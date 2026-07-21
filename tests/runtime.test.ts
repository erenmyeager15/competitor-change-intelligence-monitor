import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { BaselineStore } from '../src/baseline/types.js';
import { extractDocument } from '../src/extraction/extract.js';
import type { PageInspection } from '../src/inspection.js';
import { runMonitor, type PushResult, type RuntimeDependencies } from '../src/runtime.js';
import type { ActorInput, TargetInput, TargetReport } from '../src/types.js';

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
  changeTypes: ['price', 'product_feature', 'pricing_plan', 'terms_policy'],
  currency: 'USD',
};

function actorInput(overrides: Partial<ActorInput> = {}): ActorInput {
  return {
    targets: [target],
    confirmAuthorizedUse: true,
    baselineAction: 'compare_only',
    includeUnchanged: false,
    minimumMateriality: 'low',
    notificationMode: 'none',
    minimumAlertSeverity: 'medium',
    weeklyDigestDay: 1,
    timezone: 'UTC',
    requestTimeoutSeconds: 10,
    maxResponseBytes: 262_144,
    maxRetries: 0,
    dryRun: false,
    ...overrides,
  };
}

async function pageInspection(version: 1 | 2): Promise<PageInspection> {
  const body = await readFile(new URL(`../../fixtures/change-page-v${version}.html`, import.meta.url), 'utf8');
  return {
    status: 'ok', targetUrl: target.url, finalUrl: target.url, reachable: true, robotsAllowed: true,
    robotsReason: 'Allowed by fixture.', httpStatus: 200, contentType: 'text/html',
    responseBytes: Buffer.byteLength(body), latencyMs: 5, redirectOrigins: [],
    document: extractDocument(body, 'text/html', target), error: null,
  };
}

function blockedInspection(): PageInspection {
  return {
    status: 'blocked_target', targetUrl: target.url, finalUrl: target.url, reachable: false,
    robotsAllowed: null, robotsReason: 'Rejected before network access.', httpStatus: null,
    contentType: null, responseBytes: 0, latencyMs: 0, redirectOrigins: [], document: null,
    error: { code: 'BLOCKED_TARGET', message: 'Private target rejected.' },
  };
}

function pushResult(chargedCount = 0, eventChargeLimitReached = false): PushResult {
  return { chargedCount, eventChargeLimitReached, chargeableWithinLimit: { 'page-checked': 10 } };
}

function dependencies(overrides: Partial<RuntimeDependencies> = {}): RuntimeDependencies & { outputs: Map<string, unknown> } {
  const outputs = new Map<string, unknown>();
  return {
    stateStore: new MemoryStore(),
    billingEnabled: true,
    getChargeableCount: () => 10,
    pushData: async (_report, eventName) => pushResult(eventName ? 1 : 0),
    setOutputValue: async (key, value) => { outputs.set(key, structuredClone(value)); },
    now: () => '2026-07-21T10:00:00.000Z',
    runUrl: 'https://console.apify.com/actors/runs/test?token=secret',
    baselineDependencies: { now: () => '2026-07-21T10:00:00.000Z', createId: () => 'runtime-test' },
    outputs,
    ...overrides,
  };
}

test('dry run does not mutate, charge, or deliver', async () => {
  const stateStore = new MemoryStore();
  const events: Array<string | undefined> = [];
  let sends = 0;
  const deps = dependencies({
    stateStore,
    inspect: async () => pageInspection(1),
    pushData: async (_report, eventName) => { events.push(eventName); return pushResult(0); },
    deliveryDependencies: { send: async () => { sends += 1; return { attempts: 1, statusCode: 204, responseBytes: 0 }; } },
  });
  const result = await runMonitor(actorInput({
    dryRun: true, notificationMode: 'immediate', alertWebhookUrl: 'https://hooks.example.com/hook',
  }), deps);
  assert.deepEqual(events, [undefined]);
  assert.equal(stateStore.values.size, 0);
  assert.equal(sends, 0);
  assert.equal(result.summary.chargedEventCount, 0);
  assert.equal(result.summary.delivery.status, 'disabled');
  assert.deepEqual([...deps.outputs.keys()].sort(), ['DIGEST.json', 'DIGEST.md', 'RUN_SUMMARY.json']);
});

test('successful report persistence and PPE charging are one atomic operation', async () => {
  const events: Array<string | undefined> = [];
  const deps = dependencies({
    inspect: async () => pageInspection(1),
    pushData: async (_report, eventName) => { events.push(eventName); return pushResult(eventName ? 1 : 0); },
  });
  const result = await runMonitor(actorInput({ baselineAction: 'initialize_trusted' }), deps);
  assert.deepEqual(events, ['page-checked']);
  assert.equal(result.reports[0]?.status, 'baseline_initialized');
  assert.equal(result.summary.billableReportCount, 1);
  assert.equal(result.summary.chargedEventCount, 1);
  assert.equal(result.summary.costAssessment.measured, false);
});

test('owner-discounted PPE persistence with zero charged count is still successful', async () => {
  const calls: Array<string | undefined> = [];
  const deps = dependencies({
    inspect: async () => pageInspection(1),
    pushData: async (_report, eventName) => { calls.push(eventName); return pushResult(0, false); },
  });
  const result = await runMonitor(actorInput({ baselineAction: 'initialize_trusted' }), deps);
  assert.deepEqual(calls, ['page-checked']);
  assert.equal(result.reports[0]?.status, 'baseline_initialized');
  assert.equal(result.summary.persistedReportCount, 1);
  assert.equal(result.summary.billableReportCount, 1);
  assert.equal(result.summary.chargedEventCount, 0);
});

test('pre-pricing runtime persists eligible reports without an event name', async () => {
  const calls: Array<string | undefined> = [];
  const deps = dependencies({
    billingEnabled: false,
    inspect: async () => pageInspection(1),
    pushData: async (_report, eventName) => { calls.push(eventName); return pushResult(0); },
  });
  const result = await runMonitor(actorInput({ baselineAction: 'initialize_trusted' }), deps);
  assert.deepEqual(calls, [undefined]);
  assert.equal(result.summary.persistedReportCount, 1);
  assert.equal(result.summary.billableReportCount, 1);
  assert.equal(result.summary.chargedEventCount, 0);
});

test('safety-stop reports persist without charging', async () => {
  const events: Array<string | undefined> = [];
  const deps = dependencies({
    inspect: async () => blockedInspection(),
    pushData: async (_report, eventName) => { events.push(eventName); return pushResult(0); },
  });
  const result = await runMonitor(actorInput(), deps);
  assert.deepEqual(events, [undefined]);
  assert.equal(result.reports[0]?.status, 'blocked_target');
  assert.equal(result.summary.chargedEventCount, 0);
});

test('known zero allowance stops before inspection or persistence', async () => {
  let inspections = 0;
  let pushes = 0;
  const deps = dependencies({
    getChargeableCount: () => 0,
    inspect: async () => { inspections += 1; return pageInspection(1); },
    pushData: async () => { pushes += 1; return pushResult(0); },
  });
  const result = await runMonitor(actorInput(), deps);
  assert.equal(inspections, 0);
  assert.equal(pushes, 0);
  assert.equal(result.summary.processedTargetCount, 0);
  assert.equal(result.summary.skippedForChargeLimit, 1);
});

test('persistence failure is not counted as persisted, billable, or charged', async () => {
  const deps = dependencies({
    inspect: async () => pageInspection(1),
    pushData: async () => { throw new Error('dataset unavailable'); },
  });
  const result = await runMonitor(actorInput({ baselineAction: 'initialize_trusted' }), deps);
  assert.equal(result.summary.processedTargetCount, 1);
  assert.equal(result.summary.persistedReportCount, 0);
  assert.equal(result.summary.persistenceFailureCount, 1);
  assert.equal(result.summary.billableReportCount, 0);
  assert.equal(result.summary.chargedEventCount, 0);
});

test('charge allowance race records a nonbillable stop and skips remaining targets', async () => {
  const calls: Array<{ event: string | undefined; status: TargetReport['status'] }> = [];
  const deps = dependencies({
    inspect: async () => pageInspection(1),
    pushData: async (report, eventName) => {
      calls.push({ event: eventName, status: report.status });
      return pushResult(0, true);
    },
  });
  const result = await runMonitor(actorInput({
    targets: [target, { ...target, name: 'Second target', url: 'https://example.com/second' }],
    baselineAction: 'initialize_trusted',
  }), deps);
  assert.deepEqual(calls, [
    { event: 'page-checked', status: 'baseline_initialized' },
    { event: undefined, status: 'internal_error' },
  ]);
  assert.equal(result.summary.chargedEventCount, 0);
  assert.equal(result.summary.skippedForChargeLimit, 1);
});

test('webhook delivery begins only after changed report persistence', async () => {
  const stateStore = new MemoryStore();
  await runMonitor(actorInput({ baselineAction: 'initialize_trusted' }), dependencies({
    stateStore, inspect: async () => pageInspection(1),
  }));
  const operations: string[] = [];
  const result = await runMonitor(actorInput({
    notificationMode: 'immediate', alertWebhookUrl: 'https://hooks.example.com/hook',
  }), dependencies({
    stateStore,
    inspect: async () => pageInspection(2),
    pushData: async (_report, eventName) => { operations.push(`push:${eventName ?? 'none'}`); return pushResult(eventName ? 1 : 0); },
    deliveryDependencies: {
      send: async () => { operations.push('send'); return { attempts: 1, statusCode: 204, responseBytes: 0 }; },
    },
  }));
  assert.deepEqual(operations, ['push:page-checked', 'send']);
  assert.equal(result.summary.delivery.status, 'delivered');
});
