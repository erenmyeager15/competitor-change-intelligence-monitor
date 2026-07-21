# Phase 6 private-cloud validation

Validated on 2026-07-21 against private Apify build `0.1.3` and the
owner-controlled GitHub Pages fixture.

## Automated verification

- Local verification: passed
- TypeScript checks: passed
- Tests: 90/90 passed
- Entrypoint check: passed
- Foundation validation: passed
- Apify input, Dataset, output, and Key-Value Store schemas: passed
- GitHub CI run `29828849471`: passed

## Private-cloud proofs

### Safe dry run

- Run: `XStCS1IldAefOnup3`
- Result: succeeded with one bounded Dataset report and all three output records
- `page-checked` event: not charged
- Measured platform cost: `$0.00024256898070706265`

### Trusted baseline initialization

- Run: `ieTkVINPfEDgMtJAr`
- Result: trusted v1 baseline initialized and persisted
- Measured platform cost: `$0.0001481736636095577`

### Unchanged comparison

- Run: `DAOMLnQcS9Tmt13IT`
- Result: `success_no_change`
- Dataset reports: 1
- Billable page reports in runtime summary: 1
- Persistence failures: 0
- Measured platform cost: `$0.00021138745135068895`

### Controlled material-change comparison

- Run: `terQBYfh6smomsfPL`
- Result: `success_changed`
- Material changes: 4
- Categories: `price`, `product_feature`, `pricing_plan`, `terms_policy`
- Overall severity: `high`
- Overall confidence: 84
- Trusted baseline updated: no
- Dataset reports: 1
- Billable page reports in runtime summary: 1
- Measured platform cost: `$0.00023063047236204147`

### Immediate webhook delivery

- Run: `TXefsVftte148NNIW`
- Result: `success_changed`
- Delivery: one POST, HTTP 200, status `delivered`
- Eligible and delivered changes: 4
- Payload size: 2,934 bytes
- Receiver URL persisted in report, digest, summary, or logs: no
- Temporary receiver and local secret input: deleted after verification
- Measured platform cost: `$0.0001688000743786494`

## Pricing and measured margin

Configured events for a one-page paid run:

- Actor start: `$0.00005`
- One `page-checked`: `$0.003`
- Gross event revenue: `$0.00305`

Apify's documented PPE profit formula is `(0.8 * revenue) - platform costs`.
Using the highest measured non-dry comparison cost:

- Estimated developer revenue after 20% commission: `$0.00244`
- Estimated profit after measured platform cost: `$0.0022093695276379584`
- Estimated margin on developer revenue: `90.55%`
- Estimated profit as a percentage of the user's gross event charge: `72.44%`

This is a controlled owner run, so platform `accountedChargedEventCounts` are zero.
The runtime summary correctly reports one billable page report, and real paid-user
monetization remains subject to Apify discount tiers, final invoices, refunds, and
fraud controls.

## Release decision

Functional, safety, persistence, delivery, billing-count, and measured-margin gates
passed. The owner-controlled fixture was restored to trusted v1 after proof. Store
publication still requires the final README/icon deployment and explicit public
metadata update.
