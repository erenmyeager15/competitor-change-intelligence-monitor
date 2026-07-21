# Public task publication guide

The saved tasks use an owner-controlled GitHub Pages fixture and run in `dryRun` + `compare_only` mode. They do not mutate trusted baselines, deliver webhooks, or charge the per-page event.

## 1. SaaS Competitor Pricing Change Monitor

- Task slug: `saas-competitor-pricing-change-monitor`
- SEO title: `Monitor SaaS Competitor Pricing and Plan Changes`
- SEO description: `Track authorized SaaS pricing pages for price, plan, feature, and terms changes with before-and-after evidence and severity alerts.`
- Public input fields: `targets`, `confirmAuthorizedUse`, `baselineAction`, `minimumMateriality`, `dryRun`
- Dataset view: `changes`
- Landing page: `https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor/examples/saas-competitor-pricing-change-monitor`

## 2. Terms & Policy Change Monitor

- Task slug: `terms-policy-change-monitor`
- SEO title: `Monitor Competitor Terms and Policy Changes`
- SEO description: `Track authorized public terms and policy pages for material updates with structured evidence, confidence, severity, and webhook-ready output.`
- Public input fields: `targets`, `confirmAuthorizedUse`, `baselineAction`, `minimumMateriality`, `dryRun`
- Dataset view: `changes`
- Landing page: `https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor/examples/terms-policy-change-monitor`

## 3. Product Feature & Changelog Monitor

- Task slug: `product-feature-changelog-monitor`
- SEO title: `Track Product Feature and Changelog Updates`
- SEO description: `Monitor authorized product and changelog pages for new features, plan changes, launches, and structured before-and-after evidence.`
- Public input fields: `targets`, `confirmAuthorizedUse`, `baselineAction`, `minimumMateriality`, `dryRun`
- Dataset view: `changes`
- Landing page: `https://apify.com/fascinating_lentil/competitor-change-intelligence-monitor/examples/product-feature-changelog-monitor`

## Console-only publication

Apify currently requires public task landing pages to be published from each saved task's **Publication** tab. For every task:

1. Open the task in Apify Console.
2. Open **Publication**.
3. Enter the SEO title and description above.
4. Select only the listed public input fields.
5. Select the `Material change detail` (`changes`) dataset view.
6. Publish and open the landing-page URL in a logged-out browser.
