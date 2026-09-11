/**
 * The gate board.
 *
 * A gate is a question about the system, and the answer has a shelf life. This
 * runs the gate scripts, records what they said and when, and shows the age of
 * each answer beside it — because "G8 passed" is only useful with "forty
 * minutes ago, on this commit" attached.
 *
 * ## The lookup table is the security boundary
 *
 * Gates are addressed by id and resolved through a fixed table to a fixed
 * argument vector. Nothing an operator types reaches a command line, and there
 * is no path to compose: `runGate("G8")` can only ever run the one command
 * written below. This is the same pattern as the log sources and for the same
 * reason.
 *
 * Results are cached to disk so the board survives a restart, and each carries
 * the commit it ran against — a green board from before the last deploy is a
 * board that is lying by omission.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { REPO_ROOT } from "./registry.js";
import { commit } from "./infra.js";

/** Where results are kept between restarts. */
const RESULTS_PATH = resolve(REPO_ROOT, ".run", "ops-gates.json");

/**
 * Gate id to the command that answers it.
 *
 * Every entry is a fixed vector. Adding a gate is an edit here, which is the
 * point — a console that can run arbitrary make targets is a remote shell with
 * a nice font.
 *
 * @type {Record<string, {args: string[], timeoutMs: number, needsStack: boolean}>}
 */
export const GATE_COMMANDS = {
  G0: { args: ["--no-print-directory", "fmt-check"], timeoutMs: 180_000, needsStack: false },
  G1: { args: ["--no-print-directory", "lint"], timeoutMs: 300_000, needsStack: false },
  G2: { args: ["--no-print-directory", "test"], timeoutMs: 600_000, needsStack: false },
  G3: { args: ["--no-print-directory", "test-property"], timeoutMs: 600_000, needsStack: false },
  G4: { args: ["--no-print-directory", "test-invariants"], timeoutMs: 600_000, needsStack: true },
  G5: { args: ["--no-print-directory", "test-integration"], timeoutMs: 600_000, needsStack: true },
  G6: { args: ["--no-print-directory", "test-replay"], timeoutMs: 600_000, needsStack: false },
  G8: { args: ["--no-print-directory", "test-security"], timeoutMs: 600_000, needsStack: true },
  G9: { args: ["--no-print-directory", "test-performance"], timeoutMs: 600_000, needsStack: true },
};

/**
 * Read the recorded results.
 * @returns {Promise<Record<string, any>>}
 */
export async function results() {
  try {
    return JSON.parse(await readFile(RESULTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {string} id
 * @param {any} result
 */
async function record(id, result) {
  const all = await results();
  all[id] = result;
  await mkdir(resolve(REPO_ROOT, ".run"), { recursive: true }).catch(() => {});
  await writeFile(RESULTS_PATH, JSON.stringify(all, null, 2));
}

/**
 * Can this process actually run a gate?
 *
 * The gates need `make`, a Rust toolchain, Python, installed node modules and a
 * writable tree. A console running on the host has all of that; a console in a
 * container has none of it, and the repository is mounted read-only besides.
 *
 * Putting that toolchain into the console image would turn the console into a
 * build machine — a far larger image, a much wider attack surface, and a second
 * place where "the tests passed" could mean something different from the one
 * CI uses. So the container reports gate *results* and refuses to produce them,
 * and the board says which it is rather than offering a button that does
 * nothing.
 *
 * @type {{checked: boolean, can: boolean, reason: string}}
 */
const capability = { checked: false, can: false, reason: "" };

/** @returns {Promise<{can: boolean, reason: string}>} */
export async function canRunGates() {
  if (capability.checked) return capability;
  capability.checked = true;

  const found = await new Promise((resolveRun) => {
    execFile("make", ["--version"], { timeout: 5_000, cwd: REPO_ROOT }, (error) => {
      resolveRun(!error);
    });
  });

  if (!found) {
    capability.can = false;
    capability.reason =
      "This console cannot run gates: `make` is not available to it. That is " +
      "expected in the container — the gates need the build toolchain and a " +
      "writable tree. Run them from the host, or from CI.";
    return capability;
  }

  // A gate writes its result back into .run/. A read-only mount is the other
  // half of the same story.
  const writable = await new Promise((resolveRun) => {
    mkdir(resolve(REPO_ROOT, ".run"), { recursive: true })
      .then(() => writeFile(resolve(REPO_ROOT, ".run", ".ops-write-probe"), "x"))
      .then(() => resolveRun(true))
      .catch(() => resolveRun(false));
  });

  if (!writable) {
    capability.can = false;
    capability.reason =
      "This console cannot run gates: the repository is mounted read-only, so a " +
      "result could not be recorded. Run them from the host, or from CI.";
    return capability;
  }

  capability.can = true;
  capability.reason = "";
  return capability;
}

/** Is a gate currently running? Keyed by id, so two clicks do not start two. */
const inFlight = new Set();

/** @param {string} id */
export const isRunning = (id) => inFlight.has(id);

/** Every gate currently running. */
export const running = () => [...inFlight];

/**
 * Run one gate.
 *
 * The output is kept in full and the last lines are what the board shows: a
 * failing gate's reason is almost always in its final few lines, and an
 * operator who has to open a terminal to find out why has not been served.
 *
 * @param {string} id
 * @param {string} operator
 */
export async function runGate(id, operator) {
  const gate = GATE_COMMANDS[id];
  if (!gate) throw new Error(`no such gate: ${id}`);
  if (inFlight.has(id)) return { alreadyRunning: true };

  const able = await canRunGates();
  if (!able.can) throw new Error(able.reason);

  inFlight.add(id);
  const startedAt = Date.now();
  const at = await commit();

  return new Promise((resolveRun) => {
    execFile(
      "make", gate.args,
      {
        cwd: REPO_ROOT,
        timeout: gate.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          // The gate scripts refuse to replace a production deployment unless
          // told to. The console is the operator saying so.
          ALLOW_REPLACING_DEPLOYMENT: process.env.OPS_ALLOW_GATE_STACK ?? "false",
        },
      },
      async (error, stdout, stderr) => {
        inFlight.delete(id);
        const output = `${stdout}${stderr}`.split("\n").filter(Boolean);
        const result = {
          id,
          passed: !error,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          commit: at.sha,
          clean: at.clean,
          operator,
          timedOut: Boolean(error && /timed out|ETIMEDOUT/i.test(String(error.message))),
          summary: summarise(output, !error),
          output: output.slice(-160),
        };
        await record(id, result).catch(() => {});
        resolveRun(result);
      },
    );
  });
}

/**
 * The one line worth putting on a card.
 *
 * Prefers a line the gate script itself wrote as its verdict; falls back to the
 * last failing check, then to the last line of output. Anything is better than
 * showing the last line of a make recipe, which is usually "make: *** Error 1".
 *
 * @param {string[]} output
 * @param {boolean} passed
 */
function summarise(output, passed) {
  const verdict = [...output].reverse().find((line) => /^[✓✗]\s/.test(line.trim()));
  if (verdict) return verdict.trim();

  if (!passed) {
    const failure = [...output].reverse().find((line) => /✗|FAILED|error/i.test(line));
    if (failure) return failure.trim().slice(0, 160);
  }
  return (output[output.length - 1] ?? "").trim().slice(0, 160);
}

/**
 * The board: every gate, with its definition and its last result.
 *
 * @param {Array<{id: string, name: string, stage: string, blocking: boolean, question: string, checks: string[]}>} definitions
 * @param {Array<{id: string, requiredGates: string[]}>} moduleList
 */
export async function board(definitions, moduleList) {
  const recorded = await results();
  const at = await commit();
  const able = await canRunGates();

  return definitions.map((definition) => {
    const last = recorded[definition.id] ?? null;
    const requiredBy = moduleList
      .filter((module) => (module.requiredGates ?? []).includes(definition.id))
      .map((module) => module.id);

    return {
      ...definition,
      defined: Boolean(GATE_COMMANDS[definition.id]),
      // Defined here *and* runnable by this process are different questions,
      // and a button that cannot work is worse than no button.
      runnable: Boolean(GATE_COMMANDS[definition.id]) && able.can,
      cannotRunBecause: GATE_COMMANDS[definition.id] && !able.can ? able.reason : "",
      running: inFlight.has(definition.id),
      requiredBy,
      last,
      // A result from a different commit is not a result about this tree. The
      // board says so rather than showing a reassuring green tick.
      stale: Boolean(last && at.available && last.commit && last.commit !== at.sha),
    };
  });
}
