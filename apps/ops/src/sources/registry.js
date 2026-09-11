/**
 * The module registry and the gate matrix, read from the repository.
 *
 * `registry/modules.yaml` is already the single source of truth for the
 * dependency graph, the gate matrix and the generated docs. The console reads
 * the same file rather than keeping its own copy, so a module added there
 * appears here without anybody remembering to.
 *
 * ## The parser
 *
 * A deliberately small YAML subset — mappings, sequences, block scalars,
 * quoted strings — sufficient for this one file and nothing else. The
 * alternative was a dependency, and this console has none; the registry is
 * validated by `scripts/check_dag.py` on every commit, so it cannot drift into
 * shapes this does not handle without that failing first.
 *
 * If it ever needs more than this, the answer is to read the JSON that
 * `gen_docs.py` could emit, not to grow a YAML implementation here.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root, from apps/ops/src/sources. */
export const REPO_ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../../../..");

/**
 * Parse the subset of YAML this file uses.
 *
 * Indentation-driven, like the real thing. Returns plain objects and arrays.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseYaml(text) {
  /** @type {string[]} */
  const lines = [];
  for (const raw of text.split("\n")) {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === "") continue;
    lines.push(withoutComment.replace(/\s+$/, ""));
  }

  let index = 0;

  /** @param {string} line */
  const indentOf = (line) => line.length - line.trimStart().length;

  /**
   * Parse a block at one indentation level.
   * @param {number} indent
   * @returns {any}
   */
  function parseBlock(indent) {
    // A sequence: every line at this level starts with "- ".
    if (index < lines.length && indentOf(String(lines[index])) === indent
        && String(lines[index]).trimStart().startsWith("- ")) {
      /** @type {any[]} */
      const items = [];
      while (index < lines.length) {
        const line = String(lines[index]);
        if (indentOf(line) !== indent || !line.trimStart().startsWith("- ")) break;
        index += 1;

        const rest = line.trimStart().slice(2);
        if (rest.includes(": ") || rest.endsWith(":")) {
          // An inline first key: "- id: 03-ledger", with the rest of the
          // mapping on following lines indented further.
          const inline = `${" ".repeat(indent + 2)}${rest}`;
          lines.splice(index, 0, inline);
          items.push(parseBlock(indent + 2));
        } else {
          items.push(scalar(rest));
        }
      }
      return items;
    }

    // A mapping.
    /** @type {Record<string, any>} */
    const map = {};
    while (index < lines.length) {
      const line = String(lines[index]);
      const at = indentOf(line);
      if (at < indent) break;
      if (at > indent) { index += 1; continue; }

      const trimmed = line.trimStart();
      if (trimmed.startsWith("- ")) break;

      const colon = keyEnd(trimmed);
      if (colon === -1) { index += 1; continue; }

      const key = trimmed.slice(0, colon).trim().replace(/^["']|["']$/g, "");
      const inlineValue = trimmed.slice(colon + 1).trim();
      index += 1;

      if (inlineValue === "" ) {
        map[key] = index < lines.length && indentOf(String(lines[index])) > indent
          ? parseBlock(indentOf(String(lines[index])))
          : null;
      } else if (inlineValue === ">" || inlineValue === "|" || inlineValue === ">-" || inlineValue === "|-") {
        // A block scalar: everything indented further, joined.
        /** @type {string[]} */
        const parts = [];
        while (index < lines.length && indentOf(String(lines[index])) > indent) {
          parts.push(String(lines[index]).trim());
          index += 1;
        }
        map[key] = parts.join(inlineValue.startsWith(">") ? " " : "\n");
      } else {
        map[key] = scalar(inlineValue);
      }
    }
    return map;
  }

  return parseBlock(indentOf(String(lines[0] ?? "")));
}

/**
 * Where the key ends, ignoring a colon inside quotes.
 * @param {string} line
 */
function keyEnd(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ":") return i;
  }
  return -1;
}

/**
 * A comment starts at "#" outside quotes. A "#" inside a value is data.
 * @param {string} line
 */
function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(String(line[i - 1])))) return line.slice(0, i);
  }
  return line;
}

/**
 * @param {string} value
 * @returns {any} A string, number, boolean, null, array or flow mapping.
 */
function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((part) => scalar(part));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    // Flow mappings appear in the tiers table.
    /** @type {Record<string, any>} */
    const map = {};
    const inner = trimmed.slice(1, -1);
    for (const pair of splitTopLevel(inner)) {
      const colon = keyEnd(pair);
      if (colon === -1) continue;
      map[pair.slice(0, colon).trim()] = scalar(pair.slice(colon + 1));
    }
    return map;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Split a flow mapping on commas that are not inside quotes or braces.
 * @param {string} text
 */
function splitTopLevel(text) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/* ------------------------------------------------------------- the data */

/** @type {{registry: any, gates: any, at: number}|null} */
let cached = null;
const CACHE_MS = 10_000;

/**
 * The registry and gate definitions.
 *
 * Cached briefly: these are files on disk that change on a deploy, not on a
 * request, and every page reads them.
 */
export async function loadRegistry() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;

  const [registryText, gatesText] = await Promise.all([
    readFile(resolve(REPO_ROOT, "registry/modules.yaml"), "utf8"),
    readFile(resolve(REPO_ROOT, "gates/gates.yaml"), "utf8").catch(() => ""),
  ]);

  cached = {
    registry: parseYaml(registryText),
    gates: gatesText ? parseYaml(gatesText) : { gates: {} },
    at: Date.now(),
  };
  return cached;
}

/**
 * Modules, flattened for display.
 *
 * Each carries what the console shows: tier, status, required gates, what
 * depends on it, and how many invariants it declares.
 */
export async function modules() {
  const { registry } = await loadRegistry();
  /** @type {any[]} */
  const list = registry?.modules ?? [];

  /** @type {Map<string, string[]>} */
  const dependents = new Map();
  for (const module of list) {
    for (const dependency of module.depends_on ?? []) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), module.id]);
    }
  }

  return list.map((/** @type {any} */ module) => ({
    id: module.id,
    name: module.name,
    tier: module.tier,
    status: module.status,
    releaseApproval: module.release_approval,
    dependsOn: module.depends_on ?? [],
    dependents: dependents.get(module.id) ?? [],
    requiredGates: module.required_gates ?? [],
    invariants: (module.invariants ?? []).length,
    tests: (module.tests ?? []).length,
    purpose: String(module.purpose ?? "").trim(),
    builds: module.builds ?? [],
    invariantList: module.invariants ?? [],
  }));
}

/** The gate definitions, keyed by id. */
export async function gateDefinitions() {
  const { gates } = await loadRegistry();
  const table = gates?.gates ?? {};
  return Object.entries(table).map(([id, gate]) => ({
    id,
    name: /** @type {any} */ (gate).name,
    stage: /** @type {any} */ (gate).stage,
    blocking: /** @type {any} */ (gate).blocking,
    question: /** @type {any} */ (gate).question,
    checks: /** @type {any} */ (gate).checks ?? [],
  }));
}

/** Tier descriptions, for the legend. */
export async function tiers() {
  const { registry } = await loadRegistry();
  return Object.entries(registry?.tiers ?? {}).map(([id, tier]) => ({
    id,
    name: /** @type {any} */ (tier).name,
    blastRadius: /** @type {any} */ (tier).blast_radius,
    changePolicy: /** @type {any} */ (tier).change_policy,
  }));
}
