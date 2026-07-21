import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractDocument } from '../src/extraction/extract.js';
import type { PageInspection } from '../src/inspection.js';
import { composeTargetReport } from '../src/intelligence/report.js';
import type { BaselineStore } from '../src/baseline/types.js';
import type { TargetInput, TargetReport } from '../src/types.js';

class MemoryStore implements BaselineStore {
  readonly values = new Map<string, unknown>();
  async getValue<T>(key: string): Promise<T | null> { return (this.values.get(key) as T | undefined) ?? null; }
  async setValue(key: string, value: unknown | null): Promise<void> {
    if (value === null) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
}

const target: TargetInput = {
  name: 'Northstar pricing',
  url: 'https://example.com/pricing',
  changeTypes: ['price', 'availability', 'product_feature', 'pricing_plan', 'terms_policy'],
  currency: 'USD',
};

async function inspection(version: 1 | 2): Promise<PageInspection> {
  const body = await readFile(new URL(`../../fixtures/change-page-v${version}.html`, import.meta.url), 'utf8');
  return {
    status: 'ok',
    targetUrl: target.url,
    finalUrl: target.url,
    reachable: true,
    robotsAllowed: true,
    robotsReason: 'Allowed by fixture.',
    httpStatus: 200,
    contentType: 'text/html',
    responseBytes: Buffer.byteLength(body),
    latencyMs: 10,
    redirectOrigins: [],
    document: extractDocument(body, 'text/html', target),
    error: null,
  };
}

test('composes baseline initialization and a schema-compatible material change report', async () => {
  const store = new MemoryStore();
  const initialized = await composeTargetReport({
    target,
    inspection: await inspection(1),
    store,
    baselineAction: 'initialize_trusted',
    minimumMateriality: 'low',
    checkedAt: '2026-07-21T10:00:00Z',
    baselineDependencies: { now: () => '2026-07-21T10:00:00Z', createId: () => 'phase4-init' },
  });
  assert.equal(initialized.status, 'baseline_initialized');
  assert.equal(initialized.changeDetected, false);
  assert.equal(initialized.baselineUpdated, true);

  const changed = await composeTargetReport({
    target,
    inspection: await inspection(2),
    store,
    baselineAction: 'compare_only',
    minimumMateriality: 'low',
    checkedAt: '2026-07-21T11:00:00Z',
  });
  assert.equal(changed.status, 'success_changed');
  assert.equal(changed.changeDetected, true);
  assert.equal(changed.overallSeverity, 'high');
  assert.ok(changed.materialChangeCount >= 4);
  assert.deepEqual([...new Set(changed.changes.map((change) => change.category))].sort(), ['price', 'pricing_plan', 'product_feature', 'terms_policy']);
  await assertDatasetShape(changed);
});

test('filters changes below the selected materiality threshold', async () => {
  const store = new MemoryStore();
  await composeTargetReport({
    target,
    inspection: await inspection(1),
    store,
    baselineAction: 'initialize_trusted',
    minimumMateriality: 'low',
    checkedAt: '2026-07-21T10:00:00Z',
    baselineDependencies: { now: () => '2026-07-21T10:00:00Z', createId: () => 'phase4-filter' },
  });
  const highOnly = await composeTargetReport({
    target,
    inspection: await inspection(2),
    store,
    baselineAction: 'compare_only',
    minimumMateriality: 'high',
    checkedAt: '2026-07-21T11:00:00Z',
  });
  assert.ok(highOnly.changes.length > 0);
  assert.ok(highOnly.changes.every((change) => change.severity === 'high' || change.severity === 'critical'));
  assert.equal(highOnly.changes.some((change) => change.category === 'price'), false);
});

test('turns inspection safety stops into structured critical reports without baseline writes', async () => {
  const blocked: PageInspection = {
    status: 'blocked_target',
    targetUrl: 'https://127.0.0.1/',
    finalUrl: 'https://127.0.0.1/',
    reachable: false,
    robotsAllowed: null,
    robotsReason: 'Target rejected before network access.',
    httpStatus: null,
    contentType: null,
    responseBytes: 0,
    latencyMs: 0,
    redirectOrigins: [],
    document: null,
    error: { code: 'BLOCKED_TARGET', message: 'Private target rejected.' },
  };
  const store = new MemoryStore();
  const report = await composeTargetReport({
    target: { ...target, url: blocked.targetUrl },
    inspection: blocked,
    store,
    baselineAction: 'compare_only',
    minimumMateriality: 'low',
    checkedAt: '2026-07-21T12:00:00Z',
  });
  assert.equal(report.status, 'blocked_target');
  assert.equal(report.overallSeverity, 'critical');
  assert.equal(report.persistence.succeeded, true);
  assert.equal(store.values.size, 0);
  await assertDatasetShape(report);
});

async function assertDatasetShape(report: TargetReport): Promise<void> {
  const schema = JSON.parse(await readFile(new URL('../../.actor/dataset_schema.json', import.meta.url), 'utf8')) as {
    fields: { required: string[]; properties: Record<string, unknown> };
  };
  for (const key of schema.fields.required) assert.ok(key in report, `Missing required output field: ${key}`);
  for (const key of Object.keys(report)) assert.ok(key in schema.fields.properties, `Unexpected output field: ${key}`);
}
