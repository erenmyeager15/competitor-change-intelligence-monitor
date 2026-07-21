import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PAGE_CHECKED_EVENT, assessCost, isBillableReport } from '../src/billing.js';
import type { TargetReport } from '../src/types.js';

function report(status: TargetReport['status'], persisted = true): TargetReport {
  return {
    targetName: 'Demo', targetUrl: 'https://example.com/', finalUrl: 'https://example.com/', status,
    reachable: true, robotsAllowed: true, baselineFound: true, baselineAction: 'compare_only',
    baselineUpdated: false, candidateStored: false, candidateId: null, previousSnapshotHash: null,
    currentSnapshotHash: 'a'.repeat(64), changeDetected: false, materialChangeCount: 0,
    overallSeverity: 'informational', overallConfidence: 100, summary: 'Done.', recommendedAction: 'None.',
    changes: [], inspection: { httpStatus: 200, contentType: 'text/html', responseBytes: 10, latencyMs: 1, redirectOrigins: [] },
    checkedAt: '2026-07-21T10:00:00.000Z', persistence: { succeeded: persisted },
  };
}

test('only successful persisted non-dry reports are billable', () => {
  for (const status of ['success_no_change', 'success_changed', 'baseline_missing', 'baseline_initialized', 'candidate_stored', 'candidate_promoted'] as const) {
    assert.equal(isBillableReport(report(status), false), true, status);
  }
  assert.equal(isBillableReport(report('blocked_target'), false), false);
  assert.equal(isBillableReport(report('success_changed', false), false), false);
  assert.equal(isBillableReport(report('success_changed'), true), false);
});

test('cost assessment never invents measured cloud cost or margin', () => {
  assert.deepEqual(assessCost(10), {
    chargedPages: 10, revenueUsd: 0.03, platformCostUsd: null, profitUsd: null, marginPercent: null, measured: false,
  });
  assert.deepEqual(assessCost(10, 0.006), {
    chargedPages: 10, revenueUsd: 0.03, platformCostUsd: 0.006, profitUsd: 0.024, marginPercent: 80, measured: true,
  });
});

test('entrypoint uses atomic pushData event billing and never separate Actor.charge', async () => {
  const main = await readFile('src/main.ts', 'utf8');
  assert.equal(PAGE_CHECKED_EVENT, 'page-checked');
  assert.match(main, /Actor\.pushData\(\{ \.\.\.report \}, eventName\)/);
  assert.doesNotMatch(main, /Actor\.charge\s*\(/);
});
