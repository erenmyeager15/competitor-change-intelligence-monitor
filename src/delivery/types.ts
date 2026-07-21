import type { ChangeType, ConfidenceBand, NotificationMode, Severity } from '../types.js';

export const DELIVERY_SCHEMA_VERSION = 1 as const;
export const MAX_DIGEST_CHANGES = 100;
export const MAX_WEBHOOK_CHANGES = 10;

export interface DigestChange {
  changeId: string;
  targetName: string;
  targetUrl: string;
  category: ChangeType;
  field: string;
  severity: Severity;
  confidenceScore: number;
  confidence: ConfidenceBand;
  explanation: string;
  recommendedAction: string;
  previousExcerpt: string | null;
  currentExcerpt: string | null;
}

export interface DigestDocument {
  schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
  generatedAt: string;
  runUrl: string | null;
  reportCount: number;
  changedTargetCount: number;
  changeCount: number;
  changes: DigestChange[];
}

export interface WebhookPayload {
  schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
  deliveryId: string;
  mode: Exclude<NotificationMode, 'none'>;
  generatedAt: string;
  runUrl: string | null;
  totalEligibleChanges: number;
  changes: DigestChange[];
}

export interface DeliveryOutcome {
  mode: NotificationMode;
  attempted: boolean;
  succeeded: boolean;
  status: 'disabled' | 'no_changes' | 'queued' | 'already_delivered' | 'lease_held' | 'delivered' | 'failed';
  eligibleChangeCount: number;
  deliveredChangeCount: number;
  queuedChangeCount: number;
  attempts: number;
  statusCode: number | null;
  deliveryId: string | null;
  error?: string;
}

export interface WeeklyDeliveryLease {
  deliveryId: string;
  owner: string;
  status: 'sending' | 'delivered';
  acquiredAt: string;
  expiresAt: string;
  deliveredAt: string | null;
}

export interface WeeklyDigestState {
  schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
  windowId: string;
  destinationHash: string;
  timezone: string;
  deliveryDay: number;
  pendingChanges: DigestChange[];
  delivery: WeeklyDeliveryLease | null;
  updatedAt: string;
}
