# Private release evidence

These files capture the private-cloud release inputs and API payloads used for
the initial Actor verification.

- `actor-pricing-initial.json` is historical evidence of the first pricing
  configuration. Do not replay it after pricing has been activated.
- `actor-private-metadata.json` keeps the Actor private. Publication is a
  separate, explicit release action after all proof gates pass.
- `proof-dry-run.json`, `proof-baseline.json`, and `proof-compare.json` target
  the owner-controlled GitHub Pages fixture.

Never add webhook URLs, API tokens, credentials, or unredacted user data to
this directory.
