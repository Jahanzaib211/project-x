# Project X Ops — the operator console

Internal control plane for **Project X**. A standalone app on its own port with
its own deploy, talking to `19-client-api`'s operator surface over HTTP.

> This is **not** part of the product. `20-web` ships the client area; the
> operator surface lives here so it can be secured, exposed and audited
> independently. Nothing in the client area can reach this, and no client's
> session is an operator credential however senior the person holding it.

## What it does

| Page | Capability |
|---|---|
| **Overview** | What is wrong right now, first — then clients, sessions, accounts, failed sign-ins, mail. Live core health and host load. |
| **Users** | Search and sort every client; click through to god mode. |
| **User detail** | Sessions, trading accounts, security history, mail. End sessions, clear a lockout, suspend, restore, remove a second factor. |
| **Accounts** | Every trading account, with its owner. Metadata only — balances live in the core. |
| **Gates** | All thirteen gates with their question, what requires them, the last result, its age and the commit it ran against. Run one, where the console can. |
| **Modules** | The registry graph: tier, status, required gates, invariant count, dependents. |
| **Infrastructure** | Containers, images, volumes, the reserved port block, tunnels, host, commit. |
| **Database** | What Postgres is actually enforcing — roles, row-level security, policies, grants. Read from the catalogue, not from a file. |
| **Audit** | Every security event across every client, filterable. |
| **Outbox** | The mail queue and why anything is undelivered. Bodies are never shown. |
| **Logs** | Per-service log viewer, from the container or the local run directory. |

## Architecture

```
operator browser
  │  passcode → signed HttpOnly cookie (HMAC, 8h)
  ▼
ops (:27030)  ── server-side only: X-Ops-Token ──►  client-api /v1/admin/*
  │
  ├─ registry/modules.yaml, gates/gates.yaml   (the repository, read-only)
  └─ docker, ss, git, /proc                     (the host)
```

- **The API token never reaches the browser.** The console holds it and attaches
  it server-side. That is the reason this is a server rather than a page talking
  to the admin API directly.
- **No database credential.** Everything about clients comes through the admin
  surface, so "what may an operator see" is decided once, by the service that
  owns the data.
- **Every mutation is audited** against the person it affected, with the
  operator named on the row.
- **CSRF** double-submit on every action, on top of `SameSite=Lax`.
- **Brute force** — five attempts per address per five minutes, timing-safe
  comparison. Per address, not global: one passcode locked globally would let
  anyone who can reach the console lock every operator out of it.
- **Command execution** is a compile-time lookup table. Nothing an operator
  types reaches a command line.
- **Security headers** — noindex, DENY framing, nosniff, no referrer, and a CSP
  that permits no external origin.

## Running it

```bash
# Secrets — the console refuses to start without them.
OPS_TOKEN=$(openssl rand -base64 32)          # must match the client API's
OPS_PASSCODE=<a long passphrase>
OPS_SESSION_SECRET=$(openssl rand -base64 48)

# In the composed stack:
docker compose --profile all up -d ops        # → http://127.0.0.1:27030

# On the host, which is the only way gates are runnable:
PORT=27030 API_INTERNAL_URL=http://127.0.0.1:27001 node apps/ops/src/server.js
```

## Two things it deliberately cannot do

**Run gates in the container.** The gates need `make`, a Rust toolchain, Python
and a writable tree. Putting that in the console image would make the console a
build machine and create a second place where "the tests passed" could mean
something different from CI. The container reports results and says plainly that
it cannot produce them; a console on the host can.

**Be exposed publicly.** It reads the docker socket, which is equivalent to root
on the host. It binds to loopback and belongs behind whatever you already trust.

## Why it looks different from the product

Darker, denser, cooler — on the same spacing, radius and type scales as
`20-web`. Two scales in one repository is how a design system stops being one;
two palettes is how an operator stops mistaking a screenshot of the console for
a screenshot of the product, and acting on the wrong surface.
