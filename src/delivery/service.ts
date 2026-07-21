import { randomUUID } from 'node:crypto';
import type { BaselineStore } from '../baseline/types.js';
import { sha256 } from '../baseline/canonical.js';
import { severityRank } from '../intelligence/classify.js';
import { redactText } from '../security/redaction.js';
import type { ActorInput } from '../types.js';
import { buildWebhookPayload, deliveryId, filterDigestBySeverity } from './digest.js';
import {
  DELIVERY_SCHEMA_VERSION,
  MAX_DIGEST_CHANGES,
  type DeliveryOutcome,
  type DigestChange,
  type DigestDocument,
  type WeeklyDigestState,
} from './types.js';
import { sendWebhook, type WebhookSendResult } from './webhook.js';

const WEEKLY_LEASE_MILLISECONDS = 5 * 60 * 1_000;

export interface DeliveryDependencies {
  send?: (url: string, payload: ReturnType<typeof buildWebhookPayload>) => Promise<WebhookSendResult>;
  createId?: () => string;
}

export async function deliverDigest(args: {
  input: ActorInput;
  digest: DigestDocument;
  stateStore: BaselineStore;
  now: string;
  runUrl?: string | null;
  dependencies?: DeliveryDependencies;
}): Promise<DeliveryOutcome> {
  if (args.input.notificationMode === 'none') return outcome('none', 'disabled', 0);
  const eligible = filterDigestBySeverity(args.digest, args.input.minimumAlertSeverity);
  if (args.input.notificationMode === 'immediate') return deliverImmediate(args, eligible);
  return deliverWeekly(args, eligible);
}

async function deliverImmediate(
  args: Parameters<typeof deliverDigest>[0],
  changes: DigestChange[],
): Promise<DeliveryOutcome> {
  if (changes.length === 0) return outcome('immediate', 'no_changes', 0);
  const id = deliveryId({ mode: 'immediate', runUrl: args.runUrl ?? null, generatedAt: args.now, changes: changes.map((change) => change.changeId) });
  const payload = buildWebhookPayload({
    mode: 'immediate', generatedAt: args.now, runUrl: args.runUrl, deliveryId: id, changes,
  });
  try {
    const result = await sender(args)(args.input.alertWebhookUrl!, payload);
    return {
      mode: 'immediate', attempted: true, succeeded: true, status: 'delivered',
      eligibleChangeCount: changes.length, deliveredChangeCount: payload.changes.length,
      queuedChangeCount: 0, attempts: result.attempts, statusCode: result.statusCode, deliveryId: id,
    };
  } catch (error) {
    return failureOutcome('immediate', changes.length, 0, id, error);
  }
}

async function deliverWeekly(
  args: Parameters<typeof deliverDigest>[0],
  newChanges: DigestChange[],
): Promise<DeliveryOutcome> {
  const webhookUrl = args.input.alertWebhookUrl!;
  const destinationHash = sha256(webhookUrl);
  const stateKey = weeklyStateKey(destinationHash, args.input.timezone, args.input.weeklyDigestDay);
  const currentWindow = weeklyWindow(args.now, args.input.timezone);
  const existing = await loadState(args.stateStore, stateKey, destinationHash);
  const pendingChanges = mergeChanges(existing?.pendingChanges ?? [], newChanges);
  const sameWindow = existing?.windowId === currentWindow.windowId;
  let state: WeeklyDigestState = {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    windowId: currentWindow.windowId,
    destinationHash,
    timezone: args.input.timezone,
    deliveryDay: args.input.weeklyDigestDay,
    pendingChanges,
    delivery: sameWindow ? existing?.delivery ?? null : null,
    updatedAt: isoDate(args.now),
  };
  await args.stateStore.setValue(stateKey, state);

  if (currentWindow.weekday !== args.input.weeklyDigestDay) {
    return weeklyOutcome('queued', newChanges.length, state.pendingChanges.length, state.delivery?.deliveryId ?? null);
  }
  if (state.delivery?.status === 'delivered') {
    return weeklyOutcome('already_delivered', newChanges.length, state.pendingChanges.length, state.delivery.deliveryId);
  }
  if (state.pendingChanges.length === 0) return outcome('weekly_digest', 'no_changes', 0);
  if (state.delivery?.status === 'sending' && Date.parse(state.delivery.expiresAt) > Date.parse(args.now)) {
    return weeklyOutcome('lease_held', newChanges.length, state.pendingChanges.length, state.delivery.deliveryId);
  }

  const owner = cleanId(args.dependencies?.createId?.() ?? randomUUID());
  const id = deliveryId({ mode: 'weekly_digest', windowId: state.windowId, destinationHash, changes: state.pendingChanges.map((change) => change.changeId) });
  state = {
    ...state,
    delivery: {
      deliveryId: id,
      owner,
      status: 'sending',
      acquiredAt: isoDate(args.now),
      expiresAt: new Date(Date.parse(args.now) + WEEKLY_LEASE_MILLISECONDS).toISOString(),
      deliveredAt: null,
    },
    updatedAt: isoDate(args.now),
  };
  await args.stateStore.setValue(stateKey, state);
  const verified = await loadState(args.stateStore, stateKey, destinationHash);
  if (verified?.delivery?.owner !== owner || verified.delivery.deliveryId !== id || verified.delivery.status !== 'sending') {
    return weeklyOutcome('lease_held', newChanges.length, verified?.pendingChanges.length ?? state.pendingChanges.length, id);
  }
  const payload = buildWebhookPayload({
    mode: 'weekly_digest', generatedAt: args.now, runUrl: args.runUrl, deliveryId: id, changes: verified.pendingChanges,
  });
  try {
    const result = await sender(args)(webhookUrl, payload);
    const latest = await loadState(args.stateStore, stateKey, destinationHash);
    if (latest?.delivery?.owner === owner && latest.delivery.deliveryId === id) {
      await args.stateStore.setValue(stateKey, {
        ...latest,
        pendingChanges: [],
        delivery: { ...latest.delivery, status: 'delivered', deliveredAt: isoDate(args.now) },
        updatedAt: isoDate(args.now),
      } satisfies WeeklyDigestState);
    }
    return {
      mode: 'weekly_digest', attempted: true, succeeded: true, status: 'delivered',
      eligibleChangeCount: verified.pendingChanges.length, deliveredChangeCount: payload.changes.length,
      queuedChangeCount: 0, attempts: result.attempts, statusCode: result.statusCode, deliveryId: id,
    };
  } catch (error) {
    const latest = await loadState(args.stateStore, stateKey, destinationHash);
    if (latest?.delivery?.owner === owner && latest.delivery.deliveryId === id) {
      await args.stateStore.setValue(stateKey, { ...latest, delivery: null, updatedAt: isoDate(args.now) } satisfies WeeklyDigestState);
    }
    return failureOutcome('weekly_digest', verified.pendingChanges.length, verified.pendingChanges.length, id, error);
  }
}

export function weeklyStateKey(destinationHash: string, timezone: string, deliveryDay: number): string {
  return `weekly-digest-v1-${sha256(JSON.stringify({ destinationHash, timezone, deliveryDay })).slice(0, 40)}`;
}

export function weeklyWindow(value: string, timezone: string): { windowId: string; weekday: number } {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Weekly digest timestamp must be a valid date-time.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? '';
  const year = Number(part('year'));
  const month = Number(part('month'));
  const day = Number(part('day'));
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = weekdays[part('weekday')];
  if (!year || !month || !day || !weekday) throw new Error('Weekly digest local date could not be determined.');
  const localDay = Date.UTC(year, month - 1, day);
  const start = new Date(localDay - (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
  return { windowId: `${start}:${timezone}`, weekday };
}

function sender(args: Parameters<typeof deliverDigest>[0]): NonNullable<DeliveryDependencies['send']> {
  return args.dependencies?.send ?? ((url, payload) => sendWebhook(url, payload, { timeoutMs: 10_000, maxRetries: 2 }));
}

async function loadState(store: BaselineStore, key: string, destinationHash: string): Promise<WeeklyDigestState | null> {
  const value = await store.getValue<WeeklyDigestState>(key);
  if (value === null) return null;
  if (!value || value.schemaVersion !== DELIVERY_SCHEMA_VERSION || value.destinationHash !== destinationHash
    || !Array.isArray(value.pendingChanges) || value.pendingChanges.length > MAX_DIGEST_CHANGES
    || typeof value.windowId !== 'string' || typeof value.timezone !== 'string') {
    throw new Error('Weekly digest state is invalid or incompatible.');
  }
  return value;
}

function mergeChanges(previous: DigestChange[], current: DigestChange[]): DigestChange[] {
  const values = new Map<string, DigestChange>();
  for (const change of [...previous, ...current]) if (!values.has(change.changeId)) values.set(change.changeId, change);
  return [...values.values()]
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity)
      || right.confidenceScore - left.confidenceScore
      || left.changeId.localeCompare(right.changeId))
    .slice(0, MAX_DIGEST_CHANGES);
}

function outcome(mode: DeliveryOutcome['mode'], status: DeliveryOutcome['status'], eligible: number): DeliveryOutcome {
  return {
    mode, attempted: false, succeeded: status === 'disabled' || status === 'no_changes', status,
    eligibleChangeCount: eligible, deliveredChangeCount: 0, queuedChangeCount: 0,
    attempts: 0, statusCode: null, deliveryId: null,
  };
}

function weeklyOutcome(status: DeliveryOutcome['status'], eligible: number, queued: number, id: string | null): DeliveryOutcome {
  return {
    mode: 'weekly_digest', attempted: false, succeeded: status !== 'failed', status,
    eligibleChangeCount: eligible, deliveredChangeCount: 0, queuedChangeCount: queued,
    attempts: 0, statusCode: null, deliveryId: id,
  };
}

function failureOutcome(
  mode: Exclude<DeliveryOutcome['mode'], 'none'>,
  eligible: number,
  queued: number,
  id: string,
  error: unknown,
): DeliveryOutcome {
  const statusCode = typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
  return {
    mode, attempted: true, succeeded: false, status: 'failed', eligibleChangeCount: eligible,
    deliveredChangeCount: 0, queuedChangeCount: queued, attempts: 0, statusCode, deliveryId: id,
    error: redactText((error as Error).message || 'Webhook delivery failed.', 500),
  };
}

function cleanId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || randomUUID().replace(/-/g, '');
}

function isoDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Delivery timestamp must be a valid date-time.');
  return new Date(parsed).toISOString();
}
