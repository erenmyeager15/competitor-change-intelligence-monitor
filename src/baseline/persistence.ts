import {
  DEFAULT_CHUNK_BYTES,
  NORMALIZER_VERSION,
  STORAGE_SCHEMA_VERSION,
  type BaselineLease,
  type BaselineManifest,
  type BaselineStore,
  type CandidateBaselineManifest,
  type SnapshotChunk,
  type SnapshotChunkReference,
  type SnapshotPayload,
  type TrustedBaselineManifest,
} from './types.js';
import { canonicalStringify, sha256 } from './canonical.js';

export type BaselineStateErrorCode = 'CORRUPT_STATE' | 'MIGRATION_REQUIRED' | 'CONCURRENCY_CONFLICT';

export class BaselineStateError extends Error {
  constructor(public readonly code: BaselineStateErrorCode, message: string) {
    super(message);
    this.name = 'BaselineStateError';
  }
}

export function trustedManifestKey(identityHash: string): string {
  return `trusted-baseline-v1-manifest-${identityHash}`;
}

export function candidateManifestKey(identityHash: string, candidateId: string): string {
  return `candidate-baseline-v1-manifest-${identityHash}-${sha256(candidateId).slice(0, 24)}`;
}

export function leaseKey(identityHash: string): string {
  return `baseline-lease-v1-${identityHash}`;
}

export async function loadTrusted(
  store: BaselineStore,
  identityHash: string,
): Promise<{ manifest: TrustedBaselineManifest; snapshot: SnapshotPayload } | null> {
  const key = trustedManifestKey(identityHash);
  const manifest = await store.getValue<unknown>(key);
  if (manifest === null) return null;
  const validated = validateManifest(manifest, 'trusted', identityHash) as TrustedBaselineManifest;
  return { manifest: validated, snapshot: await loadSnapshot(store, validated) };
}

export async function loadCandidate(
  store: BaselineStore,
  identityHash: string,
  candidateId: string,
): Promise<{ manifest: CandidateBaselineManifest; snapshot: SnapshotPayload } | null> {
  const manifest = await store.getValue<unknown>(candidateManifestKey(identityHash, candidateId));
  if (manifest === null) return null;
  const validated = validateManifest(manifest, 'candidate', identityHash) as CandidateBaselineManifest;
  if (validated.candidateId !== candidateId) throw new BaselineStateError('CORRUPT_STATE', 'Candidate ID does not match its storage key.');
  return { manifest: validated, snapshot: await loadSnapshot(store, validated) };
}

export async function acquireLease(args: {
  store: BaselineStore;
  identityHash: string;
  owner: string;
  now: string;
  ttlSeconds: number;
}): Promise<void> {
  const key = leaseKey(args.identityHash);
  const nowMs = Date.parse(args.now);
  const existing = await args.store.getValue<BaselineLease>(key);
  if (existing && Date.parse(existing.expiresAt) > nowMs) {
    throw new BaselineStateError('CONCURRENCY_CONFLICT', 'Another baseline operation holds the active lease.');
  }
  const lease: BaselineLease = {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    owner: args.owner,
    acquiredAt: args.now,
    expiresAt: new Date(nowMs + Math.min(Math.max(args.ttlSeconds, 60), 3_600) * 1_000).toISOString(),
  };
  await args.store.setValue(key, lease);
  const verified = await args.store.getValue<BaselineLease>(key);
  if (!verified || verified.owner !== args.owner || verified.storageSchemaVersion !== STORAGE_SCHEMA_VERSION) {
    throw new BaselineStateError('CONCURRENCY_CONFLICT', 'Baseline lease ownership could not be verified.');
  }
}

export async function releaseLease(store: BaselineStore, identityHash: string, owner: string): Promise<void> {
  const key = leaseKey(identityHash);
  const lease = await store.getValue<BaselineLease>(key);
  if (lease?.owner === owner) await store.setValue(key, null);
}

export async function writeGeneration(args: {
  store: BaselineStore;
  keyPrefix: string;
  generation: string;
  serialized: string;
  chunkBytes?: number;
}): Promise<{ chunks: SnapshotChunkReference[]; byteLength: number }> {
  const data = Buffer.from(args.serialized, 'utf8');
  const chunkBytes = Math.min(Math.max(args.chunkBytes ?? DEFAULT_CHUNK_BYTES, 65_536), DEFAULT_CHUNK_BYTES);
  const references: SnapshotChunkReference[] = [];
  const chunkCount = Math.max(1, Math.ceil(data.byteLength / chunkBytes));
  if (chunkCount > 32) throw new BaselineStateError('CORRUPT_STATE', 'Snapshot requires too many persistence chunks.');
  for (let index = 0; index < chunkCount; index += 1) {
    const payload = data.subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, data.byteLength));
    const hash = sha256(payload);
    const key = `${args.keyPrefix}-${args.generation}-${String(index).padStart(4, '0')}`;
    const chunk: SnapshotChunk = {
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      generation: args.generation,
      index,
      sha256: hash,
      byteLength: payload.byteLength,
      payloadBase64: payload.toString('base64'),
    };
    await args.store.setValue(key, chunk);
    references.push({ key, sha256: hash, byteLength: payload.byteLength });
  }
  return { chunks: references, byteLength: data.byteLength };
}

export async function commitManifest(args: {
  store: BaselineStore;
  manifestKey: string;
  manifest: BaselineManifest;
  previousManifest: BaselineManifest | null;
  leaseOwner: string;
  identityHash: string;
  now: string;
}): Promise<void> {
  const current = await args.store.getValue<unknown>(args.manifestKey);
  if (current !== null && (!current || typeof current !== 'object' || !('generation' in current)
    || typeof (current as { generation: unknown }).generation !== 'string')) {
    throw new BaselineStateError('CORRUPT_STATE', 'Current baseline manifest is malformed.');
  }
  const currentGeneration = current === null ? null : (current as { generation: string }).generation;
  const expectedGeneration = args.previousManifest?.generation ?? null;
  if (currentGeneration !== expectedGeneration) {
    throw new BaselineStateError('CONCURRENCY_CONFLICT', 'Baseline generation changed before manifest commit.');
  }
  const lease = await args.store.getValue<BaselineLease>(leaseKey(args.identityHash));
  if (!lease || lease.owner !== args.leaseOwner || Date.parse(lease.expiresAt) <= Date.parse(args.now)) {
    throw new BaselineStateError('CONCURRENCY_CONFLICT', 'Baseline lease expired or changed before manifest commit.');
  }
  await args.store.setValue(args.manifestKey, args.manifest);
  const durable = await args.store.getValue<unknown>(args.manifestKey);
  if (!durable || typeof durable !== 'object' || !('generation' in durable)
    || (durable as { generation: unknown }).generation !== args.manifest.generation) {
    throw new BaselineStateError('CONCURRENCY_CONFLICT', 'Baseline manifest durability verification failed.');
  }
  await Promise.allSettled((args.previousManifest?.chunks ?? [])
    .filter((chunk) => !args.manifest.chunks.some((currentChunk) => currentChunk.key === chunk.key))
    .map((chunk) => args.store.setValue(chunk.key, null)));
}

export async function deleteManifestAfterCommit(store: BaselineStore, key: string, manifest: BaselineManifest): Promise<void> {
  await Promise.allSettled([
    store.setValue(key, null),
    ...manifest.chunks.map((chunk) => store.setValue(chunk.key, null)),
  ]);
}

export function validateManifest(value: unknown, kind: BaselineManifest['kind'], identityHash: string): BaselineManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BaselineStateError('CORRUPT_STATE', 'Baseline manifest is not an object.');
  const manifest = value as Record<string, unknown>;
  const baseFields = new Set([
    'kind', 'storageSchemaVersion', 'normalizerVersion', 'targetIdentityHash', 'snapshotHash',
    'generation', 'chunks', 'byteLength', 'createdAt', 'updatedAt',
    ...(kind === 'trusted' ? ['evidenceHistory'] : ['candidateId', 'trustedParentSnapshotHash']),
  ]);
  if (Object.keys(manifest).some((key) => !baseFields.has(key))) throw new BaselineStateError('CORRUPT_STATE', 'Baseline manifest contains unsupported fields.');
  if (manifest.storageSchemaVersion !== STORAGE_SCHEMA_VERSION || manifest.normalizerVersion !== NORMALIZER_VERSION) {
    throw new BaselineStateError('MIGRATION_REQUIRED', 'Baseline schema or normalizer version is incompatible.');
  }
  if (manifest.kind !== kind || manifest.targetIdentityHash !== identityHash || !isHash(manifest.targetIdentityHash)) {
    throw new BaselineStateError('CORRUPT_STATE', 'Baseline manifest identity is invalid.');
  }
  if (!isHash(manifest.snapshotHash) || typeof manifest.generation !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(manifest.generation)) {
    throw new BaselineStateError('CORRUPT_STATE', 'Baseline manifest hash or generation is invalid.');
  }
  if (!isIsoDate(manifest.createdAt) || !isIsoDate(manifest.updatedAt)) throw new BaselineStateError('CORRUPT_STATE', 'Baseline manifest timestamps are invalid.');
  if (!Number.isInteger(manifest.byteLength) || (manifest.byteLength as number) < 2) throw new BaselineStateError('CORRUPT_STATE', 'Baseline byte length is invalid.');
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length < 1 || manifest.chunks.length > 32) {
    throw new BaselineStateError('CORRUPT_STATE', 'Baseline manifest chunk list is invalid.');
  }
  for (const item of manifest.chunks) {
    if (!item || typeof item !== 'object' || Object.keys(item).some((key) => !['key', 'sha256', 'byteLength'].includes(key))
      || typeof item.key !== 'string' || item.key.length > 512 || !isHash(item.sha256)
      || !Number.isInteger(item.byteLength) || item.byteLength < 0) {
      throw new BaselineStateError('CORRUPT_STATE', 'Baseline chunk reference is invalid.');
    }
  }
  if (kind === 'trusted') {
    if (!Array.isArray(manifest.evidenceHistory) || manifest.evidenceHistory.length > 30) {
      throw new BaselineStateError('CORRUPT_STATE', 'Trusted evidence history is invalid.');
    }
    for (const entry of manifest.evidenceHistory) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => !['checkedAt', 'snapshotHash', 'status', 'materialChangeCount'].includes(key))
        || !isIsoDate(entry.checkedAt) || !isHash(entry.snapshotHash) || typeof entry.status !== 'string'
        || entry.status.length > 64 || !Number.isInteger(entry.materialChangeCount) || entry.materialChangeCount < 0) {
        throw new BaselineStateError('CORRUPT_STATE', 'Trusted evidence history entry is invalid.');
      }
    }
  }
  if (kind === 'candidate' && (typeof manifest.candidateId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(manifest.candidateId)
    || !(manifest.trustedParentSnapshotHash === null || isHash(manifest.trustedParentSnapshotHash)))) {
    throw new BaselineStateError('CORRUPT_STATE', 'Candidate lineage is invalid.');
  }
  return manifest as unknown as BaselineManifest;
}

async function loadSnapshot(store: BaselineStore, manifest: BaselineManifest): Promise<SnapshotPayload> {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for (const [index, reference] of manifest.chunks.entries()) {
    const chunk = await store.getValue<SnapshotChunk>(reference.key);
    if (!chunk || chunk.storageSchemaVersion !== STORAGE_SCHEMA_VERSION || chunk.generation !== manifest.generation
      || chunk.index !== index || chunk.sha256 !== reference.sha256 || chunk.byteLength !== reference.byteLength) {
      throw new BaselineStateError('CORRUPT_STATE', `Baseline chunk is missing or incompatible: ${reference.key}`);
    }
    const payload = Buffer.from(chunk.payloadBase64, 'base64');
    if (payload.byteLength !== reference.byteLength || sha256(payload) !== reference.sha256) {
      throw new BaselineStateError('CORRUPT_STATE', `Baseline chunk integrity check failed: ${reference.key}`);
    }
    bytes += payload.byteLength;
    buffers.push(payload);
  }
  if (bytes !== manifest.byteLength) throw new BaselineStateError('CORRUPT_STATE', 'Baseline byte length does not match its manifest.');
  const serialized = Buffer.concat(buffers, bytes).toString('utf8');
  if (sha256(serialized) !== manifest.snapshotHash) throw new BaselineStateError('CORRUPT_STATE', 'Baseline snapshot hash check failed.');
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(serialized);
  } catch {
    throw new BaselineStateError('CORRUPT_STATE', 'Baseline snapshot JSON is invalid.');
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || canonicalStringify(snapshot) !== serialized) {
    throw new BaselineStateError('CORRUPT_STATE', 'Baseline snapshot is not canonical.');
  }
  return snapshot as SnapshotPayload;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
