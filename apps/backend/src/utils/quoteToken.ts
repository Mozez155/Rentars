/**
 * Signed price-quote tokens (#754).
 *
 * A quote token binds an authoritative total to the exact inputs it was computed
 * for (listing, dates, listing version) and expires. Booking creation verifies the
 * token before reserving dates, so the amount a tenant confirms cannot drift from
 * the amount the server charges.
 *
 * Tokens are only issued when QUOTE_SIGNING_SECRET is configured. Without it,
 * booking still re-prices server-side; the token is an additional binding.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export interface QuoteTokenClaims {
  /** Stellar network the quote was computed for (e.g. "testnet", "mainnet"). */
  net: string;
  /** Property ID the quote was computed for. */
  pid: string;
  /** Normalised check-in instant (ISO 8601). */
  ci: string;
  /** Normalised check-out instant (ISO 8601). */
  co: string;
  /** Total the tenant is charged, in dollars, rounded to cents. */
  tot: number;
  /** Listing version: the property's updated_at when the quote was computed. */
  ver: string;
  /** Expiry instant (ISO 8601). */
  exp: string;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Produce a `<payload>.<signature>` token, or null when no signing secret is set.
 */
export function signQuoteToken(
  claims: QuoteTokenClaims,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): string | null {
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token's signature and decode its claims.
 *
 * When `expectedNetwork` is provided, tokens issued for a different network are
 * rejected. Callers that consume a quote for signing/submission should always
 * pass the network the backend is configured for, so a quote minted on one
 * network can never be replayed against another.
 *
 * @returns The claims when the signature is valid (and the network matches, if
 *          required), otherwise null. Expiry and input matching are the
 *          caller's responsibility.
 */
export function verifyQuoteToken(
  token: string,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
  expectedNetwork?: string,
): QuoteTokenClaims | null {
  if (!secret || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;

  const expected = Buffer.from(sign(body, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let claims: QuoteTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuoteTokenClaims;
  } catch {
    return null;
  }

  if (typeof claims?.net !== 'string' || !claims.net) return null;
  if (expectedNetwork !== undefined && claims.net !== expectedNetwork) return null;

  return claims;
}
