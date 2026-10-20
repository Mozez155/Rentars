import { useState, useCallback, useEffect, useRef } from 'react';
import {
  connectFreighterWallet,
  getWalletStatus,
  isValidStellarAddress,
  FreighterError,
  WalletState,
  checkNetworkMatch,
} from '@/lib/freighter-utils';
import { getExpectedNetwork } from '@/lib/network-utils';

export interface UseWalletReturn {
  state: WalletState & { isLoading: boolean };
  /** Network the app is configured to use (the "active" network). */
  activeNetwork: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  checkStatus: () => Promise<void>;
}

export interface UseWalletOptions {
  /**
   * Address that owns the currently pending operation (e.g. a booking quote or
   * signature request). When the active wallet address differs, the operation
   * is considered stale and must not silently continue.
   */
  operationOwner?: string | null;
  /** Called when the active account or network changes and stale state must be invalidated. */
  onAccountChange?: (info: { address: string | null; network: string; previousAddress: string | null }) => void;
  /** Called when the wallet network no longer matches the configured network. */
  onNetworkMismatch?: (info: { walletNetwork: string | null; expectedNetwork: string }) => void;
}

const WALLET_STORAGE_KEY = 'freighter_wallet_connected';
const WALLET_ADDRESS_KEY = 'freighter_wallet_address';

/**
 * Hook for managing Freighter wallet connection and status.
 *
 * Observes account/network changes (storage events plus focus-based checks),
 * compares the active address against the configured network and the owner of
 * any pending operation, and invalidates stale signatures/quotes on change.
 */
export function useWallet(options: UseWalletOptions = {}): UseWalletReturn {
  const { operationOwner = null, onAccountChange, onNetworkMismatch } = options;
  const expectedNetwork = getExpectedNetwork();

  const [state, setState] = useState<WalletState & { isLoading: boolean }>({
    isConnected: false,
    address: null,
    network: expectedNetwork,
    networkMismatch: false,
    isLoading: true,
    error: null,
  });

  // Track the last observed address/network so we can detect changes.
  const lastAddressRef = useRef<string | null>(null);
  const lastNetworkRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onAccountChange, onNetworkMismatch });
  callbacksRef.current = { onAccountChange, onNetworkMismatch };

  /**
   * Apply a fresh wallet status, detecting account/network changes and
   * invalidating stale state when they occur.
   */
  const applyStatus = useCallback(
    (status: WalletState) => {
      const previousAddress = lastAddressRef.current;
      const previousNetwork = lastNetworkRef.current;
      const nextAddress = status.address ?? null;
      const nextNetwork = status.network ?? null;

      const addressChanged = previousAddress !== null && previousAddress !== nextAddress;
      const networkChanged = previousNetwork !== null && previousNetwork !== nextNetwork;

      if (addressChanged || networkChanged) {
        // Clear the stale cached public key so downstream code cannot reuse it.
        localStorage.removeItem(WALLET_ADDRESS_KEY);
        if (nextAddress) {
          localStorage.setItem(WALLET_ADDRESS_KEY, nextAddress);
        } else {
          localStorage.removeItem(WALLET_STORAGE_KEY);
        }

        callbacksRef.current.onAccountChange?.({
          address: nextAddress,
          network: status.network,
          previousAddress,
        });
      }

      if (status.networkMismatch) {
        callbacksRef.current.onNetworkMismatch?.({
          walletNetwork: nextNetwork,
          expectedNetwork,
        });
      }

      lastAddressRef.current = nextAddress;
      lastNetworkRef.current = nextNetwork;

      setState({ ...status, isLoading: false });
    },
    [expectedNetwork]
  );

  /**
   * Compare the active address against the pending operation owner. Returns
   * true when the operation may safely continue under the current address.
   */
  const isOperationOwnerActive = useCallback(
    (address: string | null): boolean => {
      if (!operationOwner) return true;
      return address !== null && address === operationOwner;
    },
    [operationOwner]
  );

  // Check for existing connection on mount and attempt auto-reconnect
  useEffect(() => {
    const attemptReconnect = async () => {
      const wasConnected = localStorage.getItem(WALLET_STORAGE_KEY) === 'true';
      const savedAddress = localStorage.getItem(WALLET_ADDRESS_KEY);
      
      if (wasConnected && savedAddress) {
        // Try silent reconnect
        try {
          await checkStatus();
        } catch (error) {
          // If reconnect fails, clear the connection state
          localStorage.removeItem(WALLET_STORAGE_KEY);
          localStorage.removeItem(WALLET_ADDRESS_KEY);
          setState((prev) => ({ ...prev, isLoading: false }));
        }
      } else {
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    };

    attemptReconnect();

    // Listen for account/network changes (Freighter fires storage events)
    const handleStorageChange = (e: StorageEvent) => {
      if (
        e.key === 'freighter-network' ||
        e.key === 'freighter-address' ||
        e.key === 'freighter:account' ||
        e.key === WALLET_ADDRESS_KEY
      ) {
        checkStatus();
      }
    };

    // Focus-based fallback for wallets that do not emit events.
    const handleFocus = () => {
      if (lastAddressRef.current !== null) {
        checkStatus();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  const checkStatus = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    const status = await getWalletStatus(expectedNetwork);
    applyStatus(status);
  }, [expectedNetwork, applyStatus]);

  const connect = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const address = await connectFreighterWallet(expectedNetwork);

      // Persist connection state
      localStorage.setItem(WALLET_STORAGE_KEY, 'true');
      localStorage.setItem(WALLET_ADDRESS_KEY, address);

      lastAddressRef.current = address;
      lastNetworkRef.current = expectedNetwork;

      setState({
        isConnected: true,
        address,
        network: expectedNetwork,
        networkMismatch: false,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      let errorMessage = 'Failed to connect wallet';

      if (error instanceof FreighterError) {
        switch (error.code) {
          case 'NOT_INSTALLED':
            errorMessage =
              'Freighter wallet is not installed. Please install it from https://www.freighter.app';
            break;
          case 'NOT_CONNECTED':
            errorMessage =
              'Wallet is not connected in Freighter. Please open Freighter and connect your account.';
            break;
          case 'USER_REJECTED':
            errorMessage = 'You rejected the connection request. Please try again.';
            break;
          case 'NETWORK_MISMATCH':
            errorMessage = error.message;
            break;
          default:
            errorMessage = error.message;
        }
      }

      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));

      throw error;
    }
  }, [expectedNetwork]);

  const disconnect = useCallback(() => {
    // Only clear wallet-specific state; unrelated account data is preserved.
    localStorage.removeItem(WALLET_STORAGE_KEY);
    localStorage.removeItem(WALLET_ADDRESS_KEY);
    lastAddressRef.current = null;
    lastNetworkRef.current = null;
    setState({
      isConnected: false,
      address: null,
      network: expectedNetwork,
      networkMismatch: false,
      isLoading: false,
      error: null,
    });
  }, [expectedNetwork]);

  return {
    state,
    activeNetwork: expectedNetwork,
    connect,
    disconnect,
    checkStatus,
  };
}
