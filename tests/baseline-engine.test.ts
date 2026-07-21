import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBaselineAction } from '../src/baseline/engine.js';
import { targetIdentity } from '../src/baseline/canonical.js';
import {
  BaselineStateError,
  candidateManifestKey,
  commitManifest,
  leaseKey,
  loadCandidate,
  loadTrusted,
  trustedManifestKey,
} from '../src/baseline/persistence.js';
import {
  NORMALIZER_VERSION,
  STORAGE_SCHEMA_VERSION,
  type BaselineLease,
  type BaselineOperationInput,
  type BaselineStore,
  type SnapshotPayload,
  type TrustedBaselineManifest,
} from '../src/baseline/types.js';
import type { TargetInput } from '../src/types.js';

class MemoryStore implements BaselineStore {
  readonly values = new Map<string, unknown>();
  readonly events: Array<{ operation: 'get' | 'set' | 'delete'; key: string }> = [];
  beforeGet?: (key: string, store: MemoryStore) => void | Promise<void>;
  beforeSet?: (key: string, value: unknown | null, store: MemoryStore) => void | Promise<void>;

  async getValue<T>(key: string): Promise<T | null> {
    await this.beforeGet?.(key, this);
    this.events.push({ operation: 'get', key });
    return this.values.has(key) ? structuredClone(this.values.get(key)) as T : null;
  }

  async setValue(key: string, value: unknown | null): Promise<void> {
    await this.beforeSet?.(key, value, this);
    this.events.push({ operation: value === null ? 'delete' : 'set', key });
    if (value === null) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
}

const target: TargetInput = {
  name: 'Northstar pricing',
  url: 'https://example.com/pricing',
  changeTypes: ['price', 'pricing_plan'],
  includeSelectors: ['main'],
};
const NOW = '2026-07-21T12:00:00.000Z';

function ids(prefix = 'id'): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function operation(store: BaselineStore, action: BaselineOperationInput['action'], snapshot: SnapshotPayload, extra: Partial<BaselineOperationInput> = {}): BaselineOperationInput {
  return {
    store,
    target,
    action,
    snapshot,
    dependencies: { now: () => NOW, createId: ids(action) },
    ...extra,
  };
}

test('compare_only reports a missing baseline without writing any state', async () => {
  const store = new MemoryStore();
  const result = await applyBaselineAction(operation(store, 'compare_only', {}));
  assert.equal(result.status, 'baseline_missing');
  assert.equal(result.baselineFound, false);
  assert.equal(store.events.some((event) => event.operation !== 'get'), false);
});

test('initialization stores empty, single-chunk, and multi-chunk canonical snapshots', async () => {
  for (const snapshot of [{}, { price: 29 }, { sections: Array.from({ length: 4 }, (_, index) => `${index}-${'a'.repeat(40_000)}`), nested: { price: 29 } }]) {
    const store = new MemoryStore();
    const result = await applyBaselineAction(operation(store, 'initialize_trusted', snapshot, { chunkBytes: 128 }));
    assert.equal(result.status, 'baseline_initialized');
    assert.equal(result.baselineFound, false);
    assert.equal(result.baselineUpdated, true);
    assert.equal(result.previousSnapshotHash, null);
    const trusted = await loadTrusted(store, result.targetIdentityHash);
    assert.deepEqual(trusted?.snapshot, snapshot);
    assert.ok((trusted?.manifest.chunks.length ?? 0) >= 1);
    if ('sections' in snapshot) assert.ok(trusted!.manifest.chunks.length > 1);
  }
});

test('initialization cannot overwrite an existing trusted baseline and comparison never mutates it', async () => {
  const store = new MemoryStore();
  const first = await applyBaselineAction(operation(store, 'initialize_trusted', { price: 29 }));
  const writesAfterInitialize = store.events.filter((event) => event.operation !== 'get').length;
  const changed = await applyBaselineAction(operation(store, 'compare_only', { price: 35 }));
  assert.equal(changed.status, 'success_changed');
  assert.equal(store.events.filter((event) => event.operation !== 'get').length, writesAfterInitialize);
  const secondInitialize = await applyBaselineAction(operation(store, 'initialize_trusted', { price: 35 }));
  assert.equal(secondInitialize.status, 'success_changed');
  assert.equal(secondInitialize.baselineUpdated, false);
  assert.equal((await loadTrusted(store, first.targetIdentityHash))?.manifest.snapshotHash, first.currentSnapshotHash);
});

test('candidate storage is isolated and exact candidate/parent lineage is required for promotion', async () => {
  const store = new MemoryStore();
  const initial = await applyBaselineAction(operation(store, 'initialize_trusted', { price: 29 }));
  const candidate = await applyBaselineAction(operation(store, 'store_candidate', { price: 35 }, {
    dependencies: { now: () => '2026-07-21T12:01:00.000Z', createId: ids('candidate') },
  }));
  assert.equal(candidate.status, 'candidate_stored');
  assert.equal(candidate.candidateStored, true);
  assert.ok(candidate.candidateId);
  assert.equal((await loadTrusted(store, initial.targetIdentityHash))?.manifest.snapshotHash, initial.currentSnapshotHash);
  const storedCandidate = await loadCandidate(store, initial.targetIdentityHash, candidate.candidateId!);
  assert.equal(storedCandidate?.manifest.trustedParentSnapshotHash, initial.currentSnapshotHash);

  const mismatch = await applyBaselineAction(operation(store, 'promote_candidate', { price: 35 }, {
    candidateId: candidate.candidateId!,
    expectedCandidateHash: '0'.repeat(64),
    expectedTrustedParentHash: initial.currentSnapshotHash,
    dependencies: { now: () => '2026-07-21T12:02:00.000Z', createId: ids('bad-promotion') },
  }));
  assert.equal(mismatch.status, 'promotion_mismatch');
  assert.equal((await loadTrusted(store, initial.targetIdentityHash))?.manifest.snapshotHash, initial.currentSnapshotHash);

  const promoted = await applyBaselineAction(operation(store, 'promote_candidate', { ignoredCurrentPage: true }, {
    candidateId: candidate.candidateId!,
    expectedCandidateHash: candidate.currentSnapshotHash,
    expectedTrustedParentHash: initial.currentSnapshotHash,
    materialChangeCount: 1,
    dependencies: { now: () => '2026-07-21T12:03:00.000Z', createId: ids('promotion') },
  }));
  assert.equal(promoted.status, 'candidate_promoted');
  assert.equal(promoted.previousSnapshotHash, initial.currentSnapshotHash);
  assert.equal(promoted.currentSnapshotHash, candidate.currentSnapshotHash);
  assert.deepEqual(promoted.trustedSnapshot, { price: 35 });
  assert.equal(await loadCandidate(store, initial.targetIdentityHash, candidate.candidateId!), null);
});

test('a candidate with NO_PARENT can initialize trust only through exact promotion', async () => {
  const store = new MemoryStore();
  const candidate = await applyBaselineAction(operation(store, 'store_candidate', { availability: 'in_stock' }));
  const promoted = await applyBaselineAction(operation(store, 'promote_candidate', { availability: 'in_stock' }, {
    candidateId: candidate.candidateId!,
    expectedCandidateHash: candidate.currentSnapshotHash,
    expectedTrustedParentHash: 'NO_PARENT',
    dependencies: { now: () => '2026-07-21T12:03:00.000Z', createId: ids('no-parent') },
  }));
  assert.equal(promoted.status, 'candidate_promoted');
  assert.equal(promoted.baselineFound, false);
  assert.equal(promoted.previousSnapshotHash, null);
});

test('trusted evidence history retains only the newest 30 explicit mutations', async () => {
  const store = new MemoryStore();
  let trusted = await applyBaselineAction(operation(store, 'initialize_trusted', { version: 0 }));
  for (let index = 1; index <= 32; index += 1) {
    const minute = String(index).padStart(2, '0');
    const candidate = await applyBaselineAction(operation(store, 'store_candidate', { version: index }, {
      dependencies: { now: () => `2026-07-21T12:${minute}:00.000Z`, createId: ids(`c${index}`) },
    }));
    trusted = await applyBaselineAction(operation(store, 'promote_candidate', { version: index }, {
      candidateId: candidate.candidateId!,
      expectedCandidateHash: candidate.currentSnapshotHash,
      expectedTrustedParentHash: trusted.currentSnapshotHash,
      materialChangeCount: index,
      dependencies: { now: () => `2026-07-21T13:${minute}:00.000Z`, createId: ids(`p${index}`) },
    }));
    assert.equal(trusted.status, 'candidate_promoted');
  }
  const loaded = await loadTrusted(store, trusted.targetIdentityHash);
  assert.equal(loaded?.manifest.evidenceHistory.length, 30);
  assert.equal(loaded?.manifest.evidenceHistory.at(-1)?.materialChangeCount, 32);
  assert.equal(loaded?.manifest.evidenceHistory[0]?.materialChangeCount, 3);
});

test('active leases conflict, expired leases recover, and lease ownership is verified', async () => {
  const identityHash = targetIdentity(target).hash;
  const activeStore = new MemoryStore();
  const activeLease: BaselineLease = {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    owner: 'other',
    acquiredAt: NOW,
    expiresAt: '2026-07-21T12:10:00.000Z',
  };
  activeStore.values.set(leaseKey(identityHash), activeLease);
  assert.equal((await applyBaselineAction(operation(activeStore, 'initialize_trusted', { price: 29 }))).status, 'concurrency_conflict');

  const expiredStore = new MemoryStore();
  expiredStore.values.set(leaseKey(identityHash), { ...activeLease, expiresAt: '2026-07-21T11:59:00.000Z' });
  assert.equal((await applyBaselineAction(operation(expiredStore, 'initialize_trusted', { price: 29 }))).status, 'baseline_initialized');

  const stolenStore = new MemoryStore();
  let leaseReads = 0;
  stolenStore.beforeGet = async (key, store) => {
    if (key === leaseKey(identityHash) && ++leaseReads === 2) {
      const value = store.values.get(key) as BaselineLease;
      store.values.set(key, { ...value, owner: 'stolen' });
    }
  };
  assert.equal((await applyBaselineAction(operation(stolenStore, 'initialize_trusted', { price: 29 }))).status, 'concurrency_conflict');
});

test('manifest replacement checks the expected generation and lease before writing', async () => {
  const store = new MemoryStore();
  const identityHash = targetIdentity(target).hash;
  const oldManifest = manifestFixture(identityHash, 'old');
  const newManifest = manifestFixture(identityHash, 'new');
  store.values.set(trustedManifestKey(identityHash), { ...oldManifest, generation: 'raced' });
  store.values.set(leaseKey(identityHash), {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    owner: 'owner',
    acquiredAt: NOW,
    expiresAt: '2026-07-21T12:10:00.000Z',
  } satisfies BaselineLease);
  await assert.rejects(
    commitManifest({
      store,
      manifestKey: trustedManifestKey(identityHash),
      manifest: newManifest,
      previousManifest: oldManifest,
      leaseOwner: 'owner',
      identityHash,
      now: NOW,
    }),
    (error: unknown) => error instanceof BaselineStateError && error.code === 'CONCURRENCY_CONFLICT',
  );
  assert.equal((store.values.get(trustedManifestKey(identityHash)) as TrustedBaselineManifest).generation, 'raced');
});

test('old and candidate chunks are deleted only after a durable trusted manifest commit', async () => {
  const store = new MemoryStore();
  const initial = await applyBaselineAction(operation(store, 'initialize_trusted', { price: 29 }));
  const oldChunks = (await loadTrusted(store, initial.targetIdentityHash))!.manifest.chunks.map((chunk) => chunk.key);
  const candidate = await applyBaselineAction(operation(store, 'store_candidate', { price: 35 }));
  const candidateManifest = (await loadCandidate(store, initial.targetIdentityHash, candidate.candidateId!))!.manifest;
  store.events.length = 0;
  const promoted = await applyBaselineAction(operation(store, 'promote_candidate', { price: 35 }, {
    candidateId: candidate.candidateId!,
    expectedCandidateHash: candidate.currentSnapshotHash,
    expectedTrustedParentHash: initial.currentSnapshotHash,
    dependencies: { now: () => '2026-07-21T12:05:00.000Z', createId: ids('cleanup') },
  }));
  assert.equal(promoted.status, 'candidate_promoted');
  const manifestSet = store.events.findIndex((event) => event.operation === 'set' && event.key === trustedManifestKey(initial.targetIdentityHash));
  for (const key of [...oldChunks, candidateManifestKey(initial.targetIdentityHash, candidate.candidateId!), ...candidateManifest.chunks.map((chunk) => chunk.key)]) {
    const deleted = store.events.findIndex((event) => event.operation === 'delete' && event.key === key);
    assert.ok(deleted > manifestSet, `${key} was cleaned before the trusted manifest commit`);
  }
});

test('a failed manifest write leaves the previous generation and candidate intact without cleanup', async () => {
  const store = new MemoryStore();
  const initial = await applyBaselineAction(operation(store, 'initialize_trusted', { price: 29 }));
  const before = (await loadTrusted(store, initial.targetIdentityHash))!;
  const candidate = await applyBaselineAction(operation(store, 'store_candidate', { price: 35 }));
  const candidateBefore = (await loadCandidate(store, initial.targetIdentityHash, candidate.candidateId!))!;
  store.events.length = 0;
  store.beforeSet = async (key, value) => {
    if (key === trustedManifestKey(initial.targetIdentityHash) && value !== null) throw new Error('Simulated manifest failure.');
  };
  const promoted = await applyBaselineAction(operation(store, 'promote_candidate', { price: 35 }, {
    candidateId: candidate.candidateId!,
    expectedCandidateHash: candidate.currentSnapshotHash,
    expectedTrustedParentHash: initial.currentSnapshotHash,
    dependencies: { now: () => '2026-07-21T12:05:00.000Z', createId: ids('failed-commit') },
  }));
  assert.equal(promoted.status, 'internal_error');
  assert.equal((store.values.get(trustedManifestKey(initial.targetIdentityHash)) as TrustedBaselineManifest).generation, before.manifest.generation);
  for (const key of [...before.manifest.chunks.map((chunk) => chunk.key), candidateManifestKey(initial.targetIdentityHash, candidate.candidateId!), ...candidateBefore.manifest.chunks.map((chunk) => chunk.key)]) {
    assert.equal(store.values.has(key), true, `${key} should remain after failed commit`);
    assert.equal(store.events.some((event) => event.operation === 'delete' && event.key === key), false);
  }
});

test('missing/corrupt chunks and incompatible manifests fail closed without mutation', async () => {
  const store = new MemoryStore();
  const initialized = await applyBaselineAction(operation(store, 'initialize_trusted', { price: 29 }));
  const trusted = await loadTrusted(store, initialized.targetIdentityHash);
  store.values.delete(trusted!.manifest.chunks[0]!.key);
  const corrupt = await applyBaselineAction(operation(store, 'compare_only', { price: 29 }));
  assert.equal(corrupt.status, 'internal_error');
  assert.match(corrupt.persistence.error ?? '', /chunk/i);

  const migrationStore = new MemoryStore();
  migrationStore.values.set(trustedManifestKey(initialized.targetIdentityHash), {
    ...trusted!.manifest,
    storageSchemaVersion: 2,
  });
  const migration = await applyBaselineAction(operation(migrationStore, 'compare_only', { price: 29 }));
  assert.equal(migration.status, 'internal_error');
  assert.match(migration.persistence.error ?? '', /incompatible/i);
});

function manifestFixture(identityHash: string, generation: string): TrustedBaselineManifest {
  return {
    kind: 'trusted',
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    targetIdentityHash: identityHash,
    snapshotHash: 'a'.repeat(64),
    generation,
    chunks: [{ key: `${generation}-chunk`, sha256: 'b'.repeat(64), byteLength: 2 }],
    byteLength: 2,
    createdAt: NOW,
    updatedAt: NOW,
    evidenceHistory: [],
  };
}
