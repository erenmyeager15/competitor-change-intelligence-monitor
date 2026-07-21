import type { ReportStatus, TargetReport } from './types.js';

export const PAGE_CHECKED_EVENT = 'page-checked';
export const RECOMMENDED_PAGE_CHECKED_PRICE_USD = 0.003;

const BILLABLE_STATUSES = new Set<ReportStatus>([
  'success_no_change',
  'success_changed',
  'baseline_missing',
  'baseline_initialized',
  'candidate_stored',
  'candidate_promoted',
]);

export interface CostAssessment {
  chargedPages: number;
  revenueUsd: number;
  platformCostUsd: number | null;
  profitUsd: number | null;
  marginPercent: number | null;
  measured: boolean;
}

export function isBillableReport(report: TargetReport, dryRun: boolean): boolean {
  return !dryRun && report.persistence.succeeded && BILLABLE_STATUSES.has(report.status);
}

export function assessCost(chargedPages: number, platformCostUsd?: number): CostAssessment {
  const pages = Number.isFinite(chargedPages) ? Math.max(0, Math.floor(chargedPages)) : 0;
  const revenueUsd = round(pages * RECOMMENDED_PAGE_CHECKED_PRICE_USD);
  if (platformCostUsd === undefined || !Number.isFinite(platformCostUsd) || platformCostUsd < 0) {
    return { chargedPages: pages, revenueUsd, platformCostUsd: null, profitUsd: null, marginPercent: null, measured: false };
  }
  const cost = round(platformCostUsd);
  const profit = round(revenueUsd - cost);
  const margin = revenueUsd === 0 ? null : round((profit / revenueUsd) * 100);
  return { chargedPages: pages, revenueUsd, platformCostUsd: cost, profitUsd: profit, marginPercent: margin, measured: true };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
