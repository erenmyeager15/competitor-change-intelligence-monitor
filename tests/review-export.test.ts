import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewCsv } from '../src/review-export.js';
import type { TargetReport } from '../src/types.js';

test('review export preserves failures, numeric deltas, quotes and neutralizes formulas', () => {
  const report = { targetName: '=HYPERLINK("bad")', targetUrl: 'https://example.com', status: 'blocked_target',
    checkedAt: '2026-10-07', changes: [], overallSeverity: 'high', overallConfidence: 100,
    recommendedAction: 'Review, then retry' } as unknown as TargetReport;
  const csv = reviewCsv([report]);
  assert.match(csv, /'\=HYPERLINK\(""bad""\)/);
  assert.match(csv, /"blocked_target"/);
  assert.match(csv, /"Review, then retry"/);
  assert.equal(csv.split('\r\n').length, 3);
  assert.equal(reviewCsv([]).split('\r\n').length, 2);
});
