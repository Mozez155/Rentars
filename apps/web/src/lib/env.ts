/**
 * Frontend environment configuration validation.
 * 
 * Validates public environment variables at build time using Zod.
 * On failure, throws with clear error messages listing all issues.
 * On success, exports a typed, frozen `env` object.
 */

import { z } from 'zod';

const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string()
    .url('NEXT_PUBLIC_API_URL must be a valid URL')
    .refine(
      (url) => {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      },
      'NEXT_PUBLIC_API_URL must use http:// or https://'
    ),

  // Network must be explicitly configured. There is no default: an unset or
  // empty value fails validation so production can never silently fall back
  // to testnet.
  NEXT_PUBLIC_STELLAR_NETWORK: z
    .enum(['testnet', 'mainnet', 'futurenet'], {
      errorMap: () => ({
        message:
          'NEXT_PUBLIC_STELLAR_NETWORK must be explicitly set to one of: testnet, mainnet, futurenet',
      }),
    })
    .refine((network) => network.trim().length > 0, {
      message: 'NEXT_PUBLIC_STELLAR_NETWORK must not be empty',
    }),

  // Contract ID deployed on the selected network (required).
  NEXT_PUBLIC_CONTRACT_ID: z
    .string()
    .min(1, 'NEXT_PUBLIC_CONTRACT_ID is required')
    .regex(/^C[A-Z2-7]{55}$/, 'NEXT_PUBLIC_CONTRACT_ID must be a valid Stellar contract ID (C...)'),

  // ABI version the frontend was built against (required).
  NEXT_PUBLIC_CONTRACT_ABI_VERSION: z
    .string()
    .min(1, 'NEXT_PUBLIC_CONTRACT_ABI_VERSION is required'),

  // WASM hash of the deployed contract (required for version health checks).
  NEXT_PUBLIC_CONTRACT_WASM_HASH: z
    .string()
    .min(1, 'NEXT_PUBLIC_CONTRACT_WASM_HASH is required')
    .regex(/^[0-9a-f]{64}$/i, 'NEXT_PUBLIC_CONTRACT_WASM_HASH must be a 64-character hex string'),

  NEXT_PUBLIC_HORIZON_URL: z
    .string()
    .url('NEXT_PUBLIC_HORIZON_URL must be a valid URL')
    .refine(
      (url) => new URL(url).protocol === 'https:',
      'NEXT_PUBLIC_HORIZON_URL must use https://'
    ),

  NEXT_PUBLIC_SOROBAN_RPC_URL: z
    .string()
    .url('NEXT_PUBLIC_SOROBAN_RPC_URL must be a valid URL')
    .refine(
      (url) => new URL(url).protocol === 'https:',
      'NEXT_PUBLIC_SOROBAN_RPC_URL must use https://'
    ),

  NEXT_PUBLIC_PASSKEY_RP_ID: z
    .string()
    .min(1, 'NEXT_PUBLIC_PASSKEY_RP_ID is required'),

  NEXT_PUBLIC_PASSKEY_RP_NAME: z
    .string()
    .min(1, 'NEXT_PUBLIC_PASSKEY_RP_NAME is required'),

  NEXT_PUBLIC_PASSKEY_ORIGIN: z
    .string()
    .url('NEXT_PUBLIC_PASSKEY_ORIGIN must be a valid URL'),
});

/**
 * Detect whether a URL points at a testnet/futurenet endpoint.
 * Returns the detected network name, or 'mainnet' when no testnet marker
 * is present.
 */
function detectNetworkFromUrl(url: string): 'testnet' | 'futurenet' | 'mainnet' {
  const lower = url.toLowerCase();
  if (lower.includes('futurenet')) return 'futurenet';
  if (lower.includes('testnet')) return 'testnet';
  return 'mainnet';
}

/**
 * Determine whether the current runtime is a production deployment.
 * Server-side: NODE_ENV === 'production'.
 * Client-side: non-local, non-staging hostname.
 */
export function isProductionRuntime(): boolean {
  if (typeof window === 'undefined') {
    return process.env.NODE_ENV === 'production';
  }
  const host = window.location.hostname;
  return host !== 'localhost' && host !== '127.0.0.1' && !host.includes('staging');
}

// Cross-field validation: ensure network matches URLs and production safety.
const envWithCrossValidation = envSchema
  .refine(
    (data) => {
      const network = data.NEXT_PUBLIC_STELLAR_NETWORK;
      const horizonNetwork = detectNetworkFromUrl(data.NEXT_PUBLIC_HORIZON_URL);
      const sorobanNetwork = detectNetworkFromUrl(data.NEXT_PUBLIC_SOROBAN_RPC_URL);

      return horizonNetwork === network && sorobanNetwork === network;
    },
    {
      message:
        'Network configuration mismatch: NEXT_PUBLIC_STELLAR_NETWORK must match NEXT_PUBLIC_HORIZON_URL and NEXT_PUBLIC_SOROBAN_RPC_URL',
      path: ['NEXT_PUBLIC_STELLAR_NETWORK'],
    }
  )
  .refine(
    (data) => {
      // Production must never resolve to a non-mainnet network.
      if (isProductionRuntime()) {
        return data.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet';
      }
      return true;
    },
    {
      message:
        'Production deployment must use NEXT_PUBLIC_STELLAR_NETWORK=mainnet; refusing to run against testnet/futurenet',
      path: ['NEXT_PUBLIC_STELLAR_NETWORK'],
    }
  );

export type ClientEnvironment = z.infer<typeof envSchema>;

function validateEnv(): ClientEnvironment {
  const envVars = {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
    NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
    NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
    NEXT_PUBLIC_PASSKEY_RP_ID: process.env.NEXT_PUBLIC_PASSKEY_RP_ID,
    NEXT_PUBLIC_PASSKEY_RP_NAME: process.env.NEXT_PUBLIC_PASSKEY_RP_NAME,
    NEXT_PUBLIC_PASSKEY_ORIGIN: process.env.NEXT_PUBLIC_PASSKEY_ORIGIN,
    NEXT_PUBLIC_CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
    NEXT_PUBLIC_CONTRACT_ABI_VERSION: process.env.NEXT_PUBLIC_CONTRACT_ABI_VERSION,
    NEXT_PUBLIC_CONTRACT_WASM_HASH: process.env.NEXT_PUBLIC_CONTRACT_WASM_HASH,
  };

  const result = envWithCrossValidation.safeParse(envVars);

  if (!result.success) {
    const lines: string[] = [
      '',
      '❌  Frontend environment validation failed:',
      '',
    ];

    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      lines.push(`  • ${path}: ${issue.message}`);
    }

    lines.push('');
    console.error(lines.join('\n'));
    
    if (typeof window === 'undefined') {
      // Build-time: throw to fail the build
      throw new Error('Environment validation failed. Check the console for details.');
    } else {
      // Runtime: log but don't crash the app
      console.error('⚠️  Application may not function correctly with invalid configuration');
    }
  }

  return Object.freeze(result.data!) as ClientEnvironment;
}

export const env = validateEnv();

/**
 * The active Stellar network the app is configured for.
 * Exposed so the UI can display it before user authorization.
 */
export const activeNetwork: ClientEnvironment['NEXT_PUBLIC_STELLAR_NETWORK'] =
  env.NEXT_PUBLIC_STELLAR_NETWORK;

/**
 * Non-sensitive contract version metadata for the active network.
 * Used by the UI to display the deployed contract version and by startup
 * health checks to detect unknown/incompatible configuration.
 */
export interface ContractMetadata {
  network: ClientEnvironment['NEXT_PUBLIC_STELLAR_NETWORK'];
  contractId: string;
  abiVersion: string;
  wasmHash: string;
}

export const contractMetadata: Readonly<ContractMetadata> = Object.freeze({
  network: env.NEXT_PUBLIC_STELLAR_NETWORK,
  contractId: env.NEXT_PUBLIC_CONTRACT_ID,
  abiVersion: env.NEXT_PUBLIC_CONTRACT_ABI_VERSION,
  wasmHash: env.NEXT_PUBLIC_CONTRACT_WASM_HASH,
});

/**
 * Human-readable label for the active network, suitable for display in the UI.
 */
export function getActiveNetworkLabel(): string {
  switch (env.NEXT_PUBLIC_STELLAR_NETWORK) {
    case 'mainnet':
      return 'Mainnet';
    case 'testnet':
      return 'Testnet';
    case 'futurenet':
      return 'Futurenet';
    default:
      return env.NEXT_PUBLIC_STELLAR_NETWORK;
  }
}

/**
 * Diagnostic command that reports missing/invalid keys without printing values.
 * Run with: node -e "require('./dist/lib/env').diagnose()"
 */
export function diagnose(): void {
  const required = [
    'NEXT_PUBLIC_API_URL',
    'NEXT_PUBLIC_STELLAR_NETWORK',
    'NEXT_PUBLIC_HORIZON_URL',
    'NEXT_PUBLIC_SOROBAN_RPC_URL',
    'NEXT_PUBLIC_PASSKEY_RP_ID',
    'NEXT_PUBLIC_PASSKEY_RP_NAME',
    'NEXT_PUBLIC_PASSKEY_ORIGIN',
    'NEXT_PUBLIC_CONTRACT_ID',
    'NEXT_PUBLIC_CONTRACT_ABI_VERSION',
    'NEXT_PUBLIC_CONTRACT_WASM_HASH',
  ];

  console.log('\n📋 Environment Configuration Diagnostic\n');
  
  for (const key of required) {
    const value = process.env[key];
    if (!value) {
      console.log(`❌ ${key}: MISSING`);
    } else {
      console.log(`✅ ${key}: SET (${value.substring(0, 20)}...)`);
    }
  }
  
  console.log('');
}
