/**
 * Trading account lifecycle — module `04-account`'s non-financial half.
 *
 * Open, list, archive, restore. No balances are *stored* here: every figure
 * is read from `03-ledger` at the moment of asking and forwarded as the string
 * the ledger produced, or reported as unavailable with the reason (INV-183).
 *
 * ## One account, two records, one number (INV-033)
 *
 * The ledger is the authority on account numbers. Opening an account opens it
 * in the ledger **first** and stores the client-area record — platform, type,
 * nickname, archive state — under the number the ledger issued. There is no
 * second sequence to drift from it, and there is no such thing as a client-area
 * account the ledger has never heard of: the terminal, the accounts page and
 * the funding screens all name the same thing.
 */

import { randomUUID } from "node:crypto";
import { forward, refusal, UPSTREAM } from "./core.js";
import { adminQuery, asOwner } from "./db.js";
import { HttpError } from "./money.js";

/**
 * Every function here runs inside `asOwner`, which opens a transaction and
 * tells Postgres whose request this is. Row-level security then confines the
 * statements to that owner's rows.
 *
 * The `WHERE owner_id = $1` clauses below are kept even though the policies
 * make them redundant. They are not redundant in the way that matters: they
 * document the intent at the call site, they produce the index scan the planner
 * wants, and they are what still holds if a policy is ever dropped. Two
 * independent mechanisms, and only one of them can be edited by someone who
 * does not know the other exists.
 */

/** Account types offered, with the shape a client actually chooses between. */
export const ACCOUNT_TYPES = {
  Standard: {
    label: "Standard",
    description: "Balanced spreads with no commission. The usual starting point.",
    minDeposit: "10.00",
    commission: "None",
    spreadFrom: "0.3 pips",
  },
  Pro: {
    label: "Pro",
    description: "Tighter spreads, no commission, higher minimum.",
    minDeposit: "200.00",
    commission: "None",
    spreadFrom: "0.1 pips",
  },
  Zero: {
    label: "Zero",
    description: "Zero spread on major pairs; commission per lot.",
    minDeposit: "200.00",
    commission: "From 3.50 per lot",
    spreadFrom: "0.0 pips",
  },
  Raw: {
    label: "Raw",
    description: "Raw interbank spread with a flat commission.",
    minDeposit: "200.00",
    commission: "3.50 per lot",
    spreadFrom: "0.0 pips",
  },
};

export const LEVERAGES = [50, 100, 200, 400, 500, 1000, 2000];
export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"];
export const PLATFORMS = ["MT5", "MT4"];

/**
 * @param {string} ownerId
 * @param {{mode?: string|undefined, status?: string|undefined}} [filter]
 * @returns {Promise<PresentedAccount[]>}
 */
export async function list(ownerId, filter = {}) {
  const clauses = ["owner_id = $1"];
  const params = [ownerId];

  if (filter.mode) {
    params.push(filter.mode);
    clauses.push(`mode = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length}`);
  }

  const rows = await asOwner(ownerId, async (q) => {
    const result = await q(
      `SELECT account_number, platform, account_type, mode, nickname, currency,
              leverage, status, created_at, archived_at, archived_reason
         FROM app.accounts
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC`,
      params,
    );
    return result.rows;
  });
  return valued(ownerId, rows.map(present));
}

/**
 * Attach the ledger's figures to a list of accounts.
 *
 * One call for the owner's ledger accounts, then one valuation per active
 * account, in parallel. Nothing here is computed: `balance` and `equity` are
 * the strings the ledger returned. Where the ledger cannot be reached the
 * figures stay `null` and the reason says so (INV-183).
 *
 * @param {string} ownerId
 * @param {PresentedAccount[]} accounts
 */
async function valued(ownerId, accounts) {
  if (accounts.length === 0) return accounts;

  /** @type {Map<string, TradingAccount>} */
  const inLedger = new Map();
  try {
    const listed = await forward(
      UPSTREAM.ledger,
      `/v1/accounts?owner=${encodeURIComponent(ownerId)}`,
    );
    for (const account of listed.ok ? listed.body.accounts ?? [] : []) {
      inLedger.set(String(account.accountNumber), account);
    }
  } catch {
    return accounts.map((account) => ({
      ...account,
      balanceUnavailableReason: "The financial core is unreachable, so no balance can be read.",
    }));
  }

  return Promise.all(
    accounts.map(async (account) => {
      const ledger = inLedger.get(account.accountNumber);
      if (!ledger) {
        return {
          ...account,
          balanceUnavailableReason: "The ledger holds no record of this account.",
        };
      }
      const state = await forward(
        UPSTREAM.ledger,
        `/v1/accounts/${encodeURIComponent(account.accountNumber)}/state`,
      ).catch(() => null);
      const valuation = state?.ok ? state.body.valuation : undefined;
      return {
        ...account,
        ledgerStatus: ledger.status,
        balance: valuation?.balance ?? null,
        equity: valuation?.equity ?? null,
        openPositions: valuation ? valuation.positions.length : null,
        balanceUnavailableReason: valuation
          ? null
          : "The financial core could not value this account.",
      };
    }),
  );
}

/**
 * A trading account as the API presents it.
 *
 * `balance` and `equity` are `null` by construction, not by accident: the edge
 * has no financial state to report and says so (INV-183).
 *
 * @typedef {object} PresentedAccount
 * @property {string} accountNumber
 * @property {string} platform
 * @property {string} accountType
 * @property {string} mode
 * @property {string} nickname
 * @property {string} currency
 * @property {number} leverage
 * @property {string} status
 * @property {string} createdAt
 * @property {string|null} archivedAt
 * @property {string|null} archivedReason
 * @property {string|null} balance The ledger's figure, or null with a reason.
 * @property {string|null} equity
 * @property {number|null} [openPositions]
 * @property {string|undefined} [ledgerStatus] active | frozen | closed, as the ledger has it.
 * @property {string|null} balanceUnavailableReason
 */

/**
 * Shape a row for the API. Note what is absent: every financial field is
 * reported as unavailable with the reason, never as a number.
 * @param {Record<string, any>} row
 * @returns {PresentedAccount}
 */
function present(row) {
  return {
    accountNumber: String(row.account_number),
    platform: row.platform,
    accountType: row.account_type,
    mode: row.mode,
    nickname: row.nickname,
    currency: row.currency,
    leverage: row.leverage,
    status: row.status,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    archivedReason: row.archived_reason,
    // INV-183 — the client area never fabricates a financial figure. These
    // are filled in from the ledger by `valued`, or left null with a reason.
    balance: null,
    equity: null,
    balanceUnavailableReason: "No valuation has been read for this account.",
  };
}

/**
 * Open a trading account.
 * @param {string} ownerId
 * @param {Record<string, unknown>} input
 */
export async function open(ownerId, input) {
  const platform = String(input.platform ?? "MT5");
  const accountType = String(input.accountType ?? "Standard");
  const mode = String(input.mode ?? "real");
  const currency = String(input.currency ?? "USD");
  const leverage = Number(input.leverage ?? 200);
  const nickname = String(input.nickname ?? "").trim();

  if (!PLATFORMS.includes(platform)) {
    throw new HttpError(400, `platform must be one of ${PLATFORMS.join(", ")}`);
  }
  if (!Object.hasOwn(ACCOUNT_TYPES, accountType)) {
    throw new HttpError(
      400,
      `accountType must be one of ${Object.keys(ACCOUNT_TYPES).join(", ")}`,
    );
  }
  if (mode !== "real" && mode !== "demo") {
    throw new HttpError(400, "mode must be 'real' or 'demo'");
  }
  if (!CURRENCIES.includes(currency)) {
    throw new HttpError(400, `currency must be one of ${CURRENCIES.join(", ")}`);
  }
  if (!LEVERAGES.includes(leverage)) {
    throw new HttpError(400, `leverage must be one of ${LEVERAGES.join(", ")}`);
  }
  if (nickname.length > 40) {
    throw new HttpError(400, "nickname must be 40 characters or fewer");
  }

  const label = nickname || `${accountType} ${mode === "demo" ? "Demo" : ""}`.trim();

  // The ledger issues the number and, for a demo account, the capital — in one
  // durable effect. Only once that has been acknowledged does a client-area
  // record exist to point at it.
  const opened = await forward(UPSTREAM.ledger, "/v1/accounts", {
    method: "POST",
    body: { owner: ownerId, nickname: label, leverage, mode },
  });
  if (!opened.ok) throw refusal(opened, "The financial core refused to open the account.");
  const accountNumber = String(opened.body.accountNumber);

  const stored = await asOwner(ownerId, async (q) => {
    // The policy's WITH CHECK clause applies here too: an INSERT naming a
    // different owner_id is rejected by the database, not merely absent from
    // later reads. Writing into someone else's account list is as impossible
    // as reading from it.
    const result = await q(
      `INSERT INTO app.accounts
         (account_number, owner_id, platform, account_type, mode, nickname, currency, leverage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING account_number, platform, account_type, mode, nickname, currency,
                 leverage, status, created_at, archived_at, archived_reason`,
      [accountNumber, ownerId, platform, accountType, mode, label, currency, leverage],
    );
    return present(result.rows[0]);
  });
  const [account] = await valued(ownerId, [stored]);
  return /** @type {PresentedAccount} */ (account);
}

/**
 * Tell the ledger an account's lifecycle changed (INV-032).
 *
 * Archived here is frozen there: the account stops originating anything, and
 * its positions and history stand. The ledger is asked first; if it cannot be
 * told, the client-area record is not changed either — two records that
 * disagree about whether an account can trade is exactly the state INV-033
 * exists to prevent.
 *
 * @param {string} accountNumber
 * @param {"active"|"frozen"} status
 */
async function setLedgerStatus(accountNumber, status) {
  const result = await forward(
    UPSTREAM.ledger,
    `/v1/accounts/${encodeURIComponent(accountNumber)}/status`,
    { method: "POST", body: { status } },
  );
  // Already in that state is fine: the client-area transition below is
  // idempotent too, and the two must agree.
  if (!result.ok && result.body.error !== "ILLEGAL_TRANSITION") {
    throw refusal(result, "The financial core could not change the account's status.");
  }
}

/**
 * The owner's own record of an account, or a 404.
 *
 * Someone else's account number is indistinguishable from one that does not
 * exist: the policy hides the row, and this reports the same 404 either way.
 * Anything else would confirm that the number belongs to somebody.
 *
 * @param {string} ownerId
 * @param {string} accountNumber
 * @returns {Promise<{mode: string, status: string}>}
 */
async function requireOwned(ownerId, accountNumber) {
  if (!/^\d{6,12}$/.test(accountNumber)) throw new HttpError(404, "account not found");
  const row = await asOwner(ownerId, async (q) => {
    const found = await q(
      "SELECT mode, status FROM app.accounts WHERE owner_id = $1 AND account_number = $2",
      [ownerId, accountNumber],
    );
    return found.rows[0];
  });
  if (!row) throw new HttpError(404, "account not found");
  return row;
}

/**
 * Archive an account. Idempotent: archiving an archived account is a no-op.
 * @param {string} ownerId
 * @param {string} accountNumber
 * @param {string} reason
 */
export async function archive(ownerId, accountNumber, reason) {
  await requireOwned(ownerId, accountNumber);
  await setLedgerStatus(accountNumber, "frozen");
  return asOwner(ownerId, async (q) => {
    const result = await q(
      `UPDATE app.accounts
          SET status = 'archived', archived_at = now(), archived_reason = $3
        WHERE owner_id = $1 AND account_number = $2 AND status = 'active'
        RETURNING account_number`,
      [ownerId, accountNumber, reason],
    );
    if (result.rowCount === 0) {
      // Someone else's account number is indistinguishable from one that does
      // not exist, and says so: the policy hides the row, and this reports the
      // same 404 either way. Anything else would confirm that the number
      // belongs to somebody.
      const exists = await q(
        "SELECT status FROM app.accounts WHERE owner_id = $1 AND account_number = $2",
        [ownerId, accountNumber],
      );
      if (exists.rowCount === 0) throw new HttpError(404, "account not found");
    }
    return { accountNumber, status: "archived" };
  });
}

/**
 * Restore an archived account. Idempotent.
 * @param {string} ownerId
 * @param {string} accountNumber
 */
export async function restore(ownerId, accountNumber) {
  await requireOwned(ownerId, accountNumber);
  await setLedgerStatus(accountNumber, "active");
  return asOwner(ownerId, async (q) => {
    const result = await q(
      `UPDATE app.accounts
          SET status = 'active', archived_at = NULL, archived_reason = NULL
        WHERE owner_id = $1 AND account_number = $2 AND status = 'archived'
        RETURNING account_number`,
      [ownerId, accountNumber],
    );
    if (result.rowCount === 0) {
      const exists = await q(
        "SELECT status FROM app.accounts WHERE owner_id = $1 AND account_number = $2",
        [ownerId, accountNumber],
      );
      if (exists.rowCount === 0) throw new HttpError(404, "account not found");
    }
    return { accountNumber, status: "active" };
  });
}

/**
 * Seed a couple of archived accounts so a fresh install has something to show.
 *
 * Called once at startup, never from a read handler. Even so, the whole thing
 * runs inside one transaction behind a transaction-scoped advisory lock: two
 * API instances starting simultaneously would otherwise both observe an empty
 * table and both seed. The lock is released when the transaction ends, whether
 * it commits or rolls back.
 *
 * The seeds are opened in the ledger like any other account (INV-033) and
 * frozen there, so an archived seed is exactly what an archived account is.
 * If the ledger cannot be reached the seeding is skipped, not faked.
 *
 * @param {string} ownerId
 * @returns {Promise<boolean>} true if this call did the seeding
 */
export async function seedIfEmpty(ownerId) {
  // `asOwner` supplies the transaction, so the advisory lock is held for
  // exactly the right span and released on commit or rollback either way.
  return asOwner(ownerId, async (q) => {
    // One lock per owner. hashtext() gives a stable key from the owner id.
    await q("SELECT pg_advisory_xact_lock(hashtext($1))", [ownerId]);

    const existing = await q(
      "SELECT count(*)::int AS n FROM app.accounts WHERE owner_id = $1",
      [ownerId],
    );
    if (existing.rows[0].n > 0) return false;

    for (const seed of [
      { type: "Standard", nickname: "Long-term", days: 63 },
      { type: "Standard", nickname: "Scalping", days: 58 },
    ]) {
      const opened = await forward(UPSTREAM.ledger, "/v1/accounts", {
        method: "POST",
        body: { owner: ownerId, nickname: seed.nickname, leverage: 200, mode: "real" },
      });
      if (!opened.ok) throw new HttpError(503, "the ledger refused to open a seed account");
      const number = String(opened.body.accountNumber);
      await setLedgerStatus(number, "frozen");
      await q(
        `INSERT INTO app.accounts
           (account_number, owner_id, platform, account_type, mode, nickname,
            currency, leverage, status, created_at, archived_at, archived_reason)
         VALUES ($1,$2,'MT5',$3,'real',$4,'USD',200,'archived',
                 now() - ($5 || ' days')::interval,
                 now() - (($5::int - 30) || ' days')::interval,
                 'Archived automatically after 30 days of inactivity')`,
        [number, ownerId, seed.type, seed.nickname, String(seed.days)],
      );
    }

    return true;
  });
}

/**
 * Make the ledger and the client area agree about every account (INV-033).
 *
 * Two kinds of disagreement can exist on an install that predates this rule:
 *
 * - **Legacy records** — this service used to issue numbers from its own
 *   sequence, so a client-area record may name a number the ledger has never
 *   issued, or has issued *to somebody else*. Each is opened in the ledger under
 *   the mode it declared and re-keyed to the number the ledger gives it;
 *   archived ones are frozen there. Rows are first parked on negative numbers
 *   so re-keying can never collide with a legacy number not yet migrated.
 * - **Orphans** — ledger accounts opened through the old terminal path with no
 *   client-area record. Each gets one, under its ledger owner.
 *
 * Runs once at startup, across every owner: the one administrative write in
 * this file, and a migration rather than a request path.
 *
 * @returns {Promise<number>} how many records were migrated or adopted
 */
export async function reconcileLegacyAccounts() {
  const known = await forward(UPSTREAM.ledger, "/v1/accounts");
  if (!known.ok) throw new HttpError(503, "the ledger could not list its accounts");
  /** @type {Map<string, TradingAccount>} */
  const inLedger = new Map(
    (known.body.accounts ?? []).map((/** @type {TradingAccount} */ a) => [String(a.accountNumber), a]),
  );

  const rows = await adminQuery(
    "SELECT account_number, owner_id, mode, nickname, leverage, status FROM app.accounts WHERE account_number > 0",
  );
  const legacy = rows.rows.filter((row) => {
    const ledger = inLedger.get(String(row.account_number));
    return !ledger || ledger.owner !== row.owner_id;
  });

  for (const row of legacy) {
    await adminQuery(
      "UPDATE app.accounts SET account_number = -account_number WHERE account_number = $1",
      [row.account_number],
    );
    await adminQuery(
      "UPDATE app.funding_requests SET to_account = -to_account WHERE to_account = $1",
      [row.account_number],
    );
    await adminQuery(
      "UPDATE app.funding_requests SET from_account = -from_account WHERE from_account = $1",
      [row.account_number],
    );
  }

  for (const row of legacy) {
    const opened = await forward(UPSTREAM.ledger, "/v1/accounts", {
      method: "POST",
      body: {
        owner: row.owner_id,
        nickname: row.nickname,
        leverage: Number(row.leverage),
        mode: row.mode,
      },
    });
    if (!opened.ok) throw new HttpError(503, "the ledger refused to open a migrated account");
    const number = String(opened.body.accountNumber);
    if (row.status === "archived") await setLedgerStatus(number, "frozen");
    const parked = -Number(row.account_number);
    await adminQuery("UPDATE app.accounts SET account_number = $2 WHERE account_number = $1", [parked, number]);
    await adminQuery("UPDATE app.funding_requests SET to_account = $2 WHERE to_account = $1", [parked, number]);
    await adminQuery("UPDATE app.funding_requests SET from_account = $2 WHERE from_account = $1", [parked, number]);
  }

  // Orphans: the ledger knows an account the client area does not.
  const after = await adminQuery("SELECT account_number FROM app.accounts");
  const recorded = new Set(after.rows.map((row) => String(row.account_number)));
  let adopted = 0;
  for (const [number, ledger] of inLedger) {
    if (recorded.has(number)) continue;
    const archived = ledger.status !== "active";
    await adminQuery(
      `INSERT INTO app.accounts
         (account_number, owner_id, platform, account_type, mode, nickname, currency, leverage,
          status, archived_at, archived_reason)
       VALUES ($1, $2, 'MT5', 'Standard', $3, $4, 'USD', $5, $6, $7, $8)
       ON CONFLICT (account_number) DO NOTHING`,
      [
        number,
        ledger.owner,
        ledger.mode === "real" ? "real" : "demo",
        ledger.nickname || "Trading account",
        Math.min(2000, Math.max(1, Number(ledger.leverage) || 200)),
        archived ? "archived" : "active",
        archived ? new Date() : null,
        archived ? "Frozen in the ledger" : null,
      ],
    );
    adopted += 1;
  }
  return legacy.length + adopted;
}

/**
 * Put demo capital into a demo account.
 *
 * This is the one funding path that is live, and it is live because no payment
 * rail is involved: the ledger draws the amount from the demo capital pot and
 * settles it in the same journal as everything else (INV-034). A real account
 * never reaches this — it is refused here on the client-area record and again
 * in the ledger on the account's mode.
 *
 * @param {string} ownerId
 * @param {string} accountNumber
 * @param {string} amount Decimal string, already validated.
 * @param {string} idempotencyKey
 */
export async function demoDeposit(ownerId, accountNumber, amount, idempotencyKey) {
  const owned = await requireOwned(ownerId, accountNumber);
  if (owned.mode !== "demo") {
    throw new HttpError(422, "Only a demo account can be funded with demo capital.");
  }
  if (owned.status !== "active") {
    throw new HttpError(422, "Restore the account before funding it.");
  }

  const result = await forward(
    UPSTREAM.ledger,
    `/v1/accounts/${encodeURIComponent(accountNumber)}/demo-credit`,
    { method: "POST", idempotencyKey, body: { amount } },
  );
  if (!result.ok) throw refusal(result, "The ledger refused the demo credit.");

  const record = await recordFunding(ownerId, {
    kind: "deposit",
    method: "demo",
    amount,
    currency: "USD",
    toAccount: accountNumber,
    status: "settled",
    blockedReason: null,
  }, idempotencyKey);

  return {
    settled: true,
    replayed: Boolean(result.body.replayed),
    requestId: record.request_id,
    accountNumber,
    balance: result.body.balance ?? null,
    transactionId: result.body.transaction?.transactionId ?? null,
  };
}

/**
 * Reset a demo account to its opening grant (INV-035).
 * @param {string} ownerId
 * @param {string} accountNumber
 * @param {string} idempotencyKey
 */
export async function demoReset(ownerId, accountNumber, idempotencyKey) {
  const owned = await requireOwned(ownerId, accountNumber);
  if (owned.mode !== "demo") throw new HttpError(422, "Only a demo account can be reset.");
  const result = await forward(
    UPSTREAM.ledger,
    `/v1/accounts/${encodeURIComponent(accountNumber)}/demo-reset`,
    { method: "POST", idempotencyKey, body: {} },
  );
  if (!result.ok) throw refusal(result, "The ledger refused the reset.");
  return {
    reset: true,
    replayed: Boolean(result.body.replayed),
    accountNumber,
    balance: result.body.balance ?? null,
    changed: result.body.transaction !== null,
  };
}

/**
 * Write one funding row. Shared by intents (blocked) and demo credits (settled).
 * @param {string} ownerId
 * @param {{kind: string, method: string, amount: string, currency: string,
 *          fromAccount?: unknown, toAccount?: unknown, status: string,
 *          blockedReason: string|null}} row
 * @param {string} idempotencyKey
 */
async function recordFunding(ownerId, row, idempotencyKey) {
  const requestId = randomUUID();
  return asOwner(ownerId, async (q) => {
    const result = await q(
      `INSERT INTO app.funding_requests
         (request_id, owner_id, kind, method, amount_decimal, currency,
          from_account, to_account, status, blocked_reason, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (owner_id, idempotency_key) DO NOTHING
       RETURNING request_id, created_at`,
      [
        requestId,
        ownerId,
        row.kind,
        row.method,
        row.amount,
        row.currency,
        row.fromAccount ?? null,
        row.toAccount ?? null,
        row.status,
        row.blockedReason,
        idempotencyKey,
      ],
    );
    // ON CONFLICT DO NOTHING means a replay; return the original.
    if (result.rowCount === 0) {
      const original = await q(
        `SELECT request_id, created_at FROM app.funding_requests
          WHERE owner_id = $1 AND idempotency_key = $2`,
        [ownerId, idempotencyKey],
      );
      return { ...original.rows[0], replayed: true };
    }
    return { ...result.rows[0], replayed: false };
  });
}

/**
 * Record a funding intent. This is not money moving — it is a request that
 * cannot become a ledger effect until `17-payments` and `03-ledger` are gated.
 * @param {string} ownerId
 * @param {Record<string, unknown>} input
 * @param {string} idempotencyKey
 * @param {string} blockedReason
 */
export async function recordFundingIntent(ownerId, input, idempotencyKey, blockedReason) {
  return recordFunding(ownerId, {
    kind: String(input.kind),
    method: String(input.method),
    amount: String(input.amount),
    currency: String(input.currency),
    fromAccount: input.fromAccount,
    toAccount: input.toAccount,
    status: "blocked_by_gate",
    blockedReason,
  }, idempotencyKey);
}

/**
 * @param {string} ownerId
 */
export async function fundingHistory(ownerId) {
  const result = await asOwner(ownerId, (q) => q(
    `SELECT request_id, kind, method, amount_decimal, currency,
            from_account, to_account, status, blocked_reason, created_at
       FROM app.funding_requests
      WHERE owner_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [ownerId],
  ));
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    requestId: row.request_id,
    kind: row.kind,
    method: row.method,
    // Money stays a decimal string all the way out (P1).
    amount: row.amount_decimal,
    currency: row.currency,
    fromAccount: row.from_account ? String(row.from_account) : null,
    toAccount: row.to_account ? String(row.to_account) : null,
    status: row.status,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
  }));
}

/**
 * A trading account as `03-ledger` presents it.
 *
 * Distinct from {@link PresentedAccount}: that one is client-area metadata this
 * service stores, this one is the core's own record of an account that can
 * hold money. They are deliberately not merged — the moment they are one type,
 * something will put a balance on the edge's copy.
 *
 * @typedef {object} TradingAccount
 * @property {string} accountNumber
 * @property {string} owner
 * @property {string} nickname
 * @property {"demo"|"real"|string} mode
 * @property {string} currency
 * @property {number} leverage
 * @property {string} status
 * @property {number} openedTick
 * @property {number} openedMs
 */

/**
 * One open position, valued by `08-pnl-margin`.
 *
 * Every money field is a decimal string computed by the core. Nothing here is
 * ever arithmetic done at the edge (INV-180).
 *
 * @typedef {object} ValuedPosition
 * @property {string} symbol
 * @property {"BUY"|"SELL"|string} side
 * @property {string} volume
 * @property {number} digits
 * @property {string} openPrice
 * @property {string} mark
 * @property {string} unrealised
 * @property {string} margin
 * @property {number} openedTick
 * @property {number} openedMs
 */

/**
 * An account valued at a moment.
 *
 * `marginLevel` is `null` when nothing is open — absent, not zero and not a
 * large number that reads as safety (INV-072, INV-183).
 *
 * @typedef {object} Valuation
 * @property {string} balance
 * @property {string} equity
 * @property {string} unrealised
 * @property {string} usedMargin
 * @property {string} freeMargin
 * @property {string|null} marginLevel
 * @property {string} policyVersion
 * @property {ValuedPosition[]} positions
 */
