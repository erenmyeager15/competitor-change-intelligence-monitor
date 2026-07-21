# Proof-based launch post

## Post body

I built a safer competitor-change monitor for business pages where the useful question is not "did the HTML change?" but "what changed, how important is it, and what evidence supports it?"

In a verified Apify cloud run against an owner-controlled SaaS fixture, it detected four material changes:

- Price: $29 -> $35 (+20.7%)
- Plan limit: 10 -> 25 dashboards
- Feature: Priority alerts added
- Terms: Cancel anytime -> annual commitment required

Result: HIGH overall severity, 84% confidence, HTTP 200, and no trusted-baseline mutation.

The public example runs in dry-run/read-only mode and returns structured before/after evidence for pricing, plans, product features, terms, and changelogs.

Try the SaaS pricing example:
https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor/examples/saas-competitor-pricing-change-monitor

Actor:
https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor

#Apify #CompetitiveIntelligence #SaaS #Automation #WebMonitoring

## Proof references

- Verified saved-task run: `S7KWhlUzK8ToENQT6`
- Dataset: `kFuDbSaeXKETgzUEt`
- Actor build: `0.1.4`
- Proof screenshot: `competitor-change-proof.png`
