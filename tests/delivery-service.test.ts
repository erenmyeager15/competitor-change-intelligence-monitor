import assert from 'node:assert/strict';
import test from 'node:test';
import type { BaselineStore } from '../src/baseline/types.js';
import { deliverDigest, weeklyWindow } from '../src/delivery/service.js';
import type { DigestChange, DigestDocument, WeeklyDigestState } from '../src/delivery/types.js';
import type { ActorInput } from '../src/types.js';

class MemoryStore implements BaselineStore {
  readonly values = new Map<string, unknown>();
  async getValue<T>(key: string): Promise<T | null> { return (this.values.get(key) as T | undefined) ?? null; }
  async setValue(key: string, value: unknown | null): Promise<void> {
    if (value === null) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
}

function actorInput(overrides: Partial<ActorInput> = {}): ActorInput {
  return {
    targets: [{ name: 'Northstar', url: 'https://example.com/pricing', changeTypes: ['price'] }],
    confirmAuthorizedUse: true,
    baselineAction: 'compare_only',
    includeUnchanged: false,
    minimumMateriality: 'low',
    notificationMode: 'weekly_digest',
    minimumAlertSeverity: 'medium',
    alertWebhookUrl: 'https://hooks.example.com/secret-hook',
    weeklyDigestDay: 1,
    timezone: 'UTC',
    requestTimeoutSeconds: 10,
    maxResponseBytes: 262_144,
    maxRetries: 0,
    dryRun: false,
    ...overrides,
  };
}

function change(id: string, severity: DigestChange['severity'] = 'high'): DigestChange {
  return {
    changeId: id,
    targetName: 'Northstar',
    targetUrl: 'https://example.com/pricing',
    category: 'price',
    field: 'price',
    severity,
    confidenceScore: 95,
    confidence: 'high',
    explanation: 'Price increased.',
    recommendedAction: 'Review margin.',
    previousExcerpt: '$10',
    currentExcerpt: '$12',
  };
}

function digest(changes: DigestChange[]): DigestDocument {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-19T10:00:00.000Z',
    runUrl: null,
    reportCount: 1,
    changedTargetCount: changes.length ? 1 : 0,
    changeCount: changes.length,
    changes,
  };
}

test('immediate delivery skips empty digests and sends at most once otherwise', async () => {
  const store = new MemoryStore();
  let sends = 0;
  const input = actorInput({ notificationMode: 'immediate' });
  const empty = await deliverDigest({
    input, digest: digest([]), stateStore: store, now: '2026-07-21T10:00:00Z',
    dependencies: { send: async () => { sends += 1; return { attempts: 1, statusCode: 204, responseBytes: 0 }; } },
  });
  assert.equal(empty.status, 'no_changes');
  assert.equal(sends, 0);

  const delivered = await deliverDigest({
    input, digest: digest([change('a')]), stateStore: store, now: '2026-07-21T10:00:00Z',
    dependencies: { send: async () => { sends += 1; return { attempts: 1, statusCode: 204, responseBytes: 0 }; } },
  });
  assert.equal(delivered.status, 'delivered');
  assert.equal(sends, 1);
});

test('weekly delivery carries queued changes, sends once per window, and never persists the webhook URL', async () => {
  const store = new MemoryStore();
  const sentIds: string[] = [];
  const dependencies = {
    createId: () => 'lease-owner',
    send: async (_url: string, payload: { deliveryId: string }) => {
      sentIds.push(payload.deliveryId);
      return { attempts: 1, statusCode: 204, responseBytes: 0 };
    },
  };
  const queued = await deliverDigest({
    input: actorInput(), digest: digest([change('a')]), stateStore: store,
    now: '2026-07-19T10:00:00Z', dependencies,
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queuedChangeCount, 1);
  assert.doesNotMatch(JSON.stringify([...store.values.values()]), /secret-hook|hooks\.example\.com/);

  const delivered = await deliverDigest({
    input: actorInput(), digest: digest([]), stateStore: store,
    now: '2026-07-20T10:00:00Z', dependencies,
  });
  assert.equal(delivered.status, 'delivered');
  assert.equal(sentIds.length, 1);

  const heldUntilNextWindow = await deliverDigest({
    input: actorInput(), digest: digest([change('b')]), stateStore: store,
    now: '2026-07-20T11:00:00Z', dependencies,
  });
  assert.equal(heldUntilNextWindow.status, 'already_delivered');
  assert.equal(heldUntilNextWindow.queuedChangeCount, 1);
  assert.equal(sentIds.length, 1);

  const nextWeek = await deliverDigest({
    input: actorInput(), digest: digest([]), stateStore: store,
    now: '2026-07-27T10:00:00Z', dependencies,
  });
  assert.equal(nextWeek.status, 'delivered');
  assert.equal(sentIds.length, 2);
});

test('weekly lease prevents duplicate sends and failed delivery retains pending changes', async () => {
  const store = new MemoryStore();
  await deliverDigest({
    input: actorInput(), digest: digest([change('a')]), stateStore: store,
    now: '2026-07-19T10:00:00Z',
  });
  const key = [...store.values.keys()][0]!;
  const state = await store.getValue<WeeklyDigestState>(key);
  assert.ok(state);
  const mondayWindow = weeklyWindow('2026-07-20T10:00:00Z', 'UTC');
  await store.setValue(key, {
    ...state,
    windowId: mondayWindow.windowId,
    delivery: {
      deliveryId: 'active', owner: 'other-owner', status: 'sending',
      acquiredAt: '2026-07-20T09:59:00.000Z', expiresAt: '2026-07-20T10:04:00.000Z', deliveredAt: null,
    },
  } satisfies WeeklyDigestState);
  let sends = 0;
  const leaseHeld = await deliverDigest({
    input: actorInput(), digest: digest([]), stateStore: store,
    now: '2026-07-20T10:00:00Z',
    dependencies: { send: async () => { sends += 1; return { attempts: 1, statusCode: 204, responseBytes: 0 }; } },
  });
  assert.equal(leaseHeld.status, 'lease_held');
  assert.equal(sends, 0);

  await store.setValue(key, { ...await store.getValue<WeeklyDigestState>(key), delivery: null });
  const failed = await deliverDigest({
    input: actorInput(), digest: digest([]), stateStore: store,
    now: '2026-07-20T10:05:00Z',
    dependencies: { createId: () => 'retry-owner', send: async () => { throw new Error('temporary failure'); } },
  });
  assert.equal(failed.status, 'failed');
  const afterFailure = await store.getValue<WeeklyDigestState>(key);
  assert.equal(afterFailure?.pendingChanges.length, 1);
  assert.equal(afterFailure?.delivery, null);

  const retry = await deliverDigest({
    input: actorInput(), digest: digest([]), stateStore: store,
    now: '2026-07-20T10:06:00Z',
    dependencies: { createId: () => 'retry-owner-2', send: async () => ({ attempts: 1, statusCode: 204, responseBytes: 0 }) },
  });
  assert.equal(retry.status, 'delivered');
});
