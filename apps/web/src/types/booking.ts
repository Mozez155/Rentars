// ─── Booking status ───────────────────────────────────────────────────────────

/**
 * All valid booking status values.
 *
 * DB stores title-case (Pending, Confirmed, …) but the frontend normalises
 * everything to lowercase for comparisons so both forms are included.
 */
export type BookingStatus =
  | 'Pending'   | 'pending'
  | 'Confirmed' | 'confirmed'
  | 'Completed' | 'completed'
  | 'Cancelled' | 'cancelled'
  | 'Disputed'  | 'disputed';

/** Normalise a raw status string from the API to lowercase. */
export function normaliseStatus(status: string): Lowercase<BookingStatus> {
  return status.toLowerCase() as Lowercase<BookingStatus>;
}

// ─── Allowed lifecycle transitions ───────────────────────────────────────────

/**
 * Valid transitions the current user (tenant) may trigger from each state.
 * Mirrors the server-side state machine.
 */
export const TENANT_TRANSITIONS: Record<string, ('confirm' | 'complete' | 'cancel' | 'dispute')[]> = {
  pending:   ['cancel'],
  confirmed: ['complete', 'dispute', 'cancel'],
  completed: [],
  cancelled: [],
  disputed:  [],
};

// ─── Core types ───────────────────────────────────────────────────────────────

export interface Booking {
  id: string;
  property_id: string;
  tenant_id: string;
  check_in: string;
  check_out: string;
  guest_count: number;
  total_price: number;
  status: BookingStatus;
  escrow_id?: string;
  escrow_status?: 'locked' | 'released' | 'refunded';
  on_chain_id?: number;
  rules_acknowledged_at?: string | null;
  dispute_reason?: string | null;
  created_at: string;
  updated_at?: string;
}

// ─── On-chain transaction tracking ───────────────────────────────────────────

/** Stellar networks a transaction may be broadcast to. */
export type StellarNetwork = 'testnet' | 'mainnet' | 'futurenet' | 'standalone';

/**
 * Lifecycle of a broadcast transaction as observed by the client.
 *
 * - `submitted`: broadcast succeeded but ledger inclusion is not yet proven.
 * - `pending`:   seen by the network / RPC but not yet confirmed.
 * - `confirmed`: included in a ledger and successful.
 * - `failed`:    included in a ledger but failed, or definitively rejected.
 * - `unresolved`: polling deadline elapsed without a final outcome; must be
 *                 handed to reconciliation rather than treated as failed.
 */
export type TransactionStatus =
  | 'submitted'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'unresolved';

/** Persisted record of a broadcast Stellar transaction. */
export interface TransactionRecord {
  /** Transaction hash (hex). */
  hash: string;
  /** Network the transaction was broadcast to. */
  network: StellarNetwork;
  /** Current client-observed status. */
  status: TransactionStatus;
  /** Ledger sequence once confirmed, if known. */
  ledger?: number;
  /** ISO timestamp of the last status update. */
  updated_at: string;
  /** Human-readable failure reason when status is `failed`. */
  error?: string;
}

// ─── Pending operation context ───────────────────────────────────────────────

/**
 * Context for an in-flight booking operation (e.g. escrow lock).
 *
 * The `owner_address` binds the operation to the wallet account that started
 * it. If the active wallet address changes, the operation must be invalidated
 * and the user must confirm before resuming.
 */
export interface PendingOperation {
  /** Unique id for this operation attempt. */
  id: string;
  /** Booking the operation applies to. */
  booking_id: string;
  /** Stellar public key of the account that initiated the operation. */
  owner_address: string;
  /** Network the operation targets. */
  network: StellarNetwork;
  /** Transaction hash once broadcast, if any. */
  tx_hash?: string;
  /** Client-observed transaction status, if broadcast. */
  tx_status?: TransactionStatus;
  /** ISO timestamp the operation was started. */
  started_at: string;
  /** Whether the operation was invalidated by an account switch. */
  invalidated?: boolean;
  /** Reason the operation was invalidated, if applicable. */
  invalidation_reason?: 'account_switch' | 'disconnect' | 'timeout';
}

export interface BookingFormData {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  propertyId: string;
}

export interface BookingWithProperty extends Booking {
  property?: {
    id: string;
    title: string;
    city?: string;
    country?: string;
    address?: string;
    images?: string[];
    slug?: string;
    owner_id?: string;
  };
}
