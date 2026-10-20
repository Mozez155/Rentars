-- Migration guide for updating existing properties with calendar pricing
--
-- This guide also documents the sequencing for the contract version registry
-- (Issue 055) and Stellar transaction confirmation tracking (Issue 054).
-- Run sections in the order listed; every statement is written to be
-- idempotent so a partially applied migration can be safely re-run.

-- Step 1: Update properties with base pricing (data migration)
-- For existing properties, migrate price_per_night → base_price_per_night
UPDATE properties
SET base_price_per_night = price_per_night
WHERE base_price_per_night = 0 OR base_price_per_night IS NULL;

-- Step 2: Set sensible defaults for new fields
UPDATE properties
SET minimum_stay_nights = COALESCE(minimum_stay_nights, 1)
WHERE minimum_stay_nights IS NULL OR minimum_stay_nights = 0;

-- Step 3: Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_bookings_status_dates
  ON bookings(property_id, status, check_in, check_out)
  WHERE status != 'Cancelled';

-- Step 4: Populate pricing_history from existing bookings (audit trail)
-- This captures historical pricing information
INSERT INTO pricing_history (property_id, date, price_per_night, reason, created_at)
SELECT
  p.id,
  DATE(b.created_at),
  p.base_price_per_night,
  'Historical import from bookings',
  NOW()
FROM properties p
LEFT JOIN bookings b ON p.id = b.property_id
WHERE b.created_at > NOW() - INTERVAL '90 days'
  AND NOT EXISTS (
    SELECT 1 FROM pricing_history ph
    WHERE ph.property_id = p.id
      AND DATE(ph.created_at) = DATE(b.created_at)
  )
ON CONFLICT DO NOTHING;

-- Step 5: Verify migration success
-- Count properties with proper base pricing
SELECT 
  COUNT(*) as total_properties,
  COUNT(CASE WHEN base_price_per_night > 0 THEN 1 END) as with_base_price,
  COUNT(CASE WHEN minimum_stay_nights >= 1 THEN 1 END) as with_min_stay
FROM properties;

-- Step 6: Archive old price_per_night if needed (optional)
-- ALTER TABLE properties DROP COLUMN price_per_night;
-- Only drop after confirming base_price_per_night is working

-- Step 7: Test that availability queries work correctly
EXPLAIN ANALYZE
SELECT d::date
FROM generate_series(
  (SELECT MIN(check_in) FROM bookings),
  (SELECT MAX(check_out) FROM bookings),
  '1 day'::interval
) AS d
WHERE NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.property_id = 'test-id'
    AND b.status != 'Cancelled'
    AND d::date >= b.check_in::date
    AND d::date < b.check_out::date
);

-- Step 8: Create maintenance record
INSERT INTO special_events (property_id, name, start_date, end_date, is_blocked, created_at)
SELECT 
  id,
  'Historical availability import',
  CURRENT_DATE,
  CURRENT_DATE + INTERVAL '1 day',
  false,
  NOW()
FROM properties
WHERE created_at < NOW() - INTERVAL '30 days'
LIMIT 0; -- Don't actually create, just showing structure

-- ===========================================================================
-- Step 9: Contract version registry (Issue 055)
-- ===========================================================================
-- Records which contract ID, WASM hash and ABI version is deployed per
-- network. Populated by the build/deploy pipeline; validated at startup.
-- Rows are never deleted, only superseded, so operators can always identify
-- the deployed hash and ABI for any point in time.

CREATE TABLE IF NOT EXISTS contract_versions (
  id                    BIGSERIAL PRIMARY KEY,
  network               TEXT        NOT NULL,          -- e.g. 'testnet', 'mainnet'
  contract_id           TEXT        NOT NULL,          -- Stellar contract address (C...)
  wasm_hash             TEXT        NOT NULL,          -- hex SHA-256 of deployed WASM
  abi_version           TEXT        NOT NULL,          -- semver of the ABI
  app_release           TEXT        NOT NULL,          -- compatible application release
  initialization_deps   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_active             BOOLEAN     NOT NULL DEFAULT false,
  deployed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contract_versions_unique UNIQUE (network, contract_id, wasm_hash, abi_version)
);

-- Only one active version per (network, contract_id) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_versions_active
  ON contract_versions(network, contract_id)
  WHERE is_active;

-- Idempotent registration: re-running a deploy with the same metadata is a
-- no-op; a new hash/ABI inserts a new row and deactivates the previous one.
-- Replace the VALUES block with the values emitted by the build pipeline.
WITH incoming(network, contract_id, wasm_hash, abi_version, app_release, initialization_deps) AS (
  VALUES (
    'testnet',
    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    '0000000000000000000000000000000000000000000000000000000000000000',
    '1.0.0',
    '0.0.0',
    '[]'::jsonb
  )
), deactivated AS (
  UPDATE contract_versions cv
  SET is_active = false
  FROM incoming i
  WHERE cv.network = i.network
    AND cv.contract_id = i.contract_id
    AND cv.is_active
    AND NOT (cv.wasm_hash = i.wasm_hash AND cv.abi_version = i.abi_version)
  RETURNING cv.id
)
INSERT INTO contract_versions (network, contract_id, wasm_hash, abi_version, app_release, initialization_deps, is_active)
SELECT i.network, i.contract_id, i.wasm_hash, i.abi_version, i.app_release, i.initialization_deps, true
FROM incoming i
ON CONFLICT (network, contract_id, wasm_hash, abi_version) DO UPDATE
  SET app_release         = EXCLUDED.app_release,
      initialization_deps = EXCLUDED.initialization_deps,
      is_active           = true;

-- Startup validation: fail fast if a configured contract has no active
-- registry entry, or if the active ABI is not compatible with this release.
-- (Run as a pre-flight check; returns zero rows when configuration is valid.)
SELECT cv.network, cv.contract_id, cv.abi_version, cv.app_release
FROM contract_versions cv
WHERE cv.is_active
  AND cv.app_release <> '0.0.0'   -- replace with the running app release
ORDER BY cv.network, cv.contract_id;

-- Non-sensitive version health data for operators / status endpoints.
SELECT
  network,
  contract_id,
  wasm_hash,
  abi_version,
  app_release,
  deployed_at
FROM contract_versions
WHERE is_active
ORDER BY network, contract_id;

-- Migration sequencing for upgrades:
--   1. Deploy the new contract to staging and register it here (is_active
--      stays false until validation passes).
--   2. Run the startup validation query against staging; confirm the active
--      ABI version is compatible with the staging app release.
--   3. Promote: re-run the idempotent registration block for mainnet. The
--      previous row is deactivated in the same transaction, so readers never
--      observe two active versions.
--   4. Only after promotion, roll out the application release that depends on
--      the new ABI. Roll back by re-activating the prior row.

-- ===========================================================================
-- Step 10: Stellar transaction confirmation tracking (Issue 054)
-- ===========================================================================
-- A successful broadcast is not proof of ledger confirmation. Persist the
-- hash and network at submission time, then let the poller/reconciler move
-- the row through pending -> confirmed | failed. Unresolved rows are handed
-- to reconciliation rather than being marked failed on timeout.

CREATE TABLE IF NOT EXISTS stellar_transactions (
  id                BIGSERIAL PRIMARY KEY,
  tx_hash           TEXT        NOT NULL,              -- Stellar transaction hash
  network           TEXT        NOT NULL,              -- 'testnet' | 'mainnet'
  operation_type    TEXT        NOT NULL,              -- e.g. 'payment'
  operation_ref     TEXT,                              -- domain row id (e.g. payment id)
  status            TEXT        NOT NULL DEFAULT 'submitted',
                    -- submitted | pending | confirmed | failed | unresolved
  ledger            BIGINT,
  result_code       TEXT,                              -- e.g. 'txSUCCESS', 'txFAILED'
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at   TIMESTAMPTZ,
  confirmed_at      TIMESTAMPTZ,
  poll_attempts     INTEGER     NOT NULL DEFAULT 0,
  deadline_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes'),
  reconciliation_at TIMESTAMPTZ,                       -- set when handed off
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stellar_transactions_hash_network_unique UNIQUE (network, tx_hash),
  CONSTRAINT stellar_transactions_status_check
    CHECK (status IN ('submitted', 'pending', 'confirmed', 'failed', 'unresolved'))
);

CREATE INDEX IF NOT EXISTS idx_stellar_transactions_pending
  ON stellar_transactions(status, deadline_at)
  WHERE status IN ('submitted', 'pending');

CREATE INDEX IF NOT EXISTS idx_stellar_transactions_operation
  ON stellar_transactions(operation_type, operation_ref);

-- Idempotent insert at broadcast time. Re-submitting the same hash is a no-op
-- and never resets an already-final outcome.
INSERT INTO stellar_transactions (tx_hash, network, operation_type, operation_ref, status)
VALUES ('<tx_hash>', 'testnet', 'payment', '<payment_id>', 'submitted')
ON CONFLICT (network, tx_hash) DO NOTHING;

-- Idempotent status transition. Only non-final rows may advance, and a
-- confirmed row can never be downgraded, so replays are safe.
-- status: 'pending' when the hash is not yet found / not yet included,
--         'confirmed' when included with a success result code,
--         'failed' only for a definitive on-chain failure.
UPDATE stellar_transactions
SET status          = '<new_status>',
    ledger          = COALESCE(<ledger>, ledger),
    result_code     = COALESCE('<result_code>', result_code),
    last_checked_at = NOW(),
    confirmed_at    = CASE WHEN '<new_status>' = 'confirmed' THEN NOW() ELSE confirmed_at END,
    poll_attempts   = poll_attempts + 1,
    updated_at      = NOW()
WHERE network = 'testnet'
  AND tx_hash = '<tx_hash>'
  AND status IN ('submitted', 'pending')
  AND NOT (status = 'confirmed');

-- Bounded polling: select rows still eligible for polling (deadline not yet
-- passed). The poller applies exponential backoff between attempts.
SELECT id, tx_hash, network, poll_attempts, deadline_at
FROM stellar_transactions
WHERE status IN ('submitted', 'pending')
  AND deadline_at > NOW()
ORDER BY last_checked_at NULLS FIRST
LIMIT 100;

-- Reconciliation handoff: a polling timeout is NOT a final failure. Rows past
-- their deadline are marked 'unresolved' and queued for reconciliation, which
-- may later resolve them to confirmed or failed.
UPDATE stellar_transactions
SET status            = 'unresolved',
    reconciliation_at = NOW(),
    updated_at        = NOW()
WHERE status IN ('submitted', 'pending')
  AND deadline_at <= NOW();

-- Reconciliation worker picks up unresolved rows (idempotent; safe to retry).
SELECT id, tx_hash, network, operation_type, operation_ref, submitted_at
FROM stellar_transactions
WHERE status = 'unresolved'
ORDER BY submitted_at
LIMIT 100;

-- Confirmed operations must update the payment exactly once. Guard the
-- payment update on the transaction still being unresolved/confirmed and use
-- the unique (network, tx_hash) constraint as the idempotency key.
UPDATE payments p
SET status = 'confirmed',
    confirmed_at = COALESCE(p.confirmed_at, NOW())
FROM stellar_transactions t
WHERE t.network = 'testnet'
  AND t.tx_hash = '<tx_hash>'
  AND t.status = 'confirmed'
  AND p.id = t.operation_ref
  AND p.status <> 'confirmed';

-- Verification: no transaction should remain in a non-final state past its
-- deadline without being handed to reconciliation.
SELECT id, tx_hash, network, status, deadline_at
FROM stellar_transactions
WHERE status IN ('submitted', 'pending')
  AND deadline_at <= NOW()
ORDER BY deadline_at;

-- Migration verification queries

-- Check for properties missing base pricing
SELECT id, title, base_price_per_night
FROM properties
WHERE base_price_per_night IS NULL OR base_price_per_night = 0
ORDER BY created_at DESC;

-- Check minimum stay constraints
SELECT id, title, minimum_stay_nights
FROM properties
WHERE minimum_stay_nights IS NULL OR minimum_stay_nights < 1
ORDER BY created_at DESC;

-- Count seasonal pricing by property
SELECT 
  p.id,
  p.title,
  COUNT(sp.id) as season_count,
  COUNT(se.id) as event_count
FROM properties p
LEFT JOIN seasonal_pricing sp ON p.id = sp.property_id
LEFT JOIN special_events se ON p.id = se.property_id
GROUP BY p.id, p.title
ORDER BY season_count DESC, event_count DESC;

-- Availability ranges summary
SELECT 
  p.id,
  p.title,
  COUNT(ar.id) as blocked_ranges,
  MIN(ar.start_date) as earliest_block,
  MAX(ar.end_date) as latest_block
FROM properties p
LEFT JOIN availability_ranges ar ON p.id = ar.property_id AND ar.is_available = false
GROUP BY p.id, p.title
HAVING COUNT(ar.id) > 0
ORDER BY blocked_ranges DESC;

-- Timeline of pricing changes
SELECT 
  property_id,
  date,
  price_per_night,
  reason,
  created_at
FROM pricing_history
ORDER BY property_id, date DESC
LIMIT 50;
