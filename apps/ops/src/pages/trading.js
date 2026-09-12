/**
 * The trading pages: the feed, the whole ledger, every order, live telemetry
 * and the platform bridge.
 *
 * Every figure on these pages is a string the core returned. The console
 * computes nothing about money (INV-180) — where it adds up a count, it is
 * counting rows, never amounts.
 */

import { ago, badge, esc, icon, kpi, table, unavailable } from "../ui/layout.js";

/** The sources the feed knows, for the reorder form. */
const SOURCES = ["synthetic", "binance", "twelvedata", "finnhub", "mt5", "sim-lp"];

/* ------------------------------------------------------------------- feed */

/**
 * @param {{feed: any, csrf: string, error: string|null, done?: string, fail?: string}} data
 */
export function feedPage({ feed, csrf, error, done = "", fail = "" }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Market feed</h1>
      <p class="muted small">Where every price comes from, per instrument class, and how each provider is doing. The pure synthetic function is the floor; a real source takes over the moment it speaks (INV-052, INV-054).</p>
    </div>
  </div>`;
  if (error) return `${head}${unavailable("The feed", error)}`;
  const md = feed.marketData;
  const gw = feed.gateway;

  const notice = done
    ? `<div class="notice notice-positive"><span class="notice-icon">${icon.check(16)}</span><div class="notice-body"><div class="notice-title">Source order changed for ${esc(done)}</div><div class="notice-text">Logged to the feed record; the gateway picks it up within five seconds.</div></div></div>`
    : fail
      ? `<div class="notice notice-warning"><span class="notice-icon">${icon.alert(16)}</span><div class="notice-body"><div class="notice-title">Not changed</div><div class="notice-text">${esc(fail)}</div></div></div>`
      : "";

  const instrumentRows = (md?.instruments ?? []).map((/** @type {any} */ i) => `<tr>
    <td class="mono small">${esc(i.symbol)}</td>
    <td class="small muted">${esc(i.class)}</td>
    <td>${i.mode === "recorded" ? badge(`recorded · ${i.source}`, "positive") : badge("synthetic", "accent")}</td>
    <td>${i.session?.open ? badge("open", "positive") : badge("closed", "warning")}</td>
    <td class="num small mono">${esc(String(i.recordedQuotes ?? 0))}</td>
    <td class="num small muted">${i.recordedAgeMs === null || i.recordedAgeMs === undefined ? "—" : esc(`${i.recordedAgeMs} ms`)}</td>
    <td class="small mono muted">${esc((i.sources ?? []).join(" → "))}</td>
  </tr>`);

  const adapterRows = Object.entries(gw?.adapters ?? {}).map(([name, a]) => {
    const state = String(/** @type {any} */ (a).state);
    const tone = state === "connected" ? "positive" : state === "unconfigured" || state === "idle" ? "" : state === "circuit-open" ? "danger" : "warning";
    const ad = /** @type {any} */ (a);
    return `<tr>
      <td class="mono small">${esc(name)}</td>
      <td>${badge(state, /** @type {any} */ (tone))}</td>
      <td class="small mono muted">${esc((ad.symbols ?? []).join(", ") || "—")}</td>
      <td class="num small mono">${esc(String(ad.ticksPerSecond ?? "0"))}/s</td>
      <td class="num small muted">${ad.lastTickMs ? esc(ago(new Date(ad.lastTickMs).toISOString())) : "never"}</td>
      <td class="num small muted">${esc(String(ad.errors ?? 0))}</td>
      <td class="small muted truncate" title="${esc(ad.detail ?? "")}">${esc(ad.detail ?? "")}</td>
    </tr>`;
  });

  const classForms = Object.entries(md?.classes ?? {}).map(([cls, sources]) => `
    <form method="post" action="/feed/source" class="row">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="class" value="${esc(cls)}">
      <div class="row-main">
        <div class="row-label">${esc(cls)}</div>
        <div class="row-detail">Sources in order of preference; <span class="mono">synthetic</span> last means the pure function is the fallback. Known: ${esc(SOURCES.join(", "))}.</div>
      </div>
      <input class="input mono" name="sources" value="${esc(/** @type {string[]} */ (sources).join(","))}" style="width:320px">
      <button class="btn btn-sm" type="submit">Apply</button>
    </form>`).join("");

  return `${head}${notice}
  <div class="grid grid-4">
    ${kpi({ label: "Recorded quotes", value: md?.recorded ?? 0, note: `state hash ${md?.stateHash ?? "—"}` })}
    ${kpi({ label: "Out of order", value: md?.outOfOrder ?? 0, note: "kept, and counted" })}
    ${kpi({ label: "Refused at the door", value: md?.refused ?? 0, note: "INV-050", ...(md?.refused ? { tone: /** @type {const} */ ("warning") } : {}) })}
    ${kpi({ label: "Gateway failovers", value: gw?.counters?.failovers ?? 0, note: gw ? `${gw.counters?.forwarded ?? 0} forwarded · ${gw.counters?.dropped ?? 0} dropped` : "gateway unreachable" })}
  </div>

  <div class="section card">
    <div class="card-head"><h2 class="h2 grow">Instruments</h2><span class="micro muted">${esc(md ? `tick ${md.tick}` : "")}</span></div>
    ${table({ columns: [{ label: "Symbol" }, { label: "Class" }, { label: "Priced from" }, { label: "Session" }, { label: "Recorded", align: "num" }, { label: "Age", align: "num" }, { label: "Order" }], rows: instrumentRows, empty: feed.marketDataError ?? "market-data returned no instruments." })}
  </div>

  <div class="section card">
    <div class="card-head"><h2 class="h2 grow">Providers</h2><span class="micro muted">${gw ? `selected: ${esc(Object.entries(gw.selected ?? {}).map(([s, p]) => `${s}←${p}`).join("  ") || "none")}` : ""}</span></div>
    ${table({ columns: [{ label: "Adapter" }, { label: "State" }, { label: "Symbols" }, { label: "Rate", align: "num" }, { label: "Last tick", align: "num" }, { label: "Errors", align: "num" }, { label: "Detail" }], rows: adapterRows, empty: feed.gatewayError ?? "the gateway reported no adapters." })}
  </div>

  <div class="section card">
    <div class="card-head"><h2 class="h2 grow">Source order</h2><span class="micro muted">Written to the feed record; replay reproduces it</span></div>
    ${classForms || '<div class="table-empty small">No classes reported.</div>'}
  </div>`;
}

/* ----------------------------------------------------------------- ledger */

/**
 * @param {{balances: any, invariants: any, journal: any, error: string|null, kind: string, after: string}} data
 */
export function ledgerPage({ balances, invariants, journal, error, kind, after }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">The ledger</h1>
      <p class="muted small">Every account in the chart of accounts with its balance, and the journal that produced them. Positive is a debit balance, negative a credit balance; each currency sums to zero or the ledger is broken (INV-020).</p>
    </div>
  </div>`;
  if (error) return `${head}${unavailable("The ledger", error)}`;

  const balanceRows = (balances?.balances ?? []).map((/** @type {any} */ b) => `<tr>
    <td class="mono small">${esc(b.account)}</td>
    <td class="small muted">${esc(b.currency)}</td>
    <td class="num mono small${String(b.signed).startsWith("-") ? " is-negative" : ""}">${esc(b.signed)}</td>
  </tr>`);

  const kinds = ["", "DEMO_CREDIT", "DEPOSIT", "WITHDRAWAL", "REALISED_PNL", "FEE", "CORRECTION"];
  const rows = (journal?.transactions ?? []).map((/** @type {any} */ t) => `<tr>
    <td class="num mono small muted">${esc(String(t.sequence))}</td>
    <td>${badge(t.kind, t.kind === "CORRECTION" ? "warning" : "")}</td>
    <td class="mono small">${t.subject ? `<a class="row-link" href="/orders?account=${esc(t.subject)}">${esc(t.subject)}</a>` : "—"}</td>
    <td class="small mono">${(t.entries ?? []).map((/** @type {any} */ e) => `<div>${esc(e.account)} <span class="${String(e.amount).startsWith("-") ? "is-negative" : ""}">${esc(e.amount)}</span> ${esc(e.currency)}</div>`).join("")}</td>
  </tr>`);
  const last = journal?.transactions?.at(-1)?.sequence;
  const healthy = invariants?.healthy;

  return `${head}
  <div class="grid grid-4">
    ${kpi({ label: "Transactions", value: balances?.version ?? journal?.total ?? 0 })}
    ${kpi({ label: "Trial balance", value: balances?.balanced ? "balanced" : "IMBALANCED", tone: balances?.balanced ? "positive" : "danger", note: "INV-020" })}
    ${kpi({ label: "Projection drift", value: invariants ? String(invariants["INV-023_projection_drift"] ?? "—") : "—", tone: invariants && invariants["INV-023_projection_drift"] === 0 ? "positive" : "danger", note: "INV-023" })}
    ${kpi({ label: "Invariants", value: healthy === undefined ? "—" : healthy ? "healthy" : "BROKEN", tone: healthy ? "positive" : "danger" })}
  </div>

  <div class="section split">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Trial balance</h2><span class="micro muted">${esc(String((balances?.balances ?? []).length))} accounts</span></div>
      ${table({ columns: [{ label: "Account" }, { label: "Ccy" }, { label: "Signed balance", align: "num" }], rows: balanceRows, empty: "The ledger holds no balances." })}
    </div>
    <div class="card">
      <div class="card-head">
        <h2 class="h2 grow">Journal</h2>
        <form method="get" action="/ledger" class="inline">
          <select class="select" name="kind" onchange="this.form.submit()">
            ${kinds.map((k) => `<option value="${esc(k)}"${k === kind ? " selected" : ""}>${k || "All kinds"}</option>`).join("")}
          </select>
          ${after ? `<input type="hidden" name="after" value="${esc(after)}">` : ""}
        </form>
      </div>
      ${table({ columns: [{ label: "#", align: "num" }, { label: "Kind" }, { label: "Subject" }, { label: "Entries" }], rows, empty: "No transactions in this window." })}
      <div class="card-foot">
        ${after ? `<a class="btn btn-sm" href="/ledger?kind=${esc(kind)}">First page</a>` : ""}
        ${rows.length >= 100 && last !== undefined ? `<a class="btn btn-sm" href="/ledger?kind=${esc(kind)}&after=${esc(String(last))}">Older →</a>` : ""}
      </div>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- orders */

/**
 * @param {{orders: any[], account: string, error: string|null}} data
 */
export function ordersPage({ orders, account, error }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Order book</h1>
      <p class="muted small">Every order across every client, newest first, filled or refused with the rule that refused it (INV-082). Refreshes every ten seconds.</p>
    </div>
    <form method="get" action="/orders" class="inline">
      <input class="input mono" name="account" placeholder="account number" value="${esc(account)}" style="width:180px">
      <button class="btn btn-sm" type="submit">Filter</button>
    </form>
  </div>`;
  if (error) return `${head}${unavailable("Orders", error)}`;
  const shown = account ? orders.filter((o) => String(o.account) === account) : orders;
  const filled = shown.filter((o) => o.state === "FILLED").length;
  const rows = shown.map((o) => `<tr>
    <td class="num small muted">${esc(ago(new Date(o.timestampMs).toISOString()))}</td>
    <td class="small">${o.owner && String(o.owner).includes("-") ? `<a class="row-link" href="/users/${esc(o.owner)}">${esc(String(o.owner).slice(0, 8))}…</a>` : `<span class="muted">${esc(o.owner ?? "—")}</span>`}</td>
    <td class="mono small"><a class="row-link" href="/orders?account=${esc(o.account)}">${esc(o.account)}</a>${o.mode === "demo" ? ` ${badge("demo", "accent")}` : ""}</td>
    <td class="mono small">${esc(o.symbol)}</td>
    <td>${badge(o.side, o.side === "BUY" ? "positive" : "danger")}</td>
    <td class="num mono small">${esc(o.volume)}</td>
    <td class="num mono small">${o.deal ? esc(o.deal.price) : "—"}</td>
    <td class="num mono small${o.deal && String(o.deal.realised).startsWith("-") ? " is-negative" : ""}">${o.deal ? esc(o.deal.realised) : "—"}</td>
    <td>${o.state === "FILLED" ? badge("filled", "positive") : badge(o.rejection?.code ?? "rejected", "warning")}</td>
  </tr>`);
  return `${head}
  <div class="grid grid-3">
    ${kpi({ label: "Orders shown", value: shown.length })}
    ${kpi({ label: "Filled", value: filled })}
    ${kpi({ label: "Refused", value: shown.length - filled, note: "recorded decisions, not discarded" })}
  </div>
  <div class="section card">
    ${table({ columns: [{ label: "When", align: "num" }, { label: "Owner" }, { label: "Account" }, { label: "Symbol" }, { label: "Side" }, { label: "Volume", align: "num" }, { label: "Price", align: "num" }, { label: "Realised", align: "num" }, { label: "Outcome" }], rows, empty: "No orders have been placed." })}
  </div>`;
}

/* -------------------------------------------------------------- telemetry */

/**
 * The live page. Rendered once with a snapshot; console.js then keeps it
 * current from the event stream at /telemetry/stream.
 * @param {{telemetry: any, error: string|null}} data
 */
export function telemetryPage({ telemetry, error }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Live telemetry</h1>
      <p class="muted small">What each identity is doing at the edge, second by second, with their accounts valued by the ledger as it happens. Held in memory, served only here — never a metric label.</p>
    </div>
    <span class="micro muted" data-telemetry-state>snapshot</span>
  </div>`;
  if (error) return `${head}${unavailable("Telemetry", error)}`;
  return `${head}
  <div class="grid grid-3" data-telemetry-kpis>
    ${kpi({ label: "Active identities", value: telemetry.users.length, note: `${telemetry.tracked} tracked` })}
    ${kpi({ label: "Requests / min", value: telemetry.users.reduce((/** @type {number} */ n, /** @type {any} */ u) => n + u.requestsPerMinute, 0) })}
    ${kpi({ label: "Orders / min", value: telemetry.users.reduce((/** @type {number} */ n, /** @type {any} */ u) => n + u.ordersPerMinute, 0) })}
  </div>
  <div class="section card" data-telemetry>
    ${telemetryTable(telemetry)}
  </div>`;
}

/** @param {any} telemetry */
export function telemetryTable(telemetry) {
  const rows = (telemetry.users ?? []).map((/** @type {any} */ u) => `<tr>
    <td class="small">${u.authenticated && String(u.owner).includes("-") ? `<a class="row-link" href="/users/${esc(u.owner)}">${esc(String(u.owner).slice(0, 8))}…</a>` : `<span class="muted mono">${esc(u.owner)}</span>`}</td>
    <td class="num mono small">${esc(String(u.requestsPerMinute))}</td>
    <td class="num mono small${u.errorsPerMinute ? " is-negative" : ""}">${esc(String(u.errorsPerMinute))}</td>
    <td class="num mono small${u.throttledPerMinute ? " is-negative" : ""}">${esc(String(u.throttledPerMinute))}</td>
    <td class="num mono small">${esc(String(u.ordersPerMinute))} <span class="muted">/ ${esc(String(u.orders))}</span></td>
    <td class="num mono small">${esc(String(u.meanMs))}<span class="muted"> ms</span></td>
    <td class="small mono truncate" title="${esc(u.lastPath)}">${esc(u.lastPath)} <span class="muted">${esc(String(u.lastStatus))}</span></td>
    <td class="small">${(u.accounts ?? []).map((/** @type {any} */ a) => `<div class="mono">${esc(a.accountNumber)} <span class="muted">eq</span> ${esc(a.equity ?? "—")} <span class="muted">ml</span> ${esc(a.marginLevel ?? "—")}${a.openPositions ? ` <span class="muted">(${esc(String(a.openPositions))} open)</span>` : ""}</div>`).join("") || '<span class="muted">—</span>'}</td>
    <td class="num small muted">${esc(ago(u.lastSeen))}</td>
  </tr>`);
  return table({
    columns: [{ label: "Identity" }, { label: "req/min", align: "num" }, { label: "5xx/min", align: "num" }, { label: "429/min", align: "num" }, { label: "orders/min · total", align: "num" }, { label: "mean", align: "num" }, { label: "Last request" }, { label: "Accounts (ledger, live)" }, { label: "Seen", align: "num" }],
    rows,
    empty: "Nobody has touched the edge in the last fifteen minutes.",
  });
}

/* ----------------------------------------------------------------- bridge */

/**
 * @param {{external: any, csrf: string, error: string|null, done?: string, fail?: string}} data
 */
export function bridgePage({ external, csrf, error, done = "", fail = "" }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Platform bridge</h1>
      <p class="muted small">MT5 as a client of the broker, behind an adapter. Never the source of truth (INV-200); reconciled every cycle, divergence is a break (INV-201).</p>
    </div>
  </div>`;
  if (error) return `${head}${unavailable("The bridge", error)}`;
  const b = external.bridge ?? {};
  const tone = b.state === "connected" ? "positive" : b.state === "unconfigured" ? "" : b.state === "unreachable" ? "danger" : "warning";
  const notice = done
    ? `<div class="notice notice-positive"><span class="notice-icon">${icon.check(16)}</span><div class="notice-body"><div class="notice-title">${esc(done)}</div></div></div>`
    : fail ? `<div class="notice notice-warning"><span class="notice-icon">${icon.alert(16)}</span><div class="notice-body"><div class="notice-title">Not done</div><div class="notice-text">${esc(fail)}</div></div></div>` : "";

  const breakRows = (external.breaks ?? []).map((/** @type {any} */ k) => `<tr>
    <td>${k.resolved_at ? badge("resolved", "positive") : badge("open", "danger")}</td>
    <td class="small">${esc(k.kind)}</td>
    <td class="mono small">${esc(k.symbol ?? "—")}</td>
    <td class="num mono small">${esc(k.ledger_value ?? "—")}</td>
    <td class="num mono small">${esc(k.platform_value ?? "—")}</td>
    <td class="small muted truncate" title="${esc(k.detail ?? "")}">${esc(k.detail ?? "")}</td>
    <td class="num small muted">${esc(ago(k.opened_at))}</td>
  </tr>`);
  const actionRows = (external.actions ?? []).map((/** @type {any} */ a) => `<tr>
    <td class="num small muted">${esc(ago(a.at))}</td>
    <td>${badge(a.kind.replace("_", " "), a.kind === "platform_deal" ? "accent" : "")}</td>
    <td class="mono small">${esc(a.ledger_account)}</td>
    <td class="mono small">${esc(a.symbol)}</td>
    <td>${badge(a.side, a.side === "BUY" ? "positive" : "danger")}</td>
    <td class="num mono small">${esc(a.volume)}</td>
    <td>${a.outcome === "done" || a.outcome === "SETTLED" ? badge(a.outcome, "positive") : badge(a.outcome, "warning")}</td>
    <td class="small muted mono truncate" title="${esc(a.reference)}">${esc(a.detail ?? a.reference)}</td>
  </tr>`);

  return `${head}${notice}
  <div class="grid grid-4">
    ${kpi({ label: "Bridge", value: b.state ?? "unknown", tone: /** @type {any} */ (tone), note: b.simulated ? "simulated terminal" : (b.server ? `${b.server} · ${b.login}` : b.detail ?? "") })}
    ${kpi({ label: "Mapped account", value: external.mapping?.ledgerAccount ?? "none", note: external.mapping ? `login ${external.mapping.platformLogin}` : "mirroring is off" })}
    ${kpi({ label: "Open breaks", value: external.openBreaks ?? 0, tone: external.openBreaks ? "danger" : "positive", note: "INV-201" })}
    ${kpi({ label: "Cycles", value: external.counters?.cycles ?? 0, note: external.lastError ? `last error: ${external.lastError}` : `every ${Math.round((external.cycleMs ?? 5000) / 1000)}s · last ${ago(external.lastCycleAt)}` })}
  </div>

  <div class="section card">
    <div class="card-head"><h2 class="h2 grow">Mapping</h2><span class="micro muted">${esc(b.detail ?? "")}</span></div>
    <form method="post" action="/bridge/map" class="row">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div class="row-main">
        <div class="row-label">Map the bridge's login to a ledger account</div>
        <div class="row-detail">The account's net position per symbol becomes the platform's target every cycle; a trade made on the platform is carried into this account through the OMS.</div>
      </div>
      <input class="input mono" name="ledgerAccount" placeholder="5000…" value="${esc(external.mapping?.ledgerAccount ?? "")}" style="width:160px">
      <button class="btn btn-sm" type="submit">Map</button>
    </form>
    <form method="post" action="/bridge/unmap" class="row">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div class="row-main"><div class="row-label">Remove the mapping</div><div class="row-detail">Stops mirroring and carry-in. Breaks stay on record.</div></div>
      <button class="btn btn-sm btn-danger" type="submit"${external.mapping ? "" : " disabled"}>Unmap</button>
    </form>
    <form method="post" action="/bridge/cycle" class="row">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div class="row-main"><div class="row-label">Reconcile now</div><div class="row-detail">Runs one cycle immediately rather than waiting for the timer.</div></div>
      <button class="btn btn-sm" type="submit">Run cycle</button>
    </form>
  </div>

  <div class="section card">
    <div class="card-head"><h2 class="h2 grow">Breaks</h2><span class="micro muted">divergence that survived a mirroring attempt</span></div>
    ${table({ columns: [{ label: "State" }, { label: "Kind" }, { label: "Symbol" }, { label: "Ledger", align: "num" }, { label: "Platform", align: "num" }, { label: "Detail" }, { label: "Opened", align: "num" }], rows: breakRows, empty: "No break has ever been raised." })}
  </div>

  <div class="section card">
    <div class="card-head"><h2 class="h2 grow">Actions</h2><span class="micro muted">${esc(String(external.dealsCarried ?? 0))} platform deals seen</span></div>
    ${table({ columns: [{ label: "When", align: "num" }, { label: "Kind" }, { label: "Account" }, { label: "Symbol" }, { label: "Side" }, { label: "Volume", align: "num" }, { label: "Outcome" }, { label: "Detail" }], rows: actionRows, empty: "The reconciler has taken no action." })}
  </div>`;
}

/* --------------------------------------------- per-user order book (partial) */

/**
 * The ledger's view of one person's accounts, for the user detail page.
 * @param {any[]} tradingAccounts
 * @param {boolean} reachable
 */
export function userOrderBook(tradingAccounts, reachable) {
  if (!reachable) return unavailable("The order book", "the ledger could not be reached, so no position or order can be shown.");
  if (tradingAccounts.length === 0) return '<div class="table-empty small">The ledger holds no account for this person.</div>';
  return tradingAccounts.map((a) => {
    const v = a.valuation;
    const positions = (v?.positions ?? []).map((/** @type {any} */ p) => `<tr>
      <td class="mono small">${esc(p.symbol)}</td><td>${badge(p.side, p.side === "BUY" ? "positive" : "danger")}</td>
      <td class="num mono small">${esc(p.volume)}</td><td class="num mono small">${esc(p.openPrice)}</td>
      <td class="num mono small">${esc(p.mark)}</td><td class="num mono small${String(p.unrealised).startsWith("-") ? " is-negative" : ""}">${esc(p.unrealised)}</td>
    </tr>`);
    const orders = (a.orders ?? []).slice(0, 50).map((/** @type {any} */ o) => `<tr>
      <td class="num small muted">${esc(ago(new Date(o.timestampMs).toISOString()))}</td>
      <td class="mono small">${esc(o.symbol)}</td><td>${badge(o.side, o.side === "BUY" ? "positive" : "danger")}</td>
      <td class="num mono small">${esc(o.volume)}</td><td class="num mono small">${o.deal ? esc(o.deal.price) : "—"}</td>
      <td class="num mono small">${o.deal ? esc(o.deal.realised) : "—"}</td>
      <td>${o.state === "FILLED" ? badge("filled", "positive") : badge(o.rejection?.code ?? "rejected", "warning")}</td>
    </tr>`);
    return `<div class="card">
      <div class="card-head">
        <h2 class="h2 grow"><span class="mono">${esc(a.accountNumber)}</span> · ${esc(a.nickname)} ${a.mode === "demo" ? badge("demo", "accent") : badge("real", "warning")} ${a.status === "active" ? badge("active", "positive") : badge(a.status)}</h2>
        <span class="micro muted mono">${v ? `balance ${esc(v.balance)} · equity ${esc(v.equity)} · free ${esc(v.freeMargin)} · ML ${esc(v.marginLevel ?? "—")}` : "not valued"}</span>
      </div>
      ${table({ columns: [{ label: "Symbol" }, { label: "Side" }, { label: "Volume", align: "num" }, { label: "Open", align: "num" }, { label: "Mark", align: "num" }, { label: "Unrealised", align: "num" }], rows: positions, empty: "No open positions." })}
      <div class="card-head"><h3 class="h3 grow">Orders</h3><span class="micro muted">${esc(String((a.orders ?? []).length))} total</span></div>
      ${table({ columns: [{ label: "When", align: "num" }, { label: "Symbol" }, { label: "Side" }, { label: "Volume", align: "num" }, { label: "Price", align: "num" }, { label: "Realised", align: "num" }, { label: "Outcome" }], rows: orders, empty: "No orders yet." })}
    </div>`;
  }).join("");
}
