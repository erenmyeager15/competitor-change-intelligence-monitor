export const CHANGE_TYPES = [
  'price',
  'availability',
  'product_feature',
  'pricing_plan',
  'terms_policy',
  'launch_changelog',
  'general_content',
] as const;

export const SEVERITIES = ['informational', 'low', 'medium', 'high', 'critical'] as const;
export const BASELINE_ACTIONS = ['compare_only', 'initialize_trusted', 'store_candidate', 'promote_candidate'] as const;
export const NOTIFICATION_MODES = ['none', 'immediate', 'weekly_digest'] as const;

export type ChangeType = typeof CHANGE_TYPES[number];
export type Severity = typeof SEVERITIES[number];
export type BaselineAction = typeof BASELINE_ACTIONS[number];
export type NotificationMode = typeof NOTIFICATION_MODES[number];
export type ConfidenceBand = 'low' | 'medium' | 'high';

export interface ProductIdentifiers {
  sku?: string;
  gtin?: string;
  mpn?: string;
  brand?: string;
  model?: string;
  variant?: string;
  packQuantity?: string;
}

export interface TargetInput {
  name: string;
  url: string;
  changeTypes: ChangeType[];
  includeSelectors?: string[];
  excludeSelectors?: string[];
  ignoreTextPatterns?: string[];
  currency?: string;
  productIdentifiers?: ProductIdentifiers;
  authorizedRedirectOrigins?: string[];
}

export interface ActorInput {
  targets: TargetInput[];
  confirmAuthorizedUse: boolean;
  baselineAction: BaselineAction;
  candidateId?: string;
  expectedCandidateHash?: string;
  expectedTrustedParentHash?: string;
  includeUnchanged: boolean;
  minimumMateriality: Severity;
  notificationMode: NotificationMode;
  minimumAlertSeverity: Exclude<Severity, 'informational'>;
  alertWebhookUrl?: string;
  weeklyDigestDay: number;
  timezone: string;
  requestTimeoutSeconds: number;
  maxResponseBytes: number;
  maxRetries: number;
  dryRun: boolean;
}

export type ReportStatus =
  | 'success_no_change'
  | 'success_changed'
  | 'baseline_missing'
  | 'baseline_initialized'
  | 'candidate_stored'
  | 'candidate_promoted'
  | 'promotion_mismatch'
  | 'authorization_required'
  | 'robots_disallowed'
  | 'blocked_target'
  | 'unsupported_content'
  | 'unreachable'
  | 'rate_limited'
  | 'timeout'
  | 'response_too_large'
  | 'invalid_response'
  | 'concurrency_conflict'
  | 'internal_error';

export interface ChangeEvidence {
  previousExcerpt: string | null;
  currentExcerpt: string | null;
  sources: string[];
}

export interface ClassifiedChange {
  changeId: string;
  category: ChangeType;
  field: string;
  previousValue: unknown;
  currentValue: unknown;
  delta?: number | null;
  deltaPercent?: number | null;
  severity: Severity;
  confidenceScore: number;
  confidence: ConfidenceBand;
  explanation: string;
  recommendedAction: string;
  evidence: ChangeEvidence;
}

export interface InspectionMetadata {
  httpStatus: number | null;
  contentType: string | null;
  responseBytes: number;
  latencyMs: number;
  etag?: string | null;
  lastModified?: string | null;
  redirectOrigins: string[];
}

export interface TargetReport {
  targetName: string;
  targetUrl: string;
  finalUrl: string;
  status: ReportStatus;
  reachable: boolean;
  robotsAllowed: boolean | null;
  baselineFound: boolean;
  baselineAction: BaselineAction;
  baselineUpdated: boolean;
  candidateStored: boolean;
  candidateId: string | null;
  previousSnapshotHash: string | null;
  currentSnapshotHash: string | null;
  changeDetected: boolean;
  materialChangeCount: number;
  overallSeverity: Severity;
  overallConfidence: number;
  summary: string;
  recommendedAction: string;
  changes: ClassifiedChange[];
  inspection: InspectionMetadata;
  checkedAt: string;
  persistence: { succeeded: boolean; error?: string };
  error?: { code: string; message: string };
}
