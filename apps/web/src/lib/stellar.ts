import * as StellarSdk from '@stellar/stellar-sdk';

export type StellarNetwork = 'testnet' | 'mainnet';

export interface StellarNetworkConfig {
  name: string;
  passphrase: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
  contractIds: Record<string, string>;
}

export const STELLAR_NETWORKS: Record<StellarNetwork, StellarNetworkConfig> = {
  testnet: {
    name: 'Testnet',
    passphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    contractIds: {
      escrow: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      payments: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4',
    },
  },
  mainnet: {
    name: 'Mainnet',
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
    contractIds: {
      escrow: 'CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDSC4',
      payments: 'CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEESC4',
    },
  },
};

const VALID_NETWORKS: StellarNetwork[] = ['testnet', 'mainnet'];

export class NetworkMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkMismatchError';
  }
}

export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return typeof value === 'string' && (VALID_NETWORKS as string[]).includes(value);
}

export function assertValidNetwork(network: unknown): StellarNetwork {
  if (!isStellarNetwork(network)) {
    throw new NetworkMismatchError(
      `Unknown Stellar network "${String(network)}". Expected one of: ${VALID_NETWORKS.join(', ')}.`,
    );
  }
  return network;
}

export function getNetworkConfig(network: StellarNetwork = 'testnet'): StellarNetworkConfig {
  return STELLAR_NETWORKS[assertValidNetwork(network)];
}

export function getHorizonServer(network: StellarNetwork = 'testnet') {
  const config = getNetworkConfig(network);
  return new StellarSdk.Horizon.Server(config.horizonUrl);
}

export function getSorobanServer(network: StellarNetwork = 'testnet') {
  const config = getNetworkConfig(network);
  return new StellarSdk.SorobanRpc.Server(config.sorobanRpcUrl);
}

export function getContractId(network: StellarNetwork, contractName: string): string {
  const config = getNetworkConfig(network);
  const contractId = config.contractIds[contractName];
  if (!contractId) {
    throw new NetworkMismatchError(
      `No contract ID configured for "${contractName}" on ${config.name}.`,
    );
  }
  return contractId;
}

/**
 * Compares the wallet's reported network against the server's expected network.
 * Throws a NetworkMismatchError with an actionable message when they differ.
 */
export function assertNetworkMatch(
  walletNetwork: unknown,
  expectedNetwork: StellarNetwork,
): StellarNetwork {
  const expected = assertValidNetwork(expectedNetwork);
  if (!isStellarNetwork(walletNetwork)) {
    throw new NetworkMismatchError(
      `Wallet did not report a recognized network. Please switch your wallet to ${getNetworkConfig(expected).name}.`,
    );
  }
  if (walletNetwork !== expected) {
    throw new NetworkMismatchError(
      `Wallet is on ${getNetworkConfig(walletNetwork).name} but this app expects ${getNetworkConfig(expected).name}. ` +
        `Switch your wallet network to ${getNetworkConfig(expected).name} before signing.`,
    );
  }
  return expected;
}

export interface SigningIntent {
  network: StellarNetwork;
  passphrase: string;
  xdr: string;
}

/**
 * Builds a signing intent tagged with the network. Validates the wallet network
 * against the expected network before returning anything that can be signed.
 */
export function createSigningIntent(params: {
  network: StellarNetwork;
  walletNetwork: unknown;
  xdr: string;
}): SigningIntent {
  const network = assertNetworkMatch(params.walletNetwork, params.network);
  const config = getNetworkConfig(network);
  return {
    network,
    passphrase: config.passphrase,
    xdr: params.xdr,
  };
}

/**
 * Verifies that a transaction envelope's network passphrase matches the expected network.
 * Rejects mismatches before broadcast.
 */
export function assertTransactionNetwork(
  transaction: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
  expectedNetwork: StellarNetwork,
): void {
  const expected = assertValidNetwork(expectedNetwork);
  const config = getNetworkConfig(expected);
  const txNetworkPassphrase = (transaction as { networkPassphrase?: string }).networkPassphrase;
  if (txNetworkPassphrase && txNetworkPassphrase !== config.passphrase) {
    throw new NetworkMismatchError(
      `Transaction was built for a different network than ${config.name}. Refusing to submit.`,
    );
  }
}