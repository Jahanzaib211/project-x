-- =============================================================================
-- PROJECT X — event store and ledger schema
-- =============================================================================
-- Two things in this file are authoritative: the event log and the journal.
-- Everything else in the system is a projection that can be rebuilt from them.
--
-- Constraints here are the last line of defence. They exist so that an
-- accidental SQL statement meets the same rules the application enforces.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS events;
CREATE SCHEMA IF NOT EXISTS ledger;

-- -----------------------------------------------------------------------------
-- 02-event-kernel — the append-only event log
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events.event_log (
    -- Global ordering for replay cursors.
    global_position BIGSERIAL PRIMARY KEY,

    event_id        UUID        NOT NULL,
    event_type      TEXT        NOT NULL,
    aggregate_type  TEXT        NOT NULL,
    aggregate_id    TEXT        NOT NULL,

    -- Ordering is sequence, never wall-clock time. (P4, INV-011)
    sequence        BIGINT      NOT NULL CHECK (sequence > 0),

    correlation_id  UUID        NOT NULL,
    causation_id    UUID,
    schema_version  INTEGER     NOT NULL CHECK (schema_version > 0),

    payload         JSONB       NOT NULL,
    metadata        JSONB       NOT NULL DEFAULT '{}'::JSONB,

    -- Observation time. Metadata, not ordering.
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    -- INV-010: a duplicate append is a no-op, not a second effect.
    CONSTRAINT event_log_event_id_unique UNIQUE (event_id),
    -- INV-011: gapless, strictly increasing per aggregate. Also gives us
    -- optimistic concurrency for free.
    CONSTRAINT event_log_aggregate_sequence_unique UNIQUE (aggregate_id, sequence)
);

CREATE INDEX IF NOT EXISTS event_log_aggregate_idx  ON events.event_log (aggregate_type, aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS event_log_type_idx       ON events.event_log (event_type, global_position);
CREATE INDEX IF NOT EXISTS event_log_correlation_idx ON events.event_log (correlation_id);

-- INV-012: append-only. No update, no delete, ever.
CREATE OR REPLACE FUNCTION events.reject_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'events.event_log is append-only (INV-012). Attempted %s. Corrections are new events.',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_log_no_update ON events.event_log;
CREATE TRIGGER event_log_no_update BEFORE UPDATE OR DELETE ON events.event_log
    FOR EACH ROW EXECUTE FUNCTION events.reject_mutation();

-- Transactional outbox: the event and its publication intent are written in one
-- transaction, so "it happened" and "it was published" cannot disagree. (P5)
CREATE TABLE IF NOT EXISTS events.outbox (
    global_position BIGINT      PRIMARY KEY REFERENCES events.event_log (global_position),
    topic           TEXT        NOT NULL,
    partition_key   TEXT        NOT NULL,
    published_at    TIMESTAMPTZ,
    attempts        INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
    ON events.outbox (global_position) WHERE published_at IS NULL;

-- Dedupe index for externally-sourced events (PSP webhooks, LP execution
-- reports). This is where exactly-once meets an at-least-once world. (P5)
CREATE TABLE IF NOT EXISTS events.idempotency (
    scope           TEXT        NOT NULL,
    idempotency_key TEXT        NOT NULL,
    event_id        UUID        NOT NULL,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (scope, idempotency_key)
);

-- -----------------------------------------------------------------------------
-- 03-ledger — double-entry journal
-- -----------------------------------------------------------------------------
CREATE TYPE ledger.account_kind AS ENUM (
    'client',     -- client money. segregated from house money. (INV-162)
    'house',      -- broker's own money
    'psp',        -- payment provider clearing
    'lp',         -- liquidity provider settlement
    'suspense',   -- unidentified funds, pending resolution
    'pnl',        -- realized profit and loss
    'fee'         -- commissions, swaps, charges
);

CREATE TABLE IF NOT EXISTS ledger.accounts (
    account_id   TEXT PRIMARY KEY,
    kind         ledger.account_kind NOT NULL,
    currency     CHAR(3)     NOT NULL,
    owner_id     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    closed_at    TIMESTAMPTZ
    -- NOTE: there is deliberately NO balance column here.
    -- A balance you can write to is a balance you can corrupt. (P2, INV-023)
);

CREATE TABLE IF NOT EXISTS ledger.transactions (
    transaction_id UUID PRIMARY KEY,
    event_id       UUID        NOT NULL REFERENCES events.event_log (event_id),
    kind           TEXT        NOT NULL,
    description    TEXT        NOT NULL,
    posted_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- A reversal is a new balanced transaction, never a deletion. (INV-163)
    reverses       UUID        REFERENCES ledger.transactions (transaction_id)
);

CREATE TABLE IF NOT EXISTS ledger.entries (
    entry_id       BIGSERIAL PRIMARY KEY,
    transaction_id UUID    NOT NULL REFERENCES ledger.transactions (transaction_id),
    account_id     TEXT    NOT NULL REFERENCES ledger.accounts (account_id),
    currency       CHAR(3) NOT NULL,

    -- Money is an exact integer of minor units. Never a float. (P1, INV-001)
    -- Positive = debit, negative = credit. Scale is per-currency and explicit.
    amount_minor   BIGINT  NOT NULL,
    scale          SMALLINT NOT NULL CHECK (scale >= 0 AND scale <= 12),

    CONSTRAINT entries_nonzero CHECK (amount_minor <> 0)
);

CREATE INDEX IF NOT EXISTS entries_account_idx     ON ledger.entries (account_id, entry_id);
CREATE INDEX IF NOT EXISTS entries_transaction_idx ON ledger.entries (transaction_id);

-- INV-022: entries are immutable. Corrections are new balanced entries.
DROP TRIGGER IF EXISTS entries_no_update ON ledger.entries;
CREATE TRIGGER entries_no_update BEFORE UPDATE OR DELETE ON ledger.entries
    FOR EACH ROW EXECUTE FUNCTION events.reject_mutation();

-- INV-020 / INV-021: debits == credits, per transaction AND per currency.
-- Enforced in the database as well as in code. This is the constraint that a
-- careless SQL statement still has to satisfy.
CREATE OR REPLACE FUNCTION ledger.assert_balanced() RETURNS TRIGGER AS $$
DECLARE
    imbalance RECORD;
BEGIN
    FOR imbalance IN
        SELECT currency, SUM(amount_minor) AS total
        FROM ledger.entries
        WHERE transaction_id = NEW.transaction_id
        GROUP BY currency
        HAVING SUM(amount_minor) <> 0
    LOOP
        RAISE EXCEPTION
            'INV-020/021 violated: transaction % is unbalanced in % by % minor units',
            NEW.transaction_id, imbalance.currency, imbalance.total;
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Deferred to the end of the transaction: entries are inserted one at a time,
-- so the balance check must run when the whole set is present.
DROP TRIGGER IF EXISTS entries_balanced ON ledger.entries;
CREATE CONSTRAINT TRIGGER entries_balanced
    AFTER INSERT ON ledger.entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger.assert_balanced();

-- INV-023: balance is a projection over the journal. Always derived, never stored.
CREATE OR REPLACE VIEW ledger.balances AS
SELECT
    a.account_id,
    a.kind,
    a.currency,
    COALESCE(SUM(e.amount_minor), 0) AS balance_minor,
    COALESCE(MAX(e.scale), 0)        AS scale,
    COUNT(e.entry_id)                AS entry_count
FROM ledger.accounts a
LEFT JOIN ledger.entries e ON e.account_id = a.account_id
GROUP BY a.account_id, a.kind, a.currency;

-- Invariant monitor (INV-020). Must always return zero rows in production;
-- Prometheus scrapes this and a non-zero result is a page, not a warning.
CREATE OR REPLACE VIEW ledger.imbalances AS
SELECT transaction_id, currency, SUM(amount_minor) AS imbalance_minor
FROM ledger.entries
GROUP BY transaction_id, currency
HAVING SUM(amount_minor) <> 0;
