import type { BaselineOperationDependencies, BaselineStore } from './baseline/types.js';
import { PAGE_CHECKED_EVENT, assessCost, isBillableReport, type CostAssessment } from './billing.js';
import { buildDigest, digestMarkdown } from './delivery/digest.js';
import { deliverDigest, type DeliveryDependencies } from './delivery/service.js';
import type { DeliveryOutcome, DigestDocument } from './delivery/types.js';
import { inspectTarget } from './inspection.js';
import { composeTargetReport } from './intelligence/report.js';
import { redactText, redactUrl } from './security/redaction.js';
import type { ActorInput, ReportStatus, Severity, TargetInput, TargetReport } from './types.js';

export const RUNTIME_SCHEMA_VERSION = 1 as const;

export interface PushResult {
  chargedCount: number;
  eventChargeLimitReached: boolean;
  chargeableWithinLimit: Record<string, number>;
}

export interface RunSummary {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  startedAt: string;
  finishedAt: string;
  runUrl: string | null;
  targetCount: number;
  processedTargetCount: number;
  skippedForChargeLimit: number;
  persistedReportCount: number;
  billableReportCount: number;
  chargedEventCount: number;
  persistenceFailureCount: number;
  statusCounts: Record<string, number>;
  severityCounts: Record<Severity, number>;
  delivery: DeliveryOutcome;
  costAssessment: CostAssessment;
}

export interface MonitorRunResult {
  reports: TargetReport[];
  digest: DigestDocument;
  summary: RunSummary;
}

export interface RuntimeDependencies {
  stateStore: BaselineStore;
  billingEnabled: boolean;
  getChargeableCount: (eventName: string) => number;
  pushData: (report: TargetReport, eventName?: string) => Promise<PushResult>;
  setOutputValue: (key: string, value: unknown, contentType: string) => Promise<void>;
  inspect?: typeof inspectTarget;
  now?: () => string;
  runUrl?: string | null;
  baselineDependencies?: BaselineOperationDependencies;
  deliveryDependencies?: DeliveryDependencies;
}

export async function runMonitor(input: ActorInput, dependencies: RuntimeDependencies): Promise<MonitorRunResult> {
  if (input.dryRun && input.baselineAction !== 'compare_only') {
    throw new Error('Dry runs require baselineAction=compare_only so trusted and candidate state cannot mutate.');
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const startedAt = validDate(now());
  const reports: TargetReport[] = [];
  let skippedForChargeLimit = 0;
  let processedTargetCount = 0;
  let billableReportCount = 0;
  let chargedEventCount = 0;
  let persistenceFailureCount = 0;

  for (const [index, target] of input.targets.entries()) {
    if (!input.dryRun && dependencies.billingEnabled && dependencies.getChargeableCount(PAGE_CHECKED_EVENT) < 1) {
      skippedForChargeLimit = input.targets.length - index;
      break;
    }
    let report: TargetReport;
    try {
      const inspection = await (dependencies.inspect ?? inspectTarget)(target, {
        timeoutMs: input.requestTimeoutSeconds * 1_000,
        maxResponseBytes: input.maxResponseBytes,
        maxRetries: input.maxRetries,
      });
      report = await composeTargetReport({
        target,
        inspection,
        store: dependencies.stateStore,
        baselineAction: input.baselineAction,
        minimumMateriality: input.minimumMateriality,
        checkedAt: validDate(now()),
        ...(input.candidateId ? { candidateId: input.candidateId } : {}),
        ...(input.expectedCandidateHash ? { expectedCandidateHash: input.expectedCandidateHash } : {}),
        ...(input.expectedTrustedParentHash ? { expectedTrustedParentHash: input.expectedTrustedParentHash } : {}),
        baselineDependencies: dependencies.baselineDependencies,
      });
    } catch (error) {
      report = runtimeFailureReport(target, validDate(now()), error);
    }
    processedTargetCount += 1;

    const billable = isBillableReport(report, input.dryRun);
    try {
      if (billable && dependencies.billingEnabled) {
        const charge = await dependencies.pushData(datasetReport(report, input.includeUnchanged), PAGE_CHECKED_EVENT);
        if (charge.chargedCount < 1 && charge.eventChargeLimitReached) {
          const allowanceReport = chargeLimitReport(report);
          await dependencies.pushData(allowanceReport);
          reports.push(allowanceReport);
          skippedForChargeLimit = input.targets.length - index - 1;
          break;
        }
        billableReportCount += 1;
        chargedEventCount += charge.chargedCount;
      } else {
        await dependencies.pushData(datasetReport(report, input.includeUnchanged));
        if (billable) billableReportCount += 1;
      }
      reports.push(report);
    } catch {
      persistenceFailureCount += 1;
    }
  }

  const finishedAt = validDate(now());
  const digest = buildDigest(reports, finishedAt, dependencies.runUrl);
  let delivery: DeliveryOutcome;
  if (input.dryRun) {
    delivery = disabledDelivery(input.notificationMode);
  } else {
    try {
      delivery = await deliverDigest({
        input,
        digest,
        stateStore: dependencies.stateStore,
        now: finishedAt,
        runUrl: dependencies.runUrl,
        dependencies: dependencies.deliveryDependencies,
      });
    } catch (error) {
      delivery = failedDelivery(input.notificationMode, error);
    }
  }
  const summary: RunSummary = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    startedAt,
    finishedAt,
    runUrl: safeRunUrl(dependencies.runUrl),
    targetCount: input.targets.length,
    processedTargetCount,
    skippedForChargeLimit,
    persistedReportCount: reports.length,
    billableReportCount,
    chargedEventCount,
    persistenceFailureCount,
    statusCounts: countValues(reports.map((report) => report.status)),
    severityCounts: countSeverities(reports),
    delivery,
    costAssessment: assessCost(chargedEventCount),
  };
  await dependencies.setOutputValue('DIGEST_JSON', digest, 'application/json');
  await dependencies.setOutputValue('DIGEST_MARKDOWN', digestMarkdown(digest), 'text/markdown');
  await dependencies.setOutputValue('RUN_SUMMARY', summary, 'application/json');
  return { reports, digest, summary };
}

function datasetReport(report: TargetReport, includeUnchanged: boolean): TargetReport {
  if (includeUnchanged || report.status !== 'success_no_change') return report;
  return {
    ...report,
    summary: 'No material change detected.',
    recommendedAction: 'No review is required at the selected materiality threshold.',
    changes: [],
  };
}

function runtimeFailureReport(target: TargetInput, checkedAt: string, error: unknown): TargetReport {
  return {
    targetName: redactText(target.name, 100),
    targetUrl: redactUrl(target.url),
    finalUrl: redactUrl(target.url),
    status: 'internal_error',
    reachable: false,
    robotsAllowed: null,
    baselineFound: false,
    baselineAction: 'compare_only',
    baselineUpdated: false,
    candidateStored: false,
    candidateId: null,
    previousSnapshotHash: null,
    currentSnapshotHash: null,
    changeDetected: false,
    materialChangeCount: 0,
    overallSeverity: 'high',
    overallConfidence: 0,
    summary: 'Target processing stopped because of an internal error.',
    recommendedAction: 'Review the redacted error and retry only after correcting the cause.',
    changes: [],
    inspection: { httpStatus: null, contentType: null, responseBytes: 0, latencyMs: 0, redirectOrigins: [] },
    checkedAt,
    persistence: { succeeded: false, error: redactText((error as Error).message || 'Target processing failed.', 500) },
    error: { code: 'INTERNAL_ERROR', message: redactText((error as Error).message || 'Target processing failed.', 500) },
  };
}

function chargeLimitReport(report: TargetReport): TargetReport {
  return {
    ...report,
    status: 'internal_error',
    changeDetected: false,
    materialChangeCount: 0,
    overallSeverity: 'high',
    overallConfidence: 100,
    summary: 'The page was checked, but the paid-event allowance was exhausted before atomic persistence and charging.',
    recommendedAction: 'Increase the run budget or reduce the number of target pages, then retry.',
    changes: [],
    persistence: { succeeded: false, error: 'Paid-event allowance exhausted.' },
    error: { code: 'CHARGE_ALLOWANCE_EXHAUSTED', message: 'Paid-event allowance exhausted before atomic persistence and charging.' },
  };
}

function countValues(values: ReportStatus[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function countSeverities(reports: TargetReport[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { informational: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const report of reports) counts[report.overallSeverity] += 1;
  return counts;
}

function disabledDelivery(mode: ActorInput['notificationMode']): DeliveryOutcome {
  return {
    mode, attempted: false, succeeded: true, status: 'disabled', eligibleChangeCount: 0,
    deliveredChangeCount: 0, queuedChangeCount: 0, attempts: 0, statusCode: null, deliveryId: null,
  };
}

function failedDelivery(mode: ActorInput['notificationMode'], error: unknown): DeliveryOutcome {
  return {
    mode, attempted: false, succeeded: false, status: 'failed', eligibleChangeCount: 0,
    deliveredChangeCount: 0, queuedChangeCount: 0, attempts: 0, statusCode: null, deliveryId: null,
    error: redactText((error as Error).message || 'Delivery orchestration failed.', 500),
  };
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

function validDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Runtime clock returned an invalid timestamp.');
  return new Date(parsed).toISOString();
}
