'use client';

import {
    createContext,
    useContext,
    ReactNode,
    useEffect,
    useCallback,
    useRef,
    useState,
} from 'react';
import { useWallet, UseWalletReturn } from '@/hooks/useWallet';

/**
 * The Stellar network the app is configured to operate on.
 * Centralized here so wallet, backend, contract IDs and RPC config can be
 * compared against a single source of truth.
 */
export type StellarNetwork = 'testnet' | 'mainnet' | 'futurenet' | 'custom';

export interface NetworkConfig {
    network: StellarNetwork;
    networkPassphrase: string;
    rpcUrl: string;
    horizonUrl: string;
}

export interface NetworkMismatch {
    walletNetwork: string | null;
    expectedNetwork: string;
    message: string;
}

export interface AccountChangeState {
    /** Address that was active when the change was detected. */
    previousAddress: string | null;
    /** Address currently selected in the wallet. */
    currentAddress: string | null;
    /** True while a pending operation is blocked awaiting user confirmation. */
    requiresConfirmation: boolean;
    /** Human-readable reason the flow is paused. */
    reason: string | null;
}

interface WalletContextType extends UseWalletReturn {
    isReady: boolean;
    /** Active network configuration (centralized). */
    networkConfig: NetworkConfig;
    /** Non-null when wallet network does not match the expected network. */
    networkMismatch: NetworkMismatch | null;
    /** True when it is safe to sign/submit (no mismatch, no pending confirmation). */
    canAuthorize: boolean;
    /** State describing a detected account switch that needs confirmation. */
    accountChange: AccountChangeState | null;
    /** User confirms resuming the flow under the currently selected account. */
    confirmAccountChange: () => void;
    /** User cancels resuming; pending operation is abandoned. */
    cancelAccountChange: () => void;
    /** Invalidate any cached public keys, quotes and signatures. */
    invalidatePendingOperations: () => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

/**
 * Resolve the expected network configuration.
 * Production must never silently default to testnet.
 */
function resolveNetworkConfig(): NetworkConfig {
    const env = process.env.NODE_ENV;
    const rawNetwork = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || '').toLowerCase();
    const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL || '';
    const horizonUrl = process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL || '';

    let network: StellarNetwork;
    if (rawNetwork === 'mainnet' || rawNetwork === 'public') {
        network = 'mainnet';
    } else if (rawNetwork === 'testnet') {
        network = 'testnet';
    } else if (rawNetwork === 'futurenet') {
        network = 'futurenet';
    } else if (rawNetwork === 'custom') {
        network = 'custom';
    } else if (env === 'production') {
        // Fail closed: production must explicitly configure the network.
        throw new Error(
            'NEXT_PUBLIC_STELLAR_NETWORK must be explicitly set in production. ' +
                'Refusing to default to testnet.',
        );
    } else {
        network = 'testnet';
    }

    const passphrases: Record<StellarNetwork, string> = {
        mainnet: 'Public Global Stellar Network ; September 2015',
        testnet: 'Test SDF Network ; September 2015',
        futurenet: 'Test SDF Future Network ; October 2022',
        custom: process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || '',
    };

    const networkPassphrase =
        process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || passphrases[network];

    if (env === 'production' && (!rpcUrl || !horizonUrl || !networkPassphrase)) {
        throw new Error(
            'Production Stellar configuration is incomplete: RPC URL, Horizon URL and ' +
                'network passphrase must all be set.',
        );
    }

    return { network, networkPassphrase, rpcUrl, horizonUrl };
}

const NETWORK_CONFIG: NetworkConfig = resolveNetworkConfig();

/** Map a wallet-reported network to our canonical network id. */
function normalizeWalletNetwork(walletNetwork: string | null | undefined): StellarNetwork | null {
    if (!walletNetwork) return null;
    const value = walletNetwork.toLowerCase();
    if (value === 'public' || value === 'mainnet') return 'mainnet';
    if (value === 'test' || value === 'testnet') return 'testnet';
    if (value === 'futurenet') return 'futurenet';
    return 'custom';
}

export function WalletProvider({ children }: { children: ReactNode }) {
    const wallet = useWallet();
    const isReady = !wallet.state.isLoading;

    const [accountChange, setAccountChange] = useState<AccountChangeState | null>(null);
    const [networkMismatch, setNetworkMismatch] = useState<NetworkMismatch | null>(null);

    // Track the last known address so we can detect switches.
    const lastAddressRef = useRef<string | null>(wallet.state.publicKey ?? null);
    // Guard so we don't re-trigger confirmation for the same address.
    const pendingAddressRef = useRef<string | null>(null);

    const invalidatePendingOperations = useCallback(() => {
        // Clear any wallet-scoped cached public keys, quotes and signatures.
        // Only wallet-scoped state is cleared; unrelated account data is untouched.
        try {
            window.dispatchEvent(new CustomEvent('wallet:invalidate-pending'));
        } catch {
            /* no-op in non-browser environments */
        }
    }, []);

    const evaluateNetwork = useCallback(() => {
        const walletNetwork = normalizeWalletNetwork(wallet.state.network ?? null);
        if (walletNetwork && walletNetwork !== NETWORK_CONFIG.network) {
            setNetworkMismatch({
                walletNetwork: wallet.state.network ?? null,
                expectedNetwork: NETWORK_CONFIG.network,
                message:
                    `Your wallet is on ${wallet.state.network ?? 'an unknown network'} but this ` +
                    `app requires ${NETWORK_CONFIG.network}. Switch networks in your wallet to continue.`,
            });
            return false;
        }
        setNetworkMismatch(null);
        return true;
    }, [wallet.state.network]);

    const handleAccountChange = useCallback(
        (newAddress: string | null) => {
            const previous = lastAddressRef.current;
            if (previous === newAddress) return;

            lastAddressRef.current = newAddress;

            // Invalidate stale signatures and quotes immediately.
            invalidatePendingOperations();

            if (previous && newAddress && previous !== newAddress) {
                pendingAddressRef.current = newAddress;
                setAccountChange({
                    previousAddress: previous,
                    currentAddress: newAddress,
                    requiresConfirmation: true,
                    reason:
                        'The wallet account changed. Confirm to resume the booking flow ' +
                        'under the newly selected account.',
                });
            } else if (!newAddress) {
                // Disconnected: clear wallet-scoped state only.
                pendingAddressRef.current = null;
                setAccountChange(null);
            } else {
                // Fresh connection with no prior address.
                setAccountChange(null);
            }
        },
        [invalidatePendingOperations],
    );

    const confirmAccountChange = useCallback(() => {
        pendingAddressRef.current = null;
        setAccountChange((prev) =>
            prev ? { ...prev, requiresConfirmation: false, reason: null } : null,
        );
    }, []);

    const cancelAccountChange = useCallback(() => {
        pendingAddressRef.current = null;
        setAccountChange(null);
        invalidatePendingOperations();
    }, [invalidatePendingOperations]);

    // React to wallet-reported account/network changes.
    useEffect(() => {
        const current = wallet.state.publicKey ?? null;
        handleAccountChange(current);
        evaluateNetwork();
    }, [wallet.state.publicKey, wallet.state.network, handleAccountChange, evaluateNetwork]);

    // Subscribe to Freighter / wallet events where supported, with
    // focus/visibility-based polling as a fallback.
    useEffect(() => {
        if (typeof window === 'undefined') return;

        const refresh = () => {
            wallet.checkStatus();
            evaluateNetwork();
        };

        const handleFocus = () => refresh();
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') refresh();
        };
        const handleNetworkChange = () => refresh();
        const handleAccountsChanged = () => refresh();

        window.addEventListener('stellar-network-change', handleNetworkChange);
        window.addEventListener('stellar-account-change', handleAccountsChanged);
        window.addEventListener('focus', handleFocus);
        document.addEventListener('visibilitychange', handleVisibility);

        // Some Freighter versions expose an event emitter.
        const freighter = (window as unknown as { freighter?: { on?: Function; off?: Function } })
            .freighter;
        if (freighter && typeof freighter.on === 'function') {
            try {
                freighter.on('accountChanged', handleAccountsChanged);
                freighter.on('networkChanged', handleNetworkChange);
            } catch {
                /* ignore unsupported event names */
            }
        }

        // Polling fallback for environments without wallet events.
        const interval = window.setInterval(refresh, 5000);

        return () => {
            window.removeEventListener('stellar-network-change', handleNetworkChange);
            window.removeEventListener('stellar-account-change', handleAccountsChanged);
            window.removeEventListener('focus', handleFocus);
            document.removeEventListener('visibilitychange', handleVisibility);
            window.clearInterval(interval);
            if (freighter && typeof freighter.off === 'function') {
                try {
                    freighter.off('accountChanged', handleAccountsChanged);
                    freighter.off('networkChanged', handleNetworkChange);
                } catch {
                    /* ignore */
                }
            }
        };
    }, [wallet, evaluateNetwork]);

    const canAuthorize =
        !networkMismatch && !(accountChange && accountChange.requiresConfirmation);

    return (
        <WalletContext.Provider
            value={{
                ...wallet,
                isReady,
                networkConfig: NETWORK_CONFIG,
                networkMismatch,
                canAuthorize,
                accountChange,
                confirmAccountChange,
                cancelAccountChange,
                invalidatePendingOperations,
            }}
        >
            {children}
        </WalletContext.Provider>
    );
}

export function useWalletContext() {
    const context = useContext(WalletContext);
    if (context === undefined) {
        throw new Error('useWalletContext must be used within a WalletProvider');
    }
    return context;
}
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>