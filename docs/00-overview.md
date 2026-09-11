# 00 — Overview

## What this is

A brokerage platform: clients deposit money, see prices, place orders, hold
positions, realise profit and loss, and withdraw money. The broker prices,
executes, manages its own risk, hedges, reconciles, reports to regulators, and
must be able to prove — years later — exactly what happened and why.

## What makes it different from ordinary software

In most systems, a bug is an inconvenience. Here, a bug is a **loss**, a
**regulatory breach**, or an unfalsifiable **dispute with a client**. Three
properties follow, and they shape every decision in this repository.

**1. Money is conserved.** Value is never created or destroyed by a code path.
It moves between accounts, in balanced pairs, always. This is why the ledger is
double-entry and why balances are projections rather than fields.

**2. History is the truth, not the current state.** "What is the balance?" is a
weaker question than "how did it come to be that balance?" Regulators, disputes
and reconciliation all ask the second. This is why the system is event-sourced
and why replay determinism is a hard gate rather than a nice property.

**3. Correctness must be provable, not merely believed.** "We tested it" is not
an answer when a client's account is wrong. This is why financial laws are
declared as invariants in a registry, executed as tests at a named gate, and
monitored continuously in production.

## The shape of the build

The system is a **directed acyclic graph of 22 modules**, not a feature list.
Each module declares its dependencies and the gates it must pass. Nothing
downstream may be built, merged or deployed while an upstream module is short of
its gates — and that rule is machine-checked by
[`scripts/check_gates.py`](../scripts/check_gates.py) in CI, not remembered by
people.

The consequence is unusual and intentional: **you cannot start the trading UI
early.** You cannot prototype the risk engine before the domain kernel is proven.
The graph is the plan, and it is enforced.

## The first deployable product

Not the web terminal. This loop:

```
Market State → Pricing → Order → Risk → Execution → Position → P&L → Ledger → Replay
```

When that loop is mathematically correct, deterministic, crash-safe, replayable
and fully reconciled, the nucleus of a broker exists. Everything after it —
liquidity, treasury, compliance, client interfaces — wraps that nucleus without
changing it.

## Scope

**In scope:** domain kernel, event kernel, double-entry ledger, accounts,
positions, market data, pricing, P&L and margin, risk, OMS, execution, internal
risk book, LP/FIX connectivity, routing and hedging, reconciliation, KYC/AML and
fraud, payments and treasury, compliance and reporting, client API, web and
mobile, and external platform integrations such as MT5.

**Deliberately not in scope:**

- **Being a venue.** This is a broker, not an exchange. There is no central limit
  order book of our own; liquidity comes from LPs.
- **Trusting an external platform as the source of truth.** MT5 and its
  equivalents are integrations behind an adapter. The core owns the money.
- **Floating-point money.** Anywhere. At all.
- **Deciding the jurisdiction and licence.** Those are business decisions that
  parameterise compliance; the architecture is built so they can be
  parameterised rather than rewritten.
- **Guessing performance numbers.** SLOs are established by measurement on target
  hardware and recorded per module. Nothing in this repository invents a latency
  target it has not measured.

## Who this documentation is for

Engineers building it, reviewers gating it, operators running it, and — because
this is a regulated domain — an auditor who was not in the room and who needs to
reconstruct what the system did and why it was allowed to do it.
