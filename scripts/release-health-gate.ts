#!/usr/bin/env bun
/**
 * Release health gate (#737).
 *
 * Evaluates a metrics snapshot against docs/releases/health-gates.json and
 * prints the rollout decision as JSON. The deployment pipeline acts on the exit
 * code:
 *
 *   0   proceed    every gate is within its threshold
 *   10  pause      a pause gate is breached, or a gate has too little data
 *   20  rollback   a rollback gate is breached
 *   1   error      invalid policy or snapshot
 *
 * Missing or short metric data pauses the rollout. The gate fails closed rather
 * than assuming health.
 *
 * Contract registry (#779): the gate also validates the generated contract
 * manifest (docs/releases/contract-manifest.json) against the target network
 * before any traffic is allowed. Unknown contract IDs, ABI mismatches, missing
 * WASM hashes, unmet initialization dependencies, or an application release
 * outside the contract's compatibility range are configuration errors and exit
 * with code 1. Production rollouts additionally require a recorded staging
 * upgrade that proves the same contract/ABI/WASM combination is compatible.
 *
 * Usage:
 *   bun run scripts/release-health-gate.ts --metrics <snapshot.json>
 *     [--policy <file>] [--mode evaluate|resume]
 *     [--contracts <manifest.json>] [--network <name>]
 *     [--app-release <version>] [--staging-proof <proof.json>]
 *
 * Snapshot format: { "<gate name>": [value, ...] }, one value per one-minute
 * window, oldest first.
 *
 * --mode evaluate (default) answers "is this release healthy right now?".
 * --mode resume answers "may a paused rollout continue?". Every gate that has a
 * recovery rule must be at or below its recovery threshold for its recovery
 * windows, and no gate may be breached. The snapshot does not record which gate
 * paused the rollout, so the check applies to all of them.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type GateAction = 'pause' | 'rollback';
export type Decision = 'proceed' | 'pause' | 'rollback';
export type Mode = 'evaluate' | 'resume';

export interface Recovery {
  threshold: number;
  windows: number;
}

export interface Gate {
  name: string;
  threshold: number;
  consecutive_windows: number;
  action: GateAction;
  recovery: Recovery | null;
}

export interface Policy {
  policy_version: string;
  gates: Gate[];
}

export type Snapshot = Record<string, number[]>;

export type GateStatus = 'ok' | 'breached' | 'insufficient_data' | 'recovering';

export interface GateResult {
  name: string;
  action: GateAction;
  status: GateStatus;
  threshold: number;
  observed: number[];
}

export interface Evaluation {
  decision: Decision;
  gates: GateResult[];
}

export const EXIT_CODES: Record<Decision, number> = {
  proceed: 0,
  pause: 10,
  rollback: 20,
};

const ERROR_EXIT_CODE = 1;

export interface ContractEntry {
  contract_id: string;
  network: string;
  wasm_hash: string;
  abi_version: string;
  initialization_dependencies: string[];
  compatible_app_releases: string;
}

export interface ContractManifest {
  manifest_version: string;
  generated_at: string;
  contracts: ContractEntry[];
}

export interface StagingProof {
  network: string;
  contract_id: string;
  wasm_hash: string;
  abi_version: string;
  app_release: string;
  verified_at: string;
}

export interface ContractHealth {
  network: string;
  app_release: string | null;
  contracts: Array<{
    contract_id: string;
    wasm_hash: string;
    abi_version: string;
    initialization_dependencies: string[];
  }>;
  staging_verified: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePolicy(raw: unknown): Policy {
  if (!isRecord(raw) || typeof raw.policy_version !== 'string' || !Array.isArray(raw.gates)) {
    fail('policy must contain policy_version and a gates array');
  }

  const gates = raw.gates.map((entry, index): Gate => {
    if (!isRecord(entry)) fail(`gates[${index}] must be an object`);
    const { name, threshold, consecutive_windows, action, recovery } = entry;
    if (typeof name !== 'string' || name === '')
      fail(`gates[${index}].name must be a non-empty string`);
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      fail(`gate ${String(name)} threshold must be a finite number`);
    }
    if (!Number.isInteger(consecutive_windows) || (consecutive_windows as number) < 1) {
      fail(`gate ${String(name)} consecutive_windows must be an integer >= 1`);
    }
    if (action !== 'pause' && action !== 'rollback') {
      fail(`gate ${String(name)} action must be "pause" or "rollback"`);
    }

    let parsedRecovery: Recovery | null = null;
    if (recovery !== null && recovery !== undefined) {
      if (
        !isRecord(recovery) ||
        typeof recovery.threshold !== 'number' ||
        !Number.isInteger(recovery.windows)
      ) {
        fail(`gate ${String(name)} recovery must have a numeric threshold and integer windows`);
      }
      parsedRecovery = {
        threshold: recovery.threshold as number,
        windows: recovery.windows as number,
      };
    }

    return {
      name: name as string,
      threshold,
      consecutive_windows: consecutive_windows as number,
      action,
      recovery: parsedRecovery,
    };
  });

  return { policy_version: raw.policy_version, gates };
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ABI_PATTERN = /^\d+\.\d+\.\d+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) fail(`invalid semantic version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** Parses a compatibility range such as ">=1.2.0 <2.0.0" or "^1.2.0". */
export function parseCompatibilityRange(range: string): (version: string) => boolean {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return () => true;

  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (caret) {
    const [major] = parseSemver(caret[1]);
    return (version) => {
      const [vMajor] = parseSemver(version);
      return vMajor === major && compareSemver(version, caret[1]) >= 0;
    };
  }

  const comparators = trimmed.split(/\s+/).map((token) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(token);
    if (!match) fail(`invalid compatibility range: ${range}`);
    return { operator: match[1] ?? '=', version: match[2] };
  });

  return (version) => {
    if (!SEMVER_PATTERN.test(version)) return false;
    return comparators.every(({ operator, version: bound }) => {
      const cmp = compareSemver(version, bound);
      switch (operator) {
        case '>=':
          return cmp >= 0;
        case '<=':
          return cmp <= 0;
        case '>':
          return cmp > 0;
        case '<':
          return cmp < 0;
        default:
          return cmp === 0;
      }
    });
  };
}

export function parseContractManifest(raw: unknown): ContractManifest {
  if (
    !isRecord(raw) ||
    typeof raw.manifest_version !== 'string' ||
    typeof raw.generated_at !== 'string' ||
    !Array.isArray(raw.contracts)
  ) {
    fail('contract manifest must contain manifest_version, generated_at and a contracts array');
  }

  const seen = new Set<string>();
  const contracts = raw.contracts.map((entry, index): ContractEntry => {
    if (!isRecord(entry)) fail(`contracts[${index}] must be an object`);
    const {
      contract_id,
      network,
      wasm_hash,
      abi_version,
      initialization_dependencies,
      compatible_app_releases,
    } = entry;
    if (typeof contract_id !== 'string' || contract_id === '') {
      fail(`contracts[${index}].contract_id must be a non-empty string`);
    }
    if (typeof network !== 'string' || network === '') {
      fail(`contract ${contract_id} network must be a non-empty string`);
    }
    if (typeof wasm_hash !== 'string' || !HASH_PATTERN.test(wasm_hash)) {
      fail(`contract ${contract_id} wasm_hash must be a 64-character lowercase hex digest`);
    }
    if (typeof abi_version !== 'string' || !ABI_PATTERN.test(abi_version)) {
      fail(`contract ${contract_id} abi_version must be a semantic version`);
    }
    if (
      !Array.isArray(initialization_dependencies) ||
      !initialization_dependencies.every((dep) => typeof dep === 'string' && dep !== '')
    ) {
      fail(`contract ${contract_id} initialization_dependencies must be an array of contract IDs`);
    }
    if (typeof compatible_app_releases !== 'string') {
      fail(`contract ${contract_id} compatible_app_releases must be a range string`);
    }
    // Validate the range eagerly so a bad manifest fails before traffic.
    parseCompatibilityRange(compatible_app_releases);

    const key = `${network}:${contract_id}`;
    if (seen.has(key)) fail(`duplicate contract ${contract_id} on network ${network}`);
    seen.add(key);

    return {
      contract_id,
      network,
      wasm_hash,
      abi_version,
      initialization_dependencies: initialization_dependencies as string[],
      compatible_app_releases,
    };
  });

  return {
    manifest_version: raw.manifest_version,
    generated_at: raw.generated_at,
    contracts,
  };
}

export function parseStagingProof(raw: unknown): StagingProof {
  if (
    !isRecord(raw) ||
    typeof raw.network !== 'string' ||
    typeof raw.contract_id !== 'string' ||
    typeof raw.wasm_hash !== 'string' ||
    typeof raw.abi_version !== 'string' ||
    typeof raw.app_release !== 'string' ||
    typeof raw.verified_at !== 'string'
  ) {
    fail('staging proof must contain network, contract_id, wasm_hash, abi_version, app_release and verified_at');
  }
  return {
    network: raw.network,
    contract_id: raw.contract_id,
    wasm_hash: raw.wasm_hash,
    abi_version: raw.abi_version,
    app_release: raw.app_release,
    verified_at: raw.verified_at,
  };
}

/**
 * Validates the manifest for the target network and application release.
 * Throws on unknown contracts, ABI/WASM mismatches, unmet initialization
 * dependencies, or an incompatible application release.
 */
export function validateContracts(
  manifest: ContractManifest,
  network: string,
  appRelease: string | null,
): ContractHealth {
  const deployed = manifest.contracts.filter((c) => c.network === network);
  if (deployed.length === 0) {
    fail(`no contracts registered for network ${network}`);
  }

  const byId = new Map(deployed.map((c) => [c.contract_id, c]));

  for (const contract of deployed) {
    for (const dependency of contract.initialization_dependencies) {
      if (!byId.has(dependency)) {
        fail(
          `contract ${contract.contract_id} depends on ${dependency}, which is not registered on ${network}`,
        );
      }
    }
    if (appRelease !== null) {
      const compatible = parseCompatibilityRange(contract.compatible_app_releases);
      if (!compatible(appRelease)) {
        fail(
          `contract ${contract.contract_id} ABI ${contract.abi_version} is incompatible with app release ${appRelease} (requires ${contract.compatible_app_releases})`,
        );
      }
    }
  }

  return {
    network,
    app_release: appRelease,
    contracts: deployed.map((c) => ({
      contract_id: c.contract_id,
      wasm_hash: c.wasm_hash,
      abi_version: c.abi_version,
      initialization_dependencies: c.initialization_dependencies,
    })),
    staging_verified: false,
  };
}

/**
 * Production rollouts must be preceded by a staging upgrade that proves the
 * same contract, WASM hash, ABI version and application release are compatible.
 */
export function enforceStagingFirst(
  health: ContractHealth,
  proof: StagingProof | null,
  productionNetwork: string,
  stagingNetwork: string,
): ContractHealth {
  if (health.network !== productionNetwork) return health;
  if (!proof) {
    fail(`production rollout on ${productionNetwork} requires a staging upgrade proof`);
  }
  if (proof.network !== stagingNetwork) {
    fail(`staging proof must come from ${stagingNetwork}, got ${proof.network}`);
  }
  const contract = health.contracts.find((c) => c.contract_id === proof.contract_id);
  if (!contract) {
    fail(`staging proof references unknown contract ${proof.contract_id}`);
  }
  if (contract.wasm_hash !== proof.wasm_hash) {
    fail(
      `staging proof WASM hash ${proof.wasm_hash} does not match deployed hash ${contract.wasm_hash} for ${contract.contract_id}`,
    );
  }
  if (contract.abi_version !== proof.abi_version) {
    fail(
      `staging proof ABI ${proof.abi_version} does not match deployed ABI ${contract.abi_version} for ${contract.contract_id}`,
    );
  }
  if (health.app_release !== null && proof.app_release !== health.app_release) {
    fail(
      `staging proof app release ${proof.app_release} does not match target release ${health.app_release}`,
    );
  }
  return { ...health, staging_verified: true };
}

export function parseSnapshot(raw: unknown): Snapshot {
  if (!isRecord(raw)) fail('metrics snapshot must be a JSON object keyed by gate name');

  const snapshot: Snapshot = {};
  for (const [name, values] of Object.entries(raw)) {
    if (
      !Array.isArray(values) ||
      !values.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      fail(`metric ${name} must be an array of finite numbers`);
    }
    snapshot[name] = values as number[];
  }
  return snapshot;
}

/**
 * Evaluates the rollout. A gate is breached when its most recent
 * `consecutive_windows` values are all above the threshold.
 */
export function evaluate(policy: Policy, snapshot: Snapshot): Evaluation {
  const gates = policy.gates.map((gate): GateResult => {
    const values = snapshot[gate.name] ?? [];
    if (values.length < gate.consecutive_windows) {
      return {
        name: gate.name,
        action: gate.action,
        status: 'insufficient_data',
        threshold: gate.threshold,
        observed: values,
      };
    }

    const observed = values.slice(-gate.consecutive_windows);
    const breached = observed.every((value) => value > gate.threshold);
    return {
      name: gate.name,
      action: gate.action,
      status: breached ? 'breached' : 'ok',
      threshold: gate.threshold,
      observed,
    };
  });

  return { decision: decide(gates), gates };
}

function decide(gates: GateResult[]): Decision {
  if (gates.some((g) => g.status === 'breached' && g.action === 'rollback')) return 'rollback';
  if (gates.some((g) => g.status !== 'ok')) return 'pause';
  return 'proceed';
}

/**
 * Decides whether a paused rollout may continue. Each gate with a recovery rule
 * needs its last `recovery.windows` values at or below `recovery.threshold`.
 * Gates without a recovery rule must be healthy in the current window. A gate
 * with too few windows is treated as still recovering.
 */
export function evaluateResume(policy: Policy, snapshot: Snapshot): Evaluation {
  const current = evaluate(policy, snapshot);
  const gates = current.gates.map((result): GateResult => {
    const gate = policy.gates.find((g) => g.name === result.name);
    if (!gate || result.status !== 'ok' || !gate.recovery) return result;

    const values = snapshot[gate.name] ?? [];
    const recent = values.slice(-gate.recovery.windows);
    const recovered =
      recent.length === gate.recovery.windows && recent.every((v) => v <= gate.recovery!.threshold);
    return recovered ? result : { ...result, status: 'recovering', observed: recent };
  });

  return { decision: decide(gates), gates };
}

export function evaluateMode(policy: Policy, snapshot: Snapshot, mode: Mode): Evaluation {
  return mode === 'resume' ? evaluateResume(policy, snapshot) : evaluate(policy, snapshot);
}

interface Args {
  metrics: string;
  policy: string;
  mode: Mode;
  contracts: string;
  network: string;
  appRelease: string | null;
  stagingProof: string | null;
  productionNetwork: string;
  stagingNetwork: string;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const metrics = value('--metrics');
  if (!metrics) fail('--metrics <snapshot.json> is required');

  const mode = value('--mode') ?? 'evaluate';
  if (mode !== 'evaluate' && mode !== 'resume') fail('--mode must be "evaluate" or "resume"');

  const network = value('--network');
  if (!network) fail('--network <name> is required');

  const appRelease = value('--app-release') ?? null;
  if (appRelease !== null && !SEMVER_PATTERN.test(appRelease)) {
    fail('--app-release must be a semantic version');
  }

  const defaultPolicy = resolve(import.meta.dir, '../docs/releases/health-gates.json');
  const defaultContracts = resolve(import.meta.dir, '../docs/releases/contract-manifest.json');
  return {
    metrics,
    policy: value('--policy') ?? defaultPolicy,
    mode,
    contracts: value('--contracts') ?? defaultContracts,
    network,
    appRelease,
    stagingProof: value('--staging-proof') ?? null,
    productionNetwork: value('--production-network') ?? 'mainnet',
    stagingNetwork: value('--staging-network') ?? 'testnet',
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  const policyText = readFileSync(args.policy, 'utf-8');
  const policy = parsePolicy(JSON.parse(policyText));

  // Contract configuration is validated before any metric evaluation so that
  // unknown or incompatible deployments are caught before critical traffic.
  const manifestText = readFileSync(args.contracts, 'utf-8');
  const manifest = parseContractManifest(JSON.parse(manifestText));
  let contractHealth = validateContracts(manifest, args.network, args.appRelease);

  if (args.stagingProof !== null) {
    if (!existsSync(args.stagingProof)) {
      fail(`staging proof not found: ${args.stagingProof}`);
    }
    const proof = parseStagingProof(JSON.parse(readFileSync(args.stagingProof, 'utf-8')));
    contractHealth = enforceStagingFirst(
      contractHealth,
      proof,
      args.productionNetwork,
      args.stagingNetwork,
    );
  } else {
    contractHealth = enforceStagingFirst(
      contractHealth,
      null,
      args.productionNetwork,
      args.stagingNetwork,
    );
  }

  const snapshot = parseSnapshot(JSON.parse(readFileSync(args.metrics, 'utf-8')));
  const result = evaluateMode(policy, snapshot, args.mode);

  const report = {
    mode: args.mode,
    decision: result.decision,
    policy_version: policy.policy_version,
    policy_sha256: createHash('sha256').update(policyText).digest('hex'),
    contract_manifest_version: manifest.manifest_version,
    contract_manifest_sha256: createHash('sha256').update(manifestText).digest('hex'),
    contracts: contractHealth,
    evaluated_at: new Date().toISOString(),
    gates: result.gates,
  };
  console.log(JSON.stringify(report, null, 2));
  return EXIT_CODES[result.decision];
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`release-health-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(ERROR_EXIT_CODE);
  }
}
