import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { allowedOrigins, resolvePublicTarget, type ResolvedPublicTarget } from './target.js';

export const MONITOR_USER_AGENT = 'CompetitorChangeIntelligenceMonitor/0.1 (+https://apify.com)';

export type SafeFetchErrorCode =
  | 'BLOCKED_TARGET'
  | 'INVALID_URL'
  | 'DNS_FAILURE'
  | 'TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_LOOP'
  | 'CROSS_ORIGIN_REDIRECT'
  | 'INVALID_REDIRECT'
  | 'RESPONSE_TOO_LARGE'
  | 'UNSUPPORTED_ENCODING'
  | 'NETWORK_ERROR';

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeHttpResponse {
  status: number;
  headers: Headers;
  body: string;
  url: string;
  redirectOrigins: string[];
  responseBytes: number;
  latencyMs: number;
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects?: number;
  authorizedRedirectOrigins?: string[];
  headers?: Record<string, string>;
  rateLimiter?: OriginRateLimiter;
}

export interface PinnedResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  responseBytes: number;
}

export interface SafeNetworkDependencies {
  resolveTarget?: typeof resolvePublicTarget;
  requestPinned?: (target: ResolvedPublicTarget, options: SafeFetchOptions) => Promise<PinnedResponse>;
}

export class OriginRateLimiter {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastStartedAt = new Map<string, number>();

  constructor(private readonly minimumIntervalMs = 1_000) {}

  async wait(origin: string): Promise<void> {
    const previous = this.tails.get(origin) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const delay = Math.max(0, (this.lastStartedAt.get(origin) ?? 0) + this.minimumIntervalMs - Date.now());
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      this.lastStartedAt.set(origin, Date.now());
    });
    this.tails.set(origin, current);
    try {
      await current;
    } finally {
      if (this.tails.get(origin) === current) this.tails.delete(origin);
    }
  }
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
  dependencies: SafeNetworkDependencies = {},
): Promise<SafeHttpResponse> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 30_000) {
    throw new SafeFetchError('NETWORK_ERROR', 'timeoutMs must be an integer from 1000 to 30000.');
  }
  if (!Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < 65_536 || options.maxResponseBytes > 5_242_880) {
    throw new SafeFetchError('NETWORK_ERROR', 'maxResponseBytes must be an integer from 65536 to 5242880.');
  }
  safeAdditionalHeaders(options.headers);
  const startedAt = Date.now();
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? 5, 0), 5);
  const permittedOrigins = allowedOrigins(rawUrl, options.authorizedRedirectOrigins);
  const visited = new Set<string>();
  const redirectOrigins: string[] = [];
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolveTarget = dependencies.resolveTarget ?? resolvePublicTarget;
    let target: ResolvedPublicTarget;
    try {
      target = await resolveTarget(currentUrl);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'BLOCKED_TARGET';
      if (code === 'INVALID_URL' || code === 'DNS_FAILURE' || code === 'BLOCKED_TARGET') {
        throw new SafeFetchError(code, (error as Error).message);
      }
      throw error;
    }
    if (!permittedOrigins.has(target.url.origin)) {
      throw new SafeFetchError('CROSS_ORIGIN_REDIRECT', 'Redirect target origin was not explicitly authorized.');
    }
    const canonical = target.url.toString();
    if (visited.has(canonical)) throw new SafeFetchError('REDIRECT_LOOP', 'Redirect loop detected.');
    visited.add(canonical);
    await options.rateLimiter?.wait(target.url.origin);

    const pinnedRequest = dependencies.requestPinned ?? requestPinned;
    let response: PinnedResponse;
    try {
      response = await pinnedRequest(target, options);
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      const name = (error as Error).name;
      throw new SafeFetchError(name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', (error as Error).message);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop >= maxRedirects) throw new SafeFetchError('TOO_MANY_REDIRECTS', `Redirect limit of ${maxRedirects} exceeded.`);
      const location = response.headers.get('location');
      if (!location) throw new SafeFetchError('INVALID_REDIRECT', 'Redirect response did not include a Location header.');
      try {
        currentUrl = new URL(location, target.url).toString();
      } catch {
        throw new SafeFetchError('INVALID_REDIRECT', 'Redirect Location could not be parsed.');
      }
      redirectOrigins.push(new URL(currentUrl).origin);
      continue;
    }

    let decoded: Buffer;
    try {
      decoded = decodeBody(response.body, response.headers.get('content-encoding'), options.maxResponseBytes);
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError('NETWORK_ERROR', (error as Error).message);
    }
    return {
      status: response.status,
      headers: response.headers,
      body: decoded.toString('utf8'),
      url: target.url.toString(),
      redirectOrigins,
      responseBytes: response.responseBytes,
      latencyMs: Date.now() - startedAt,
    };
  }
  throw new SafeFetchError('TOO_MANY_REDIRECTS', `Redirect limit of ${maxRedirects} exceeded.`);
}

async function requestPinned(target: ResolvedPublicTarget, options: SafeFetchOptions): Promise<PinnedResponse> {
  if (options.maxResponseBytes < 65_536 || options.maxResponseBytes > 5_242_880) {
    throw new SafeFetchError('NETWORK_ERROR', 'maxResponseBytes is outside the validated range.');
  }
  return new Promise((resolve, reject) => {
    const url = target.url;
    const requestOptions: RequestOptions = {
      protocol: 'https:',
      hostname: target.address,
      family: target.family,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      rejectUnauthorized: true,
      maxHeaderSize: 32 * 1024,
      headers: {
        Accept: 'text/html, application/xhtml+xml, application/json, application/xml, text/xml, text/plain;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        Host: url.host,
        'User-Agent': MONITOR_USER_AGENT,
        ...safeAdditionalHeaders(options.headers),
      },
    };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, value?: PinnedResponse): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const request = httpsRequest(requestOptions, async (response) => {
      try {
        const headers = toHeaders(response.headers);
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          finish(undefined, { status, headers, body: Buffer.alloc(0), responseBytes: 0 });
          return;
        }
        const body = await readBoundedBody(response, options.maxResponseBytes);
        finish(undefined, { status, headers, body, responseBytes: body.byteLength });
      } catch (error) {
        finish(error);
      }
    });
    timer = setTimeout(() => {
      request.destroy(Object.assign(new Error(`Request timed out after ${options.timeoutMs}ms.`), { name: 'AbortError' }));
    }, options.timeoutMs);
    request.once('error', (error) => finish(error));
    request.end();
  });
}

function safeAdditionalHeaders(values: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set(['accept', 'if-none-match', 'if-modified-since']);
  for (const [rawName, value] of Object.entries(values ?? {})) {
    const name = rawName.trim().toLowerCase();
    if (!allowed.has(name)) throw new SafeFetchError('NETWORK_ERROR', `Request header '${rawName}' is not allowed.`);
    if (/\r|\n/.test(value)) throw new SafeFetchError('NETWORK_ERROR', `Request header '${rawName}' contains an invalid line break.`);
    result[name] = value.slice(0, 1_024);
  }
  return result;
}

async function readBoundedBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new SafeFetchError('RESPONSE_TOO_LARGE', `Response exceeds maximum compressed size of ${maxBytes} bytes.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes) {
      response.destroy();
      throw new SafeFetchError('RESPONSE_TOO_LARGE', `Response exceeds maximum compressed size of ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export function decodeBody(body: Buffer, rawEncoding: string | null, maxBytes: number): Buffer {
  if (body.byteLength > maxBytes) throw new SafeFetchError('RESPONSE_TOO_LARGE', `Response exceeds maximum compressed size of ${maxBytes} bytes.`);
  const encoding = rawEncoding?.split(',')[0]?.trim().toLowerCase();
  const zlibOptions = { maxOutputLength: maxBytes };
  try {
    if (!encoding || encoding === 'identity') return body;
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(body, zlibOptions);
    if (encoding === 'deflate') return zlib.inflateSync(body, zlibOptions);
    if (encoding === 'br') return zlib.brotliDecompressSync(body, zlibOptions);
    throw new SafeFetchError('UNSUPPORTED_ENCODING', `Unsupported content encoding '${encoding}'.`);
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new SafeFetchError('RESPONSE_TOO_LARGE', `Decoded response exceeds maximum size of ${maxBytes} bytes.`);
    }
    throw new SafeFetchError('NETWORK_ERROR', 'Response decompression failed.');
  }
}

function toHeaders(values: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}
