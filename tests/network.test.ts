import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  decodeBody,
  OriginRateLimiter,
  safeFetch,
  SafeFetchError,
  type PinnedResponse,
  type SafeNetworkDependencies,
} from '../src/security/network.js';
import type { ResolvedPublicTarget } from '../src/security/target.js';

function pinned(status: number, body = '', headers: Record<string, string> = {}): PinnedResponse {
  return { status, body: Buffer.from(body), headers: new Headers(headers), responseBytes: Buffer.byteLength(body) };
}

function dependencies(responses: PinnedResponse[], seen: string[]): SafeNetworkDependencies {
  return {
    resolveTarget: async (rawUrl: string): Promise<ResolvedPublicTarget> => {
      const url = new URL(rawUrl);
      seen.push(`resolve:${url.toString()}`);
      return { url, address: '93.184.216.34', family: 4, resolvedAddresses: ['93.184.216.34'] };
    },
    requestPinned: async (target) => {
      seen.push(`request:${target.url.toString()}`);
      const response = responses.shift();
      if (!response) throw new Error('Missing mock response.');
      return response;
    },
  };
}

const OPTIONS = { timeoutMs: 1_000, maxResponseBytes: 65_536, maxRedirects: 3 };

test('re-resolves and fetches each same-origin redirect hop', async () => {
  const seen: string[] = [];
  const result = await safeFetch('https://example.com/start', OPTIONS, dependencies([
    pinned(302, '', { location: '/next' }),
    pinned(200, 'done', { 'content-type': 'text/plain' }),
  ], seen));
  assert.equal(result.body, 'done');
  assert.equal(result.url, 'https://example.com/next');
  assert.deepEqual(seen, [
    'resolve:https://example.com/start', 'request:https://example.com/start',
    'resolve:https://example.com/next', 'request:https://example.com/next',
  ]);
});

test('blocks a cross-origin redirect before requesting it', async () => {
  const seen: string[] = [];
  await assert.rejects(
    safeFetch('https://example.com/start', OPTIONS, dependencies([
      pinned(302, '', { location: 'https://cdn.example.net/file' }),
    ], seen)),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'CROSS_ORIGIN_REDIRECT',
  );
  assert.equal(seen.filter((entry) => entry.startsWith('request:')).length, 1);
});

test('permits an explicitly authorized redirect origin', async () => {
  const seen: string[] = [];
  const result = await safeFetch('https://example.com/start', {
    ...OPTIONS,
    authorizedRedirectOrigins: ['https://cdn.example.net'],
  }, dependencies([
    pinned(302, '', { location: 'https://cdn.example.net/file' }),
    pinned(200, 'asset'),
  ], seen));
  assert.equal(result.url, 'https://cdn.example.net/file');
  assert.deepEqual(result.redirectOrigins, ['https://cdn.example.net']);
});

test('detects redirect loops and redirect limits', async () => {
  await assert.rejects(
    safeFetch('https://example.com/a', OPTIONS, dependencies([
      pinned(302, '', { location: '/b' }), pinned(302, '', { location: '/a' }),
    ], [])),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'REDIRECT_LOOP',
  );
  await assert.rejects(
    safeFetch('https://example.com/a', { ...OPTIONS, maxRedirects: 0 }, dependencies([
      pinned(302, '', { location: '/b' }),
    ], [])),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'TOO_MANY_REDIRECTS',
  );
});

test('bounds compressed and decompressed bodies and rejects unknown encodings', () => {
  assert.throws(
    () => decodeBody(Buffer.alloc(65_537), null, 65_536),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'RESPONSE_TOO_LARGE',
  );
  const compressed = zlib.gzipSync(Buffer.alloc(70_000, 'a'));
  assert.throws(
    () => decodeBody(compressed, 'gzip', 65_536),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.throws(
    () => decodeBody(Buffer.from('hello'), 'compress', 65_536),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'UNSUPPORTED_ENCODING',
  );
});

test('rejects unbounded options and unsafe caller-controlled headers', async () => {
  await assert.rejects(
    safeFetch('https://example.com', { ...OPTIONS, timeoutMs: 999 }, dependencies([], [])),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'NETWORK_ERROR',
  );
  await assert.rejects(
    safeFetch('https://example.com', { ...OPTIONS, headers: { Authorization: 'Bearer secret' } }, dependencies([
      pinned(200, 'never'),
    ], [])),
    (error: unknown) => error instanceof SafeFetchError && error.code === 'NETWORK_ERROR',
  );
});

test('serializes requests to the same origin', async () => {
  const limiter = new OriginRateLimiter(15);
  const times: number[] = [];
  await Promise.all([
    limiter.wait('https://example.com').then(() => times.push(Date.now())),
    limiter.wait('https://example.com').then(() => times.push(Date.now())),
    limiter.wait('https://example.com').then(() => times.push(Date.now())),
  ]);
  assert.equal(times.length, 3);
  assert.ok(times[1]! - times[0]! >= 10);
  assert.ok(times[2]! - times[1]! >= 10);
});
