import { createHash } from 'node:crypto';
import { redactText, redactUrl } from '../security/redaction.js';
import { validatePublicHttpsUrl } from '../security/target.js';
import type { TargetInput } from '../types.js';
import {
  MAX_SNAPSHOT_BYTES,
  NORMALIZER_VERSION,
  STORAGE_SCHEMA_VERSION,
  type SnapshotPayload,
} from './types.js';

const RAW_DOCUMENT_KEY = /^(?:raw[-_]?html|html|body|response[-_]?body|headers?|cookies?)$/i;
const SENSITIVE_KEY = /authorization|cookie|token|secret|api[-_]?key|password|credential|session|signature|^sig$|^key$|webhook/i;
const RAW_HTML = /<!doctype\s+html|<html(?:\s|>)/i;

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value, '', 0, { nodes: 0 }));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function prepareSnapshot(value: SnapshotPayload): { snapshot: SnapshotPayload; serialized: string; hash: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotValidationError('Snapshot must be a plain object.');
  }
  const snapshot = canonicalValue(value, '', 0, { nodes: 0 }) as SnapshotPayload;
  const serialized = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotValidationError(`Snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte persistence limit.`);
  }
  return { snapshot, serialized, hash: sha256(serialized) };
}

export function targetIdentity(target: TargetInput): { identity: Record<string, unknown>; hash: string } {
  const url = validatePublicHttpsUrl(target.url);
  url.searchParams.sort();
  const identity = {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    targetUrl: redactUrl(url.toString()),
    targetName: target.name.normalize('NFC').trim(),
    changeTypes: [...target.changeTypes],
    includeSelectors: [...(target.includeSelectors ?? [])],
    excludeSelectors: [...(target.excludeSelectors ?? [])],
    ignoreTextPatterns: [...(target.ignoreTextPatterns ?? [])],
  };
  return { identity, hash: sha256(canonicalStringify(identity)) };
}

function canonicalValue(value: unknown, key: string, depth: number, state: { nodes: number }): unknown {
  state.nodes += 1;
  if (state.nodes > 10_000) throw new SnapshotValidationError('Snapshot contains too many values.');
  if (depth > 12) throw new SnapshotValidationError('Snapshot exceeds the maximum nesting depth.');
  if (RAW_DOCUMENT_KEY.test(key)) throw new SnapshotValidationError(`Snapshot field '${key}' may contain raw response data and is prohibited.`);
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value === null) return null;
  if (typeof value === 'string') {
    if (RAW_HTML.test(value)) throw new SnapshotValidationError('Raw HTML documents are prohibited in baseline storage.');
    return redactText(value, 50_000);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SnapshotValidationError('Snapshot numbers must be finite.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new SnapshotValidationError('Snapshot arrays may contain at most 1000 entries.');
    return value.map((entry) => canonicalValue(entry, key, depth + 1, state));
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new SnapshotValidationError(`Snapshot contains unsupported ${typeof value} data.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new SnapshotValidationError('Snapshot values must be plain JSON objects.');
  const result: Record<string, unknown> = {};
  for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) continue;
    result[childKey] = canonicalValue((value as Record<string, unknown>)[childKey], childKey, depth + 1, state);
  }
  return result;
}
