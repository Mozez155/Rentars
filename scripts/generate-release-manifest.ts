#!/usr/bin/env bun
/**
 * Generates a machine-readable release manifest at
 * docs/releases/manifest-<version>.json.
 *
 * The manifest records:
 *   - commit SHA and tag
 *   - per-component versions (backend, web, contracts)
 *   - latest applied migration
 *   - ABI file hashes for each contract
 *   - Docker image identifiers (if IMAGE_TAG env is set)
 *   - rollback documentation pointer
 *
 * Usage:
 *   bun run scripts/generate-release-manifest.ts [--version <semver>]
 *
 * Reads version from:
 *   1. --version CLI flag
 *   2. ROOT_VERSION env variable
 *   3. root package.json version field
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ── Resolve version ──────────────────────────────────────────────────────────
const versionFlag = process.argv.findIndex((a) => a === '--version');
const version: string =
  versionFlag >= 0
    ? (process.argv[versionFlag + 1] ?? '')
    : (process.env.ROOT_VERSION ?? String((json('package.json') as { version?: string }).version ?? '0.0.0'));

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid version: "${version}". Pass --version X.Y.Z or set ROOT_VERSION.`);
  process.exit(1);
}

// ── Component versions ────────────────────────────────────────────────────────
const backendPkg = json('apps/backend/package.json') as { version?: string };
const webPkg = json('apps/web/package.json') as { version?: string };
const contractsCargo = read('apps/contracts/Cargo.toml');
const contractsVersion = contractsCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown';

// ── Latest migration ─────────────────────────────────────────────────────────
const migrationsDir = resolve(ROOT, 'apps/backend/database/migrations');
let latestMigration = 'none';
let migrationCount = 0;
if (existsSync(migrationsDir)) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  migrationCount = files.length;
  if (files.length > 0) latestMigration = files[files.length - 1];
}

// ── Rollback target and gate policy ──────────────────────────────────────────
// The rollback target is the newest manifest that is not this release. Its
// existence is what makes "roll back to the last known-good release" answerable.
const releasesDir = resolve(ROOT, 'docs/releases');
const gatePolicyPath = 'docs/releases/health-gates.json';
const previousManifest = existsSync(releasesDir)
  ? (readdirSync(releasesDir)
      .filter((f) => /^manifest-.+\.json$/.test(f) && f !== `manifest-${version}.json`)
      .map((f) => ({
        file: f,
        generatedAt: String(
          (json(`docs/releases/${f}`) as { generated_at?: unknown }).generated_at ?? ''
        ),
      }))
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0]?.file ?? null)
  : null;

// ── ABI hashes ───────────────────────────────────────────────────────────────
const abiFiles = ['booking_abi.json', 'property_listing_abi.json', 'review_abi.json'];
const abiHashes: Record<string, string> = {};
for (const abi of abiFiles) {
  const path = `apps/contracts/${abi}`;
  if (existsSync(resolve(ROOT, path))) {
    abiHashes[abi] = sha256(read(path));
  }
}

// ── Contract version registry ────────────────────────────────────────────────
// Per-network record of contract ID, WASM hash, ABI version, initialization
// dependencies and compatible application releases. Consumed by the backend
// contract registry (apps/backend/src/contracts/registry.ts) to validate
// configuration at startup and to expose non-sensitive version health data.
//
// Configuration sources (highest precedence first):
//   1. CONTRACT_REGISTRY_FILE — path to a JSON registry document
//   2. Per-network env vars (see contractEnv below)
//   3. apps/contracts/contracts.registry.json (checked-in defaults)
const CONTRACT_NAMES = ['property_listing', 'booking', 'review'] as const;
type ContractName = (typeof CONTRACT_NAMES)[number];

const ABI_VERSION = '1';
const ABI_FILE_BY_CONTRACT: Record<ContractName, string> = {
  property_listing: 'property_listing_abi.json',
  booking: 'booking_abi.json',
  review: 'review_abi.json',
};

// Initialization dependencies: contracts that must be deployed and initialized
// before the dependent contract can be initialized.
const INIT_DEPENDENCIES: Record<ContractName, ContractName[]> = {
  property_listing: [],
  booking: ['property_listing'],
  review: ['property_listing', 'booking'],
};

const CONTRACT_ENV: Record<ContractName, { id: string; wasm: string }> = {
  property_listing: {
    id: 'PROPERTY_LISTING_CONTRACT_ID',
    wasm: 'PROPERTY_LISTING_WASM_HASH',
  },
  booking: { id: 'BOOKING_CONTRACT_ID', wasm: 'BOOKING_WASM_HASH' },
  review: { id: 'REVIEW_CONTRACT_ID', wasm: 'REVIEW_WASM_HASH' },
};

const NETWORKS = ['local', 'testnet', 'futurenet', 'mainnet'] as const;
type Network = (typeof NETWORKS)[number];

interface ContractRegistryEntry {
  contract_id: string | null;
  wasm_sha256: string | null;
  abi_version: string;
  abi_sha256: string | null;
  init_dependencies: ContractName[];
  compatible_releases: { backend: string; web: string; contracts: string };
}

type NetworkRegistry = Record<ContractName, ContractRegistryEntry>;

const registryDefaultsPath = 'apps/contracts/contracts.registry.json';
const registryFileOverride = process.env.CONTRACT_REGISTRY_FILE ?? null;
const registrySourcePath = registryFileOverride ?? registryDefaultsPath;

let registrySource: Record<string, unknown> = {};
if (existsSync(resolve(ROOT, registrySourcePath))) {
  registrySource = json(registrySourcePath);
}

const registryNetworks = (registrySource.networks ?? {}) as Record<string, unknown>;

function buildNetworkRegistry(network: Network): NetworkRegistry {
  const fromFile = (registryNetworks[network] ?? {}) as Record<string, unknown>;
  const envSuffix = network.toUpperCase();
  const entries = {} as NetworkRegistry;

  for (const name of CONTRACT_NAMES) {
    const fileEntry = (fromFile[name] ?? {}) as Record<string, unknown>;
    const env = CONTRACT_ENV[name];
    const contractId =
      process.env[`${env.id}_${envSuffix}`] ??
      (network === (process.env.STELLAR_NETWORK ?? 'local') ? process.env[env.id] : undefined) ??
      (fileEntry.contract_id as string | undefined) ??
      null;
    const wasmHash =
      process.env[`${env.wasm}_${envSuffix}`] ??
      (network === (process.env.STELLAR_NETWORK ?? 'local') ? process.env[env.wasm] : undefined) ??
      (fileEntry.wasm_sha256 as string | undefined) ??
      null;
    const abiFile = ABI_FILE_BY_CONTRACT[name];
    const abiPath = `apps/contracts/${abiFile}`;

    entries[name] = {
      contract_id: contractId,
      wasm_sha256: wasmHash,
      abi_version: String(fileEntry.abi_version ?? ABI_VERSION),
      abi_sha256: existsSync(resolve(ROOT, abiPath)) ? sha256(read(abiPath)) : null,
      init_dependencies: [...INIT_DEPENDENCIES[name]],
      compatible_releases: {
        backend: String(
          (fileEntry.compatible_releases as { backend?: string } | undefined)?.backend ??
            backendPkg.version ??
            version
        ),
        web: String(
          (fileEntry.compatible_releases as { web?: string } | undefined)?.web ??
            webPkg.version ??
            version
        ),
        contracts: String(
          (fileEntry.compatible_releases as { contracts?: string } | undefined)?.contracts ??
            contractsVersion
        ),
      },
    };
  }

  return entries;
}

const contractRegistry: Record<Network, NetworkRegistry> = {} as Record<Network, NetworkRegistry>;
for (const network of NETWORKS) {
  contractRegistry[network] = buildNetworkRegistry(network);
}

// Validate configured contract IDs at generation time so an unknown or
// malformed configuration fails the build before it reaches critical traffic.
const contractIdPattern = /^C[A-Z2-7]{55}$/;
const registryWarnings: string[] = [];
for (const network of NETWORKS) {
  for (const name of CONTRACT_NAMES) {
    const entry = contractRegistry[network][name];
    if (entry.contract_id !== null && !contractIdPattern.test(entry.contract_id)) {
      console.error(
        `Invalid contract ID for ${name} on ${network}: "${entry.contract_id}" (expected C... StrKey)`
      );
      process.exit(1);
    }
    if (entry.wasm_sha256 !== null && !/^[0-9a-f]{64}$/.test(entry.wasm_sha256)) {
      console.error(
        `Invalid WASM hash for ${name} on ${network}: "${entry.wasm_sha256}" (expected 64 hex chars)`
      );
      process.exit(1);
    }
    if (entry.contract_id === null && network === 'mainnet') {
      registryWarnings.push(`${name}: no contract ID configured for mainnet`);
    }
  }
}
for (const warning of registryWarnings) {
  console.warn(`[contract-registry] ${warning}`);
}

// ── Git metadata ──────────────────────────────────────────────────────────────
const commit = git('rev-parse HEAD');
const tag = git('describe --tags --exact-match 2>/dev/null') || `v${version}`;

// ── Assemble manifest ────────────────────────────────────────────────────────
const manifest = {
  schema_version: '1',
  generated_at: new Date().toISOString(),
  release: {
    version,
    commit,
    tag,
    image_tag: process.env.IMAGE_TAG ?? null,
  },
  components: {
    backend: { version: backendPkg.version ?? version },
    web: { version: webPkg.version ?? version },
    contracts: { version: contractsVersion },
  },
  database: {
    latest_migration: latestMigration,
    migration_count: migrationCount,
  },
  dependencies: {
    stellar_network: process.env.STELLAR_NETWORK ?? null,
    contract_ids: {
      property_listing: process.env.PROPERTY_LISTING_CONTRACT_ID ?? null,
      booking: process.env.BOOKING_CONTRACT_ID ?? null,
      review: process.env.REVIEW_CONTRACT_ID ?? null,
    },
  },
  contracts: {
    abi_sha256: abiHashes,
    abi_version: ABI_VERSION,
    registry_source: registrySourcePath,
    registry_sha256: existsSync(resolve(ROOT, registrySourcePath))
      ? sha256(read(registrySourcePath))
      : null,
    networks: contractRegistry,
  },
  rollback: {
    docs: 'docs/releases/rollback.md',
    prior_manifest_pattern: `docs/releases/manifest-*.json`,
    previous_manifest: previousManifest ? `docs/releases/${previousManifest}` : null,
    health_gate_policy: {
      path: gatePolicyPath,
      sha256: existsSync(resolve(ROOT, gatePolicyPath)) ? sha256(read(gatePolicyPath)) : null,
    },
  },
};

// ── Write ─────────────────────────────────────────────────────────────────────
const outDir = resolve(ROOT, 'docs/releases');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `manifest-${version}.json`);
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Release manifest written to: ${outPath.replace(ROOT + '/', '')}`);
