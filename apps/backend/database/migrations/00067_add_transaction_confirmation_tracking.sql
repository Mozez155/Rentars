-- Migration 00067: Add transaction confirmation tracking
-- Persists Stellar transaction hash, network, confirmation status and
-- reconciliation handoff fields on payments and bookings.
-- Ensures chain status updates are idempotent so a confirmed payment is
-- recorded exactly once.

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_confirmation_status') THEN
        CREATE TYPE transaction_confirmation_status AS ENUM (
            'not_found',
            'pending',
            'failed',
            'confirmed',
            'unresolved'
        );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stellar_network') THEN
        CREATE TYPE stellar_network AS ENUM (
            'testnet',
            'mainnet',
            'futurenet',
            'standalone'
        );
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Payments: confirmation tracking columns
-- ---------------------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS transaction_hash TEXT,
    ADD COLUMN IF NOT EXISTS network stellar_network,
    ADD COLUMN IF NOT EXISTS confirmation_status transaction_confirmation_status NOT NULL DEFAULT 'not_found',
    ADD COLUMN IF NOT EXISTS confirmation_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confirmation_deadline TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_reason TEXT,
    ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reconciliation_handed_off_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reconciliation_resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0;

-- A transaction hash is unique per network once recorded.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_transaction_hash_network
    ON payments (network, transaction_hash)
    WHERE transaction_hash IS NOT NULL AND network IS NOT NULL;

-- Fast lookup for the reconciliation worker.
CREATE INDEX IF NOT EXISTS ix_payments_reconciliation_pending
    ON payments (reconciliation_handed_off_at)
    WHERE reconciliation_required = TRUE AND reconciliation_resolved_at IS NULL;

-- Fast lookup for in-flight polling.
CREATE INDEX IF NOT EXISTS ix_payments_confirmation_pending
    ON payments (confirmation_deadline)
    WHERE confirmation_status IN ('not_found', 'pending');

-- ---------------------------------------------------------------------------
-- Bookings: confirmation tracking columns
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS transaction_hash TEXT,
    ADD COLUMN IF NOT EXISTS network stellar_network,
    ADD COLUMN IF NOT EXISTS confirmation_status transaction_confirmation_status NOT NULL DEFAULT 'not_found',
    ADD COLUMN IF NOT EXISTS confirmation_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confirmation_deadline TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_reason TEXT,
    ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reconciliation_handed_off_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reconciliation_resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_transaction_hash_network
    ON bookings (network, transaction_hash)
    WHERE transaction_hash IS NOT NULL AND network IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_bookings_reconciliation_pending
    ON bookings (reconciliation_handed_off_at)
    WHERE reconciliation_required = TRUE AND reconciliation_resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_bookings_confirmation_pending
    ON bookings (confirmation_deadline)
    WHERE confirmation_status IN ('not_found', 'pending');

-- ---------------------------------------------------------------------------
-- Idempotency guards
--
-- A confirmed transaction must be recorded exactly once. Once a row reaches
-- 'confirmed' it can never transition to another status, and confirmed_at is
-- stamped only on the first transition. The same applies to 'failed' being
-- terminal for the polling lifecycle (reconciliation may still resolve an
-- 'unresolved' row, but a definitively failed transaction stays failed).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_transaction_confirmation_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Terminal states cannot be left.
    IF OLD.confirmation_status = 'confirmed'
       AND NEW.confirmation_status IS DISTINCT FROM 'confirmed' THEN
        RAISE EXCEPTION
            'Cannot change confirmation_status from confirmed to % on % (id=%)',
            NEW.confirmation_status, TG_TABLE_NAME, OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.confirmation_status = 'failed'
       AND NEW.confirmation_status IS DISTINCT FROM 'failed' THEN
        RAISE EXCEPTION
            'Cannot change confirmation_status from failed to % on % (id=%)',
            NEW.confirmation_status, TG_TABLE_NAME, OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Stamp confirmed_at exactly once.
    IF NEW.confirmation_status = 'confirmed' THEN
        IF OLD.confirmation_status = 'confirmed' THEN
            NEW.confirmed_at := OLD.confirmed_at;
        ELSIF NEW.confirmed_at IS NULL THEN
            NEW.confirmed_at := NOW();
        END IF;
        NEW.failed_at := NULL;
        NEW.failure_reason := NULL;
        NEW.reconciliation_required := FALSE;
    END IF;

    -- Stamp failed_at exactly once.
    IF NEW.confirmation_status = 'failed' THEN
        IF OLD.confirmation_status = 'failed' THEN
            NEW.failed_at := OLD.failed_at;
        ELSIF NEW.failed_at IS NULL THEN
            NEW.failed_at := NOW();
        END IF;
        NEW.confirmed_at := NULL;
    END IF;

    -- A polling timeout must not imply final failure: it moves the row to
    -- 'unresolved' and hands it to reconciliation.
    IF NEW.confirmation_status = 'unresolved' THEN
        NEW.reconciliation_required := TRUE;
        IF NEW.reconciliation_handed_off_at IS NULL THEN
            NEW.reconciliation_handed_off_at := NOW();
        END IF;
    END IF;

    -- Once reconciliation resolves the row, stamp the resolution time.
    IF NEW.reconciliation_resolved_at IS NOT NULL
       AND OLD.reconciliation_resolved_at IS NULL THEN
        NEW.reconciliation_required := FALSE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_confirmation_transition ON payments;
CREATE TRIGGER trg_payments_confirmation_transition
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION enforce_transaction_confirmation_transition();

DROP TRIGGER IF EXISTS trg_bookings_confirmation_transition ON bookings;
CREATE TRIGGER trg_bookings_confirmation_transition
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION enforce_transaction_confirmation_transition();

-- ---------------------------------------------------------------------------
-- Consistency constraints
-- ---------------------------------------------------------------------------

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_payments_confirmation_consistency;
ALTER TABLE payments
    ADD CONSTRAINT chk_payments_confirmation_consistency CHECK (
        (confirmation_status = 'confirmed' AND confirmed_at IS NOT NULL)
        OR (confirmation_status <> 'confirmed')
    );

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_payments_transaction_identity;
ALTER TABLE payments
    ADD CONSTRAINT chk_payments_transaction_identity CHECK (
        transaction_hash IS NULL OR network IS NOT NULL
    );

ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS chk_bookings_confirmation_consistency;
ALTER TABLE bookings
    ADD CONSTRAINT chk_bookings_confirmation_consistency CHECK (
        (confirmation_status = 'confirmed' AND confirmed_at IS NOT NULL)
        OR (confirmation_status <> 'confirmed')
    );

ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS chk_bookings_transaction_identity;
ALTER TABLE bookings
    ADD CONSTRAINT chk_bookings_transaction_identity CHECK (
        transaction_hash IS NULL OR network IS NOT NULL
    );

COMMIT;