/**
 * Higher-level service that stores a canonical data-hash for each property
 * on-chain. The Supabase DB holds the authoritative property data; the hash
 * on-chain allows tamper-evidence verification via verifyPropertyIntegrity().
 *
 * Assumed contract interface (Soroban):
 *   create_property_listing(id: String, data_hash: String, owner: Address)
 *   update_property_listing(id: String, data_hash: String, owner: Address)
 *   get_property_listing(id: String) -> { owner: Address, data_hash: String, status: Symbol }
 *   update_property_status(id: String, owner: Address, status: Symbol)
 */

import { createHash } from 'crypto';
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  NETWORK_PASSPHRASE,
  PROPERTY_LISTING_CONTRACT_ID,
  STELLAR_SOURCE_ACCOUNT,
} from './config.js';
import { getSorobanServer, simulateReadOnly, submitAndWait } from './soroban.js';
import { buildPrepareAndSign } from './transactionUtils.js';
import { ContractError } from './errors.js';
import {
  assertContractCompatible,
  getContractEntry,
  type ContractRegistryEntry,
} from './contractRegistry.js';
import type { ListingStatus } from './types.js';

const PROPERTY_LISTING_CONTRACT_NAME = 'property_listing';
const PROPERTY_LISTING_ABI_VERSION = '1.0.0';

/**
 * Resolve the registry entry for the property listing contract and fail fast
 * when the configured contract ID, network, or ABI version is unknown or
 * incompatible with this client.
 *
 * @param operation - Contract method name used for error reporting
 * @returns Validated registry entry for the property listing contract
 * @throws ContractError if the contract is not registered or is incompatible
 */
function resolvePropertyListingContract(operation: string): ContractRegistryEntry {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    throw new ContractError(
      'PROPERTY_LISTING_CONTRACT_ID is not configured',
      operation,
    );
  }

  const entry = getContractEntry(PROPERTY_LISTING_CONTRACT_NAME);
  if (!entry) {
    throw new ContractError(
      `Contract "${PROPERTY_LISTING_CONTRACT_NAME}" is not present in the contract registry`,
      operation,
    );
  }

  if (entry.contractId !== PROPERTY_LISTING_CONTRACT_ID) {
    throw new ContractError(
      `Contract registry ID for "${PROPERTY_LISTING_CONTRACT_NAME}" does not match the configured contract ID`,
      operation,
    );
  }

  if (entry.network !== NETWORK_PASSPHRASE) {
    throw new ContractError(
      `Contract registry network for "${PROPERTY_LISTING_CONTRACT_NAME}" does not match the configured network`,
      operation,
    );
  }

  assertContractCompatible(PROPERTY_LISTING_CONTRACT_NAME, PROPERTY_LISTING_ABI_VERSION, operation);

  return entry;
}

export interface OnChainPropertyData {
  owner: string;
  data_hash: string;
  status: ListingStatus;
}

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * Serialise the canonical subset of property fields to a deterministic JSON
 * string for hashing. Keys are always sorted alphabetically.
 *
 * @param property - Property record (any extra keys are ignored)
 * @returns Deterministic JSON string of the canonical fields
 */
export function propertyToHashData(property: Record<string, unknown>): string {
  const CANONICAL_FIELDS = [
    'address',
    'bathrooms',
    'bedrooms',
    'city',
    'country',
    'description',
    'id',
    'max_guests',
    'price_per_night',
    'title',
  ] as const;

  const canonical: Record<string, unknown> = {};
  for (const field of CANONICAL_FIELDS) {
    if (field in property) {
      canonical[field] = property[field];
    }
  }

  return JSON.stringify(canonical);
}

function computeSha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the on-chain hash record for a property.
 *
 * @param id - Supabase property UUID used as the on-chain identifier
 * @returns On-chain property data including owner address, data hash, and listing status
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or the call fails
 */
export async function getPropertyListing(id: string): Promise<OnChainPropertyData> {
  const entry = resolvePropertyListingContract('get_property_listing');

  const server = getSorobanServer();
  const contract = new Contract(entry.contractId);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call('get_property_listing', nativeToScVal(id, { type: 'string' })),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_property_listing');
  const native = scValToNative(retval) as {
    owner: string;
    data_hash: string;
    status: string;
  };

  return {
    owner: native.owner,
    data_hash: native.data_hash,
    status: native.status as ListingStatus,
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Register a property's data-hash on-chain.
 *
 * @param id - Supabase property UUID
 * @param dataHash - SHA-256 hex hash of the canonical property data
 * @param ownerAddress - Stellar public key of the property owner
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or submission fails
 */
export async function createPropertyListing(
  id: string,
  dataHash: string,
  ownerAddress: string,
): Promise<void> {
  const entry = resolvePropertyListingContract('create_property_listing');

  const server = getSorobanServer();
  const contract = new Contract(entry.contractId);

  const op = contract.call(
    'create_property_listing',
    nativeToScVal(id, { type: 'string' }),
    nativeToScVal(dataHash, { type: 'string' }),
    nativeToScVal(ownerAddress, { type: 'address' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Update the stored data-hash for a property.
 *
 * @param id - Supabase property UUID
 * @param dataHash - New SHA-256 hex hash of updated canonical property data
 * @param ownerAddress - Stellar public key of the property owner
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or submission fails
 */
export async function updatePropertyListing(
  id: string,
  dataHash: string,
  ownerAddress: string,
): Promise<void> {
  const entry = resolvePropertyListingContract('update_property_listing');

  const server = getSorobanServer();
  const contract = new Contract(entry.contractId);

  const op = contract.call(
    'update_property_listing',
    nativeToScVal(id, { type: 'string' }),
    nativeToScVal(dataHash, { type: 'string' }),
    nativeToScVal(ownerAddress, { type: 'address' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Update the status of a property listing on-chain.
 *
 * @param id - Supabase property UUID
 * @param ownerAddress - Stellar public key of the property owner
 * @param status - New listing status ('Active', 'Inactive', etc.)
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or submission fails
 */
export async function updatePropertyStatus(
  id: string,
  ownerAddress: string,
  status: ListingStatus,
): Promise<void> {
  const entry = resolvePropertyListingContract('update_property_status');

  const server = getSorobanServer();
  const contract = new Contract(entry.contractId);

  const op = contract.call(
    'update_property_status',
    nativeToScVal(id, { type: 'string' }),
    nativeToScVal(ownerAddress, { type: 'address' }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(status)]),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

// ─── Integrity ────────────────────────────────────────────────────────────────

/**
 * Verify that local property data matches the hash stored on-chain.
 *
 * Returns true when the hashes match, false when they diverge (indicating
 * the off-chain record may have been mutated outside the normal update flow).
 *
 * @param id - Supabase property UUID
 * @param localData - Current local property record from Supabase
 * @returns true if hashes match, false if tamper detected
 * @throws ContractError if the on-chain lookup fails
 * @example
 * const isValid = await verifyPropertyIntegrity(property.id, property);
 * if (!isValid) console.warn('Property data has been tampered with!');
 */
export async function verifyPropertyIntegrity(
  id: string,
  localData: Record<string, unknown>,
): Promise<boolean> {
  const onChain = await getPropertyListing(id);
  const localHash = computeSha256(propertyToHashData(localData));
  return localHash === onChain.data_hash;
}
