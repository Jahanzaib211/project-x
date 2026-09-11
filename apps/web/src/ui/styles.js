/**
 * The stylesheet, served at /styles.css.
 *
 * Written as a design system rather than a pile of ad-hoc rules:
 *
 * - one 4px spacing scale, one type scale, one radius scale
 * - a neutral palette carrying the whole interface, with a single accent used
 *   only for state (active nav, links, focus) — never for decoration
 * - borders instead of shadows for structure; shadows only where something
 *   genuinely floats (menus, modals)
 * - every interactive element has hover, focus-visible, active and disabled
 *   states, because an interface that only looks right at rest is half built
 * - dark theme by token swap, so no rule is written twice
 */

export const stylesheet = `
/* ============================================================ tokens */
:root {
  color-scheme: light;

  /* Neutrals do the work. */
  --n-0:  #ffffff;
  --n-25: #fcfcfd;
  --n-50: #f7f8f9;
  --n-100:#f1f2f4;
  --n-150:#e8eaed;
  --n-200:#dfe1e6;
  --n-300:#c3c7ce;
  --n-400:#9aa1ac;
  --n-500:#6b7280;
  --n-600:#4b5261;
  --n-700:#343a45;
  --n-800:#22262e;
  --n-900:#14171c;

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

  /* One accent. State only, never decoration. */
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

  /* 4px scale. */
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px;
  --s-5: 20px; --s-6: 24px; --s-8: 32px; --s-10: 40px;
  --s-12: 48px; --s-16: 64px;

  --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-full: 999px;

  --shadow-menu: 0 1px 2px rgba(16,20,28,.06), 0 8px 24px rgba(16,20,28,.10);
  --shadow-modal: 0 8px 16px rgba(16,20,28,.08), 0 24px 56px rgba(16,20,28,.18);

  /* One hue per navigation section, so the sidebar reads as sections rather
     than one long list. Used on icons only — never on text or backgrounds,
     which is what keeps it informative instead of decorative. */
  --tint-trading:  #2f5fe0;
  --tint-payments: #0f7b47;
  --tint-insights: #6d45c7;
  --tint-benefits: #a35e00;
  --tint: var(--text-subtle);

  --sidebar-w: 264px;
  --topbar-h: 56px;
  --content-max: 1180px;

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
          Arial, "Noto Sans", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg:            #0e1014;
  --bg-raised:     #16191f;
  --bg-sunken:     #0a0c10;
  --bg-hover:      #1d212a;
  --bg-active:     #252a34;

  --text:          #e8eaee;
  --text-muted:    #99a1af;
  --text-subtle:   #6d7482;
  --text-inverse:  #0e1014;

  --border:        #262b34;
  --border-strong: #363c47;

  --accent:        #5b84f5;
  --accent-hover:  #7699f7;
  --accent-soft:   #16203a;
  --accent-text:   #a8bef9;

  --positive:      #4ac585;
  --positive-soft: #122a1f;
  --warning:       #e0a94a;
  --warning-soft:  #2a2113;
  --danger:        #f2837c;
  --danger-soft:   #2c1817;

  --shadow-menu: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.5);
  --shadow-modal: 0 8px 16px rgba(0,0,0,.4), 0 24px 56px rgba(0,0,0,.6);

  /* Lifted for contrast against the dark ground. */
  --tint-trading:  #6f93f7;
  --tint-payments: #4ac585;
  --tint-insights: #a98bf0;
  --tint-benefits: #e0a94a;
}

/* ============================================================ reset */
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
h1,h2,h3,h4,p,figure { margin: 0; }
ul,ol { margin: 0; padding: 0; list-style: none; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; cursor: pointer; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
svg { display: block; flex: none; }
table { border-collapse: collapse; width: 100%; }

/* The browser's own [hidden] rule lives in the user-agent stylesheet, and ANY
   author \`display\` declaration beats it regardless of specificity. Without this
   line, giving a component a display (\`.modal-backdrop { display: grid }\`)
   silently makes \`el.hidden = true\` inert — the attribute flips and nothing
   disappears. \`!important\` is deliberate: \`hidden\` states that the element is
   not rendered, and no component rule should be able to overrule that.
   Enforced by scripts/check_client_area_invariants.sh. */
[hidden] { display: none !important; }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}
:focus:not(:focus-visible) { outline: none; }

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ============================================================ type */
.h1 { font-size: 28px; line-height: 1.2; font-weight: 600; letter-spacing: -0.02em; }
.h2 { font-size: 20px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; }
.h3 { font-size: 15px; line-height: 1.4; font-weight: 600; }
.body { font-size: 14px; }
.small { font-size: 13px; }
.micro { font-size: 12px; }
.muted { color: var(--text-muted); }
.subtle { color: var(--text-subtle); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.num { font-variant-numeric: tabular-nums; }
.eyebrow {
  font-size: 11px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--text-subtle);
}

/* ============================================================ shell */
.app { display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100%; }
:root[data-rail="true"] { --sidebar-w: 64px; }

/* ---- topbar ---- */
.topbar {
  position: sticky; top: 0; z-index: 40;
  grid-column: 1 / -1;
  height: var(--topbar-h);
  display: flex; align-items: center; gap: var(--s-4);
  padding: 0 var(--s-5) 0 var(--s-6);
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: var(--s-3); font-weight: 600; letter-spacing: -0.01em; }
.brand:hover { text-decoration: none; }
.brand-mark {
  width: 26px; height: 26px; border-radius: 7px;
  background: var(--n-900); color: var(--n-0);
  display: grid; place-items: center;
  font-size: 13px; font-weight: 700; letter-spacing: -0.03em;
}
:root[data-theme="dark"] .brand-mark { background: var(--n-0); color: var(--n-900); }
.brand-name { color: var(--text); font-size: 15px; }

.topbar-spacer { flex: 1; }

.balance-chip {
  display: flex; align-items: center; gap: var(--s-2);
  height: 32px; padding: 0 var(--s-3);
  border: 1px solid var(--border); border-radius: var(--r-full);
  color: var(--text); font-size: 13px; font-weight: 500;
  transition: background .12s ease, border-color .12s ease;
}
.balance-chip:hover { background: var(--bg-hover); border-color: var(--border-strong); text-decoration: none; }

.icon-btn {
  position: relative;
  width: 32px; height: 32px; border-radius: var(--r-md);
  display: grid; place-items: center; color: var(--text-muted);
  transition: background .12s ease, color .12s ease;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn[aria-expanded="true"] { background: var(--bg-active); color: var(--text); }
.icon-btn .dot {
  position: absolute; top: 5px; right: 5px;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--danger); border: 1.5px solid var(--bg-raised);
}

/* ---- sidebar ---- */
.sidebar {
  position: sticky; top: var(--topbar-h);
  height: calc(100vh - var(--topbar-h));
  border-right: 1px solid var(--border);
  background: var(--bg-raised);
  display: flex; flex-direction: column;
  overflow-y: auto; overscroll-behavior: contain;
}
.nav { padding: var(--s-3) var(--s-3) var(--s-2); flex: 1; }
.nav-group + .nav-group { margin-top: var(--s-1); }
.nav-group-head {
  width: 100%;
  display: flex; align-items: center; gap: var(--s-3);
  height: 36px; padding: 0 var(--s-3);
  border-radius: var(--r-md);
  color: var(--text-muted); font-size: 13px; font-weight: 500;
  transition: background .12s ease, color .12s ease;
}
.nav-group-head:hover { background: var(--bg-hover); color: var(--text); }
.nav-group-head > svg { color: var(--tint); }
.nav-group-head .chev { margin-left: auto; transition: transform .16s ease; color: var(--text-subtle); }
.nav-group[data-open="false"] .chev { transform: rotate(-90deg); }
.nav-group[data-open="false"] .nav-items { display: none; }
.nav-items { padding: var(--s-1) 0 var(--s-2); }

.nav-item {
  position: relative;
  display: flex; align-items: center; gap: var(--s-3);
  height: 36px; padding: 0 var(--s-3) 0 var(--s-5);
  border-radius: var(--r-md);
  color: var(--text-muted); font-size: 13.5px;
  transition: background .12s ease, color .12s ease;
}
.nav-icon { display: grid; place-items: center; color: var(--text-subtle); transition: color .12s ease; }
.nav-item:hover { background: var(--bg-hover); color: var(--text); text-decoration: none; }
.nav-item:hover .nav-icon { color: var(--tint); }
.nav-item[aria-current="page"] {
  background: var(--bg-active); color: var(--text); font-weight: 500;
}
.nav-item[aria-current="page"] .nav-icon { color: var(--tint); }
/* A rail marking the active row, so the current page is findable without
   relying on the background alone. */
.nav-item[aria-current="page"]::before {
  content: ""; position: absolute; left: -4px; top: 8px; bottom: 8px;
  width: 2px; border-radius: 2px; background: var(--tint);
}
.nav-item .tag { margin-left: auto; }
.nav-item .ext { margin-left: auto; color: var(--text-subtle); }

.nav-cta {
  margin: var(--s-2) var(--s-3) var(--s-3);
  display: flex; align-items: center; gap: var(--s-3);
  padding: var(--s-3);
  border-radius: var(--r-md);
  background: var(--accent-soft); color: var(--accent-text);
  font-size: 13.5px; font-weight: 500; line-height: 1.35;
}
.nav-cta:hover { text-decoration: none; filter: brightness(.98); }

.sidebar-foot {
  position: sticky; bottom: 0;
  padding: var(--s-2) var(--s-3);
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
}
.collapse-btn {
  display: flex; align-items: center; gap: var(--s-3);
  width: 100%; height: 34px; padding: 0 var(--s-3);
  border-radius: var(--r-md); color: var(--text-subtle); font-size: 13px;
}
.collapse-btn:hover { background: var(--bg-hover); color: var(--text); }

/* Rail mode: icons only. */
:root[data-rail="true"] .nav-item,
:root[data-rail="true"] .nav-group-head { padding: 0; justify-content: center; }
:root[data-rail="true"] .nav-label,
:root[data-rail="true"] .chev,
:root[data-rail="true"] .tag,
:root[data-rail="true"] .nav-cta span,
:root[data-rail="true"] .collapse-btn span,
:root[data-rail="true"] .brand-name { display: none; }
:root[data-rail="true"] .nav-items { display: block; }
:root[data-rail="true"] .nav-item { padding-left: 0; gap: 0; }
:root[data-rail="true"] .nav-item[aria-current="page"]::before { left: 2px; }

/* ---- main ---- */
.main { min-width: 0; display: flex; flex-direction: column; }
.page { flex: 1; width: 100%; max-width: var(--content-max); margin: 0 auto; padding: var(--s-6) var(--s-8) var(--s-16); }
.page-head { display: flex; align-items: flex-start; gap: var(--s-4); margin-bottom: var(--s-6); }
.page-head .grow { flex: 1; min-width: 0; }
.page-head p { margin-top: var(--s-1); }

.section { margin-top: var(--s-10); }
.section-head { display: flex; align-items: center; gap: var(--s-3); margin-bottom: var(--s-4); }
.section-head .grow { flex: 1; }

/* Content beside a narrow supporting column (a form and its summary, details
   and their status). The aside collapses below the content rather than being
   squeezed, so the pair reflows instead of overflowing. The breakpoint is where
   a 300px column stops leaving the main column a usable measure. */
[data-responsive-split] {
  display: grid; gap: var(--s-6);
  grid-template-columns: minmax(0, 1fr) 300px;
  align-items: start;
}
@media (max-width: 860px) {
  [data-responsive-split] { grid-template-columns: minmax(0, 1fr); }
}

/* ============================================================ buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--s-2);
  height: 36px; padding: 0 var(--s-4);
  border: 1px solid transparent; border-radius: var(--r-md);
  font-size: 13.5px; font-weight: 500; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, color .12s ease, opacity .12s ease;
}
.btn:hover { text-decoration: none; }
.btn:active { transform: translateY(.5px); }
.btn[disabled], .btn[aria-disabled="true"] { opacity: .45; pointer-events: none; }

/* A button whose label swaps for a busy state wraps its contents in a span, so
   the span — not the icon and the words — becomes the flex item. Inside it the
   SVG falls back to inline layout and sits on the text baseline, which renders
   the glyph above the label rather than beside it. These carry the button's own
   alignment inwards. */
.btn > [data-submit-label], .btn > [data-submit-busy] {
  display: inline-flex; align-items: center; gap: var(--s-2);
}

.btn-primary { background: var(--n-900); color: var(--n-0); }
.btn-primary:hover { background: var(--n-800); }
:root[data-theme="dark"] .btn-primary { background: var(--n-0); color: var(--n-900); }
:root[data-theme="dark"] .btn-primary:hover { background: var(--n-150); }

.btn-secondary { background: var(--bg-raised); border-color: var(--border); color: var(--text); }
.btn-secondary:hover { background: var(--bg-hover); border-color: var(--border-strong); }

.btn-ghost { color: var(--text-muted); }
.btn-ghost:hover { background: var(--bg-hover); color: var(--text); }

.btn-sm { height: 30px; padding: 0 var(--s-3); font-size: 13px; }
.btn-lg { height: 42px; padding: 0 var(--s-5); font-size: 14px; }
.btn-block { width: 100%; }

/* ============================================================ controls */
.segmented {
  display: inline-flex; padding: 3px; gap: 2px;
  background: var(--bg-sunken); border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.segmented a, .segmented button {
  display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 var(--s-4); border-radius: 5px;
  font-size: 13.5px; font-weight: 500; color: var(--text-muted);
  transition: background .12s ease, color .12s ease;
}
.segmented a:hover, .segmented button:hover { color: var(--text); text-decoration: none; }
.segmented [aria-selected="true"] { background: var(--bg-raised); color: var(--text); box-shadow: 0 1px 2px rgba(16,20,28,.07); }
:root[data-theme="dark"] .segmented [aria-selected="true"] { box-shadow: none; border: 1px solid var(--border-strong); }

.viewtoggle { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; }
.viewtoggle button {
  width: 34px; height: 34px; display: grid; place-items: center; color: var(--text-muted);
  transition: background .12s ease, color .12s ease;
}
.viewtoggle button + button { border-left: 1px solid var(--border); }
.viewtoggle button:hover { background: var(--bg-hover); color: var(--text); }
.viewtoggle button[aria-pressed="true"] { background: var(--bg-active); color: var(--text); }

.field { display: block; margin-bottom: var(--s-4); }
.field > .label { display: block; font-size: 13px; font-weight: 500; margin-bottom: var(--s-2); }
.field > .hint { display: block; font-size: 12.5px; color: var(--text-muted); margin-top: var(--s-2); }

.input, .select {
  width: 100%; height: 38px; padding: 0 var(--s-3);
  background: var(--bg-raised); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-md);
  transition: border-color .12s ease, box-shadow .12s ease;
}
.input:hover, .select:hover { border-color: var(--border-strong); }
.input:focus, .select:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.input::placeholder { color: var(--text-subtle); }
.select { appearance: none; padding-right: var(--s-8);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right var(--s-3) center;
}
.input-affix { position: relative; }
.input-affix .affix {
  position: absolute; right: var(--s-3); top: 50%; transform: translateY(-50%);
  color: var(--text-muted); font-size: 13px; pointer-events: none;
}
.input-affix .input { padding-right: var(--s-12); }

/* Radio cards — choosing an account type is a real decision, so it gets
   real space rather than a dropdown. */
.choice-grid { display: grid; gap: var(--s-3); grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.choice {
  position: relative; display: block; cursor: pointer;
  padding: var(--s-4); border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg-raised);
  transition: border-color .12s ease, background .12s ease;
}
.choice:hover { border-color: var(--border-strong); }
.choice input { position: absolute; opacity: 0; pointer-events: none; }
.choice input:checked ~ .choice-body { color: var(--text); }
.choice:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.choice:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.choice-title { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); font-weight: 600; margin-bottom: var(--s-1); }
.choice-desc { font-size: 12.5px; color: var(--text-muted); line-height: 1.45; }
.choice-meta { margin-top: var(--s-3); padding-top: var(--s-3); border-top: 1px solid var(--border); display: grid; gap: var(--s-1); }
.choice-meta div { display: flex; justify-content: space-between; font-size: 12.5px; }
.choice-meta dt { color: var(--text-muted); }
.choice-meta dd { margin: 0; font-variant-numeric: tabular-nums; }

/* ============================================================ surfaces */
.card {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}
.card + .card { margin-top: var(--s-3); }
.card-pad { padding: var(--s-5); }

.badge {
  display: inline-flex; align-items: center; gap: 4px;
  height: 20px; padding: 0 var(--s-2);
  border-radius: var(--r-sm);
  background: var(--bg-sunken); border: 1px solid var(--border);
  font-size: 11.5px; font-weight: 500; color: var(--text-muted);
  white-space: nowrap;
}
.badge-accent { background: var(--accent-soft); border-color: transparent; color: var(--accent-text); }
.badge-positive { background: var(--positive-soft); border-color: transparent; color: var(--positive); }
.badge-warning { background: var(--warning-soft); border-color: transparent; color: var(--warning); }
.badge-danger { background: var(--danger-soft); border-color: transparent; color: var(--danger); }

/* Account type carries a hue so a list of accounts is scannable without
   reading every badge. Border only — a filled chip at this size fights the
   account number beside it for attention. */
.badge-type { color: var(--tint); border-color: color-mix(in srgb, var(--tint) 35%, var(--border)); }
.badge-type[data-type="Standard"] { --tint: var(--tint-trading); }
.badge-type[data-type="Pro"]      { --tint: var(--tint-insights); }
.badge-type[data-type="Zero"]     { --tint: var(--tint-payments); }
.badge-type[data-type="Raw"]      { --tint: var(--tint-benefits); }
.tag {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  border-radius: 4px; background: var(--accent-soft); color: var(--accent-text);
  font-size: 11px; font-weight: 600;
}

/* ---- account card ---- */
.account {
  display: grid; gap: var(--s-4);
  grid-template-columns: 1fr auto; align-items: center;
  padding: var(--s-5);
  transition: border-color .12s ease, background .12s ease;
}
.account:hover { border-color: var(--border-strong); background: var(--bg-hover); }
.account:hover .account-actions .btn-secondary { border-color: var(--border-strong); }
.account-main { min-width: 0; }
.account-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); margin-bottom: var(--s-3); }
.account-id { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.account-nick { color: var(--text-muted); }
.account-figure { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-3); }
.account-balance { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.account-balance.unavailable { font-size: 15px; font-weight: 500; color: var(--text-muted); }
.session-banner { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) var(--s-4); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--warning-soft); font-size: 13px; }
.account.account-new { outline: 2px solid var(--accent); outline-offset: 2px; transition: outline-color 1.2s ease; }
[data-funding-result][data-tone="ok"] { color: var(--positive); }
[data-funding-result][data-tone="error"] { color: var(--danger); }
.account-actions { display: flex; gap: var(--s-2); align-items: center; }

.accounts-grid { display: grid; gap: var(--s-3); grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.accounts-grid .account { grid-template-columns: 1fr; align-items: start; }
.accounts-grid .account-actions { width: 100%; }
.accounts-grid .account-actions .btn { flex: 1; }

/* ---- empty state ---- */
.empty { text-align: center; padding: var(--s-16) var(--s-6); }
.empty-icon {
  width: 44px; height: 44px; margin: 0 auto var(--s-4);
  border-radius: var(--r-lg); display: grid; place-items: center;
  background: var(--bg-sunken); color: var(--text-subtle);
  border: 1px solid var(--border);
}
.empty h3 { margin-bottom: var(--s-2); }
.empty p { color: var(--text-muted); max-width: 40ch; margin: 0 auto; }
.empty .btn { margin-top: var(--s-5); }

/* ---- notice: the gate state, shown honestly ---- */
.notice {
  display: flex; gap: var(--s-3); padding: var(--s-4);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg-raised);
}
.notice-icon { color: var(--text-muted); margin-top: 1px; }
.notice-body { min-width: 0; flex: 1; }
.notice-title { font-weight: 600; margin-bottom: 2px; }
.notice-text { color: var(--text-muted); font-size: 13px; }
.notice-warning { background: var(--warning-soft); border-color: transparent; }
.notice-warning .notice-icon, .notice-warning .notice-title { color: var(--warning); }
.notice-warning .notice-text { color: color-mix(in srgb, var(--warning) 80%, var(--text)); }

/* ---- table ---- */
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-raised); }
.table { font-size: 13.5px; }
.table thead th {
  text-align: left; font-weight: 500; font-size: 12.5px; color: var(--text-muted);
  padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--border);
  background: var(--bg-sunken); white-space: nowrap;
}
.table tbody td { padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--border); vertical-align: middle; }
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr:hover { background: var(--bg-hover); }
.table .num { text-align: right; }

/* ---- carousel ---- */
.promos { position: relative; margin-bottom: var(--s-8); }
/* A wrapping grid rather than a horizontal scroller. The scroller clipped the
   last card mid-content at common widths, which reads as a layout fault rather
   than an invitation to scroll. */
.promo-track {
  display: grid; gap: var(--s-3);
  grid-template-columns: repeat(auto-fit, minmax(248px, 1fr));
}
.promo {
  display: flex; align-items: center; gap: var(--s-4);
  padding: var(--s-4) var(--s-5); border-radius: var(--r-lg);
  background: var(--bg-raised); border: 1px solid var(--border);
  transition: border-color .12s ease;
}
.promo:hover {
  border-color: var(--border-strong); background: var(--bg-hover);
  text-decoration: none; transform: translateY(-1px);
}
.promo:active { transform: translateY(0); }
.promo:hover .promo-art { color: var(--tint); border-color: currentColor; }
.promo-body { min-width: 0; flex: 1; }
/* Both are <span>, which is inline by default — without this the title and the
   body text render on one run-on line. */
.promo-title { display: block; font-weight: 600; color: var(--text); margin-bottom: 2px; }
.promo-text { display: block; font-size: 12.5px; color: var(--text-muted); line-height: 1.4; }
.promo-art {
  width: 40px; height: 40px; border-radius: var(--r-md);
  display: grid; place-items: center;
  background: var(--bg-sunken); color: var(--text-muted);
  border: 1px solid transparent;
  transition: color .12s ease, border-color .12s ease;
}
/* Each promo carries its own hue, so four cards in a row are distinguishable
   at a glance rather than four identical grey chips. */
.promo:nth-child(1) { --tint: var(--tint-benefits); }
.promo:nth-child(2) { --tint: var(--tint-trading); }
.promo:nth-child(3) { --tint: var(--tint-insights); }
.promo:nth-child(4) { --tint: var(--tint-payments); }

/* ---- stat row ---- */
.stats { display: grid; gap: var(--s-3); grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.stat { padding: var(--s-4) var(--s-5); transition: border-color .12s ease; }
.stat:hover { border-color: var(--border-strong); }
.stat-label { font-size: 12.5px; color: var(--text-muted); margin-bottom: var(--s-2); }
.stat-value { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat-value.na { font-size: 15px; font-weight: 500; color: var(--text-subtle); }
.stat-sub { font-size: 12.5px; color: var(--text-subtle); margin-top: var(--s-1); }

/* ---- modal ---- */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(16,20,28,.44);
  display: grid; place-items: center; padding: var(--s-5);
  animation: fade .12s ease;
}
.modal {
  width: 100%; max-width: 620px; max-height: calc(100vh - var(--s-12));
  display: flex; flex-direction: column;
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--r-lg); box-shadow: var(--shadow-modal);
  animation: pop .14s cubic-bezier(.2,.8,.3,1);
}
/* The dialog's <form> sits between .modal and its three regions, so it has to
   be a column flex container as well. As a plain block it grew to its content
   height, .modal's max-height clipped nothing, .modal-body never became
   scrollable, and .modal-foot — which holds the submit button — was pushed
   below the viewport with no way to scroll to it. The dialog rendered
   perfectly and could not be submitted on any screen shorter than its content.
   min-height:0 is the part that actually lets the body shrink: a flex item
   defaults to min-height:auto, which refuses to go below its content size. */
.modal > form { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.modal-head { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-5); border-bottom: 1px solid var(--border); flex: none; }
.modal-head .grow { flex: 1; }
.modal-body { padding: var(--s-5); overflow-y: auto; flex: 1; min-height: 0; }
.modal-foot { display: flex; justify-content: flex-end; gap: var(--s-2); padding: var(--s-4) var(--s-5); border-top: 1px solid var(--border); flex: none; }
@keyframes fade { from { opacity: 0 } }
@keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.99) } }

/* ---- menu ---- */
.menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 60;
  min-width: 220px; padding: var(--s-1);
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--r-md); box-shadow: var(--shadow-menu);
  animation: pop .1s ease;
}
.menu-item {
  display: flex; align-items: center; gap: var(--s-3); width: 100%;
  padding: var(--s-2) var(--s-3); border-radius: var(--r-sm);
  font-size: 13.5px; color: var(--text); text-align: left;
}
.menu-item:hover { background: var(--bg-hover); text-decoration: none; }
.menu-sep { height: 1px; background: var(--border); margin: var(--s-1) 0; }
.menu-head { padding: var(--s-3); border-bottom: 1px solid var(--border); margin-bottom: var(--s-1); }
.has-menu { position: relative; }

/* ---- toast ---- */
.toasts { position: fixed; right: var(--s-5); bottom: var(--s-5); z-index: 120; display: grid; gap: var(--s-2); }
.toast {
  display: flex; align-items: flex-start; gap: var(--s-3);
  min-width: 280px; max-width: 380px; padding: var(--s-3) var(--s-4);
  background: var(--n-900); color: var(--n-0);
  border-radius: var(--r-md); box-shadow: var(--shadow-menu);
  font-size: 13.5px; animation: pop .16s ease;
}
:root[data-theme="dark"] .toast { background: var(--n-150); color: var(--n-900); }
.toast .close { color: inherit; opacity: .6; }
.toast .close:hover { opacity: 1; }

/* ---- footer ---- */
/* ============================================================ footer */
/* Three bands. Each rule spans the viewport while its content lines up with
   .page at --content-max — without the inner wrapper the footer text would
   start at the far left of a centred layout. */
.footer { margin-top: var(--s-12); background: var(--bg-raised); }
.footer-band { border-top: 1px solid var(--border); }
.footer-inner { width: 100%; max-width: var(--content-max); margin: 0 auto; padding: 0 var(--s-8); }

.footer-top {
  display: grid; gap: var(--s-8);
  grid-template-columns: minmax(220px, 280px) 1fr;
  padding-top: var(--s-10); padding-bottom: var(--s-10);
}
.footer-brand { display: grid; gap: var(--s-3); align-content: start; }
.footer-brand p { font-size: 12.5px; line-height: 1.6; color: var(--text-muted); max-width: 34ch; }
.footer-status {
  display: inline-flex; align-items: center; gap: var(--s-2);
  font-size: 12.5px; color: var(--text-muted); width: fit-content;
}
.footer-status:hover { color: var(--text); text-decoration: none; }
.footer-status-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--positive);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--positive) 20%, transparent);
}

.footer-cols { display: grid; gap: var(--s-6); grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.footer-heading {
  font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text); margin-bottom: var(--s-3);
}
.footer-col ul { display: grid; gap: var(--s-2); }
.footer-col a { font-size: 13px; color: var(--text-muted); }
.footer-col a:hover { color: var(--text); text-decoration: none; }

/* The disclosure band. Denser type and a muted ground so it reads as legal
   copy rather than another navigation row. */
.footer-risk { padding: var(--s-6) var(--s-8); display: grid; gap: var(--s-3); background: var(--bg-sunken); }
.footer-risk p { font-size: 12px; line-height: 1.65; color: var(--text-subtle); max-width: 108ch; }
.footer-risk strong { color: var(--text-muted); font-weight: 600; }

.footer-bottom {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-3) var(--s-5);
  padding: var(--s-4) var(--s-8);
}
.footer-copy { font-size: 12px; color: var(--text-subtle); flex: 1; min-width: 260px; }
.footer-mini { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-4); }
.footer-mini a { font-size: 12px; color: var(--text-subtle); }
.footer-mini a:hover { color: var(--text-muted); text-decoration: none; }

/* ============================================================ documents */
.crumbs { display: flex; align-items: center; gap: var(--s-2); font-size: 12.5px; color: var(--text-subtle); margin-bottom: var(--s-2); }
.crumbs a { color: var(--text-muted); }

.doc { max-width: 78ch; }
.doc-section + .doc-section { margin-top: var(--s-6); }
.doc-section h2 { margin-bottom: var(--s-2); }
.doc-section p { color: var(--text-muted); line-height: 1.7; }

.doc-toc { position: sticky; top: calc(var(--topbar-h) + var(--s-5)); }
.doc-toc ol { display: grid; gap: var(--s-2); counter-reset: toc; }
.doc-toc a { font-size: 12.5px; color: var(--text-muted); }
.doc-toc a:hover { color: var(--text); text-decoration: none; }

.doc-grid { display: grid; gap: var(--s-3); grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.doc-card {
  display: flex; align-items: flex-start; gap: var(--s-3);
  transition: border-color .12s ease, background .12s ease;
}
.doc-card:hover { border-color: var(--border-strong); background: var(--bg-hover); text-decoration: none; }
.doc-card:hover .doc-card-chev { color: var(--text); transform: translateX(2px); }
.doc-card-icon { color: var(--text-subtle); margin-top: 1px; }
.doc-card-body { flex: 1; min-width: 0; }
.doc-card-title { display: block; font-weight: 600; color: var(--text); margin-bottom: 2px; }
.doc-card-text { display: block; font-size: 12.5px; color: var(--text-muted); line-height: 1.45; }
.doc-card-chev { color: var(--text-subtle); transition: color .12s ease, transform .12s ease; }

/* ============================================================ platforms */
.platform-card { display: flex; flex-direction: column; }
.platform-head { display: flex; align-items: flex-start; gap: var(--s-3); }
.platform-icon {
  width: 36px; height: 36px; border-radius: var(--r-md); flex: none;
  display: grid; place-items: center;
  background: var(--bg-sunken); color: var(--text-muted);
}
.platform-card .btn { margin-top: auto; align-self: flex-start; }

/* ============================================================ api */
.code-block {
  padding: var(--s-3) var(--s-4); border-radius: var(--r-md);
  background: var(--bg-sunken); border: 1px solid var(--border);
  font-size: 13px; overflow-x: auto; white-space: nowrap;
}
.endpoint {
  display: flex; align-items: center; gap: var(--s-3);
  padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--border);
}
.endpoint:last-child { border-bottom: 0; }
.endpoint:hover { background: var(--bg-hover); }
.endpoint-path { font-size: 13px; color: var(--text); }
.endpoint-desc { flex: 1; min-width: 0; }

/* ============================================================ rows */
.verify-row, .notif-row {
  display: flex; align-items: center; gap: var(--s-4);
  padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--border);
}
.verify-row:last-child, .notif-row:last-child { border-bottom: 0; }
.verify-row:hover, .notif-row:hover { background: var(--bg-hover); }
.notif-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
.notif-dot.positive { background: var(--positive); }

/* ============================================================ responsive */
@media (max-width: 1000px) {
  .app { grid-template-columns: 1fr; }
  .sidebar {
    position: fixed; top: var(--topbar-h); left: 0; z-index: 50;
    width: var(--sidebar-w); transform: translateX(-100%);
    transition: transform .18s ease;
  }
  .app[data-drawer="open"] .sidebar { transform: none; }
  .app[data-drawer="open"]::after {
    content: ""; position: fixed; inset: var(--topbar-h) 0 0; z-index: 45;
    background: rgba(16,20,28,.4);
  }
  .page { padding: var(--s-5) var(--s-4) var(--s-12); }
  .menu-toggle { display: grid !important; }
}
@media (min-width: 1001px) { .menu-toggle { display: none !important; } }

@media (max-width: 640px) {
  .h1 { font-size: 22px; }
  .account { grid-template-columns: 1fr; align-items: stretch; }
  .account-actions .btn { flex: 1; }
  .page-head { flex-direction: column; }
  .footer-inner { padding-left: var(--s-4); padding-right: var(--s-4); }
  .footer-top { grid-template-columns: 1fr; gap: var(--s-6); padding-top: var(--s-8); padding-bottom: var(--s-8); }
  .footer-risk, .footer-bottom { padding-left: var(--s-4); padding-right: var(--s-4); }
  .doc-toc { position: static; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}

/* ---------------------------------------------------------------- terminal */
/* The trading terminal. Two columns on a desktop — chart and ticket — with the
   blotters full width beneath, collapsing to one column on a narrow screen.
   The chart is given a fixed aspect rather than a fixed height so it stays
   readable when the window is short. */

.terminal { display: block; }
.terminal-account { min-width: 260px; }
.terminal-account .label { display: block; font-size: 13px; font-weight: 500; margin-bottom: var(--s-2); }

.terminal-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--s-4);
  align-items: start;
}

.chart-card { overflow: hidden; }
.chart-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border);
}
.chart-symbol .select { min-width: 240px; }

.quote-strip { display: flex; gap: var(--s-4); margin-left: auto; }
.quote-side { display: flex; flex-direction: column; align-items: flex-end; min-width: 74px; }
.quote-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
.quote-price { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.quote-bid .quote-price { color: var(--danger); }
.quote-ask .quote-price { color: var(--positive); }

/* A price that just moved gets a brief wash of colour. Transitions are the
   only animation here, so prefers-reduced-motion switches it off entirely. */
.quote-price[data-move="up"] { color: var(--positive); }
.quote-price[data-move="down"] { color: var(--danger); }

.interval-picker { display: flex; gap: 2px; background: var(--bg-sunken); padding: 2px; border-radius: var(--r-md); }
.interval-btn {
  border: 0; background: transparent; color: var(--text-muted);
  font: inherit; font-size: 12.5px; font-weight: 500;
  padding: var(--s-1) var(--s-3); border-radius: var(--r-sm); cursor: pointer;
}
.interval-btn:hover { color: var(--text); }
.interval-btn[aria-pressed="true"] { background: var(--bg-raised); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }

.chart-host { position: relative; aspect-ratio: 24 / 10; min-height: 300px; }
.chart-host canvas { display: block; width: 100%; height: 100%; }
.chart-empty {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: var(--bg-raised);
}
.chart-host[data-candles]:not([data-candles="0"]) .chart-empty { display: none; }

/* ------------------------------------------------------------------ ticket */

.ticket-title { margin-bottom: var(--s-4); }
.ticket-actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2); margin-bottom: var(--s-3); }
.ticket-actions .btn { flex-direction: column; gap: 2px; padding: var(--s-3); height: auto; }
.ticket-side { font-size: 13px; font-weight: 600; }
.ticket-price { font-size: 15px; font-variant-numeric: tabular-nums; opacity: 0.92; }
.btn-buy { background: var(--positive); color: #fff; border-color: transparent; }
.btn-buy:hover { filter: brightness(1.06); }
.btn-sell { background: var(--danger); color: #fff; border-color: transparent; }
.btn-sell:hover { filter: brightness(1.06); }
.ticket-note { min-height: 2.4em; display: block; }
.ticket-note[data-tone="error"] { color: var(--danger); }
.ticket-note[data-tone="ok"] { color: var(--positive); }

.summary {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2);
  margin: var(--s-4) 0 var(--s-2);
  padding-top: var(--s-4); border-top: 1px solid var(--border);
}
.tile { display: flex; flex-direction: column; gap: 2px; }
.tile-label { font-size: 11.5px; color: var(--text-muted); }
.tile-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; font-family: var(--mono); }

/* ----------------------------------------------------------------- blotter */

.blotter { margin-top: var(--s-4); }
.blotter-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--border);
}
.table-scroll { overflow-x: auto; }
.figure-up { color: var(--positive); }
.figure-down { color: var(--danger); }

@media (max-width: 1080px) {
  .terminal-grid { grid-template-columns: 1fr; }
  .quote-strip { margin-left: 0; width: 100%; justify-content: space-between; }
  .chart-symbol .select { min-width: 0; width: 100%; }
}

/* ============================================================ identity */
/* The signed-out screens. A separate shell rather than the app shell with
   pieces hidden: a sidebar full of links that all bounce to /login is worse
   than no sidebar, and "hide the parts that do not apply" is how a layout ends
   up with six mutually exclusive modifiers. */

.auth-body { background: var(--bg); }
.auth-shell { min-height: 100vh; display: flex; flex-direction: column; }
.auth-topbar {
  display: flex; align-items: center; gap: var(--s-2);
  height: var(--topbar-h); padding: 0 var(--s-5);
  border-bottom: 1px solid var(--border); background: var(--bg-raised);
}
.auth-page { flex: 1; width: 100%; max-width: var(--content-max); margin: 0 auto; padding: var(--s-10) var(--s-6); }

/* The form and the panel beside it. The panel is the first thing to go on a
   narrow screen — it is context, and the form is the task. */
.auth-split { display: grid; gap: var(--s-10); grid-template-columns: minmax(0, 1fr) minmax(0, 420px); align-items: start; }
.auth-main { min-width: 0; max-width: 460px; justify-self: center; width: 100%; }
.auth-card-wide { max-width: none; }
.auth-card {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: var(--s-8);
}
.auth-head { margin-bottom: var(--s-6); }
.auth-head .brand-mark { margin-bottom: var(--s-4); }
.auth-head .h1 { margin-bottom: var(--s-2); }
.auth-form { margin-top: var(--s-5); }
.auth-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--s-4); margin: var(--s-2) 0 var(--s-5);
}
.auth-alt { margin-top: var(--s-5); text-align: center; font-size: 13.5px; color: var(--text-muted); }
.auth-foot { margin-top: var(--s-5); }
.auth-foot.micro { text-align: center; line-height: 1.6; }

/* Two fields on one row where they are genuinely one decision (country and
   the currency that follows from it), and stacked everywhere narrower. */
.field-pair { display: grid; gap: var(--s-4); grid-template-columns: 1fr 1fr; }

.auth-aside { position: sticky; top: var(--s-8); }
.auth-aside-inner {
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: var(--s-8);
}
.auth-aside-inner .h2 { margin-bottom: var(--s-3); }
.auth-points { list-style: none; display: grid; gap: var(--s-5); margin: var(--s-6) 0 0; padding: 0; }
.auth-points li { display: flex; gap: var(--s-4); align-items: flex-start; }
.auth-point-icon {
  display: grid; place-items: center; flex: none;
  width: 34px; height: 34px; border-radius: var(--r-md);
  background: var(--bg-sunken); color: var(--text-muted);
}
.auth-point-title { font-weight: 600; font-size: 13.5px; margin-bottom: 2px; }
.auth-point-text { color: var(--text-muted); font-size: 13px; line-height: 1.6; margin: 0; }
.auth-aside-link {
  display: inline-flex; align-items: center; gap: var(--s-2);
  margin-top: var(--s-6); font-size: 13px; color: var(--text-muted);
}

/* ---- errors ---- */
/* Two levels, deliberately. The form-level banner is for "those credentials do
   not match" — a failure that belongs to no single field. The field-level one
   is for "this address is not an address", which belongs to exactly one. A
   design that only has the banner makes people hunt for which box is wrong. */
.form-error {
  display: flex; align-items: flex-start; gap: var(--s-3);
  padding: var(--s-3) var(--s-4); margin-bottom: var(--s-5);
  background: var(--danger-soft); border-radius: var(--r-md);
  color: var(--danger); font-size: 13.5px; line-height: 1.55;
}
.form-error-icon { flex: none; margin-top: 1px; }
.field-error { margin: var(--s-2) 0 0; font-size: 12.5px; color: var(--danger); line-height: 1.5; }
.input[aria-invalid="true"], .select[aria-invalid="true"] { border-color: var(--danger); }
.input[aria-invalid="true"]:focus, .select[aria-invalid="true"]:focus {
  border-color: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft);
}

.notice-quiet { background: var(--bg-sunken); border-color: transparent; }

/* ---- checkbox ---- */
.check { display: inline-flex; align-items: center; gap: var(--s-2); font-size: 13.5px; cursor: pointer; }
.check input { width: 16px; height: 16px; flex: none; accent-color: var(--accent); cursor: pointer; }
.check-block { align-items: flex-start; line-height: 1.55; }
.check-block input { margin-top: 2px; }
.check-block span { color: var(--text-muted); }

/* ---- reveal toggle ---- */
.affix-btn {
  display: grid; place-items: center; width: 32px; height: 32px;
  border-radius: var(--r-sm); color: var(--text-subtle); background: none; border: 0; cursor: pointer;
}
.affix-btn:hover { color: var(--text); background: var(--bg-hover); }

/* A one-time code is read back digit by digit, so it gets the mono face and
   room to breathe rather than the prose stack. */
.input-code { font-family: var(--mono); font-size: 17px; letter-spacing: .22em; text-align: center; }

/* ---- password meter ---- */
.pw-meter { display: grid; gap: var(--s-2); margin-top: var(--s-3); }
.pw-meter-track { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.pw-meter-seg { height: 4px; border-radius: var(--r-full); background: var(--bg-active); transition: background .18s ease; }
.pw-meter[data-score="1"] .pw-meter-seg[data-seg="0"] { background: var(--danger); }
.pw-meter[data-score="2"] .pw-meter-seg[data-seg="0"],
.pw-meter[data-score="2"] .pw-meter-seg[data-seg="1"] { background: var(--warning); }
.pw-meter[data-score="3"] .pw-meter-seg[data-seg="0"],
.pw-meter[data-score="3"] .pw-meter-seg[data-seg="1"],
.pw-meter[data-score="3"] .pw-meter-seg[data-seg="2"] { background: var(--accent); }
.pw-meter[data-score="4"] .pw-meter-seg { background: var(--positive); }

.pw-rules { list-style: none; margin: var(--s-3) 0 0; padding: 0; display: grid; gap: var(--s-2); }
.pw-rules li { display: flex; align-items: center; gap: var(--s-2); font-size: 12.5px; color: var(--text-muted); }
.pw-rule-mark {
  display: grid; place-items: center; flex: none; width: 16px; height: 16px;
  border-radius: var(--r-full); border: 1px solid var(--border-strong);
  color: transparent; transition: all .15s ease;
}
.pw-rules li[data-met="true"] { color: var(--text); }
.pw-rules li[data-met="true"] .pw-rule-mark {
  background: var(--positive); border-color: var(--positive); color: var(--n-0);
}

/* ---- avatar ---- */
.topbar-auth { display: flex; align-items: center; gap: var(--s-2); }
.avatar-btn { padding: 0; }
.avatar {
  display: grid; place-items: center; width: 28px; height: 28px;
  border-radius: var(--r-full); background: var(--n-900); color: var(--n-0);
  font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
}
:root[data-theme="dark"] .avatar { background: var(--n-0); color: var(--n-900); }

/* ---- security screen ---- */
.plain-list { margin: 0; padding-left: var(--s-5); display: grid; gap: var(--s-3); color: var(--text-muted); font-size: 13.5px; line-height: 1.6; }
.plain-list strong { color: var(--text); font-weight: 600; }

.setting-row {
  display: flex; align-items: center; gap: var(--s-4);
  padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--border);
}
.setting-row:last-child { border-bottom: 0; }
.setting-main { flex: 1; min-width: 0; }
.setting-label { font-weight: 500; }
.setting-detail { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

.session-device { display: flex; align-items: center; gap: var(--s-3); }
.session-icon { color: var(--text-subtle); flex: none; }

/* Recovery codes are transcribed by hand or printed, so they get a grid with
   real spacing rather than a wrapped paragraph of hex. */
.code-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--s-2);
  padding: var(--s-4); background: var(--bg-sunken); border-radius: var(--r-md);
  font-family: var(--mono); font-size: 13.5px; letter-spacing: .04em;
}
.code-grid span { padding: var(--s-1) var(--s-2); }

.totp-secret {
  display: block; padding: var(--s-3) var(--s-4); margin: var(--s-3) 0;
  background: var(--bg-sunken); border-radius: var(--r-md);
  font-family: var(--mono); font-size: 14px; letter-spacing: .12em; word-break: break-all;
}

@media (max-width: 940px) {
  /* The panel is context; the form is the task. Context goes second. */
  .auth-split { grid-template-columns: 1fr; gap: var(--s-6); }
  .auth-aside { position: static; order: 2; }
  .auth-main { max-width: 520px; }
}

@media (max-width: 560px) {
  .auth-page { padding: var(--s-5) var(--s-4); }
  .auth-card, .auth-aside-inner { padding: var(--s-5); }
  .field-pair { grid-template-columns: 1fr; }
  .code-grid { grid-template-columns: 1fr; }
  .auth-row { flex-wrap: wrap; gap: var(--s-2); }
}

@media (prefers-reduced-motion: reduce) {
  .quote-price { transition: none; }
  .pw-meter-seg, .pw-rule-mark { transition: none; }
}
`;
