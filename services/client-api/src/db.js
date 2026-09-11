/**
 * Database access for the client area.
 *
 * ## What lives here, and what deliberately does not
 *
 * This schema holds **account metadata**: which trading accounts exist, what
 * platform and type they are, what they are nicknamed, and whether they are
 * active or archived. Opening an account is a lifecycle event, not a movement
 * of value.
 *
 * It holds **no balance, equity, margin or P&L column** — the same design as
 * `ledger.accounts` in the core, and for the same reason: a balance you can
 * write to is a balance you can corrupt (P2, INV-023). Financial figures are
 * read from the core at request time, and when the core cannot supply them the
 * client area says so rather than inventing them (INV-183).
 *
 * This registry belongs to module `04-account` and moves there once that module
 * passes its gates. It lives at the edge for now because `04-account` is
 * blocked behind `03-ledger`, and account *metadata* carries no financial risk.
 *
 * ## Isolation is the database's job, not the application's
 *
 * One client must never see another's rows. Enforcing that with a `WHERE
 * owner_id = $1` on every statement works right up until the day somebody
 * forgets one — and the failure is silent, total, and discovered by a customer.
 *
 * So it is enforced underneath the application instead, by row-level security:
 *
 * - Three roles. `projectx` (the migration role) owns the schema and is used
 *   for nothing else. `projectx_app` serves ordinary requests. `projectx_auth`
 *   exists only to check credentials. None of the two serving roles is a
 *   superuser, and neither has BYPASSRLS — a superuser bypasses every policy
 *   here silently, which is exactly how RLS gets deployed and does nothing.
 * - Every tenant table has `FORCE ROW LEVEL SECURITY`, so the policies apply to
 *   the table owner too.
 * - `projectx_app` sees only rows matching `app.current_user_id`, a setting this
 *   module sets per transaction and nothing else can reach.
 *
 * The property that matters: **an unscoped query returns nothing.** A statement
 * that forgets its `WHERE` clause, or runs outside `asOwner`, reads zero rows
 * rather than everybody's. The application's own `WHERE` clauses stay — two
 * independent mechanisms, and the database is the one that cannot be talked out
 * of it.
 *
 * `projectx_auth` is the deliberate exception, and is narrow by construction: it
 * reaches the credential tables (to look up an address before anyone has proved
 * who they are) and has no grant at all on `app.accounts` or
 * `app.funding_requests`. Signing in cannot read a trading account.
 */

import pg from "pg";

const { Pool } = pg;

/** The setting every policy reads. Set per transaction by `asOwner`. */
const SCOPE_SETTING = "app.current_user_id";

/**
 * Passwords for the two serving roles.
 *
 * Development defaults so `docker compose up` works with no ceremony;
 * `assertProductionSafe()` refuses to start with them when NODE_ENV is
 * production, because a well-known password on a role that can read every
 * client's account list is not a smaller problem for being a default.
 */
const DEV_APP_PASSWORD = "dev_only_app_role";
const DEV_AUTH_PASSWORD = "dev_only_auth_role";

const APP_PASSWORD = process.env.DB_APP_PASSWORD ?? DEV_APP_PASSWORD;
const AUTH_PASSWORD = process.env.DB_AUTH_PASSWORD ?? DEV_AUTH_PASSWORD;

/**
 * Build a connection string for one of the serving roles from the admin one.
 *
 * Derived rather than configured separately so the three cannot drift onto
 * different hosts or databases — a mistake that produces a confusing "relation
 * does not exist" long after the deploy.
 *
 * @param {string} role
 * @param {string} password
 */
function connectionStringFor(role, password) {
  const admin = process.env.DATABASE_URL;
  if (!admin) throw new Error("DATABASE_URL is not set");
  const url = new URL(admin);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** Migration and schema ownership. Used at startup, then idle. */
export const adminPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/** Ordinary requests. Subject to row-level security. */
let appPool = /** @type {pg.Pool|null} */ (null);
/** Credential checks only. No grant on any table holding client data. */
let authPool = /** @type {pg.Pool|null} */ (null);

/**
 * The serving pools are created after `migrate()` has made their roles exist.
 * Connecting earlier fails with an authentication error that reads like a
 * configuration problem rather than an ordering one.
 */
function servingPools() {
  if (!appPool) {
    appPool = new Pool({
      connectionString: connectionStringFor("projectx_app", APP_PASSWORD),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  if (!authPool) {
    authPool = new Pool({
      connectionString: connectionStringFor("projectx_auth", AUTH_PASSWORD),
      max: 6,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return { appPool, authPool };
}

/**
 * A query function bound to one transaction.
 * @typedef {(text: string, params?: unknown[]) => Promise<pg.QueryResult<any>>} Query
 */

/**
 * Run a unit of work scoped to one owner.
 *
 * Everything inside sees only that owner's rows, because the database says so.
 * The scope is set with `set_config(..., true)` — transaction-local, so it
 * cannot leak to the next request that borrows this pooled connection. A
 * pooled connection carrying the previous caller's identity is the classic way
 * an RLS deployment turns into a cross-tenant leak.
 *
 * @template T
 * @param {string} ownerId
 * @param {(q: Query) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function asOwner(ownerId, fn) {
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    // Refused rather than defaulted. An empty scope matches no row under the
    // policies, so this would "work" — silently, returning nothing, for reasons
    // nobody would find quickly.
    throw new Error("asOwner requires an owner id");
  }
  const { appPool: pool } = servingPools();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('${SCOPE_SETTING}', $1, true)`, [ownerId]);
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run a credential operation, before an identity has been established.
 *
 * Looking up an address at sign-in, or a session by its token digest, cannot be
 * scoped to a user — finding out which user it is *is* the operation. This runs
 * as `projectx_auth`, whose grants stop at the credential tables.
 *
 * @template T
 * @param {(q: Query) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function asAuth(fn) {
  const { authPool: pool } = servingPools();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Refuse to start a production process with development defaults.
 *
 * Each of these is individually survivable and collectively an incident. They
 * are checked at startup rather than documented, because a deployment checklist
 * is a thing people complete from memory at the end of a long day.
 *
 * @returns {string[]} Problems. Empty when safe.
 */
export function productionSafetyProblems(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  /** @type {string[]} */
  const problems = [];

  if ((env.DB_APP_PASSWORD ?? DEV_APP_PASSWORD) === DEV_APP_PASSWORD) {
    problems.push("DB_APP_PASSWORD is the development default");
  }
  if ((env.DB_AUTH_PASSWORD ?? DEV_AUTH_PASSWORD) === DEV_AUTH_PASSWORD) {
    problems.push("DB_AUTH_PASSWORD is the development default");
  }
  if (env.AUTH_REQUIRED !== "true") {
    problems.push(
      "AUTH_REQUIRED is not true — anonymous requests would resolve to the shared development identity",
    );
  }
  if (env.TRUST_CLIENT_ID_HEADER === "true") {
    problems.push(
      "TRUST_CLIENT_ID_HEADER is true — the x-client-id header would let any caller act as any owner",
    );
  }
  if (String(env.DATABASE_URL ?? "").includes("dev_only_not_a_real_password")) {
    problems.push("DATABASE_URL carries the development database password");
  }
  return problems;
}

/**
 * Idempotent migration. Runs at startup, as the owning role.
 *
 * `CREATE ... IF NOT EXISTS` throughout, because the container restarts and the
 * Postgres init scripts only run on a fresh volume.
 */
export async function migrate() {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS app`);

    // Account numbers look like real trading account numbers and must never
    // collide. A sequence gives that for free and survives restarts.
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS app.account_number_seq
        START WITH 50000001 INCREMENT BY 1 NO CYCLE
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app.accounts (
        account_number  BIGINT      PRIMARY KEY,
        owner_id        TEXT        NOT NULL,
        platform        TEXT        NOT NULL CHECK (platform IN ('MT5','MT4')),
        account_type    TEXT        NOT NULL CHECK (account_type IN ('Standard','Pro','Zero','Raw')),
        mode            TEXT        NOT NULL CHECK (mode IN ('real','demo')),
        nickname        TEXT        NOT NULL,
        currency        CHAR(3)     NOT NULL,
        leverage        INTEGER     NOT NULL CHECK (leverage > 0 AND leverage <= 2000),
        status          TEXT        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active','archived')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at     TIMESTAMPTZ,
        archived_reason TEXT,

        -- An archived account must record when, and an active one must not
        -- pretend to have been archived. The state and its evidence agree.
        CONSTRAINT archived_has_a_date CHECK (
          (status = 'archived' AND archived_at IS NOT NULL) OR
          (status = 'active'   AND archived_at IS NULL)
        )
        -- NOTE: there is deliberately no balance/equity/margin column here.
        -- INV-184. The edge stores no financial value.
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS accounts_owner_idx
        ON app.accounts (owner_id, mode, status, created_at DESC)
    `);

    // Requests to move money. These are *intents*, never money: an intent
    // carries no ledger effect, and each one is stamped with the gate that is
    // currently preventing it from becoming one.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.funding_requests (
        request_id      UUID        PRIMARY KEY,
        owner_id        TEXT        NOT NULL,
        kind            TEXT        NOT NULL CHECK (kind IN ('deposit','withdrawal','transfer')),
        method          TEXT        NOT NULL,
        amount_decimal  TEXT        NOT NULL,
        currency        CHAR(3)     NOT NULL,
        from_account    BIGINT,
        to_account      BIGINT,
        status          TEXT        NOT NULL
                                    CHECK (status IN ('blocked_by_gate','submitted','settled','failed')),
        blocked_reason  TEXT,
        idempotency_key TEXT        NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT funding_idempotent UNIQUE (owner_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS funding_owner_idx
        ON app.funding_requests (owner_id, created_at DESC)
    `);

    // ---------------------------------------------------------- identity
    // Who owns the rows above. See auth.js for the rules these columns exist
    // to hold; the short version is that nothing here is reversible — a
    // password is a scrypt digest and a session token is a SHA-256, so a dump
    // of this schema yields neither a password nor a usable session.
    //
    // `owner_id` on the tables above is a user_id once someone is signed in,
    // and the development owner otherwise. It is deliberately TEXT rather than
    // a foreign key: the development owner is not a user, and making it one
    // would mean seeding a fake person into the identity table to satisfy a
    // constraint.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.users (
        user_id             UUID        PRIMARY KEY,
        email               TEXT        NOT NULL,
        password_hash       TEXT        NOT NULL,
        name                TEXT        NOT NULL,
        country             TEXT        NOT NULL DEFAULT 'Other',
        base_currency       CHAR(3)     NOT NULL DEFAULT 'USD',
        status              TEXT        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active','suspended','closed')),
        email_verified      BOOLEAN     NOT NULL DEFAULT false,

        -- Second factor. 'pending' holds a secret that has been generated but
        -- not yet proven, so an abandoned enrolment cannot lock anyone out.
        totp_secret         TEXT,
        totp_pending        TEXT,

        failed_attempts     INTEGER     NOT NULL DEFAULT 0,
        locked_until        TIMESTAMPTZ,
        password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at       TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        -- NOTE: no balance column here either. INV-184 applies to every table
        -- in this schema, not only to the account registry.
      )
    `);

    // Addresses are compared case-insensitively, so uniqueness has to be too.
    // A UNIQUE on the raw column would let "A@x.com" and "a@x.com" both
    // register and then race to own the same person.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON app.users (lower(email))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app.sessions (
        session_id    UUID        PRIMARY KEY,
        user_id       UUID        NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
        -- The token itself is never stored. This is its SHA-256.
        token_digest  TEXT        NOT NULL UNIQUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NOT NULL,
        revoked_at    TIMESTAMPTZ,
        user_agent    TEXT,
        ip            TEXT
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS sessions_user_idx
        ON app.sessions (user_id, revoked_at, expires_at DESC)
    `);

    // Single-use codes for when the authenticator is lost. Digests only, and a
    // spent code is deleted rather than flagged — there is no state a spent
    // code needs to carry, and a row that can be un-spent is a row that will be.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.recovery_codes (
        user_id      UUID        NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
        code_digest  TEXT        NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, code_digest)
      )
    `);

    // One-time links: password reset and email confirmation.
    //
    // The token is stored as a digest, like a session, so the table cannot be
    // read to mint a reset. `purpose` keeps the two kinds apart — a reset token
    // accepted as a verification token (or the reverse) is a confused-deputy
    // bug that reads as a feature until somebody notices.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.one_time_tokens (
        token_digest TEXT        PRIMARY KEY,
        user_id      UUID        NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
        purpose      TEXT        NOT NULL CHECK (purpose IN ('password_reset','email_verification')),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ NOT NULL,
        consumed_at  TIMESTAMPTZ,
        requested_ip TEXT
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS one_time_tokens_user_idx
        ON app.one_time_tokens (user_id, purpose, expires_at DESC)
    `);

    // Messages this platform would send if it could send anything.
    //
    // There is no email provider, so a reset link has nowhere to go. Dropping
    // it would make password reset untestable and undemonstrable; pretending to
    // send it would be a lie told to somebody locked out. It is recorded here
    // instead: a real outbox, which a delivery worker would drain, and which in
    // development is where the link can actually be read from.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.outbox (
        message_id   UUID        PRIMARY KEY,
        user_id      UUID        REFERENCES app.users(user_id) ON DELETE CASCADE,
        to_address   TEXT        NOT NULL,
        kind         TEXT        NOT NULL,
        subject      TEXT        NOT NULL,
        body         TEXT        NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivered_at TIMESTAMPTZ,
        -- Why it has not been delivered. Null once a provider exists and works.
        blocked_reason TEXT
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS outbox_undelivered_idx
        ON app.outbox (created_at DESC) WHERE delivered_at IS NULL
    `);

    // What happened to an account, as opposed to what it looks like now.
    //
    // "Was that me?" and "when did this change?" are questions a person asks
    // after something has gone wrong, and the current state cannot answer
    // either. Append-only: there is no update path, and the serving roles are
    // granted INSERT and SELECT but never UPDATE or DELETE.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.security_events (
        event_id   BIGSERIAL   PRIMARY KEY,
        user_id    UUID        REFERENCES app.users(user_id) ON DELETE CASCADE,
        event      TEXT        NOT NULL,
        detail     TEXT,
        ip         TEXT,
        user_agent TEXT,
        at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS security_events_user_idx
        ON app.security_events (user_id, at DESC)
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await applyIsolation();
  return true;
}

/**
 * Create the serving roles and the policies that confine them.
 *
 * Runs outside the schema transaction because `CREATE ROLE` is not something to
 * hold a schema lock across, and because each statement here is independently
 * idempotent.
 */
async function applyIsolation() {
  const client = await adminPool.connect();
  try {
    // ---- roles ----
    // NOSUPERUSER and NOBYPASSRLS are the load-bearing words. A superuser
    // ignores every policy below without an error, a warning, or any visible
    // difference — which is how row-level security comes to be deployed,
    // believed in, and doing nothing at all.
    /** @type {Array<[string, string]>} */
    const servingRoles = [
      ["projectx_app", APP_PASSWORD],
      ["projectx_auth", AUTH_PASSWORD],
    ];
    for (const [role, password] of servingRoles) {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
                                NOINHERIT NOREPLICATION NOBYPASSRLS;
          END IF;
        END
        $$;
      `);
      // Set every time, so rotating a password is a restart rather than a
      // manual step somebody has to remember.
      await client.query(`ALTER ROLE ${role} WITH PASSWORD ${literal(password)} NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT USAGE ON SCHEMA app TO ${role}`);
    }

    // ---- grants ----
    // projectx_app: the client's own data. No access to password hashes.
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON
        app.accounts, app.funding_requests, app.sessions, app.recovery_codes
      TO projectx_app
    `);
    await client.query(`GRANT SELECT, UPDATE ON app.users TO projectx_app`);
    await client.query(`GRANT SELECT, INSERT ON app.security_events TO projectx_app`);
    await client.query(`GRANT USAGE ON SEQUENCE app.account_number_seq TO projectx_app`);
    await client.query(`GRANT USAGE ON SEQUENCE app.security_events_event_id_seq TO projectx_app`);

    // projectx_auth: credentials only. Deliberately no grant whatsoever on
    // app.accounts or app.funding_requests — signing in cannot read a trading
    // account, and that is enforced by the absence of a grant rather than by
    // the absence of a query.
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON
        app.users, app.sessions, app.recovery_codes, app.one_time_tokens
      TO projectx_auth
    `);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON app.outbox TO projectx_auth`);
    await client.query(`GRANT SELECT, INSERT ON app.security_events TO projectx_auth`);
    await client.query(`GRANT USAGE ON SEQUENCE app.security_events_event_id_seq TO projectx_auth`);

    // ---- policies ----
    for (const table of [
      "accounts", "funding_requests", "users", "sessions",
      "recovery_codes", "one_time_tokens", "outbox", "security_events",
    ]) {
      await client.query(`ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY`);
      // FORCE, so the owning role is subject to its own policies too. Without
      // it the policies apply to everyone except the role running migrations —
      // and a check that runs as that role would report everything is fine.
      await client.query(`ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`);
    }

    /**
     * @param {string} table
     * @param {string} name
     * @param {string} role
     * @param {string} predicate
     */
    const policy = async (table, name, role, predicate) => {
      await client.query(`DROP POLICY IF EXISTS ${name} ON app.${table}`);
      await client.query(
        `CREATE POLICY ${name} ON app.${table} FOR ALL TO ${role}
           USING (${predicate}) WITH CHECK (${predicate})`,
      );
    };

    // The scope. `current_setting(..., true)` returns NULL when unset rather
    // than raising, and NULL never equals anything — so a statement that runs
    // outside asOwner matches no row. Unscoped reads nothing; it does not read
    // everything.
    const scope = `current_setting('${SCOPE_SETTING}', true)`;

    await policy("accounts", "accounts_own", "projectx_app", `owner_id = ${scope}`);
    await policy("funding_requests", "funding_own", "projectx_app", `owner_id = ${scope}`);
    await policy("users", "users_own", "projectx_app", `user_id::text = ${scope}`);
    await policy("sessions", "sessions_own", "projectx_app", `user_id::text = ${scope}`);
    await policy("recovery_codes", "recovery_own", "projectx_app", `user_id::text = ${scope}`);
    await policy("security_events", "events_own", "projectx_app", `user_id::text = ${scope}`);

    // The credential role. Its confinement is the grant list above, not a
    // predicate: these are the tables it may touch at all, and it may touch
    // every row in them because "which user is this?" is the question it exists
    // to answer.
    for (const table of ["users", "sessions", "recovery_codes", "one_time_tokens"]) {
      await policy(table, `${table}_auth`, "projectx_auth", "true");
    }
    await policy("outbox", "outbox_auth", "projectx_auth", "true");
    await policy("security_events", "events_auth", "projectx_auth", "true");
  } finally {
    client.release();
  }
}

/**
 * Quote a string as a SQL literal.
 *
 * Used only for role passwords, which cannot be bound as parameters because
 * ALTER ROLE does not accept them. Doubling the quote is the whole escape rule
 * for a standard-conforming string, and the value is rejected outright if it
 * contains a backslash or a null, so no escape-string extension can apply.
 *
 * @param {string} value
 */
function literal(value) {
  if (/[\\\u0000]/.test(value)) {
    throw new Error("a database role password may not contain a backslash or a null byte");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Report what the database will actually enforce.
 *
 * Read back from the catalogue rather than assumed from the migration having
 * run, so the gate checks the state of the system rather than the intent of the
 * code. A policy that failed to apply, or a role that acquired BYPASSRLS in
 * some later manual fix, shows up here.
 */
export async function isolationStatus() {
  const roles = await adminPool.query(
    `SELECT rolname, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname IN ('projectx_app','projectx_auth')
      ORDER BY rolname`,
  );
  const tables = await adminPool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  const grants = await adminPool.query(
    `SELECT grantee, table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privileges
       FROM information_schema.role_table_grants
      WHERE table_schema = 'app' AND grantee IN ('projectx_app','projectx_auth')
      GROUP BY grantee, table_name
      ORDER BY grantee, table_name`,
  );
  return { roles: roles.rows, tables: tables.rows, grants: grants.rows };
}

/**
 * Admin-scope query. Migration and diagnostics only.
 *
 * Not exported as `query`: the old name made "just run a statement" the path of
 * least resistance, and that path runs as the owning role with every policy
 * behind it. Callers reach for `asOwner` or `asAuth` instead.
 *
 * @param {string} text
 * @param {unknown[]} [params]
 */
export async function adminQuery(text, params = []) {
  return adminPool.query(text, params);
}

/** Close every pool on shutdown. */
export async function close() {
  await Promise.all([
    adminPool.end().catch(() => {}),
    appPool?.end().catch(() => {}),
    authPool?.end().catch(() => {}),
  ]);
}
