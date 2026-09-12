/**
 * G3 — the edge's money boundary, over generated input.
 *
 * `19-client-api` never turns money into a JavaScript number (INV-001 at the
 * edge, INV-180): an amount is accepted only as an exact decimal string, and
 * refused otherwise. These are properties over thousands of generated
 * strings — well-formed decimals of every width, and every mangling of one —
 * with a seed printed on failure so a case can be replayed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidAmount, requireAmount, HttpError } from "./money.js";

/**
 * A splitmix64-style generator: reproducible from its seed.
 * @param {number} seed
 */
function generator(seed) {
  let state = BigInt(seed);
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return Number((z ^ (z >> 31n)) & 0xffffffffn) / 0x100000000;
  };
}

const SEED = Number(process.env.PROPTEST_SEED ?? 0x19_01);
const CASES = 5_000;

/**
 * @param {string} name
 * @param {(random: () => number, pick: (n: number) => number) => string | null} property
 */
function forAll(name, property) {
  const random = generator(SEED);
  /** @param {number} n */
  const pick = (n) => Math.floor(random() * n);
  for (let i = 0; i < CASES; i += 1) {
    const failure = property(random, pick);
    if (failure !== null) {
      assert.fail(`PROPERTY FAILED: ${name}\n  case: ${i}\n  seed: ${SEED}\n  reason: ${failure}\n  Reproduce with: PROPTEST_SEED=${SEED} node --test src/money.test.js`);
    }
  }
}

const DIGITS = "0123456789";
/**
 * A well-formed amount: a canonical whole part (no leading zero, 1–18
 * digits, or a lone 0), optionally 1–8 decimals.
 * @param {(n: number) => number} pick
 */
function wellFormed(pick) {
  const length = 1 + pick(18);
  const whole = pick(12) === 0
    ? "0"
    : DIGITS[1 + pick(9)] + Array.from({ length: length - 1 }, () => DIGITS[pick(10)]).join("");
  if (pick(3) === 0) return whole;
  const frac = Array.from({ length: 1 + pick(8) }, () => DIGITS[pick(10)]).join("");
  return `${whole}.${frac}`;
}

test("INV-001: every well-formed decimal string is accepted verbatim and never becomes a number", () => {
  forAll("well-formed amounts", (_, pick) => {
    const text = wellFormed(pick);
    if (!isValidAmount(text)) return `${text} was refused`;
    const kept = requireAmount(text, "amount");
    if (kept !== text) return `${text} came back as ${kept}`;
    if (typeof kept !== "string") return `${text} became a ${typeof kept}`;
    return null;
  });
});

test("INV-001: every mangling of a decimal is refused with a 400, never coerced", () => {
  /** @type {Array<(s: string) => string>} */
  const manglings = [
    (s) => `-${s}`,
    (s) => `0${s}`,
    (s) => `+${s}`,
    (s) => `${s}e3`,
    (s) => ` ${s}`,
    (s) => `${s} `,
    (s) => `${s}.`,
    (s) => `.${s}`,
    (s) => s.replace(".", ",") === s ? `${s},00` : s.replace(".", ","),
    (s) => `${s}.${"0".repeat(9)}`,
    (s) => `${"1".repeat(19)}.00`,
    (s) => `0x${s}`,
    (s) => `${s}\n`,
    (s) => `${s}${String.fromCharCode(0x660 + 3)}`,
    () => "",
    () => "NaN",
    () => "Infinity",
    () => "1e308",
    () => "١٢٣",
  ];
  forAll("mangled amounts", (_, pick) => {
    const base = wellFormed(pick);
    const mangle = manglings[pick(manglings.length)] ?? ((s) => s);
    const mangled = mangle(base);
    if (isValidAmount(mangled)) return `${JSON.stringify(mangled)} was accepted`;
    try {
      requireAmount(mangled, "amount");
      return `${JSON.stringify(mangled)} passed requireAmount`;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400) return `${JSON.stringify(mangled)} threw ${String(error)}`;
    }
    return null;
  });
});

test("INV-001: a number is refused however it is spelled — the wire carries strings", () => {
  forAll("numbers", (random) => {
    const value = random() * 10 ** Math.floor(random() * 12);
    for (const candidate of [value, Math.round(value), -value, { amount: value }, [value], null, undefined, true]) {
      if (isValidAmount(candidate)) return `${JSON.stringify(candidate)} (a ${typeof candidate}) was accepted`;
    }
    return null;
  });
});
