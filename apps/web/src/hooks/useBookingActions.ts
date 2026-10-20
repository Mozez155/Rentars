'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Booking } from '@/types/booking';
import {
  getActiveNetwork,
  getActivePublicKey,
  subscribeWallet,
  type WalletNetwork,
} from '@/lib/wallet';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type ActionType = 'confirm' | 'complete' | 'cancel' | 'dispute';

interface UseBookingActionsResult {
  /** Currently executing action (or null) */
  pendingAction: ActionType | null;
  /** Latest error message (or null) */
  actionError: string | null;
  /** Confirm check-in — transitions Pending → Confirmed */
  confirm: () => Promise<Booking | null>;
  /** Complete stay — transitions Confirmed → Completed */
  complete: () => Promise<Booking | null>;
  /** Cancel — transitions Pending|Confirmed → Cancelled */
  cancel: () => Promise<Booking | null>;
  /** Dispute — transitions Confirmed → Disputed */
  dispute: (reason?: string) => Promise<Booking | null>;
  clearError: () => void;
  /** True when a wallet account switch invalidated the pending flow and needs confirmation */
  requiresAccountConfirmation: boolean;
  /** Acknowledge the account switch and resume the booking flow */
  confirmAccountSwitch: () => void;
  /** Abandon the pending flow after an account switch */
  cancelAccountSwitch: () => void;
}

/**
 * Hook that wraps all booking lifecycle mutation calls for a single booking.
 *
 * @param bookingId - UUID of the booking to act on
 * @param onSuccess - Optional callback fired with the updated booking after each action
 */
export function useBookingActions(
  bookingId: string,
  onSuccess?: (updated: Booking) => void,
): UseBookingActionsResult {
  const [pendingAction, setPendingAction] = useState<ActionType | null>(null);
  const [actionError, setActionError]     = useState<string | null>(null);
  const [requiresAccountConfirmation, setRequiresAccountConfirmation] = useState(false);

  // Address that owns the current booking flow. Captured on first action and
  // compared against the live wallet address before every subsequent action.
  const ownerAddressRef = useRef<string | null>(null);
  const pendingActionRef = useRef<ActionType | null>(null);
  const requiresConfirmationRef = useRef(false);

  useEffect(() => {
    pendingActionRef.current = pendingAction;
  }, [pendingAction]);

  useEffect(() => {
    requiresConfirmationRef.current = requiresAccountConfirmation;
  }, [requiresAccountConfirmation]);

  const clearError = useCallback(() => setActionError(null), []);

  const confirmAccountSwitch = useCallback(() => {
    // Adopt the currently selected account as the new owner of the flow.
    ownerAddressRef.current = getActivePublicKey();
    setRequiresAccountConfirmation(false);
    setActionError(null);
  }, []);

  const cancelAccountSwitch = useCallback(() => {
    ownerAddressRef.current = null;
    setRequiresAccountConfirmation(false);
    setPendingAction(null);
    setActionError('Booking flow cancelled after wallet account change.');
  }, []);

  // Detect wallet account switches while an operation is pending or a flow is
  // in progress, and require explicit confirmation before resuming.
  useEffect(() => {
    const unsubscribe = subscribeWallet((state) => {
      const owner = ownerAddressRef.current;
      if (!owner) return;
      if (state.publicKey && state.publicKey !== owner) {
        if (pendingActionRef.current || requiresConfirmationRef.current) {
          setRequiresAccountConfirmation(true);
          setActionError(
            'Wallet account changed. Confirm the new account before continuing this booking.',
          );
        }
      }
    });
    return unsubscribe;
  }, []);

  const call = useCallback(
    async (action: ActionType, body?: Record<string, unknown>): Promise<Booking | null> => {
      setActionError(null);

      if (requiresConfirmationRef.current) {
        setActionError(
          'Wallet account changed. Confirm the new account before continuing this booking.',
        );
        return null;
      }

      const walletNetwork: WalletNetwork | null = getActiveNetwork();
      const walletPublicKey = getActivePublicKey();

      if (!walletNetwork) {
        setActionError('Wallet network could not be determined. Reconnect Freighter and try again.');
        return null;
      }

      if (!walletPublicKey) {
        setActionError('Wallet is not connected. Connect Freighter and try again.');
        return null;
      }

      const owner = ownerAddressRef.current;
      if (owner && owner !== walletPublicKey) {
        setRequiresAccountConfirmation(true);
        setActionError(
          'Wallet account changed. Confirm the new account before continuing this booking.',
        );
        return null;
      }

      if (!owner) {
        ownerAddressRef.current = walletPublicKey;
      }

      setPendingAction(action);

      try {
        const url = `${API_BASE}/api/v1/bookings/${bookingId}/${action}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'X-Stellar-Network': walletNetwork,
            'X-Stellar-Account': walletPublicKey,
          },
          body: JSON.stringify({
            ...(body ?? {}),
            network: walletNetwork,
            account: walletPublicKey,
          }),
        });

        const json = await res.json();

        if (!res.ok) {
          if (res.status === 409 && json?.code === 'NETWORK_MISMATCH') {
            setActionError(
              json.error ??
                `Network mismatch: wallet is on ${walletNetwork} but the server expects a different network.`,
            );
            return null;
          }
          setActionError(json.error ?? `Failed to ${action} booking`);
          return null;
        }

        const updated = json as Booking;
        onSuccess?.(updated);
        return updated;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `Failed to ${action} booking`);
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [bookingId, onSuccess],
  );

  const confirm  = useCallback(() => call('confirm'),            [call]);
  const complete = useCallback(() => call('complete'),           [call]);
  const cancel   = useCallback(() => call('cancel'),             [call]);
  const dispute  = useCallback(
    (reason?: string) => call('dispute', reason ? { reason } : undefined),
    [call],
  );

  return {
    pendingAction,
    actionError,
    confirm,
    complete,
    cancel,
    dispute,
    clearError,
    requiresAccountConfirmation,
    confirmAccountSwitch,
    cancelAccountSwitch,
  };
}
