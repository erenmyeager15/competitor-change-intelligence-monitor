import { randomUUID } from 'node:crypto';
import { redactText } from '../security/redaction.js';
import type { ReportStatus } from '../types.js';
import { prepareSnapshot, sha256, SnapshotValidationError, targetIdentity } from './canonical.js';
import {
  acquireLease,
  BaselineStateError,
  candidateManifestKey,
  commitManifest,
  deleteManifestAfterCommit,
  loadCandidate,
  loadTrusted,
  releaseLease,
  trustedManifestKey,
  writeGeneration,
} from './persistence.js';
import {
  MAX_HISTORY_ENTRIES,
  NORMALIZER_VERSION,
  STORAGE_SCHEMA_VERSION,
  type BaselineOperationInput,
  type BaselineOperationResult,
  type CandidateBaselineManifest,
  type EvidenceHistoryEntry,
  type SnapshotPayload,
  type TrustedBaselineManifest,
} from './types.js';

export async function applyBaselineAction(input: BaselineOperationInput): Promise<BaselineOperationResult> {
  const identity = targetIdentity(input.target);
  let prepared: ReturnType<typeof prepareSnapshot>;
  try {
    prepared = prepareSnapshot(input.snapshot);
  } catch (error) {
    return failureResult(input, identity.hash, '', 'internal_error', error);
  }

  if (input.action === 'compare_only') {
    try {
      const trusted = await loadTrusted(input.store, identity.hash);
      if (!trusted) return result(input, identity.hash, prepared.hash, 'baseline_missing', null, null);
      const status = trusted.manifest.snapshotHash === prepared.hash ? 'success_no_change' : 'success_changed';
      return result(input, identity.hash, prepared.hash, status, trusted, null);
    } catch (error) {
      return failureResult(input, identity.hash, prepared.hash, 'internal_error', error);
    }
  }

  const now = validNow(input.dependencies?.now?.() ?? new Date().toISOString());
  const createId = input.dependencies?.createId ?? randomUUID;
  const owner = cleanId(createId());
  try {
    await acquireLease({
      store: input.store,
      identityHash: identity.hash,
      owner,
      now,
      ttlSeconds: input.leaseTtlSeconds ?? 300,
    });
  } catch (error) {
    return failureResult(input, identity.hash, prepared.hash, mapFailure(error), error);
  }

  try {
    if (input.action === 'initialize_trusted') {
      const trusted = await loadTrusted(input.store, identity.hash);
      if (trusted) {
        const status = trusted.manifest.snapshotHash === prepared.hash ? 'success_no_change' : 'success_changed';
        return result(input, identity.hash, prepared.hash, status, trusted, null);
      }
      const manifest = await buildTrustedManifest({
        input,
        identityHash: identity.hash,
        prepared,
        generation: cleanId(createId()),
        now,
        previous: null,
        historyStatus: 'baseline_initialized',
      });
      await commitManifest({
        store: input.store,
        manifestKey: trustedManifestKey(identity.hash),
        manifest,
        previousManifest: null,
        leaseOwner: owner,
        identityHash: identity.hash,
        now,
      });
      return result(input, identity.hash, prepared.hash, 'baseline_initialized', null, null, true, false, prepared.snapshot);
    }

    if (input.action === 'store_candidate') {
      const trusted = await loadTrusted(input.store, identity.hash);
      const candidateId = createCandidateId(now, createId());
      const key = candidateManifestKey(identity.hash, candidateId);
      if (await input.store.getValue(key) !== null) {
        throw new BaselineStateError('CONCURRENCY_CONFLICT', 'Generated candidate ID already exists.');
      }
      const generation = cleanId(createId());
      const written = await writeGeneration({
        store: input.store,
        keyPrefix: `candidate-baseline-v1-chunk-${identity.hash}-${sha256(candidateId).slice(0, 24)}`,
        generation,
        serialized: prepared.serialized,
        chunkBytes: input.chunkBytes,
      });
      const manifest: CandidateBaselineManifest = {
        kind: 'candidate',
        storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        normalizerVersion: NORMALIZER_VERSION,
        candidateId,
        targetIdentityHash: identity.hash,
        snapshotHash: prepared.hash,
        trustedParentSnapshotHash: trusted?.manifest.snapshotHash ?? null,
        generation,
        chunks: written.chunks,
        byteLength: written.byteLength,
        createdAt: now,
        updatedAt: now,
      };
      await commitManifest({
        store: input.store,
        manifestKey: key,
        manifest,
        previousManifest: null,
        leaseOwner: owner,
        identityHash: identity.hash,
        now,
      });
      return result(input, identity.hash, prepared.hash, 'candidate_stored', trusted, candidateId, false, true);
    }

    const mismatch = promotionInputMismatch(input);
    if (mismatch) return failureResult(input, identity.hash, prepared.hash, 'promotion_mismatch', new Error(mismatch), true);
    const candidateId = input.candidateId!;
    const candidate = await loadCandidate(input.store, identity.hash, candidateId);
    const trusted = await loadTrusted(input.store, identity.hash);
    const trustedParent = trusted?.manifest.snapshotHash ?? null;
    const expectedParent = input.expectedTrustedParentHash === 'NO_PARENT' ? null : input.expectedTrustedParentHash!;
    if (!candidate
      || candidate.manifest.snapshotHash !== input.expectedCandidateHash
      || candidate.manifest.trustedParentSnapshotHash !== expectedParent
      || trustedParent !== expectedParent) {
      return failureResult(input, identity.hash, prepared.hash, 'promotion_mismatch', new Error('Candidate hash or trusted-parent lineage does not match.'), true, trusted);
    }
    const promotedPrepared = prepareSnapshot(candidate.snapshot);
    const manifest = await buildTrustedManifest({
      input,
      identityHash: identity.hash,
      prepared: promotedPrepared,
      generation: cleanId(createId()),
      now,
      previous: trusted?.manifest ?? null,
      historyStatus: 'candidate_promoted',
    });
    await commitManifest({
      store: input.store,
      manifestKey: trustedManifestKey(identity.hash),
      manifest,
      previousManifest: trusted?.manifest ?? null,
      leaseOwner: owner,
      identityHash: identity.hash,
      now,
    });
    await deleteManifestAfterCommit(input.store, candidateManifestKey(identity.hash, candidateId), candidate.manifest);
    return result(input, identity.hash, promotedPrepared.hash, 'candidate_promoted', trusted, candidateId, true, false, promotedPrepared.snapshot);
  } catch (error) {
    return failureResult(input, identity.hash, prepared.hash, mapFailure(error), error);
  } finally {
    await releaseLease(input.store, identity.hash, owner).catch(() => undefined);
  }
}

async function buildTrustedManifest(args: {
  input: BaselineOperationInput;
  identityHash: string;
  prepared: ReturnType<typeof prepareSnapshot>;
  generation: string;
  now: string;
  previous: TrustedBaselineManifest | null;
  historyStatus: string;
}): Promise<TrustedBaselineManifest> {
  const written = await writeGeneration({
    store: args.input.store,
    keyPrefix: `trusted-baseline-v1-chunk-${args.identityHash}`,
    generation: args.generation,
    serialized: args.prepared.serialized,
    chunkBytes: args.input.chunkBytes,
  });
  const historyEntry: EvidenceHistoryEntry = {
    checkedAt: args.now,
    snapshotHash: args.prepared.hash,
    status: redactText(args.historyStatus, 64),
    materialChangeCount: Number.isFinite(args.input.materialChangeCount)
      ? Math.min(Math.max(Math.floor(args.input.materialChangeCount ?? 0), 0), 100_000)
      : 0,
  };
  return {
    kind: 'trusted',
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    targetIdentityHash: args.identityHash,
    snapshotHash: args.prepared.hash,
    generation: args.generation,
    chunks: written.chunks,
    byteLength: written.byteLength,
    createdAt: args.previous?.createdAt ?? args.now,
    updatedAt: args.now,
    evidenceHistory: [...(args.previous?.evidenceHistory ?? []), historyEntry].slice(-MAX_HISTORY_ENTRIES),
  };
}

function result(
  input: BaselineOperationInput,
  identityHash: string,
  currentHash: string,
  status: BaselineOperationResult['status'],
  trusted: { manifest: TrustedBaselineManifest; snapshot: SnapshotPayload } | null,
  candidateId: string | null,
  baselineUpdated = false,
  candidateStored = false,
  persistedTrustedSnapshot?: SnapshotPayload,
): BaselineOperationResult {
  return {
    status,
    action: input.action,
    targetIdentityHash: identityHash,
    baselineFound: Boolean(trusted),
    baselineUpdated,
    candidateStored,
    candidateId,
    previousSnapshotHash: trusted?.manifest.snapshotHash ?? null,
    currentSnapshotHash: currentHash,
    previousTrustedSnapshot: trusted?.snapshot ?? null,
    trustedSnapshot: persistedTrustedSnapshot ?? trusted?.snapshot ?? null,
    persistence: { succeeded: true },
  };
}

function failureResult(
  input: BaselineOperationInput,
  identityHash: string,
  currentHash: string,
  status: Extract<ReportStatus, 'promotion_mismatch' | 'concurrency_conflict' | 'internal_error'>,
  error: unknown,
  persistenceSucceeded = false,
  trusted: { manifest: TrustedBaselineManifest; snapshot: SnapshotPayload } | null = null,
): BaselineOperationResult {
  return {
    status,
    action: input.action,
    targetIdentityHash: identityHash,
    baselineFound: Boolean(trusted),
    baselineUpdated: false,
    candidateStored: false,
    candidateId: input.candidateId ?? null,
    previousSnapshotHash: trusted?.manifest.snapshotHash ?? null,
    currentSnapshotHash: currentHash,
    previousTrustedSnapshot: trusted?.snapshot ?? null,
    trustedSnapshot: trusted?.snapshot ?? null,
    persistence: { succeeded: persistenceSucceeded, error: redactText((error as Error).message || 'Baseline operation failed.', 500) },
  };
}

function mapFailure(error: unknown): Extract<ReportStatus, 'promotion_mismatch' | 'concurrency_conflict' | 'internal_error'> {
  if (error instanceof BaselineStateError && error.code === 'CONCURRENCY_CONFLICT') return 'concurrency_conflict';
  if (error instanceof SnapshotValidationError) return 'internal_error';
  return 'internal_error';
}

function promotionInputMismatch(input: BaselineOperationInput): string | null {
  if (!input.candidateId || !/^[A-Za-z0-9_-]{1,128}$/.test(input.candidateId)) return 'Promotion requires a valid candidateId.';
  if (!input.expectedCandidateHash || !/^[a-f0-9]{64}$/.test(input.expectedCandidateHash)) return 'Promotion requires an exact candidate SHA-256 hash.';
  if (!input.expectedTrustedParentHash || !(input.expectedTrustedParentHash === 'NO_PARENT' || /^[a-f0-9]{64}$/.test(input.expectedTrustedParentHash))) {
    return 'Promotion requires an exact trusted-parent hash or NO_PARENT.';
  }
  return null;
}

function createCandidateId(now: string, id: string): string {
  return `candidate-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${cleanId(id).slice(0, 24)}`;
}

function cleanId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || randomUUID().replace(/-/g, '');
}

function validNow(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Baseline clock returned an invalid timestamp.');
  return new Date(time).toISOString();
}
