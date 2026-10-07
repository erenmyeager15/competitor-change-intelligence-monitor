import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PAGE_CHECKED_EVENT, assessCost, isBillableReport, normalizeSingleReportCharge, validateEventPrice } from '../src/billing.js';
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
    chargedPages: 10, revenueUsd: 0.024, grossRevenueUsd: 0.03, estimatedPlatformShare: 0.2, platformCostUsd: null, profitUsd: null, marginPercent: null, measured: false,
  });
  assert.deepEqual(assessCost(10, 0.006), {
    chargedPages: 10, revenueUsd: 0.024, grossRevenueUsd: 0.03, estimatedPlatformShare: 0.2, platformCostUsd: 0.006, profitUsd: 0.018, marginPercent: 75, measured: true,
  });
});

test('single-report charge normalization removes SDK dataset bookkeeping counts', () => {
  const base = { chargeableWithinLimit: { 'page-checked': 10 } };
  assert.equal(normalizeSingleReportCharge({ ...base, chargedCount: 2, eventChargeLimitReached: false }).chargedCount, 1);
  assert.equal(normalizeSingleReportCharge({ ...base, chargedCount: 1, eventChargeLimitReached: true }).chargedCount, 1);
  assert.equal(normalizeSingleReportCharge({ ...base, chargedCount: 0, eventChargeLimitReached: false }).chargedCount, 0);
  assert.equal(normalizeSingleReportCharge({ ...base, chargedCount: 0, eventChargeLimitReached: true }).chargedCount, 0);
});

test('entrypoint uses atomic pushData event billing and never separate Actor.charge', async () => {
  const main = await readFile('src/main.ts', 'utf8');
  assert.equal(PAGE_CHECKED_EVENT, 'page-checked');
  assert.match(main, /Actor\.pushData\(\{ \.\.\.report \}, eventName\)/);
  assert.match(main, /validateEventPrice\(pricing.isPayPerEvent, pricing.perEventPrices\[PAGE_CHECKED_EVENT\]\)/);
  assert.match(main, /normalizeSingleReportCharge\(charge\)/);
  assert.doesNotMatch(main, /Actor\.charge\s*\(/);
});

test('discounted and zero event prices remain valid; absent or corrupt pricing fails clearly', () => {
  for (const price of [0, 0.0015, 0.003, 0.005]) assert.doesNotThrow(() => validateEventPrice(true, price));
  for (const price of [undefined, NaN, Infinity, -1, '0.003']) assert.throws(() => validateEventPrice(true, price));
  assert.doesNotThrow(() => validateEventPrice(false, undefined));
  assert.equal(assessCost(10, 0.006, 0.0015).marginPercent, 50);
  assert.equal(assessCost(10, 0, 0).marginPercent, null);
});
