/**
 * The console stylesheet, served at /styles.css.
 *
 * A deliberately different skin from the client area, on the same bones. The
 * spacing, radius and type scales are the ones `20-web` uses, because two
 * scales in one repository is how a design system stops being one — but the
 * palette is darker, denser and cooler, so that a screenshot of the console is
 * never mistaken for a screenshot of the product. An operator acting on the
 * wrong surface is the mistake this is trying to make impossible.
 *
 * Dark by default and light by choice, which is the opposite of the client
 * area, for the same reason.
 */

export const stylesheet = `
/* ============================================================ tokens */
:root {
  color-scheme: dark;

  --n-0:  #0b0d10;
  --n-25: #0e1116;
  --n-50: #12161c;
  --n-100:#171c24;
  --n-150:#1d232d;
  --n-200:#242b37;
  --n-300:#323b4a;
  --n-400:#4c5768;
  --n-500:#6b7789;
  --n-600:#8b96a7;
  --n-700:#aeb8c6;
  --n-800:#d3dae3;
  --n-900:#eef2f7;

  --bg:            var(--n-0);
  --bg-raised:     var(--n-50);
  --bg-sunken:     var(--n-25);
  --bg-hover:      var(--n-100);
  --bg-active:     var(--n-150);

  --text:          var(--n-900);
  --text-muted:    var(--n-600);
  --text-subtle:   var(--n-500);
  --text-inverse:  var(--n-0);

  --border:        var(--n-200);
  --border-strong: var(--n-300);

  --accent:        #4d8dff;
  --accent-hover:  #6ba0ff;
  --accent-soft:   #15243d;
  --accent-text:   #9cc2ff;

  --positive:      #3ecf8e;
  --positive-soft: #10291f;
  --warning:       #e0a33a;
  --warning-soft:  #2b2110;
  --danger:        #f2555a;
  --danger-soft:   #2e1416;

  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px;
  --s-5: 20px; --s-6: 24px; --s-8: 32px; --s-10: 40px;
  --s-12: 48px; --s-16: 64px;

  --r-sm: 5px; --r-md: 7px; --r-lg: 10px; --r-full: 999px;

  --shadow-menu: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.45);
  --shadow-modal: 0 8px 16px rgba(0,0,0,.35), 0 24px 56px rgba(0,0,0,.55);

  --tier-t0: #f2555a;
  --tier-t1: #e0a33a;
  --tier-t2: #b47ae0;
  --tier-t3: #4d8dff;
  --tier-t4: #3ecf8e;

  --sidebar-w: 232px;
  --topbar-h: 52px;
  --content-max: 1560px;

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
          Arial, "Noto Sans", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

:root[data-theme="light"] {
  color-scheme: light;
  --n-0:  #ffffff;
  --n-25: #fcfcfd;
  --n-50: #f7f8fa;
  --n-100:#f0f2f5;
  --n-150:#e6e9ee;
  --n-200:#dce0e7;
  --n-300:#c2c8d2;
  --n-400:#98a1af;
  --n-500:#6c7684;
  --n-600:#4d5663;
  --n-700:#343b46;
  --n-800:#1f242c;
  --n-900:#11151a;

  --bg:            var(--n-50);
  --bg-raised:     var(--n-0);
  --bg-sunken:     var(--n-100);
  --bg-hover:      var(--n-100);
  --bg-active:     var(--n-150);
  --text:          var(--n-900);
  --text-muted:    var(--n-500);
  --text-subtle:   var(--n-400);
  --text-inverse:  var(--n-0);
  --border:        var(--n-200);
  --border-strong: var(--n-300);

  --accent:        #2f5fe0;
  --accent-hover:  #2750c4;
  --accent-soft:   #eef2fe;
  --accent-text:   #1f47b3;
  --positive:      #0f7b47;
  --positive-soft: #e8f5ee;
  --warning:       #8a5a00;
  --warning-soft:  #fdf3e0;
  --danger:        #b3261e;
  --danger-soft:   #fdeceb;

  --shadow-menu: 0 1px 2px rgba(16,20,28,.06), 0 8px 24px rgba(16,20,28,.10);
  --shadow-modal: 0 8px 16px rgba(16,20,28,.08), 0 24px 56px rgba(16,20,28,.18);
}

/* ============================================================ reset */
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; padding: 0; }
[hidden] { display: none !important; }

html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--font);
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent-text); text-decoration: none; }
a:hover { text-decoration: underline; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; cursor: pointer; }
table { border-collapse: collapse; width: 100%; }
svg { display: block; }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0;
  margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ============================================================ type */
.h1 { font-size: 20px; font-weight: 640; letter-spacing: -.01em; line-height: 1.25; }
.h2 { font-size: 15.5px; font-weight: 620; letter-spacing: -.005em; }
.h3 { font-size: 13.5px; font-weight: 620; }
.small { font-size: 12.5px; }
.micro { font-size: 11.5px; }
.muted { color: var(--text-muted); }
.mono { font-family: var(--mono); font-size: .94em; }
.num { font-variant-numeric: tabular-nums; font-family: var(--mono); }
.eyebrow {
  font-size: 10.5px; font-weight: 640; letter-spacing: .07em;
  text-transform: uppercase; color: var(--text-subtle);
}
.grow { flex: 1; min-width: 0; }

/* A link that carries an icon beside its words. The icons are block-level
   SVGs, so without this the glyph sits on its own line above the text. */
a.small, .back-link {
  display: inline-flex; align-items: center; gap: var(--s-1);
}
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ============================================================ shell */
.app { display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }

.sidebar {
  position: sticky; top: 0; height: 100vh;
  display: flex; flex-direction: column;
  background: var(--bg-raised); border-right: 1px solid var(--border);
  padding: var(--s-4); gap: var(--s-1);
}
.brand { display: flex; align-items: center; gap: var(--s-3); margin-bottom: var(--s-5); }
.brand-mark {
  display: grid; place-items: center; width: 28px; height: 28px; flex: none;
  border-radius: var(--r-md); background: var(--accent); color: #fff;
  font-size: 11px; font-weight: 700; letter-spacing: .02em;
}
.brand-name { font-weight: 640; letter-spacing: -.01em; }
.brand-sub { font-size: 10.5px; color: var(--text-subtle); letter-spacing: .06em; text-transform: uppercase; }

.nav-item {
  display: flex; align-items: center; gap: var(--s-3);
  padding: var(--s-2) var(--s-3); border-radius: var(--r-sm);
  color: var(--text-muted); font-size: 13px; font-weight: 500;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); text-decoration: none; }
.nav-item[aria-current="page"] { background: var(--accent-soft); color: var(--accent-text); }
.nav-item .count {
  margin-left: auto; font-size: 11px; color: var(--text-subtle);
  font-variant-numeric: tabular-nums;
}
.nav-sep { height: 1px; background: var(--border); margin: var(--s-3) 0; }
.sidebar-foot { margin-top: auto; padding-top: var(--s-4); border-top: 1px solid var(--border); }

.main { min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; gap: var(--s-3);
  height: var(--topbar-h); padding: 0 var(--s-6);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.page { padding: var(--s-6); width: 100%; max-width: var(--content-max); }
.page-head { display: flex; align-items: flex-start; gap: var(--s-4); margin-bottom: var(--s-5); }
.page-head .h1 { margin-bottom: 2px; }
.section { margin-top: var(--s-6); }
.section-head { display: flex; align-items: center; gap: var(--s-3); margin-bottom: var(--s-3); }

/* ============================================================ surfaces */
.card {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--r-lg); overflow: hidden;
}
.card-pad { padding: var(--s-4) var(--s-5); }
.card-head {
  display: flex; align-items: center; gap: var(--s-3);
  padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--border);
}
.grid { display: grid; gap: var(--s-4); }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.grid-6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
.split { display: grid; gap: var(--s-4); grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); align-items: start; }

/* ---- KPI ---- */
.kpi { padding: var(--s-4); display: flex; flex-direction: column; gap: 2px; }
.kpi-label { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--text-subtle); }
.kpi-value { font-size: 22px; font-weight: 640; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.kpi-note { font-size: 11.5px; color: var(--text-muted); }
.kpi-value.is-positive { color: var(--positive); }
.kpi-value.is-warning { color: var(--warning); }
.kpi-value.is-danger { color: var(--danger); }

/* ---- table ---- */
.table-wrap { overflow-x: auto; }
.table th, .table td {
  padding: var(--s-2) var(--s-4); text-align: left;
  border-bottom: 1px solid var(--border); vertical-align: middle;
}
.table th {
  font-size: 10.5px; font-weight: 640; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-subtle); background: var(--bg-sunken); white-space: nowrap;
  position: sticky; top: 0;
}
.table tbody tr:hover { background: var(--bg-hover); }
.table tbody tr:last-child td { border-bottom: 0; }
.table td.num, .table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-empty { padding: var(--s-10); text-align: center; color: var(--text-muted); }
.row-link { color: var(--text); font-weight: 500; }

/* ---- badge ---- */
.badge {
  display: inline-flex; align-items: center; gap: var(--s-1);
  padding: 1px var(--s-2); border-radius: var(--r-full);
  font-size: 11px; font-weight: 600; letter-spacing: .01em;
  background: var(--bg-active); color: var(--text-muted); white-space: nowrap;
}
.badge-positive { background: var(--positive-soft); color: var(--positive); }
.badge-warning  { background: var(--warning-soft); color: var(--warning); }
.badge-danger   { background: var(--danger-soft); color: var(--danger); }
.badge-accent   { background: var(--accent-soft); color: var(--accent-text); }

.dot { width: 7px; height: 7px; border-radius: var(--r-full); background: var(--text-subtle); flex: none; }
.dot-positive { background: var(--positive); }
.dot-warning  { background: var(--warning); }
.dot-danger   { background: var(--danger); }

/* ---- tier ---- */
.tier {
  display: inline-flex; align-items: center; gap: var(--s-1);
  font-size: 11px; font-weight: 700; letter-spacing: .04em;
  padding: 1px var(--s-2); border-radius: var(--r-sm);
  border: 1px solid currentColor;
}
.tier-T0 { color: var(--tier-t0); }
.tier-T1 { color: var(--tier-t1); }
.tier-T2 { color: var(--tier-t2); }
.tier-T3 { color: var(--tier-t3); }
.tier-T4 { color: var(--tier-t4); }

/* ---- buttons ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--s-2);
  height: 30px; padding: 0 var(--s-3);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  font-size: 12.5px; font-weight: 550; white-space: nowrap;
  background: var(--bg-raised); color: var(--text);
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
.btn:hover { background: var(--bg-hover); border-color: var(--border-strong); text-decoration: none; }
.btn:active { transform: translateY(.5px); }
.btn[disabled], .btn[aria-disabled="true"] { opacity: .45; pointer-events: none; }
.btn-primary { background: var(--accent); border-color: transparent; color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-danger { background: var(--danger-soft); border-color: transparent; color: var(--danger); }
.btn-danger:hover { background: var(--danger); color: #fff; }
.btn-sm { height: 25px; padding: 0 var(--s-2); font-size: 11.5px; }
.btn-block { width: 100%; }
.btn-row { display: flex; flex-wrap: wrap; gap: var(--s-2); }

/* ---- forms ---- */
.field { display: block; margin-bottom: var(--s-4); }
.field > .label { display: block; font-size: 12px; font-weight: 600; margin-bottom: var(--s-2); }
.field > .hint { display: block; font-size: 11.5px; color: var(--text-muted); margin-top: var(--s-2); }
.input, .select {
  width: 100%; height: 32px; padding: 0 var(--s-3);
  background: var(--bg-sunken); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-sm);
}
.input:hover, .select:hover { border-color: var(--border-strong); }
.input:focus, .select:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.input::placeholder { color: var(--text-subtle); }
.select { appearance: none; padding-right: var(--s-8); cursor: pointer; }
.filter-bar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s-3); margin-bottom: var(--s-4); }
.filter-bar .field { margin-bottom: 0; }
.filter-bar .input, .filter-bar .select { width: auto; min-width: 180px; }

/* ---- chips ---- */
.chips { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.chip {
  display: inline-flex; align-items: center; gap: var(--s-1);
  padding: 2px var(--s-3); border-radius: var(--r-full);
  border: 1px solid var(--border); background: var(--bg-raised);
  font-size: 11.5px; color: var(--text-muted);
}
.chip:hover { border-color: var(--border-strong); color: var(--text); text-decoration: none; }
.chip[aria-current="true"] { background: var(--accent-soft); border-color: transparent; color: var(--accent-text); }

/* ---- notice ---- */
.notice {
  display: flex; gap: var(--s-3); padding: var(--s-3) var(--s-4);
  background: var(--bg-sunken); border: 1px solid var(--border);
  border-radius: var(--r-md); font-size: 12.5px;
}
.notice-icon { color: var(--text-muted); margin-top: 1px; flex: none; }
.notice-positive { border-color: var(--positive); }
.notice-positive .notice-icon { color: var(--positive); }
.is-negative { color: var(--danger); }
.inline { display: inline-flex; gap: var(--s-2); align-items: center; }
.card-foot { display: flex; gap: var(--s-2); justify-content: flex-end; padding: var(--s-3) var(--s-4); }
.notice-body { min-width: 0; flex: 1; }
.notice-title { font-weight: 600; margin-bottom: 2px; }
.notice-text { color: var(--text-muted); line-height: 1.55; }
.notice-danger { background: var(--danger-soft); border-color: transparent; }
.notice-danger .notice-icon, .notice-danger .notice-title { color: var(--danger); }
.notice-warning { background: var(--warning-soft); border-color: transparent; }
.notice-warning .notice-icon, .notice-warning .notice-title { color: var(--warning); }

/* ---- gate board ---- */
.gate-grid { display: grid; gap: var(--s-3); grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.gate {
  display: flex; flex-direction: column; gap: var(--s-2);
  padding: var(--s-4); border-radius: var(--r-lg);
  border: 1px solid var(--border); background: var(--bg-raised);
  border-left: 3px solid var(--border-strong);
}
.gate[data-state="passed"] { border-left-color: var(--positive); }
.gate[data-state="failed"] { border-left-color: var(--danger); }
.gate[data-state="stale"]  { border-left-color: var(--warning); }
.gate[data-state="running"] { border-left-color: var(--accent); }
.gate-head { display: flex; align-items: baseline; gap: var(--s-2); }
.gate-id { font-family: var(--mono); font-weight: 700; font-size: 13px; }
.gate-question { color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.gate-summary {
  font-family: var(--mono); font-size: 11.5px; color: var(--text-muted);
  background: var(--bg-sunken); padding: var(--s-2); border-radius: var(--r-sm);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gate-foot { display: flex; align-items: center; gap: var(--s-2); margin-top: auto; padding-top: var(--s-2); }

/* ---- log viewer ---- */
.log {
  font-family: var(--mono); font-size: 11.5px; line-height: 1.65;
  background: var(--n-0); color: var(--n-700);
  padding: var(--s-3); border-radius: var(--r-md);
  max-height: 640px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
.log .lvl-error { color: var(--danger); }
.log .lvl-warn { color: var(--warning); }
.log .lvl-info { color: var(--n-700); }
.log-line { display: block; }
.log-line:hover { background: var(--bg-hover); }

/* ---- definition rows ---- */
.rows { display: grid; }
.row {
  display: flex; align-items: center; gap: var(--s-4);
  padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--border);
}
.row:last-child { border-bottom: 0; }
.row-main { flex: 1; min-width: 0; }
.row-label { font-weight: 550; }
.row-detail { font-size: 12px; color: var(--text-muted); margin-top: 1px; }

/* ---- login ---- */
.login-shell { min-height: 100vh; display: grid; place-items: center; padding: var(--s-6); }
.login-card {
  width: 100%; max-width: 360px; padding: var(--s-8);
  background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--r-lg);
}
.login-card .brand { justify-content: flex-start; margin-bottom: var(--s-6); }

/* ---- toast ---- */
.toasts { position: fixed; right: var(--s-5); bottom: var(--s-5); z-index: 120; display: grid; gap: var(--s-2); }
.toast {
  display: flex; align-items: flex-start; gap: var(--s-3);
  min-width: 280px; max-width: 420px; padding: var(--s-3) var(--s-4);
  background: var(--n-150); color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md); box-shadow: var(--shadow-menu);
  font-size: 12.5px; animation: pop .16s ease;
}
.toast .close { color: inherit; opacity: .6; }
.toast .close:hover { opacity: 1; }
@keyframes pop { from { opacity: 0; transform: translateY(6px); } }

/* ---- misc ---- */
.bar { height: 4px; border-radius: var(--r-full); background: var(--bg-active); overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); }
.bar-fill.is-positive { background: var(--positive); }
.bar-fill.is-danger { background: var(--danger); }

.scroll-y { max-height: 420px; overflow-y: auto; }

@media (max-width: 1100px) {
  .grid-6, .grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split { grid-template-columns: 1fr; }
}

@media (max-width: 780px) {
  .app { grid-template-columns: 1fr; }
  .sidebar {
    position: static; height: auto; flex-direction: row; flex-wrap: wrap;
    align-items: center; border-right: 0; border-bottom: 1px solid var(--border);
  }
  .brand { margin-bottom: 0; margin-right: var(--s-4); }
  .nav-sep, .sidebar-foot { display: none; }
  .grid-6, .grid-4, .grid-3, .grid-2 { grid-template-columns: 1fr; }
  .page { padding: var(--s-4); }
}

@media (prefers-reduced-motion: reduce) {
  .toast { animation: none; }
  .btn, .nav-item, .chip { transition: none; }
}
`;
