/**
 * Payment callback controller (#610).
 *
 * Receives POST webhooks from TrustlessWork / Stellar escrow providers.
 * Raw request bytes are read before Express JSON-parsing so the HMAC is
 * computed over the exact wire bytes.
 *
 * Route:  POST /api/v1/payments/callback
 * Header: X-TrustlessWork-Signature: <hmac-sha256-hex>
 */

import type { Request, Response } from 'express';
import {
  processProviderCallback,
  buildCallbackResponse,
} from '@/services/paymentCallback.service.js';
import { getNetworkConfig } from '@/config/network.config.js';

/**
 * POST /api/v1/payments/callback
 *
 * Expects the raw body to be stored on `req.rawBody` by the body-parser
 * middleware configured in the router (see payment.routes.ts).
 *
 * Never exposes internal error messages in the response.
 */
export async function handlePaymentCallback(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const signature = req.headers['x-trustlesswork-signature'] as string | undefined;

  const webhookSecret = process.env.TRUSTLESS_WORK_WEBHOOK_SECRET ?? '';
  const expectedProviderId = process.env.TRUSTLESS_WORK_PROVIDER_ID ?? '';

  if (!webhookSecret) {
    // Misconfiguration — fail open-safe: reject all callbacks
    res.status(500).json({ status: 'error', message: 'Webhook secret not configured' });
    return;
  }

  // Resolve the configured network once; production must never silently fall
  // back to testnet (see network.config.ts).
  let expectedNetwork: string;
  try {
    expectedNetwork = getNetworkConfig().network;
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err instanceof Error ? err.message : 'Network configuration invalid',
    });
    return;
  }

  // Reject callbacks that explicitly declare a different network before any
  // state is touched. The backend independently enforces the network so a
  // compromised or misconfigured provider cannot drive the wrong chain.
  const declaredNetwork =
    (req.body && typeof req.body === 'object'
      ? (req.body.network ?? req.body.stellarNetwork ?? req.body.chain)
      : undefined) ?? (req.headers['x-stellar-network'] as string | undefined);

  if (typeof declaredNetwork === 'string' && declaredNetwork.trim() !== '') {
    if (declaredNetwork.trim().toLowerCase() !== expectedNetwork.toLowerCase()) {
      res.status(409).json({
        status: 'error',
        code: 'NETWORK_MISMATCH',
        message: `Callback network "${declaredNetwork}" does not match configured network "${expectedNetwork}".`,
      });
      return;
    }
  }

  const result = await processProviderCallback(
    rawBody,
    signature,
    req.body,
    webhookSecret,
    expectedProviderId,
    expectedNetwork,
  );

  const responseBody = buildCallbackResponse(result.data!);
  res.status(result.statusCode ?? (result.success ? 200 : 400)).json(responseBody);
}
