/**
 * Booking Authorization Service
 *
 * Centralizes role-based authorization checks for booking operations.
 * Enforces the principle of least privilege:
 *
 *   - Tenant can: cancel own booking, complete own booking, dispute, request modifications
 *   - Host can: confirm bookings on their properties, accept/decline modifications
 *   - Moderator/Admin can: resolve disputes, read all bookings, manage properties
 *   - Support can: read-only access to bookings and disputes
 */

import { supabase } from '@/config/supabase.js';
import type { AdminRole } from '@/config/adminScopes.js';
import { getStellarNetworkConfig, type StellarNetwork } from '@/config/stellar.js';

/**
 * Booking operations covered by the operation-to-role matrix below.
 *
 *   read                  view a booking
 *   read_status_history   view a booking's status transitions
 *   update                change status or escrow fields on a booking
 *   delete                remove a booking record
 */
export type BookingOperation = 'read' | 'read_status_history' | 'update' | 'delete';

/**
 * The authenticated caller. Built from the signed JWT by the auth middleware,
 * never from request body or parameters.
 */
export interface BookingActor {
  id: string;
  role?: string;
}

export type BookingAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 404; reason: string };

/**
 * Context describing the wallet operation that accompanies a booking action.
 *
 * Signing, submission, and reconciliation must all refer to the same Stellar
 * network, and the signing address must belong to the operation owner. When
 * this context is supplied, the service rejects stale or mismatched
 * signatures before the operation is authorized.
 */
export interface BookingOperationContext {
  /** Stellar network the client signed on (e.g. 'testnet' or 'mainnet'). */
  network?: string;
  /** Public key that produced the signature. */
  signerAddress?: string;
  /** Public key expected to own the operation (tenant or host). */
  ownerAddress?: string;
  /** Ledger sequence the signature was produced against, if known. */
  signedLedger?: number;
  /** Current ledger sequence, used to reject stale signatures. */
  currentLedger?: number;
  /** Maximum age (in ledgers) a signature may have before it is stale. */
  maxSignatureAgeLedgers?: number;
}

const DEFAULT_MAX_SIGNATURE_AGE_LEDGERS = 120;

function normalizeNetwork(value: string): string {
  return value.trim().toLowerCase();
}

interface OperationPolicy {
  /** Roles that may perform the operation on any booking, regardless of ownership. */
  elevatedRoles: readonly AdminRole[];
  /** Whether the booking's tenant or host may perform the operation on their own booking. */
  participants: boolean;
}

/**
 * Operation-to-role matrix.
 *
 * Tenants and hosts may read only bookings they are a party to. Support,
 * finance, moderators, and admins may read any booking. Changing or deleting a
 * booking is an admin-only action and never depends on ownership.
 *
 * Denied reads of bookings the caller is not party to return 404, so booking
 * IDs cannot be probed. Denied admin-only actions return 403 and are audited.
 */
export const BOOKING_OPERATION_POLICY: Record<BookingOperation, OperationPolicy> = {
  read: { elevatedRoles: ['admin', 'moderator', 'support', 'finance'], participants: true },
  read_status_history: {
    elevatedRoles: ['admin', 'moderator', 'support', 'finance'],
    participants: true,
  },
  update: { elevatedRoles: ['admin'], participants: false },
  delete: { elevatedRoles: ['admin'], participants: false },
};

export class BookingAuthorizationService {
  /**
   * Decide whether an actor may perform an operation on a booking, using the
   * matrix above. Role checks run first and need no database access.
   */
  async authorize(
    operation: BookingOperation,
    bookingId: string,
    actor: BookingActor,
    context?: BookingOperationContext,
  ): Promise<BookingAuthorizationDecision> {
    if (!actor.id) {
      return { allowed: false, status: 403, reason: 'Forbidden: unauthenticated actor' };
    }

    if (context) {
      const rejection = this.validateOperationContext(context);
      if (rejection) {
        return rejection;
      }
    }

    const policy = BOOKING_OPERATION_POLICY[operation];
    if (actor.role && (policy.elevatedRoles as readonly string[]).includes(actor.role)) {
      return { allowed: true };
    }

    if (!policy.participants) {
      return {
        allowed: false,
        status: 403,
        reason: `Forbidden: requires one of [${policy.elevatedRoles.join(', ')}]`,
      };
    }

    const [isTenant, isHost] = await Promise.all([
      this.isTenant(bookingId, actor.id),
      this.isHost(bookingId, actor.id),
    ]);
    if (isTenant || isHost) {
      return { allowed: true };
    }

    return { allowed: false, status: 404, reason: 'Booking not found' };
  }

  /**
   * Validate the wallet operation context against the configured network and
   * the operation owner. Returns a rejection decision, or null when the
   * context is consistent and may proceed.
   */
  validateOperationContext(context: BookingOperationContext): BookingAuthorizationDecision | null {
    let configuredNetwork: StellarNetwork;
    try {
      configuredNetwork = getStellarNetworkConfig().network;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown network configuration error';
      return {
        allowed: false,
        status: 403,
        reason: `Network configuration is invalid: ${message}. Contact support before retrying.`,
      };
    }

    if (!context.network) {
      return {
        allowed: false,
        status: 403,
        reason:
          'Missing network in signing context. Reconnect your wallet and retry so the request is signed on the configured network.',
      };
    }

    if (normalizeNetwork(context.network) !== normalizeNetwork(configuredNetwork)) {
      return {
        allowed: false,
        status: 403,
        reason: `Network mismatch: wallet signed on "${context.network}" but this service operates on "${configuredNetwork}". Switch your wallet to ${configuredNetwork} and retry.`,
      };
    }

    if (!context.signerAddress) {
      return {
        allowed: false,
        status: 403,
        reason:
          'Missing signing address. Reconnect your wallet and retry so the operation is signed by the expected account.',
      };
    }

    if (!context.ownerAddress) {
      return {
        allowed: false,
        status: 403,
        reason:
          'Missing operation owner address. Refresh the booking and retry so the signing account can be verified.',
      };
    }

    if (context.signerAddress !== context.ownerAddress) {
      return {
        allowed: false,
        status: 403,
        reason: `Signing address ${context.signerAddress} does not match the operation owner ${context.ownerAddress}. Switch back to the owning account in your wallet and retry.`,
      };
    }

    if (context.signedLedger !== undefined && context.currentLedger !== undefined) {
      const maxAge = context.maxSignatureAgeLedgers ?? DEFAULT_MAX_SIGNATURE_AGE_LEDGERS;
      const age = context.currentLedger - context.signedLedger;
      if (age < 0 || age > maxAge) {
        return {
          allowed: false,
          status: 403,
          reason: `Signature is stale (signed at ledger ${context.signedLedger}, current ledger ${context.currentLedger}). Re-sign the operation and retry.`,
        };
      }
    }

    return null;
  }

  /**
   * Check if user is the tenant of a booking.
   */
  async isTenant(bookingId: string, userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('bookings')
      .select('tenant_id')
      .eq('id', bookingId)
      .single();

    if (error || !data) return false;
    return data.tenant_id === userId;
  }

  /**
   * Check if user is the host (property owner) of a booking.
   */
  async isHost(bookingId: string, userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('bookings')
      .select('properties!inner(owner_id)')
      .eq('id', bookingId)
      .single();

    if (error || !data) return false;
    const booking = data as unknown as { properties: { owner_id: string } };
    return booking.properties.owner_id === userId;
  }

  /**
   * Check if user can cancel a booking.
   * Only the tenant can cancel (unless it's an admin with cancel scope).
   */
  async canCancel(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always cancel
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isTenant = await this.isTenant(bookingId, userId);
    if (!isTenant) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant may cancel a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can confirm a booking.
   * Only the host (property owner) can confirm, or an admin.
   */
  async canConfirm(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always confirm
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isHost = await this.isHost(bookingId, userId);
    if (!isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the host may confirm a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can complete a booking.
   * Only the tenant can mark as complete (after host has confirmed).
   */
  async canComplete(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always complete
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isTenant = await this.isTenant(bookingId, userId);
    if (!isTenant) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant may complete a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can dispute a booking.
   * Only the tenant or host can dispute.
   */
  async canDispute(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always dispute
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const [isTenant, isHost] = await Promise.all([
      this.isTenant(bookingId, userId),
      this.isHost(bookingId, userId),
    ]);

    if (!isTenant && !isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant or host may dispute a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can request a modification (date change).
   * Only the tenant can request modifications.
   */
  async canRequestModification(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always request modifications
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isTenant = await this.isTenant(bookingId, userId);
    if (!isTenant) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant may request a modification',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can accept or decline a modification.
   * Only the host can accept/decline modifications on their bookings.
   */
  async canManageModification(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always manage modifications
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isHost = await this.isHost(bookingId, userId);
    if (!isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the host may accept or decline modifications',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can read a booking.
   * Tenant/Host can read their own. Support/Admins can read all.
   */
  async canRead(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins, moderators, support, and finance can read all bookings
    if (userRole === 'admin' || userRole === 'moderator' || userRole === 'support' || userRole === 'finance') {
      return { allowed: true };
    }

    // Regular users can read their own bookings
    const [isTenant, isHost] = await Promise.all([
      this.isTenant(bookingId, userId),
      this.isHost(bookingId, userId),
    ]);

    if (!isTenant && !isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: You do not have access to this booking',
      };
    }

    return { allowed: true };
  }
}

export const bookingAuthorizationService = new BookingAuthorizationService();
