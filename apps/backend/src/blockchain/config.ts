import { Networks, StrKey } from '@stellar/stellar-sdk';

/**
 * Centralized Stellar network configuration.
 *
 * This module is the single source of truth for the network passphrase, RPC
 * and Horizon endpoints, contract IDs, WASM hashes, ABI versions and
 * initialization dependencies. It is imported by env.ts, soroban.ts,
 * transactionUtils.ts and the contract clients so that wallet, backend,
 * contract and RPC configuration can never drift apart silently.
 */

export type StellarNetworkName = 'testnet' | 'mainnet' | 'futurenet';

export interface ContractVersionRecord {
  /** Contract ID (StrKey `C...`) deployed on this network. */
  contractId: string;
  /** Hex-encoded SHA-256 of the deployed WASM blob. */
  wasmHash: string;
  /** ABI version the application is compiled against. */
  abiVersion: string;
  /** Contracts that must be initialized before this one is usable. */
  initializationDependencies: string[];
  /** Application releases known to be compatible with this record. */
  compatibleAppReleases: string[];
}

export interface NetworkConfig {
  name: StellarNetworkName;
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  contracts: {
    propertyListing: ContractVersionRecord;
    booking: ContractVersionRecord;
    review: ContractVersionRecord;
  };
}

export const SUPPORTED_NETWORKS: Record<StellarNetworkName, {
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string;
}> = {
  testnet: {
    passphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  mainnet: {
    passphrase: Networks.PUBLIC,
    rpcUrl: 'https://soroban-mainnet.stellar.org',
    horizonUrl: 'https://horizon.stellar.org',
  },
  futurenet: {
    passphrase: Networks.FUTURENET,
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
  },
};

/** ABI version this build of the application expects. */
export const EXPECTED_ABI_VERSION = process.env.STELLAR_ABI_VERSION ?? '1.0.0';

/** Application release identifier, used for compatibility checks. */
export const APP_RELEASE = process.env.APP_RELEASE ?? 'dev';

const IS_PRODUCTION =
  process.env.NODE_ENV === 'production' ||
  process.env.STELLAR_ENVIRONMENT === 'production';

function resolveNetworkName(): StellarNetworkName | undefined {
  const raw = (
    process.env.STELLAR_NETWORK ??
    process.env.STELLAR_NETWORK_NAME ??
    ''
  ).toLowerCase();

  if (raw === 'testnet' || raw === 'mainnet' || raw === 'futurenet') {
    return raw;
  }

  // Fall back to inferring from an explicit passphrase, if provided.
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  if (passphrase) {
    const match = (Object.keys(SUPPORTED_NETWORKS) as StellarNetworkName[]).find(
      (name) => SUPPORTED_NETWORKS[name].passphrase === passphrase,
    );
    if (match) return match;
  }

  return undefined;
}

export const ACTIVE_NETWORK_NAME: StellarNetworkName | undefined =
  resolveNetworkName();

const activeDefaults = ACTIVE_NETWORK_NAME
  ? SUPPORTED_NETWORKS[ACTIVE_NETWORK_NAME]
  : undefined;

export const STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ??
  activeDefaults?.rpcUrl ??
  SUPPORTED_NETWORKS.testnet.rpcUrl;

export const STELLAR_HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ??
  activeDefaults?.horizonUrl ??
  SUPPORTED_NETWORKS.testnet.horizonUrl;

export const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ??
  activeDefaults?.passphrase ??
  Networks.TESTNET;

export const PROPERTY_LISTING_CONTRACT_ID =
  process.env.PROPERTY_LISTING_CONTRACT_ID ?? '';

export const BOOKING_CONTRACT_ID = process.env.BOOKING_CONTRACT_ID ?? '';

export const REVIEW_CONTRACT_ID = process.env.REVIEW_CONTRACT_ID ?? '';

export const PROPERTY_LISTING_WASM_HASH =
  process.env.PROPERTY_LISTING_WASM_HASH ?? '';

export const BOOKING_WASM_HASH = process.env.BOOKING_WASM_HASH ?? '';

export const REVIEW_WASM_HASH = process.env.REVIEW_WASM_HASH ?? '';

export const PROPERTY_LISTING_ABI_VERSION =
  process.env.PROPERTY_LISTING_ABI_VERSION ?? EXPECTED_ABI_VERSION;

export const BOOKING_ABI_VERSION =
  process.env.BOOKING_ABI_VERSION ?? EXPECTED_ABI_VERSION;

export const REVIEW_ABI_VERSION =
  process.env.REVIEW_ABI_VERSION ?? EXPECTED_ABI_VERSION;

export const STELLAR_SOURCE_ACCOUNT =
  process.env.STELLAR_SOURCE_ACCOUNT ??
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

export const STELLAR_ADMIN_SECRET = process.env.STELLAR_ADMIN_SECRET ?? '';

export const BASE_FEE = process.env.STELLAR_BASE_FEE ?? '100';

export const BLOCKCHAIN_FEATURES_ENABLED =
  process.env.BLOCKCHAIN_FEATURES_ENABLED === 'true';

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const NETWORK_CONFIG: NetworkConfig = {
  name: ACTIVE_NETWORK_NAME ?? 'testnet',
  passphrase: NETWORK_PASSPHRASE,
  rpcUrl: STELLAR_RPC_URL,
  horizonUrl: STELLAR_HORIZON_URL,
  contracts: {
    propertyListing: {
      contractId: PROPERTY_LISTING_CONTRACT_ID,
      wasmHash: PROPERTY_LISTING_WASM_HASH,
      abiVersion: PROPERTY_LISTING_ABI_VERSION,
      initializationDependencies: parseList(
        process.env.PROPERTY_LISTING_INIT_DEPENDENCIES,
      ),
      compatibleAppReleases: parseList(
        process.env.PROPERTY_LISTING_COMPATIBLE_RELEASES,
      ),
    },
    booking: {
      contractId: BOOKING_CONTRACT_ID,
      wasmHash: BOOKING_WASM_HASH,
      abiVersion: BOOKING_ABI_VERSION,
      initializationDependencies: parseList(
        process.env.BOOKING_INIT_DEPENDENCIES,
      ),
      compatibleAppReleases: parseList(
        process.env.BOOKING_COMPATIBLE_RELEASES,
      ),
    },
    review: {
      contractId: REVIEW_CONTRACT_ID,
      wasmHash: REVIEW_WASM_HASH,
      abiVersion: REVIEW_ABI_VERSION,
      initializationDependencies: parseList(
        process.env.REVIEW_INIT_DEPENDENCIES,
      ),
      compatibleAppReleases: parseList(
        process.env.REVIEW_COMPATIBLE_RELEASES,
      ),
    },
  },
};

export interface ConfigValidationError {
  field: string;
  message: string;
}

function isValidContractId(id: string): boolean {
  if (!id) return false;
  try {
    return StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidWasmHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

function compareAbiVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function validateContractRecord(
  label: string,
  record: ContractVersionRecord,
  errors: ConfigValidationError[],
): void {
  if (!isValidContractId(record.contractId)) {
    errors.push({
      field: `${label}_CONTRACT_ID`,
      message: `Invalid or missing contract ID: ${record.contractId}`,
    });
  }

  if (!record.wasmHash) {
    errors.push({
      field: `${label}_WASM_HASH`,
      message: 'Deployed WASM hash is required to verify the contract version',
    });
  } else if (!isValidWasmHash(record.wasmHash)) {
    errors.push({
      field: `${label}_WASM_HASH`,
      message: `WASM hash must be a 64-character hex string: ${record.wasmHash}`,
    });
  }

  if (!record.abiVersion) {
    errors.push({
      field: `${label}_ABI_VERSION`,
      message: 'ABI version is required',
    });
  } else if (compareAbiVersions(record.abiVersion, EXPECTED_ABI_VERSION) !== 0) {
    errors.push({
      field: `${label}_ABI_VERSION`,
      message:
        `Incompatible ABI version ${record.abiVersion}; this release expects ` +
        `${EXPECTED_ABI_VERSION}. Redeploy the contract or upgrade the application.`,
    });
  }

  if (
    record.compatibleAppReleases.length > 0 &&
    !record.compatibleAppReleases.includes(APP_RELEASE)
  ) {
    errors.push({
      field: `${label}_COMPATIBLE_RELEASES`,
      message:
        `Application release ${APP_RELEASE} is not listed as compatible with ` +
        `${label} contract ${record.contractId}`,
    });
  }
}

/**
 * Validates the network configuration. Fails fast in production when the
 * network is missing or set to testnet, and rejects unknown or incompatible
 * contract IDs / ABI versions.
 */
export function validateNetworkConfig(): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (!ACTIVE_NETWORK_NAME) {
    errors.push({
      field: 'STELLAR_NETWORK',
      message:
        'Stellar network is not configured. Set STELLAR_NETWORK to one of ' +
        `${Object.keys(SUPPORTED_NETWORKS).join(', ')}.`,
    });
  }

  if (IS_PRODUCTION) {
    if (!ACTIVE_NETWORK_NAME) {
      // Already reported above; keep the production-specific hint.
      errors.push({
        field: 'STELLAR_NETWORK',
        message:
          'Production must explicitly configure STELLAR_NETWORK; it cannot ' +
          'silently default to testnet.',
      });
    } else if (ACTIVE_NETWORK_NAME === 'testnet') {
      errors.push({
        field: 'STELLAR_NETWORK',
        message:
          'Refusing to run production against testnet. Set STELLAR_NETWORK=mainnet.',
      });
    }
  }

  if (!isValidUrl(STELLAR_RPC_URL)) {
    errors.push({
      field: 'STELLAR_RPC_URL',
      message: `Invalid RPC URL: ${STELLAR_RPC_URL}`,
    });
  }

  if (!isValidUrl(STELLAR_HORIZON_URL)) {
    errors.push({
      field: 'STELLAR_HORIZON_URL',
      message: `Invalid Horizon URL: ${STELLAR_HORIZON_URL}`,
    });
  }

  if (!NETWORK_PASSPHRASE) {
    errors.push({
      field: 'STELLAR_NETWORK_PASSPHRASE',
      message: 'Network passphrase is required',
    });
  } else if (
    ACTIVE_NETWORK_NAME &&
    SUPPORTED_NETWORKS[ACTIVE_NETWORK_NAME].passphrase !== NETWORK_PASSPHRASE
  ) {
    errors.push({
      field: 'STELLAR_NETWORK_PASSPHRASE',
      message:
        `Passphrase does not match network ${ACTIVE_NETWORK_NAME}. Expected ` +
        `"${SUPPORTED_NETWORKS[ACTIVE_NETWORK_NAME].passphrase}".`,
    });
  }

  if (BLOCKCHAIN_FEATURES_ENABLED) {
    validateContractRecord(
      'PROPERTY_LISTING',
      NETWORK_CONFIG.contracts.propertyListing,
      errors,
    );
    validateContractRecord(
      'BOOKING',
      NETWORK_CONFIG.contracts.booking,
      errors,
    );
    validateContractRecord('REVIEW', NETWORK_CONFIG.contracts.review, errors);

    if (!STELLAR_ADMIN_SECRET) {
      errors.push({
        field: 'STELLAR_ADMIN_SECRET',
        message: 'Admin secret key is required when blockchain features are enabled',
      });
    }
  }

  return errors;
}

/**
 * Throws when the network configuration is invalid. Intended to be called at
 * startup so unknown or incompatible contract configuration is detected
 * before critical traffic.
 */
export function assertValidNetworkConfig(): void {
  const errors = validateNetworkConfig();
  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Invalid Stellar network configuration — ${summary}`);
  }
}

export interface NetworkMismatch {
  mismatch: true;
  code: 'NETWORK_MISMATCH' | 'NETWORK_MISSING';
  expectedPassphrase: string;
  receivedPassphrase: string | undefined;
  message: string;
}

export type NetworkComparison = { mismatch: false } | NetworkMismatch;

/**
 * Compares a wallet-reported network passphrase against the configured one.
 * Returns an actionable mismatch description instead of throwing so callers
 * can surface it to the user before signing or broadcasting.
 */
export function compareWalletNetwork(
  walletPassphrase: string | undefined | null,
): NetworkComparison {
  if (!walletPassphrase) {
    return {
      mismatch: true,
      code: 'NETWORK_MISSING',
      expectedPassphrase: NETWORK_PASSPHRASE,
      receivedPassphrase: undefined,
      message:
        `Your wallet did not report a network. Switch it to ` +
        `${NETWORK_CONFIG.name} (${NETWORK_PASSPHRASE}) and try again.`,
    };
  }

  if (walletPassphrase !== NETWORK_PASSPHRASE) {
    return {
      mismatch: true,
      code: 'NETWORK_MISMATCH',
      expectedPassphrase: NETWORK_PASSPHRASE,
      receivedPassphrase: walletPassphrase,
      message:
        `Wallet network does not match the server. The server expects ` +
        `${NETWORK_CONFIG.name} (${NETWORK_PASSPHRASE}) but the wallet reported ` +
        `"${walletPassphrase}". Switch your wallet network to ` +
        `${NETWORK_CONFIG.name} before signing.`,
    };
  }

  return { mismatch: false };
}

/**
 * Throws an actionable error when the wallet network does not match. Use this
 * before signing or broadcasting any transaction.
 */
export function assertWalletNetwork(walletPassphrase: string | undefined | null): void {
  const result = compareWalletNetwork(walletPassphrase);
  if (result.mismatch) {
    const error = new Error(result.message) as Error & {
      code?: string;
      expectedPassphrase?: string;
      receivedPassphrase?: string;
    };
    error.code = result.code;
    error.expectedPassphrase = result.expectedPassphrase;
    error.receivedPassphrase = result.receivedPassphrase;
    throw error;
  }
}

/** Non-sensitive version health data for operators. */
export function getNetworkHealth() {
  return {
    network: NETWORK_CONFIG.name,
    passphrase: NETWORK_CONFIG.passphrase,
    rpcUrl: NETWORK_CONFIG.rpcUrl,
    horizonUrl: NETWORK_CONFIG.horizonUrl,
    expectedAbiVersion: EXPECTED_ABI_VERSION,
    appRelease: APP_RELEASE,
    contracts: Object.fromEntries(
      Object.entries(NETWORK_CONFIG.contracts).map(([key, record]) => [
        key,
        {
          contractId: record.contractId,
          wasmHash: record.wasmHash,
          abiVersion: record.abiVersion,
          initializationDependencies: record.initializationDependencies,
        },
      ]),
    ),
  };
}

/** @deprecated Use validateNetworkConfig() instead. */
export function validateBlockchainConfig(): ConfigValidationError[] {
  return validateNetworkConfig();
}
