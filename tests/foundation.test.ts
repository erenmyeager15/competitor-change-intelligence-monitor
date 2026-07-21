import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const json = async (file: string): Promise<Record<string, any>> => JSON.parse(await readFile(file, 'utf8'));

test('Actor metadata references strict schemas and a non-production version', async () => {
  const actor = await json('.actor/actor.json');
  assert.equal(actor.name, 'competitor-change-intelligence-monitor');
  assert.equal(actor.version, '0.1');
  assert.equal(actor.input, './INPUT_SCHEMA.json');
  assert.equal(actor.output, './output_schema.json');
  await Promise.all([
    access('.actor/INPUT_SCHEMA.json'),
    access('.actor/output_schema.json'),
    access('.actor/dataset_schema.json'),
    access('.actor/key_value_store_schema.json'),
  ]);
});

test('Store prefill is a non-mutating, no-alert, no-charge safe demo', async () => {
  const schema = await json('.actor/INPUT_SCHEMA.json');
  const smoke = await json('fixtures/input-smoke.json');
  assert.deepEqual(schema.properties.targets.prefill, smoke.targets);
  assert.equal(schema.properties.confirmAuthorizedUse.prefill, false);
  assert.equal(schema.properties.baselineAction.prefill, 'compare_only');
  assert.equal(schema.properties.notificationMode.prefill, 'none');
  assert.equal(schema.properties.dryRun.prefill, true);
  assert.equal(smoke.targets[0].url, 'https://example.com/');
});

test('input and Dataset schemas reject unexpected fields', async () => {
  const input = await json('.actor/INPUT_SCHEMA.json');
  const dataset = await json('.actor/dataset_schema.json');
  assert.equal(input.additionalProperties, false);
  assert.equal(input.properties.targets.items.additionalProperties, false);
  assert.equal(input.properties.targets.maxItems, 25);
  assert.equal(dataset.fields.additionalProperties, false);
  assert.equal(dataset.fields.definitions.change.additionalProperties, false);
});

test('output exposes reports and digests without leaking persistent baseline storage links', async () => {
  const output = await json('.actor/output_schema.json');
  assert.ok(output.properties.reports);
  assert.ok(output.properties.runSummary);
  assert.ok(output.properties.digestMarkdown);
  assert.ok(output.properties.digestJson);
  assert.equal(output.properties.trustedBaselines, undefined);
  assert.equal(output.properties.candidateBaselines, undefined);
});

test('fictional fixtures encode controlled price, feature, and terms changes', async () => {
  const v1 = await readFile('fixtures/change-page-v1.html', 'utf8');
  const v2 = await readFile('fixtures/change-page-v2.html', 'utf8');
  const expected = await json('fixtures/expected-change.json');
  assert.match(v1, /\$29 per month/);
  assert.match(v2, /\$35 per month/);
  assert.match(v1, /10 dashboards/);
  assert.match(v2, /25 dashboards/);
  assert.match(v2, /Annual commitment required/);
  assert.deepEqual(expected.expectedCategories, ['price', 'product_feature', 'pricing_plan', 'terms_policy']);
});

test('runtime uses the integrated bounded monitor and atomic event persistence', async () => {
  const main = await readFile('src/main.ts', 'utf8');
  const runtime = await readFile('src/runtime.ts', 'utf8');
  assert.doesNotMatch(main, /FOUNDATION_ONLY/);
  assert.doesNotMatch(main, /fetch\s*\(/);
  assert.match(main, /runMonitor/);
  assert.match(main, /Actor\.pushData\(\{ \.\.\.report \}, eventName\)/);
  assert.match(main, /pricing\.perEventPrices\[PAGE_CHECKED_EVENT\]/);
  assert.match(main, /normalizeSingleReportCharge\(charge\)/);
  assert.doesNotMatch(main, /Actor\.charge/);
  assert.match(main, /Actor\.fail\(message\)/);
  assert.match(main, /contentType === 'application\/json'/);
  assert.doesNotMatch(main, /finally\s*\{\s*await Actor\.exit/);
  assert.doesNotMatch(runtime, /Actor\.charge/);
  assert.match(runtime, /PAGE_CHECKED_EVENT/);
});
