export type StellarNetwork = 'testnet' | 'mainnet';

export const STELLAR_NETWORKS = {
  testnet: {
    name: 'Testnet',
    passphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    name: 'Mainnet',
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
  },
} as const;

export const SUPPORTED_NETWORKS: readonly StellarNetwork[] = ['testnet', 'mainnet'];

export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return value === 'testnet' || value === 'mainnet';
}

export function getNetworkConfig(network: StellarNetwork = 'testnet') {
  return STELLAR_NETWORKS[network];
}

export function getNetworkPassphrase(network: StellarNetwork = 'testnet'): string {
  return STELLAR_NETWORKS[network].passphrase;
}

export function getNetworkName(network: StellarNetwork): string {
  return STELLAR_NETWORKS[network].name;
}

/**
 * Resolve a network identifier from a passphrase. Returns null when the
 * passphrase does not match any known network.
 */
export function getNetworkFromPassphrase(passphrase: string | null | undefined): StellarNetwork | null {
  if (!passphrase) return null;
  for (const network of SUPPORTED_NETWORKS) {
    if (STELLAR_NETWORKS[network].passphrase === passphrase) {
      return network;
    }
  }
  return null;
}

/**
 * Get the expected network from environment configuration.
 *
 * Production must never silently default to testnet: if the app is running in
 * production and no explicit network is configured, this throws so the
 * misconfiguration surfaces immediately rather than routing users to testnet.
 */
export function getExpectedNetwork(): StellarNetwork {
  const raw = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  const isProduction = process.env.NODE_ENV === 'production';

  if (raw === undefined || raw === null || raw === '') {
    if (isProduction) {
      throw new Error(
        'Stellar network is not configured. Set NEXT_PUBLIC_STELLAR_NETWORK to "mainnet" or "testnet" before deploying to production.',
      );
    }
    return 'testnet';
  }

  const normalized = raw.trim().toLowerCase();
  if (!isStellarNetwork(normalized)) {
    throw new Error(
      `Invalid Stellar network "${raw}". NEXT_PUBLIC_STELLAR_NETWORK must be "mainnet" or "testnet".`,
    );
  }

  return normalized;
}

/**
 * Safely resolve the expected network without throwing. Useful for rendering
 * configuration errors in the UI instead of crashing.
 */
export function tryGetExpectedNetwork(): { network: StellarNetwork | null; error: string | null } {
  try {
    return { network: getExpectedNetwork(), error: null };
  } catch (err) {
    return { network: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface NetworkMismatch {
  expected: StellarNetwork;
  actual: StellarNetwork | null;
  message: string;
}

/**
 * Compare the wallet's network against the server/backend expectation.
 * Returns null when they match, otherwise an actionable mismatch descriptor.
 */
export function compareNetworks(
  expected: StellarNetwork,
  actual: StellarNetwork | null | undefined,
): NetworkMismatch | null {
  if (actual === null || actual === undefined) {
    return {
      expected,
      actual: null,
      message: `Unable to determine your wallet's network. This app requires ${getNetworkName(
        expected,
      )}. Please switch your wallet to ${getNetworkName(expected)} and try again.`,
    };
  }

  if (actual !== expected) {
    return {
      expected,
      actual,
      message: `Network mismatch: your wallet is on ${getNetworkName(
        actual,
      )} but this app requires ${getNetworkName(
        expected,
      )}. Switch your wallet to ${getNetworkName(expected)} before signing.`,
    };
  }

  return null;
}

/**
 * Compare a wallet passphrase against the expected network.
 */
export function comparePassphrase(
  expected: StellarNetwork,
  passphrase: string | null | undefined,
): NetworkMismatch | null {
  const actual = getNetworkFromPassphrase(passphrase);
  if (passphrase && actual === null) {
    return {
      expected,
      actual: null,
      message: `Your wallet is connected to an unrecognized Stellar network. This app requires ${getNetworkName(
        expected,
      )}. Please switch your wallet to ${getNetworkName(expected)} and try again.`,
    };
  }
  return compareNetworks(expected, actual);
}

/**
 * Assert that the wallet and server expectations match. Throws an actionable
 * error on mismatch so callers can abort before signing or broadcasting.
 */
export function assertNetworkMatch(
  expected: StellarNetwork,
  actual: StellarNetwork | null | undefined,
): void {
  const mismatch = compareNetworks(expected, actual);
  if (mismatch) {
    throw new Error(mismatch.message);
  }
}

/**
 * Get the block explorer URL for a transaction
 */
export function getExplorerUrl(txHash: string, network: StellarNetwork): string {
  const base =
    network === 'mainnet'
      ? 'https://stellar.expert/explorer/public/tx/'
      : 'https://stellar.expert/explorer/testnet/tx/';
  return `${base}${txHash}`;
}