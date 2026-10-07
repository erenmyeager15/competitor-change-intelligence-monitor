import type { ReportStatus, TargetReport } from './types.js';

export const PAGE_CHECKED_EVENT = 'page-checked';
export const RECOMMENDED_PAGE_CHECKED_PRICE_USD = 0.003;

export function validateEventPrice(isPayPerEvent: boolean, price: unknown): void {
  if (isPayPerEvent && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) {
    throw new Error(`PPE pricing must configure '${PAGE_CHECKED_EVENT}' with a valid non-negative price.`);
  }
}

interface AtomicPushChargeResult {
  chargedCount: number;
  eventChargeLimitReached: boolean;
  chargeableWithinLimit: Record<string, number>;
}

export function normalizeSingleReportCharge<T extends AtomicPushChargeResult>(charge: T): T {
  return {
    ...charge,
    chargedCount: charge.chargedCount < 1 ? 0 : 1,
  };
}

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
  grossRevenueUsd: number;
  estimatedPlatformShare: number;
  platformCostUsd: number | null;
  profitUsd: number | null;
  marginPercent: number | null;
  measured: boolean;
}

export function isBillableReport(report: TargetReport, dryRun: boolean): boolean {
  return !dryRun && report.persistence.succeeded && BILLABLE_STATUSES.has(report.status);
}

export function assessCost(chargedPages: number, platformCostUsd?: number, eventPrice = RECOMMENDED_PAGE_CHECKED_PRICE_USD, platformShare = 0.2): CostAssessment {
  validateEventPrice(true, eventPrice);
  if (!Number.isFinite(platformShare) || platformShare < 0 || platformShare > 1) throw new Error('Invalid platform share.');
  const pages = Number.isFinite(chargedPages) ? Math.max(0, Math.floor(chargedPages)) : 0;
  const grossRevenueUsd = round(pages * eventPrice);
  const revenueUsd = round(grossRevenueUsd * (1 - platformShare));
  const estimates = { grossRevenueUsd, estimatedPlatformShare: platformShare };
  if (platformCostUsd === undefined || !Number.isFinite(platformCostUsd) || platformCostUsd < 0) {
    return { chargedPages: pages, revenueUsd, ...estimates, platformCostUsd: null, profitUsd: null, marginPercent: null, measured: false };
  }
  const cost = round(platformCostUsd);
  const profit = round(revenueUsd - cost);
  const margin = revenueUsd === 0 ? null : round((profit / revenueUsd) * 100);
  return { chargedPages: pages, revenueUsd, ...estimates, platformCostUsd: cost, profitUsd: profit, marginPercent: margin, measured: true };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
