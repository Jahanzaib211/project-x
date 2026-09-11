/**
 * G1/G4 — design-system guards for the stylesheet.
 *
 * These exist because a CSS-only defect once shipped: `.modal-backdrop` set
 * `display: grid`, which overrode the user-agent `[hidden] { display: none }`,
 * so the Open account dialog could never be closed. Nothing in the pipeline
 * rendered CSS, so every structural check passed while the page was broken.
 *
 * Each test below encodes one class of defect, not one instance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stylesheet as css } from "../src/ui/styles.js";

const clientSource = readFileSync(
  fileURLToPath(new URL("../src/client.js", import.meta.url)),
  "utf8",
);

/** Strip comments so they cannot satisfy or trip a check. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("the reset neutralises the hidden attribute", () => {
  // Author styles beat the user-agent stylesheet, so without an explicit rule
  // any component that sets `display` makes `el.hidden` inert.
  const rule = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(cssCode);
  assert.ok(
    rule,
    "styles.js must contain `[hidden] { display: none !important; }` — " +
      "without it, setting el.hidden = true does nothing to any element that has a display rule",
  );
});

test("no selector toggled via hidden also sets display", () => {
  // Which classes does the client toggle with the hidden attribute?
  const toggled = new Set();
  for (const match of clientSource.matchAll(/\$\(["'`]([^"'`]+)["'`]\)[^\n]*\.hidden\s*=/g)) {
    if (match[1]) toggled.add(match[1]);
  }
  for (const match of clientSource.matchAll(/["'`](\.[a-z-]+)["'`][^\n]*hidden/gi)) {
    if (match[1]) toggled.add(match[1]);
  }
  // Known hidden-toggled components, named explicitly so a rename is caught.
  for (const sel of [".modal-backdrop", ".menu"]) toggled.add(sel);

  const offenders = [];
  for (const selector of toggled) {
    if (!selector.startsWith(".")) continue;
    const name = selector.slice(1).split(/[\s\[:.]/)[0];
    if (!name) continue;
    // Find the rule block for this bare class and look for `display:`.
    const block = new RegExp(`(^|\\n)\\.${name}\\s*\\{([^}]*)\\}`, "m").exec(cssCode);
    const body = block?.[2] ?? "";
    if (/(^|;|\s)display\s*:/.test(body)) {
      const value = /display\s*:\s*([a-z-]+)/.exec(body)?.[1] ?? "?";
      offenders.push(`${selector} sets display:${value}`);
    }
  }

  // An offender is only a bug when the [hidden] reset is missing, but we keep
  // the list visible so the coupling stays obvious to whoever reads a failure.
  const hasReset = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(cssCode);
  assert.ok(
    hasReset || offenders.length === 0,
    `these components set display and are toggled via [hidden]: ${offenders.join(", ")}. ` +
      "Either drop the display declaration or keep the [hidden] reset.",
  );
});

test("every referenced CSS custom property is defined", () => {
  const defined = new Set();
  // Definitions appear several per line: `--s-1: 4px;  --s-2: 8px; ...`
  for (const match of cssCode.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);

  const referenced = new Set();
  for (const match of cssCode.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) referenced.add(match[1]);

  const orphans = [...referenced].filter((token) => !defined.has(token)).sort();
  assert.deepEqual(
    orphans, [],
    `undefined CSS custom propert${orphans.length === 1 ? "y" : "ies"}: ${orphans.join(", ")}. ` +
      "An undefined var() silently falls back to nothing, so the rule is dropped without an error.",
  );
});

test("dark theme redefines every colour token the light theme defines", () => {
  /** @param {string} selector */
  const block = (selector) => {
    const match = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(cssCode);
    return match?.[1] ?? "";
  };
  /** @param {string} text */
  const tokensIn = (text) =>
    new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? ""));

  const light = tokensIn(block(":root"));
  const dark = tokensIn(block(':root\\[data-theme="dark"\\]'));

  // Only colour-ish tokens must be re-stated; scales and fonts are shared.
  const colourish = [...light].filter((t) =>
    /^--(bg|text|border|accent|positive|warning|danger|n)-/.test(t) && !/^--n-/.test(t));

  const missing = colourish.filter((t) => !dark.has(t));
  assert.deepEqual(
    missing, [],
    `dark theme does not redefine: ${missing.join(", ")}. ` +
      "A colour defined only on :root keeps its light value in dark mode.",
  );
});

test("no duplicate custom-property definitions inside one theme block", () => {
  // A repeated token in the same block is a typo survivor: the second wins and
  // the first is dead. This caught a `--accent-soft: #172votes` paste error.
  for (const selector of [":root", ':root\\[data-theme="dark"\\]']) {
    const match = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(cssCode);
    if (!match) continue;
    const seen = new Map();
    for (const token of (match[1] ?? "").matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      const name = token[1] ?? "";
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
    assert.deepEqual(dupes, [], `${selector} defines ${dupes.join(", ")} more than once`);
  }
});

test("no colour is hardcoded outside the token blocks", () => {
  // Rules must consume tokens, not literals, or the dark theme silently misses them.
  const withoutTokenBlocks = cssCode
    .replace(/:root\s*\{[\s\S]*?\n\}/, "")
    .replace(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/, "");
  const literals = [...withoutTokenBlocks.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
  // rgba() scrims and the inline SVG data-URI arrow are deliberate exceptions.
  const offenders = literals.filter((c) => !/^#(fff|000)$/i.test(c) && !c.startsWith("#236"));
  assert.deepEqual(
    offenders, [],
    `hardcoded colour(s) outside the token blocks: ${[...new Set(offenders)].join(", ")}`,
  );
});

test("focus is never removed without a visible replacement", () => {
  // `outline: none` with nothing in its place is the single most common
  // accessibility regression in a design system. Removing it is fine — but only
  // when the same rule draws a focus indicator of its own, or when the rule is
  // the deliberate `:focus:not(:focus-visible)` suppression.
  const rules = [...cssCode.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const offenders = [];

  for (const rule of rules) {
    const selector = rule[1] ?? "";
    const body = rule[2] ?? "";
    if (!/outline:\s*(none|0)\b/.test(body)) continue;

    const isKeyboardSuppression = /:focus:not\(:focus-visible\)/.test(selector);
    const providesRing = /box-shadow:\s*[^;]*\b(0 0 0|inset)/.test(body)
      || /border-color:/.test(body)
      || /outline:\s*\d/.test(body);

    if (!isKeyboardSuppression && !providesRing) {
      offenders.push(selector.trim().replace(/\s+/g, " "));
    }
  }

  assert.deepEqual(
    offenders, [],
    `outline removed with no visible replacement in: ${offenders.join(" | ")}. ` +
      "Either keep the outline, draw a ring (box-shadow/border-color), or scope " +
      "the removal to :focus:not(:focus-visible).",
  );
});

test("reduced motion is honoured", () => {
  assert.match(
    cssCode, /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    "the stylesheet must neutralise animation for prefers-reduced-motion",
  );
});

test("no shimmer, skeleton or looping animation", () => {
  // Looping decoration is noise: it draws the eye repeatedly to something that
  // is not changing. One-shot entrance transitions are fine and are what the
  // dialog and menus use.
  const banned = /shimmer|skeleton|@keyframes\s+(pulse|shine|glow)/i.exec(cssCode);
  assert.equal(banned, null, `banned decorative effect: ${banned?.[0]}`);

  const looping = [...cssCode.matchAll(/animation:\s*([^;]+);/g)]
    .map((m) => m[1] ?? "")
    .filter((value) => /\binfinite\b|\balternate\b/.test(value));
  assert.deepEqual(looping, [], `looping animation(s): ${looping.join(", ")}`);
});

test("no gradient is used as decoration", () => {
  const gradients = [...cssCode.matchAll(/(linear|radial|conic)-gradient/g)].map((m) => m[0]);
  assert.deepEqual(gradients, [], `gradient(s) found: ${[...new Set(gradients)].join(", ")}`);
});

test("hover, focus and active states exist for interactive components", () => {
  // A component that only looks right at rest is half built.
  for (const selector of [".btn-primary", ".btn-secondary", ".nav-item", ".promo", ".account", ".icon-btn"]) {
    assert.ok(
      cssCode.includes(`${selector}:hover`),
      `${selector} has no :hover state`,
    );
  }
  assert.match(cssCode, /:focus-visible\s*\{/, "no global focus-visible ring is defined");
});

test("a height-constrained dialog can still reach its own footer", () => {
  // The defect this encodes: `.modal` capped its height and `.modal-body` was
  // `overflow-y: auto`, but the <form> wrapping head, body and foot was a plain
  // block. A block grows to its content, so the body never became scrollable and
  // the footer — holding the submit button — was pushed off-screen. The dialog
  // rendered perfectly and could not be submitted on any short viewport.
  //
  // Every link in the chain is asserted, because breaking any one of them
  // restores the bug while the others still look correct.
  const modal = /\.modal\s*\{([^}]*)\}/.exec(cssCode)?.[1] ?? "";
  assert.match(modal, /max-height:/, ".modal must cap its height");
  assert.match(modal, /flex-direction:\s*column/, ".modal must lay out as a column");

  const form = /\.modal\s*>\s*form\s*\{([^}]*)\}/.exec(cssCode)?.[1] ?? "";
  assert.ok(form, ".modal > form needs a rule, or the height constraint stops at it");
  assert.match(form, /display:\s*flex/, "the dialog's form must be a flex container");
  assert.match(form, /flex-direction:\s*column/, "the dialog's form must be a column");
  assert.match(form, /min-height:\s*0/, "without min-height:0 a flex item will not shrink below its content");

  const body = /\.modal-body\s*\{([^}]*)\}/.exec(cssCode)?.[1] ?? "";
  assert.match(body, /overflow-y:\s*auto/, ".modal-body must scroll");
  assert.match(body, /min-height:\s*0/, ".modal-body must be allowed to shrink");

  // The regions that must never scroll away.
  for (const region of ["modal-head", "modal-foot"]) {
    const rule = new RegExp(`\\.${region}\\s*\\{([^}]*)\\}`).exec(cssCode)?.[1] ?? "";
    assert.match(rule, /flex:\s*none/, `.${region} must not be allowed to shrink or grow`);
  }
});

test("a button whose label swaps for a busy state still aligns its icon", () => {
  // `.btn` is an inline-flex row, which aligns an icon beside its words. A
  // button that swaps its label for a "Signing in…" state wraps both in a span,
  // and that span becomes the flex item — so the icon inside falls back to
  // inline layout, lands on the text baseline, and renders above the label
  // instead of beside it. Both auth buttons shipped looking exactly like that.
  for (const slot of ["data-submit-label", "data-submit-busy"]) {
    const rule = new RegExp(`\\[${slot}\\][^{]*\\{([^}]*)\\}`).exec(cssCode)?.[1]
      ?? new RegExp(`\\[data-submit-label\\],\\s*\\.btn\\s*>\\s*\\[${slot}\\]\\s*\\{([^}]*)\\}`).exec(cssCode)?.[1]
      ?? "";
    assert.match(
      rule, /display:\s*inline-flex|display:\s*flex/,
      `[${slot}] must carry the button's flex alignment inwards`,
    );
    assert.match(rule, /align-items:\s*center/, `[${slot}] must centre its icon against the text`);
  }
});
