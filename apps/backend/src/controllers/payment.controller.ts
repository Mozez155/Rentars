/**
 * Payment controller — handles USDC payment submission, status polling, and retry.
 * No blockchain logic lives here; all Stellar calls go through stellar.service.ts.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  createPaymentIntent,
  getPaymentStatus,
  updatePaymentStatus,
} from '@/services/payment.service.js';
import {
  submitTransaction,
  confirmTransaction,
  retryTransaction,
  getActiveNetwork,
  assertNetworkMatch,
  NetworkMismatchError,
} from '@/services/stellar.service.js';

const submitSchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
  signedXdr: z.string().min(1, 'signedXdr is required'),
  amountUsdc: z.number().positive('amountUsdc must be positive'),
  metadata: z.record(z.unknown()).optional(),
  network: z.string().min(1, 'network is required'),
});

const retrySchema = z.object({
  signedXdr: z.string().optional(),
  network: z.string().min(1, 'network is required'),
});

const quoteSchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
  amountUsdc: z.number().positive('amountUsdc must be positive'),
  network: z.string().min(1, 'network is required'),
});

/**
 * Builds an actionable error payload for a wallet/backend network mismatch.
 */
function networkMismatchResponse(res: Response, err: NetworkMismatchError): void {
  res.status(409).json({
    error: {
      code: 'NETWORK_MISMATCH',
      message: err.message,
      expectedNetwork: err.expectedNetwork,
      receivedNetwork: err.receivedNetwork,
      action: `Switch your wallet to ${err.expectedNetwork} and try again.`,
    },
  });
}

/**
 * POST /api/v1/payments/quote
 *
 * Validates that the wallet's selected network matches the backend's active
 * network before a payment intent is created. Returns the active network so
 * the client can display it before user authorization.
 *
 * Body: { bookingId, amountUsdc, network }
 * Returns: { network, amountUsdc }
 */
export async function quotePayment(req: AuthRequest, res: Response): Promise<void> {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  try {
    assertNetworkMatch(parsed.data.network);
  } catch (err) {
    if (err instanceof NetworkMismatchError) {
      networkMismatchResponse(res, err);
      return;
    }
    throw err;
  }

  res.json({
    network: getActiveNetwork(),
    amountUsdc: parsed.data.amountUsdc,
  });
}

/**
 * POST /api/v1/payments/submit
 *
 * Creates a payment intent, submits the signed XDR to Stellar, and begins
 * async confirmation polling (fire-and-forget — client polls for status).
 *
 * Body: { bookingId, signedXdr, amountUsdc, metadata? }
 * Returns: { paymentId, status }
 */
export async function submitPayment(req: AuthRequest, res: Response): Promise<void> {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { bookingId, signedXdr, amountUsdc, metadata, network } = parsed.data;
  const tenantId = req.userId!;

  // 0. Reject wallet/backend network mismatch before any intent or broadcast
  try {
    assertNetworkMatch(network);
  } catch (err) {
    if (err instanceof NetworkMismatchError) {
      networkMismatchResponse(res, err);
      return;
    }
    throw err;
  }

  // 1. Create payment intent in 'pending' state, tagged with the active network
  const payment = await createPaymentIntent({
    bookingId,
    tenantId,
    amountUsdc,
    metadata,
    network: getActiveNetwork(),
  });

  // 2. Submit signed XDR to Stellar
  let txHash: string;
  try {
    const result = await submitTransaction(signedXdr, network);
    txHash = result.txHash;
    await updatePaymentStatus(payment.id, txHash, 'submitted');
  } catch (err) {
    if (err instanceof NetworkMismatchError) {
      await updatePaymentStatus(payment.id, null, 'failed');
      networkMismatchResponse(res, err);
      return;
    }
    await updatePaymentStatus(payment.id, null, 'failed');
    res.status(502).json({
      error: {
        code: 'TX_SUBMIT_FAILED',
        message: err instanceof Error ? err.message : 'Transaction submission failed',
      },
    });
    return;
  }

  // 3. Kick off async confirmation polling (does not block the response).
  //    A polling timeout leaves the payment 'submitted' for reconciliation;
  //    it is never reported as a final failure here.
  confirmTransaction(payment.id, txHash).catch((err) => {
    console.error('[Payment] Confirmation polling failed for', payment.id, err);
  });

  res.status(202).json({
    paymentId: payment.id,
    status: 'submitted',
    txHash,
    network: getActiveNetwork(),
  });
}

/**
 * GET /api/v1/payments/:id/status
 *
 * Returns the current payment status and tx hash.
 * Frontend polls this every 3 seconds while status is 'submitted'.
 */
export async function getStatus(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const payment = await getPaymentStatus(id);

  if (!payment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    return;
  }

  // Only the owning tenant or an admin may query
  if (payment.tenant_id !== req.userId && req.user?.role !== 'admin') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  // Distinguish submitted (broadcast, not yet ledger-confirmed) from confirmed.
  const chainStatus =
    payment.status === 'confirmed'
      ? 'confirmed'
      : payment.status === 'submitted'
        ? 'submitted'
        : payment.status === 'failed'
          ? 'failed'
          : 'pending';

  res.json({
    paymentId: payment.id,
    bookingId: payment.booking_id,
    status: payment.status,
    chainStatus,
    confirmed: payment.status === 'confirmed',
    txHash: payment.stellar_tx_hash,
    network: payment.network ?? getActiveNetwork(),
    amountUsdc: payment.amount_usdc,
    updatedAt: payment.updated_at,
  });
}

/**
 * POST /api/v1/payments/:id/retry
 *
 * Retries a failed or timed-out payment safely.
 * If the payment already has a txHash, it re-polls instead of re-submitting.
 *
 * Body: { signedXdr? } — only required if no txHash exists on the payment.
 */
export async function retryPayment(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const parsed = retrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const payment = await getPaymentStatus(id);
  if (!payment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    return;
  }

  if (payment.tenant_id !== req.userId) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  // Reject a wallet/backend network mismatch before any re-submission
  try {
    assertNetworkMatch(parsed.data.network);
  } catch (err) {
    if (err instanceof NetworkMismatchError) {
      networkMismatchResponse(res, err);
      return;
    }
    throw err;
  }

  try {
    const result = await retryTransaction(id, parsed.data.signedXdr, parsed.data.network);
    res.json({
      paymentId: id,
      txHash: result.txHash,
      status: result.status,
      network: getActiveNetwork(),
    });
  } catch (err) {
    if (err instanceof NetworkMismatchError) {
      networkMismatchResponse(res, err);
      return;
    }
    res.status(422).json({
      error: {
        code: 'RETRY_FAILED',
        message: err instanceof Error ? err.message : 'Retry failed',
      },
    });
  }
}
