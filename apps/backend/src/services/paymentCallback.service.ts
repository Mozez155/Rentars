/**
 * Payment callback verification service (#610).
 *
 * Defends against:
 *  - Forged signatures  — HMAC-SHA256 over raw request bytes
 *  - Replay attacks     — persisted event-ID ledger with TTL
 *  - Clock skew         — reject events older than MAX_CLOCK_SKEW_MS
 *  - Out-of-order       — tolerated; idempotency in state machine handles it
 *  - Cross-booking      — validate payload booking/amount against DB record
 *  - Unknown payloads   — quarantine via transitionPaymentStatus()
 *
 * Provider responses follow HTTP semantics:
 *  - 200 with { status: 'acknowledged' } on valid new event
 *  - 200 with { status: 'replayed' } on recognised duplicate
 *  - 400 on malformed payload
 *  - 401 on invalid / missing signature
 *  - 422 on semantic mismatch (wrong booking / amount)
 *
 * Internal error details are never surfaced to the provider to avoid
 * information leakage.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { supabase } from '@/config/supabase.js';
import {
  transitionPaymentStatus,
  mapProviderStatus,
  hashEventPayload,
  getPaymentByBookingId,
} from './payment.service.js';
import { getStellarNetworkConfig, type StellarNetwork } from '@/config/stellarNetwork.js';
import type { ServiceResponse } from './index.js';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Maximum age of an incoming callback before it is rejected as stale. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000; // 5 minutes

/** How long event IDs are retained in the replay ledger. */
const REPLAY_TTL_HOURS = 24;

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Expected shape of a TrustlessWork / generic escrow callback body.
 * Unknown extra fields are stripped by Zod's .strict() equivalent via
 * passthrough — they are still hashed for the replay ledger.
 */
export const callbackBodySchema = z.object({
  /** Unique event ID issued by the provider. */
  eventId: z.string().min(1),
  /** ISO-8601 timestamp when the provider emitted this event. */
  timestamp: z.string().datetime(),
  /** Provider-specific status string — mapped via mapProviderStatus(). */
  status: z.string().min(1),
  /** UUID of the booking this event relates to. */
  bookingId: z.string().uuid(),
  /** Amount in USDC stroops (integer as string to survive JSON serialization). */
  amountStroops: z.string().regex(/^\d+$/, 'amountStroops must be a non-negative integer string'),
  /** Provider's account or API-key identifier — must match env config. */
  providerAccountId: z.string().min(1),
  /**
   * Stellar network the event was emitted on. Optional for backwards
   * compatibility, but when present it MUST match the configured network.
   */
  network: z.enum(['testnet', 'mainnet', 'futurenet']).optional(),
  /** Optional Stellar transaction hash associated with the event. */
  txHash: z.string().optional(),
}).passthrough();

export type CallbackBody = z.infer<typeof callbackBodySchema>;

// ─── Verification result ──────────────────────────────────────────────────────

export type CallbackVerificationStatus =
  | 'acknowledged'
  | 'replayed'
  | 'invalid_signature'
  | 'invalid_timestamp'
  | 'invalid_payload'
  | 'invalid_network'
  | 'mismatch'
  | 'quarantined';

export interface CallbackVerificationResult {
  status: CallbackVerificationStatus;
  /** HTTP status code to return to the provider. */
  httpStatus: number;
  /** Safe message to surface to the provider (no internals). */
  message: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 over `rawBody` using `secret`.
 * Returns lowercase hex.
 */
function computeHmac(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Timing-safe comparison of two hex digest strings.
 * Prevents leaking secret length via early-exit timing.
 */
function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a.padEnd(64, '0').slice(0, 64), 'hex');
    const bufB = Buffer.from(b.padEnd(64, '0').slice(0, 64), 'hex');
    return timingSafeEqual(bufA, bufB) && a.length === b.length;
  } catch {
    return false;
  }
}

/**
 * Check whether `eventId` has already been processed (replay ledger).
 * Returns true when the event is a known replay.
 */
async function isReplay(eventId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - REPLAY_TTL_HOURS * 60 * 60 * 1_000).toISOString();
  const { data } = await supabase
    .from('payment_callback_events')
    .select('id')
    .eq('event_id', eventId)
    .gte('created_at', cutoff)
    .maybeSingle();
  return data !== null;
}

/**
 * Persist an event ID to the replay ledger.
 *
 * Idempotent: the unique constraint on `event_id` means a concurrent or
 * duplicate insert is ignored rather than creating a second ledger row.
 */
async function recordEvent(
  eventId: string,
  bookingId: string,
  eventHash: string,
): Promise<void> {
  const { error } = await supabase
    .from('payment_callback_events')
    .insert({
      event_id: eventId,
      booking_id: bookingId,
      event_hash: eventHash,
      created_at: new Date().toISOString(),
    })
    .select();

  // 23505 = unique_violation — a concurrent delivery already recorded it.
  if (error && error.code !== '23505') {
    console.error(`[Callback] Failed to record event ${eventId}:`, error.message);
  }
}

/**
 * Resolve the network the callback claims to be for, and compare it with the
 * configured network. Returns null when the network is acceptable (or absent),
 * otherwise returns the configured network for the rejection message.
 */
function resolveNetworkMismatch(claimed: StellarNetwork | undefined): StellarNetwork | null {
  const config = getStellarNetworkConfig();
  if (!claimed) return null;
  return claimed === config.network ? null : config.network;
}

// ─── Main verifier ────────────────────────────────────────────────────────────

/**
 * Verify and process an incoming payment provider callback.
 *
 * @param rawBody          - Raw request body bytes (Buffer) for HMAC verification.
 * @param signatureHeader  - Value of the provider's signature header
 *                           (e.g. `X-TrustlessWork-Signature`).
 * @param parsedBody       - Already-parsed JSON from the request (Express req.body).
 * @param webhookSecret    - Shared HMAC secret configured in env (per-provider).
 * @param expectedProviderId - The provider account ID we expect in the payload.
 *
 * @returns CallbackVerificationResult — describes what to return to the provider.
 */
export async function verifyAndProcessCallback(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  parsedBody: unknown,
  webhookSecret: string,
  expectedProviderId: string,
): Promise<CallbackVerificationResult> {

  // ── 1. Signature presence ────────────────────────────────────────────────
  if (!signatureHeader) {
    return {
      status: 'invalid_signature',
      httpStatus: 401,
      message: 'Missing signature header',
    };
  }

  // ── 2. HMAC signature verification (constant time) ───────────────────────
  const expected = computeHmac(rawBody, webhookSecret);
  if (!safeCompare(signatureHeader, expected)) {
    return {
      status: 'invalid_signature',
      httpStatus: 401,
      message: 'Signature verification failed',
    };
  }

  // ── 3. Payload schema validation ─────────────────────────────────────────
  const parseResult = callbackBodySchema.safeParse(parsedBody);
  if (!parseResult.success) {
    return {
      status: 'invalid_payload',
      httpStatus: 400,
      message: 'Malformed callback payload',
    };
  }

  const body = parseResult.data;

  // ── 4. Clock skew check ───────────────────────────────────────────────────
  const eventAge = Date.now() - new Date(body.timestamp).getTime();
  if (Math.abs(eventAge) > MAX_CLOCK_SKEW_MS) {
    return {
      status: 'invalid_timestamp',
      httpStatus: 400,
      message: 'Event timestamp outside acceptable window',
    };
  }

  // ── 5. Network validation ─────────────────────────────────────────────────
  // The backend independently rejects events tagged with a network other than
  // the one it is configured for. This prevents testnet events from mutating
  // mainnet payment state (and vice versa).
  const configuredNetwork = resolveNetworkMismatch(body.network);
  if (configuredNetwork !== null) {
    console.error(
      `[Callback] Network mismatch for bookingId=${body.bookingId}: ` +
      `got=${body.network} expected=${configuredNetwork}`,
    );
    return {
      status: 'invalid_network',
      httpStatus: 422,
      message: `Network mismatch — this endpoint only accepts ${configuredNetwork} events`,
    };
  }

  // ── 6. Provider account identity check ───────────────────────────────────
  if (body.providerAccountId !== expectedProviderId) {
    // Potential cross-tenant injection; quarantine
    console.error(
      `[Callback] Provider account mismatch: got=${body.providerAccountId} expected=${expectedProviderId}`,
    );
    return {
      status: 'mismatch',
      httpStatus: 422,
      message: 'Provider account identity mismatch',
    };
  }

  // ── 7. Replay detection ───────────────────────────────────────────────────
  const eventHash = hashEventPayload(body as unknown as Record<string, unknown>);

  if (await isReplay(body.eventId)) {
    return {
      status: 'replayed',
      httpStatus: 200,
      message: 'Event already processed',
    };
  }

  // ── 8. Load payment and cross-reference booking + amount ─────────────────
  const payment = await getPaymentByBookingId(body.bookingId);

  if (!payment) {
    // Booking not found — could be a test event or mis-routed webhook
    console.warn(`[Callback] No payment found for bookingId=${body.bookingId}`);
    return {
      status: 'mismatch',
      httpStatus: 422,
      message: 'Booking not found',
    };
  }

  const incomingStroops = BigInt(body.amountStroops);
  if (incomingStroops !== payment.amount_stroops) {
    // Amount mismatch — quarantine; do NOT mark paid
    console.error(
      `[Callback] Amount mismatch for bookingId=${body.bookingId}: ` +
      `got=${incomingStroops} expected=${payment.amount_stroops}`,
    );
    // Transition to under_review so the discrepancy is auditable
    await transitionPaymentStatus(
      payment.id,
      'under_review',
      { ...body, _reason: 'amount_mismatch' } as unknown as Record<string, unknown>,
    );
    // Record in replay ledger to avoid re-processing
    await recordEvent(body.eventId, body.bookingId, eventHash);
    return {
      status: 'mismatch',
      httpStatus: 422,
      message: 'Amount mismatch — payment under review',
    };
  }

  // ── 9. Map provider status and apply transition ───────────────────────────
  // transitionPaymentStatus() is idempotent: a duplicate confirmation for an
  // already-confirmed payment returns { replayed: true } without re-applying
  // the state change, so payments are never double-recorded.
  const canonicalStatus = mapProviderStatus(body.status);

  const transitionResult = await transitionPaymentStatus(
    payment.id,
    canonicalStatus,
    body as unknown as Record<string, unknown>,
    body.txHash ?? null,
  );

  // Record in replay ledger regardless of transition outcome
  await recordEvent(body.eventId, body.bookingId, eventHash);

  if (!transitionResult.success) {
    console.error(`[Callback] Transition failed for payment=${payment.id}:`, transitionResult.error);
    // Still return 200 to the provider (we received it fine; our internal
    // state diverged, which is a separate alert path).
    return {
      status: 'quarantined',
      httpStatus: 200,
      message: 'Event received; payment under review',
    };
  }

  const { replayed } = transitionResult.data!;

  return {
    status: replayed ? 'replayed' : 'acknowledged',
    httpStatus: 200,
    message: replayed ? 'Event already processed' : 'Event acknowledged',
  };
}

// ─── HTTP handler helper ──────────────────────────────────────────────────────

/**
 * Convenience: build the provider-safe response body from a verification result.
 * Internal details are stripped.
 */
export function buildCallbackResponse(result: CallbackVerificationResult): {
  status: string;
  message: string;
} {
  return {
    status: result.status === 'acknowledged' || result.status === 'replayed'
      ? result.status
      : 'error',
    message: result.message,
  };
}

// ─── ServiceResponse wrapper ──────────────────────────────────────────────────

/**
 * Wraps verifyAndProcessCallback() to return a ServiceResponse for use in
 * controllers. Sets statusCode so the controller can call res.status().
 */
export async function processProviderCallback(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  parsedBody: unknown,
  webhookSecret: string,
  expectedProviderId: string,
): Promise<ServiceResponse<CallbackVerificationResult>> {
  const result = await verifyAndProcessCallback(
    rawBody,
    signatureHeader,
    parsedBody,
    webhookSecret,
    expectedProviderId,
  );

  return {
    success: result.httpStatus < 400,
    data: result,
    statusCode: result.httpStatus,
    error: result.httpStatus >= 400 ? result.message : undefined,
  };
}
