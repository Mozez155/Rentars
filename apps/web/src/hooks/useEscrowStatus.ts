'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Chain confirmation state for the escrow transaction.
 *
 * - `not_found`: the transaction hash is not yet visible on the network.
 * - `submitted`: broadcast succeeded but ledger confirmation is not yet proven.
 * - `pending`:   the network has seen the transaction but it is not final.
 * - `confirmed`: the transaction is included in a ledger and final.
 * - `failed`:    the network reported a definitive failure.
 * - `unresolved`: polling deadline elapsed without a final outcome; the
 *   transaction has been handed off to reconciliation and may still resolve.
 */
export type EscrowChainStatus =
  | 'not_found'
  | 'submitted'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'unresolved';

export interface EscrowStatus {
  status: 'locked' | 'released' | 'refunded';
  amount: number;
  releaseDate?: string;
  /** Persisted transaction hash for the escrow operation, if any. */
  transactionHash?: string;
  /** Stellar network the transaction was submitted to (e.g. 'testnet'). */
  network?: string;
  /** Chain confirmation state, distinct from the escrow business status. */
  chainStatus?: EscrowChainStatus;
  /** Ledger in which the transaction was confirmed, when available. */
  ledger?: number;
}

export interface UseEscrowStatusResult {
  escrow: EscrowStatus | null;
  isLoading: boolean;
  /** True while a transaction has been submitted but not yet confirmed. */
  isSubmitted: boolean;
  /** True only once the chain has confirmed the transaction. */
  isConfirmed: boolean;
  /** True when polling timed out and reconciliation must resolve the outcome. */
  isUnresolved: boolean;
  /** True only for a definitive on-chain failure. */
  isFailed: boolean;
}

const INITIAL_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 1.8;
const MAX_POLL_DURATION_MS = 120_000;

function isFinalChainStatus(status: EscrowChainStatus | undefined): boolean {
  return status === 'confirmed' || status === 'failed';
}

export function useEscrowStatus(bookingId: string): UseEscrowStatusResult {
  const [escrow, setEscrow] = useState<EscrowStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUnresolved, setIsUnresolved] = useState(false);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!bookingId) {
      setIsLoading(false);
      return;
    }

    cancelledRef.current = false;
    setIsLoading(true);
    setIsUnresolved(false);

    const token =
      typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const startedAt = Date.now();
    let delay = INITIAL_DELAY_MS;

    const clearTimer = () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const scheduleNext = () => {
      if (cancelledRef.current) return;
      if (Date.now() - startedAt >= MAX_POLL_DURATION_MS) {
        // Deadline reached without a final outcome. Do NOT imply failure:
        // mark as unresolved so reconciliation can resolve it later.
        setIsUnresolved(true);
        setIsLoading(false);
        return;
      }
      timeoutRef.current = setTimeout(poll, delay);
      delay = Math.min(Math.round(delay * BACKOFF_FACTOR), MAX_DELAY_MS);
    };

    const poll = async () => {
      if (cancelledRef.current) return;

      try {
        const response = await fetch(
          `${API_URL}/api/bookings/${bookingId}/escrow`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          },
        );

        if (cancelledRef.current) return;

        if (!response.ok) {
          // Transient server error: keep polling within the deadline.
          scheduleNext();
          return;
        }

        const data: EscrowStatus = await response.json();
        if (cancelledRef.current) return;

        setEscrow(data);
        setIsLoading(false);

        if (isFinalChainStatus(data.chainStatus)) {
          // Idempotent terminal state: stop polling.
          clearTimer();
          return;
        }

        scheduleNext();
      } catch {
        // Network/timeout error is not a final failure; retry with backoff.
        if (cancelledRef.current) return;
        setIsLoading(false);
        scheduleNext();
      }
    };

    // Kick off immediately, then back off on subsequent polls.
    poll();

    return () => {
      cancelledRef.current = true;
      clearTimer();
    };
  }, [bookingId]);

  const chainStatus = escrow?.chainStatus;
  const isConfirmed = chainStatus === 'confirmed';
  const isFailed = chainStatus === 'failed';
  const isSubmitted =
    !isConfirmed &&
    !isFailed &&
    (chainStatus === 'submitted' ||
      chainStatus === 'pending' ||
      chainStatus === 'not_found' ||
      Boolean(escrow?.transactionHash));

  return {
    escrow,
    isLoading,
    isSubmitted,
    isConfirmed,
    isUnresolved,
    isFailed,
  };
}