/**
 * The trading terminal.
 *
 * Server-rendered like every other page: the instrument list, the account
 * summary and the blotter all arrive complete, and `client.js` then upgrades
 * them into something live. With scripting off, the page still shows the
 * account, its positions and its orders — it simply stops updating.
 *
 * **This page owns no financial truth** (INV-190). Every figure on it is a
 * string the API returned. The chart is the one place a number is derived from
 * one, and even there the conversion is exact and integer-only: a price is
 * turned into a count of its own last decimal place, and the pixel geometry is
 * done on those integers. No amount is ever parsed into a float (INV-191, P1).
 */

import { esc } from "../ui/layout.js";
import { icon } from "../ui/icons.js";

/**
 * @typedef {object} TerminalInstrument
 * @property {string} symbol
 * @property {string} name
 * @property {string} class
 * @property {number} digits
 * @property {number} minVolumeMilliLots
 * @property {number} maxVolumeMilliLots
 */

/**
 * @typedef {object} TerminalAccount
 * @property {string} accountNumber
 * @property {string} nickname
 * @property {string} mode
 * @property {string} currency
 * @property {number} leverage
 */

/** The chart intervals offered, shortest first. */
const INTERVALS = ["5s", "15s", "1m", "5m", "15m", "1h"];

/**
 * A figure the core supplied, or an explicit dash.
 *
 * Never a zero. "We have no figure for you" and "your balance is zero" are
 * different statements, and a page that renders them the same way is lying in
 * one of the two cases (INV-183).
 *
 * @param {string|null|undefined} value
 */
const figure = (value) => (value === null || value === undefined ? "—" : esc(value));

/**
 * The panel shown when the client has no trading account yet.
 * @param {boolean} coreReachable
 */
function noAccountPanel(coreReachable) {
  if (!coreReachable) {
    return `<div class="card card-pad empty" data-terminal-empty>
      <div class="empty-icon">${icon.info(28)}</div>
      <h2 class="h2">The financial core is unreachable</h2>
      <p class="small muted">
        The terminal will not show a price it cannot verify, and will not accept an order it
        cannot risk-check. Nothing is cached and nothing is estimated.
      </p>
    </div>`;
  }
  return `<div class="card card-pad empty" data-terminal-empty>
    <div class="empty-icon">${icon.candles(28)}</div>
    <h2 class="h2">Open a demo account to start</h2>
    <p class="small muted">
      A demo account is funded with 10,000.00 USD of demo capital, issued against the demo
      capital pot in the ledger. It settles through the same journal, the same risk engine and
      the same execution path as a real one — only the money is not.
    </p>
    <button class="btn btn-primary btn-lg" type="button" data-open-demo>
      ${icon.plus(18)} Open a demo account
    </button>
  </div>`;
}

/**
 * @param {TerminalInstrument[]} instruments
 * @param {string} symbol
 */
function symbolOptions(instruments, symbol) {
  if (instruments.length === 0) {
    return `<option value="">No instruments available</option>`;
  }
  return instruments
    .map(
      (instrument) =>
        `<option value="${esc(instrument.symbol)}"${instrument.symbol === symbol ? " selected" : ""}>${esc(
          instrument.symbol,
        )} — ${esc(instrument.name)}</option>`,
    )
    .join("");
}

/**
 * @param {TerminalAccount[]} accounts
 * @param {string} selected
 */
function accountOptions(accounts, selected) {
  return accounts
    .map(
      (account) =>
        `<option value="${esc(account.accountNumber)}"${
          account.accountNumber === selected ? " selected" : ""
        }>${esc(account.accountNumber)} · ${esc(account.nickname)} (${esc(account.mode)})</option>`,
    )
    .join("");
}

/**
 * One summary tile.
 * @param {string} label
 * @param {string} key
 * @param {string|null} value
 * @param {string} [hint]
 */
const tile = (label, key, value, hint = "") =>
  `<div class="tile">
    <span class="tile-label">${esc(label)}${hint ? ` <span class="micro muted">${esc(hint)}</span>` : ""}</span>
    <span class="tile-value" data-${esc(key)}>${figure(value)}</span>
  </div>`;

/**
 * @param {import("../../../../services/client-api/src/accounts.js").ValuedPosition[]} positions
 */
function positionRows(positions) {
  if (positions.length === 0) {
    return `<tr data-positions-empty><td colspan="7" class="small muted" style="text-align:center;padding:var(--s-6)">
      No open positions.
    </td></tr>`;
  }
  return positions.map(positionRow).join("");
}

/**
 * @param {import("../../../../services/client-api/src/accounts.js").ValuedPosition} position
 */
function positionRow(position) {
  // The sign of a P&L string decides the colour. Reading the leading character
  // is not arithmetic — the page still does no maths on money (INV-191).
  const losing = position.unrealised.startsWith("-");
  return `<tr data-position="${esc(position.symbol)}">
    <td class="mono">${esc(position.symbol)}</td>
    <td><span class="badge ${position.side === "BUY" ? "badge-positive" : "badge-danger"}">${esc(position.side)}</span></td>
    <td class="mono">${esc(position.volume)}</td>
    <td class="mono">${esc(position.openPrice)}</td>
    <td class="mono" data-position-mark>${esc(position.mark)}</td>
    <td class="mono ${losing ? "figure-down" : "figure-up"}" data-position-pnl>${esc(position.unrealised)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" type="button" data-close-position="${esc(position.symbol)}">Close</button>
    </td>
  </tr>`;
}

/**
 * @typedef {object} TerminalOrder
 * @property {string} orderId
 * @property {string} state
 * @property {string} symbol
 * @property {string} side
 * @property {string} volume
 * @property {number} timestampMs
 * @property {{price: string, realised: string, commission: string}|null} deal
 * @property {{code: string, detail: string}|null} rejection
 */

/** @param {TerminalOrder[]} orders */
function orderRows(orders) {
  if (orders.length === 0) {
    return `<tr data-orders-empty><td colspan="6" class="small muted" style="text-align:center;padding:var(--s-6)">
      No orders yet.
    </td></tr>`;
  }
  return orders
    .map((order) => {
      const filled = order.state === "FILLED";
      return `<tr data-order="${esc(order.orderId)}">
        <td class="mono">${esc(order.symbol)}</td>
        <td><span class="badge ${order.side === "BUY" ? "badge-positive" : "badge-danger"}">${esc(order.side)}</span></td>
        <td class="mono">${esc(order.volume)}</td>
        <td class="mono">${order.deal ? esc(order.deal.price) : "—"}</td>
        <td class="mono">${order.deal ? esc(order.deal.realised) : "—"}</td>
        <td>
          <span class="badge ${filled ? "badge-positive" : "badge-warning"}" data-order-state>${esc(order.state)}</span>
          ${order.rejection ? `<span class="micro muted" style="display:block">${esc(order.rejection.detail)}</span>` : ""}
        </td>
      </tr>`;
    })
    .join("");
}

/**
 * The terminal.
 *
 * @param {object} data
 * @param {TerminalInstrument[]} data.instruments
 * @param {TerminalAccount[]} data.accounts
 * @param {string} data.symbol
 * @param {string} data.interval
 * @param {string} data.account
 * @param {import("../../../../services/client-api/src/accounts.js").Valuation|null} data.valuation
 * @param {TerminalOrder[]} data.orders
 * @param {boolean} data.coreReachable
 */
export function terminalPage({
  instruments,
  accounts,
  symbol,
  interval,
  account,
  valuation,
  orders,
  coreReachable,
}) {
  if (accounts.length === 0) {
    return `<div class="page-head">
        <div class="grow">
          <h1 class="h1">Trading terminal</h1>
          <p class="muted">Quotes, ticket and blotter in one view.</p>
        </div>
      </div>
      ${noAccountPanel(coreReachable)}`;
  }

  const positions = valuation?.positions ?? [];
  const digits = instruments.find((i) => i.symbol === symbol)?.digits ?? 5;

  return `<div class="terminal"
      data-terminal
      data-account="${esc(account)}"
      data-symbol="${esc(symbol)}"
      data-interval="${esc(interval)}"
      data-digits="${digits}">

    <div class="page-head">
      <div class="grow">
        <h1 class="h1">Trading terminal</h1>
        <p class="muted">Every figure here came from the core. This page computes none of them.</p>
      </div>
      <div class="terminal-account">
        <label class="label" for="terminal-account">Account</label>
        <select class="select" id="terminal-account" data-account-select>
          ${accountOptions(accounts, account)}
        </select>
      </div>
    </div>

    <div class="terminal-grid">
      <!-- ------------------------------------------------------- chart -->
      <section class="card chart-card" aria-label="Price chart">
        <header class="chart-head">
          <div class="chart-symbol">
            <label class="sr-only" for="terminal-symbol">Instrument</label>
            <select class="select" id="terminal-symbol" data-symbol-select>
              ${symbolOptions(instruments, symbol)}
            </select>
          </div>

          <div class="quote-strip" data-quote-strip>
            <div class="quote-side quote-bid">
              <span class="quote-label">Bid</span>
              <span class="quote-price mono" data-bid>—</span>
            </div>
            <div class="quote-side quote-ask">
              <span class="quote-label">Ask</span>
              <span class="quote-price mono" data-ask>—</span>
            </div>
            <div class="quote-side">
              <span class="quote-label">Spread</span>
              <span class="quote-price mono" data-spread>—</span>
            </div>
            <div class="quote-side">
              <span class="quote-label">Age</span>
              <span class="quote-price mono" data-quote-age>—</span>
            </div>
          </div>

          <div class="interval-picker" role="group" aria-label="Chart interval">
            ${INTERVALS.map(
              (label) =>
                `<button class="interval-btn" type="button" data-interval-btn="${esc(label)}"${
                  label === interval ? ' aria-pressed="true"' : ' aria-pressed="false"'
                }>${esc(label)}</button>`,
            ).join("")}
          </div>
        </header>

        <!--
          The canvas carries the drawn data as attributes as well as pixels:
          a chart that renders but plots nothing looks identical to a working
          one in a screenshot, and these make the difference assertable.
        -->
        <div class="chart-host" data-chart-host data-candles="0" data-last="">
          <canvas data-chart width="1200" height="460" role="img"
                  aria-label="Candlestick chart for ${esc(symbol)}"></canvas>
          <div class="chart-empty small muted" data-chart-empty>Loading price history…</div>
        </div>
      </section>

      <!-- ------------------------------------------------------ ticket -->
      <aside class="card card-pad ticket" aria-label="Order ticket">
        <h2 class="h3 ticket-title">New order</h2>

        <form data-ticket novalidate>
          <div class="field">
            <label class="label" for="terminal-volume">Volume <span class="micro muted">lots</span></label>
            <input class="input mono" id="terminal-volume" name="volume" data-volume
                   value="0.10" inputmode="decimal" autocomplete="off" spellcheck="false">
            <p class="hint" data-volume-hint>
              Up to three decimal places. Sent as text, never as a number.
            </p>
          </div>

          <div class="ticket-actions">
            <button class="btn btn-sell" type="submit" value="SELL" name="side" data-sell>
              <span class="ticket-side">Sell</span>
              <span class="ticket-price mono" data-sell-price>—</span>
            </button>
            <button class="btn btn-buy" type="submit" value="BUY" name="side" data-buy>
              <span class="ticket-side">Buy</span>
              <span class="ticket-price mono" data-buy-price>—</span>
            </button>
          </div>

          <p class="ticket-note micro muted" data-ticket-note role="status" aria-live="polite"></p>
        </form>

        <div class="summary" data-summary>
          ${tile("Balance", "balance", valuation?.balance ?? null)}
          ${tile("Equity", "equity", valuation?.equity ?? null)}
          ${tile("Unrealised", "unrealised", valuation?.unrealised ?? null)}
          ${tile("Used margin", "used-margin", valuation?.usedMargin ?? null)}
          ${tile("Free margin", "free-margin", valuation?.freeMargin ?? null)}
          ${tile("Margin level", "margin-level", valuation?.marginLevel ?? null, "%")}
        </div>
        <p class="micro muted">
          Margin level is blank when nothing is open — that is a defined state, not a zero.
        </p>
      </aside>
    </div>

    <!-- --------------------------------------------------------- blotter -->
    <section class="card blotter" aria-label="Open positions">
      <header class="blotter-head">
        <h2 class="h3">Open positions</h2>
        <span class="micro muted" data-positions-count>${positions.length} open</span>
      </header>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th><th>Side</th><th>Volume</th>
              <th>Open</th><th>Mark</th><th>Unrealised</th><th></th>
            </tr>
          </thead>
          <tbody data-positions>${positionRows(positions)}</tbody>
        </table>
      </div>
    </section>

    <section class="card blotter" aria-label="Order history">
      <header class="blotter-head">
        <h2 class="h3">Orders</h2>
        <a class="small" href="/orders">Full history</a>
      </header>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr><th>Symbol</th><th>Side</th><th>Volume</th><th>Price</th><th>Realised</th><th>State</th></tr>
          </thead>
          <tbody data-orders>${orderRows(orders)}</tbody>
        </table>
      </div>
    </section>
  </div>`;
}
