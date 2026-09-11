/**
 * What is actually running.
 *
 * Everything here is observed rather than configured: containers from the
 * daemon, listeners from the kernel, images from the local store, the commit
 * from git. A console that reports what a file says should be running is a
 * console that agrees with you during an outage.
 *
 * ## Why these shell out
 *
 * There is no Docker SDK here for the same reason there is no YAML library: the
 * console has no dependencies. Each command is a fixed argument vector passed
 * to `execFile` — never a shell string — so nothing an operator types can reach
 * a command line. Every call is bounded by a timeout, and a failure is returned
 * as data rather than thrown: one unavailable panel must not take down the page
 * that the other panels are on.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { REPO_ROOT } from "./registry.js";

const TIMEOUT_MS = Number(process.env.OPS_EXEC_TIMEOUT_MS ?? 6_000);

/**
 * Run a command with a fixed argument vector.
 *
 * `execFile`, never `exec`: the second takes a shell string, and a shell string
 * is a place where an argument becomes a command.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, stdout: string, error: string|null}>}
 */
function run(command, args) {
  return new Promise((resolveRun) => {
    execFile(
      command, args,
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, cwd: REPO_ROOT },
      (error, stdout, stderr) => {
        if (error) {
          // What the command actually said, not just that it failed.
          //
          // `error.message` opens with "Command failed: <the command>" and
          // carries the real reason on the lines after it, so taking the first
          // line threw away the only useful part — "fatal: Needed a single
          // revision" became "Command failed: git rev-parse --short HEAD",
          // which tells a reader nothing they could act on.
          const detail = String(stderr ?? "").trim().split("\n")[0]
            ?? String(error.message).split("\n").slice(1).join(" ").trim();
          resolveRun({
            ok: false,
            stdout: String(stdout ?? ""),
            error: /ENOENT/.test(String(error.message))
              ? `${command} is not available to this process`
              : detail || String(error.message).split("\n")[0] || "failed",
          });
          return;
        }
        resolveRun({ ok: true, stdout: String(stdout), error: null });
      },
    );
  });
}

/* --------------------------------------------------------- containers */

/**
 * Containers, with health and uptime.
 *
 * The format string asks the daemon for exactly the fields shown, so there is
 * no JSON to parse and no field that silently disappears between versions
 * without the column going obviously blank.
 */
export async function containers() {
  const result = await run("docker", [
    "ps", "--all", "--no-trunc",
    "--filter", "name=projectx",
    "--format", "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}",
  ]);
  if (!result.ok) return { available: false, error: result.error, list: [] };

  const list = result.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, state, status, image, ports] = line.split("\t");
    return {
      name: name ?? "",
      state: state ?? "",
      status: status ?? "",
      image: image ?? "",
      // Only the published side is interesting; the container-internal half is
      // noise in a table this wide.
      ports: (ports ?? "").split(",").map((p) => p.trim())
        .filter((p) => p.includes("->")).map((p) => p.split("->")[0] ?? p).join(", "),
      healthy: /\(healthy\)/.test(status ?? ""),
      unhealthy: /\(unhealthy\)/.test(status ?? ""),
    };
  });
  return { available: true, error: null, list };
}

/** Images built from this tree, newest first. */
export async function images() {
  const result = await run("docker", [
    "images", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}",
  ]);
  if (!result.ok) return { available: false, error: result.error, list: [] };

  const list = result.stdout.split("\n").filter(Boolean)
    .filter((line) => line.startsWith("projectx/"))
    .map((line) => {
      const [reference, id, created, size] = line.split("\t");
      return {
        reference: reference ?? "",
        id: (id ?? "").replace("sha256:", "").slice(0, 12),
        created: created ?? "",
        size: size ?? "",
      };
    })
    .sort((a, b) => a.reference.localeCompare(b.reference));
  return { available: true, error: null, list };
}

/** Named volumes, which is where the journal and the database live. */
export async function volumes() {
  const result = await run("docker", [
    "volume", "ls", "--filter", "name=projectx", "--format", "{{.Name}}\t{{.Driver}}",
  ]);
  if (!result.ok) return { available: false, error: result.error, list: [] };
  return {
    available: true,
    error: null,
    list: result.stdout.split("\n").filter(Boolean).map((line) => {
      const [name, driver] = line.split("\t");
      return { name: name ?? "", driver: driver ?? "" };
    }),
  };
}

/* -------------------------------------------------------------- ports */

/**
 * The reserved port block, and what is holding each one.
 *
 * Read from `.env` rather than hard-coded, so the console shows the block this
 * deployment actually reserved.
 */
export async function ports() {
  /** @type {Array<{name: string, port: number, description: string}>} */
  const reserved = [];
  try {
    const env = await readFile(resolve(REPO_ROOT, ".env"), "utf8");
    for (const line of env.split("\n")) {
      const match = /^(PORT_[A-Z0-9_]+)=(\d+)\s*(?:#\s*(.*))?$/.exec(line.trim());
      if (!match) continue;
      reserved.push({
        name: String(match[1]).replace(/^PORT_/, "").toLowerCase().replace(/_/g, " "),
        port: Number(match[2]),
        description: String(match[3] ?? "").trim(),
      });
    }
  } catch {
    return { available: false, error: "could not read .env", list: [] };
  }

  const listening = await run("ss", ["-ltnH"]);
  /** @type {Set<number>} */
  const open = new Set();
  if (listening.ok) {
    for (const line of listening.stdout.split("\n")) {
      const match = /:(\d+)\s/.exec(line);
      if (match) open.add(Number(match[1]));
    }
  }

  return {
    available: true,
    error: listening.ok ? null : listening.error,
    list: reserved.sort((a, b) => a.port - b.port).map((entry) => ({
      ...entry,
      listening: open.has(entry.port),
    })),
  };
}

/* ---------------------------------------------------------------- git */

/** The commit this tree is on, and whether it is clean. */
export async function commit() {
  const [described, status, log] = await Promise.all([
    run("git", ["rev-parse", "--short", "HEAD"]),
    run("git", ["status", "--porcelain"]),
    run("git", ["log", "-1", "--format=%s|%an|%ar"]),
  ]);

  if (!described.ok) {
    // A repository with no commits is not a broken repository, and reporting it
    // as one sends somebody looking for a problem with git. `rev-parse HEAD`
    // fails with "Needed a single revision" until the first commit exists.
    const noCommits = /Needed a single revision|unknown revision|ambiguous argument/i
      .test(described.error ?? "");
    return {
      available: false,
      error: noCommits
        ? "This tree has no commits yet, so there is nothing to pin a gate result to."
        : described.error,
      noCommits,
      sha: "", clean: true, changedFiles: 0, subject: "", author: "", when: "",
    };
  }
  const [subject, author, when] = (log.stdout.trim() || "||").split("|");
  const dirty = status.ok ? status.stdout.split("\n").filter(Boolean).length : 0;

  return {
    available: true,
    error: null,
    noCommits: false,
    sha: described.stdout.trim(),
    clean: dirty === 0,
    changedFiles: dirty,
    subject: subject ?? "",
    author: author ?? "",
    when: when ?? "",
  };
}

/* ------------------------------------------------------------- tunnels */

/**
 * Cloudflare tunnels running on this host.
 *
 * The command line is read from `/proc` and the token is stripped before it
 * goes anywhere near a page: a tunnel token is a credential that runs a tunnel,
 * and this console renders into a browser.
 */
export async function tunnels() {
  const result = await run("pgrep", ["-a", "cloudflared"]);
  if (!result.ok) {
    // Not an error worth a red panel: no tunnel is a normal state.
    return { available: true, error: null, list: [] };
  }
  const list = result.stdout.split("\n").filter(Boolean).map((line) => {
    const [pid, ...rest] = line.split(" ");
    const command = rest.join(" ")
      .replace(/--token[= ]\S+/g, "--token <redacted>")
      .replace(/--token-file[= ]\S+/g, "--token-file <redacted>");
    const config = /--config\s+(\S+)/.exec(command)?.[1] ?? "";
    return {
      pid: Number(pid),
      config: config ? config.split("/").pop() ?? config : "(remotely managed)",
      command: command.slice(0, 160),
    };
  });
  return { available: true, error: null, list };
}

/* ------------------------------------------------------------- process */

/** This host, as the console sees it. */
export async function host() {
  const [uptime, load, disk] = await Promise.all([
    readFile("/proc/uptime", "utf8").catch(() => ""),
    readFile("/proc/loadavg", "utf8").catch(() => ""),
    run("df", ["-h", REPO_ROOT]),
  ]);

  const seconds = Number(uptime.split(" ")[0] ?? 0);
  const [one, five, fifteen] = load.split(" ");

  /** @type {string} */
  let free = "—";
  /** @type {string} */
  let usedPercent = "—";
  if (disk.ok) {
    const row = disk.stdout.split("\n")[1]?.split(/\s+/) ?? [];
    free = row[3] ?? "—";
    usedPercent = row[4] ?? "—";
  }

  return {
    uptimeHours: seconds ? Math.floor(seconds / 3600) : 0,
    load: { one: one ?? "—", five: five ?? "—", fifteen: fifteen ?? "—" },
    disk: { free, usedPercent },
    node: process.version,
  };
}

/* --------------------------------------------------------------- logs */

/**
 * Service logs written by `scripts/dev_stack.sh`, and container logs otherwise.
 *
 * The service name is checked against a fixed list rather than used to build a
 * path. A console that opens whatever file an operator names is a console with
 * a path traversal in it, and "operators are trusted" stops being true the
 * moment one of them is phished.
 */
export const LOG_SOURCES = /** @type {const} */ ([
  "web", "client-api", "ledger", "market-data", "pricing", "oms", "ops",
]);

/**
 * @param {string} service
 * @param {number} [lines]
 */
export async function logs(service, lines = 200) {
  if (!(/** @type {readonly string[]} */ (LOG_SOURCES).includes(service))) {
    return { available: false, error: "unknown service", lines: [] };
  }
  const bounded = Math.max(10, Math.min(1000, Number(lines) || 200));

  // The container first: that is what a deployed stack runs.
  const container = await run("docker", ["logs", "--tail", String(bounded), `projectx-${service}`]);
  if (container.ok || container.stdout) {
    return {
      available: true, error: null, source: `container projectx-${service}`,
      lines: container.stdout.split("\n").filter(Boolean).slice(-bounded),
    };
  }

  // Otherwise the file the local stack writes.
  try {
    const text = await readFile(resolve(REPO_ROOT, ".run", `${service}.log`), "utf8");
    return {
      available: true, error: null, source: `.run/${service}.log`,
      lines: text.split("\n").filter(Boolean).slice(-bounded),
    };
  } catch {
    return {
      available: false,
      error: `no container and no .run/${service}.log`,
      source: "",
      lines: [],
    };
  }
}
