import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import { redactText } from '../security/redaction.js';
import { resolvePublicTarget, validatePublicHttpsUrl, type ResolvedPublicTarget } from '../security/target.js';
import type { WebhookPayload } from './types.js';

export const MAX_WEBHOOK_PAYLOAD_BYTES = 32 * 1024;
export const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

export type WebhookErrorCode =
  | 'INVALID_WEBHOOK'
  | 'WEBHOOK_PAYLOAD_TOO_LARGE'
  | 'WEBHOOK_TIMEOUT'
  | 'WEBHOOK_REDIRECT'
  | 'WEBHOOK_RESPONSE_TOO_LARGE'
  | 'WEBHOOK_HTTP_ERROR'
  | 'WEBHOOK_NETWORK_ERROR';

export class WebhookDeliveryError extends Error {
  constructor(public readonly code: WebhookErrorCode, message: string, public readonly statusCode: number | null = null) {
    super(redactText(message, 500));
    this.name = 'WebhookDeliveryError';
  }
}

export interface WebhookSendOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export interface WebhookSendResult {
  attempts: number;
  statusCode: number;
  responseBytes: number;
}

export interface PinnedWebhookResponse {
  statusCode: number;
  responseBytes: number;
}

export interface WebhookDependencies {
  resolveTarget?: typeof resolvePublicTarget;
  requestPinned?: (target: ResolvedPublicTarget, body: Buffer, timeoutMs: number) => Promise<PinnedWebhookResponse>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function validateWebhookUrl(rawUrl: string): URL {
  try {
    return validatePublicHttpsUrl(rawUrl);
  } catch (error) {
    throw new WebhookDeliveryError('INVALID_WEBHOOK', (error as Error).message);
  }
}

export async function sendWebhook(
  rawUrl: string,
  payload: WebhookPayload,
  options: WebhookSendOptions = {},
  dependencies: WebhookDependencies = {},
): Promise<WebhookSendResult> {
  validateWebhookUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 3_000 || timeoutMs > 15_000) {
    throw new WebhookDeliveryError('INVALID_WEBHOOK', 'Webhook timeout must be an integer from 3000 to 15000 milliseconds.');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new WebhookDeliveryError('INVALID_WEBHOOK', 'Webhook retries must be an integer from zero to two.');
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.byteLength > MAX_WEBHOOK_PAYLOAD_BYTES) {
    throw new WebhookDeliveryError('WEBHOOK_PAYLOAD_TOO_LARGE', `Webhook payload exceeds ${MAX_WEBHOOK_PAYLOAD_BYTES} bytes.`);
  }

  const resolveTarget = dependencies.resolveTarget ?? resolvePublicTarget;
  const requestPinned = dependencies.requestPinned ?? requestPinnedWebhook;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const target = await resolveTarget(rawUrl);
      const response = await requestPinned(target, body, timeoutMs);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { attempts: attempt + 1, statusCode: response.statusCode, responseBytes: response.responseBytes };
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        throw new WebhookDeliveryError('WEBHOOK_REDIRECT', 'Webhook redirects are prohibited.', response.statusCode);
      }
      const error = new WebhookDeliveryError('WEBHOOK_HTTP_ERROR', `Webhook returned HTTP ${response.statusCode}.`, response.statusCode);
      if (!transientStatus(response.statusCode) || attempt >= maxRetries) throw error;
      lastError = error;
    } catch (error) {
      const mapped = mapWebhookError(error);
      lastError = mapped;
      if (!transientError(mapped) || attempt >= maxRetries) throw mapped;
    }
    await sleep(Math.min(2_000, 250 * (2 ** attempt)));
  }
  throw mapWebhookError(lastError);
}

async function requestPinnedWebhook(target: ResolvedPublicTarget, body: Buffer, timeoutMs: number): Promise<PinnedWebhookResponse> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: 'https:',
      hostname: target.address,
      family: target.family,
      port: 443,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'POST',
      servername: net.isIP(target.url.hostname) ? undefined : target.url.hostname,
      rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024,
      headers: {
        Accept: 'application/json, text/plain;q=0.5',
        'Content-Type': 'application/json',
        'Content-Length': String(body.byteLength),
        Host: target.url.host,
        'User-Agent': 'CompetitorChangeIntelligenceMonitor/0.1 (+https://apify.com)',
      },
    };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, value?: PinnedWebhookResponse): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const request = httpsRequest(options, async (response) => {
      try {
        const responseBytes = await consumeBoundedResponse(response, MAX_WEBHOOK_RESPONSE_BYTES);
        finish(undefined, { statusCode: response.statusCode ?? 0, responseBytes });
      } catch (error) {
        finish(error);
      }
    });
    timer = setTimeout(() => {
      request.destroy(new WebhookDeliveryError('WEBHOOK_TIMEOUT', `Webhook timed out after ${timeoutMs} milliseconds.`));
    }, timeoutMs);
    request.once('error', (error) => finish(error));
    request.end(body);
  });
}

async function consumeBoundedResponse(response: IncomingMessage, maxBytes: number): Promise<number> {
  const declared = Number(response.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new WebhookDeliveryError('WEBHOOK_RESPONSE_TOO_LARGE', `Webhook response exceeds ${maxBytes} bytes.`);
  }
  let size = 0;
  for await (const chunk of response) {
    size += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk as Uint8Array);
    if (size > maxBytes) {
      response.destroy();
      throw new WebhookDeliveryError('WEBHOOK_RESPONSE_TOO_LARGE', `Webhook response exceeds ${maxBytes} bytes.`);
    }
  }
  return size;
}

function transientStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function transientError(error: WebhookDeliveryError): boolean {
  return ['WEBHOOK_TIMEOUT', 'WEBHOOK_NETWORK_ERROR'].includes(error.code)
    || (error.code === 'WEBHOOK_HTTP_ERROR' && transientStatus(error.statusCode ?? 0));
}

function mapWebhookError(error: unknown): WebhookDeliveryError {
  if (error instanceof WebhookDeliveryError) return error;
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (['INVALID_URL', 'BLOCKED_TARGET', 'DNS_FAILURE'].includes(code)) {
    return new WebhookDeliveryError('INVALID_WEBHOOK', (error as Error).message);
  }
  return new WebhookDeliveryError('WEBHOOK_NETWORK_ERROR', (error as Error)?.message ?? 'Webhook request failed.');
}
