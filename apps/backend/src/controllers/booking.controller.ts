import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { BookingService } from '@/services/booking.service.js';
import { getPropertyById } from '@/services/property.service.js';
import { generateIcs, generateIcsFeed } from '@/utils/ics.js';
import type { IcsEventInput } from '@/utils/ics.js';
import { supabase } from '@/config/supabase.js';
import { env } from '@/config/env.js';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import type { BookingModification } from '@/services/booking.service.js';
import type { BookingActor } from '@/services/bookingAuthorization.service.js';
import { lookup, store, lockKey, completeKey, releaseKey, hashRequestBody } from '@/services/idempotency.service.js';
import { fetchReceiptData, generateReceiptPdf } from '@/services/receipt.service.js';
import {
  getActiveNetwork,
  resolveRequestNetwork,
  networkMismatchMessage,
  type StellarNetwork,
} from '@/config/network.js';

function calendarFeedSecret(): string {
  return env.CALENDAR_FEED_SECRET ?? env.JWT_SECRET;
}

/**
 * Resolve the network a request claims to operate on and compare it against the
 * backend's active network. Returns the active network on success, or writes an
 * actionable 409 and returns undefined on mismatch.
 *
 * The backend independently rejects the wrong network here so a client that
 * skips its own check can never broadcast against the wrong ledger.
 */
function requireMatchingNetwork(req: Request, res: Response): StellarNetwork | undefined {
  const active = getActiveNetwork();
  const requested = resolveRequestNetwork(req);

  if (requested && requested !== active) {
    res.status(409).json({
      error: networkMismatchMessage(requested, active),
      code: 'NETWORK_MISMATCH',
      expected_network: active,
      received_network: requested,
    });
    return undefined;
  }

  return active;
}

/**
 * Ensure the wallet address that owns the operation matches the authenticated
 * caller's active wallet. Prevents a pending operation from silently continuing
 * under a different account after a wallet switch.
 */
function requireOperationOwner(
  req: Request,
  res: Response,
  expectedOwner: string | undefined,
): boolean {
  const claimedOwner =
    (typeof req.body?.wallet_address === 'string' && req.body.wallet_address.trim()) ||
    (typeof req.headers['x-wallet-address'] === 'string' && req.headers['x-wallet-address'].trim()) ||
    undefined;

  if (!claimedOwner) return true;

  if (expectedOwner && claimedOwner !== expectedOwner) {
    res.status(409).json({
      error:
        'The wallet account that started this operation no longer matches the active account. ' +
        'Reconnect the original wallet and retry, or start a new booking.',
      code: 'WALLET_ACCOUNT_MISMATCH',
      expected_owner: expectedOwner,
      received_owner: claimedOwner,
    });
    return false;
  }

  return true;
}

/**
 * The authenticated caller, from the JWT populated by `authenticate`. Returns
 * undefined when there is no caller, so handlers can answer 401.
 */
function bookingActor(req: Request): BookingActor | undefined {
  const user = (req as Request & { user?: { id: string; role?: string } }).user;
  return user?.id ? { id: user.id, role: user.role } : undefined;
}

function generateFeedToken(userId: string): string {
  return createHmac('sha256', calendarFeedSecret()).update(userId).digest('hex');
}

function validateFeedToken(token: string, userId: string): boolean {
  try {
    const expected = generateFeedToken(userId);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(token, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const bookingService = new BookingService();

export async function listUserBookings(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const pagination = (req as AuthRequest & { parsedPagination?: { page: number; pageSize: number } }).parsedPagination;
  const page = pagination?.page ?? Number(req.query.page ?? 1);
  const pageSize = pagination?.pageSize ?? Number(req.query.pageSize ?? req.query.limit ?? 20);

  const status = typeof req.query.status === 'string' ? req.query.status : null;

  const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : 'created';
  const sort = ['date', 'price', 'created'].includes(sortRaw) ? (sortRaw as 'date' | 'price' | 'created') : 'created';

  const orderRaw = typeof req.query.order === 'string' ? req.query.order : 'desc';
  const order = orderRaw === 'asc' ? 'asc' : 'desc';

  const result = await bookingService.getUserBookings(userId, page, pageSize, status, sort, order);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/modifications
 *
 * Request a date change for a booking.
 * Only the booking tenant may request a modification.
 * Body: { requested_start: string, requested_end: string, reason?: string }
 */
export async function requestModification(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { requested_start, requested_end, reason, guest_count } = req.body as {
    requested_start: string;
    requested_end: string;
    reason?: string;
    guest_count?: number;
  };

  const result = await bookingService.requestModification(
    req.params.id,
    authUser.id,
    requested_start,
    requested_end,
    reason,
    guest_count,
  );

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found'  ? 404
      : result.conflict ? 409
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

/**
 * POST /api/v1/bookings/:id/modifications/:modId/accept
 *
 * Accept a pending date-change request.
 * Only the host (property owner) may accept.
 */
export async function acceptModification(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.acceptModification(req.params.id, authUser.id, req.params.modId);

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found' || result.error === 'Modification request not found' ? 404
      : result.conflict ? 409
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/modifications/:modId/decline
 *
 * Decline a pending date-change request.
 * Only the host (property owner) may decline.
 */
export async function declineModification(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.declineModification(req.params.id, authUser.id, req.params.modId);

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found' || result.error === 'Modification request not found' ? 404
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/bookings/:id
 *
 * Returns the booking to its tenant, its host, or a role that may read any booking.
 * Anyone else receives 404.
 */
export async function getBooking(req: Request, res: Response): Promise<void> {
  const actor = bookingActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.getBookingForActor(req.params.id, actor);

  if (!result.success) {
    res.status(result.statusCode ?? 404).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/bookings/:id/status-history
 *
 * Same access rule as getBooking.
 */
export async function getBookingStatusHistory(req: Request, res: Response): Promise<void> {
  const actor = bookingActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.getBookingStatusHistoryForActor(req.params.id, actor);

  if (!result.success) {
    res.status(result.statusCode ?? 404).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function createBooking(req: Request, res: Response): Promise<void> {
  const authReq = req as AuthRequest;
  const userId = authReq.user?.id ?? authReq.userId;
  const idempotencyKey = req.headers['idempotency-key'];

  // ── Network validation ──────────────────────────────────────────────────────
  // Reject a wallet/backend network mismatch before any booking intent is
  // created or any payment is broadcast.
  const network = requireMatchingNetwork(req, res);
  if (!network) return;

  if (!requireOperationOwner(req, res, userId)) return;

  // ── Idempotency check ───────────────────────────────────────────────────────
  if (idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      res.status(400).json({ error: 'Idempotency-Key header must be a non-empty string' });
      return;
    }

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const trimmedKey = idempotencyKey.trim();
    const requestHash = hashRequestBody(req.body);

    // Atomic claim: win the INSERT race or receive the existing record.
    const lockResult = await lockKey(userId, trimmedKey, requestHash);

    if (!lockResult.success) {
      // DB error during lock — fail safe rather than blocking all bookings.
      console.error('[idempotency] lock error:', lockResult.error);
    } else if (lockResult.data) {
      const lockData = lockResult.data;

      if (!lockData.claimed) {
        const record = (lockData as { claimed: false; existing: import('@/services/idempotency.service.js').IdempotencyRecord }).existing;

        if (record.request_hash !== requestHash) {
          // Same key, different payload → reject to prevent silent mutation.
          res.status(422).json({
            error:
              'Idempotency-Key has already been used with a different request payload. ' +
              'Use a new key for a different booking request.',
          });
          return;
        }

        if (record.status === 'processing') {
          // Another request is still in flight with the same key.
          res.status(409).json({
            error:
              'A request with this Idempotency-Key is already being processed. ' +
              'Retry after a short delay.',
          });
          return;
        }

        // Completed record with matching hash → replay.
        res
          .status(record.status_code)
          .set('Idempotent-Replayed', 'true')
          .json(record.response_body);
        return;
      }

      // We claimed the key — proceed and complete or release on failure.
      const claimedId = (lockData as { claimed: true; id: string }).id;

      const result = await bookingService.createBooking({ ...req.body, network });

      if (!result.success) {
        // Release the processing lock so the caller can retry.
        await releaseKey(claimedId);
        const status = result.statusCode ?? (result.conflict ? 409 : 400);
        res.status(status).json({ error: result.error, code: result.code, details: result.details });
        return;
      }

      const responseBody = result.data as unknown as Record<string, unknown>;
      const statusCode = 201;

      const completeResult = await completeKey(claimedId, responseBody, statusCode);
      if (!completeResult.success) {
        console.error('[idempotency] complete error:', completeResult.error);
      }

      res.status(statusCode).json(responseBody);
      return;
    }
  }

  // ── Fallback: no idempotency key provided ───────────────────────────────────
  const result = await bookingService.createBooking({ ...req.body, network });

  if (!result.success) {
    const status = result.statusCode ?? (result.conflict ? 409 : 400);
    res.status(status).json({ error: result.error, code: result.code, details: result.details });
    return;
  }

  res.status(201).json(result.data);
}

/**
 * POST /api/v1/bookings/:id/cancel
 *
 * Cancels a booking as the tenant. The refund amount is computed from the
 * configured refund policy, the escrow is settled accordingly, and both the
 * tenant and host are notified. Only the tenant may cancel.
 */
export async function cancelBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Cancellation settles escrow on-chain; reject a network mismatch before
  // any refund transaction is signed or broadcast.
  const network = requireMatchingNetwork(req, res);
  if (!network) return;

  if (!requireOperationOwner(req, res, authUser.id)) return;

  const result = await bookingService.cancelBooking(req.params.id, authUser.id, new Date(), authUser.role, network);

  if (!result.success) {
    const statusCode =
      result.statusCode ??
      (result.error === 'Booking not found'
        ? 404
        : result.error?.startsWith('Forbidden')
          ? 403
          : result.error === 'Booking is already cancelled' ||
              result.error === 'Cannot cancel a completed booking' ||
              result.error === 'Cannot cancel a disputed booking. Resolve the dispute first.'
            ? 409
            : 400);

    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function confirmBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Signing/submission boundary: the network and operation owner must still
  // match before we accept a signed transaction hash.
  const network = requireMatchingNetwork(req, res);
  if (!network) return;

  if (!requireOperationOwner(req, res, authUser.id)) return;

  const result = await bookingService.confirmBooking(req.params.id, authUser.id, authUser.role, network);

  if (!result.success) {
    const statusCode = result.statusCode ?? (result.error?.startsWith('Forbidden') ? 403 : 400);
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/bookings/:id/transaction
 *
 * Returns the persisted transaction state for a booking, distinguishing a
 * broadcast-but-unconfirmed submission from a ledger-confirmed outcome. When
 * polling has timed out the status is reported as `pending` (never a false
 * final failure) so the client can defer to reconciliation.
 */
export async function getBookingTransaction(req: Request, res: Response): Promise<void> {
  const actor = bookingActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.getBookingTransactionForActor(req.params.id, actor);

  if (!result.success) {
    res.status(result.statusCode ?? 404).json({ error: result.error });
    return;
  }

  const tx = result.data;
  const submitted = Boolean(tx?.tx_hash);
  const confirmed = tx?.status === 'confirmed';

  res.json({
    ...tx,
    submitted,
    confirmed,
    // Explicitly surface that an unresolved transaction is not a failure.
    final: confirmed || tx?.status === 'failed',
  });
}

/**
 * POST /api/v1/bookings/:id/complete
 *
 * Marks a Confirmed booking as Completed.
 * Only the booking tenant may call this endpoint.
 */
export async function completeBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const network = requireMatchingNetwork(req, res);
  if (!network) return;

  if (!requireOperationOwner(req, res, authUser.id)) return;

  const result = await bookingService.completeBooking(req.params.id, authUser.id, authUser.role, network);

  if (!result.success) {
    const statusCode = result.statusCode ??
      (result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found'  ? 404
      : 400);
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/dispute
 *
 * Opens a dispute on a Confirmed booking.
 * Only the booking tenant may call this endpoint.
 * Optional body: { reason: string }
 */
export async function disputeBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
  const result = await bookingService.disputeBooking(req.params.id, authUser.id, reason);

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found'  ? 404
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * PATCH /api/v1/bookings/:id
 *
 * Admin only. Denied attempts are audited by the service.
 */
export async function updateBooking(req: Request, res: Response): Promise<void> {
  const actor = bookingActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.updateBooking(req.params.id, req.body, actor);

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * DELETE /api/v1/bookings/:id
 *
 * Admin only. Denied attempts are audited by the service.
 */
export async function deleteBooking(req: Request, res: Response): Promise<void> {
  const actor = bookingActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.deleteBooking(req.params.id, actor);

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }

  res.status(204).send();
}

/**
 * GET /api/v1/bookings/:id/calendar.ics
 *
 * Returns a downloadable .ics file for the booking.
 * Only the booking's tenant is allowed to fetch it.
 */
export async function getBookingCalendar(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;

  const bookingResult = await bookingService.getBookingById(req.params.id);
  if (!bookingResult.success || !bookingResult.data) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }

  const booking = bookingResult.data;

  if (!booking.check_in || !booking.check_out) {
    res.status(422).json({ error: 'Booking is missing date information' });
    return;
  }

  // Fetch property for location, title, and host ID check
  let propertyTitle = 'Rental Stay';
  let propertyLocation = '';
  let hostOwnerId: string | undefined;
  if (booking.property_id) {
    const propResult = await getPropertyById(booking.property_id);
    if (propResult.success && propResult.data) {
      const p = propResult.data;
      propertyTitle = p.title ?? propertyTitle;
      const parts = [p.address, p.city, p.country].filter(Boolean);
      propertyLocation = parts.join(', ');
      hostOwnerId = p.owner_id;
    }
  }

  // Authorization: tenant or host may download
  const isTenant = authUser?.id === booking.tenant_id;
  const isHost = !!hostOwnerId && authUser?.id === hostOwnerId;
  if (!isTenant && !isHost) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const isCancelled = booking.status === 'Cancelled' || booking.status === 'Expired';
  const description = [
    `Booking ID: ${booking.id}`,
    `Guests: ${booking.guest_count ?? 1}`,
    `Total: ${booking.total_price ?? ''} USDC`,
    `Status: ${booking.status ?? ''}`,
  ]
    .filter(Boolean)
    .join('\\n');

  const ics = generateIcs({
    uid: `booking-${booking.id}@rentars.app`,
    summary: `Stay at ${propertyTitle}`,
    description,
    location: propertyLocation,
    dtStart: booking.check_in,
    dtEnd: booking.check_out,
    created: booking.created_at,
    status: isCancelled ? 'CANCELLED' : 'CONFIRMED',
    sequence: isCancelled ? 1 : 0,
  });

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="booking-${booking.id}.ics"`);
  res.send(ics);
}

/**
 * GET /api/v1/bookings/calendar-feed-token
 *
 * Returns an HMAC-signed token and a ready-to-subscribe calendar feed URL
 * for the authenticated user. The URL is safe to share with calendar apps
 * because the token prevents enumeration of other users' feeds.
 */
export async function getCalendarFeedToken(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = generateFeedToken(authUser.id);
  const baseUrl = (req.headers['x-forwarded-proto'] ?? req.protocol) + '://' + req.headers.host;
  const feedUrl = `${baseUrl}/api/v1/calendar/feed/${authUser.id}/${token}.ics`;

  res.json({ token, feed_url: feedUrl });
}

/**
 * GET /api/v1/calendar/feed/:userId/:token.ics  (public — no auth middleware)
 *
 * Validates the HMAC token, then returns a full iCalendar feed containing all
 * bookings (tenant and host) for the given user. Cancelled and expired bookings
 * are included with STATUS:CANCELLED so calendar clients remove them cleanly.
 */
export async function getCalendarFeed(req: Request, res: Response): Promise<void> {
  const { userId, token } = req.params as { userId: string; token: string };

  // Strip .ics suffix if present (Express won't strip it automatically)
  const cleanToken = token.replace(/\.ics$/, '');

  if (!validateFeedToken(cleanToken, userId)) {
    res.status(403).json({ error: 'Invalid or expired calendar feed token' });
    return;
  }

  // Fetch all bookings where the user is tenant
  const { data: tenantBookings } = await supabase
    .from('bookings')
    .select('*, properties(title, address, city, country)')
    .eq('tenant_id', userId)
    .order('check_in', { ascending: true });

  // Fetch all bookings for properties the user owns
  const { data: hostBookings } = await supabase
    .from('bookings')
    .select('*, properties!inner(title, address, city, country, owner_id)')
    .eq('properties.owner_id', userId)
    .neq('tenant_id', userId)
    .order('check_in', { ascending: true });

  const allBookings = [
    ...(tenantBookings ?? []),
    ...(hostBookings ?? []),
  ];

  const events: IcsEventInput[] = allBookings
    .filter((b) => b.check_in && b.check_out)
    .map((b) => {
      const prop = b.properties as { title?: string; address?: string; city?: string; country?: string } | null;
      const title = prop?.title ?? 'Rental Stay';
      const location = [prop?.address, prop?.city, prop?.country].filter(Boolean).join(', ');
      const isCancelled = b.status === 'Cancelled' || b.status === 'Expired';
      return {
        uid: `booking-${b.id}@rentars.app`,
        summary: `Stay at ${title}`,
        description: [
          `Booking ID: ${b.id}`,
          `Guests: ${b.guest_count ?? 1}`,
          `Total: ${b.total_price ?? ''} USDC`,
          `Status: ${b.status ?? ''}`,
        ].join('\\n'),
        location,
        dtStart: b.check_in as string,
        dtEnd: b.check_out as string,
        created: b.created_at as string | undefined,
        status: isCancelled ? 'CANCELLED' : ('CONFIRMED' as const),
        sequence: isCancelled ? 1 : 0,
      };
    });

  const ics = generateIcsFeed(events);

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rentars-calendar.ics"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(ics);
}

/**
 * GET /api/v1/bookings/:id/receipt.pdf
 *
 * Generates and streams a PDF receipt for the booking.
 * Only the booking's tenant or the property's host may download it.
 */
export async function getBookingReceipt(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;

  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const bookingResult = await bookingService.getBookingById(req.params.id);
  if (!bookingResult.success || !bookingResult.data) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }

  const booking = bookingResult.data;

  // Fetch property to check host ownership
  let hostOwnerId: string | undefined;
  if (booking.property_id) {
    const propResult = await getPropertyById(booking.property_id);
    if (propResult.success && propResult.data) {
      hostOwnerId = propResult.data.owner_id;
    }
  }

  // Authorisation: tenant or host only
  const isTenant = authUser.id === booking.tenant_id;
  const isHost = !!hostOwnerId && authUser.id === hostOwnerId;

  if (!isTenant && !isHost) {
    res.status(403).json({ error: 'Forbidden: only the tenant or host may download this receipt' });
    return;
  }

  // Only allow receipts for completed/confirmed bookings
  const receiptableStatuses = ['Confirmed', 'Completed', 'confirmed', 'completed'];
  if (!booking.status || !receiptableStatuses.includes(booking.status)) {
    res.status(422).json({ error: 'Receipt is only available for confirmed or completed bookings' });
    return;
  }

  const receiptResult = await fetchReceiptData(req.params.id);
  if (!receiptResult.success || !receiptResult.data) {
    res.status(500).json({ error: receiptResult.error ?? 'Failed to fetch receipt data' });
    return;
  }

  let pdfBuffer: Buffer | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      pdfBuffer = generateReceiptPdf(receiptResult.data);
      break;
    } catch {
      if (attempt === 2) {
        res.status(500).json({ error: 'Failed to generate PDF receipt' });
        return;
      }
    }
  }

  // pdfBuffer is always set here — the loop returns early on the second failure
  const buf = pdfBuffer!;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${booking.id}.pdf"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

/**
 * POST /api/v1/bookings/:id/dispute
 *
 * Raise a dispute on a booking. Only the tenant or host may raise a dispute.
 */
export async function raiseDispute(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const network = requireMatchingNetwork(req, res);
  if (!network) return;

  if (!requireOperationOwner(req, res, userId)) return;

  const { reason, details } = req.body as { reason: string; details?: string };

  const result = await bookingService.raiseDispute(req.params.id, userId, reason, details, network);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/dispute/resolve
 *
 * Resolve a dispute on a booking. Only admins/moderators may resolve disputes.
 */
export async function resolveDispute(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;

  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const network = requireMatchingNetwork(req, res);
  if (!network) return;

  const { resolution, admin_notes } = req.body as {
    resolution: 'refund_tenant' | 'release_to_host';
    admin_notes?: string;
  };

  const result = await bookingService.resolveDispute(
    req.params.id,
    authUser.id,
    resolution,
    admin_notes,
    authUser.role,
    network
  );

  if (!result.success) {
    const statusCode = result.statusCode ?? (result.error?.startsWith('Forbidden') ? 403 : 400);
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}
