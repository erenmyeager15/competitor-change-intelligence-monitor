import type { BaselineAction, ReportStatus, TargetInput } from '../types.js';

export const STORAGE_SCHEMA_VERSION = 1 as const;
export const NORMALIZER_VERSION = '1.0.0';
export const MAX_HISTORY_ENTRIES = 30;
export const DEFAULT_CHUNK_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type SnapshotPayload = Record<string, unknown>;

export interface SnapshotChunkReference {
  key: string;
  sha256: string;
  byteLength: number;
}

export interface SnapshotChunk {
  storageSchemaVersion: typeof STORAGE_SCHEMA_VERSION;
  generation: string;
  index: number;
  sha256: string;
  byteLength: number;
  payloadBase64: string;
}

export interface EvidenceHistoryEntry {
  checkedAt: string;
  snapshotHash: string;
  status: string;
  materialChangeCount: number;
}

interface ManifestBase {
  storageSchemaVersion: typeof STORAGE_SCHEMA_VERSION;
  normalizerVersion: string;
  targetIdentityHash: string;
  snapshotHash: string;
  generation: string;
  chunks: SnapshotChunkReference[];
  byteLength: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrustedBaselineManifest extends ManifestBase {
  kind: 'trusted';
  evidenceHistory: EvidenceHistoryEntry[];
}

export interface CandidateBaselineManifest extends ManifestBase {
  kind: 'candidate';
  candidateId: string;
  trustedParentSnapshotHash: string | null;
}

export type BaselineManifest = TrustedBaselineManifest | CandidateBaselineManifest;

export interface BaselineLease {
  storageSchemaVersion: typeof STORAGE_SCHEMA_VERSION;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface BaselineStore {
  getValue<T>(key: string): Promise<T | null>;
  setValue(key: string, value: unknown | null): Promise<void>;
}

export interface BaselineOperationDependencies {
  now?: () => string;
  createId?: () => string;
}

export interface BaselineOperationInput {
  store: BaselineStore;
  target: TargetInput;
  snapshot: SnapshotPayload;
  action: BaselineAction;
  candidateId?: string;
  expectedCandidateHash?: string;
  expectedTrustedParentHash?: string;
  materialChangeCount?: number;
  leaseTtlSeconds?: number;
  chunkBytes?: number;
  dependencies?: BaselineOperationDependencies;
}

export interface BaselineOperationResult {
  status: Extract<ReportStatus,
    | 'success_no_change'
    | 'success_changed'
    | 'baseline_missing'
    | 'baseline_initialized'
    | 'candidate_stored'
    | 'candidate_promoted'
    | 'promotion_mismatch'
    | 'concurrency_conflict'
    | 'internal_error'>;
  action: BaselineAction;
  targetIdentityHash: string;
  baselineFound: boolean;
  baselineUpdated: boolean;
  candidateStored: boolean;
  candidateId: string | null;
  previousSnapshotHash: string | null;
  currentSnapshotHash: string;
  previousTrustedSnapshot: SnapshotPayload | null;
  trustedSnapshot: SnapshotPayload | null;
  persistence: { succeeded: boolean; error?: string };
}
