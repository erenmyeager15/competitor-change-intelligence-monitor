# Competitor Change Intelligence Monitor

> Phases 1-5 complete locally. Release, cloud proof, and pricing activation remain
> blocked behind the Phase 6 owner-approval gate.

The planned Actor will monitor bounded, authorized public pages for material pricing,
availability, product, plan, terms, policy, and changelog changes. It will return
before/after evidence, confidence, severity, and one concise human review action.

## Current Status

Completed in Phases 1-5:

- Strict Apify input, output, Dataset, and Key-Value Store schemas
- TypeScript input and report contracts
- Strict local input parsing and authorization attestation
- Safe `example.com` dry-run prefill
- Fictional deterministic changed/unchanged HTML fixtures
- Docker and GitHub CI foundations
- HTTPS-only public-target validation
- DNS rebinding protection with all-address checks and IP-pinned TLS requests
- Same-origin redirects by default, with explicit authorized-origin support
- Strict time, redirect, header, compressed-body, and decoded-body bounds
- Conservative robots.txt enforcement before every target inspection
- Bounded HTML, JSON, XML, and plain-text extraction
- Safe CSS selector validation, JSON-LD product facts, and secret/contact redaction
- Retry and per-origin rate-limit orchestration kept separate from the Actor runtime
- Canonical redacted snapshot serialization with stable SHA-256 hashes
- Versioned trusted and candidate manifests with bounded base64 chunks
- Exact candidate hash and trusted-parent lineage promotion
- Verified leases, optimistic generation checks, and explicit conflict results
- Maximum-30 trusted evidence history and post-commit old-generation cleanup
- Fail-closed corrupt/migration state handling and compare-only immutability
- Unicode, decimal, currency, unit, pack, model, date, and URL normalization
- Bounded noise suppression that retains prices, versions, and effective dates
- Duplicate-safe JSON-LD Product/Offer and pricing-plan fact extraction
- Deterministic material-change classification across all seven categories
- Stable change IDs, numeric deltas, severity, confidence, evidence, and human actions
- Schema-compatible per-target reports with materiality filtering and safety-stop outcomes
- Bounded general-content excerpts backed by full normalized content hashes
- Integrated bounded runtime from input parsing through inspection, baseline comparison,
  report persistence, digest generation, and run summaries
- Immediate and weekly generic HTTPS webhook delivery after Dataset persistence
- Webhook SSRF protection, IP-pinned TLS, no redirects, size/time/retry bounds, and
  secret-safe delivery errors
- Bounded, redacted, deduplicated JSON/Markdown digests and weekly idempotency state
- Atomic `page-checked` Dataset persistence and PPE charging through `Actor.pushData`
- Pre-work paid-event allowance checks and nonbillable safety/failure outcomes
- Dry-run enforcement with no baseline mutation, webhook delivery, or event charging
- 89 local foundation, input, security, extraction, robots, inspection, persistence,
  intelligence, delivery, runtime, and billing tests

Not completed yet:

- Owner-controlled Apify cloud proof runs
- Measured cloud-cost and margin approval for the proposed event price
- GitHub commit/remote, Apify deployment, pricing activation, and Store publication

## Safety Boundary

V1 will support at most 25 explicitly configured public HTTPS pages per run. It will
not log in, accept cookies, solve CAPTCHAs, bypass access controls, crawl recursively,
discover competitors automatically, or perform automatic repricing. The authorization
checkbox records a user's confirmation; it does not create permission.

## Safe Foundation Input

```json
{
  "targets": [
    {
      "name": "Example.com public demo",
      "url": "https://example.com/",
      "changeTypes": ["general_content"]
    }
  ],
  "confirmAuthorizedUse": false,
  "baselineAction": "compare_only",
  "notificationMode": "none",
  "dryRun": true
}
```

Every non-demo target requires `confirmAuthorizedUse: true`. That confirmation does
not create permission. Phase 2 validates target and redirect URLs again immediately
before network access, checks every DNS answer, pins the selected public address to a
verified TLS request, and enforces robots.txt and response bounds.

`fixtures/cloud-proof.html` is fictional content controlled in this repository. It is
reserved for owner-approved release verification and must not be presented as a real
company, offer, or customer result.

## Phase 5 Boundary

`src/main.ts` now connects the bounded inspection, baseline, intelligence, Dataset,
digest, delivery, and billing layers through `src/runtime.ts`. Webhooks are optional,
post-persistence, public-HTTPS-only, size bounded, IP pinned, and redirect free. The
runtime never calls `Actor.charge()` separately: billable reports use the SDK's atomic
Dataset/event operation. No cloud run, live webhook, paid test, deployment, or pricing
activation has occurred. Those are Phase 6 release gates and require owner approval.

## Local Verification

```bash
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
```

## Planned PPE Contract

The launch proposal is one `page-checked` event at $0.003 for each successfully
inspected page, subject to measured cloud-cost approval. Invalid, unauthorized,
blocked, robots-disallowed, failed, dry-run, or non-persisted work will not be charged.
Billable Dataset persistence and event charging use the Apify SDK's combined atomic
`Actor.pushData(report, 'page-checked')` operation. The event and proposed price are
not active until Phase 6 cloud-cost proof and owner approval.

## Source Of Truth

The complete approved design is in:

`E:\APIFY PROJECT\APIFY-PORTFOLIO-ROADMAP\COMPETITOR-CHANGE-INTELLIGENCE-MONITOR-SPEC.md`

Implementation must follow the six gated phases in that document. Do not deploy or
activate pricing until all acceptance gates pass and the owner explicitly approves.
