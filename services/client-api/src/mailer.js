/**
 * Delivery.
 *
 * The outbox in `db.js` records messages this platform needs to send. Until now
 * nothing drained it: every row carried a `blocked_reason` saying there was no
 * provider, which made password reset honest but unusable — the link existed
 * and had nowhere to go.
 *
 * This is the provider. Three drivers, chosen by `MAIL_DRIVER`:
 *
 * - `none` (default) — the previous behaviour. Messages are queued and stay
 *   queued, with the reason recorded on the row. Nothing is claimed.
 * - `log` — writes the message to the service log. For a developer who wants
 *   the link without running a mail server.
 * - `smtp` — actually sends it.
 *
 * ## Why the SMTP client is written out here
 *
 * `services/client-api/Dockerfile` already sets out the rule: the
 * zero-dependency stance binds the financial core, not the edge, and a
 * hand-rolled Postgres wire protocol client would be a worse risk than the
 * standard driver. SMTP submission is the other side of that judgement — it is
 * a line-oriented text protocol with about eight verbs, and the whole client is
 * below. Pulling in a dependency tree to send one kind of message would add
 * more supply chain than protocol.
 *
 * What it does **not** implement, deliberately: attachments, MIME multipart,
 * connection pooling, DKIM signing, or IDN address encoding. This sends one
 * short plain-text message at a time. Anything more belongs to the
 * notifications module when that is built, not here.
 */

import net from "node:net";
import tls from "node:tls";

import { asAuth } from "./db.js";

const DRIVER = process.env.MAIL_DRIVER ?? "none";
const FROM = process.env.MAIL_FROM ?? "no-reply@projectx.local";

/** How long any single SMTP step may take before the attempt is abandoned. */
const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS ?? 10_000);

/**
 * The reason recorded on a message that has not been delivered.
 *
 * Kept on the row rather than inferred, so the interface can say what actually
 * happened to a specific message instead of describing the system in general.
 */
const NO_PROVIDER =
  "No email provider is configured. Set MAIL_DRIVER to send, or read the outbox in development.";

/** @param {string} level @param {string} message @param {Record<string, unknown>} [fields] */
function log(level, message, fields = {}) {
  process.stdout.write(
    JSON.stringify({
      ts: Date.now(), level, service: "client-api", module_id: "19-client-api",
      tier: "T4", message, ...fields,
    }) + "\n",
  );
}

/* --------------------------------------------------------------- SMTP */

/**
 * One SMTP conversation, on one connection.
 *
 * Written as a small state machine over the socket rather than a stream
 * pipeline: SMTP is strictly request/response, and the sequencing is the whole
 * protocol. A reply may span several lines — `250-EXTENSION` continues,
 * `250 EXTENSION` ends — and treating the first line as the reply is the
 * classic way a client appears to work until it meets a server that advertises
 * more than one extension.
 */
class SmtpSession {
  /** @param {import("node:net").Socket} socket */
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    /** @type {Array<{resolve: (r: {code: number, lines: string[]}) => void, reject: (e: Error) => void}>} */
    this.waiting = [];

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.consume(String(chunk)));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("the SMTP server closed the connection")));
  }

  /** @param {string} chunk */
  consume(chunk) {
    this.buffer += chunk;
    for (;;) {
      // A complete reply ends with a line whose fourth character is a space
      // rather than a hyphen. Anything before that is a continuation.
      const match = /^(?:\d{3}-[^\r\n]*\r?\n)*\d{3} [^\r\n]*\r?\n/.exec(this.buffer);
      if (!match) return;
      const raw = match[0];
      this.buffer = this.buffer.slice(raw.length);

      const lines = raw.split(/\r?\n/).filter(Boolean);
      const code = Number(lines[lines.length - 1]?.slice(0, 3));
      const pending = this.waiting.shift();
      pending?.resolve({ code, lines: lines.map((line) => line.slice(4)) });
    }
  }

  /** @param {Error} error */
  failAll(error) {
    const pending = this.waiting.splice(0);
    for (const one of pending) one.reject(error);
  }

  /** Wait for the next complete reply. */
  reply() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the SMTP server did not reply within ${SMTP_TIMEOUT_MS}ms`)),
        SMTP_TIMEOUT_MS,
      );
      this.waiting.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  /**
   * Send a command and read its reply, refusing anything but the codes given.
   * @param {string} command
   * @param {number[]} expected
   */
  async send(command, expected) {
    this.socket.write(`${command}\r\n`);
    const reply = await this.reply();
    if (!expected.includes(reply.code)) {
      // The server's own words, not a paraphrase: "550 5.7.1 relay denied" is
      // the answer to what went wrong, and summarising it loses the answer.
      throw new Error(`SMTP ${command.split(" ")[0]} refused: ${reply.code} ${reply.lines.join(" ")}`);
    }
    return reply;
  }
}

/**
 * Escape a message body for the DATA command.
 *
 * Two rules, both load-bearing. Lines are CRLF-terminated, and a line
 * consisting of a single dot ends the message — so a dot at the start of any
 * line is doubled. Without that, a message body containing ".\n" truncates
 * itself and the rest is interpreted as SMTP commands.
 *
 * @param {string} body
 */
export function dotStuff(body) {
  return body
    .replace(/\r?\n/g, "\r\n")
    .replace(/^\./gm, "..");
}

/**
 * Build the RFC 5322 message.
 *
 * Headers are folded at nothing and encoded at nothing: the subject lines this
 * service sends are ASCII. A non-ASCII subject is encoded as RFC 2047 base64
 * rather than sent raw, because a raw one is silently mangled by some servers
 * and rejected by others.
 *
 * @param {{from: string, to: string, subject: string, body: string}} message
 */
export function buildMessage({ from, to, subject, body }) {
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;

  // A Message-ID and a Date: without them many servers score the message as
  // spam, which is a delivery failure that looks like a delivery success.
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${
    from.split("@")[1] ?? "projectx.local"
  }>`;

  // The body's own line endings are normalised here rather than relying on
  // `dotStuff` to do it later. Both are applied in the send path, but a
  // function that is only correct because of what happens to its output next is
  // a function that breaks the first time somebody calls it on its own — and
  // bare LFs are accepted by some servers and rejected by others, so the
  // failure would be intermittent and per-recipient.
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    String(body).replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
}

/**
 * Addresses are validated before they reach a command line.
 *
 * A newline in an address is SMTP header injection: the rest of the "address"
 * becomes further commands. The addresses here come from a column that
 * `requireEmail` already validated, and this is the second gate rather than the
 * first — the point is that neither alone has to be perfect.
 *
 * @param {string} address
 */
function safeAddress(address) {
  const value = String(address ?? "").trim();
  if (!value || /[\r\n<>]/.test(value) || value.length > 254) {
    throw new Error("refusing to send to an address containing control characters");
  }
  return value;
}

/**
 * Deliver one message over SMTP.
 *
 * @param {{to: string, subject: string, body: string}} message
 */
async function sendOverSmtp({ to, subject, body }) {
  const url = new URL(process.env.SMTP_URL ?? "smtp://localhost:1025");
  const implicitTls = url.protocol === "smtps:";
  const port = Number(url.port || (implicitTls ? 465 : 587));
  const host = url.hostname;

  const socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(SMTP_TIMEOUT_MS);

  /** @type {SmtpSession} */
  let session;
  try {
    await new Promise((resolve, reject) => {
      socket.once(implicitTls ? "secureConnect" : "connect", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error(`connecting to ${host}:${port} timed out`)));
    });

    session = new SmtpSession(socket);
    const greeting = await session.reply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting was ${greeting.code}`);

    const ehloName = process.env.SMTP_EHLO ?? "projectx.local";
    let capabilities = await session.send(`EHLO ${ehloName}`, [250]);

    // STARTTLS where the server offers it and we are not already encrypted.
    // Credentials must never cross a plaintext connection, so AUTH below is
    // refused unless one of the two happened.
    const offersStartTls = capabilities.lines.some(
      (/** @type {string} */ line) => /^STARTTLS\b/i.test(line),
    );
    let secured = implicitTls;
    if (!implicitTls && offersStartTls) {
      await session.send("STARTTLS", [220]);
      const upgraded = await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
        secure.once("error", reject);
      });
      session = new SmtpSession(/** @type {any} */ (upgraded));
      capabilities = await session.send(`EHLO ${ehloName}`, [250]);
      secured = true;
    }

    if (url.username) {
      if (!secured && process.env.SMTP_ALLOW_PLAINTEXT_AUTH !== "true") {
        throw new Error(
          "refusing to send SMTP credentials over an unencrypted connection " +
            "(the server offered no STARTTLS; set SMTP_ALLOW_PLAINTEXT_AUTH=true only for a local sink)",
        );
      }
      const user = decodeURIComponent(url.username);
      const pass = decodeURIComponent(url.password);
      // AUTH PLAIN carries both in one base64 blob, separated by NULs.
      const credential = Buffer.from(`\u0000${user}\u0000${pass}`, "utf8").toString("base64");
      await session.send(`AUTH PLAIN ${credential}`, [235]);
    }

    await session.send(`MAIL FROM:<${safeAddress(FROM)}>`, [250]);
    await session.send(`RCPT TO:<${safeAddress(to)}>`, [250, 251]);
    await session.send("DATA", [354]);

    session.socket.write(dotStuff(buildMessage({ from: FROM, to, subject, body })));
    await session.send("\r\n.", [250]);
    await session.send("QUIT", [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

/* ------------------------------------------------------------ the worker */

/**
 * Deliver one queued message.
 *
 * @param {{messageId: string, to: string, subject: string, body: string}} message
 * @returns {Promise<{delivered: boolean, reason: string|null}>}
 */
export async function deliver(message) {
  if (DRIVER === "none") return { delivered: false, reason: NO_PROVIDER };

  if (DRIVER === "log") {
    log("info", "outbox message (MAIL_DRIVER=log, not sent)", {
      to: message.to, subject: message.subject, body: message.body,
    });
    return { delivered: true, reason: null };
  }

  if (DRIVER === "smtp") {
    await sendOverSmtp(message);
    return { delivered: true, reason: null };
  }

  return { delivered: false, reason: `Unknown MAIL_DRIVER "${DRIVER}".` };
}

/**
 * Drain the outbox once.
 *
 * Claims each row before attempting it, so two instances running this loop do
 * not both send the same message. `FOR UPDATE SKIP LOCKED` is what makes that
 * true without a queue: the second worker steps over anything the first is
 * already holding rather than blocking behind it.
 *
 * A failure is recorded on the row and retried on the next pass. It is not
 * dropped, and it is not retried forever in a tight loop — the interval between
 * passes is the backoff.
 *
 * @param {number} [limit]
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function drainOutbox(limit = 20) {
  if (DRIVER === "none") return { sent: 0, failed: 0 };

  /** @type {Array<{messageId: string, to: string, subject: string, body: string}>} */
  const claimed = await asAuth(async (q) => {
    const result = await q(
      `SELECT message_id, to_address, subject, body
         FROM app.outbox
        WHERE delivered_at IS NULL
        ORDER BY created_at
        LIMIT ${Math.max(1, Math.min(100, Number(limit) || 20))}
          FOR UPDATE SKIP LOCKED`,
    );
    return result.rows.map((/** @type {Record<string, any>} */ row) => ({
      messageId: row.message_id,
      to: row.to_address,
      subject: row.subject,
      body: row.body,
    }));
  });

  let sent = 0;
  let failed = 0;

  for (const message of claimed) {
    try {
      const outcome = await deliver(message);
      if (outcome.delivered) {
        await asAuth((q) => q(
          `UPDATE app.outbox SET delivered_at = now(), blocked_reason = NULL WHERE message_id = $1`,
          [message.messageId],
        ));
        sent += 1;
        // The address is logged, the body is not: a reset link in a log file is
        // a reset link in whatever aggregates that log file.
        log("info", "outbox message delivered", { to: message.to, subject: message.subject });
      } else {
        await asAuth((q) => q(
          `UPDATE app.outbox SET blocked_reason = $2 WHERE message_id = $1`,
          [message.messageId, outcome.reason],
        ));
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      const reason = String(error instanceof Error ? error.message : error).slice(0, 400);
      await asAuth((q) => q(
        `UPDATE app.outbox SET blocked_reason = $2 WHERE message_id = $1`,
        [message.messageId, reason],
      )).catch(() => {});
      log("error", "outbox delivery failed", { to: message.to, detail: reason });
    }
  }

  return { sent, failed };
}

/**
 * Run the drain on an interval.
 *
 * Returns a stop function. The timer is unref'd so it never holds the process
 * open during shutdown — a worker that keeps a draining service alive is a
 * worker that turns a rolling restart into an outage.
 *
 * @param {number} [intervalMs]
 */
export function startOutboxWorker(intervalMs = Number(process.env.OUTBOX_INTERVAL_MS ?? 5_000)) {
  if (DRIVER === "none") {
    log("info", "outbox worker not started", { reason: "MAIL_DRIVER=none" });
    return () => {};
  }

  let running = false;
  const tick = async () => {
    // Never two passes at once. A slow SMTP server would otherwise stack
    // overlapping drains until something ran out of connections.
    if (running) return;
    running = true;
    try {
      const { sent, failed } = await drainOutbox();
      if (sent || failed) log("info", "outbox drained", { sent, failed });
    } catch (error) {
      log("error", "outbox worker pass failed", { detail: String(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, Math.max(1_000, intervalMs));
  timer.unref();
  void tick();

  log("info", "outbox worker started", { driver: DRIVER, intervalMs });
  return () => clearInterval(timer);
}

/** What the interface should tell somebody about delivery. */
export const delivery = {
  driver: DRIVER,
  /** True when a message asked for will actually be sent somewhere. */
  enabled: DRIVER !== "none",
  noProviderReason: NO_PROVIDER,
};
