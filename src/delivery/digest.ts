import { sha256 } from '../baseline/canonical.js';
import { redactText, redactUrl } from '../security/redaction.js';
import type { Severity, TargetReport } from '../types.js';
import { severityRank } from '../intelligence/classify.js';
import {
  DELIVERY_SCHEMA_VERSION,
  MAX_DIGEST_CHANGES,
  MAX_WEBHOOK_CHANGES,
  type DigestChange,
  type DigestDocument,
  type WebhookPayload,
} from './types.js';

export function buildDigest(reports: TargetReport[], generatedAt: string, runUrl?: string | null): DigestDocument {
  const changes = deduplicateChanges(reports.flatMap((report) => report.changes.map((change): DigestChange => ({
    changeId: change.changeId,
    targetName: redactText(report.targetName, 100),
    targetUrl: redactUrl(report.targetUrl),
    category: change.category,
    field: redactText(change.field, 256),
    severity: change.severity,
    confidenceScore: change.confidenceScore,
    confidence: change.confidence,
    explanation: redactText(change.explanation, 300),
    recommendedAction: redactText(change.recommendedAction, 300),
    previousExcerpt: change.evidence.previousExcerpt ? redactText(change.evidence.previousExcerpt, 240) : null,
    currentExcerpt: change.evidence.currentExcerpt ? redactText(change.evidence.currentExcerpt, 240) : null,
  }))));
  return {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    generatedAt: isoDate(generatedAt),
    runUrl: safeRunUrl(runUrl),
    reportCount: reports.length,
    changedTargetCount: new Set(changes.map((change) => change.targetUrl)).size,
    changeCount: changes.length,
    changes,
  };
}

export function filterDigestBySeverity(digest: DigestDocument, minimum: Severity): DigestChange[] {
  return digest.changes.filter((change) => severityRank(change.severity) >= severityRank(minimum));
}

export function buildWebhookPayload(args: {
  mode: WebhookPayload['mode'];
  generatedAt: string;
  runUrl?: string | null;
  deliveryId: string;
  changes: DigestChange[];
}): WebhookPayload {
  const changes = deduplicateChanges(args.changes);
  return {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    deliveryId: redactText(args.deliveryId, 128),
    mode: args.mode,
    generatedAt: isoDate(args.generatedAt),
    runUrl: safeRunUrl(args.runUrl),
    totalEligibleChanges: changes.length,
    changes: changes.slice(0, MAX_WEBHOOK_CHANGES),
  };
}

export function digestMarkdown(digest: DigestDocument): string {
  const lines = [
    '# Competitor Change Intelligence Digest',
    '',
    `Generated: ${digest.generatedAt}`,
    `Reports: ${digest.reportCount}`,
    `Material changes: ${digest.changeCount}`,
    '',
  ];
  if (digest.changeCount === 0) lines.push('No material changes met the selected threshold.');
  for (const [index, change] of digest.changes.slice(0, 50).entries()) {
    lines.push(
      `## ${index + 1}. ${escapeMarkdown(change.targetName)} - ${escapeMarkdown(change.severity)}`,
      '',
      `- Category: ${escapeMarkdown(change.category)}`,
      `- Field: ${escapeMarkdown(change.field)}`,
      `- Confidence: ${change.confidenceScore}/100 (${change.confidence})`,
      `- Change: ${escapeMarkdown(change.explanation)}`,
      `- Review: ${escapeMarkdown(change.recommendedAction)}`,
      `- Source: ${change.targetUrl}`,
      '',
    );
  }
  if (digest.runUrl) lines.push(`Run: ${digest.runUrl}`, '');
  return redactText(lines.join('\n').slice(0, 50_000), 50_000);
}

export function deliveryId(parts: unknown): string {
  return sha256(JSON.stringify(parts));
}

function deduplicateChanges(changes: DigestChange[]): DigestChange[] {
  const result = new Map<string, DigestChange>();
  for (const change of changes) if (!result.has(change.changeId)) result.set(change.changeId, change);
  return [...result.values()]
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity)
      || right.confidenceScore - left.confidenceScore
      || left.targetName.localeCompare(right.targetName)
      || left.field.localeCompare(right.field))
    .slice(0, MAX_DIGEST_CHANGES);
}

function safeRunUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return redactUrl(url.toString());
  } catch {
    return null;
  }
}

function isoDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Digest timestamp must be a valid date-time.');
  return new Date(parsed).toISOString();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, '\\$&');
}
