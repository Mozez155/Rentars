/**
 * Environment configuration — single source of truth for all env vars.
 *
 * Validates every variable at module-load time using Zod.
 * On failure, all problems are logged at once and the process exits with code 1.
 * On success, exports a typed, frozen `env` object that replaces all
 * direct `process.env` reads throughout the codebase.
 */

import { z } from 'zod';

// ── Schema ────────────────────────────────────────────────────────────────────

const envSchema = z.object({
  // ── Server ─────────────────────────────────────────────────────────────────
  PORT: z
    .string()
    .default('3000')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('PORT must be 1–65535');
      return n;
    }),

  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // ── Supabase (required) ────────────────────────────────────────────────────
  SUPABASE_URL: z
    .string()
    .url('SUPABASE_URL must be a valid URL'),

  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  // ── Auth (required) ────────────────────────────────────────────────────────
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters for security'),

  // ── CORS ───────────────────────────────────────────────────────────────────
  // Comma-separated list of allowed origins for credentialed requests.
  // Wildcards ('*') are rejected at startup — credentialed CORS requires
  // explicit origins.  Example: "https://app.rentars.com,https://www.rentars.com"
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:3001')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean))
    .refine(
      (origins) =>
        origins.length > 0 && origins.every((o) => o !== '*'),
      'CORS_ORIGIN must not be a wildcard — list explicit origins for credentialed requests',
    ),

  // ── Redis (optional) ───────────────────────────────────────────────────────
  REDIS_URL: z.string().url().optional(),

  // ── Stellar / Soroban ─────────────────────────────────────────────────────
  // Network selection is explicit. In production the default is removed by the
  // superRefine below so a missing value can never silently resolve to testnet.
  STELLAR_NETWORK: z
    .enum(['testnet', 'mainnet'])
    .default('testnet'),

  STELLAR_RPC_URL: z.string().url().optional(),

  // Network passphrase used to sign/verify transactions. When unset it is
  // derived from STELLAR_NETWORK by the centralized network config.
  STELLAR_NETWORK_PASSPHRASE: z.string().optional(),

  PROPERTY_LISTING_CONTRACT_ID: z.string().optional(),
  BOOKING_CONTRACT_ID: z.string().optional(),

  // ── Contract version registry ─────────────────────────────────────────────
  // ABI version deployed alongside the contract IDs above.
  CONTRACT_ABI_VERSION: z.string().optional(),
  // WASM hash of the deployed contract (hex, 64 chars) for version health.
  CONTRACT_WASM_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CONTRACT_WASM_HASH must be a 64-character hex string')
    .optional(),
  // Application release the deployed contracts are compatible with.
  CONTRACT_COMPATIBLE_APP_VERSION: z.string().optional(),

  // ── Trustless Work (escrow) ────────────────────────────────────────────────
  TRUSTLESS_WORK_API_URL: z.string().url().optional(),
  TRUSTLESS_WORK_API_KEY: z.string().optional(),

  // ── Geocoding ─────────────────────────────────────────────────────────────
  GEOCODING_API_KEY: z.string().optional(),
  // hCaptcha bot protection (set HCAPTCHA_ENABLED=false to bypass in dev)
  HCAPTCHA_SECRET_KEY: z.string().optional(),
  HCAPTCHA_ENABLED: z.string().optional(),

  // ── Email webhook ─────────────────────────────────────────────────────────
  // HMAC-SHA256 secret used to verify inbound delivery-status webhooks from
  // the SMTP/ESP provider.  When unset all webhook requests are rejected.
  EMAIL_WEBHOOK_SECRET: z.string().optional(),

  // ── Booking rate limits ────────────────────────────────────────────────────
  // Per-user rate limit window for booking creation, in milliseconds.
  // Default: 60 000 ms (1 minute).
  BOOKING_RATE_LIMIT_WINDOW_MS: z
    .string()
    .default('60000')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('BOOKING_RATE_LIMIT_WINDOW_MS must be a positive integer');
      return n;
    }),

  // Maximum number of booking creation requests per user per window.
  // Default: 5 requests per window.
  BOOKING_RATE_LIMIT_MAX: z
    .string()
    .default('5')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('BOOKING_RATE_LIMIT_MAX must be a positive integer');
      return n;
    }),

  // ── Booking expiry ────────────────────────────────────────────────────────
  // Hours before a Pending booking automatically expires (default: 24 h).
  PENDING_BOOKING_EXPIRY_HOURS: z
    .string()
    .default('24')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error('PENDING_BOOKING_EXPIRY_HOURS must be positive');
      return n;
    }),

  // ── Calendar feed ─────────────────────────────────────────────────────────
  // HMAC secret used to sign calendar feed subscription URLs.
  // Falls back to JWT_SECRET in code when unset.
  CALENDAR_FEED_SECRET: z.string().optional(),

  // ── Body size limits ───────────────────────────────────────────────────────
  // Maximum size for JSON request bodies (Express body-parser format: "1mb", "512kb", etc.)
  // Upload routes (multipart/form-data) are governed by multer limits, not this value.
  JSON_BODY_LIMIT: z.string().default('1mb'),

  // ── Property image upload limits ──────────────────────────────────────────
  MAX_IMAGES_PER_PROPERTY: z
    .string()
    .default('15')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('MAX_IMAGES_PER_PROPERTY must be a positive integer');
      return n;
    }),

  MAX_IMAGE_SIZE_BYTES: z
    .string()
    .default('5242880') // 5 MB
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('MAX_IMAGE_SIZE_BYTES must be a positive integer');
      return n;
    }),

  // ── Observability ─────────────────────────────────────────────────────────
  // Minimum log level: debug | info | warn | error  (default: info)
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),

  // Bearer token required to scrape /metrics.
  // When unset the endpoint is restricted to localhost only.
  METRICS_TOKEN: z.string().optional(),

  // Distributed tracing sample rate (0.0 to 1.0). Default: 0.1 (10%)
  TRACE_SAMPLE_RATE: z
    .string()
    .default('0.1')
    .transform((v) => {
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > 1) throw new Error('TRACE_SAMPLE_RATE must be between 0 and 1');
      return n;
    }),

  // Deployment version for trace tagging
  DEPLOYMENT_VERSION: z.string().optional(),

  // Probe configuration
  PROBES_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  PROBE_LOCATION: z.string().optional(),
  FRONTEND_URL: z.string().url().optional(),
  API_URL: z.string().url().optional(),
  PROBE_TEST_EMAIL: z.string().email().optional(),
  PROBE_TEST_PASSWORD: z.string().optional(),
  PROBE_BOOKING_EMAIL: z.string().email().optional(),
  PROBE_BOOKING_PASSWORD: z.string().optional(),

  // ── Security headers ──────────────────────────────────────────────────────
  // Set to "true" to force-enable HSTS even outside NODE_ENV=production.
  // Useful when running behind a TLS-terminating proxy in staging.
  HSTS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ── Data retention ────────────────────────────────────────────────────────
  // How often the full retention sweep runs, in hours. Default: 24 (once/day).
  RETENTION_INTERVAL_HOURS: z
    .string()
    .default('24')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error('RETENTION_INTERVAL_HOURS must be a positive number');
      return n;
    }),

  // Maximum rows deleted per table per retention run. Default: 500.
  // Lower this on high-traffic databases to reduce lock contention.
  RETENTION_BATCH_SIZE: z
    .string()
    .default('500')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_BATCH_SIZE must be a positive integer');
      return n;
    }),

  // Set to "true" to run a live (non-dry-run) retention sweep 60 s after
  // startup.  Useful for one-off cleanups after a policy change is deployed.
  // The dry-run preview always fires at startup regardless of this flag.
  RETENTION_RUN_ON_STARTUP: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // ── Retention windows ─────────────────────────────────────────────────────
  // Each window controls how long a data class is kept before deletion.
  // All values are in DAYS unless the variable name says HOURS.

  // Expired wallet challenge tokens (hours — they have a 10-min DB TTL).
  RETENTION_WALLET_CHALLENGES_HOURS: z
    .string()
    .default('1')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error('RETENTION_WALLET_CHALLENGES_HOURS must be positive');
      return n;
    }),

  // Password reset tokens past their expiry timestamp.
  RETENTION_PASSWORD_RESET_TOKENS_DAYS: z
    .string()
    .default('7')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_PASSWORD_RESET_TOKENS_DAYS must be a positive integer');
      return n;
    }),

  // Blockchain operation logs.
  RETENTION_BLOCKCHAIN_LOGS_DAYS: z
    .string()
    .default('90')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_BLOCKCHAIN_LOGS_DAYS must be a positive integer');
      return n;
    }),

  // Blockchain→DB sync log rows.
  RETENTION_SYNC_LOG_DAYS: z
    .string()
    .default('30')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_SYNC_LOG_DAYS must be a positive integer');
      return n;
    }),

  // Read notifications (shorter window — already actioned).
  RETENTION_NOTIFICATIONS_READ_DAYS: z
    .string()
    .default('90')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_NOTIFICATIONS_READ_DAYS must be a positive integer');
      return n;
    }),

  // Unread notifications (longer window — user may not have seen them yet).
  RETENTION_NOTIFICATIONS_UNREAD_DAYS: z
    .string()
    .default('180')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_NOTIFICATIONS_UNREAD_DAYS must be a positive integer');
      return n;
    }),

  // Search analytics query records.
  RETENTION_SEARCH_ANALYTICS_DAYS: z
    .string()
    .default('365')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_SEARCH_ANALYTICS_DAYS must be a positive integer');
      return n;
    }),

  // Deduplicated property view tracking rows.
  RETENTION_PROPERTY_VIEWS_DAYS: z
    .string()
    .default('90')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_PROPERTY_VIEWS_DAYS must be a positive integer');
      return n;
    }),

  // Failed / timed-out payment intent records (no active dispute).
  RETENTION_PAYMENTS_FAILED_DAYS: z
    .string()
    .default('90')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_PAYMENTS_FAILED_DAYS must be a positive integer');
      return n;
    }),

  // Soft-deleted properties (deleted_at IS NOT NULL, no active dispute).
  RETENTION_SOFT_DELETED_PROPERTIES_DAYS: z
    .string()
    .default('180')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_SOFT_DELETED_PROPERTIES_DAYS must be a positive integer');
      return n;
    }),

  // Completed or cancelled account deletion request records.
  RETENTION_ACCOUNT_DELETIONS_CLOSED_DAYS: z
    .string()
    .default('30')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('RETENTION_ACCOUNT_DELETIONS_CLOSED_DAYS must be a positive integer');
      return n;
    }),
}).superRefine((value, ctx) => {
  // Production must name its browser origins explicitly. The development default
  // (localhost) must never become the production allowlist by omission.
  if (value.NODE_ENV !== 'production') return;

  if (!process.env.CORS_ORIGIN?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CORS_ORIGIN'],
      message: 'CORS_ORIGIN must be set explicitly in production',
    });
  } else {
    for (const origin of value.CORS_ORIGIN) {
      if (!origin.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: `Production CORS origin must use https:// (got '${origin}')`,
        });
      }
    }
  }

  // ── Stellar network must be explicit and non-testnet in production ────────
  // A missing STELLAR_NETWORK would otherwise fall back to the schema default
  // ('testnet'), silently routing production traffic to the wrong network.
  if (!process.env.STELLAR_NETWORK?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STELLAR_NETWORK'],
      message: 'STELLAR_NETWORK must be set explicitly in production (testnet or mainnet)',
    });
  } else if (value.STELLAR_NETWORK === 'testnet') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STELLAR_NETWORK'],
      message: 'STELLAR_NETWORK must not be testnet in production',
    });
  }

  // RPC endpoint must be explicit — no implicit public/testnet fallback.
  if (!value.STELLAR_RPC_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STELLAR_RPC_URL'],
      message: 'STELLAR_RPC_URL must be set explicitly in production',
    });
  }

  // Contract IDs must be explicit so we never run against unknown contracts.
  if (!value.PROPERTY_LISTING_CONTRACT_ID?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PROPERTY_LISTING_CONTRACT_ID'],
      message: 'PROPERTY_LISTING_CONTRACT_ID must be set explicitly in production',
    });
  }
  if (!value.BOOKING_CONTRACT_ID?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BOOKING_CONTRACT_ID'],
      message: 'BOOKING_CONTRACT_ID must be set explicitly in production',
    });
  }

  // Contract version metadata is required to detect incompatible deployments.
  if (!value.CONTRACT_ABI_VERSION?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CONTRACT_ABI_VERSION'],
      message: 'CONTRACT_ABI_VERSION must be set explicitly in production',
    });
  }
  if (!value.CONTRACT_WASM_HASH?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CONTRACT_WASM_HASH'],
      message: 'CONTRACT_WASM_HASH must be set explicitly in production',
    });
  }
});

// ── Type export ───────────────────────────────────────────────────────────────

export type Environment = z.infer<typeof envSchema>;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Parse and validate all environment variables.
 * Logs every problem aggregated together, then exits with code 1 so the
 * container/process doesn't start in a broken state.
 */
function validateEnv(): Environment {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const lines: string[] = ['', '❌  Environment validation failed — fix the issues below before starting the server:', ''];

    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      lines.push(`  • ${path}: ${issue.message}`);
    }

    lines.push('');
    console.error(lines.join('\n'));
    process.exit(1);
  }

  // Freeze so accidental mutation is caught at runtime
  return Object.freeze(result.data) as Environment;
}

export const env: Readonly<Environment> = validateEnv();

// ── Centralized network config ────────────────────────────────────────────────
// Re-export the single source of truth for Stellar network configuration and
// validate it at startup so a wallet/backend network mismatch fails fast.
export {
  NETWORK_CONFIG,
  resolveNetworkConfig,
  validateNetworkConfig,
  type NetworkConfig,
} from '../blockchain/config.js';

import { validateNetworkConfig } from '../blockchain/config.js';

// Throws (and therefore aborts startup) when the resolved network config is
// inconsistent with the validated environment — e.g. a testnet RPC URL in a
// mainnet deployment, or a missing production configuration.
validateNetworkConfig(env);
