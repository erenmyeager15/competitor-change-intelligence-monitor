import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalStringify, prepareSnapshot, SnapshotValidationError, targetIdentity } from '../src/baseline/canonical.js';
import type { TargetInput } from '../src/types.js';

const target: TargetInput = {
  name: 'Northstar pricing',
  url: 'https://example.com/pricing?b=2&a=1',
  changeTypes: ['price', 'pricing_plan'],
  includeSelectors: ['main'],
  excludeSelectors: ['.noise'],
  ignoreTextPatterns: ['Updated * ago'],
};

test('canonical serialization and snapshot hashes ignore object key insertion order', () => {
  const left = prepareSnapshot({ z: 2, nested: { b: true, a: 'x' }, a: 1 });
  const right = prepareSnapshot({ a: 1, nested: { a: 'x', b: true }, z: 2 });
  assert.equal(left.serialized, right.serialized);
  assert.equal(left.hash, right.hash);
  assert.equal(canonicalStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test('snapshot preparation redacts sensitive values and preserves business identifiers', () => {
  const prepared = prepareSnapshot({
    apiKey: 'secret',
    webhookUrl: 'https://hooks.example/abc',
    nested: { email: 'owner@example.com', date: '2026-07-21', gtin: '1234567890123' },
  });
  assert.deepEqual(prepared.snapshot, {
    apiKey: '[REDACTED]',
    nested: { date: '2026-07-21', email: '[REDACTED_EMAIL]', gtin: '1234567890123' },
    webhookUrl: '[REDACTED]',
  });
  assert.equal(prepared.serialized.includes('secret'), false);
  assert.equal(prepared.serialized.includes('owner@example.com'), false);
});

test('snapshot preparation rejects raw response documents and unsupported values', () => {
  assert.throws(() => prepareSnapshot({ rawHtml: '<main>secret</main>' }), SnapshotValidationError);
  assert.throws(() => prepareSnapshot({ content: '<!doctype html><html></html>' }), SnapshotValidationError);
  assert.throws(() => prepareSnapshot({ value: Number.NaN }), SnapshotValidationError);
  assert.throws(() => prepareSnapshot({ value: undefined }), SnapshotValidationError);
});

test('target identity is deterministic and covers the approved baseline scope', () => {
  const first = targetIdentity(target);
  const reorderedQuery = targetIdentity({ ...target, url: 'https://example.com/pricing?a=1&b=2' });
  assert.equal(first.hash, reorderedQuery.hash);
  assert.notEqual(first.hash, targetIdentity({ ...target, name: 'Different name' }).hash);
  assert.notEqual(first.hash, targetIdentity({ ...target, changeTypes: ['price'] }).hash);
  assert.notEqual(first.hash, targetIdentity({ ...target, includeSelectors: ['article'] }).hash);
  assert.notEqual(first.hash, targetIdentity({ ...target, ignoreTextPatterns: [] }).hash);
});
