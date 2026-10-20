import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import {
  BASE_FEE,
  NETWORK_PASSPHRASE,
  STELLAR_NETWORK,
  STELLAR_RPC_URL,
  assertNetworkPassphrase,
} from './config.js';
import { TransactionError } from './errors.js';

const POLL_INITIAL_INTERVAL_MS = 1000;
const POLL_MAX_INTERVAL_MS = 8000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_DEADLINE_MS = 60_000;

const SIMULATION_CACHE_TTL_MS = 5000;

/**
 * Return a Soroban RPC server bound to the centralized network configuration.
 *
 * The configured network passphrase is asserted before the server is created so
 * that a misconfigured deployment (e.g. mainnet RPC with a testnet passphrase)
 * fails fast instead of silently operating on the wrong network.
 */
export function getSorobanServer(): rpc.Server {
  assertNetworkPassphrase(NETWORK_PASSPHRASE);
  return new rpc.Server(STELLAR_RPC_URL, {
    allowHttp: STELLAR_RPC_URL.startsWith('http://'),
  });
}

/**
 * Assert that the configured network matches the expected network.
 *
 * @param expectedNetwork optional network identifier (e.g. "testnet", "mainnet")
 *   or passphrase to compare against the centralized configuration.
 * @throws TransactionError when the configured network does not match.
 */
export function assertConfiguredNetwork(expectedNetwork?: string): void {
  if (expectedNetwork === undefined) {
    assertNetworkPassphrase(NETWORK_PASSPHRASE);
    return;
  }

  const matches =
    expectedNetwork === STELLAR_NETWORK ||
    expectedNetwork === NETWORK_PASSPHRASE;

  if (!matches) {
    throw new TransactionError(
      `Network mismatch: expected ${expectedNetwork} but backend is configured for ${STELLAR_NETWORK}. ` +
        'Check STELLAR_NETWORK and STELLAR_RPC_URL configuration.',
    );
  }

  assertNetworkPassphrase(NETWORK_PASSPHRASE);
}

/**
 * Classified outcome of a transaction status lookup.
 *
 * - `not_found`: the RPC has not seen the hash yet (may still be in flight)
 * - `pending`: the transaction is included but not yet finalized
 * - `failed`: the transaction failed on-chain (final)
 * - `confirmed`: the transaction succeeded on-chain (final)
 * - `unresolved`: the polling deadline elapsed without a final outcome
 */
export type TransactionStatus =
  | 'not_found'
  | 'pending'
  | 'failed'
  | 'confirmed'
  | 'unresolved';

export interface PollTransactionResult {
  status: TransactionStatus;
  hash: string;
  network: string;
  /** True only for final on-chain outcomes (confirmed or failed). */
  final: boolean;
  /** True when the deadline elapsed before a final outcome was observed. */
  unresolved: boolean;
  response?: rpc.Api.GetTransactionResponse;
}

/**
 * Poll a transaction hash with exponential backoff until a final outcome is
 * observed or the deadline elapses.
 *
 * A deadline expiry returns `unresolved` rather than `failed`, because a
 * transaction may still be included later and must be handed to reconciliation.
 */
export async function pollTransactionStatus(
  server: rpc.Server,
  hash: string,
  options: { deadlineMs?: number } = {},
): Promise<PollTransactionResult> {
  const deadlineMs = options.deadlineMs ?? POLL_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  let interval = POLL_INITIAL_INTERVAL_MS;

  for (;;) {
    let response: rpc.Api.GetTransactionResponse | undefined;
    try {
      response = await server.getTransaction(hash);
    } catch {
      // Transient RPC errors are treated as not-found; keep polling until the
      // deadline so a timeout never implies a final failure.
      response = undefined;
    }

    if (response) {
      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          status: 'confirmed',
          hash,
          network: STELLAR_NETWORK,
          final: true,
          unresolved: false,
          response,
        };
      }

      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        return {
          status: 'failed',
          hash,
          network: STELLAR_NETWORK,
          final: true,
          unresolved: false,
          response,
        };
      }
    }

    if (Date.now() + interval >= deadline) {
      return {
        status: 'unresolved',
        hash,
        network: STELLAR_NETWORK,
        final: false,
        unresolved: true,
        response,
      };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, interval));
    interval = Math.min(
      Math.round(interval * POLL_BACKOFF_FACTOR),
      POLL_MAX_INTERVAL_MS,
    );
  }
}

const RPC_HEALTH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stellar RPC health check timed out')), ms);
    }),
  ]);
}

/**
 * Verify Stellar RPC connectivity with a bounded-time getHealth() probe.
 *
 * @returns true if the RPC endpoint reports "healthy" within the timeout, false otherwise
 */
export async function getRpcHealth(): Promise<boolean> {
  try {
    const server = getSorobanServer();
    const health = await withTimeout(server.getHealth(), RPC_HEALTH_TIMEOUT_MS);
    return health.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Submit a signed Soroban transaction and poll until it is confirmed.
 *
 * The transaction's network passphrase is validated against the centralized
 * configuration before broadcast. A polling deadline that elapses without a
 * final outcome throws an `unresolved` TransactionError carrying the hash so
 * the caller can hand the transaction to reconciliation.
 */
export async function submitAndWait(
  server: rpc.Server,
  tx: Transaction,
): Promise<rpc.Api.GetTransactionResponse> {
  assertNetworkPassphrase(tx.networkPassphrase);

  const sendResponse = await server.sendTransaction(tx);

  if (sendResponse.status === 'ERROR') {
    const detail =
      sendResponse.errorResult?.toXDR('base64') ?? 'unknown error';
    throw new TransactionError(`Transaction submission failed: ${detail}`);
  }

  const result = await pollTransactionStatus(server, sendResponse.hash);

  if (result.status === 'confirmed' && result.response) {
    return result.response;
  }

  if (result.status === 'failed') {
    throw new TransactionError('Transaction failed on-chain', sendResponse.hash);
  }

  throw new TransactionError(
    `Transaction not confirmed before deadline; pending reconciliation`,
    sendResponse.hash,
  );
}

/**
 * Wrap an inner transaction in a fee-bump and sign with the fee-source keypair.
 */
export function buildFeeBump(
  innerTx: Transaction,
  feeSourceKeypair: Keypair,
): FeeBumpTransaction {
  assertNetworkPassphrase(innerTx.networkPassphrase);
  const bumpFee = String(Math.max(200, Number(BASE_FEE) * 10));
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSourceKeypair,
    bumpFee,
    innerTx,
    NETWORK_PASSPHRASE,
  );
  feeBump.sign(feeSourceKeypair);
  return feeBump;
}

/**
 * Simulate a read-only contract call and return the result ScVal.
 */
export async function simulateReadOnly(
  server: rpc.Server,
  tx: Transaction,
  methodName: string,
): Promise<xdr.ScVal> {
  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new TransactionError(
      `Simulation failed for ${methodName}: ${(simResult as rpc.Api.SimulateTransactionErrorResponse).error}`,
    );
  }

  const success = simResult as rpc.Api.SimulateTransactionSuccessResponse;
  if (!success.result?.retval) {
    throw new TransactionError(`No return value from ${methodName}`);
  }

  return success.result.retval;
}

/**
 * Result of a preflight simulation, including estimated fee and diagnostics.
 */
export interface SimulationResult {
  success: boolean;
  estimatedFee: string;
  minResourceFee: string;
  latestLedger: number;
  error?: string;
  recoverable?: boolean;
  events?: string[];
}

interface SimulationCacheEntry {
  result: SimulationResult;
  ledger: number;
  expiresAt: number;
}

const simulationCache = new Map<string, SimulationCacheEntry>();

/**
 * Derive a stable cache key from a transaction's intent (source, ops, seq).
 */
function simulationCacheKey(tx: Transaction): string {
  const ops = tx.operations
    .map((op) => JSON.stringify(op))
    .join('|');
  return `${tx.source}|${tx.sequence}|${ops}`;
}

/**
 * Parse simulation diagnostics into a safe, non-throwing summary.
 */
function parseSimulationDiagnostics(
  simResult: rpc.Api.SimulateTransactionResponse,
): { error?: string; recoverable: boolean } {
  if (!rpc.Api.isSimulationError(simResult)) {
    return { recoverable: false };
  }

  const errResponse = simResult as rpc.Api.SimulateTransactionErrorResponse;
  const raw = errResponse.error ?? 'unknown simulation error';

  // Contract errors are typically recoverable (e.g. insufficient balance,
  // authorization failures) and should be surfaced to the user preflight.
  const recoverable =
    /contract|auth|balance|trustline|allowance/i.test(raw) ||
    errResponse.events?.some((e) => e.type === 'contract') === true;

  return { error: raw, recoverable };
}

/**
 * Simulate a transaction to estimate fees and surface preflight failures.
 *
 * Results are cached briefly by transaction intent and invalidated when the
 * latest ledger advances or the transaction inputs change.
 */
export async function simulateTransaction(
  server: rpc.Server,
  tx: Transaction,
): Promise<SimulationResult> {
  const key = simulationCacheKey(tx);
  const now = Date.now();
  const cached = simulationCache.get(key);

  if (cached && cached.expiresAt > now) {
    try {
      const latest = await server.getLatestLedger();
      if (latest.sequence === cached.ledger) {
        return cached.result;
      }
    } catch {
      // Fall through to re-simulate if ledger lookup fails.
    }
  }

  let latestLedger = 0;
  try {
    const latest = await server.getLatestLedger();
    latestLedger = latest.sequence;
  } catch {
    latestLedger = 0;
  }

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const { error, recoverable } = parseSimulationDiagnostics(simResult);
    const result: SimulationResult = {
      success: false,
      estimatedFee: '0',
      minResourceFee: '0',
      latestLedger,
      error,
      recoverable,
    };
    simulationCache.set(key, {
      result,
      ledger: latestLedger,
      expiresAt: now + SIMULATION_CACHE_TTL_MS,
    });
    return result;
  }

  const success = simResult as rpc.Api.SimulateTransactionSuccessResponse;
  const minResourceFee = success.minResourceFee ?? '0';
  const estimatedFee = String(
    Number(BASE_FEE) + Number(minResourceFee),
  );

  const result: SimulationResult = {
    success: true,
    estimatedFee,
    minResourceFee,
    latestLedger,
    events: success.events?.map((e) => e.type) ?? [],
  };

  simulationCache.set(key, {
    result,
    ledger: latestLedger,
    expiresAt: now + SIMULATION_CACHE_TTL_MS,
  });

  return result;
}

/**
 * Simulate a transaction and throw if it is not safe to sign.
 *
 * Prevents signing obviously invalid operations by failing fast on
 * unrecoverable simulation errors.
 */
export async function assertSimulationSafe(
  server: rpc.Server,
  tx: Transaction,
): Promise<SimulationResult> {
  const result = await simulateTransaction(server, tx);

  if (!result.success) {
    throw new TransactionError(
      `Preflight simulation failed: ${result.error ?? 'unknown error'}`,
    );
  }

  return result;
}

/**
 * Build a transaction from a source account for simulation purposes.
 */
export function buildSimulationTransaction(
  sourceAccount: Account,
  operations: xdr.Operation[],
  fee = BASE_FEE,
): Transaction {
  assertNetworkPassphrase(NETWORK_PASSPHRASE);
  const builder = new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  for (const op of operations) {
    builder.addOperation(op);
  }

  return builder.setTimeout(30).build();
}

/**
 * Clear cached simulation results, e.g. when a quote changes.
 */
export function invalidateSimulationCache(): void {
  simulationCache.clear();
}
