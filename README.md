# Competitor Change Intelligence Monitor

Monitor authorized public competitor pages for meaningful pricing, product,
availability, plan, policy, and changelog changes. The Actor compares each page
with a trusted baseline and returns concise evidence, confidence, severity, and a
recommended human review action.

Use it for competitor pricing intelligence, product launch monitoring, SaaS plan
tracking, public terms updates, and release-note alerts without building a custom
monitoring pipeline.

## Try A Safe Example

### Review and reliability upgrade

`REVIEW_CSV` provides one row per material change with before/after values, percentage delta, severity, confidence and recommended action. Targets without changes still receive a diagnostic row, so blocked pages cannot disappear from the review. Spreadsheet formula-like source values are escaped. This export needs no additional page requests or extra charge event.

`RUN_SUMMARY.outcome` distinguishes complete, partial, failed and budget-limited checks. Runs with no usable target report fail after saving diagnostics. Discounted and zero-price events are accepted; an exact fixed-price check no longer rejects them. Cost estimates use the configured event price and an explicitly estimated 20% platform share; they exclude start-event revenue and cannot establish a measured margin until platform costs are available. Demo/dry runs remain nonbillable and are not a profitability benchmark.

These public examples use an owner-controlled fictional SaaS page. They run in
dry-run comparison mode, do not update a baseline, send alerts, or charge the
per-page event.

- [SaaS Competitor Pricing Change Monitor](https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor/examples/saas-competitor-pricing-change-monitor)
- [Terms & Policy Change Monitor](https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor/examples/terms-policy-change-monitor)
- [Product Feature & Changelog Monitor](https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor/examples/product-feature-changelog-monitor)

Verified proof runs detected pricing, plan, feature, terms, and changelog changes
with structured evidence and confidence scores. A recent one-page cloud proof
completed in about 4 seconds, peaked near 55 MB of memory, and used about
**$0.00032** in platform resources.

## Why It Is Different

This is not only a raw text-diff tool. It classifies material business changes,
normalizes prices and product identifiers conservatively, preserves an explicit
trusted baseline, and keeps unexpected revisions in reviewable candidate state
instead of silently trusting them.

## What You Get

- Structured before-and-after changes instead of raw page diffs
- Price deltas and percentage changes when values can be normalized safely
- Categories for price, availability, product features, pricing plans,
  terms/policies, launches/changelogs, and general content
- Confidence scores, severity, bounded evidence, and suggested review actions
- Stable change IDs for deduplication and downstream automation
- JSON Dataset output plus JSON and Markdown digests
- Optional immediate or weekly HTTPS webhook delivery
- Persistent trusted baselines with explicit candidate review and promotion

## Quick Start

### 1. Initialize a trusted baseline

Run once with a page you are authorized to monitor:

```json
{
  "targets": [
    {
      "name": "Acme pricing",
      "url": "https://example.org/pricing",
      "changeTypes": ["price", "pricing_plan", "product_feature"]
    }
  ],
  "confirmAuthorizedUse": true,
  "baselineAction": "initialize_trusted",
  "notificationMode": "none",
  "dryRun": false
}
```

### 2. Compare later runs

Keep the target name, URL, selected change types, selectors, and product identifiers
consistent, then change `baselineAction` to `compare_only`. Schedule the Actor in
Apify Console for recurring checks.

```json
{
  "targets": [
    {
      "name": "Acme pricing",
      "url": "https://example.org/pricing",
      "changeTypes": ["price", "pricing_plan", "product_feature"]
    }
  ],
  "confirmAuthorizedUse": true,
  "baselineAction": "compare_only",
  "minimumMateriality": "low",
  "notificationMode": "none",
  "dryRun": false
}
```

The prefilled `example.com` input is a safe dry run. It does not mutate a baseline,
send a webhook, or charge a `page-checked` event.

## Output

Each target produces one Dataset report with fields such as:

```json
{
  "targetName": "Acme pricing",
  "status": "success_changed",
  "baselineFound": true,
  "changeDetected": true,
  "materialChangeCount": 2,
  "overallSeverity": "high",
  "overallConfidence": 91,
  "changes": [
    {
      "category": "price",
      "field": "product.pro.price",
      "previousValue": 29,
      "currentValue": 35,
      "delta": 6,
      "deltaPercent": 20.6897,
      "severity": "medium",
      "confidence": "high",
      "recommendedAction": "Review pricing, margin, and positioning before changing your offer."
    }
  ]
}
```

The default Key-Value Store also exposes:

- `RUN_SUMMARY`: counts, statuses, delivery result, and page-event assessment
- `DIGEST_JSON`: bounded machine-readable changes
- `DIGEST_MARKDOWN`: concise human-readable digest

## Baseline Actions

- `compare_only`: compare with the trusted baseline without changing it
- `initialize_trusted`: create the first trusted baseline; refuses overwrite
- `store_candidate`: save a candidate snapshot for review
- `promote_candidate`: promote only an exact reviewed candidate and parent hash

Use candidate promotion when a detected page revision should become the new trusted
reference. This prevents an unexpected change from silently replacing the baseline.

## Better Signal With Selectors

For noisy pages, add `includeSelectors` for the sections you care about and
`excludeSelectors` for banners, timestamps, rotating recommendations, or other
volatile content. `ignoreTextPatterns` accepts only bounded literal or simple glob
patterns, not arbitrary regular expressions.

Known SKU, GTIN, MPN, brand, model, variant, and pack quantity values can improve
product-change confidence. The Actor does not discover competitor products
automatically or claim uncertain products are equivalent.

## Webhook Alerts

Set `notificationMode` to `immediate` or `weekly_digest`, provide a secret public
HTTPS `alertWebhookUrl`, and choose `minimumAlertSeverity`. Delivery happens only
after the Dataset report is persisted. Payloads are deduplicated, redacted, bounded,
and contain at most ten material changes per delivery.

The webhook URL is secret input and is never logged, returned, or stored in reports
or digests.

## Pricing

This Actor uses pay per event:

- `page-checked`: **$0.003** for each successfully inspected page report persisted
  to the Dataset
- Actor start: **$0.00005** per run

Platform usage is billed separately by Apify. The observed July average was about
**$0.31 per 1,000 Dataset results**, although real cost varies with page size,
response time, storage operations, and retries.

Dry runs, invalid input, unauthorized targets, blocked or robots-disallowed pages,
failed inspections, and failed Dataset persistence do not charge `page-checked`.

## Safety And Limits

- One to 25 explicitly configured public HTTPS pages per run
- One document per target; no recursive crawling
- Public HTML, JSON, XML, and text responses only; no browser rendering
- Public-IP DNS validation and rebinding protection
- Same-origin redirects unless another public HTTPS origin is explicitly authorized
- Robots.txt enforcement, bounded responses, timeouts, and retries
- No login, cookie acceptance, CAPTCHA solving, access-control bypass, or repricing
- Secret, credential, email, and phone-number redaction from retained evidence

`confirmAuthorizedUse` records that you already have permission; it does not create
permission. Use the Actor only on pages that belong to you, intentionally expose
content for this use, or that you are otherwise permitted to monitor. Follow source
terms and applicable laws.

## Common Statuses

- `success_no_change`: the trusted baseline matches
- `success_changed`: material changes were detected
- `baseline_missing`: initialize or review a candidate first
- `robots_disallowed`: source policy blocked inspection
- `blocked_target`: URL or network safety validation stopped the request
- `http_error`, `unsupported_content`, or `internal_error`: inspect the report

## Support

When reporting an issue, include the public target type, selected change types, run
ID, and redacted log excerpt. Never share credentials, private URLs, or webhook
secrets.

Need another change type, output field, or authorized public-page workflow? Open an
Issue with the use case, desired output, and monitoring frequency. Do not include
private or gated URLs, credentials, personal data, or webhook secrets.

Source and issue tracker:
[GitHub repository](https://github.com/erenmyeager15/competitor-change-intelligence-monitor)
