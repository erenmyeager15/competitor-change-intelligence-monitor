import { access, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const requiredFiles = [
  '.actor/actor.json',
  '.actor/INPUT_SCHEMA.json',
  '.actor/output_schema.json',
  '.actor/dataset_schema.json',
  '.actor/key_value_store_schema.json',
  '.github/workflows/ci.yml',
  'fixtures/input-smoke.json',
  'fixtures/change-page-v1.html',
  'fixtures/change-page-v2.html',
  'fixtures/cloud-proof.html',
  'fixtures/expected-change.json',
  'src/main.ts',
  'src/input.ts',
  'src/types.ts',
  'src/inspection.ts',
  'src/security/network.ts',
  'src/security/redaction.ts',
  'src/security/robots.ts',
  'src/security/target.ts',
  'src/extraction/extract.ts',
  'src/extraction/selectors.ts',
  'src/baseline/canonical.ts',
  'src/baseline/engine.ts',
  'src/baseline/persistence.ts',
  'src/baseline/types.ts',
  'src/intelligence/classify.ts',
  'src/intelligence/normalize.ts',
  'src/intelligence/report.ts',
  'src/intelligence/types.ts',
  'src/billing.ts',
  'src/runtime.ts',
  'src/delivery/digest.ts',
  'src/delivery/service.ts',
  'src/delivery/types.ts',
  'src/delivery/webhook.ts',
  'tests/baseline-canonical.test.ts',
  'tests/baseline-engine.test.ts',
  'tests/billing.test.ts',
  'tests/delivery-digest.test.ts',
  'tests/delivery-service.test.ts',
  'tests/foundation.test.ts',
  'tests/input.test.ts',
  'tests/inspection.test.ts',
  'tests/intelligence-classify.test.ts',
  'tests/intelligence-normalize.test.ts',
  'tests/intelligence-report.test.ts',
  'tests/network.test.ts',
  'tests/robots-extraction.test.ts',
  'tests/security-target.test.ts',
  'tests/runtime.test.ts',
  'tests/webhook.test.ts',
  'Dockerfile',
  'README.md',
];

await Promise.all(requiredFiles.map((file) => access(file)));

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const actor = await json('.actor/actor.json');
const input = await json('.actor/INPUT_SCHEMA.json');
const output = await json('.actor/output_schema.json');
const dataset = await json('.actor/dataset_schema.json');
const keyValueStore = await json('.actor/key_value_store_schema.json');
const smoke = await json('fixtures/input-smoke.json');

assert.equal(actor.name, 'competitor-change-intelligence-monitor');
assert.equal(actor.version, '0.1');
assert.equal(actor.input, './INPUT_SCHEMA.json');
assert.equal(input.additionalProperties, false);
assert.equal(input.properties.targets.maxItems, 25);
assert.deepEqual(input.required, ['targets', 'confirmAuthorizedUse']);
assert.equal(input.properties.alertWebhookUrl.isSecret, true);
assert.equal(input.properties.baselineAction.default, 'compare_only');
assert.equal(smoke.targets[0].url, 'https://example.com/');
assert.equal(smoke.confirmAuthorizedUse, false);
assert.equal(smoke.baselineAction, 'compare_only');
assert.equal(smoke.notificationMode, 'none');
assert.equal(smoke.dryRun, true);
assert.ok(output.properties.reports);
assert.ok(output.properties.runSummary);
assert.equal(output.properties.trustedBaselines, undefined);
assert.equal(output.properties.candidateBaselines, undefined);
assert.ok(dataset.views.overview);
assert.ok(dataset.views.changes);
assert.ok(dataset.views.failures);
assert.ok(dataset.fields.properties.persistence);
assert.ok(keyValueStore.collections.trustedBaselineManifests);
assert.ok(keyValueStore.collections.candidateBaselineManifests);
assert.ok(keyValueStore.collections.trustedBaselineChunks);
assert.ok(keyValueStore.collections.candidateBaselineChunks);
assert.ok(keyValueStore.collections.baselineLeases);
assert.ok(keyValueStore.collections.weeklyDigestState);

const main = await readFile('src/main.ts', 'utf8');
const runtime = await readFile('src/runtime.ts', 'utf8');
assert.doesNotMatch(main, /FOUNDATION_ONLY/);
assert.match(main, /Actor\.pushData\(\{ \.\.\.report \}, eventName\)/);
assert.doesNotMatch(`${main}\n${runtime}`, /Actor\.charge\s*\(/);
assert.match(runtime, /PAGE_CHECKED_EVENT/);
assert.match(main, /Actor\.fail\(message\)/);
assert.match(main, /contentType === 'application\/json'/);
assert.doesNotMatch(main, /finally\s*\{\s*await Actor\.exit/);

console.log(`Phase 5 repository validation passed for ${requiredFiles.length} required files.`);
