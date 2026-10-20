import { isConnected, getAddress, signTransaction, getNetwork } from '@stellar/freighter-api';

export type StellarNetwork = 'testnet' | 'mainnet';

export interface WalletState {
  isConnected: boolean;
  address: string | null;
  network: StellarNetwork;
  networkMismatch: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface WalletChangeEvent {
  type: 'accountChanged' | 'networkChanged' | 'disconnected';
  address: string | null;
  network: StellarNetwork;
}

export type WalletChangeListener = (event: WalletChangeEvent) => void;

/**
 * Cached public key so we can detect account switches without a round trip.
 * Cleared on disconnect or explicit invalidation.
 */
let cachedPublicKey: string | null = null;

const walletChangeListeners = new Set<WalletChangeListener>();
let pollingHandle: ReturnType<typeof setInterval> | null = null;
let lastKnownAddress: string | null = null;
let lastKnownNetwork: StellarNetwork | null = null;
let pollingInFlight = false;

/**
 * Clear the cached public key. Call this on disconnect or when the wallet
 * account is known to have changed so stale signatures are not reused.
 */
export function clearCachedPublicKey(): void {
  cachedPublicKey = null;
}

/**
 * Return the cached public key (if any) without hitting the wallet.
 */
export function getCachedPublicKey(): string | null {
  return cachedPublicKey;
}

/**
 * Compare an operation owner address against the currently active wallet
 * address. Returns true when they differ (i.e. the account switched).
 */
export function hasAccountSwitched(operationOwner: string | null | undefined): boolean {
  if (!operationOwner) return false;
  if (!cachedPublicKey) return false;
  return operationOwner !== cachedPublicKey;
}

/**
 * Normalize a raw Freighter network string to our canonical network type.
 * Freighter reports 'PUBLIC' for mainnet and 'TESTNET' for testnet.
 */
export function normalizeWalletNetwork(raw: string | null | undefined): StellarNetwork {
  const value = (raw ?? '').toUpperCase();
  if (value === 'PUBLIC' || value === 'MAINNET') return 'mainnet';
  return 'testnet';
}

/**
 * Subscribe to wallet account/network changes. Uses polling (focus + interval)
 * since Freighter does not reliably emit events across all versions.
 * Returns an unsubscribe function.
 */
export function subscribeToWalletChanges(listener: WalletChangeListener): () => void {
  walletChangeListeners.add(listener);
  ensurePolling();
  return () => {
    walletChangeListeners.delete(listener);
    if (walletChangeListeners.size === 0) {
      stopPolling();
    }
  };
}

function emitWalletChange(event: WalletChangeEvent): void {
  walletChangeListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // Listener errors must not break other subscribers.
    }
  });
}

function ensurePolling(): void {
  if (pollingHandle !== null || typeof window === 'undefined') return;
  pollingHandle = setInterval(() => {
    void pollWalletState();
  }, 3000);
  window.addEventListener('focus', handleFocusCheck);
}

function stopPolling(): void {
  if (pollingHandle !== null) {
    clearInterval(pollingHandle);
    pollingHandle = null;
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', handleFocusCheck);
  }
  lastKnownAddress = null;
  lastKnownNetwork = null;
}

function handleFocusCheck(): void {
  void pollWalletState();
}

async function pollWalletState(): Promise<void> {
  if (pollingInFlight) return;
  pollingInFlight = true;
  try {
    const connected = await isFreighterInstalled();
    if (!connected) {
      if (lastKnownAddress !== null) {
        lastKnownAddress = null;
        lastKnownNetwork = null;
        clearCachedPublicKey();
        emitWalletChange({ type: 'disconnected', address: null, network: lastKnownNetwork ?? 'testnet' });
      }
      return;
    }

    const address = await getFreighterPublicKey();
    const network = await getWalletNetwork();

    if (lastKnownAddress !== null && address !== lastKnownAddress) {
      clearCachedPublicKey();
      emitWalletChange({ type: 'accountChanged', address, network });
    } else if (lastKnownNetwork !== null && network !== lastKnownNetwork) {
      emitWalletChange({ type: 'networkChanged', address, network });
    }

    lastKnownAddress = address;
    lastKnownNetwork = network;
  } catch {
    // Ignore transient errors during polling.
  } finally {
    pollingInFlight = false;
  }
}

export class FreighterError extends Error {
  constructor(
    message: string,
    public code: 'NOT_INSTALLED' | 'NOT_CONNECTED' | 'SIGN_FAILED' | 'USER_REJECTED' | 'NETWORK_ERROR' | 'NETWORK_MISMATCH' | 'TIMEOUT' = 'NETWORK_ERROR'
  ) {
    super(message);
    this.name = 'FreighterError';
  }
}

const FREIGHTER_ERROR_MESSAGES: Record<FreighterError['code'], string> = {
  NOT_INSTALLED: 'Freighter wallet is not installed. Please install it from https://www.freighter.app',
  NOT_CONNECTED: 'Wallet is not connected in Freighter. Please open Freighter and connect your account.',
  SIGN_FAILED: 'Failed to sign the transaction. Please try again.',
  USER_REJECTED: 'You rejected the connection request. Please try again.',
  NETWORK_ERROR: 'Freighter wallet request failed. Please try again.',
  NETWORK_MISMATCH: 'Freighter is on a different network than this app.',
  TIMEOUT: 'Signing request timed out. Please check your wallet and try again.',
};

export function getFreighterErrorMessage(
  error: unknown,
  fallback = 'Freighter wallet request failed. Please try again.',
): string {
  if (error instanceof FreighterError) {
    return FREIGHTER_ERROR_MESSAGES[error.code] ?? error.message;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes('not installed')) return FREIGHTER_ERROR_MESSAGES.NOT_INSTALLED;
    if (lower.includes('not connected')) return FREIGHTER_ERROR_MESSAGES.NOT_CONNECTED;
    if (lower.includes('rejected')) return FREIGHTER_ERROR_MESSAGES.USER_REJECTED;
    if (lower.includes('timed out')) return FREIGHTER_ERROR_MESSAGES.TIMEOUT;
    if (lower.includes('network mismatch')) return error.message;
    return error.message;
  }

  return fallback;
}

/**
 * Get the wallet's current network from Freighter.
 * Throws NETWORK_ERROR when the wallet cannot report its network so callers
 * never silently assume a network.
 */
export async function getWalletNetwork(): Promise<StellarNetwork> {
  try {
    const result = await getNetwork();
    if (result.error) {
      throw new FreighterError('Failed to get wallet network', 'NETWORK_ERROR');
    }
    return normalizeWalletNetwork(result.network);
  } catch (error) {
    if (error instanceof FreighterError) throw error;
    throw new FreighterError(
      error instanceof Error ? error.message : 'Failed to get wallet network',
      'NETWORK_ERROR'
    );
  }
}

/**
 * Check if wallet network matches the expected network
 */
export async function checkNetworkMatch(expectedNetwork: StellarNetwork): Promise<boolean> {
  try {
    const walletNetwork = await getWalletNetwork();
    return walletNetwork === expectedNetwork;
  } catch (error) {
    return false;
  }
}

/**
 * Assert that the wallet network matches the expected network, throwing an
 * actionable NETWORK_MISMATCH error otherwise.
 */
export async function assertNetworkMatch(expectedNetwork: StellarNetwork): Promise<void> {
  const walletNetwork = await getWalletNetwork();
  if (walletNetwork !== expectedNetwork) {
    throw new FreighterError(
      `Wallet is on ${walletNetwork} but this app is configured for ${expectedNetwork}. ` +
        `Open Freighter and switch to ${expectedNetwork} before continuing.`,
      'NETWORK_MISMATCH'
    );
  }
}

/**
 * Check if Freighter wallet is installed and connected
 */
export async function isFreighterInstalled(): Promise<boolean> {
  try {
    const result = await isConnected();
    return result.isConnected;
  } catch (error) {
    return false;
  }
}

/**
 * Get the currently connected Freighter wallet public key/address
 */
export async function getFreighterPublicKey(): Promise<string> {
  try {
    const result = await getAddress();
    if (result.error) {
      if (result.error.message?.includes('Not connected')) {
        throw new FreighterError('Wallet not connected. Please open Freighter and connect.', 'NOT_CONNECTED');
      }
      throw new FreighterError(
        result.error.message || 'Failed to get wallet address',
        'NETWORK_ERROR'
      );
    }
    if (!result.address) {
      throw new FreighterError('No address returned from wallet', 'NOT_CONNECTED');
    }
    cachedPublicKey = result.address;
    return result.address;
  } catch (error) {
    if (error instanceof FreighterError) throw error;
    throw new FreighterError(
      error instanceof Error ? error.message : 'Failed to get wallet address',
      'NETWORK_ERROR'
    );
  }
}

/**
 * Sign a transaction with Freighter wallet
 */
export async function signWithFreighter(
  xdr: string, 
  network: StellarNetwork,
  options?: { timeout?: number; expectedAddress?: string }
): Promise<string> {
  const timeout = options?.timeout ?? 60000; // 60 seconds default
  
  try {
    // Check network match before signing
    await assertNetworkMatch(network);

    // Ensure the active account still owns this operation before signing.
    const activeAddress = await getFreighterPublicKey();
    if (options?.expectedAddress && activeAddress !== options.expectedAddress) {
      clearCachedPublicKey();
      throw new FreighterError(
        `Wallet account changed to ${activeAddress} but this operation belongs to ${options.expectedAddress}. ` +
          `Please switch back in Freighter or restart the flow.`,
        'NETWORK_MISMATCH'
      );
    }

    const networkPassphrase = getNetworkPassphrase(network);
    
    // Wrap signing in a timeout promise
    const signPromise = signTransaction(xdr, { networkPassphrase });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new FreighterError('Signing request timed out', 'TIMEOUT')), timeout);
    });

    const result = await Promise.race([signPromise, timeoutPromise]);

    if (result.error) {
      if (result.error.message?.includes('rejected')) {
        throw new FreighterError('Transaction signing rejected by user', 'USER_REJECTED');
      }
      throw new FreighterError(
        result.error.message || 'Failed to sign transaction',
        'SIGN_FAILED'
      );
    }

    if (!result.signedTxXdr || !result.signedTxXdr.trim()) {
      throw new FreighterError('No signed transaction returned', 'SIGN_FAILED');
    }

    return result.signedTxXdr;
  } catch (error) {
    if (error instanceof FreighterError) throw error;
    throw new FreighterError(
      error instanceof Error ? error.message : 'Transaction signing failed',
      'SIGN_FAILED'
    );
  }
}

/**
 * Get network passphrase for transaction signing
 */
export function getNetworkPassphrase(network: StellarNetwork): string {
  const passphrases = {
    testnet: 'Test SDF Network ; September 2015',
    mainnet: 'Public Global Stellar Network ; September 2015',
  };
  return passphrases[network];
}

/**
 * Verify if an address is a valid Stellar public key
 */
export function isValidStellarAddress(address: string): boolean {
  // Stellar public keys start with 'G' and are base32 encoded (56 chars)
  return /^G[A-Z2-7]{55}$/.test(address);
}

/**
 * Connect to Freighter wallet
 * @throws FreighterError if wallet is not installed or connection fails
 */
export async function connectFreighterWallet(expectedNetwork?: StellarNetwork): Promise<string> {
  const installed = await isFreighterInstalled();
  if (!installed) {
    throw new FreighterError(
      'Freighter wallet is not installed. Please install it from https://www.freighter.app',
      'NOT_INSTALLED'
    );
  }

  const address = await getFreighterPublicKey();
  if (!isValidStellarAddress(address)) {
    throw new FreighterError('Invalid wallet address format', 'NETWORK_ERROR');
  }

  // Check network match if expected network is provided
  if (expectedNetwork) {
    await assertNetworkMatch(expectedNetwork);
  }

  return address;
}

/**
 * Disconnect the wallet locally: clears cached public key and stops polling.
 * Does not delete any unrelated account data.
 */
export function disconnectFreighterWallet(): void {
  clearCachedPublicKey();
  lastKnownAddress = null;
  lastKnownNetwork = null;
  emitWalletChange({ type: 'disconnected', address: null, network: 'testnet' });
}

/**
 * Get wallet status without throwing
 */
export async function getWalletStatus(expectedNetwork?: StellarNetwork): Promise<WalletState> {
  try {
    const installed = await isFreighterInstalled();
    if (!installed) {
      clearCachedPublicKey();
      return {
        isConnected: false,
        address: null,
        network: expectedNetwork || 'testnet',
        networkMismatch: false,
        isLoading: false,
        error: 'Freighter wallet not installed',
      };
    }

    const address = await getFreighterPublicKey();
    const walletNetwork = await getWalletNetwork();
    const networkMismatch = expectedNetwork ? walletNetwork !== expectedNetwork : false;

    return {
      isConnected: true,
      address,
      network: walletNetwork,
      networkMismatch,
      isLoading: false,
      error: networkMismatch 
        ? `Wallet is on ${walletNetwork} but app expects ${expectedNetwork}. Please switch networks in Freighter.`
        : null,
    };
  } catch (error) {
    clearCachedPublicKey();
    return {
      isConnected: false,
      address: null,
      network: expectedNetwork || 'testnet',
      networkMismatch: false,
      isLoading: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
