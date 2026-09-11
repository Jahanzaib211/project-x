# 10 — Security

## Threat model

| Adversary | Wants | Primary controls |
|---|---|---|
| External attacker | Funds, client data | WAF, authn/authz, network segmentation, no inbound path to T0 |
| Malicious client | Trade beyond limits, exploit pricing or settlement | Server-side risk (fail closed), idempotency, rate limits, surveillance |
| Compromised credential | Anything the credential can reach | Least privilege, short-lived credentials, rotation, audit trail |
| Malicious insider | Move money, alter history | Two-person approval on T0, append-only log, tamper-evident audit, segregation of duties |
| Compromised dependency | Code execution in our runtime | Pinned deps, SBOM, vulnerability scanning, signed artifacts, minimal images |
| Compromised LP/PSP | False executions or settlements | Reconciliation, per-provider isolation, contract validation |

The insider row is the one most often left out of threat models and the one this
architecture spends the most on: an append-only log, two-person approval, and
reconciliation exist as much for that adversary as for the external one.

## Controls by layer

**Edge (T4)** — WAF and DDoS protection; TLS 1.3; per-account and per-IP rate
limits; request size caps; strict schema validation; mandatory idempotency keys on
mutating endpoints; short-lived tokens with narrow scopes.

**Service** — mTLS between services; authorization on every call, never inherited
from the caller's claim to have checked; input validation at every boundary; no
secret in a log line, an error message or an event payload.

**Data** — encryption in transit and at rest; column-level encryption for PII;
database credentials per service with least privilege; **no service outside Tier 0
can connect to the Tier 0 database**; backups encrypted, and restores rehearsed.

**Financial** — every money movement traceable to an authenticated actor and an
authorised decision; two-person approval on withdrawals above threshold;
segregation of client and house money in the chart of accounts; withdrawal
destinations verified against verified identity.

**Build and supply chain** — pinned, lockfile-committed dependencies; SBOM per
artifact; signed images with provenance verified at deploy; minimal base images;
no build-time network access beyond the pinned registry.

## Authentication and authorization

- Clients: OIDC, MFA mandatory for withdrawals and profile changes, device binding.
- Staff: SSO, MFA, role-based access, just-in-time elevation for production, every
  elevation recorded.
- Services: mTLS identity plus short-lived tokens; no shared static secrets.
- Authorization is checked **at the resource**, not only at the gateway. A gateway
  check protects against the internet; a resource check protects against everything
  else.

## Audit trail

Every security-relevant action is an event on the append-only log: authentication,
authorization decision, permission change, configuration change, manual
intervention, data access to PII, and every money movement.

Properties: append-only, tamper-evident, retained per the regulatory schedule,
queryable by actor, subject and time window, and **complete** — audit completeness
is tested at `G8`, not assumed.

## Secrets

Covered in [SECURITY.md](../SECURITY.md). In short: never in the repository, never
in an image layer, never in a log line, never in an event payload. `G1` scans on
every PR, and the scanner is verified against a planted canary so that a broken
scanner is a failing build rather than a silent gap.

## Security gates

`G1` on every module without exception: SAST, dependency vulnerabilities, secret
scanning, license policy.

`G8` on every module touching money, client data or an external boundary: authn/authz
matrix, boundary fuzzing, image scanning, key rotation, audit completeness and
tamper evidence.

## Incident response

S0 (funds movable without authorisation) and S1 (data exposure, auth bypass) are
declared incidents. The response path — including the authority to halt trading —
is in [`runbooks/`](runbooks/). Severity definitions are in
[SECURITY.md](../SECURITY.md).
