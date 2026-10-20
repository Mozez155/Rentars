/**
 * Shared TypeScript types derived from the Soroban contract ABIs.
 *
 * These types mirror the on-chain structs and enums defined in:
 *   - apps/contracts/booking_abi.json
 *   - apps/contracts/property_listing_abi.json
 *   - apps/contracts/review_abi.json
 *
 * Keep in sync with the ABI files whenever contracts are updated.
 */

import type { xdr } from '@stellar/stellar-sdk';

// ─── Network Types ────────────────────────────────────────────────────────────

/**
 * Supported Stellar networks. Every signing, submission, contract, and RPC
 * operation must agree on exactly one of these values.
 */
export type StellarNetwork = 'testnet' | 'mainnet' | 'futurenet';

/** All networks the application knows how to talk to. */
export const SUPPORTED_NETWORKS: readonly StellarNetwork[] = [
  'testnet',
  'mainnet',
  'futurenet',
] as const;

/** Networks considered production-grade. */
export const PRODUCTION_NETWORKS: readonly StellarNetwork[] = ['mainnet'] as const;

/** Returns true when the given value is a supported Stellar network. */
export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return typeof value === 'string' && (SUPPORTED_NETWORKS as readonly string[]).includes(value);
}

/**
 * Raised whenever wallet, backend, contract, or RPC configuration disagree on
 * the active network. Carries both sides so callers can surface an actionable
 * message before any signing or broadcast occurs.
 */
export class NetworkMismatchError extends Error {
  readonly code = 'NETWORK_MISMATCH' as const;
  readonly expected: StellarNetwork;
  readonly actual: StellarNetwork | string | null;

  constructor(expected: StellarNetwork, actual: StellarNetwork | string | null, context?: string) {
    const detail = context ? ` (${context})` : '';
    super(
      `Network mismatch${detail}: expected "${expected}" but received "${actual ?? 'unknown'}". ` +
        `Switch your wallet to ${expected} and retry.`,
    );
    this.name = 'NetworkMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

// ─── Transaction Status Types ─────────────────────────────────────────────────

/**
 * Lifecycle of a broadcast Stellar transaction.
 *
 * - `not_found`: RPC has not observed the hash yet (may still be in flight).
 * - `pending`:   Observed in the mempool / not yet included in a ledger.
 * - `failed`:    Included in a ledger but the operation failed.
 * - `confirmed`: Included in a ledger and succeeded.
 * - `unresolved`: Polling deadline elapsed without a final outcome; the
 *                 transaction is handed to reconciliation.
 */
export type TransactionStatus =
  | 'not_found'
  | 'pending'
  | 'failed'
  | 'confirmed'
  | 'unresolved';

/** Terminal statuses that will not change without reconciliation. */
export const TERMINAL_TRANSACTION_STATUSES: readonly TransactionStatus[] = [
  'failed',
  'confirmed',
] as const;

/** Returns true when the status is final and idempotent updates may stop. */
export function isTerminalTransactionStatus(status: TransactionStatus): boolean {
  return (TERMINAL_TRANSACTION_STATUSES as readonly string[]).includes(status);
}

/** Persisted record tracking a broadcast transaction through confirmation. */
export interface TransactionRecord {
  /** Hex-encoded transaction hash. */
  tx_hash: string;
  /** Network the transaction was broadcast on. */
  network: StellarNetwork;
  /** Current lifecycle status. */
  status: TransactionStatus;
  /** Ledger sequence the transaction was included in, when known. */
  ledger?: number;
  /** Unix timestamp (seconds) when the transaction was first submitted. */
  submitted_at: number;
  /** Unix timestamp (seconds) of the most recent status update. */
  updated_at: number;
  /** Number of polling attempts made so far. */
  attempts: number;
  /** Optional failure reason when status is `failed`. */
  error?: string;
}

// ─── Contract Metadata Types ──────────────────────────────────────────────────

/**
 * Version registry entry describing a deployed contract on a given network.
 * Used by startup validation and non-sensitive version health endpoints.
 */
export interface ContractMetadata {
  /** Contract ID (Strkey `C...`) deployed on the network. */
  contractId: string;
  /** Network the contract is deployed on. */
  network: StellarNetwork;
  /** Hex-encoded WASM hash of the deployed bytecode. */
  wasmHash: string;
  /** ABI version string, e.g. "1.2.0". */
  abiVersion: string;
  /** Other contracts this contract depends on for initialization. */
  initializationDependencies: string[];
  /** Application release versions known to be compatible with this contract. */
  compatibleAppReleases: string[];
}

/** Health summary for a single contract, safe to expose publicly. */
export interface ContractHealth {
  contractId: string;
  network: StellarNetwork;
  wasmHash: string;
  abiVersion: string;
  /** Whether the configured contract matches the registry entry. */
  compatible: boolean;
  /** Human-readable reason when `compatible` is false. */
  issue?: string;
}

// ─── Blockchain Operation Types ───────────────────────────────────────────────

/**
 * Common envelope for a blockchain operation. Every intent is tagged with the
 * network it targets and, once broadcast, the resulting transaction hash.
 */
export interface BlockchainOperation {
  /** Network this operation must be signed and submitted on. */
  network: StellarNetwork;
  /** Transaction hash, populated after broadcast. */
  tx_hash?: string;
  /** Current confirmation status, populated after broadcast. */
  status?: TransactionStatus;
}

// ─── Property Listing Types ───────────────────────────────────────────────────

/** Mirrors ListingStatus enum in property_listing_abi.json */
export type ListingStatus = 'Active' | 'Inactive' | 'Rented';

/** Mirrors PropertyListing struct in property_listing_abi.json */
export interface PropertyListing {
  id: bigint;
  owner: string; // Stellar address
  title: string;
  description: string;
  /** Nightly price in USDC stroops (1 USDC = 10_000_000 stroops) */
  price_per_night: bigint;
  status: ListingStatus;
}

// ─── Booking Types ────────────────────────────────────────────────────────────

/** Mirrors BookingStatus enum in booking_abi.json */
export type BookingStatus =
  | 'Pending'
  | 'Confirmed'
  | 'Cancelled'
  | 'Completed'
  | 'Disputed';

/** Mirrors EscrowStatus enum in booking_abi.json */
export type EscrowStatus =
  | 'NotFunded'
  | 'Funded'
  | 'Released'
  | 'Refunded';

/** Mirrors Booking struct in booking_abi.json */
export interface Booking {
  id: bigint;
  property_id: bigint;
  tenant: string; // Stellar address
  property_owner: string; // Stellar address
  /** Unix timestamp (seconds) */
  check_in: bigint;
  /** Unix timestamp (seconds) */
  check_out: bigint;
  /** Total price in USDC stroops */
  total_price: bigint;
  status: BookingStatus;
  /** Off-chain escrow reference. Empty string until set by admin. */
  escrow_id: string;
  /** On-chain escrow status */
  escrow_status: EscrowStatus;
}

// ─── Review Types ─────────────────────────────────────────────────────────────

/** Mirrors Review struct in review_abi.json */
export interface Review {
  id: bigint;
  reviewee: string; // Stellar address
  reviewer: string; // Stellar address
  /** Rating value between 1 and 5 inclusive */
  rating: number;
  comment: string;
  /** Ledger timestamp at submission time (Unix seconds) */
  timestamp: bigint;
}

// ─── Input Parameter Types ────────────────────────────────────────────────────

/** Parameters for PropertyListingClient.createListing() */
export interface CreateListingParams {
  owner: string;
  title: string;
  description: string;
  price_per_night: bigint;
}

/** Parameters for PropertyListingClient.updateListing() */
export interface UpdateListingParams {
  caller: string;
  id: bigint;
  title: string;
  description: string;
  price_per_night: bigint;
}

/** Parameters for BookingClient.createBooking() */
export interface CreateBookingParams {
  tenant: string;
  property_id: bigint;
  check_in: bigint;
  check_out: bigint;
  total_price: bigint;
}

/** Parameters for ReviewClient.submitReview() */
export interface SubmitReviewParams {
  reviewer: string;
  reviewee: string;
  rating: number;
  comment: string;
}

// ─── Escrow Types ─────────────────────────────────────────────────────────────

/** Parameters for funding an escrow */
export interface FundEscrowParams {
  tenant: string;
  booking_id: bigint;
}

/** Parameters for disputing a booking */
export interface DisputeBookingParams {
  tenant: string;
  booking_id: bigint;
}

/** Parameters for resolving a dispute */
export interface ResolveDisputeParams {
  caller: string;
  booking_id: bigint;
  release_to_owner: boolean;
}

// ─── Simulation & Fee Estimation Types ────────────────────────────────────────

/**
 * A single diagnostic entry surfaced by Soroban RPC simulation.
 * Mirrors the shape of `DiagnosticEvent` / error entries returned by
 * `simulateTransaction`, normalized for safe consumption by the client.
 */
export interface SimulationDiagnostic {
  /** Machine-readable diagnostic code, e.g. "auth", "contract", "budget". */
  code: string;
  /** Human-readable message safe to display to end users. */
  message: string;
  /** Optional contract error code when the failure originated on-chain. */
  contract_error_code?: number;
  /** Whether the caller can recover by adjusting inputs and retrying. */
  recoverable: boolean;
}

/** Estimated resource usage returned by simulation. */
export interface SimulationResources {
  /** CPU instructions consumed by the simulated invocation. */
  cpu_instructions: bigint;
  /** Memory bytes consumed by the simulated invocation. */
  memory_bytes: bigint;
  /** Number of ledger entries read during simulation. */
  read_bytes: bigint;
  /** Number of ledger entries written during simulation. */
  write_bytes: bigint;
}

/** Estimated fee breakdown for a simulated transaction. */
export interface FeeEstimate {
  /** Inclusion fee in stroops (1 XLM = 10_000_000 stroops). */
  inclusion_fee: bigint;
  /** Resource fee in stroops covering CPU, memory, and ledger I/O. */
  resource_fee: bigint;
  /** Total estimated fee in stroops (inclusion + resource). */
  total_fee: bigint;
  /** Asset used to pay the fee, e.g. "XLM" or "USDC". */
  fee_asset: string;
}

/** Result of simulating a Soroban transaction prior to signing. */
export interface SimulationResult {
  /** Whether the simulated transaction would succeed on-chain. */
  success: boolean;
  /** Estimated fee for the transaction. Present even on failure when available. */
  fee_estimate?: FeeEstimate;
  /** Estimated resource consumption. Present when simulation completed. */
  resources?: SimulationResources;
  /** Diagnostics describing failures or warnings. Empty when success is true. */
  diagnostics: SimulationDiagnostic[];
  /** Latest ledger sequence observed during simulation. */
  latest_ledger: number;
  /** Unix timestamp (seconds) when this simulation was produced. */
  simulated_at: number;
  /** Opaque cache key derived from the transaction intent. */
  intent_key: string;
}

/**
 * Cache entry for a short-lived simulation result keyed by transaction intent.
 * Invalidated when inputs change or the observed ledger advances.
 */
export interface SimulationCacheEntry {
  /** Cache key derived from the transaction intent. */
  intent_key: string;
  /** Cached simulation result. */
  result: SimulationResult;
  /** Ledger sequence at which the cached result was produced. */
  ledger: number;
  /** Unix timestamp (seconds) when the entry expires. */
  expires_at: number;
}

/** Inputs required to simulate a supported Soroban transaction. */
export interface SimulateTransactionParams {
  /** Base64-encoded unsigned transaction envelope XDR. */
  transaction_xdr: string;
  /** Optional pre-built auth entries to include in the simulation. */
  auth?: xdr.SorobanAuthorizationEntry[];
  /** Optional override for the ledger used during simulation. */
  ledger_override?: number;
}
