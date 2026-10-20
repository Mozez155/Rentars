/**
 * Stellar service — wraps Stellar Horizon interactions for payment transactions.
 *
 * Responsibilities:
 * - Submit signed XDR transactions to Stellar testnet/mainnet
 * - Poll Horizon for confirmation with timeout
 * - Retry logic with double-spend protection (check existing tx hash first)
 *
 * All blockchain calls are isolated here. Controllers/routes never call
 * Horizon directly.
 *
 * OAuth/passkey design note:
 * When OAuth or passkey support is added, authentication still produces a JWT
 * with { userId, role }. This service only operates on signed XDR from the
 * wallet layer and is fully independent of the auth mechanism.
 */

import { Horizon, Transaction } from '@stellar/stellar-sdk';
import { updatePaymentStatus, getPaymentStatus } from './payment.service.js';
import {
  StellarNetwork,
  getStellarNetworkConfig,
  assertNetworkMatch,
  NetworkMismatchError,
} from '../config/stellar-network.js';

const CONFIRMATION_TIMEOUT_MS = 60_000; // 60 seconds max wait
const POLL_INTERVAL_MS = 3_000;         // poll every 3 seconds
const MAX_POLL_INTERVAL_MS = 15_000;    // exponential backoff ceiling

function getHorizonServer(network: StellarNetwork = getStellarNetworkConfig().network): Horizon.Server {
  const config = getStellarNetworkConfig(network);
  return new Horizon.Server(config.horizonUrl);
}

export interface SubmitResult {
  txHash: string;
  network: StellarNetwork;
}

/**
 * Validate that a network referenced by a quote, signing intent, or client
 * request matches the server's configured network. Throws an actionable
 * NetworkMismatchError on mismatch.
 */
export function validateNetwork(expected?: StellarNetwork | string | null): StellarNetwork {
  const serverNetwork = getStellarNetworkConfig().network;
  if (expected === undefined || expected === null) return serverNetwork;
  assertNetworkMatch(expected, serverNetwork);
  return serverNetwork;
}

/**
 * Submit a signed transaction XDR to Stellar Horizon.
 * Returns the transaction hash on success. Throws on failure.
 *
 * The caller may pass the network the wallet signed for; it must match the
 * server's configured network or submission is rejected before broadcast.
 */
export async function submitTransaction(
  signedXdr: string,
  network?: StellarNetwork | string | null,
): Promise<SubmitResult> {
  const activeNetwork = validateNetwork(network);
  const config = getStellarNetworkConfig(activeNetwork);
  const server = getHorizonServer(activeNetwork);

  const tx = new Transaction(signedXdr, config.networkPassphrase);
  const response = await server.submitTransaction(tx);
  return { txHash: response.hash, network: activeNetwork };
}

/**
 * Poll Horizon until the transaction is confirmed or the deadline is reached.
 * Uses exponential backoff and distinguishes not-found (still pending) from
 * transport errors. A timeout is NOT a final failure — the payment is marked
 * 'timed_out' so reconciliation can resolve it later.
 *
 * Chain status updates are idempotent: a payment already in a terminal state
 * is not overwritten.
 *
 * @returns 'confirmed' | 'failed' | 'timed_out'
 */
export async function confirmTransaction(
  paymentId: string,
  txHash: string,
  network: StellarNetwork = getStellarNetworkConfig().network,
): Promise<'confirmed' | 'failed' | 'timed_out'> {
  const server = getHorizonServer(network);
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  let interval = POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    try {
      const tx = await server.transactions().transaction(txHash).call();
      if (tx.successful) {
        await updatePaymentStatus(paymentId, txHash, 'confirmed');
        return 'confirmed';
      }
      // On-chain but unsuccessful — final outcome
      await updatePaymentStatus(paymentId, txHash, 'failed');
      return 'failed';
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error &&
        (err.message.includes('404') || err.message.includes('not found'));
      if (!isNotFound) {
        // Transport/RPC error: do not declare failure; leave for reconciliation.
        await updatePaymentStatus(paymentId, txHash, 'timed_out');
        return 'timed_out';
      }
      // 404 = not yet on ledger, keep polling
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(interval, remaining)));
    interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS);
  }

  await updatePaymentStatus(paymentId, txHash, 'timed_out');
  return 'timed_out';
}

/**
 * Retry a failed or timed-out payment.
 * Double-spend protection: if a txHash already exists, re-polls it instead
 * of submitting a new transaction.
 */
export async function retryTransaction(
  paymentId: string,
  signedXdr?: string,
  network?: StellarNetwork | string | null,
): Promise<{ txHash: string; status: 'confirmed' | 'failed' | 'timed_out' }> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) throw new Error('Payment not found');

  if (!['failed', 'timed_out'].includes(payment.status)) {
    throw new Error(`Cannot retry payment in status: ${payment.status}`);
  }

  // If the payment was already tagged with a network, it must match.
  const paymentNetwork = (payment as { stellar_network?: string | null }).stellar_network ?? null;
  const activeNetwork = validateNetwork(network ?? paymentNetwork);

  let txHash: string;

  if (payment.stellar_tx_hash) {
    // Already submitted — re-poll to avoid double-spend
    txHash = payment.stellar_tx_hash;
  } else {
    if (!signedXdr) throw new Error('signedXdr required for payments that were never submitted');
    const result = await submitTransaction(signedXdr, activeNetwork);
    txHash = result.txHash;
    await updatePaymentStatus(paymentId, txHash, 'submitted', activeNetwork);
  }

  const status = await confirmTransaction(paymentId, txHash, activeNetwork);
  return { txHash, status };
}

export { NetworkMismatchError };
