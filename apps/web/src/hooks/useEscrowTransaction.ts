'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getNetworkPassphrase, STELLAR_NETWORKS, getExplorerUrl } from '@/lib/network-utils';
import { signWithFreighter, FreighterError } from '@/lib/freighter-utils';
import {
  buildEscrowFundingTransaction,
  buildEscrowReleaseTransaction,
} from '@/lib/stellar-transactions';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const DEFAULT_SIGNING_TIMEOUT = 60000; // 60 seconds
const DEFAULT_CONFIRMATION_TIMEOUT = 90000; // 90 seconds
const POLL_INITIAL_DELAY = 1000;
const POLL_MAX_DELAY = 8000;
const POLL_BACKOFF_FACTOR = 1.5;

export type EscrowTxType = 'fund' | 'release';
export type EscrowTxStatus =
  | 'idle'
  | 'waiting_signature'
  | 'submitting'
  | 'submitted'
  | 'confirmed'
  | 'pending'
  | 'success'
  | 'error'
  | 'timeout'
  | 'account_changed';

/**
 * Chain-level outcome of a broadcast transaction.
 * - not_found: the network has not seen the hash yet (may still be in flight)
 * - pending: seen in a ledger but not yet final / not yet successful
 * - confirmed: included in a ledger and successful
 * - failed: included in a ledger and failed
 * - unresolved: polling deadline elapsed without a final outcome (hand off to reconciliation)
 */
export type ChainStatus = 'not_found' | 'pending' | 'confirmed' | 'failed' | 'unresolved';

export interface EscrowTransactionResult {
  txHash: string;
  explorerUrl: string;
  network: 'testnet' | 'mainnet';
  chainStatus: ChainStatus;
  confirmed: boolean;
}

export interface PendingEscrowTransaction {
  txHash: string;
  network: 'testnet' | 'mainnet';
  type: EscrowTxType;
  escrowId: string;
  ownerPublicKey: string;
  chainStatus: ChainStatus;
}

interface SubmitParams {
  type: EscrowTxType;
  escrowId: string;
  amount?: string | number;
  tenantPublicKey?: string;
  ownerPublicKey?: string;
  signingTimeout?: number;
  confirmationTimeout?: number;
}

function getHorizonServer(network: 'testnet' | 'mainnet') {
  return new StellarSdk.Horizon.Server(
    network === 'mainnet'
      ? STELLAR_NETWORKS.mainnet.horizonUrl
      : STELLAR_NETWORKS.testnet.horizonUrl,
  );
}

async function submitXdrToHorizon(xdr: string, network: 'testnet' | 'mainnet') {
  const passphrase = getNetworkPassphrase(network);
  const tx = StellarSdk.Transaction.fromXDR(xdr, passphrase);
  const client = getHorizonServer(network);

  const result = await client.submitTransaction(tx);
  return result.hash;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll Horizon for the final ledger outcome of a transaction hash using
 * bounded exponential backoff. Distinguishes not-found / pending / confirmed /
 * failed, and returns `unresolved` when the deadline elapses so callers can
 * hand the transaction to reconciliation rather than reporting a false failure.
 */
async function pollForConfirmation(
  txHash: string,
  network: 'testnet' | 'mainnet',
  deadlineMs: number,
  isCancelled: () => boolean,
): Promise<ChainStatus> {
  const client = getHorizonServer(network);
  const startedAt = Date.now();
  let delay = POLL_INITIAL_DELAY;

  while (Date.now() - startedAt < deadlineMs) {
    if (isCancelled()) return 'unresolved';

    try {
      const tx = await client.transactions().transaction(txHash).call();
      if (tx.successful === true) return 'confirmed';
      if (tx.successful === false) return 'failed';
      return 'pending';
    } catch (err) {
      // Horizon returns 404 while the transaction is not yet included.
      const statusCode = (err as { response?: { status?: number } })?.response?.status;
      if (statusCode !== 404) {
        // Transient network error: keep polling until the deadline.
      }
    }

    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * POLL_BACKOFF_FACTOR, POLL_MAX_DELAY);
  }

  return 'unresolved';
}

async function notifyBackend(
  params: SubmitParams,
  txHash: string,
  network: 'testnet' | 'mainnet',
  chainStatus: ChainStatus,
) {
  const { type, escrowId, amount } = params;
  const endpoint =
    type === 'fund'
      ? `${API_URL}/api/v1/bookings/escrow/${escrowId}/fund`
      : `${API_URL}/api/v1/bookings/escrow/${escrowId}/release`;

  const body =
    type === 'fund'
      ? { amount: String(amount ?? '0'), txHash, network, chainStatus }
      : { reason: 'Release signed by owner', txHash, network, chainStatus };

  await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function useEscrowTransaction(network: 'testnet' | 'mainnet' = 'testnet') {
  const [status, setStatus] = useState<EscrowTxStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [chainStatus, setChainStatus] = useState<ChainStatus | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingEscrowTransaction | null>(null);

  // Tracks the address that owns the in-flight operation and whether the
  // operation has been invalidated by an account switch.
  const operationOwnerRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const pendingTxRef = useRef<PendingEscrowTransaction | null>(null);

  const clearPending = useCallback(() => {
    cancelledRef.current = true;
    operationOwnerRef.current = null;
    pendingTxRef.current = null;
    setPendingTx(null);
  }, []);

  /**
   * Called when the active wallet account changes (or disconnects). Invalidates
   * any in-flight signature/submission so it cannot silently complete under a
   * different address, and clears stale transaction context.
   */
  const handleAccountChange = useCallback(
    (newPublicKey: string | null) => {
      const owner = operationOwnerRef.current;
      const isInFlight =
        status === 'waiting_signature' || status === 'submitting' || status === 'submitted';

      if (newPublicKey === null) {
        // Disconnect: drop local wallet/transaction state only.
        clearPending();
        if (isInFlight) {
          setStatus('account_changed');
          setError('Wallet disconnected. The pending operation was cancelled.');
          setCanRetry(false);
        }
        return;
      }

      if (owner && owner !== newPublicKey) {
        clearPending();
        if (isInFlight) {
          setStatus('account_changed');
          setError(
            'Wallet account changed. The pending operation was cancelled — please review and confirm before resuming.',
          );
          setCanRetry(true);
        }
      }
    },
    [status, clearPending],
  );

  // Abort any in-flight polling when the hook unmounts.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const submit = useCallback(
    async (params: SubmitParams): Promise<EscrowTransactionResult> => {
      const {
        type,
        escrowId,
        amount,
        tenantPublicKey,
        ownerPublicKey,
        signingTimeout = DEFAULT_SIGNING_TIMEOUT,
        confirmationTimeout = DEFAULT_CONFIRMATION_TIMEOUT,
      } = params;

      const operationOwner = type === 'fund' ? tenantPublicKey : ownerPublicKey;

      cancelledRef.current = false;
      operationOwnerRef.current = operationOwner ?? null;
      setStatus('idle');
      setError(null);
      setCanRetry(false);
      setChainStatus(null);
      setPendingTx(null);
      pendingTxRef.current = null;

      try {
        const { xdr } =
          type === 'fund'
            ? buildEscrowFundingTransaction(
                escrowId,
                amount ?? '0',
                tenantPublicKey ?? '',
                network,
              )
            : buildEscrowReleaseTransaction(
                escrowId,
                ownerPublicKey ?? '',
                network,
              );

        // Sign via Freighter with timeout
        setStatus('waiting_signature');
        const signedXdr = await signWithFreighter(xdr, network, { timeout: signingTimeout });

        if (cancelledRef.current) {
          throw new Error('Operation cancelled: wallet account changed.');
        }

        // Submit to Stellar network
        setStatus('submitting');
        const txHash = await submitXdrToHorizon(signedXdr, network);

        // Broadcast succeeded — record the pending transaction and persist it
        // so it can be reconciled if confirmation is not observed in time.
        const pending: PendingEscrowTransaction = {
          txHash,
          network,
          type,
          escrowId,
          ownerPublicKey: operationOwner ?? '',
          chainStatus: 'not_found',
        };
        pendingTxRef.current = pending;
        setPendingTx(pending);
        setChainStatus('not_found');
        setStatus('submitted');

        // Notify backend of the broadcast (submitted, not yet confirmed).
        await notifyBackend(params, txHash, network, 'not_found');

        // Poll for ledger confirmation with bounded backoff.
        const finalChainStatus = await pollForConfirmation(
          txHash,
          network,
          confirmationTimeout,
          () => cancelledRef.current,
        );

        if (cancelledRef.current) {
          throw new Error('Operation cancelled: wallet account changed.');
        }

        setChainStatus(finalChainStatus);
        const updatedPending = { ...pending, chainStatus: finalChainStatus };
        pendingTxRef.current = updatedPending;
        setPendingTx(updatedPending);

        if (finalChainStatus === 'confirmed') {
          // Idempotent confirmation update — backend applies payment once.
          await notifyBackend(params, txHash, network, 'confirmed');
          setStatus('confirmed');
          return {
            txHash,
            explorerUrl: getExplorerUrl(txHash, network),
            network,
            chainStatus: 'confirmed',
            confirmed: true,
          };
        }

        if (finalChainStatus === 'failed') {
          await notifyBackend(params, txHash, network, 'failed');
          setStatus('error');
          setError('The transaction was included in the ledger but failed.');
          setCanRetry(true);
          throw new Error('Transaction failed on-chain');
        }

        // pending / unresolved: not a final failure. Hand off to reconciliation.
        await notifyBackend(params, txHash, network, finalChainStatus);
        setStatus('pending');
        setError(
          finalChainStatus === 'pending'
            ? 'Transaction is pending confirmation on the network.'
            : 'Confirmation not yet observed. The transaction will be reconciled automatically.',
        );
        setCanRetry(false);
        return {
          txHash,
          explorerUrl: getExplorerUrl(txHash, network),
          network,
          chainStatus: finalChainStatus,
          confirmed: false,
        };
      } catch (err) {
        const isFreighterError = err instanceof FreighterError;

        if (cancelledRef.current) {
          setStatus('account_changed');
          setError(
            'Wallet account changed. The pending operation was cancelled — please review and confirm before resuming.',
          );
          setCanRetry(true);
        } else if (isFreighterError && err.code === 'TIMEOUT') {
          setStatus('timeout');
          setError('Signing request timed out. Please check your wallet and try again.');
          setCanRetry(true);
        } else if (isFreighterError && err.code === 'USER_REJECTED') {
          setStatus('error');
          setError('Transaction was rejected. You can try again when ready.');
          setCanRetry(true);
        } else if (isFreighterError && err.code === 'NETWORK_MISMATCH') {
          setStatus('error');
          setError(err.message);
          setCanRetry(false);
        } else {
          setStatus('error');
          setError(err instanceof Error ? err.message : 'Failed to submit transaction');
          setCanRetry(true);
        }

        throw err;
      } finally {
        operationOwnerRef.current = null;
      }
    },
    [network],
  );

  const reset = useCallback(() => {
    cancelledRef.current = true;
    operationOwnerRef.current = null;
    pendingTxRef.current = null;
    setStatus('idle');
    setError(null);
    setCanRetry(false);
    setChainStatus(null);
    setPendingTx(null);
  }, []);

  return {
    submit,
    status,
    error,
    canRetry,
    chainStatus,
    pendingTx,
    reset,
    handleAccountChange,
    isSubmitting: status === 'waiting_signature' || status === 'submitting',
    isSubmitted: status === 'submitted',
    isConfirmed: status === 'confirmed',
    isPending: status === 'pending',
  };
}

