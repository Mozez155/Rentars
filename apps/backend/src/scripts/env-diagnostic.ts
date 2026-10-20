#!/usr/bin/env bun
/**
 * Environment diagnostic script — reports missing configuration without exposing values.
 * 
 * Usage:
 *   bun run scripts/env-diagnostic.ts
 */

import 'dotenv/config';
import {
  resolveNetworkConfig,
  getContractRegistry,
  type NetworkConfig,
  type ContractRegistryEntry,
} from '../config/network';

const REQUIRED_VARS = [
  'PORT',
  'NODE_ENV',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
  'CORS_ORIGIN',
];

const OPTIONAL_VARS = [
  'REDIS_URL',
  'STELLAR_NETWORK',
  'STELLAR_RPC_URL',
  'PROPERTY_LISTING_CONTRACT_ID',
  'BOOKING_CONTRACT_ID',
  'TRUSTLESS_WORK_API_URL',
  'TRUSTLESS_WORK_API_KEY',
  'GEOCODING_API_KEY',
  'HCAPTCHA_SECRET_KEY',
  'HCAPTCHA_ENABLED',
  'METRICS_TOKEN',
];

function maskValue(key: string, value: string): string {
  return key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD')
    ? '[REDACTED]'
    : value.substring(0, 30) + (value.length > 30 ? '...' : '');
}

function reportNetworkConfig(): boolean {
  console.log('\nStellar Network Configuration:');

  let network: NetworkConfig;
  try {
    network = resolveNetworkConfig();
  } catch (error) {
    console.log(`  ❌ ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  let ok = true;
  console.log(`  ✅ Resolved network: ${network.network}`);
  console.log(`  ✅ RPC URL: ${network.rpcUrl}`);
  console.log(`  ✅ Network passphrase: ${network.networkPassphrase}`);

  // Production must never silently fall back to testnet.
  if (process.env.NODE_ENV === 'production' && network.network !== 'mainnet') {
    console.log(
      `  ❌ NODE_ENV=production but resolved network is "${network.network}". ` +
        'Production must explicitly configure STELLAR_NETWORK=mainnet.',
    );
    ok = false;
  }

  let registry: ContractRegistryEntry[];
  try {
    registry = getContractRegistry(network.network);
  } catch (error) {
    console.log(`  ❌ ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  console.log('\nContract Registry:');
  if (registry.length === 0) {
    console.log(`  ❌ No contracts registered for network "${network.network}".`);
    return false;
  }

  for (const entry of registry) {
    console.log(`  • ${entry.name}`);
    console.log(`      contract ID: ${entry.contractId}`);
    console.log(`      WASM hash:   ${entry.wasmHash}`);
    console.log(`      ABI version: ${entry.abiVersion}`);
    console.log(`      initialized: ${entry.initialized ? 'yes' : 'no'}`);
    if (entry.dependsOn.length > 0) {
      console.log(`      depends on:  ${entry.dependsOn.join(', ')}`);
    }
    if (entry.compatibleAppReleases.length > 0) {
      console.log(`      app releases: ${entry.compatibleAppReleases.join(', ')}`);
    }
    if (!entry.initialized) {
      console.log(`      ❌ ${entry.name} is not marked initialized.`);
      ok = false;
    }
  }

  return ok;
}

console.log('\n📋 Backend Environment Configuration Diagnostic\n');
console.log('━'.repeat(60));
console.log('\nRequired Configuration:');

let hasErrors = false;

for (const key of REQUIRED_VARS) {
  const value = process.env[key];
  if (!value) {
    console.log(`  ❌ ${key}: MISSING`);
    hasErrors = true;
  } else {
    console.log(`  ✅ ${key}: ${maskValue(key, value)}`);
  }
}

console.log('\nOptional Configuration:');

for (const key of OPTIONAL_VARS) {
  const value = process.env[key];
  if (!value) {
    console.log(`  ⚪ ${key}: NOT SET`);
  } else {
    console.log(`  ✅ ${key}: ${maskValue(key, value)}`);
  }
}

console.log('\n━'.repeat(60));

if (!reportNetworkConfig()) {
  hasErrors = true;
}

console.log('\n━'.repeat(60));

if (hasErrors) {
  console.log('\n❌ Configuration incomplete or inconsistent. Fix the issues above.\n');
  process.exit(1);
} else {
  console.log('\n✅ All required configuration present and network configuration is consistent.\n');
  process.exit(0);
}
