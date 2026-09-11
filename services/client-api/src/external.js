/**
 * # 21-external — the platform bridge and its reconciler
 *
 * An external trading platform (MT5) is a *client* of this broker, behind an
 * adapter. It is never the financial source of truth (INV-200), and its state
 * is compared with the core's continuously; where they disagree, a break is
 * raised (INV-201).
 *
 * ## What flows which way
 *
 * - **Core → platform (mirroring).** The mapped ledger account's net position
 *   per symbol is the target. Each cycle, the platform's net position is
 *   moved to match: excess or wrong-side positions are closed, the shortfall
 *   opened. Every action is recorded with the core's reason. Mirroring is
 *   reconciliation-driven and therefore idempotent: a cycle that finds the
 *   platform already matching does nothing.
 * - **Platform → core (platform-originated deals).** A deal the platform
 *   reports that this reconciler did not cause — someone trading in the
 *   terminal — is carried into the core **through the OMS**, as an ordinary
 *   order that risk may refuse. It is keyed by the platform's deal ticket, so
 *   it is applied exactly once (INV-122). There is no path from here to a
 *   ledger posting: this module reads the ledger and writes only to the OMS.
 *
 * ## What it must never do
 *
 * Copy a platform balance into the core, or treat the platform's P&L as the
 * client's. Those are the platform's own bookkeeping. INV-200 is enforced by a
 * test that this file names no ledger write.
 */

import { forward, UPSTREAM } from "./core.js";
import { adminQuery } from "./db.js";

export const PLATFORM = "mt5";
/** Comment prefix that marks a platform order as one this reconciler placed. */
export const MIRROR_TAG = "px:";
/** How often the reconciler runs. */
export const CYCLE_MS = Number(process.env.EXTERNAL_CYCLE_MS ?? 5_000);
/** How long the bridge may be unreachable before that is a break. */
export const BRIDGE_DOWN_BREAK_MS = 60_000;

const BRIDGE_URL = process.env.MT5_BRIDGE_URL ?? "http://mt5-sim:8000";

/**
 * @typedef {object} BridgeState
 * @property {"unreachable"|"unconfigured"|"connecting"|"connected"|"degraded"} state
 * @property {string} [server]
 * @property {string} [login]
 * @property {boolean} [simulated]
 * @property {string} [detail]
 * @property {number} [lastTickMs]
 */

/**
 * @typedef {object} Mapping
 * @property {string} platformLogin
 * @property {string} ledgerAccount
 * @property {string} mappedBy
 * @property {string} createdAt
 */

/**
 * @typedef {object} Reconciler
 * @property {() => Promise<void>} cycle
 * @property {() => Promise<Record<string, unknown>>} status
 * @property {() => void} stop
 */

/**
 * Net position per symbol as signed thousandths of a lot: BUY positive.
 * @param {{symbol: string, side: string, volume: string}[]} positions
 */
export function netByLots(positions) {
  /** @type {Map<string, bigint>} */
  const net = new Map();
  for (const position of positions) {
    const milli = toMilli(position.volume);
    const signed = position.side === "BUY" ? milli : -milli;
    net.set(position.symbol, (net.get(position.symbol) ?? 0n) + signed);
  }
  return net;
}

/** @param {string} lots Decimal string, up to three places. */
export function toMilli(lots) {
  const [whole = "0", frac = ""] = lots.split(".");
  return BigInt(whole) * 1000n + BigInt((frac + "000").slice(0, 3));
}

/** @param {bigint} milli */
export function fromMilli(milli) {
  const abs = milli < 0n ? -milli : milli;
  const s = abs.toString().padStart(4, "0");
  return `${s.slice(0, -3)}.${s.slice(-3)}`;
}

/**
 * The platform's positions as the same shape the ledger uses.
 * @param {{symbol: string, type: string, volume: string}[]} positions
 */
export function platformNet(positions) {
  return netByLots(positions.map((p) => ({ symbol: p.symbol, side: p.type, volume: p.volume })));
}

/**
 * What must happen on the platform for its net to equal the core's, per
 * symbol. Pure, so the decision is testable without a bridge.
 *
 * @param {Map<string, bigint>} ledger
 * @param {{ticket: number, symbol: string, type: string, volume: string}[]} platformPositions
 * @returns {{closes: {ticket: number, symbol: string}[], opens: {symbol: string, side: "BUY"|"SELL", volume: string}[], diverged: {symbol: string, ledger: string, platform: string}[]}}
 */
export function plan(ledger, platformPositions) {
  const platform = platformNet(platformPositions);
  const symbols = new Set([...ledger.keys(), ...platform.keys()]);
  /** @type {{ticket: number, symbol: string}[]} */
  const closes = [];
  /** @type {{symbol: string, side: "BUY"|"SELL", volume: string}[]} */
  const opens = [];
  /** @type {{symbol: string, ledger: string, platform: string}[]} */
  const diverged = [];
  for (const symbol of symbols) {
    const want = ledger.get(symbol) ?? 0n;
    const have = platform.get(symbol) ?? 0n;
    if (want === have) continue;
    diverged.push({ symbol, ledger: fromMilli(want), platform: fromMilli(have) });
    const wrongSide = want === 0n || (want > 0n) !== (have > 0n);
    if (wrongSide && have !== 0n) {
      // Everything on the platform in this symbol goes, then the target is
      // opened cleanly. Hedged books make partial adjustments ambiguous.
      for (const p of platformPositions) if (p.symbol === symbol) closes.push({ ticket: p.ticket, symbol });
      if (want !== 0n) opens.push({ symbol, side: want > 0n ? "BUY" : "SELL", volume: fromMilli(want) });
      continue;
    }
    const delta = want - have;
    if ((want > 0n && delta > 0n) || (want < 0n && delta < 0n)) {
      opens.push({ symbol, side: delta > 0n ? "BUY" : "SELL", volume: fromMilli(delta) });
    } else {
      // Same side, platform holds more: reduce by closing positions until
      // the excess is covered. Closing whole positions may overshoot; the
      // next cycle opens the remainder.
      let excess = have - want;
      for (const p of platformPositions) {
        if (p.symbol !== symbol) continue;
        if ((excess > 0n && p.type === "BUY") || (excess < 0n && p.type === "SELL")) {
          closes.push({ ticket: p.ticket, symbol });
          const size = toMilli(p.volume);
          excess = excess > 0n ? excess - size : excess + size;
          if (excess === 0n || (excess > 0n) !== (have > 0n)) break;
        }
      }
    }
  }
  return { closes, opens, diverged };
}

/**
 * Talk to the bridge.
 * @param {string} path
 * @param {{method?: string, body?: unknown}} [options]
 */
async function bridge(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${BRIDGE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<Mapping|null>} */
export async function mapping() {
  const result = await adminQuery(
    "SELECT platform_login, ledger_account, mapped_by, created_at FROM app.external_accounts WHERE platform = $1 LIMIT 1",
    [PLATFORM],
  );
  const row = result.rows[0];
  return row
    ? { platformLogin: row.platform_login, ledgerAccount: String(row.ledger_account), mappedBy: row.mapped_by, createdAt: row.created_at }
    : null;
}

/**
 * Map the bridge's login to a ledger account (operator action).
 * @param {string} ledgerAccount
 * @param {string} operator
 */
export async function map(ledgerAccount, operator) {
  const state = await bridge("/v1/state").catch(() => null);
  const login = String(state?.body?.login ?? "unknown");
  const exists = await forward(UPSTREAM.ledger, `/v1/accounts/${encodeURIComponent(ledgerAccount)}`);
  if (!exists.ok) throw new Error(`no ledger account ${ledgerAccount}`);
  await adminQuery("DELETE FROM app.external_accounts WHERE platform = $1", [PLATFORM]);
  await adminQuery(
    "INSERT INTO app.external_accounts (platform, platform_login, ledger_account, mapped_by) VALUES ($1, $2, $3, $4)",
    [PLATFORM, login, ledgerAccount, operator],
  );
  return mapping();
}

export async function unmap() {
  await adminQuery("DELETE FROM app.external_accounts WHERE platform = $1", [PLATFORM]);
}

/**
 * @param {string} kind
 * @param {string|null} symbol
 * @param {string|null} ledgerValue
 * @param {string|null} platformValue
 * @param {string} detail
 */
async function openBreak(kind, symbol, ledgerValue, platformValue, detail) {
  const open = await adminQuery(
    "SELECT break_id FROM app.external_breaks WHERE platform = $1 AND kind = $2 AND symbol IS NOT DISTINCT FROM $3 AND resolved_at IS NULL",
    [PLATFORM, kind, symbol],
  );
  if (open.rowCount) {
    await adminQuery(
      "UPDATE app.external_breaks SET ledger_value = $2, platform_value = $3, detail = $4 WHERE break_id = $1",
      [open.rows[0].break_id, ledgerValue, platformValue, detail],
    );
    return;
  }
  await adminQuery(
    "INSERT INTO app.external_breaks (platform, kind, symbol, ledger_value, platform_value, detail) VALUES ($1,$2,$3,$4,$5,$6)",
    [PLATFORM, kind, symbol, ledgerValue, platformValue, detail],
  );
}

/**
 * @param {string} kind
 * @param {string|null} [symbol] Null resolves every open break of the kind.
 */
async function resolveBreaks(kind, symbol = null) {
  await adminQuery(
    `UPDATE app.external_breaks SET resolved_at = now()
      WHERE platform = $1 AND kind = $2 AND resolved_at IS NULL AND ($3::text IS NULL OR symbol = $3)`,
    [PLATFORM, kind, symbol],
  );
}

/**
 * @param {{ledgerAccount: string, symbol: string, kind: string, side: string, volume: string, reference: string, outcome: string, detail?: string|null}} action
 */
async function recordAction(action) {
  await adminQuery(
    `INSERT INTO app.external_actions (platform, ledger_account, symbol, kind, side, volume, reference, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [PLATFORM, action.ledgerAccount, action.symbol, action.kind, action.side, action.volume, action.reference, action.outcome, action.detail ?? null],
  );
}

/**
 * Build the reconciler. It holds its own timer and a little state; the
 * durable state is in the tables above.
 *
 * @param {{log: (level: string, message: string, fields?: Record<string, unknown>) => void}} deps
 * @returns {Reconciler}
 */
export function createReconciler({ log }) {
  /** @type {BridgeState} */
  let bridgeState = { state: "unreachable", detail: "not yet polled" };
  let unreachableSince = 0;
  let lastCycleAt = 0;
  let lastError = "";
  const counters = { cycles: 0, mirrorOpens: 0, mirrorCloses: 0, platformDeals: 0, breaksOpened: 0 };
  let running = false;

  async function pollBridge() {
    try {
      const result = await bridge("/v1/state");
      if (!result.ok) throw new Error(`bridge returned ${result.status}`);
      bridgeState = result.body;
      unreachableSince = 0;
      await resolveBreaks("bridge_unreachable");
    } catch (error) {
      if (unreachableSince === 0) unreachableSince = Date.now();
      bridgeState = { state: "unreachable", detail: String(error) };
      if (Date.now() - unreachableSince > BRIDGE_DOWN_BREAK_MS) {
        await openBreak("bridge_unreachable", null, null, null, `bridge unreachable since ${new Date(unreachableSince).toISOString()}: ${String(error)}`);
      }
    }
  }

  /** @param {Mapping} mapped */
  async function mirror(mapped) {
    const state = await forward(UPSTREAM.ledger, `/v1/accounts/${encodeURIComponent(mapped.ledgerAccount)}/state`);
    if (!state.ok) throw new Error(`ledger state ${state.status}`);
    const ledger = netByLots(state.body.valuation?.positions ?? []);
    const positions = await bridge("/v1/positions");
    if (!positions.ok) throw new Error(`bridge positions ${positions.status}`);
    /** @type {{ticket: number, symbol: string, type: string, volume: string, comment?: string}[]} */
    const platformPositions = positions.body;
    const { closes, opens, diverged } = plan(ledger, platformPositions);

    for (const close of closes) {
      const result = await bridge("/v1/positions/close", { method: "POST", body: { ticket: close.ticket } });
      counters.mirrorCloses += 1;
      await recordAction({
        ledgerAccount: mapped.ledgerAccount, symbol: close.symbol, kind: "mirror_close", side: "SELL",
        volume: "0.000", reference: `ticket:${close.ticket}`,
        outcome: result.ok ? "done" : "refused", detail: result.ok ? null : JSON.stringify(result.body).slice(0, 200),
      });
    }
    for (const open of opens) {
      const reference = `${MIRROR_TAG}${mapped.ledgerAccount}:${Date.now()}`;
      const result = await bridge("/v1/orders", { method: "POST", body: { symbol: open.symbol, type: open.side, volume: open.volume, comment: reference } });
      counters.mirrorOpens += 1;
      await recordAction({
        ledgerAccount: mapped.ledgerAccount, symbol: open.symbol, kind: "mirror_open", side: open.side,
        volume: open.volume, reference, outcome: result.ok ? "done" : "refused",
        detail: result.ok ? `deal ${result.body.deal}` : JSON.stringify(result.body).slice(0, 200),
      });
    }

    // Divergence that survives a mirroring attempt is a break (INV-201); one
    // that this cycle repaired is resolved. Checked against a fresh read so
    // the record reflects the platform as it is, not as it was asked to be.
    const after = await bridge("/v1/positions");
    const remaining = after.ok ? plan(ledger, after.body).diverged : diverged;
    const remainingSymbols = new Set(remaining.map((d) => d.symbol));
    for (const d of remaining) {
      counters.breaksOpened += 1;
      await openBreak("position_mismatch", d.symbol, d.ledger, d.platform, `net lots differ after mirroring`);
    }
    for (const d of diverged) {
      if (!remainingSymbols.has(d.symbol)) await resolveBreaks("position_mismatch", d.symbol);
    }
    if (remaining.length === 0) await resolveBreaks("position_mismatch");
    return { closes: closes.length, opens: opens.length, remaining: remaining.length };
  }

  /** @param {Mapping} mapped */
  async function carryPlatformDeals(mapped) {
    const last = await adminQuery("SELECT coalesce(max(ticket), 0) AS t FROM app.external_deals WHERE platform = $1", [PLATFORM]);
    const since = Number(last.rows[0]?.t ?? 0);
    const deals = await bridge(`/v1/deals?since=${since}`);
    if (!deals.ok) throw new Error(`bridge deals ${deals.status}`);
    /** @type {{ticket: number, symbol: string, type: string, entry: string, volume: string, comment: string}[]} */
    const rows = deals.body;
    for (const deal of rows) {
      // Ours: placed by this reconciler. Recorded as seen, not re-applied.
      if (String(deal.comment ?? "").startsWith(MIRROR_TAG)) {
        await adminQuery(
          "INSERT INTO app.external_deals (platform, ticket, ledger_account, order_id, outcome) VALUES ($1,$2,$3,NULL,'mirror') ON CONFLICT DO NOTHING",
          [PLATFORM, deal.ticket, mapped.ledgerAccount],
        );
        continue;
      }
      // Theirs: through the front door, keyed by the ticket (INV-122).
      const side = deal.type === "BUY" ? "BUY" : "SELL";
      const result = await forward(UPSTREAM.oms, "/v1/orders", {
        method: "POST",
        idempotencyKey: `mt5-deal-${deal.ticket}`,
        body: { account: mapped.ledgerAccount, symbol: deal.symbol, side, volume: deal.volume },
      });
      const outcome = result.ok ? String(result.body.state ?? "SETTLED") : `refused:${result.body.error ?? result.status}`;
      counters.platformDeals += 1;
      await adminQuery(
        "INSERT INTO app.external_deals (platform, ticket, ledger_account, order_id, outcome) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [PLATFORM, deal.ticket, mapped.ledgerAccount, result.body.clientOrderId ?? null, outcome],
      );
      await recordAction({
        ledgerAccount: mapped.ledgerAccount, symbol: deal.symbol, kind: "platform_deal", side, volume: deal.volume,
        reference: `ticket:${deal.ticket}`, outcome, detail: result.ok ? null : String(result.body.detail ?? ""),
      });
      log(result.ok ? "info" : "warn", "platform-originated deal carried into the core", { ticket: deal.ticket, symbol: deal.symbol, side, volume: deal.volume, outcome });
    }
  }

  async function cycle() {
    if (running) return;
    running = true;
    counters.cycles += 1;
    try {
      await pollBridge();
      if (bridgeState.state !== "connected") return;
      const mapped = await mapping();
      if (!mapped) return;
      await carryPlatformDeals(mapped);
      await mirror(mapped);
      lastError = "";
    } catch (error) {
      lastError = String(error);
      log("warn", "reconciliation cycle failed", { detail: lastError });
    } finally {
      lastCycleAt = Date.now();
      running = false;
    }
  }

  const timer = setInterval(() => void cycle(), CYCLE_MS);
  timer.unref?.();

  return {
    cycle,
    stop: () => clearInterval(timer),
    async status() {
      const [mapped, breaks, actions, deals] = await Promise.all([
        mapping(),
        adminQuery("SELECT break_id, kind, symbol, ledger_value, platform_value, detail, opened_at, resolved_at FROM app.external_breaks WHERE platform = $1 ORDER BY opened_at DESC LIMIT 50", [PLATFORM]),
        adminQuery("SELECT action_id, ledger_account, symbol, kind, side, volume, reference, outcome, detail, at FROM app.external_actions WHERE platform = $1 ORDER BY action_id DESC LIMIT 50", [PLATFORM]),
        adminQuery("SELECT count(*)::int AS n FROM app.external_deals WHERE platform = $1", [PLATFORM]),
      ]);
      return {
        platform: PLATFORM,
        bridgeUrl: BRIDGE_URL,
        bridge: bridgeState,
        mapping: mapped,
        breaks: breaks.rows,
        openBreaks: breaks.rows.filter((b) => !b.resolved_at).length,
        actions: actions.rows,
        dealsCarried: deals.rows[0]?.n ?? 0,
        counters,
        lastCycleAt: lastCycleAt ? new Date(lastCycleAt).toISOString() : null,
        lastError: lastError || null,
        cycleMs: CYCLE_MS,
      };
    },
  };
}
