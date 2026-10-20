import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Contract version registry.
 *
 * Loads a build/deploy-generated release manifest describing, per network, the
 * deployed contract ID, WASM hash, ABI version, initialization dependencies and
 * compatible application releases. Validates configured contract IDs and ABI
 * versions at startup so that unknown or incompatible configuration is detected
 * before critical traffic, and exposes non-sensitive version health data for
 * health/readiness endpoints.
 */

export type NetworkName = string;

export interface ContractReleaseEntry {
  /** Contract ID (e.g. Soroban contract address / C...). */
  contractId: string;
  /** Network the contract is deployed on (e.g. "testnet", "mainnet"). */
  network: NetworkName;
  /** Hex-encoded SHA-256 of the deployed WASM. */
  wasmHash: string;
  /** ABI version string (semver-ish, e.g. "1.2.0"). */
  abiVersion: string;
  /**
   * Initialization dependencies: contract IDs (or named components) that must
   * be initialized before this contract. Used to validate migration sequencing.
   */
  initializationDependencies: string[];
  /** Application release versions known to be compatible with this contract. */
  compatibleAppReleases: string[];
}

export interface ReleaseManifest {
  /** Manifest schema version. */
  manifestVersion: number;
  /** When the manifest was generated (ISO timestamp). */
  generatedAt: string;
  /** All contract release entries. */
  contracts: ContractReleaseEntry[];
}

export interface ContractRegistryConfig {
  /** Path to the generated release manifest JSON. */
  manifestPath: string;
  /** Network this process is configured to talk to. */
  network: NetworkName;
  /** Contract ID configured for this process (must match the manifest). */
  configuredContractId: string;
  /** ABI version this process expects (must be compatible with the manifest). */
  expectedAbiVersion?: string;
  /** Application release version of this process (checked for compatibility). */
  appRelease?: string;
}

export interface ContractVersionHealth {
  status: 'ok' | 'degraded' | 'error';
  network: NetworkName;
  contractId: string;
  wasmHash: string;
  abiVersion: string;
  appRelease?: string;
  compatibleAppReleases: string[];
  initializationDependencies: string[];
  manifestGeneratedAt: string;
  issues: string[];
}

export class ContractRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractRegistryError';
  }
}

/**
 * Parse a semver-ish version string into numeric components.
 * Returns null when the string is not parseable.
 */
function parseVersion(version: string): number[] | null {
  const cleaned = version.trim().replace(/^v/i, '');
  const core = cleaned.split('-')[0].split('+')[0];
  const parts = core.split('.');
  if (parts.length === 0 || parts.some((p) => p === '' || !/^\d+$/.test(p))) {
    return null;
  }
  return parts.map((p) => parseInt(p, 10));
}

/**
 * Compare two semver-ish versions. Returns negative if a < b, 0 if equal,
 * positive if a > b. Returns null when either version is unparseable.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return null;
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) {
      return va - vb;
    }
  }
  return 0;
}

/**
 * Determine whether an app release is compatible with a contract entry.
 * Compatibility is declared explicitly via `compatibleAppReleases`.
 */
export function isAppReleaseCompatible(
  entry: ContractReleaseEntry,
  appRelease: string,
): boolean {
  return entry.compatibleAppReleases.some(
    (compatible) => compareVersions(compatible, appRelease) === 0,
  );
}

/**
 * Determine whether the expected ABI version is satisfied by the deployed one.
 * The deployed ABI must be >= the expected ABI (same major line) to be safe.
 */
export function isAbiCompatible(
  deployedAbiVersion: string,
  expectedAbiVersion: string,
): boolean {
  const cmp = compareVersions(deployedAbiVersion, expectedAbiVersion);
  if (cmp === null) {
    return false;
  }
  const deployed = parseVersion(deployedAbiVersion);
  const expected = parseVersion(expectedAbiVersion);
  if (!deployed || !expected) {
    return false;
  }
  // Major versions must match; deployed must be at least the expected version.
  if ((deployed[0] ?? 0) !== (expected[0] ?? 0)) {
    return false;
  }
  return cmp >= 0;
}

function validateManifestShape(manifest: unknown): ReleaseManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new ContractRegistryError('Release manifest is not an object');
  }
  const m = manifest as Partial<ReleaseManifest>;
  if (typeof m.manifestVersion !== 'number') {
    throw new ContractRegistryError('Release manifest missing manifestVersion');
  }
  if (typeof m.generatedAt !== 'string') {
    throw new ContractRegistryError('Release manifest missing generatedAt');
  }
  if (!Array.isArray(m.contracts)) {
    throw new ContractRegistryError('Release manifest missing contracts array');
  }
  m.contracts.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new ContractRegistryError(`Contract entry ${idx} is not an object`);
    }
    const e = entry as Partial<ContractReleaseEntry>;
    if (typeof e.contractId !== 'string' || e.contractId.length === 0) {
      throw new ContractRegistryError(`Contract entry ${idx} missing contractId`);
    }
    if (typeof e.network !== 'string' || e.network.length === 0) {
      throw new ContractRegistryError(`Contract entry ${idx} missing network`);
    }
    if (typeof e.wasmHash !== 'string' || !/^[0-9a-fA-F]+$/.test(e.wasmHash)) {
      throw new ContractRegistryError(`Contract entry ${idx} has invalid wasmHash`);
    }
    if (typeof e.abiVersion !== 'string' || e.abiVersion.length === 0) {
      throw new ContractRegistryError(`Contract entry ${idx} missing abiVersion`);
    }
    if (!Array.isArray(e.initializationDependencies)) {
      throw new ContractRegistryError(
        `Contract entry ${idx} missing initializationDependencies`,
      );
    }
    if (!Array.isArray(e.compatibleAppReleases)) {
      throw new ContractRegistryError(
        `Contract entry ${idx} missing compatibleAppReleases`,
      );
    }
  });
  return m as ReleaseManifest;
}

export function loadReleaseManifest(manifestPath: string): ReleaseManifest {
  if (!existsSync(manifestPath)) {
    throw new ContractRegistryError(
      `Release manifest not found at ${manifestPath}`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new ContractRegistryError(
      `Failed to read release manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ContractRegistryError(
      `Release manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return validateManifestShape(parsed);
}

export class ContractRegistry {
  private readonly manifest: ReleaseManifest;
  private readonly config: ContractRegistryConfig;
  private readonly entry: ContractReleaseEntry;
  private readonly issues: string[] = [];

  constructor(config: ContractRegistryConfig, manifest?: ReleaseManifest) {
    this.config = config;
    this.manifest = manifest ?? loadReleaseManifest(config.manifestPath);
    this.entry = this.resolveEntry();
    this.validate();
  }

  private resolveEntry(): ContractReleaseEntry {
    const matches = this.manifest.contracts.filter(
      (c) =>
        c.network === this.config.network &&
        c.contractId === this.config.configuredContractId,
    );
    if (matches.length === 0) {
      throw new ContractRegistryError(
        `Unknown contract configuration: contractId ${this.config.configuredContractId} ` +
          `not found for network ${this.config.network}`,
      );
    }
    if (matches.length > 1) {
      throw new ContractRegistryError(
        `Ambiguous contract configuration: multiple entries for contractId ` +
          `${this.config.configuredContractId} on network ${this.config.network}`,
      );
    }
    return matches[0];
  }

  private validate(): void {
    // Validate ABI compatibility.
    if (this.config.expectedAbiVersion) {
      if (!isAbiCompatible(this.entry.abiVersion, this.config.expectedAbiVersion)) {
        throw new ContractRegistryError(
          `Incompatible ABI version: deployed ${this.entry.abiVersion} is not ` +
            `compatible with expected ${this.config.expectedAbiVersion}`,
        );
      }
    }

    // Validate app release compatibility.
    if (this.config.appRelease) {
      if (!isAppReleaseCompatible(this.entry, this.config.appRelease)) {
        throw new ContractRegistryError(
          `Incompatible application release: ${this.config.appRelease} is not ` +
            `listed as compatible with contract ${this.entry.contractId} ` +
            `(compatible: ${this.entry.compatibleAppReleases.join(', ') || 'none'})`,
        );
      }
    }

    // Validate initialization dependencies are known within the manifest.
    const knownIds = new Set(this.manifest.contracts.map((c) => c.contractId));
    for (const dep of this.entry.initializationDependencies) {
      if (!knownIds.has(dep)) {
        this.issues.push(
          `Initialization dependency ${dep} is not present in the release manifest`,
        );
      }
    }
  }

  /** Returns the resolved release entry for the configured contract. */
  getEntry(): ContractReleaseEntry {
    return { ...this.entry };
  }

  /** Returns the full manifest (read-only copy). */
  getManifest(): ReleaseManifest {
    return {
      manifestVersion: this.manifest.manifestVersion,
      generatedAt: this.manifest.generatedAt,
      contracts: this.manifest.contracts.map((c) => ({ ...c })),
    };
  }

  /**
   * Non-sensitive version health data suitable for health/readiness endpoints.
   * Does not expose secrets; only public contract metadata.
   */
  getHealth(): ContractVersionHealth {
    const status: ContractVersionHealth['status'] =
      this.issues.length > 0 ? 'degraded' : 'ok';
    return {
      status,
      network: this.entry.network,
      contractId: this.entry.contractId,
      wasmHash: this.entry.wasmHash,
      abiVersion: this.entry.abiVersion,
      appRelease: this.config.appRelease,
      compatibleAppReleases: [...this.entry.compatibleAppReleases],
      initializationDependencies: [...this.entry.initializationDependencies],
      manifestGeneratedAt: this.manifest.generatedAt,
      issues: [...this.issues],
    };
  }

  /**
   * Verify that a provided WASM byte buffer matches the deployed hash.
   * Useful for build/deploy verification and staging upgrade checks.
   */
  verifyWasmHash(wasm: Buffer): boolean {
    const hash = createHash('sha256').update(wasm).digest('hex');
    return hash.toLowerCase() === this.entry.wasmHash.toLowerCase();
  }
}

/**
 * Convenience helper to build a registry from environment-style config.
 * Throws ContractRegistryError on unknown/incompatible configuration so that
 * startup fails fast before critical traffic.
 */
export function createContractRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  manifestPath?: string,
): ContractRegistry {
  const resolvedPath =
    manifestPath ??
    env.CONTRACT_RELEASE_MANIFEST ??
    join(process.cwd(), 'contract-release-manifest.json');
  const network = env.CONTRACT_NETWORK;
  const configuredContractId = env.CONTRACT_ID;
  if (!network) {
    throw new ContractRegistryError('CONTRACT_NETWORK is not configured');
  }
  if (!configuredContractId) {
    throw new ContractRegistryError('CONTRACT_ID is not configured');
  }
  return new ContractRegistry({
    manifestPath: resolvedPath,
    network,
    configuredContractId,
    expectedAbiVersion: env.CONTRACT_ABI_VERSION,
    appRelease: env.APP_RELEASE,
  });
}