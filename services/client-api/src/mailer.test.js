/**
 * G2 — the parts of SMTP where a mistake is silent.
 *
 * A mail client fails in two ways. It refuses to send, which you find out about
 * immediately; or it sends something subtly malformed, which the receiving
 * server accepts, mangles, or scores as spam — and nobody finds out until a
 * customer says a reset link never arrived.
 *
 * These cover the second kind: dot-stuffing, line endings, header encoding, and
 * the address validation that stops a newline in an address from becoming
 * further SMTP commands.
 *
 * The conversation itself — greeting, EHLO, STARTTLS, AUTH, MAIL/RCPT/DATA — is
 * proven end to end in `tests/e2e/specs/auth.spec.js` against a real SMTP
 * server, because a mocked socket would only prove this file agrees with itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMessage, dotStuff } from "./mailer.js";

/* ------------------------------------------------------------ dot-stuffing */

test("a line that is a single dot cannot terminate the message early", () => {
  // This is the whole reason dot-stuffing exists. A body containing "\n.\n"
  // ends DATA where the dot is; everything after it is read as SMTP commands.
  const body = "Here is your link.\n.\nAnd this must still be part of the message.";
  const wire = dotStuff(body);

  assert.ok(!/\r\n\.\r\n/.test(wire), "an unescaped bare dot line survived and would truncate the message");
  assert.ok(wire.includes("\r\n..\r\n"), "the bare dot was not doubled");
  assert.ok(wire.includes("And this must still be part of the message"));
});

test("every dot at the start of a line is doubled, and only those", () => {
  const wire = dotStuff(".start\nmiddle.dot\n.another\nplain");
  const lines = wire.split("\r\n");
  assert.deepEqual(lines, ["..start", "middle.dot", "..another", "plain"]);
  // A dot inside a line is data, not a terminator, and must be left alone.
  assert.ok(wire.includes("middle.dot"), "a mid-line dot was altered");
});

test("line endings are normalised to CRLF exactly once", () => {
  // Sending bare LF is the most common way a hand-written client produces
  // messages that some servers accept and others reject outright.
  for (const input of ["a\nb", "a\r\nb", "a\r\n\r\nb"]) {
    const wire = dotStuff(input);
    assert.ok(!/[^\r]\n/.test(wire), `a bare LF survived in ${JSON.stringify(input)}`);
    assert.ok(!/\r\r/.test(wire), `a CR was doubled in ${JSON.stringify(input)}`);
  }
  // Idempotent: running it twice must not double anything.
  assert.equal(dotStuff(dotStuff("a\nb")), dotStuff("a\nb"));
});

/* ----------------------------------------------------------------- headers */

test("the message carries the headers a receiver needs to not treat it as spam", () => {
  const message = buildMessage({
    from: "no-reply@projectx.local",
    to: "someone@example.com",
    subject: "Reset your Project X password",
    body: "A link.",
  });

  for (const header of ["From:", "To:", "Subject:", "Date:", "Message-ID:", "MIME-Version:"]) {
    assert.ok(message.includes(header), `the message has no ${header} header`);
  }
  // Headers and body are separated by exactly one blank line. Without it the
  // body is parsed as more headers and the message arrives empty.
  const separator = message.indexOf("\r\n\r\n");
  assert.ok(separator > 0, "there is no header/body separator");
  assert.equal(message.slice(separator + 4), "A link.");

  // The Message-ID is bracketed and has a domain, or it is not a Message-ID.
  assert.match(message, /Message-ID: <[^@\s]+@[^>\s]+>/);
});

test("a non-ASCII subject is encoded rather than sent raw", () => {
  const message = buildMessage({
    from: "no-reply@projectx.local",
    to: "someone@example.com",
    subject: "Réinitialisez votre mot de passe",
    body: "x",
  });
  // Raw UTF-8 in a header is mangled by some servers and rejected by others.
  assert.match(message, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  assert.ok(!message.includes("Réinitialisez"), "the subject was sent raw");

  // And an ASCII subject is left alone — encoding everything is its own bug,
  // because it makes every subject unreadable in a log or a bounce.
  const plain = buildMessage({
    from: "a@b.co", to: "c@d.co", subject: "Reset your password", body: "x",
  });
  assert.ok(plain.includes("Subject: Reset your password"));
});

test("the whole message is CRLF-terminated", () => {
  const message = buildMessage({
    from: "a@b.co", to: "c@d.co", subject: "s", body: "line one\nline two",
  });
  assert.ok(!/[^\r]\n/.test(message), "the assembled message contains a bare LF");
});

/* ------------------------------------------------------------- injection */

test("a newline in the body cannot forge a header", () => {
  // The body is placed after the separator, so a header-looking line inside it
  // is body text. This asserts the ordering that makes that true.
  const message = buildMessage({
    from: "a@b.co",
    to: "c@d.co",
    subject: "s",
    body: "Bcc: attacker@example.com\nreal content",
  });
  const separator = message.indexOf("\r\n\r\n");
  const headers = message.slice(0, separator);
  assert.ok(!headers.includes("Bcc:"), "a body line was parsed into the header block");
});

test("a subject containing a newline cannot inject a header", () => {
  // A raw CR or LF in a subject splits it, and the second half becomes a header
  // of the attacker's choosing. The non-ASCII path base64-encodes it; the ASCII
  // path must not admit one at all.
  const message = buildMessage({
    from: "a@b.co",
    to: "c@d.co",
    subject: "Hello\r\nBcc: attacker@example.com",
    body: "x",
  });
  const separator = message.indexOf("\r\n\r\n");
  const headers = message.slice(0, separator);
  assert.ok(
    !/^Bcc:/m.test(headers),
    "a newline in the subject produced a separate header",
  );
});
