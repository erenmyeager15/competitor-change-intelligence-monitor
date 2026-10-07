import type { TargetReport } from './types.js';

function cell(value: unknown): string {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Spreadsheet exports must not execute source-controlled formulas.
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One row per change, plus one diagnostic row for unchanged/blocked/missing-baseline targets. */
export function reviewCsv(reports: TargetReport[]): string {
  const rows: unknown[][] = [['target', 'url', 'status', 'checkedAt', 'category', 'field', 'previousValue',
    'currentValue', 'deltaPercent', 'severity', 'confidence', 'recommendedAction']];
  for (const report of reports) {
    if (!report.changes.length) {
      rows.push([report.targetName, report.targetUrl, report.status, report.checkedAt, '', '', '', '', '',
        report.overallSeverity, report.overallConfidence, report.recommendedAction]);
    }
    for (const change of report.changes) {
      rows.push([report.targetName, report.targetUrl, report.status, report.checkedAt, change.category, change.field,
        change.previousValue, change.currentValue, change.deltaPercent, change.severity, change.confidenceScore,
        change.recommendedAction]);
    }
  }
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
