import type { TargetInput } from './types.js';
import { contentKind, extractDocument, type ExtractedDocument } from './extraction/extract.js';
import { OriginRateLimiter, SafeFetchError, safeFetch, type SafeFetchOptions, type SafeHttpResponse } from './security/network.js';
import { checkRobotsCompliance, type RobotsDecision } from './security/robots.js';
import { redactText, redactUrl } from './security/redaction.js';
import { validatePublicHttpsUrl } from './security/target.js';

export type InspectionStatus =
  | 'ok'
  | 'robots_disallowed'
  | 'blocked_target'
  | 'unsupported_content'
  | 'unreachable'
  | 'rate_limited'
  | 'timeout'
  | 'response_too_large'
  | 'invalid_response';

export interface PageInspection {
  status: InspectionStatus;
  targetUrl: string;
  finalUrl: string;
  reachable: boolean;
  robotsAllowed: boolean | null;
  robotsReason: string;
  httpStatus: number | null;
  contentType: string | null;
  etag?: string | null;
  lastModified?: string | null;
  responseBytes: number;
  latencyMs: number;
  redirectOrigins: string[];
  document: ExtractedDocument | null;
  error: { code: string; message: string } | null;
}

export interface InspectTargetOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRetries: number;
  rateLimiter?: OriginRateLimiter;
}

export interface InspectionDependencies {
  checkRobots?: typeof checkRobotsCompliance;
  fetchPage?: (url: string, options: SafeFetchOptions) => Promise<SafeHttpResponse>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function inspectTarget(
  target: TargetInput,
  options: InspectTargetOptions,
  dependencies: InspectionDependencies = {},
): Promise<PageInspection> {
  const targetUrl = redactUrl(target.url);
  const empty = (status: InspectionStatus, error: { code: string; message: string } | null, robotsAllowed: boolean | null, robotsReason: string): PageInspection => ({
    status,
    targetUrl,
    finalUrl: targetUrl,
    reachable: false,
    robotsAllowed,
    robotsReason: redactText(robotsReason, 500),
    httpStatus: null,
    contentType: null,
    etag: null,
    lastModified: null,
    responseBytes: 0,
    latencyMs: 0,
    redirectOrigins: [],
    document: null,
    error: error ? { code: error.code, message: redactText(error.message, 500) } : null,
  });

  try {
    validatePublicHttpsUrl(target.url);
  } catch (error) {
    return empty('blocked_target', { code: safetyCode(error), message: (error as Error).message }, null, 'Target rejected before network access.');
  }

  const rateLimiter = options.rateLimiter ?? new OriginRateLimiter(1_000);
  const robotsCheck = dependencies.checkRobots ?? checkRobotsCompliance;
  let robots: RobotsDecision;
  try {
    robots = await robotsCheck(target.url, { timeoutMs: options.timeoutMs, rateLimiter });
  } catch (error) {
    return empty(mapError(error), { code: safetyCode(error), message: (error as Error).message }, null, 'robots.txt could not be established safely.');
  }
  if (!robots.allowed) {
    return empty('robots_disallowed', null, false, robots.reason);
  }

  const fetchPage = dependencies.fetchPage ?? safeFetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let response: SafeHttpResponse | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      response = await fetchPage(target.url, {
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        maxRedirects: 5,
        authorizedRedirectOrigins: target.authorizedRedirectOrigins,
        rateLimiter,
      });
      if (![408, 429].includes(response.status) && response.status < 500) break;
      if (attempt >= options.maxRetries) break;
    } catch (error) {
      lastError = error;
      if (attempt >= options.maxRetries || !isTransient(error)) break;
    }
    await sleep(Math.min(2_000, 250 * (2 ** attempt)));
  }
  if (!response) {
    const error = lastError as Error | undefined;
    return empty(mapError(lastError), { code: safetyCode(lastError), message: error?.message ?? 'Target request failed.' }, true, robots.reason);
  }

  const contentType = response.headers.get('content-type');
  const base: Omit<PageInspection, 'status' | 'document' | 'error'> = {
    targetUrl,
    finalUrl: redactUrl(response.url),
    reachable: true,
    robotsAllowed: true,
    robotsReason: redactText(robots.reason, 500),
    httpStatus: response.status,
    contentType: contentType?.split(';')[0]?.trim().toLowerCase() ?? null,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    responseBytes: response.responseBytes,
    latencyMs: response.latencyMs,
    redirectOrigins: response.redirectOrigins.map(redactUrl),
  };
  if (response.status === 429) return { ...base, status: 'rate_limited', document: null, error: { code: 'RATE_LIMITED', message: 'Target returned HTTP 429.' } };
  if (response.status === 408) return { ...base, status: 'timeout', document: null, error: { code: 'HTTP_TIMEOUT', message: 'Target returned HTTP 408.' } };
  if (response.status >= 500) return { ...base, status: 'unreachable', document: null, error: { code: 'UPSTREAM_ERROR', message: `Target returned HTTP ${response.status}.` } };
  if (response.status < 200 || response.status >= 300) {
    return { ...base, status: 'invalid_response', document: null, error: { code: 'HTTP_ERROR', message: `Target returned HTTP ${response.status}.` } };
  }
  if (!contentKind(contentType)) {
    return { ...base, status: 'unsupported_content', document: null, error: { code: 'UNSUPPORTED_CONTENT', message: `Unsupported content type '${contentType ?? 'missing'}'.` } };
  }
  try {
    const document = extractDocument(response.body, contentType, target);
    return { ...base, status: 'ok', document, error: null };
  } catch (error) {
    return { ...base, status: 'invalid_response', document: null, error: { code: 'EXTRACTION_FAILED', message: redactText((error as Error).message, 500) } };
  }
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof SafeFetchError)) return false;
  return ['TIMEOUT', 'DNS_FAILURE', 'NETWORK_ERROR'].includes(error.code);
}

function mapError(error: unknown): InspectionStatus {
  const code = safetyCode(error);
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'RESPONSE_TOO_LARGE') return 'response_too_large';
  if (['BLOCKED_TARGET', 'INVALID_URL', 'CROSS_ORIGIN_REDIRECT'].includes(code)) return 'blocked_target';
  if (['DNS_FAILURE', 'NETWORK_ERROR'].includes(code)) return 'unreachable';
  return 'invalid_response';
}

function safetyCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'INVALID_RESPONSE';
}
