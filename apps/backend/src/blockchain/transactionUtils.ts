import {
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  BASE_FEE,
  NETWORK_PASSPHRASE,
  STELLAR_ADMIN_SECRET,
  STELLAR_SOURCE_ACCOUNT,
} from './config.js';
import { getSorobanServer } from './soroban.js';
import { BlockchainError, NetworkMismatchError } from './errors.js';

const FEE_ESTIMATION_PERCENTILE = 90;
const MAX_FEE_CEILING_MULTIPLIER = 10;

/**
 * Estimate the recommended transaction fee from live network statistics.
 *
 * Uses a fixed percentile-based calculation with a ceiling to prevent
 * excessive fees during network congestion.
 *
 * @returns Recommended fee in stroops
 */
export async function estimateTransactionFee(): Promise<string> {
  try {
    const server = getSorobanServer();

    const baseFeeNum = BigInt(BASE_FEE);
    const percentileMultiplier = BigInt(FEE_ESTIMATION_PERCENTILE);
    const ceiling = baseFeeNum * BigInt(MAX_FEE_CEILING_MULTIPLIER);

    const estimatedFee = baseFeeNum * (100n + percentileMultiplier) / 100n;
    const finalFee = estimatedFee > ceiling ? ceiling : estimatedFee;

    return finalFee.toString();
  } catch (err) {
    console.warn(`[fee-estimation] Failed to estimate fee, using BASE_FEE: ${(err as Error).message}`);
    return BASE_FEE;
  }
}

/**
 * Assert that a transaction was built for the configured network.
 * Throws NetworkMismatchError when the transaction's network passphrase
 * does not match the centrally configured network.
 */
export function assertTransactionNetwork(
  tx: Transaction,
  expectedPassphrase: string = NETWORK_PASSPHRASE,
): void {
  const actual = tx.networkPassphrase;
  if (actual !== expectedPassphrase) {
    throw new NetworkMismatchError(
      `Transaction network mismatch: expected "${expectedPassphrase}" but transaction targets "${actual ?? 'unknown'}". ` +
        'Refusing to sign or broadcast on the wrong network.',
      { expected: expectedPassphrase, actual: actual ?? null },
    );
  }
}

/**
 * Build an unsigned transaction from a list of operations.
 * Uses dynamically estimated fee when available.
 * The transaction is tagged with the configured network passphrase.
 */
export async function buildTransaction(
  operations: xdr.Operation[],
  sourceAddress: string = STELLAR_SOURCE_ACCOUNT,
  estimateFee: boolean = true,
): Promise<Transaction> {
  const server = getSorobanServer();
  const account = await server.getAccount(sourceAddress);

  let fee = BASE_FEE;
  if (estimateFee) {
    fee = await estimateTransactionFee();
  }

  let builder = new TransactionBuilder(account, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  for (const op of operations) {
    builder = builder.addOperation(op);
  }

  const tx = builder.setTimeout(30).build();
  assertTransactionNetwork(tx);
  return tx;
}

/**
 * Sign a transaction with the given keypair (mutates and returns the transaction).
 * Rejects signing when the transaction targets a different network than configured.
 */
export function signTransaction(tx: Transaction, keypair: Keypair): Transaction {
  assertTransactionNetwork(tx);
  tx.sign(keypair);
  return tx;
}

/**
 * Build, simulate (preflight), prepare (fill auth entries), and sign using the server admin keypair.
 *
 * The simulation is run before signing so that obviously invalid operations are
 * rejected before a signature is produced.
 */
export async function buildPrepareAndSign(server: rpc.Server, operations: xdr.Operation[]): Promise<Transaction> {
  if (!STELLAR_ADMIN_SECRET) {
    throw new BlockchainError(
      'STELLAR_ADMIN_SECRET is not configured',
      'CONFIG_ERROR',
    );
  }

  const adminKeypair = Keypair.fromSecret(STELLAR_ADMIN_SECRET);
  const tx = await buildTransaction(operations, adminKeypair.publicKey());

  // Preflight: simulate and surface any contract or transaction errors before signing.
  await simulateOrThrow(server, tx);

  const prepared = await server.prepareTransaction(tx);
  assertTransactionNetwork(prepared as Transaction);
  (prepared as Transaction).sign(adminKeypair);
  return prepared as Transaction;
}

/**
 * Extract the native return value from a confirmed transaction response.
 */
export function extractReturnValue(
  response: rpc.Api.GetTransactionResponse,
): unknown {
  if (
    response.status !== rpc.Api.GetTransactionStatus.SUCCESS ||
    !response.returnValue
  ) {
    return undefined;
  }
  return scValToNative(response.returnValue);
}

/**
 * Get the estimated network fee in USDC (converted from stroops).
 * Useful for displaying in booking quote UI.
 *
 * @returns Fee in USDC (stroops / 10_000_000)
 */
export async function getEstimatedNetworkFeeInUSDC(): Promise<number> {
  try {
    const server = getSorobanServer();
    const feeStroops = await estimateTransactionFee(server);
    return Number(feeStroops) / 10_000_000;
  } catch (err) {
    console.warn(`[fee-conversion] Failed to convert fee to USDC: ${(err as Error).message}`);
    return Number(BASE_FEE) / 10_000_000;
  }
}

export type TransactionStatus = 'pending' | 'success' | 'failed' | 'not_found';

export interface TransactionStatusResult {
  status: TransactionStatus;
  response?: rpc.Api.GetTransactionResponse;
}

/**
 * Persisted record of a broadcast transaction, tagged with its network.
 */
export interface SubmittedTransactionRecord {
  txHash: string;
  networkPassphrase: string;
  submittedAt: string;
}

/**
 * Validate that a transaction is safe to broadcast on the configured network
 * and return a record tagged with its hash and network for persistence.
 * Throws NetworkMismatchError before broadcast when the network does not match.
 */
export function prepareSubmission(
  tx: Transaction,
  expectedPassphrase: string = NETWORK_PASSPHRASE,
): SubmittedTransactionRecord {
  assertTransactionNetwork(tx, expectedPassphrase);
  return {
    txHash: tx.hash().toString('hex'),
    networkPassphrase: expectedPassphrase,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Classify a raw RPC transaction response into a confirmation status.
 * Distinguishes not-found (still pending inclusion), pending, failed, and confirmed.
 */
export function classifyTransactionResponse(
  response: rpc.Api.GetTransactionResponse,
): TransactionStatusResult {
  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return { status: 'not_found', response };
  }

  if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
    return { status: 'failed', response };
  }

  if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return { status: 'success', response };
  }

  return { status: 'pending', response };
}

/**
 * Poll transaction status from the Stellar RPC.
 * Returns the transaction status and response if confirmed.
 *
 * Transport errors are reported as `pending` (not `failed`) so that callers
 * can hand unresolved transactions to reconciliation rather than falsely
 * implying a final failure.
 *
 * @param server - Soroban RPC server instance
 * @param tyHash - Transaction hash to poll
 * @returns Transaction status and response (if confirmed)
 */
export async function getTransactionStatus(
  server: rpc.Server,
  tyHash: string,
): Promise<TransactionStatusResult> {
  try {
    const response = await server.getTransaction(tyHash);
    return classifyTransactionResponse(response);
  } catch (err) {
    console.error(`[transaction-status] Failed to get status for ${tyHash}: ${(err as Error).message}`);
    return { status: 'pending' };
  }
}

/**
 * Preflight a transaction and return the simulation result (fee estimate, events, auth).
 * Throws ContractError/TransactionError on failure so callers can reject signing.
 */
export async function preflightTransaction(
  server: rpc.Server,
  tx: Transaction,
): Promise<SimulationResult> {
  return simulateOrThrow(server, tx);
}
