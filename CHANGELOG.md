# Changelog

All notable changes to Project X are recorded here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Rules for this file

This is a financial system, so the changelog carries more weight than usual. It
is part of the audit trail, and in a regulated review it may be read by someone
who was not in the room.

Every entry that touches a **Tier 0, 1 or 2** module must record:

- **which modules** changed, by registry id
- **which gates** the change passed, on which artifact digest
- **who approved** the release, where approval was required
- **whether any invariant changed** — and if so, which, and why

An invariant is never silently modified. Changing one is a breaking change to the
financial behaviour of the system, and it gets its own entry with an explanation
a regulator could follow.

Entry template:

```
### <Added|Changed|Fixed|Removed|Security>

- **`<module-id>`** — one-line description.
  Gates: G0–G9 on `sha256:…`. Approved by: `<name>`.
  Invariants: unchanged | INV-0XX added/modified (rationale).
```

---

## [Unreleased]

### Added — real prices, trading sessions, one account system, the chart suite, the MT5 bridge

- **`04-account`, `03-ledger`, `19-client-api`, `20-web`** — One account, one
  number (INV-033): the ledger issues every account number; the client area
  keeps its record under it. Demo accounts open funded, real accounts open
  unfunded and say so; archiving freezes in the ledger. Demo capital is the
  one live funding path (INV-034, INV-035): idempotent top-ups within a cap,
  a reset to the grant while flat. The open dialog follows the tab and the
  page lands where the account is. Legacy records are re-keyed at startup.
  Gates: G0–G8. Invariants: INV-033, INV-034, INV-035 added.

- **`06-market-data`, `07-pricing`, `09-risk`, `20-web`** — Trading sessions
  (INV-053, INV-084): a per-class calendar in UTC (FX, metals with a daily
  break, crypto continuous, fixed holidays), pure in the tick. Outside its
  session an instrument's quote is frozen at the last open tick and says so;
  candles skip closed windows; risk refuses an order on a closed market before
  price or margin is considered; the terminal shows a closed-market banner and
  disables the ticket.
  Gates: G0–G9. Invariants: INV-053, INV-084 added.

- **`06-market-data`** — The recorded feed (INV-054): validated at the door
  with a spike filter (INV-050), one digest over everything accepted, an
  append-only `feed.log` with batch fsync, per-symbol modes (synthetic or
  recorded-from-source) logged with the tick they took effect at so a past
  quote is the same answer forever, an operator-settable source order per
  class, a watchdog that falls back to the pure function on silence.
  Gates: G0–G7, G9. Invariants: INV-054 added.

- **`13-lp-connectivity`** — `services/feed-gateway` (Node, zero dependencies):
  one adapter interface with health and a circuit breaker (INV-120, INV-121);
  Binance (keyless, live BTCUSD with backfill), Twelve Data, Finnhub, the MT5
  bridge over SSE with candle backfill, a simulated LP that injects
  duplicates, reordering, crossed quotes and drops; per-symbol selection and
  failover; batched delivery to market-data, applied once (INV-122).
  Gates: G0–G9. Invariants: INV-121 restated to what is built.

- **`21-external`** — One bridge protocol spoken by `mt5-sim` (deterministic,
  for CI) and `mt5-bridge` (a MetaTrader 5 terminal under Wine 10, fronted by
  `bridge.py`; unconfigured until a login is supplied). The reconciler in
  `client-api` mirrors the mapped account's net position to the platform,
  raises a break on divergence that survives mirroring (INV-201), and carries
  a platform-originated deal into the core only through the OMS, keyed by its
  ticket (INV-200). Gates: G0–G2, G4–G6, G8. Invariants: unchanged.

- **`20-web`** — The chart suite: KLineChart 10.0.3 (Apache-2.0, vendored,
  served from this origin under the unchanged CSP). Candle/hollow/OHLC/area,
  built-in indicators, drawing tools, position lines, 4h and 1d intervals,
  paging by pinned tick. Live over one server-sent-event stream per tab
  (`GET /v1/stream`), polling kept as a safety net. Numbers reach the library
  for pixels only; every displayed figure is still the API's string.

- **`apps/ops`, `19-client-api`** — Market feed (source order per class,
  provider health), the whole ledger (trial balance, paged journal,
  invariants), every order with its owner, the person's order book on each
  user, live per-user telemetry over an operator event stream (in memory,
  never a metric label), the MT5 bridge (map, unmap, cycle, breaks, actions).

- **Gates** — Property laws for the core, the OMS lifecycle, pricing, the
  feed and the edge's money boundary; replay of the real core from its
  journal; a live-stack integration suite; chaos on the ledger, the OMS,
  pricing and market-data; core-surface probes; the order path measured. The
  e2e suite chooses an open market at run time and prices the tree-run stack
  on the simulator alone, in its own database.

### Fixed

- **`05-position`, `09-risk`** — A residual position below the venue minimum
  could never be closed; a close of the whole residual now bypasses the
  opening minimum. Found by `core_laws`.
- **`03-ledger`, `10-oms`** — Order history and idempotency keys did not
  survive a restart; deals are logged with their order fields and rejections
  are logged, and the OMS resolves an UNKNOWN order on retry by asking the
  ledger rather than assuming. Found by `core_replay` and the chaos suite.
- **`07-pricing`** — On a venue spread wider than the markup the client quote
  sat inside the venue's; the markup is now applied outward from the venue's
  own sides. Found by `pricing_laws`.
- **`19-client-api`** — A signed amount was accepted at the edge; amounts are
  magnitudes and a minus sign is refused. Found by `money.test.js`.
- **`07-pricing`** — The staleness limit was a synthetic-era 500ms that
  refused a real feed's quotes at the gateway's own batch cadence; it now
  reads `MAX_QUOTE_STALENESS_MS` and defaults to the two seconds risk accepts.
- **`services/mt5-bridge`** — The MetaQuotes installer refuses to run under
  Wine 11 ("a debugger has been found"); Wine 10.0 is pinned.


### Added — Project X Ops, the operator console

A standalone app on its own port with its own deploy (`apps/ops`, `:27030`),
built on the shape of nova-ops. It is deliberately not part of `20-web`: the
client area ships product, and the operator surface lives apart so it can be
secured, exposed and audited separately.

- **`19-client-api`** — `admin.js`: the operator surface at `/v1/admin/*`,
  behind a shared token. It reads across every client, which is the opposite of
  every other read in that service, so it is reached differently on purpose — a
  client's session is never an operator credential, no sign-in flow reaches it,
  and an unset token disables the whole surface rather than leaving it open. It
  answers 404 rather than 403 to an unauthorised caller, because an admin API
  that announces itself has told somebody where to spend their time. Every
  mutation is written to `app.security_events` against the person it affected,
  with the operator named.
  Gates: G0–G5, G8, G9. Invariants: unchanged.

- **`apps/ops`** — Eleven pages: overview, users, user detail, accounts, gates,
  modules, infrastructure, database, audit, outbox and logs. Zero runtime
  dependencies, server-rendered, on the same spacing and type scales as the
  client area with a deliberately different palette — so a screenshot of the
  console is never mistaken for a screenshot of the product.

  The console holds the token and attaches it server-side; it never reaches the
  browser. It holds no database credential. Sign-in is one passcode against a
  signed HttpOnly cookie, throttled per address rather than globally — a single
  passcode locked globally would let anyone who can reach the console lock every
  operator out of it. Every action is a real form post with a double-submit CSRF
  token, so the whole console works with scripting off.

  Commands are resolved through compile-time lookup tables — gates by id, logs
  by service name — so nothing an operator types reaches a command line.

- **`apps/ops`** — Its own YAML parser for `registry/modules.yaml`, in place of
  a dependency. The console reads the same file the DAG check and the generated
  docs read, so a module added there appears here without anybody remembering to.

### Fixed

- **`apps/ops`** — The containerised console cannot run gates: no `make`, no
  toolchain, and the repository mounted read-only. It now detects that and says
  so on the board rather than offering a button that silently does nothing.
  Putting the build toolchain into the console image would have made the console
  a build machine, and created a second place where "the tests passed" could
  mean something different from CI.

- **`apps/ops`** — `git rev-parse HEAD` fails on a repository with no commits,
  which the console reported as "Git unavailable" — sending a reader to look for
  a problem with git. It distinguishes the two now. The same fix kept the
  command's own words: the exec error opens with "Command failed: …" and carries
  the real reason on the following line, which was being thrown away.

- **`scripts/check_performance.sh`** — G9 read a 2ms login as scrypt having been
  weakened. The logins were being refused with a 429, because G8 runs first and
  deliberately exhausts loopback's sign-in budget — so the gate was timing a
  refusal, which does no hashing at all. It takes its own budget now and measures
  only sign-ins that succeeded.

### Added — delivery, so a password reset actually completes

Password reset existed and could not be finished: the link was written to an
outbox with the reason it had not been sent, which was honest and useless. The
outbox is drained now.

- **`19-client-api`** — `mailer.js`: an SMTP client and an outbox worker. Three
  drivers — `none` keeps the previous behaviour and claims nothing, `log` writes
  the message to the service log, `smtp` sends it. The worker claims rows with
  `FOR UPDATE SKIP LOCKED` so two instances never send the same message twice,
  records a failure on the row rather than dropping it, and retries on the next
  pass. Addresses are re-validated before they reach a command line, because a
  newline in an address is SMTP header injection.
  The client is written out rather than pulled in, on the rule the Dockerfile
  already states: a hand-rolled Postgres wire protocol would be worse than the
  driver, and SMTP submission is the other side of that judgement — eight verbs
  and a line-oriented grammar against a dependency tree.
  Gates: G0–G5, G8, G9. Invariants: unchanged.

- **`00-foundation`** — Mailpit in the composed stack, so "the link was
  delivered" is something the end-to-end suite checks rather than assumes. The
  suite drives the reset from the **message body**, not the outbox.

### Fixed

- **`19-client-api`** — `buildMessage` joined its headers with CRLF and inserted
  the body raw, so it was only correct because `dotStuff` happened to run on its
  output afterwards. Bare LFs are accepted by some servers and rejected by
  others, which would have made delivery fail intermittently and per-recipient.
  Found by a unit test written against the function rather than the pipeline.

- **`20-web`** — The forgot-password page hard-coded "nothing was emailed to
  you". True with no provider and a lie with one — it would have sent somebody
  hunting for a workaround while the link sat in their inbox. The page now reads
  the delivery state from the API and says whichever is true; the end-to-end
  test asserts the same thing, rather than pinning one branch.

- **`19-client-api` / `20-web`** — The development link on the reset
  confirmation is no longer rendered once mail is actually delivered. A live
  reset link in a page is a live reset link on a screen.

### Security

- **`00-foundation`** — Every remaining development credential in `.env` is
  rotated: the Postgres superuser, both least-privilege role passwords, and the
  ClickHouse, MinIO and Grafana defaults. None of the last three is reachable
  from the tunnel, but "not currently exposed" is a property of today's network
  rather than of the password.

- **`19-client-api`** — G4 and G8 retrieve the reset token from the outbox where
  it is exposed and from the mail sink where it is not. Both configurations are
  real now, and a gate that only runs in one of them stops running the moment
  the deployment changes.

### Security — G8 and G9 were declared blocking and ran nothing

Both gates were in `gates/gates.yaml` from the start with an empty command list
marked "CI only". A required gate that executes nothing reads as satisfied on
the matrix, and neither had ever been answered. Both are implemented now, and
G8 found real defects on its first run.

- **`19-client-api`** — `scripts/check_security.sh` answers all five checks the
  registry asks for: an authn/authz matrix across every session-only endpoint,
  input fuzzing on every external boundary, dependency and image scanning,
  secret handling and rotation, and audit-log completeness with tamper
  evidence. `scripts/check_performance.sh` answers G9: per-endpoint latency
  against budgets, the deliberately expensive password path bounded in *both*
  directions, concurrency, and a recorded baseline for regression comparison.
  Gates: G0–G5, G8, G9. Invariants: unchanged.

### Fixed — found by the new gates

- **`19-client-api`** — A JSON body of `null` (or `[]`, or a bare string) turned
  **every** POST endpoint into a 500. `null` is valid JSON and every handler
  reads `body.something` off it. Bodies must now be objects, and `__proto__` /
  `constructor` keys are stripped before anything downstream spreads them.
  Found by the G8 fuzzer: eight endpoints, one payload.

- **`19-client-api`** — Market-data parameters were forwarded unvalidated, so a
  junk symbol reached the upstream, was refused there, and came back to the
  client as a **502** — the edge blaming a dependency for a request that asked
  for `../../etc`. It also made a scripted bad request look like an outage to
  every monitor. Validated at the edge now; a bad symbol is a 400.

- **`19-client-api`** — An oversized request body destroyed the socket before
  the refusal was written, so the client got no response at all rather than a
  413 — indistinguishable from the service falling over. The stream is paused
  instead, and the 413 is delivered.

- **`19-client-api`** — `x-forwarded-for` was believed from any caller, which
  made the per-address sign-in budget worthless: rotating the header on every
  request meant no guess ever accumulated against the guesser. It is honoured
  only from a trusted proxy now. G8 runs the attack — 45 guesses through the
  public surface, a different forged address on each — and asserts the throttle
  still bites.

- **`19-client-api`** — The sign-in failure budget counted the wrong things. It
  charged for malformed input and for requests that carried **no** credential
  at all, so one person with a broken integration behind a shared address could
  stop everyone else on that address from signing in *or signing up*. It now
  counts only a credential that was presented and rejected, and gates only the
  endpoints that check one. Both halves are verified: an account still locks
  after five failures, and spraying one password across many accounts is still
  throttled.

- **`03-ledger`** — The composed ledger had never started. It runs as a non-root
  user (INV-902) and opened its journal in root-owned `/var/lib`, so it died
  with "Permission denied" on every restart and the whole `core` profile failed
  its dependency check. The directory is created and owned in the image — and
  the journal now has a named volume, because the financial source of truth was
  otherwise living in the container's writable layer and would not have survived
  `--force-recreate`.

- **`19-client-api` / `20-web`** — Both images carried ten HIGH and one CRITICAL
  advisory, every one of them inside npm's vendored tree. INV-902 already
  forbade a package manager in a runtime image; the check only grepped the
  Dockerfile for `apk add` and never looked at what actually shipped. npm and
  apk are removed from both runtimes, openssl is patched (CVE-2026-14456), and
  INV-902 now inspects the built image. All six images scan clean.

### Changed — the deployed stack is hardened, and cannot be replaced by accident

- **`19-client-api` / `20-web`** — The stack published at a public hostname was
  running development defaults: the outbox was readable by anyone (live
  password-reset links for **any** account), and `x-client-id` let any caller
  act as any owner. Both were confirmed exploitable from the internet before
  being closed. The deployment now runs with `AUTH_REQUIRED`, no client-id
  header, no outbox, rotated database credentials and its real public origin.

- **`00-foundation`** — `dev_stack.sh` refuses to start when `.env` says
  `ENVIRONMENT=production`. It serves the development configuration on the same
  reserved ports, so running it — including as a side effect of `make e2e` —
  replaced a hardened deployment with an unauthenticated one at the same public
  address, silently. `ALLOW_REPLACING_DEPLOYMENT=true` still allows it; nothing
  does it by accident.

### Security — client isolation moved into the database

Isolation used to rest on a `WHERE owner_id = $1` in every statement. That works
until somebody forgets one, and the failure is silent, total, and discovered by
a customer. It is enforced underneath the application now.

- **`19-client-api`** — Three database roles where there was one. The schema is
  owned by `projectx` and served by `projectx_app` (ordinary requests) and
  `projectx_auth` (credential checks). Neither serving role is a superuser and
  neither may bypass RLS — **the application was previously connecting as a
  superuser with BYPASSRLS**, under which every policy below would have been
  ignored without an error, a warning, or any visible difference. Every table in
  `app` has `FORCE ROW LEVEL SECURITY`; `projectx_app` sees only rows matching a
  transaction-local `app.current_user_id`, and `projectx_auth` has no grant at
  all on `app.accounts` or `app.funding_requests` — signing in cannot read a
  trading account, enforced by the absence of a grant rather than the absence of
  a query.
  The property that matters: **an unscoped query returns nothing.** A handler
  that forgets its scope reads zero rows, not everybody's.
  Gates: G0, G1, G2, G4, G5. Invariants: INV-188 added.

- **`19-client-api`** — `scripts/check_isolation.sh` proves it against the
  database rather than through the API, connecting as the application's own role
  and issuing the statements a buggy handler would issue: unscoped select, a
  direct read of another client's row by name, an insert owned by somebody else,
  an update reassigning a row, and a scope leaking past its transaction. Testing
  this through the API would only prove today's `WHERE` clauses are correct.
  Negative-tested: dropping a policy and granting BYPASSRLS each fail the gate.

### Added — password reset, email confirmation, and an audit trail

- **`19-client-api`** — Password reset, for real. Single-use tokens stored only
  as digests, expiring in an hour, invalidating any earlier one, and revoking
  **every** session on completion — somebody resetting a password is recovering
  an account or was locked out of it, and leaving old sessions alive defeats the
  point in both cases. A request answers identically whether or not the address
  is registered, because "no account with that address" answers "does this
  person bank here?" for anyone who asks.
  Gates: G0, G1, G2, G4, G5. Invariants: INV-189 added.

- **`19-client-api`** — An outbox. There is no email provider, so a reset link
  has nowhere to go. Dropping it would make reset untestable and undemonstrable;
  claiming to have sent it would be a lie told to somebody already locked out.
  It is queued instead, with the reason it has not been delivered recorded
  alongside — a real outbox a delivery worker would drain. Reading it is
  equivalent to reading somebody's inbox, so it is exposed over HTTP only where
  explicitly enabled and never in production.

- **`19-client-api`** — `app.security_events`: what happened to an account, as
  opposed to what it looks like now. Written in the same transaction as the
  change it describes, so an audit row cannot survive a rollback and describe
  something that never happened. It never carries the thing itself — no
  password, no token, no TOTP secret — because an audit log is read by more
  people than the tables it describes, and retained for longer.

- **`20-web`** — The reset and confirmation screens, the activity panel on
  Security, and address confirmation. The forgot-password page collects an
  address now that there is a reset behind it, and still refuses to claim an
  email was sent.

### Fixed

- **`19-client-api`** — Changing a password left the current session's token
  unchanged. The credential that existed before the change still worked after
  it, so changing a password *because* somebody else had your session
  accomplished nothing for the one session that mattered. The token is now
  reissued in the same response, and the web app swaps the cookie for it.
  Gates: G0, G1, G2, G5. Invariants: unchanged.

- **`19-client-api`** — `x-client-id` was honoured unconditionally, so any
  caller could name any owner and be treated as them. It is a development
  affordance the gate scripts depend on, so it survives — but it is now named as
  an impersonation primitive, switchable off, and refused outright in
  production.
  Gates: G0, G1, G2, G4. Invariants: unchanged.

- **`19-client-api`** — Startup now refuses a production process carrying
  development defaults: either role password unchanged, `AUTH_REQUIRED` unset,
  `TRUST_CLIENT_ID_HEADER` on, or the development database password in
  `DATABASE_URL`. Each is survivable alone and an incident together, and a
  deployment checklist is a thing people complete from memory at the end of a
  long day. The service also reads the isolation state back out of the catalogue
  at boot and refuses to serve if a serving role can bypass RLS or a table lost
  its policies.

### Added — identity: registration, sessions and second factors

Until now every request in the client area was attributed to one shared
development owner, and the API said so in its own `/v1/profile` response. There
is now a real identity: a person registers, signs in, owns trading accounts
nobody else can see, and can sign out. `16-kyc-aml` still owns identity
*verification* — who someone is in the world — and nothing here pretends
otherwise. A session proves you hold this account's password. It proves nothing
else, and both the API and the profile screen say that in those words.

- **`19-client-api`** — `auth.js`: registration, sign-in, sessions, password
  change, and TOTP second factors with single-use recovery codes. Passwords are
  scrypt digests (N=16384, per-password salt, parameters stored with the digest
  so they can be raised later). Session tokens are stored only as their SHA-256,
  so a dump of the schema yields neither a password nor a usable session. A
  refused sign-in is one message and one amount of work whether the address is
  registered or not — an absent user is still verified against a dummy digest,
  because returning early is a timing oracle. Five failed attempts lock an
  account for fifteen minutes.
  Gates: G0, G1, G2, G3, G4, G5. Invariants: INV-185, INV-186, INV-187 added.

- **`20-web`** — Sign-in, registration and an honest forgot-password page; the
  security screen's password, two-factor and session controls, which were
  rendered disabled with a note explaining that authentication did not exist.
  The token reaches the browser as an HttpOnly, SameSite=Lax cookie that the web
  server exchanges for a bearer credential when it proxies, and is stripped from
  the response body on the way past — so an XSS is a defacement rather than an
  account takeover, and there is no CSRF token to get wrong. Both forms are real
  `<form method="post">` elements that complete with JavaScript disabled.
  Gates: G0, G1, G2, G4, G5. Invariants: INV-192 added.

- **`20-web`** — The profile screen's verification panel showed a fabricated set
  of states: email and phone "verified", a document "pending", an address
  "required". Nothing had checked any of them. It was the one screen in the
  client area that invented its contents, and it invented precisely what a
  person uses to judge whether their account is ready to withdraw from. It now
  reports what is known — signed in, second factor on or off — and marks the
  rest `unavailable` against the module that would own it.
  Gates: G0, G1, G2, G4. Invariants: unchanged.

### Fixed

- **`20-web`** — The "Open an account" dialog could not be submitted on any
  viewport shorter than its own content. `.modal` capped its height and
  `.modal-body` was `overflow-y: auto`, but the `<form>` wrapping the head, body
  and footer was a plain block: it grew to its content, the body never became
  scrollable, and the footer holding the submit button was pushed off-screen
  with no way to scroll to it. The dialog rendered perfectly and was unusable.
  This is the second defect of exactly this shape — the first made the same
  dialog impossible to close — so the stylesheet suite now asserts every link in
  the chain, and a negative test confirms each assertion fails when broken.
  Found by driving the dialog from a browser for the first time; no suite had
  ever clicked its submit button.
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged.

- **`20-web`** — The sign-in and change-password buttons rendered their icon
  above the label rather than beside it. `.btn` is an inline-flex row, but a
  button that swaps its label for a busy state wraps both in a span — and the
  span becomes the flex item, leaving the icon inside on the text baseline.
  Found by looking at the rendered page; every structural test passed while it
  was wrong, because the markup was correct and only the layout was not.
  Gates: G0, G1, G2, G4. Invariants: unchanged.

- **`19-client-api`** — The first version of the sign-in rate limit counted every
  credential request against a per-address budget. A shared egress address — an
  office behind NAT, a mobile carrier's CGNAT, a school — would have exhausted
  it with nothing but people successfully signing in, locking out the whole
  building; the end-to-end suite hit it within twelve seconds of legitimate
  traffic. It now counts **failures only**, so signing in correctly costs
  nothing and each guess costs one. The per-account lockout is the other half:
  this bounds an attacker spraying many accounts, that one bounds an attacker
  grinding a single account.
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged.

### Security

- **`19-client-api` / `20-web`** — Four laws added to the registry and executed
  at G4, each with a negative test confirming the check fails when the property
  is broken:
  - **INV-185** — no credential is stored in a recoverable form.
  - **INV-186** — a refused sign-in does not reveal whether an address is registered.
  - **INV-187** — a session reaches only the rows its own user owns; every
    session statement is scoped by that user or by a digest the caller proved
    they hold.
  - **INV-192** — the session token is never reachable by script.

  The INV-192 check strips comments before looking: `HttpOnly` is discussed at
  length in the doc comment above the cookie builder, and a plain `grep` stayed
  green after the code stopped setting it.

### Added — the trading loop

The nucleus described in the README now exists and runs: market state →
pricing → order → risk → execution → position → P&L → ledger → replay. A demo
account can be opened, funded, traded and closed from a browser, and every
figure it shows is one the core computed.

- **`03-ledger`** — Double-entry journal and the balance projection over it.
  `Transaction` cannot be constructed unbalanced; `Journal` exposes no method
  that edits history; `Balances` is a fold over the journal with a `verify`
  that proves the running projection equals a fresh recompute, and a drift
  alarm that names the account when it does not.
  Durability is an append-only log, `fsync`ed before an effect is
  acknowledged, replayed at startup. A torn final write is discarded.
  Gates: G0, G1, G2, G4, G5, G6 on this tree.
  Invariants: unchanged — INV-020…024 now executed rather than declared.

- **`04-account`** — Account lifecycle and demo capital. The type carries **no
  balance field**, so INV-031 is structural rather than remembered: there is
  nothing to mutate. Demo capital is issued against `equity:demo:capital`, so
  the amount in circulation is readable off the ledger.
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged — INV-030…032 executed.

- **`05-position`** — Netting, volume-weighted average price and realised P&L
  as a fold over fills. A close to zero removes the position rather than
  leaving a zero row with a stale average price; a reversal through zero opens
  a new position instead of flipping the sign on the old one.
  Gates: G0, G1, G2, G4, G5, G6. Invariants: unchanged — INV-040…043 executed.

- **`06-market-data`** — Instruments and a canonical feed that is a **pure
  function of the tick index**, built from integer value noise. Any past state
  recomputes exactly, which is what lets a fill be re-derived from the journal
  alone. Candles are a view over that function, not a stored table.
  Five instruments across FX, metals and crypto, all USD-quoted.
  Gates: G0, G1, G2, G4, G5, G6. Invariants: unchanged — INV-050…052 executed.

- **`07-pricing`** — The client quote: venue mid plus a versioned markup, on
  the instrument's own price grid, refusing to price from stale state.
  Gates: G0, G1, G2, G4, G5, G6. Invariants: unchanged — INV-060…063 executed.

- **`08-pnl-margin`** — Equity, used margin, free margin and margin level.
  Margin is taken at the entry price and does not float with the mark, so a
  drawdown does not consume margin as the account can least afford it. Margin
  level with nothing open is **absent**, not zero and not infinity.
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged — INV-070…073 executed.

- **`09-risk`** — Pre-trade checks, failing closed. `Approval` has a private
  field and no public constructor, so INV-082 is enforced by the compiler:
  `11-execution` cannot build a deal without one, and there is no path in the
  crate that produces one from an error.
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged — INV-080…083 executed.

- **`10-oms`** — The order state machine, with `UNKNOWN` as a real state. A
  core that does not answer leaves the order unknown and non-terminal rather
  than guessing; one client order id maps to one order forever, including
  across a retry after a timeout.
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged — INV-090…093 executed.

- **`11-execution`** — An approved order becomes exactly one deal and exactly
  one balanced set of postings. The fill is applied to a scratch book first, so
  a failure part-way leaves no position that no transaction explains.
  Realised P&L is asserted equal to the postings for the same close (INV-042).
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged — INV-100…104 executed.

- **`19-client-api`** — Real endpoints for instruments, quotes, candles,
  trading accounts, orders and position closes. Orders go through `10-oms`
  rather than shortcutting to the ledger, so retries have one front door.
  The edge still computes nothing and still refuses money sent as a JSON
  number. Gates: G0, G1, G2, G4, G5. Invariants: unchanged.

- **`20-web`** — The trading terminal: a canvas candlestick chart, a live quote
  strip, an order ticket, the account summary and both blotters. The page
  performs no arithmetic on money; the one place it converts a quoted figure
  into a number is chart geometry, and that conversion is exact and integer-only.
  It renders and remains readable with JavaScript disabled.
  Gates: G0, G1, G2, G4, G5. Invariants: unchanged.

- **`00-foundation`** — `service-kit` gained a dependency-free JSON reader
  (no floating-point variant, so an amount cannot become an `f64` in it), a
  request type carrying method, query, headers and body, and a minimal HTTP
  client with mandatory timeouts and no redirect, keep-alive or chunked
  handling.
  Gates: G0, G1, G2. Invariants: unchanged.

- **`00-foundation`** — **End-to-end gate (G5).** `tests/e2e` drives Chromium
  through the whole stack: the chart plots real candles and keeps ticking, an
  order fills and opens a position, P&L moves with the market, closing settles
  it, and the ledger balances after every trade. Refusals are asserted to name
  the rule that refused them. 22 tests, no stubs.
  `scripts/dev_stack.sh` runs every service from the working tree on the
  reserved port block, reaping only this project's own stale listeners.
  Gates: G0, G1, G2. Invariants: unchanged.

### Fixed

- **`20-web`** — The `/api/*` proxy forwarded only the pathname, dropping every
  query string. A chart request for 180 candles of EURUSD reached the API as a
  request for nothing, which it answered with a 404 that looked like the market
  being unavailable. Found by the end-to-end suite on its first run.
  Gates: G0, G1, G2, G5. Invariants: unchanged.

- **`10-oms`** — A refusal buried its reason inside the core's own reply, so a
  client had to know that shape to find out why an order was refused — and
  would otherwise render "something went wrong". The reason is now lifted to
  the top level of the order, and the terminal shows it.
  Gates: G0, G1, G2, G4. Invariants: unchanged.

- **`19-client-api`** — The rate limit of 240 requests per minute was sized for
  a page of static content. A single open terminal makes about 120 a minute, so
  two tabs throttled the client — a denial of service the platform performed on
  its own users. Raised to 1 200 with the arithmetic recorded at the constant.
  Gates: G0, G1, G2. Invariants: unchanged.

- **`19-client-api` / `20-web`** — Two checks had gone stale against a system
  that started working. `check_client_area_invariants.sh` matched a JSDoc line
  mentioning `08-pnl-margin` as arithmetic on a financial figure, and demanded
  that `/v1/wallet` always return a null balance. INV-183 is not "the balance
  is always null" — it is "a figure is an exact decimal string, or null with a
  stated reason, and never a substituted zero", and the check now says that.
  Gates: G0, G1, G4. Invariants: unchanged.

### Changed

- **`registry`** — `03-ledger`, `04-account`, `05-position`, `06-market-data`,
  `07-pricing`, `08-pnl-margin`, `09-risk`, `10-oms` and `11-execution` move
  from `planned` to `in-progress`. Invariant coverage enforcement rises from
  20 invariants to 56.
  **G3 is claimed by none of them.** The suites exercise wide input ranges
  exhaustively, but that is not a property-based generator with shrinking, and
  claiming the gate for it would make it a label rather than a check.
  G7, G8 and G9 remain CI-only and unclaimed.


### Added — repository foundation

- **`00-foundation`** — Monorepo layout: Cargo workspace (`crates/`, `services/`,
  `tests/`), Node services (`services/client-api`, `apps/web`), Python repository
  tooling (`scripts/`). Makefile with the full local gate suite.
  Gates: G0, G1, G2. Approved by: n/a (foundation; dev/staging only).
  Invariants: unchanged.

- **`00-foundation`** — Docker Compose stack with profiles `infra`, `core`,
  `edge`, `web`, `obs`: PostgreSQL 17, Redpanda, Redis, ClickHouse, MinIO, the
  four Rust core services, the client API, the web console, and the
  OpenTelemetry/Prometheus/Grafana/Jaeger stack.
  Host ports occupy a reserved block (`27000–27019`) bound to `127.0.0.1` only,
  verified free on the target machine; `make up` runs `scripts/check_ports.sh`
  first and refuses to start rather than displace a running process.
  Network and volumes are `projectx_`-prefixed so the stack cannot collide with
  anything else on the host.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — Gate machinery. `gates/gates.yaml` defines G0–G12;
  `gates/status.yaml` records results; `scripts/check_gates.py` enforces that no
  module may proceed while an upstream dependency is short of its declared gates.
  `G0`, `G1`, `G2`, `G4` marked non-waivable. `scripts/run_gates.py` runs a
  module's declared gates locally, failing fast.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — Module registry (`registry/modules.yaml`): the single
  source of truth for 22 modules — dependencies, tiers, required gates, declared
  invariants, test obligations, known failure modes.
  `scripts/check_dag.py` proves the graph is acyclic, that every declared gate
  and tier exists, that no module omits a non-waivable gate, that a module
  declaring invariants also requires G4, and that one declaring an SLO requires G9.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — **Regression ratchet** (`scripts/check_regressions.py`).
  Fails the build when an invariant, a required gate, a dependency edge, a module
  or a test disappears, or when a module's status regresses. Moving the ratchet
  deliberately requires `make baseline` in the same PR, putting the change in the
  diff where a reviewer sees it. Verified against three simulated regressions.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — **Invariant coverage enforcement**
  (`scripts/check_invariant_coverage.py`). A module with status `in-progress` or
  `done` may not declare a financial law that no test executes.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — **Documentation is a gate.** Module pages, the dependency
  graph, the invariant catalogue and the README status matrix are generated from
  the registry by `scripts/gen_docs.py`. CI runs `--check` **and** regenerates and
  asserts an empty `git diff`, on every push, pull request and merge queue entry,
  so generated docs can neither go stale nor be hand-edited. A pre-commit hook
  regenerates and stages them automatically. CI additionally verifies every
  required hand-written document exists, and that a PR touching code or the
  registry updates this changelog.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — Banned-pattern scan (`scripts/banned_patterns.sh`) making
  the principles mechanical: no floating point in financial code, no direct
  balance mutation, no wall-clock read inside the determinism boundary, no
  `unwrap`/`expect` on a production path, no `HashMap`/`HashSet` in replayable
  code, and no money parsed as a JavaScript number at the edge. Scans production
  code only; exceptions require a reviewed `ALLOW-BANNED` annotation.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — Git hooks (`.githooks/`, `make hooks`): pre-commit runs
  the cheap structural checks and auto-regenerates docs; pre-push runs what CI
  runs. CODEOWNERS assigns Tier 0 ownership. PR template carries the gate and
  invariant checklist.
  Gates: G0, G1. Invariants: unchanged.

- **`00-foundation`** — Documentation set: overview, principles, architecture,
  dependency DAG, gates, invariants, CI/CD, deployment topology, environments,
  testing strategy, security, observability, data stores, glossary, roadmap;
  seven ADRs; three runbooks (release, financial discrepancy, emergency change);
  22 generated module specifications.
  Gates: G0, G1. Invariants: unchanged.

### Added — financial core

- **`01-domain-kernel`** — Fixed-point, currency-typed money. `Money<C>` is an
  exact integer count of minor units; the currency is a type parameter, so
  `Money<Usd> + Money<Eur>` fails to compile (asserted by a `compile_fail`
  doctest). Checked arithmetic throughout — overflow is an error, never a wrap,
  with overflow checks left on in release. Named rounding policies with no
  default. `split(n)` distributes the remainder so shares sum exactly to the
  original. Exact decimal-string parsing that refuses precision it cannot keep.
  `Price`/`Quantity` with notional calculation requiring an explicit policy.
  **Zero external dependencies** (ADR-0006).
  Gates: G0, G1, G2, G3, G4 locally green.
  Invariants: INV-001–INV-005 declared and executed.

- **`02-event-kernel`** — Event envelope, identity, gapless per-aggregate
  sequencing, canonical byte-stable serialization with length-prefixed fields,
  idempotent append, and an append-only in-memory stream with fold/replay.
  Observation time is metadata and never reaches the canonical bytes.
  **Zero external dependencies.**
  Gates: G0, G1, G2, G3, G4 locally green.
  Invariants: INV-010–INV-014 declared and executed.

- **`00-foundation`** — `service-kit`: shared health, readiness (separate from
  liveness), Prometheus metrics and structured JSON logging for the Rust
  services, plus a static `healthcheck` binary so runtime images carry no shell
  or curl. Zero external dependencies.
  Gates: G0, G1, G2. Invariants: unchanged.

- **`03-ledger`, `06-market-data`, `07-pricing`, `10-oms`** — Phase 0 service
  shells. The ledger arms the INV-020/INV-023 monitors; market-data exposes its
  staleness policy; pricing implements markup as a pure function with tests for
  INV-060 and INV-061; the OMS implements the order state machine with an
  exhaustive legal-transition matrix and **refuses to start unless
  `RISK_FAIL_MODE=closed`** (INV-083). None performs financial mutation — the
  gate rule forbids it until their dependencies pass.
  Gates: G0, G1, G2. Invariants: unchanged.

- **`19-client-api`** — REST edge. Money crosses the boundary as a decimal string
  and is never converted to a JavaScript `number`. Mandatory idempotency keys on
  mutating endpoints (INV-181), per-client rate limiting, body size caps,
  upstream timeouts that fail closed. Refuses to fake an accepted order while
  `09-risk` and `11-execution` are ungated. Zero runtime dependencies.
  Gates: G0, G1. Invariants: unchanged.

- **`20-web`** — Operator console showing live core health, the build order and
  the non-negotiables. Computes no financial figure (INV-190). Zero runtime
  dependencies.
  Gates: G0, G1. Invariants: unchanged.

### Fixed — the dialog could never be closed, and nine defects found tracing it

- **`20-web`** — **The Open account dialog could not be dismissed.**
  `.modal-backdrop` set `display: grid`, and an author `display` declaration
  beats the user-agent `[hidden] { display: none }` regardless of specificity.
  The stylesheet had no `[hidden]` rule of its own, so `el.hidden = true`
  flipped the attribute and changed nothing. Every close path — ×, Cancel,
  Escape, backdrop click — was firing correctly the whole time. The dialog was
  also visible from first paint, not only after clicking "Open account".
  Fixed with `[hidden] { display: none !important; }` in the reset, which closes
  the whole class rather than the one instance.
  Gates: G0, G1, G2, G4. Invariants: unchanged.

- **`20-web`** — Undefined CSS token `--bg-25` (`--n-25` was defined), so table
  headers had no background and did not separate from rows while scrolling.

- **`20-web`** — `data-responsive-split` had **zero** matching CSS rules. The
  Deposit, Withdraw and Profile layouts hardcoded a 300px sidebar column inline
  at every width, so they squeezed and overflowed on narrow screens.

- **`20-web`** — Latent XSS: `toast()` assigned API error text through
  `innerHTML`. Now built as nodes with `textContent`.

- **`20-web`** — `/terminal` served the Performance page under a "Trading
  terminal" title, opened in a new tab. Now an honest gated page naming
  `11-execution`.

- **`20-web`** — Six dead links: `/security`, `/settings`, `/signout`,
  `/docs/terms`, `/docs/risk`, `/docs/privacy` were linked from the profile menu
  and footer and every one returned 404. All six are now real screens.

- **`20-web`** — Real/Demo tabs discarded the chosen sort order and view.
  The theme toggle pictured the current theme rather than the one it switches to.
  The collapsed sidebar flashed expanded on load, because the pre-paint script
  set `data-rail` on `<html>` while the CSS keyed off `.app`.

- **`19-client-api`** — **Seeding race.** `seedIfEmpty()` ran on every
  `GET /v1/accounts`, and the accounts page issues two of those concurrently;
  both could observe an empty table and each insert a pair. Moved off the read
  path to startup and wrapped in a transaction behind a per-owner advisory lock.
  Verified: five concurrent seeders, exactly one claims the work, exactly two
  accounts created.

- **`19-client-api`** — **A crash the type checker found on its first run:**
  `accounts.js` called `pool.connect()` but only imported `query`. Account
  sorting compared numeric identifiers with `localeCompare`, so `50000010`
  sorted before `5000009`.

- **`00-foundation`** — `make help` hid every target containing a digit; its
  regex was `^[a-zA-Z_-]+`, so the whole `pm2-*` group was invisible.

### Added — the document suite and the pages a brokerage site actually has

- **`20-web`** — **The footer was one paragraph block and four links.** It is now
  three bands, each separated by a rule and each constraining its content to the
  same measure as the page: navigation (brand, status indicator, five link
  columns), the disclosure band (risk warning, regulatory position, and why
  figures read as unavailable) on a muted ground so it reads as legal copy, and
  the legal line (copyright plus seven policy links).

- **`20-web`** — **A full legal and policy suite: 13 documents**, driven by one
  registry and one renderer, with a `/docs` index grouped by Terms, Data,
  Compliance, Payments and Security. Client agreement, risk disclosure, order
  execution policy, conflicts of interest, privacy, cookies, AML and CTF,
  complaints procedure, client funds and investor compensation, refunds and
  chargebacks, responsible disclosure, accessibility statement, and regulatory
  status. Each has a table of contents, a version date and a breadcrumb.

  **None of them invents a licence, regulator or registration number.** A test
  asserts that: it fails the build if a document ever grows a licence number, a
  registration number, an "authorised and regulated by" clause, or a named
  regulator. A plausible-looking licence is the single most common feature of a
  fraudulent broker site, so the regulatory-status document occupies that
  position and states the truth instead.

- **`20-web`** — **Eight product pages that were missing.** Instruments
  (spreads, overnight financing and trading hours by symbol, labelled as
  indicative configuration rather than presented as a live feed), fees and
  charges, platforms, API access with the endpoint list and its live/gated
  state, verification, contact, about, and a full notifications page.

- **`20-web`** — Instruments and Verification added to the sidebar; the
  notifications dropdown now leads to the full page.

- **`20-web`** — Three further guards: the footer must be banded with every
  band constraining its content; the document suite must be reachable from the
  footer and carry both the risk warning and the regulatory position; every
  document must render its title and at least four sections. All 13 documents
  are rendered and asserted, not a sample.

  Route coverage: **42 routes**, every one asserted to resolve by the existing
  dead-link test, which now enumerates the document registry rather than a
  hardcoded list.

### Fixed — visual defects visible on the accounts screen

- **`20-web`** — **The collapsed sidebar rendered blank rows.** Nav items
  contained only `<span class="nav-label">`, which rail mode hides, so every
  item collapsed to an empty 36px box — including the highlighted active one.
  Every item now carries its own glyph, and `NavItem.icon` is a required
  property, so a new item without one fails the type check.

- **`20-web`** — **Promo card titles ran into their body text.** `.promo-title`
  and `.promo-text` are `<span>`, inline by default, with no `display: block`.
  They rendered as one run-on line.

- **`20-web`** — **The footer did not line up with the page.** `.footer` was
  full-bleed while `.page` is centred at `--content-max`, so footer text began
  at the far left of a centred layout. Content now sits in a `.footer-inner`
  wrapper sharing the same measure, with the rule still spanning the viewport.

- **`20-web`** — The promo row was a horizontal scroller that clipped the last
  card mid-content at common widths, reading as a layout fault rather than an
  invitation to scroll. It is now a wrapping grid.

- **`20-web`** — **Account cards had no hover state at all.** Added hover for
  account rows, stat cards and promos, and a `:hover`/`:focus-visible` state for
  every interactive component — asserted by a test rather than left to review.

- **`20-web`** — Colour now carries information instead of being absent.
  Each navigation section has a hue applied to its icons, the active row gets a
  2px rail in that hue, each promo card tints its own icon chip, and account
  type badges are tinted per type so a list is scannable without reading every
  badge. Hues are used on icons and borders only — never on text or fills.

- **`20-web`** — The account row menu used the 3×3 "apps" glyph where a "more"
  affordance belongs; added a vertical-ellipsis icon.

- **`20-web`** — Three further guards: no shimmer, skeleton, looping animation
  or gradient anywhere; every interactive component declares hover and focus;
  every nav item renders an icon, asserted against rendered output as well as
  against the data.

### Added — gates for the JavaScript side, which had none

- **`00-foundation`** — Before this, **no JavaScript in the tree was checked by
  anything**: `make lint` ran clippy and the banned-pattern scan, neither of
  which looks at a `.js` file. `scripts/check_frontend.sh` adds three stages —
  G0 syntax (`node --check`), G1 types (`tsc --noEmit` with `checkJs`, `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), and G2 the
  `node:test` suites. Wired into `make lint`, `make test`, `make fmt-check` and
  the `g1-static` / `g2-unit` CI jobs.
  The first run reported 245 errors across the two packages, including the
  `pool` crash above; both packages now type-check clean at zero.
  Gates: G0, G1, G2. Invariants: unchanged.

- **`20-web`** — `apps/web/tests/stylesheet.test.js`: eight design-system
  guards, each encoding a class of defect rather than an instance — the
  `[hidden]` reset exists; nothing toggled via `hidden` also sets `display`;
  every referenced CSS custom property is defined; the dark theme redefines
  every colour token; no token is defined twice in one block; no colour is
  hardcoded outside the token blocks; focus is never removed without a visible
  replacement; reduced motion is honoured.

- **`20-web`** — `apps/web/tests/screens.test.js`: every screen rendered
  in-process and asserted — no unresolved template literals or `undefined`
  leaking into markup, no dead internal links, no duplicate element ids,
  balanced tags, no undefined CSS token in inline styles, the dialog rendered
  `hidden`, every form control and icon-only button carrying an accessible name,
  and no fabricated financial figure in a balance slot.
  Run by `make test-invariants` as part of G4, so INV-190/191 are now executed
  against rendered output rather than asserted by grep.

- **Verified the guards bite.** Removing the `[hidden]` reset, reintroducing
  `--bg-25`, and adding one dead link each produce a failing, specific test;
  restoring returns all 17 to green.

- **`00-foundation`** — `ecosystem.config.cjs` and `make pm2-start` /
  `pm2-stop` / `pm2-logs` / `pm2-status` / `docker-edge`. PM2 runs the two Node
  services against the Dockerised datastores and Rust core. `.cjs` on purpose:
  PM2's loader uses `require()` and silently registers **zero** apps against an
  ESM `.js` config under `"type": "module"`. Both runtimes bind the same
  reserved ports, so `make pm2-start` stops the docker edge containers first.

### Added — client area (19-client-api, 20-web)

- **`19-client-api`** — Account registry and client-area API. Open, list,
  archive and restore trading accounts; account metadata persisted in
  PostgreSQL under an `app` schema with a **deliberate absence of any balance,
  equity or margin column** — the same design as `ledger.accounts`, so the edge
  stores no financial value (INV-184). Endpoints for wallet, profile,
  notifications, funding intents and funding history. Validation on platform,
  account type, mode, currency, leverage and nickname. One runtime dependency
  (`pg`); ADR-0006's zero-dependency rule binds the financial core, not the edge.
  Gates: G0, G1, G2, G4. Approved by: n/a (blocked from release by upstream gates).
  Invariants: INV-183 and INV-184 added — an unavailable financial figure is
  returned as `null` with the module responsible, never as a substituted zero;
  the client-area store holds no financial column.

- **`19-client-api`** — Funding endpoints record an **intent** and return `503`
  naming the gate chain that blocks it (`03-ledger`, `15-reconciliation`,
  `17-payments`). Intents are idempotent at the database level via a unique
  `(owner_id, idempotency_key)` constraint, so a replayed request returns the
  original `requestId` rather than recording a second intent. No ledger effect
  is produced, and the response says so.
  Invariants: unchanged.

- **`20-web`** — The client area: accounts (real/demo, list/grid, sortable, with
  archived accounts as a peer section), open-account dialog, deposit, withdraw,
  transfer, transaction history, funding and crypto wallets, performance,
  order history, market overview, economic calendar, trading credits, referrals,
  profile, platform status and help. Server-rendered with zero runtime
  dependencies; `/api/*` is proxied server-side so the browser never learns the
  API address and there is no CORS surface.
  Gates: G0, G1, G2, G4. Invariants: INV-191 added — the rendered page contains
  no financial figure that did not come from the API, and performs no arithmetic
  on money.

- **`20-web`** — Design system rather than ad-hoc styling: one 4px spacing
  scale, one type scale, a neutral palette carrying the interface with a single
  accent reserved for state, borders instead of shadows for structure, and a
  light/dark theme by token swap applied before first paint. A single-family
  SVG icon set on a 24 grid at 1.5 stroke — no icon font, no emoji. Dialogs trap
  focus and restore it; menus close on Escape and outside click; every
  interactive element has hover, focus-visible, active and disabled states;
  `prefers-reduced-motion` is honoured.
  Invariants: unchanged.

- **Verified behaviour.** Money sent as a JSON number is refused at the edge with
  an explanation. A funding request replayed under the same idempotency key
  returns the original request id and ignores the changed amount. With the core
  unreachable the client area reports "not tradable" and fails closed rather than
  rendering stale or invented figures. Every balance surface reads "Balance
  unavailable" with the module responsible named — never zero.

- **`scripts/check_client_area_invariants.sh`** — G4 for the client area.
  Eleven static checks plus four live checks against the running stack, wired
  into `make test-invariants` and CI.

### Note on release

`19-client-api` and `20-web` are implemented but **cannot be released**: the gate
rule reports them BLOCKED behind `10-oms`, `04-account`, `05-position` and
`07-pricing`, which are themselves blocked behind the ledger chain. That is the
intended behaviour — the client area exists and runs locally, and the machinery
still refuses to let it ship on top of unproven modules.

### Added — test infrastructure

- **`tests/invariants`** — G3/G4 suite. A dependency-free deterministic property
  harness (SplitMix64) with seeds printed on failure and `PROPTEST_SEED` replay.
  16 invariant tests across roughly 100,000 generated cases per run, biased
  toward boundary values.
  Invariants covered: INV-001–005, INV-010–014.

- **`tests/replay`** — G6 suite. Replay from genesis is identical across runs;
  `snapshot + tail == full replay`; observation time does not affect replayed
  state; duplicate delivery does not change replayed state; balances stay exact
  across 10,000 events. Prints `state_hash=` so CI can compare across processes.

- **`infra/postgres/init/001_schema.sql`** — Event store and ledger schema.
  Append-only triggers on the event log and journal entries (INV-012, INV-022);
  unique `event_id` (INV-010) and `(aggregate_id, sequence)` (INV-011); a
  deferred constraint trigger enforcing `debits == credits` per transaction and
  per currency (INV-020, INV-021); balances as a **view**, with no balance column
  anywhere (INV-023); an `imbalances` monitor view.
  `scripts/verify_ledger_constraints.sh` proves at G5 that the database actually
  rejects what it must.

- **`infra/prometheus/rules/invariants.yml`** — Production invariant monitors.
  Every rule is severity `page`, because a violation means money is wrong now.

### Notes

Phase 0 ships **no financial behaviour on purpose**. Its deliverable is that
financial behaviour cannot later be shipped carelessly: the DAG, the gates, the
invariant catalogue, the regression ratchet and the documentation enforcement all
exist and are green before the first ledger posting is written.

Verified at the close of this phase: 62 tests passing, `clippy` clean at
`-D warnings` across the workspace, `rustfmt` clean, banned-pattern scan clean,
DAG acyclic, invariant coverage complete for every in-progress module, generated
docs in sync, and the regression baseline recorded.

## Version history

_No releases yet. The first tagged release will be `v0.1.0 — Broker Core`: the
loop from market state through pricing, order, risk, execution, position, P&L and
ledger, proven deterministic under replay and clean under reconciliation._

[Unreleased]: https://example.invalid/project-x/compare/main...HEAD
