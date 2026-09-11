/**
 * The system pages: gates, modules, infrastructure, database, audit, outbox,
 * logs and accounts.
 *
 * One file because they share a shape — a header, a filter, and a table of
 * something observed — and splitting eight variations of that across eight
 * files would spread one idea thinly rather than organising it.
 */

import { ago, badge, duration, esc, icon, kpi, table, tierBadge, unavailable } from "../ui/layout.js";

/* ------------------------------------------------------------------ gates */

/**
 * The gate board.
 *
 * A gate's result is shown with its age and the commit it ran against, because
 * "G8 passed" without those is a claim about a tree that may no longer exist.
 *
 * @param {{gates: any[], commit: any, csrf: string, running: string[]}} data
 */
export function gatesPage({ gates, commit, csrf, running }) {
  const runnable = gates.filter((g) => g.runnable);
  const passed = runnable.filter((g) => g.last?.passed && !g.stale).length;
  const failed = runnable.filter((g) => g.last && !g.last.passed).length;
  const never = runnable.filter((g) => !g.last).length;

  const cards = gates.map((gate) => {
    const state = gate.running ? "running"
      : !gate.last ? "never"
      : gate.last.passed ? (gate.stale ? "stale" : "passed")
      : "failed";

    const tone = state === "passed" ? "positive"
      : state === "failed" ? "danger"
      : state === "stale" ? "warning"
      : state === "running" ? "accent" : "";

    return `<div class="gate" data-state="${esc(state)}">
      <div class="gate-head">
        <span class="gate-id">${esc(gate.id)}</span>
        <span class="h3 grow">${esc(gate.name)}</span>
        ${badge(state, /** @type {any} */ (tone))}
      </div>
      <p class="gate-question">${esc(gate.question ?? "")}</p>

      ${gate.last ? `<div class="gate-summary" title="${esc(gate.last.summary)}">${esc(gate.last.summary)}</div>` : ""}

      ${gate.requiredBy.length ? `<div class="micro muted truncate">
        Required by ${esc(gate.requiredBy.join(", "))}
      </div>` : `<div class="micro muted">Required by no module yet</div>`}

      <div class="gate-foot">
        ${gate.last ? `<span class="micro muted">
          ${esc(ago(gate.last.startedAt))} · ${esc(duration(gate.last.durationMs))}
          ${gate.last.commit ? ` · <span class="mono">${esc(gate.last.commit)}</span>` : ""}
        </span>` : `<span class="micro muted">never run here</span>`}
        <span class="grow"></span>
        ${gate.runnable ? `<form method="post" action="/gates/${esc(gate.id)}/run">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn btn-sm" type="submit" ${gate.running ? "disabled" : ""}>
            ${gate.running ? "Running…" : `${icon.play(12)} Run`}
          </button>
        </form>` : `<span class="micro muted" title="${
          esc(gate.cannotRunBecause || "No command is defined for this gate.")
        }">${gate.defined ? "cannot run here" : "no command defined"}</span>`}
      </div>
    </div>`;
  }).join("");

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Gates</h1>
      <p class="muted small">A gate is a question about the system. The answer has a shelf life.</p>
    </div>
    ${commit.available ? `<span class="badge${commit.clean ? "" : " badge-warning"}">${esc(commit.sha)}${commit.clean ? "" : ` +${commit.changedFiles}`}</span>` : ""}
  </div>

  ${gates.some((g) => g.cannotRunBecause) ? `<div class="notice" style="margin-bottom:var(--s-4)">
    <span class="notice-icon">${icon.info(16)}</span>
    <div class="notice-body">
      <div class="notice-title">This console reports gate results, it does not produce them</div>
      <div class="notice-text">${esc(
        gates.find((g) => g.cannotRunBecause)?.cannotRunBecause ?? ""
      )}</div>
    </div>
  </div>` : ""}

  ${running.length ? `<div class="notice notice-warning" style="margin-bottom:var(--s-4)">
    <span class="notice-icon">${icon.info(16)}</span>
    <div class="notice-body">
      <div class="notice-title">${esc(running.join(", "))} running now</div>
      <div class="notice-text">This page does not stream. Refresh for the result.</div>
    </div>
  </div>` : ""}

  <div class="grid grid-4">
    ${kpi({ label: "Passing", value: passed, note: "on this commit", ...(passed ? { tone: /** @type {const} */ ("positive") } : {}) })}
    ${kpi({ label: "Failing", value: failed, ...(failed ? { tone: /** @type {const} */ ("danger") } : {}) })}
    ${kpi({ label: "Stale", value: runnable.filter((g) => g.stale).length, note: "ran on another commit" })}
    ${kpi({ label: "Never run", value: never, note: "no result recorded here" })}
  </div>

  <div class="section">
    <div class="gate-grid">${cards}</div>
  </div>

  ${gates.some((g) => g.last && !g.last.passed) ? `<div class="section">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Last failure output</h2></div>
      ${gates.filter((g) => g.last && !g.last.passed).map((g) => `
        <div class="card-pad">
          <div class="eyebrow" style="margin-bottom:var(--s-2)">${esc(g.id)} — ${esc(g.name)}</div>
          <div class="log">${g.last.output.map((/** @type {string} */ line) =>
            `<span class="log-line">${esc(line)}</span>`).join("")}</div>
        </div>`).join("")}
    </div>
  </div>` : ""}`;
}

/* ---------------------------------------------------------------- modules */

/**
 * @param {{modules: any[], tiers: any[]}} data
 */
export function modulesPage({ modules, tiers }) {
  const byStatus = /** @type {Record<string, number>} */ ({});
  for (const module of modules) byStatus[module.status] = (byStatus[module.status] ?? 0) + 1;

  const rows = modules.map((module) => `<tr>
    <td>
      <span class="mono row-link">${esc(module.id)}</span>
      <div class="micro muted truncate" style="max-width:34ch">${esc(module.name)}</div>
    </td>
    <td>${tierBadge(module.tier)}</td>
    <td>${
      module.status === "done" ? badge("done", "positive")
      : module.status === "in-progress" ? badge("in progress", "accent")
      : badge(module.status)
    }</td>
    <td class="small mono muted">${esc((module.requiredGates ?? []).join(" "))}</td>
    <td class="num small">${esc(module.invariants)}</td>
    <td class="num small muted">${esc(module.dependsOn.length)}</td>
    <td class="num small muted">${esc(module.dependents.length)}</td>
    <td class="small muted">${module.releaseApproval === "manual" ? badge("manual", "warning") : "auto"}</td>
  </tr>`);

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Modules</h1>
      <p class="muted small">Read from <span class="mono">registry/modules.yaml</span> — the same file the DAG check and the docs are generated from.</p>
    </div>
  </div>

  <div class="grid grid-4">
    ${kpi({ label: "Modules", value: modules.length })}
    ${kpi({ label: "In progress", value: byStatus["in-progress"] ?? 0, tone: "positive" })}
    ${kpi({ label: "Planned", value: byStatus["planned"] ?? 0 })}
    ${kpi({ label: "Invariants", value: modules.reduce((sum, m) => sum + m.invariants, 0), note: "declared across every module" })}
  </div>

  <div class="section">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">The graph</h2></div>
      ${table({
        columns: [
          { label: "Module" }, { label: "Tier" }, { label: "Status" }, { label: "Required gates" },
          { label: "Invariants", align: "num" }, { label: "Depends on", align: "num" },
          { label: "Depended on by", align: "num" }, { label: "Release" },
        ],
        rows,
        empty: "The registry declares no modules.",
      })}
    </div>
  </div>

  <div class="section">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Tiers</h2>
        <span class="micro muted">What goes wrong when a module at this tier is wrong</span></div>
      <div class="rows">
        ${tiers.map((tier) => `<div class="row">
          <span style="flex:none;width:44px">${tierBadge(tier.id)}</span>
          <div class="row-main">
            <div class="row-label">${esc(tier.name)}</div>
            <div class="row-detail">${esc(tier.blastRadius)}</div>
          </div>
          <span class="small muted" style="max-width:40ch;text-align:right">${esc(tier.changePolicy)}</span>
        </div>`).join("")}
      </div>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- infra */

/**
 * @param {{containers: any, images: any, volumes: any, ports: any, tunnels: any, host: any, commit: any}} data
 */
export function infraPage({ containers, images, volumes, ports, tunnels, host, commit }) {
  const containerRows = (containers.list ?? []).map((/** @type {any} */ c) => `<tr>
    <td>
      <span class="dot ${c.healthy ? "dot-positive" : c.state === "running" ? "dot-warning" : "dot-danger"}"></span>
      <span class="mono small">${esc(c.name)}</span>
    </td>
    <td>${c.state === "running" ? badge(c.healthy ? "healthy" : "running", c.healthy ? "positive" : "warning") : badge(c.state, "danger")}</td>
    <td class="small muted truncate">${esc(c.image)}</td>
    <td class="small muted mono">${esc(c.ports || "—")}</td>
    <td class="small muted truncate">${esc(c.status)}</td>
  </tr>`);

  const imageRows = (images.list ?? []).map((/** @type {any} */ i) => `<tr>
    <td class="mono small">${esc(i.reference)}</td>
    <td class="mono small muted">${esc(i.id)}</td>
    <td class="small muted">${esc(i.created)}</td>
    <td class="num small muted">${esc(i.size)}</td>
  </tr>`);

  const portRows = (ports.list ?? []).map((/** @type {any} */ p) => `<tr>
    <td class="num mono small">${esc(p.port)}</td>
    <td class="small">${esc(p.name)}</td>
    <td class="small muted truncate">${esc(p.description)}</td>
    <td>${p.listening ? badge("listening", "positive") : badge("free")}</td>
  </tr>`);

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Infrastructure</h1>
      <p class="muted small">Observed, not configured — containers from the daemon, listeners from the kernel.</p>
    </div>
  </div>

  <div class="grid grid-4">
    ${kpi({
      label: "Containers",
      value: (containers.list ?? []).filter((/** @type {any} */ c) => c.state === "running").length,
      note: `${(containers.list ?? []).length} defined`,
    })}
    ${kpi({ label: "Images", value: (images.list ?? []).length, note: "built from this tree" })}
    ${kpi({ label: "Ports listening", value: (ports.list ?? []).filter((/** @type {any} */ p) => p.listening).length, note: `${(ports.list ?? []).length} reserved` })}
    ${kpi({ label: "Tunnels", value: (tunnels.list ?? []).length, note: "cloudflared on this host" })}
  </div>

  <div class="section">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Containers</h2></div>
      ${containers.available
        ? table({
            columns: [{ label: "Name" }, { label: "State" }, { label: "Image" }, { label: "Published" }, { label: "Status" }],
            rows: containerRows,
            empty: "No container is named projectx-*.",
          })
        : `<div class="card-pad">${unavailable("Containers", containers.error ?? "")}</div>`}
    </div>
  </div>

  <div class="section split">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Images</h2></div>
      ${images.available
        ? table({
            columns: [{ label: "Reference" }, { label: "ID" }, { label: "Built" }, { label: "Size", align: "num" }],
            rows: imageRows,
            empty: "No projectx image has been built.",
          })
        : `<div class="card-pad">${unavailable("Images", images.error ?? "")}</div>`}
    </div>

    <div class="grid" style="gap:var(--s-4)">
      <div class="card card-pad">
        <div class="eyebrow" style="margin-bottom:var(--s-3)">This tree</div>
        ${commit.available ? `<div class="grid" style="gap:var(--s-2)">
          <div class="row" style="padding:0;border:0">
            <span class="row-main small muted">Commit</span>
            <span class="mono small">${esc(commit.sha)}</span>
          </div>
          <div class="row" style="padding:0;border:0">
            <span class="row-main small muted">State</span>
            <span class="small">${commit.clean ? badge("clean", "positive") : badge(`${commit.changedFiles} changed`, "warning")}</span>
          </div>
          <div class="small muted" style="margin-top:var(--s-2);line-height:1.5">
            ${esc(commit.subject)}<br>
            <span class="micro">${esc(commit.author)} · ${esc(commit.when)}</span>
          </div>
        </div>` : commit.noCommits
          ? `<div class="notice">
              <span class="notice-icon">${icon.info(16)}</span>
              <div class="notice-body">
                <div class="notice-title">No commits yet</div>
                <div class="notice-text">${esc(commit.error ?? "")}</div>
              </div>
            </div>`
          : unavailable("Git", commit.error ?? "")}
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
            <span class="num small">${esc(host.disk.free)} (${esc(host.disk.usedPercent)})</span>
          </div>
          <div class="row" style="padding:0;border:0">
            <span class="row-main small muted">Uptime</span>
            <span class="num small">${esc(host.uptimeHours)}h</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="section split">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Reserved ports</h2>
        <span class="micro muted">from .env</span></div>
      <div class="scroll-y">
        ${table({
          columns: [{ label: "Port", align: "num" }, { label: "Service" }, { label: "Purpose" }, { label: "State" }],
          rows: portRows,
          empty: "No PORT_* entries in .env.",
        })}
      </div>
    </div>

    <div class="grid" style="gap:var(--s-4)">
      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Tunnels</h2></div>
        ${(tunnels.list ?? []).length === 0
          ? `<div class="table-empty small">No cloudflared process on this host.</div>`
          : `<div class="rows">${tunnels.list.map((/** @type {any} */ t) => `<div class="row">
              <div class="row-main">
                <div class="row-label mono small">${esc(t.config)}</div>
                <div class="row-detail mono micro truncate">${esc(t.command)}</div>
              </div>
              <span class="micro muted num">pid ${esc(t.pid)}</span>
            </div>`).join("")}</div>`}
      </div>

      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Volumes</h2></div>
        ${volumes.available
          ? `<div class="rows">${(volumes.list ?? []).map((/** @type {any} */ v) => `<div class="row">
              <span class="row-main mono small">${esc(v.name)}</span>
              <span class="micro muted">${esc(v.driver)}</span>
            </div>`).join("") || `<div class="table-empty small">No projectx volume.</div>`}</div>`
          : `<div class="card-pad">${unavailable("Volumes", volumes.error ?? "")}</div>`}
      </div>
    </div>
  </div>`;
}

/* -------------------------------------------------------------- database */

/**
 * What the database is enforcing — read from its catalogue, not from a file.
 *
 * @param {{isolation: any, error: string|null}} data
 */
export function databasePage({ isolation, error }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Database</h1>
      <p class="muted small">Read from the catalogue, so this is what is enforced rather than what was intended.</p>
    </div>
  </div>`;

  if (error) return `${head}${unavailable("The database view", error)}`;

  const bypassing = (isolation.roles ?? []).filter((/** @type {any} */ r) => r.superuser || r.bypassRls);
  const serving = (isolation.roles ?? []).filter((/** @type {any} */ r) => r.role !== "projectx");
  const unprotected = (isolation.tables ?? []).filter((/** @type {any} */ t) => !t.rowSecurity || !t.forced);

  const roleRows = (isolation.roles ?? []).map((/** @type {any} */ r) => `<tr>
    <td class="mono small">${esc(r.role)}</td>
    <td>${r.superuser ? badge("superuser", "danger") : badge("no", "positive")}</td>
    <td>${r.bypassRls ? badge("bypasses RLS", "danger") : badge("no", "positive")}</td>
    <td>${r.canLogin ? badge("login") : badge("no login", "positive")}</td>
  </tr>`);

  const tableRows = (isolation.tables ?? []).map((/** @type {any} */ t) => `<tr>
    <td class="mono small">${esc(t.table)}</td>
    <td>${t.rowSecurity ? badge("on", "positive") : badge("off", "danger")}</td>
    <td>${t.forced ? badge("forced", "positive") : badge("not forced", "danger")}</td>
    <td class="num small">${esc(t.policies)}</td>
    <td class="num small muted">${esc(t.rows)}</td>
  </tr>`);

  const grantRows = (isolation.grants ?? []).map((/** @type {any} */ g) => `<tr>
    <td class="mono small">${esc(g.role)}</td>
    <td class="mono small">${esc(g.table)}</td>
    <td class="small muted mono">${esc(g.privileges)}</td>
  </tr>`);

  return `${head}

  ${bypassing.some((/** @type {any} */ r) => r.role !== "projectx") ? `<div class="notice notice-danger" style="margin-bottom:var(--s-4)">
    <span class="notice-icon">${icon.alert(16)}</span>
    <div class="notice-body">
      <div class="notice-title">A serving role can bypass row-level security</div>
      <div class="notice-text">Every policy below is inert for that role. Client isolation is not being enforced.</div>
    </div>
  </div>` : ""}

  ${unprotected.length ? `<div class="notice notice-danger" style="margin-bottom:var(--s-4)">
    <span class="notice-icon">${icon.alert(16)}</span>
    <div class="notice-body">
      <div class="notice-title">${unprotected.length} table(s) without forced row-level security</div>
      <div class="notice-text">${esc(unprotected.map((/** @type {any} */ t) => t.table).join(", "))}</div>
    </div>
  </div>` : ""}

  <div class="grid grid-4">
    ${kpi({ label: "Size", value: isolation.database?.database_size ?? "—" })}
    ${kpi({ label: "Connections", value: isolation.database?.connections ?? 0 })}
    ${kpi({
      label: "Protected tables",
      value: `${(isolation.tables ?? []).length - unprotected.length}/${(isolation.tables ?? []).length}`,
      note: "row security, forced",
      ...(unprotected.length === 0 ? { tone: /** @type {const} */ ("positive") } : { tone: /** @type {const} */ ("danger") }),
    })}
    ${kpi({
      label: "Serving roles",
      value: serving.length,
      note: serving.every((/** @type {any} */ r) => !r.superuser && !r.bypassRls) ? "none may bypass" : "one may bypass",
      ...(serving.every((/** @type {any} */ r) => !r.superuser && !r.bypassRls)
        ? { tone: /** @type {const} */ ("positive") } : { tone: /** @type {const} */ ("danger") }),
    })}
  </div>

  <div class="section split">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Tables</h2></div>
      ${table({
        columns: [{ label: "Table" }, { label: "Row security" }, { label: "Forced" },
                  { label: "Policies", align: "num" }, { label: "Rows", align: "num" }],
        rows: tableRows,
        empty: "The app schema has no tables.",
      })}
    </div>

    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Roles</h2></div>
      ${table({
        columns: [{ label: "Role" }, { label: "Superuser" }, { label: "Bypass RLS" }, { label: "Login" }],
        rows: roleRows,
        empty: "No projectx role.",
      })}
    </div>
  </div>

  <div class="section">
    <div class="card">
      <div class="card-head"><h2 class="h2 grow">Grants</h2>
        <span class="micro muted">What each serving role may touch at all</span></div>
      <div class="scroll-y">
        ${table({
          columns: [{ label: "Role" }, { label: "Table" }, { label: "Privileges" }],
          rows: grantRows,
          empty: "No grants recorded.",
        })}
      </div>
    </div>
  </div>

  <p class="micro muted" style="margin-top:var(--s-4);max-width:70ch;line-height:1.6">
    ${esc(String(isolation.database?.version ?? ""))}
  </p>`;
}

/* ----------------------------------------------------------------- audit */

/**
 * @param {{events: any[], names: any[], filter: string, error: string|null}} data
 */
export function auditPage({ events, names, filter, error }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Audit</h1>
      <p class="muted small">Everything that happened to an account, across everybody.</p>
    </div>
  </div>`;

  if (error) return `${head}${unavailable("The audit trail", error)}`;

  const rows = events.map((entry) => `<tr>
    <td class="small mono">${esc(entry.event)}</td>
    <td class="small">
      ${entry.userId
        ? `<a class="row-link" href="/users/${esc(entry.userId)}">${esc(entry.email)}</a>`
        : esc(entry.email)}
    </td>
    <td class="small muted">${esc(entry.detail ?? "—")}</td>
    <td class="small muted">${esc(entry.device)}</td>
    <td class="small muted mono">${esc(entry.ip)}</td>
    <td class="num small muted">${esc(ago(entry.at))}</td>
  </tr>`);

  return `${head}

  <div class="chips" style="margin-bottom:var(--s-4)">
    <a class="chip" href="/audit"${filter ? "" : ' aria-current="true"'}>All</a>
    ${names.map((name) => `<a class="chip" href="/audit?event=${encodeURIComponent(name.event)}"${
      filter === name.event ? ' aria-current="true"' : ""
    }>${esc(name.event)} <span class="muted">${esc(name.count)}</span></a>`).join("")}
  </div>

  <div class="card">
    ${table({
      columns: [{ label: "Event" }, { label: "Account" }, { label: "Detail" },
                { label: "Device" }, { label: "Address" }, { label: "When", align: "num" }],
      rows,
      empty: filter ? `No “${filter}” events recorded.` : "Nothing has been recorded yet.",
    })}
  </div>`;
}

/* ---------------------------------------------------------------- outbox */

/**
 * @param {{messages: any[], delivery: string, state: string, error: string|null}} data
 */
export function outboxPage({ messages, delivery, state, error }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Outbox</h1>
      <p class="muted small">Message bodies are never shown here — they carry live reset links.</p>
    </div>
    ${badge(`driver: ${delivery}`, delivery === "none" ? "warning" : "positive")}
  </div>`;

  if (error) return `${head}${unavailable("The outbox", error)}`;

  const pending = messages.filter((m) => !m.deliveredAt);
  const rows = messages.map((m) => `<tr>
    <td class="small truncate">${esc(m.to)}</td>
    <td class="small">${esc(m.subject)}</td>
    <td class="small muted mono">${esc(m.kind)}</td>
    <td>${m.deliveredAt ? badge("delivered", "positive") : badge("pending", "warning")}</td>
    <td class="small muted truncate" style="max-width:36ch">${esc(m.blockedReason ?? "—")}</td>
    <td class="num small muted">${esc(ago(m.createdAt))}</td>
  </tr>`);

  return `${head}

  ${delivery === "none" ? `<div class="notice notice-warning" style="margin-bottom:var(--s-4)">
    <span class="notice-icon">${icon.alert(16)}</span>
    <div class="notice-body">
      <div class="notice-title">No delivery driver is configured</div>
      <div class="notice-text">Messages are queued and stay queued. A reset link
      that never arrives is a person who cannot get back into their account. Set
      <span class="mono">MAIL_DRIVER</span> to send.</div>
    </div>
  </div>` : ""}

  <div class="grid grid-3">
    ${kpi({ label: "Pending", value: pending.length, ...(pending.length > 20 ? { tone: /** @type {const} */ ("warning") } : {}) })}
    ${kpi({ label: "Delivered", value: messages.length - pending.length, note: "in this window" })}
    ${kpi({ label: "Driver", value: delivery })}
  </div>

  <div class="chips section" style="margin-bottom:var(--s-4)">
    <a class="chip" href="/outbox"${state ? "" : ' aria-current="true"'}>All</a>
    <a class="chip" href="/outbox?state=pending"${state === "pending" ? ' aria-current="true"' : ""}>Pending</a>
    <a class="chip" href="/outbox?state=delivered"${state === "delivered" ? ' aria-current="true"' : ""}>Delivered</a>
  </div>

  <div class="card">
    ${table({
      columns: [{ label: "To" }, { label: "Subject" }, { label: "Kind" }, { label: "State" },
                { label: "Blocked reason" }, { label: "Queued", align: "num" }],
      rows,
      empty: "Nothing has been queued.",
    })}
  </div>`;
}

/* -------------------------------------------------------------- accounts */

/**
 * @param {{accounts: any[], error: string|null}} data
 */
export function accountsPage({ accounts, error }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Trading accounts</h1>
      <p class="muted small">Metadata only. Balances live in the core and are never stored here (INV-184).</p>
    </div>
  </div>`;

  if (error) return `${head}${unavailable("Accounts", error)}`;

  const demo = accounts.filter((a) => a.mode === "demo").length;
  const rows = accounts.map((a) => `<tr>
    <td class="mono small">${esc(a.accountNumber)}</td>
    <td class="small truncate">
      ${a.ownerId && a.ownerId.includes("-") && a.email !== "(development identity)"
        ? `<a class="row-link" href="/users/${esc(a.ownerId)}">${esc(a.email)}</a>`
        : `<span class="muted">${esc(a.email)}</span>`}
    </td>
    <td class="small">${esc(a.nickname)}</td>
    <td class="small muted">${esc(a.accountType)} · ${esc(a.platform)}</td>
    <td>${a.mode === "demo" ? badge("demo", "accent") : badge("real", "warning")}</td>
    <td>${a.status === "active" ? badge("active", "positive") : badge("archived")}</td>
    <td class="num small muted">1:${esc(a.leverage)}</td>
    <td class="num small muted">${esc(ago(a.createdAt))}</td>
  </tr>`);

  return `${head}

  <div class="grid grid-3">
    ${kpi({ label: "Accounts", value: accounts.length })}
    ${kpi({ label: "Demo", value: demo })}
    ${kpi({ label: "Real", value: accounts.length - demo, note: "no payment rail is live" })}
  </div>

  <div class="section card">
    ${table({
      columns: [{ label: "Number" }, { label: "Owner" }, { label: "Nickname" }, { label: "Type" },
                { label: "Mode" }, { label: "Status" }, { label: "Leverage", align: "num" },
                { label: "Opened", align: "num" }],
      rows,
      empty: "No trading account has been opened.",
    })}
  </div>`;
}

/* ------------------------------------------------------------------ logs */

/**
 * @param {{service: string, sources: readonly string[], result: any}} data
 */
export function logsPage({ service, sources, result }) {
  /** Colour by level, read from the structured line where there is one. */
  const rendered = (result.lines ?? []).map((/** @type {string} */ line) => {
    const level = /"level":"(\w+)"/.exec(line)?.[1] ?? /\b(ERROR|WARN|INFO)\b/.exec(line)?.[1]?.toLowerCase() ?? "";
    const css = level === "error" ? "lvl-error" : level === "warn" ? "lvl-warn" : "lvl-info";
    return `<span class="log-line ${css}">${esc(line)}</span>`;
  }).join("");

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Logs</h1>
      <p class="muted small">${esc(result.source ? `Reading ${result.source}` : "No source")}</p>
    </div>
  </div>

  <div class="chips" style="margin-bottom:var(--s-4)">
    ${sources.map((name) => `<a class="chip" href="/logs?service=${encodeURIComponent(name)}"${
      name === service ? ' aria-current="true"' : ""
    }>${esc(name)}</a>`).join("")}
  </div>

  <div class="card card-pad">
    ${result.available
      ? (result.lines ?? []).length
        ? `<div class="log">${rendered}</div>`
        : `<div class="table-empty small">That log is empty.</div>`
      : unavailable(`Logs for ${service}`, result.error ?? "")}
  </div>`;
}
