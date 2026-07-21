import { applyBaselineAction } from '../baseline/engine.js';
import type { BaselineOperationDependencies, BaselineStore } from '../baseline/types.js';
import type { PageInspection } from '../inspection.js';
import { redactText } from '../security/redaction.js';
import type { ActorInput, BaselineAction, InspectionMetadata, ReportStatus, Severity, TargetInput, TargetReport } from '../types.js';
import { classifyChanges, highestSeverity, meetsMateriality } from './classify.js';
import { normalizeDocument } from './normalize.js';
import { INTELLIGENCE_SCHEMA_VERSION, type NormalizedSnapshot } from './types.js';

export interface ComposeTargetReportInput {
  target: TargetInput;
  inspection: PageInspection;
  store: BaselineStore;
  baselineAction: BaselineAction;
  minimumMateriality: Severity;
  checkedAt: string;
  candidateId?: string;
  expectedCandidateHash?: string;
  expectedTrustedParentHash?: string;
  baselineDependencies?: BaselineOperationDependencies;
}

export async function composeTargetReport(input: ComposeTargetReportInput): Promise<TargetReport> {
  if (input.inspection.status !== 'ok' || !input.inspection.document) return failureReport(input);
  const snapshot = normalizeDocument(input.inspection.document, input.target);
  const baseline = await applyBaselineAction({
    store: input.store,
    target: input.target,
    snapshot,
    action: input.baselineAction,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    ...(input.expectedCandidateHash ? { expectedCandidateHash: input.expectedCandidateHash } : {}),
    ...(input.expectedTrustedParentHash ? { expectedTrustedParentHash: input.expectedTrustedParentHash } : {}),
    dependencies: input.baselineDependencies,
  });
  const comparisonSnapshot = input.baselineAction === 'promote_candidate' ? baseline.trustedSnapshot : snapshot;
  const previous = normalizedSnapshot(baseline.previousTrustedSnapshot);
  const current = normalizedSnapshot(comparisonSnapshot);
  const changes = previous && current
    ? classifyChanges({ targetIdentityHash: baseline.targetIdentityHash, previous, current })
      .filter((change) => meetsMateriality(change.severity, input.minimumMateriality))
    : [];
  const status = reportStatus(baseline.status, changes.length);
  const overallSeverity = highestSeverity(changes);
  const overallConfidence = changes.length === 0
    ? 0
    : Math.round(changes.reduce((sum, change) => sum + change.confidenceScore, 0) / changes.length);
  const summary = summaryFor(status, input.target.name, changes.length, overallSeverity);
  return {
    targetName: redactText(input.target.name, 100),
    targetUrl: input.inspection.targetUrl,
    finalUrl: input.inspection.finalUrl,
    status,
    reachable: input.inspection.reachable,
    robotsAllowed: input.inspection.robotsAllowed,
    baselineFound: baseline.baselineFound,
    baselineAction: input.baselineAction,
    baselineUpdated: baseline.baselineUpdated,
    candidateStored: baseline.candidateStored,
    candidateId: baseline.candidateId,
    previousSnapshotHash: baseline.previousSnapshotHash,
    currentSnapshotHash: baseline.currentSnapshotHash || null,
    changeDetected: changes.length > 0,
    materialChangeCount: changes.length,
    overallSeverity,
    overallConfidence,
    summary,
    recommendedAction: actionFor(status, overallSeverity, changes.length),
    changes,
    inspection: inspectionMetadata(input.inspection),
    checkedAt: validCheckedAt(input.checkedAt),
    persistence: baseline.persistence,
    ...(isBaselineFailure(status) ? {
      error: {
        code: status.toUpperCase(),
        message: redactText(baseline.persistence.error ?? 'Baseline operation did not complete safely.', 500),
      },
    } : {}),
  };
}

export function inspectionMetadata(inspection: PageInspection): InspectionMetadata {
  return {
    httpStatus: inspection.httpStatus,
    contentType: inspection.contentType,
    etag: inspection.etag ?? null,
    lastModified: inspection.lastModified ?? null,
    responseBytes: inspection.responseBytes,
    latencyMs: inspection.latencyMs,
    redirectOrigins: inspection.redirectOrigins,
  };
}

function failureReport(input: ComposeTargetReportInput): TargetReport {
  const status = input.inspection.status === 'ok' ? 'internal_error' : input.inspection.status;
  const severity = failureSeverity(status);
  const message = input.inspection.error?.message ?? input.inspection.robotsReason ?? 'Target inspection stopped safely.';
  return {
    targetName: redactText(input.target.name, 100),
    targetUrl: input.inspection.targetUrl,
    finalUrl: input.inspection.finalUrl,
    status,
    reachable: input.inspection.reachable,
    robotsAllowed: input.inspection.robotsAllowed,
    baselineFound: false,
    baselineAction: input.baselineAction,
    baselineUpdated: false,
    candidateStored: false,
    candidateId: null,
    previousSnapshotHash: null,
    currentSnapshotHash: null,
    changeDetected: false,
    materialChangeCount: 0,
    overallSeverity: severity,
    overallConfidence: 100,
    summary: `${input.target.name} inspection stopped with status ${status}.`,
    recommendedAction: failureAction(status),
    changes: [],
    inspection: inspectionMetadata(input.inspection),
    checkedAt: validCheckedAt(input.checkedAt),
    persistence: { succeeded: true },
    error: {
      code: input.inspection.error?.code ?? status.toUpperCase(),
      message: redactText(message, 500),
    },
  };
}

function normalizedSnapshot(value: Record<string, unknown> | null): NormalizedSnapshot | null {
  if (!value || value.intelligenceSchemaVersion !== INTELLIGENCE_SCHEMA_VERSION || !Array.isArray(value.facts)) return null;
  return value as NormalizedSnapshot;
}

function reportStatus(status: ReportStatus, materialChanges: number): ReportStatus {
  if (status === 'success_changed' && materialChanges === 0) return 'success_no_change';
  if (status === 'success_no_change' && materialChanges > 0) return 'success_changed';
  return status;
}

function failureSeverity(status: ReportStatus): Severity {
  if (['blocked_target', 'authorization_required', 'robots_disallowed'].includes(status)) return 'critical';
  if (['rate_limited', 'timeout', 'response_too_large', 'unreachable'].includes(status)) return 'high';
  return 'medium';
}

function failureAction(status: ReportStatus): string {
  if (status === 'robots_disallowed') return 'Do not fetch this target unless its robots policy changes.';
  if (status === 'blocked_target') return 'Correct the target URL; private, local, credentialed, or unsafe destinations are prohibited.';
  if (status === 'rate_limited') return 'Reduce check frequency and retry after the source rate limit resets.';
  if (status === 'timeout' || status === 'unreachable') return 'Verify the public endpoint and retry later with conservative settings.';
  if (status === 'response_too_large') return 'Use a smaller public endpoint or reduce the configured response-size limit only after review.';
  return 'Review the structured error before retrying.';
}

function summaryFor(status: ReportStatus, name: string, count: number, severity: Severity): string {
  if (status === 'baseline_missing') return `${name} has no trusted baseline; no comparison was made.`;
  if (status === 'baseline_initialized') return `${name} trusted baseline was initialized without reporting a change.`;
  if (status === 'candidate_stored') return `${name} candidate baseline was stored separately for review; ${count} material change(s) were detected.`;
  if (status === 'candidate_promoted') return `${name} reviewed candidate baseline was promoted; ${count} material change(s) were recorded.`;
  if (isBaselineFailure(status)) return `${name} baseline operation stopped with status ${status}.`;
  if (count === 0) return `${name} has no changes at or above the selected materiality threshold.`;
  return `${name} has ${count} material change(s); highest severity is ${severity}.`;
}

function actionFor(status: ReportStatus, severity: Severity, count: number): string {
  if (status === 'baseline_missing') return 'Initialize a trusted baseline explicitly before relying on change reports.';
  if (status === 'baseline_initialized') return 'Keep this baseline trusted and compare future inspections against it.';
  if (status === 'candidate_stored') return 'Review the candidate evidence before promoting it to trusted baseline.';
  if (status === 'candidate_promoted') return 'Use the promoted snapshot as the trusted reference for future comparisons.';
  if (isBaselineFailure(status)) return 'Resolve the baseline conflict or validation error before retrying.';
  if (count === 0) return 'No review is required at the selected materiality threshold.';
  if (severity === 'critical' || severity === 'high') return 'Review the source evidence promptly before making or automating a decision.';
  return 'Review the classified changes and confirm any business response.';
}

function isBaselineFailure(status: ReportStatus): boolean {
  return ['promotion_mismatch', 'concurrency_conflict', 'internal_error'].includes(status);
}

function validCheckedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('checkedAt must be a valid date-time.');
  return new Date(parsed).toISOString();
}

export function reportOptionsFromActorInput(input: ActorInput): Pick<ComposeTargetReportInput,
  'baselineAction' | 'minimumMateriality' | 'candidateId' | 'expectedCandidateHash' | 'expectedTrustedParentHash'> {
  return {
    baselineAction: input.baselineAction,
    minimumMateriality: input.minimumMateriality,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    ...(input.expectedCandidateHash ? { expectedCandidateHash: input.expectedCandidateHash } : {}),
    ...(input.expectedTrustedParentHash ? { expectedTrustedParentHash: input.expectedTrustedParentHash } : {}),
  };
}
