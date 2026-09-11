/**
 * Overview — the page an operator lands on.
 *
 * Built around one question: is anything wrong right now? Everything that could
 * be wrong is above the fold, and everything that is merely interesting is
 * below it. A dashboard where the failing service is fourteen cards down is a
 * dashboard people replace with a terminal.
 */

import { ago, badge, esc, icon, kpi, table, unavailable } from "../ui/layout.js";

/**
 * @param {{
 *   overview: any, status: any, containers: any, gates: any[],
 *   commit: any, host: any, audit: any[], error: string|null
 * }} data
 */
export function overviewPage({ overview, status, containers, gates, commit, host, audit, error }) {
  if (error) {
    return `<div class="page-head"><div class="grow"><h1 class="h1">Overview</h1></div></div>
      ${unavailable("The platform", error)}`;
  }

  const users = overview.users ?? {};
  const accounts = overview.accounts ?? {};
  const sessions = overview.sessions ?? {};
  const events = overview.events ?? {};
  const outbox = overview.outbox ?? {};

  // What is actually broken, gathered first so it can lead the page.
  /** @type {Array<{tone: string, title: string, text: string, href?: string}>} */
  const alarms = [];

  if (!status.reachable) {
    alarms.push({
      tone: "danger", title: "The client API is unreachable",
      text: "Nothing on this page about clients is current.",
    });
  } else if (!status.tradable) {
    const down = Object.entries(status.core ?? {})
      .filter(([, state]) => state !== "healthy").map(([name]) => name);
    alarms.push({
      tone: "danger", title: "The core is not tradable",
      text: down.length ? `Unavailable: ${down.join(", ")}.` : "One or more core services are unavailable.",
      href: "/infra",
    });
  }

  const unhealthy = (containers.list ?? []).filter((/** @type {any} */ c) => c.unhealthy || c.state !== "running");
  if (unhealthy.length > 0) {
    alarms.push({
      tone: "danger", title: `${unhealthy.length} container(s) not healthy`,
      text: unhealthy.map((/** @type {any} */ c) => c.name).join(", "),
      href: "/infra",
    });
  }

  const failing = gates.filter((g) => g.last && !g.last.passed);
  if (failing.length > 0) {
    alarms.push({
      tone: "danger", title: `${failing.length} gate(s) failing`,
      text: failing.map((g) => g.id).join(", "),
      href: "/gates",
    });
  }

  const stale = gates.filter((g) => g.stale);
  if (stale.length > 0) {
    alarms.push({
      tone: "warning", title: `${stale.length} gate result(s) are from an older commit`,
      text: "They describe a tree that is no longer this one.",
      href: "/gates",
    });
  }

  if ((outbox.pending ?? 0) > 20) {
    alarms.push({
      tone: "warning", title: `${outbox.pending} messages undelivered`,
      text: "A reset link waiting in a queue is a person who cannot get back in.",
      href: "/outbox",
    });
  }

  if ((users.locked ?? 0) > 0) {
    alarms.push({
      tone: "warning", title: `${users.locked} account(s) locked out`,
      text: "Locks clear themselves after fifteen minutes.",
      href: "/users",
    });
  }

  if (commit.available && !commit.clean) {
    alarms.push({
      tone: "warning", title: "The working tree has uncommitted changes",
      text: `${commit.changedFiles} file(s) differ from ${commit.sha}. Gate results describe a tree nobody else has.`,
    });
  }

  const alarmBlock = alarms.length === 0
    ? `<div class="notice">
        <span class="notice-icon">${icon.check(16)}</span>
        <div class="notice-body">
          <div class="notice-title">Nothing is currently wrong</div>
          <div class="notice-text">Every container is healthy, no gate is failing, and
          the core reports itself tradable.</div>
        </div>
      </div>`
    : `<div class="grid" style="gap:var(--s-2)">${alarms.map((alarm) => `
        <div class="notice notice-${alarm.tone}">
          <span class="notice-icon">${icon.alert(16)}</span>
          <div class="notice-body">
            <div class="notice-title">${esc(alarm.title)}</div>
            <div class="notice-text">${esc(alarm.text)}${
              alarm.href ? ` <a href="${esc(alarm.href)}">Open</a>` : ""
            }</div>
          </div>
        </div>`).join("")}</div>`;

  const coreRows = Object.entries(status.core ?? {}).map(([name, state]) => {
    const ok = state === "healthy";
    return `<tr>
      <td><span class="dot ${ok ? "dot-positive" : "dot-danger"}"></span> <span class="mono">${esc(name)}</span></td>
      <td>${badge(String(state), ok ? "positive" : "danger")}</td>
    </tr>`;
  });

  const gateRows = gates.filter((g) => g.runnable).map((g) => {
    const state = g.running ? "running" : !g.last ? "never" : g.last.passed ? (g.stale ? "stale" : "passed") : "failed";
    const tone = state === "passed" ? "positive" : state === "failed" ? "danger" : state === "stale" ? "warning" : "";
    return `<tr>
      <td><a class="mono row-link" href="/gates">${esc(g.id)}</a></td>
      <td class="small muted truncate">${esc(g.name)}</td>
      <td>${badge(state, /** @type {any} */ (tone))}</td>
      <td class="small muted num">${esc(g.last ? ago(g.last.startedAt) : "—")}</td>
    </tr>`;
  });

  const auditRows = audit.slice(0, 12).map((entry) => `<tr>
    <td class="small mono">${esc(entry.event)}</td>
    <td class="small truncate">${esc(entry.email)}</td>
    <td class="small muted truncate">${esc(entry.device)}</td>
    <td class="small muted num">${esc(ago(entry.at))}</td>
  </tr>`);

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Overview</h1>
      <p class="muted small">Everything that could be wrong, first.</p>
    </div>
    ${commit.available ? `<span class="badge${commit.clean ? "" : " badge-warning"}">
      ${esc(commit.sha)}${commit.clean ? "" : ` +${commit.changedFiles}`}
    </span>` : ""}
  </div>

  ${alarmBlock}

  <div class="section">
    <div class="grid grid-6">
      ${kpi({ label: "Clients", value: users.total ?? 0, note: `${users.today ?? 0} today · ${users.week ?? 0} this week` })}
      ${kpi({ label: "Live sessions", value: sessions.live ?? 0, note: "not expired, not revoked" })}
      ${kpi({ label: "Trading accounts", value: accounts.total ?? 0, note: `${accounts.demo ?? 0} demo` })}
      ${kpi({
        label: "Failed sign-ins",
        value: events.failed_today ?? 0,
        note: "last 24 hours",
        ...((events.failed_today ?? 0) > 20 ? { tone: /** @type {const} */ ("warning") } : {}),
      })}
      ${kpi({
        label: "Locked out",
        value: users.locked ?? 0,
        note: "clears after 15 minutes",
        ...((users.locked ?? 0) > 0 ? { tone: /** @type {const} */ ("warning") } : {}),
      })}
      ${kpi({
        label: "Mail pending",
        value: outbox.pending ?? 0,
        note: `${outbox.delivered ?? 0} delivered`,
        ...((outbox.pending ?? 0) > 20 ? { tone: /** @type {const} */ ("warning") } : {}),
      })}
    </div>
  </div>

  <div class="section split">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Gates</h2>
        <a class="small" href="/gates">All gates</a></div>
      ${table({
        columns: [{ label: "Gate" }, { label: "Name" }, { label: "State" }, { label: "Ran", align: "num" }],
        rows: gateRows,
        empty: "No runnable gates are defined.",
      })}
    </div>

    <div class="grid" style="gap:var(--s-4)">
      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Core</h2>
          <a class="small" href="/infra">Infrastructure</a></div>
        ${status.reachable
          ? table({
              columns: [{ label: "Service" }, { label: "State" }],
              rows: coreRows,
              empty: "The API reported no core services.",
            })
          : `<div class="card-pad">${unavailable("Core status", "The client API is unreachable.")}</div>`}
      </div>

      <div class="card card-pad">
        <div class="eyebrow" style="margin-bottom:var(--s-3)">Host</div>
        <div class="grid" style="gap:var(--s-2)">
          <div class="row" style="padding:0;border:0">
            <span class="row-main small muted">Load</span>
            <span class="num small">${esc(host.load.one)} · ${esc(host.load.five)} · ${esc(host.load.fifteen)}</span>
          </div>
          <div class="row" style="padding:0;border:0">
            <span class="row-main small muted">Disk free</span>
            <span class="num small">${esc(host.disk.free)} (${esc(host.disk.usedPercent)} used)</span>
          </div>
          <div class="row" style="padding:0;border:0">
            <span class="row-main small muted">Uptime</span>
            <span class="num small">${esc(host.uptimeHours)}h</span>
          </div>
          <div class="row" style="padding:0;border:0">
            <span class="row-main small muted">Node</span>
            <span class="num small">${esc(host.node)}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Recent activity</h2>
        <a class="small" href="/audit">Full audit trail</a></div>
      ${table({
        columns: [{ label: "Event" }, { label: "Account" }, { label: "Device" }, { label: "When", align: "num" }],
        rows: auditRows,
        empty: "Nothing has been recorded yet.",
      })}
    </div>
  </div>`;
}
