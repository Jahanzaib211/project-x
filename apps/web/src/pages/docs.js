/**
 * The legal and policy document suite.
 *
 * A brokerage publishes a fixed set of documents, and a client area that links
 * to three of them looks unfinished next to any real firm. All of them live in
 * one registry and share one renderer, so adding a document is a data change.
 *
 * **On honesty:** these read like the real thing in structure and tone, but
 * none of them invents a licence, a regulator, a registration number or a
 * compensation scheme. Project X is a reference implementation, and every
 * document says so where a real one would name its authorisation. Fabricating
 * that detail is precisely what a fraudulent broker site does.
 */

import { icon } from "../ui/icons.js";
import { esc } from "../ui/layout.js";

/**
 * @typedef {object} LegalDoc
 * @property {string} title
 * @property {string} summary
 * @property {string} group
 * @property {string} updated
 * @property {[string, string][]} sections
 */

const NOT_LICENSED =
  "Project X is a reference implementation of a brokerage platform. It is not " +
  "authorised or regulated by any financial authority, holds no client money, " +
  "and executes no orders on any market. Where a real firm would name its " +
  "regulator and licence number, this document says this instead.";

/** @type {Record<string, LegalDoc>} */
export const DOCS = {
  terms: {
    title: "Client agreement",
    group: "Terms",
    summary: "The agreement that would govern the relationship between you and the firm.",
    updated: "2026-09-01",
    sections: [
      ["Status of this platform", NOT_LICENSED],
      ["Scope", "This agreement would set out the terms on which the firm provides access to trading accounts, quotes, execution and funding services, and would incorporate the order execution policy, the risk disclosure and the privacy policy by reference."],
      ["Accounts", "A trading account is a record in the account registry. Accounts created here carry no balance and cannot execute orders. Where a balance would appear, the interface reports it as unavailable and names the module responsible, rather than displaying a zero."],
      ["Instructions and orders", "Orders would be accepted only after a recorded risk decision. An order for which no risk decision exists is never executed. Where the risk engine is unavailable, orders are refused rather than allowed — the platform fails closed."],
      ["Fees and charges", "Spreads, commissions, swaps and payment charges would be published in the fee schedule and applied as balanced ledger entries. No charge is ever applied by adjusting a balance directly."],
      ["Liability", "Nothing here creates a financial obligation, because no funds are held and no orders are executed. In a live deployment this section would set out the firm's liability and its limits."],
      ["Amendment", "Material changes would be notified in advance. Each version of this document is retained; the version in force at the time of any transaction is the version that governs it."],
    ],
  },

  risk: {
    title: "Risk disclosure",
    group: "Terms",
    summary: "The risks that apply to leveraged trading, stated plainly.",
    updated: "2026-09-01",
    sections: [
      ["Leverage magnifies loss", "Trading leveraged products carries a high risk of loss. Leverage increases both gains and losses in the same proportion. A small adverse move in the underlying market can produce a loss substantially greater than the margin committed to the position."],
      ["You can lose more than you deposit", "Unless negative balance protection applies to your account, losses are not limited to the amount deposited. A gap through a stop level can leave an account with a debit balance."],
      ["Markets gap", "Prices are not continuous. Around scheduled economic releases, at market open after a weekend, and during periods of stress, the next available price can be materially worse than the last. A stop order is an instruction to execute at the next available price, not a guarantee of the stop price."],
      ["Liquidation is automatic", "Positions may be closed without notice when the margin level of an account breaches policy. Liquidation is not discretionary, is not a service performed on your behalf, and may occur at a price that crystallises a large loss."],
      ["Swap and financing costs", "Positions held overnight accrue financing, which may be a charge or a credit. Over a long holding period these costs can be significant relative to the position."],
      ["Operational and counterparty risk", "Execution depends on liquidity providers, payment providers, connectivity and infrastructure, each of which can fail or degrade. A degraded component may result in refused orders or delayed funding."],
      ["Not currently applicable", "None of the above is presently in force, because this platform executes no orders and holds no funds. It is stated in full so the disclosure is complete rather than added once it matters."],
    ],
  },

  execution: {
    title: "Order execution policy",
    group: "Terms",
    summary: "How an order would be handled, and how execution quality is judged.",
    updated: "2026-09-01",
    sections: [
      ["Status", NOT_LICENSED],
      ["Execution factors", "Price, cost, speed, likelihood of execution and settlement, size and the nature of the order. For a retail client, total consideration — price plus all costs — is ordinarily the dominant factor."],
      ["Order path", "Every order passes through validation, then a recorded risk decision, then execution. The decision, the input snapshot that produced it and the policy version in force are recorded with the order, so any execution can be reconstructed years later."],
      ["Routing", "Orders are either internalised or hedged with a liquidity provider, according to a versioned routing policy. The routing decision is deterministic given its inputs, and the decision is recorded — not inferred afterwards."],
      ["Slippage", "Where the next available price differs from the requested price, the difference is recorded on the deal. Slippage is applied symmetrically: an improvement is passed on in the same way a deterioration is."],
      ["Exactly-once execution", "A retried request never produces a second financial effect. One execution produces exactly one deal, and one deal produces exactly one balanced set of ledger entries."],
      ["Monitoring", "Execution quality would be reviewed against these factors on a defined cycle, and this policy revised where the review shows it is not delivering the best result consistently."],
    ],
  },

  conflicts: {
    title: "Conflicts of interest policy",
    group: "Terms",
    summary: "Where the firm's interests could diverge from a client's, and what constrains that.",
    updated: "2026-09-01",
    sections: [
      ["Status", NOT_LICENSED],
      ["The principal conflict", "Where a broker takes the other side of a client's position rather than hedging it, the client's loss is the firm's gain. This is the central conflict in the business model and is stated first because it is the one that matters."],
      ["How it is constrained", "Routing between internalisation and external hedging follows a versioned policy, not a per-order judgement. The decision is deterministic given its inputs and is recorded, so the pattern of routing can be audited rather than asserted."],
      ["Pricing", "Client quotes are produced by a pure function of market state and a versioned configuration. The same inputs produce the same quote, which makes selective pricing detectable rather than deniable."],
      ["Liquidation", "Stop-out is driven by published margin policy applied uniformly. It is not a discretionary act and is not exercised selectively."],
      ["Inducements and remuneration", "Any payment received from or made to a third party in connection with order flow would be disclosed here. Staff remuneration would not be tied to client losses."],
      ["Disclosure as a last resort", "Where a conflict cannot be managed to the point where a client's interests are not damaged, it is disclosed rather than concealed. Disclosure is the fallback, never the first control."],
    ],
  },

  privacy: {
    title: "Privacy policy",
    group: "Data",
    summary: "What is stored, why, for how long, and what you can ask for.",
    updated: "2026-09-01",
    sections: [
      ["What is stored today", "Trading account metadata — platform, type, mode, nickname, currency, leverage, status and timestamps — and funding requests recorded as intents. No balances, no financial values, no identity documents and no payment details."],
      ["What is not stored", "There is no authentication on this platform, so no credentials exist. No production data and no third-party personal data is used anywhere, including in tests and fixtures."],
      ["Lawful basis", "In a live deployment, processing would rest on performance of a contract for account and trading data, legal obligation for identity and transaction monitoring records, and legitimate interests for fraud prevention and security."],
      ["Local storage", "Your theme and sidebar preferences are kept in your browser's local storage. They never reach the server and are not associated with an account."],
      ["Retention", "Financial events and ledger entries would be retained permanently for auditability. Identity documents would be retained for the statutory period and then deleted. Logs and traces are retained briefly."],
      ["Your rights", "Access, rectification, erasure, restriction, portability and objection. Erasure does not extend to records a firm is legally required to retain, and a legal hold cannot be bypassed by an ordinary deletion request."],
      ["Contact", "Data protection enquiries would go to the firm's data protection contact. See the contact page."],
    ],
  },

  cookies: {
    title: "Cookie policy",
    group: "Data",
    summary: "What this site stores in your browser. It is very little.",
    updated: "2026-09-01",
    sections: [
      ["This site sets no cookies", "No cookies are set by this platform. There is no analytics, no advertising, no tracking pixel and no third-party script of any kind — the content security policy blocks external scripts outright."],
      ["Local storage", "Two values are kept in your browser's local storage: your theme choice and whether the sidebar is collapsed. Both are conveniences, both stay on your device, and clearing site data removes them with no loss."],
      ["What a live deployment would add", "A session cookie for authentication, strictly necessary and exempt from consent. Anything beyond that — analytics or marketing — would require consent collected before it is set, not after."],
      ["Control", "Because nothing is set, there is nothing to withdraw consent for. Clearing site data in your browser resets the two preferences above."],
    ],
  },

  aml: {
    title: "AML and counter-terrorist financing policy",
    group: "Compliance",
    summary: "Identity, screening and monitoring, and why they fail closed.",
    updated: "2026-09-01",
    sections: [
      ["Status", NOT_LICENSED],
      ["Customer due diligence", "Identity would be verified before an account may be funded, with enhanced diligence for higher-risk relationships. Verification is a precondition, not a step completed later under pressure."],
      ["Screening", "Sanctions, politically exposed person and adverse media screening at onboarding and on an ongoing basis. Where a screening provider is unavailable, onboarding is blocked rather than allowed to proceed — the control fails closed."],
      ["Transaction monitoring", "Funding and trading activity would be monitored against rules calibrated to the client's profile. Every automated decision is explainable and permanently auditable; no decision is taken by a process that cannot say why."],
      ["Withdrawals", "Withdrawals return to the source of funding, in the same proportion. No withdrawal is released for an account failing required verification."],
      ["Reporting and records", "Suspicious activity would be reported to the relevant authority, and records retained for the statutory period. Tipping-off rules apply: a client is not informed that a report has been made."],
      ["Accountability", "A named officer would be responsible for the policy and its operation."],
    ],
  },

  complaints: {
    title: "Complaints procedure",
    group: "Compliance",
    summary: "How a complaint would be raised, handled and escalated.",
    updated: "2026-09-01",
    sections: [
      ["Status", NOT_LICENSED],
      ["Raising a complaint", "A complaint would be submitted in writing through the contact page or the help centre, with the account number, the dates concerned and what outcome is sought."],
      ["Acknowledgement", "Acknowledged within five business days, with the name of the person handling it and an indication of the expected timescale."],
      ["Investigation", "Complaints about execution, pricing or balances are investigated against the recorded event log. Because every decision records the inputs and policy version that produced it, an investigation reconstructs what happened rather than reasoning about what probably happened."],
      ["Final response", "A written final response within eight weeks, setting out the conclusion, the evidence relied on, and any redress offered."],
      ["Escalation", "Where a firm is regulated, an unresolved complaint may usually be escalated to an independent ombudsman or the regulator. No such route exists for this platform, because it is not a regulated firm."],
      ["Records", "Complaints and their outcomes would be recorded and reviewed for patterns, not merely closed individually."],
    ],
  },

  compensation: {
    title: "Client funds and investor compensation",
    group: "Compliance",
    summary: "How client money would be held, and what protection would apply.",
    updated: "2026-09-01",
    sections: [
      ["No client money is held", "This platform holds no client money. There is nothing to segregate and nothing to protect. The rest of this document describes what would apply in a live deployment."],
      ["Segregation", "Client money would be held in accounts separate from the firm's own funds, with the separation enforced in the chart of accounts as well as at the bank. Client and house money occupy distinct account kinds, and the ledger will not balance a transaction that confuses them."],
      ["Reconciliation", "Client money balances would be reconciled daily against bank records, and any unexplained discrepancy treated as an incident rather than an item to age. Zero unexplained discrepancies is a release condition, not an aspiration."],
      ["Compensation schemes", "Where a firm is authorised, an investor compensation scheme may cover eligible claims up to a limit if the firm fails. No scheme covers this platform, because it is not authorised. A real document would name the scheme and its limit here."],
      ["On insolvency", "Segregated client money would not form part of the firm's estate. This is the practical reason segregation matters, and why it is enforced structurally rather than by procedure."],
    ],
  },

  refund: {
    title: "Refunds and chargebacks",
    group: "Payments",
    summary: "How a payment would be reversed, and what a chargeback triggers.",
    updated: "2026-09-01",
    sections: [
      ["Deposits", "A deposit would be refunded to the original payment method only, in the original currency, and only where the funds have not been used for trading."],
      ["Withdrawals return to source", "Withdrawals return to the method used to fund the account, in the same proportion as the deposits received from it. This is a control against money laundering, not an inconvenience."],
      ["Reversals are new entries", "A reversal is a new balanced ledger transaction that references the original. Nothing is deleted and no entry is edited — the original transaction remains visible alongside its reversal, permanently."],
      ["Chargebacks", "A chargeback would trigger a review of the account and may suspend trading and withdrawals while it is investigated. Chargeback abuse would be reported."],
      ["Currently", "No payment is processed by this platform. Funding requests are recorded as intents and produce no ledger effect."],
    ],
  },

  disclosure: {
    title: "Responsible disclosure",
    group: "Security",
    summary: "How to report a vulnerability, and what happens next.",
    updated: "2026-09-01",
    sections: [
      ["Reporting", "Report privately, before any public disclosure. Include the affected component, reproduction steps, the impact you believe it has, and whether you have reason to think it has been exploited."],
      ["What to expect", "Acknowledgement within one business day and triage within three. If you believe client funds or client data are actively at risk, say so in the subject line — it changes the response path."],
      ["Severity", "S0 covers funds that can be moved, created or destroyed without authorisation, and is an immediate incident that may halt trading. S1 covers data exposure, authentication bypass and privilege escalation. S2 and S3 are handled in the next release and on schedule respectively."],
      ["Safe harbour", "Good-faith research that respects these terms, avoids privacy violations and does not degrade service would not be pursued. Do not access data that is not yours, and do not run denial-of-service testing."],
      ["Out of scope", "Findings from automated scanners without a demonstrated impact, and reports about the deliberately weak development credentials published in this repository — those are documented as fake and are not a finding."],
    ],
  },

  accessibility: {
    title: "Accessibility statement",
    group: "Security",
    summary: "What has been done, what is checked automatically, and what has not.",
    updated: "2026-09-01",
    sections: [
      ["Commitment", "The interface targets WCAG 2.2 AA. Where it falls short, the gap is stated here rather than left for a user to discover."],
      ["What is enforced automatically", "Every form control and icon-only button must carry an accessible name, and every interactive component must define hover and visible focus states. Both are asserted by tests that fail the build, not checked at review."],
      ["Keyboard", "The interface is operable by keyboard. Dialogs trap focus while open and return it to the control that opened them. Menus close on Escape. A skip link precedes the navigation."],
      ["Motion and colour", "No shimmer, skeleton or looping animation is used anywhere, and this is enforced by a test. Motion is limited to short entrance transitions, which are removed entirely under prefers-reduced-motion. Colour is never the only carrier of meaning: the active navigation row has a marker as well as a hue."],
      ["Known gaps", "The interface has not been tested end to end with a screen reader, and no independent audit has been carried out. Colour contrast is designed to meet AA but has not been measured across every state."],
      ["Feedback", "Accessibility problems can be raised through the contact page and are treated as defects, not enhancements."],
    ],
  },

  regulation: {
    title: "Regulatory status",
    group: "Security",
    summary: "The short version: this is not a regulated firm.",
    updated: "2026-09-01",
    sections: [
      ["Not authorised", NOT_LICENSED],
      ["Why this page exists", "Every brokerage website carries a regulatory disclosure, and its absence is itself a signal. This page occupies that position and states the truth, because the alternative — a plausible-looking licence number — is the single most common feature of a fraudulent broker site."],
      ["What a real disclosure contains", "The legal entity name and registration number, the registered office, the regulator and licence number, the jurisdictions served and those excluded, and the restrictions attached to the licence."],
      ["Restrictions", "Do not deposit funds. There is nowhere for them to go. No page in this platform accepts a payment instrument, and the funding endpoints refuse and explain why."],
      ["If you were sent here from elsewhere", "If something represented itself as a licensed broker and linked you here, that representation was false. This is engineering reference software."],
    ],
  },
};

/** Documents grouped for the index page and the footer. */
export const DOC_GROUPS = ["Terms", "Data", "Compliance", "Payments", "Security"];

/** @param {string} slug */
export function docPath(slug) {
  return `/docs/${slug}`;
}

/**
 * Render one document.
 * @param {string} slug
 */
export function legalPage(slug) {
  const doc = DOCS[slug];
  if (!doc) return "";

  const updated = new Date(doc.updated).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });

  const contents = doc.sections
    .map(([heading], i) => `<li><a href="#s${i}">${esc(heading)}</a></li>`)
    .join("");

  const body = doc.sections
    .map(([heading, text], i) => `<section id="s${i}" class="doc-section">
      <h2 class="h3">${esc(heading)}</h2>
      <p>${esc(text)}</p>
    </section>`)
    .join("");

  return `<div class="page-head">
    <div class="grow">
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="/docs">Documents</a> ${icon.chevronRight(12)} <span>${esc(doc.group)}</span>
      </nav>
      <h1 class="h1">${esc(doc.title)}</h1>
      <p class="muted">${esc(doc.summary)}</p>
    </div>
  </div>

  <div class="notice" style="margin-bottom:var(--s-5)">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">This is reference software, not a regulated firm</div>
      <div class="notice-text">This document has the structure and tone of the real thing, but it
      invents no licence, regulator or registration number. See
      <a href="/docs/regulation">regulatory status</a>.</div>
    </div>
  </div>

  <div data-responsive-split>
    <article class="card card-pad doc">
      ${body}
      <p class="micro subtle" style="margin-top:var(--s-6);padding-top:var(--s-4);border-top:1px solid var(--border)">
        Version of ${esc(updated)}. Each version is retained; the version in force at the
        time of a transaction is the one that governs it.
      </p>
    </article>

    <aside class="card card-pad doc-toc">
      <div class="eyebrow" style="margin-bottom:var(--s-3)">On this page</div>
      <ol>${contents}</ol>
      <div style="margin-top:var(--s-4);padding-top:var(--s-4);border-top:1px solid var(--border)">
        <div class="eyebrow" style="margin-bottom:var(--s-2)">Last updated</div>
        <div class="small">${esc(updated)}</div>
      </div>
    </aside>
  </div>`;
}

/** The document index. */
export function docsIndexPage() {
  const groups = DOC_GROUPS.map((group) => {
    const entries = Object.entries(DOCS).filter(([, d]) => d.group === group);
    if (!entries.length) return "";
    return `<section class="section" style="margin-top:var(--s-8)">
      <h2 class="h2" style="margin-bottom:var(--s-4)">${esc(group)}</h2>
      <div class="doc-grid">
        ${entries.map(([slug, d]) => `<a class="card card-pad doc-card" href="${esc(docPath(slug))}">
          <span class="doc-card-icon">${icon.receipt(18)}</span>
          <span class="doc-card-body">
            <span class="doc-card-title">${esc(d.title)}</span>
            <span class="doc-card-text">${esc(d.summary)}</span>
          </span>
          <span class="doc-card-chev">${icon.chevronRight(16)}</span>
        </a>`).join("")}
      </div>
    </section>`;
  }).join("");

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Documents</h1>
      <p class="muted">Terms, policies and disclosures. ${Object.keys(DOCS).length} documents.</p>
    </div>
  </div>

  <div class="notice notice-warning">
    <span class="notice-icon">${icon.shield(18)}</span>
    <div class="notice-body">
      <div class="notice-title">None of these documents claims a licence</div>
      <div class="notice-text">Project X is not authorised by any financial authority. A
      plausible-looking licence number is the most common feature of a fraudulent
      broker site, so this one states the truth instead.
      <a href="/docs/regulation">Regulatory status</a>.</div>
    </div>
  </div>
  ${groups}`;
}
