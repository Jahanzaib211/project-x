# Security Policy

This system holds client money. Security failures here are financial failures.

## Reporting a vulnerability

Report privately. Do not open a public issue, and do not discuss the finding in
a shared channel until it is resolved.

- Email: `security@example.invalid`
- Include: affected component, reproduction steps, impact, and whether you
  believe it has been exploited.
- Acknowledgement within 1 business day; triage within 3.

If you believe client funds or client data are actively at risk, say so in the
subject line — it changes the response path.

## Severity and response

| Severity | Definition | Response |
|---|---|---|
| **S0** | Funds can be moved, created or destroyed without authorisation | Immediate incident; trading may be halted |
| **S1** | Client data exposure, authentication bypass, privilege escalation | Same-day fix, emergency change process |
| **S2** | Exploitable with preconditions; no direct financial or data loss | Next release |
| **S3** | Hardening, defence in depth | Scheduled |

## Secret handling

- Secrets never enter the repository, an image layer, a log line, an event
  payload, or an error message. `G1` scans for them on every PR and the scanner
  is verified against a planted canary.
- `.env` is local-only and git-ignored. `.env.example` carries names and
  descriptions, never values.
- Every credential in a non-development environment comes from the secret
  manager at runtime, is rotatable without a code change, and has an owner.
- Development credentials in `.env.example` and `docker-compose.yml` are
  deliberately weak, deliberately obvious, and must never appear outside a
  developer machine.

## Security gates

`G8` is required on every module that touches money, client data or an external
boundary. It covers the authn/authz matrix, input fuzzing on every external
boundary, dependency and container image scanning, key rotation, and audit log
completeness with tamper evidence.

`G1` runs on every module without exception: SAST, dependency vulnerability
scanning, secret scanning, and license policy.

See [docs/10-security.md](docs/10-security.md) for the threat model and the
controls that follow from it.

## Supported versions

Only the current release line receives security fixes. There is no back-porting
policy yet because there is not yet a release.
