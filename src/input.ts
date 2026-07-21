import {
  BASELINE_ACTIONS,
  CHANGE_TYPES,
  NOTIFICATION_MODES,
  SEVERITIES,
  type ActorInput,
  type BaselineAction,
  type ChangeType,
  type NotificationMode,
  type ProductIdentifiers,
  type Severity,
  type TargetInput,
} from './types.js';

const TOP_LEVEL_FIELDS = new Set([
  'targets', 'confirmAuthorizedUse', 'baselineAction', 'candidateId',
  'expectedCandidateHash', 'expectedTrustedParentHash', 'includeUnchanged',
  'minimumMateriality', 'notificationMode', 'minimumAlertSeverity',
  'alertWebhookUrl', 'weeklyDigestDay', 'timezone', 'requestTimeoutSeconds',
  'maxResponseBytes', 'maxRetries', 'dryRun',
]);
const TARGET_FIELDS = new Set([
  'name', 'url', 'changeTypes', 'includeSelectors', 'excludeSelectors',
  'ignoreTextPatterns', 'currency', 'productIdentifiers', 'authorizedRedirectOrigins',
]);
const IDENTIFIER_FIELDS = new Set(['sku', 'gtin', 'mpn', 'brand', 'model', 'variant', 'packQuantity']);
const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^[A-Za-z0-9_-]+$/;
const CURRENCY = /^[A-Za-z]{3}$/;
const GTIN = /^[0-9]{8,14}$/;
const SAFE_GLOB = /^[^()[\]{}\\|^$+]*$/;

function fail(message: string): never {
  throw new Error(`Invalid input: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unsupported field(s): ${unknown.join(', ')}.`);
}

function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) fail(`${label} must contain ${min}-${max} characters.`);
  return trimmed;
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${label} must be a boolean.`);
  return value;
}

function integer(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

function choice<T extends string>(value: unknown, label: string, fallback: T, choices: readonly T[]): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(`${label} has an unsupported value.`);
  return value as T;
}

function stringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} must contain at most ${maxItems} items.`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 1, maxLength));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates.`);
  return result;
}

function parseHttpsUrl(value: unknown, label: string, requireOriginOnly = false): string {
  const raw = text(value, label, 9, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} must be an absolute URL.`);
  }
  if (url.protocol !== 'https:') fail(`${label} must use HTTPS.`);
  if (url.username || url.password) fail(`${label} must not contain URL credentials.`);
  if (url.hash) fail(`${label} must not contain a fragment.`);
  if (requireOriginOnly && (url.pathname !== '/' || url.search)) fail(`${label} must be an origin without a path or query.`);
  return requireOriginOnly ? url.origin : url.toString();
}

function parseIdentifiers(value: unknown, label: string): ProductIdentifiers | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, label);
  rejectUnknown(raw, IDENTIFIER_FIELDS, label);
  const parsed: ProductIdentifiers = {};
  for (const key of IDENTIFIER_FIELDS) {
    const item = raw[key];
    if (item === undefined) continue;
    const result = text(item, `${label}.${key}`, key === 'gtin' ? 8 : 1, key === 'gtin' ? 14 : key === 'packQuantity' ? 64 : 128);
    if (key === 'gtin' && !GTIN.test(result)) fail(`${label}.gtin must contain 8-14 digits.`);
    parsed[key as keyof ProductIdentifiers] = result;
  }
  return parsed;
}

function parseTarget(value: unknown, index: number): TargetInput {
  const label = `targets[${index}]`;
  const raw = object(value, label);
  rejectUnknown(raw, TARGET_FIELDS, label);
  const name = text(raw.name, `${label}.name`, 1, 100);
  const url = parseHttpsUrl(raw.url, `${label}.url`);
  if (!Array.isArray(raw.changeTypes) || raw.changeTypes.length < 1 || raw.changeTypes.length > CHANGE_TYPES.length) {
    fail(`${label}.changeTypes must contain 1-${CHANGE_TYPES.length} items.`);
  }
  const changeTypes = raw.changeTypes.map((item) => choice(item, `${label}.changeTypes`, 'general_content' as ChangeType, CHANGE_TYPES));
  if (new Set(changeTypes).size !== changeTypes.length) fail(`${label}.changeTypes must not contain duplicates.`);

  const includeSelectors = stringList(raw.includeSelectors, `${label}.includeSelectors`, 10, 256);
  const excludeSelectors = stringList(raw.excludeSelectors, `${label}.excludeSelectors`, 20, 256);
  const ignoreTextPatterns = stringList(raw.ignoreTextPatterns, `${label}.ignoreTextPatterns`, 10, 128);
  if (ignoreTextPatterns?.some((pattern) => !SAFE_GLOB.test(pattern))) {
    fail(`${label}.ignoreTextPatterns accepts literals and simple * or ? globs, not regular expressions.`);
  }
  const currency = raw.currency === undefined ? undefined : text(raw.currency, `${label}.currency`, 3, 3).toUpperCase();
  if (currency && !CURRENCY.test(currency)) fail(`${label}.currency must be a three-letter code.`);
  const productIdentifiers = parseIdentifiers(raw.productIdentifiers, `${label}.productIdentifiers`);
  const redirectValues = stringList(raw.authorizedRedirectOrigins, `${label}.authorizedRedirectOrigins`, 3, 512);
  const authorizedRedirectOrigins = redirectValues?.map((item, redirectIndex) => parseHttpsUrl(item, `${label}.authorizedRedirectOrigins[${redirectIndex}]`, true));

  return {
    name,
    url,
    changeTypes,
    ...(includeSelectors ? { includeSelectors } : {}),
    ...(excludeSelectors ? { excludeSelectors } : {}),
    ...(ignoreTextPatterns ? { ignoreTextPatterns } : {}),
    ...(currency ? { currency } : {}),
    ...(productIdentifiers ? { productIdentifiers } : {}),
    ...(authorizedRedirectOrigins ? { authorizedRedirectOrigins } : {}),
  };
}

function isSafeDemoTarget(target: TargetInput): boolean {
  const url = new URL(target.url);
  return url.protocol === 'https:' && url.hostname === 'example.com' && url.pathname === '/' && !url.search;
}

function validateTimezone(value: unknown): string {
  const timezone = text(value ?? 'UTC', 'timezone', 1, 64);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    fail('timezone must be a valid IANA timezone.');
  }
  return timezone;
}

export function parseActorInput(value: unknown): ActorInput {
  const raw = object(value, 'input');
  rejectUnknown(raw, TOP_LEVEL_FIELDS, 'input');
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 25) {
    fail('targets must contain 1-25 entries.');
  }
  const targets = raw.targets.map(parseTarget);
  const names = targets.map((target) => target.name.toLocaleLowerCase('en-US'));
  if (new Set(names).size !== names.length) fail('target names must be unique case-insensitively.');

  const confirmAuthorizedUse = boolean(raw.confirmAuthorizedUse, 'confirmAuthorizedUse', false);
  if (!confirmAuthorizedUse && targets.some((target) => !isSafeDemoTarget(target))) {
    fail('confirmAuthorizedUse=true is required for every non-demo target. This confirmation does not create permission.');
  }

  const baselineAction = choice(raw.baselineAction, 'baselineAction', 'compare_only' as BaselineAction, BASELINE_ACTIONS);
  const candidateId = raw.candidateId === undefined ? undefined : text(raw.candidateId, 'candidateId', 1, 128);
  const expectedCandidateHash = raw.expectedCandidateHash === undefined ? undefined : text(raw.expectedCandidateHash, 'expectedCandidateHash', 64, 64);
  const expectedTrustedParentHash = raw.expectedTrustedParentHash === undefined ? undefined : text(raw.expectedTrustedParentHash, 'expectedTrustedParentHash', 9, 64);
  if (baselineAction === 'promote_candidate') {
    if (!candidateId || !CANDIDATE_ID.test(candidateId)) fail('promote_candidate requires a valid candidateId.');
    if (!expectedCandidateHash || !SHA256.test(expectedCandidateHash)) fail('promote_candidate requires an exact lowercase SHA-256 expectedCandidateHash.');
    if (!expectedTrustedParentHash || (expectedTrustedParentHash !== 'NO_PARENT' && !SHA256.test(expectedTrustedParentHash))) {
      fail('promote_candidate requires an exact trusted-parent SHA-256 hash or NO_PARENT.');
    }
  } else if (candidateId || expectedCandidateHash || expectedTrustedParentHash) {
    fail('candidate promotion fields are accepted only when baselineAction is promote_candidate.');
  }

  const notificationMode = choice(raw.notificationMode, 'notificationMode', 'none' as NotificationMode, NOTIFICATION_MODES);
  const alertWebhookUrl = raw.alertWebhookUrl === undefined ? undefined : parseHttpsUrl(raw.alertWebhookUrl, 'alertWebhookUrl');
  if (notificationMode !== 'none' && !alertWebhookUrl) fail('alertWebhookUrl is required when notificationMode is not none.');
  if (notificationMode === 'none' && alertWebhookUrl) fail('alertWebhookUrl requires immediate or weekly_digest notificationMode.');

  const dryRun = boolean(raw.dryRun, 'dryRun', false);
  if (dryRun && baselineAction !== 'compare_only') fail('dryRun=true requires baselineAction=compare_only so baseline state cannot mutate.');

  return {
    targets,
    confirmAuthorizedUse,
    baselineAction,
    ...(candidateId ? { candidateId } : {}),
    ...(expectedCandidateHash ? { expectedCandidateHash } : {}),
    ...(expectedTrustedParentHash ? { expectedTrustedParentHash } : {}),
    includeUnchanged: boolean(raw.includeUnchanged, 'includeUnchanged', false),
    minimumMateriality: choice(raw.minimumMateriality, 'minimumMateriality', 'low' as Severity, SEVERITIES),
    notificationMode,
    minimumAlertSeverity: choice(raw.minimumAlertSeverity, 'minimumAlertSeverity', 'medium', ['low', 'medium', 'high', 'critical'] as const),
    ...(alertWebhookUrl ? { alertWebhookUrl } : {}),
    weeklyDigestDay: integer(raw.weeklyDigestDay, 'weeklyDigestDay', 1, 1, 7),
    timezone: validateTimezone(raw.timezone),
    requestTimeoutSeconds: integer(raw.requestTimeoutSeconds, 'requestTimeoutSeconds', 15, 3, 30),
    maxResponseBytes: integer(raw.maxResponseBytes, 'maxResponseBytes', 2_097_152, 65_536, 5_242_880),
    maxRetries: integer(raw.maxRetries, 'maxRetries', 1, 0, 2),
    dryRun,
  };
}
