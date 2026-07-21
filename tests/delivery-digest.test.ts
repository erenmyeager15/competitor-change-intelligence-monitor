import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDigest, buildWebhookPayload, deliveryId, digestMarkdown, filterDigestBySeverity } from '../src/delivery/digest.js';
import type { ClassifiedChange, TargetReport } from '../src/types.js';

function change(index: number, severity: ClassifiedChange['severity'] = 'medium'): ClassifiedChange {
  return {
    changeId: `change-${String(index).padStart(3, '0')}`,
    category: 'price',
    field: `price-${index}`,
    previousValue: '$10',
    currentValue: '$12',
    delta: 2,
    deltaPercent: 20,
    severity,
    confidenceScore: 90,
    confidence: 'high',
    explanation: `Price changed. Contact owner${index}@example.com or +1 (202) 555-01${String(index % 100).padStart(2, '0')}.`,
    recommendedAction: 'Review token=super-secret-value before changing the price.',
    evidence: {
      previousExcerpt: 'Old API key: sk_test_12345678901234567890',
      currentExcerpt: 'New price is $12.',
      sources: ['normalized:price'],
    },
  };
}

function report(changes: ClassifiedChange[]): TargetReport {
  return {
    targetName: 'Northstar owner@example.com',
    targetUrl: 'https://example.com/pricing?token=hidden',
    finalUrl: 'https://example.com/pricing?token=hidden',
    status: 'success_changed',
    reachable: true,
    robotsAllowed: true,
    baselineFound: true,
    baselineAction: 'compare_only',
    baselineUpdated: false,
    candidateStored: false,
    candidateId: null,
    previousSnapshotHash: 'a'.repeat(64),
    currentSnapshotHash: 'b'.repeat(64),
    changeDetected: true,
    materialChangeCount: changes.length,
    overallSeverity: 'high',
    overallConfidence: 90,
    summary: 'Material changes detected.',
    recommendedAction: 'Review changes.',
    changes,
    inspection: { httpStatus: 200, contentType: 'text/html', responseBytes: 100, latencyMs: 10, redirectOrigins: [] },
    checkedAt: '2026-07-21T10:00:00.000Z',
    persistence: { succeeded: true },
  };
}

test('digest deduplicates, sorts, redacts, and bounds material changes', () => {
  const changes = Array.from({ length: 120 }, (_, index) => change(index, index === 119 ? 'critical' : 'medium'));
  changes.push(changes[0]!);
  const digest = buildDigest([report(changes)], '2026-07-21T10:00:00Z', 'https://console.apify.com/runs/abc?token=secret#output');
  assert.equal(digest.changes.length, 100);
  assert.equal(digest.changeCount, 100);
  assert.equal(digest.changes[0]?.changeId, 'change-119');
  assert.equal(digest.runUrl, 'https://console.apify.com/runs/abc');
  const serialized = JSON.stringify(digest);
  assert.doesNotMatch(serialized, /owner\d*@example\.com|super-secret|sk_test_|202\) 555/);
  assert.match(serialized, /REDACTED/);
});

test('webhook payload is deterministic and limited to ten changes', () => {
  const digest = buildDigest([report(Array.from({ length: 15 }, (_, index) => change(index)))], '2026-07-21T10:00:00Z');
  const id = deliveryId({ changes: digest.changes.map((item) => item.changeId) });
  assert.equal(id, deliveryId({ changes: digest.changes.map((item) => item.changeId) }));
  const payload = buildWebhookPayload({
    mode: 'immediate', generatedAt: digest.generatedAt, deliveryId: id, changes: digest.changes,
  });
  assert.equal(payload.totalEligibleChanges, 15);
  assert.equal(payload.changes.length, 10);
  assert.equal(filterDigestBySeverity(digest, 'high').length, 0);
});

test('Markdown digest is bounded and contains no raw contact or secret values', () => {
  const digest = buildDigest([report([change(1, 'high')])], '2026-07-21T10:00:00Z');
  const markdown = digestMarkdown(digest);
  assert.ok(Buffer.byteLength(markdown) <= 50_000);
  assert.doesNotMatch(markdown, /owner1@example\.com|super-secret|sk_test_|202\) 555/);
  assert.match(markdown, /Competitor Change Intelligence Digest/);
});
