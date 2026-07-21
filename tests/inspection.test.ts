import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectTarget } from '../src/inspection.js';
import { SafeFetchError, type SafeHttpResponse } from '../src/security/network.js';
import type { TargetInput } from '../src/types.js';

const target: TargetInput = {
  name: 'Example', url: 'https://example.com/pricing', changeTypes: ['price'],
};
const options = { timeoutMs: 1_000, maxResponseBytes: 65_536, maxRetries: 1 };

function page(status: number, body: string, contentType = 'text/html'): SafeHttpResponse {
  return {
    status,
    body,
    headers: new Headers({ 'content-type': contentType }),
    url: target.url,
    redirectOrigins: [],
    responseBytes: body.length,
    latencyMs: 5,
  };
}

const robotsAllowed = async () => ({
  allowed: true, robotsUrl: 'https://example.com/robots.txt', status: 200, reason: 'Allowed.',
});

test('stops before page fetch when robots disallows the target', async () => {
  let fetched = false;
  const result = await inspectTarget(target, options, {
    checkRobots: async () => ({ allowed: false, robotsUrl: 'https://example.com/robots.txt', status: 200, reason: 'Disallowed.' }),
    fetchPage: async () => { fetched = true; return page(200, '<main>never</main>'); },
  });
  assert.equal(result.status, 'robots_disallowed');
  assert.equal(fetched, false);
});

test('returns a redacted structured inspection for a successful page', async () => {
  const result = await inspectTarget(target, options, {
    checkRobots: robotsAllowed,
    fetchPage: async () => page(200, '<html><title>Plan</title><main>$29 owner@example.com</main></html>'),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.reachable, true);
  assert.ok(result.document?.visibleText.includes('[REDACTED_EMAIL]'));
});

test('retries transient HTTP failures and succeeds', async () => {
  let attempts = 0;
  const result = await inspectTarget(target, options, {
    checkRobots: robotsAllowed,
    fetchPage: async () => {
      attempts += 1;
      return attempts === 1 ? page(503, 'busy', 'text/plain') : page(200, 'ready', 'text/plain');
    },
    sleep: async () => undefined,
  });
  assert.equal(attempts, 2);
  assert.equal(result.status, 'ok');
});

test('classifies unsupported content and bounded-response failures', async () => {
  const unsupported = await inspectTarget(target, options, {
    checkRobots: robotsAllowed,
    fetchPage: async () => page(200, 'png', 'image/png'),
  });
  assert.equal(unsupported.status, 'unsupported_content');

  const tooLarge = await inspectTarget(target, options, {
    checkRobots: robotsAllowed,
    fetchPage: async () => { throw new SafeFetchError('RESPONSE_TOO_LARGE', 'Too large.'); },
  });
  assert.equal(tooLarge.status, 'response_too_large');
});

test('does not classify an ordinary HTTP error page as a successful inspection', async () => {
  const result = await inspectTarget(target, options, {
    checkRobots: robotsAllowed,
    fetchPage: async () => page(404, '<html><title>Not found</title></html>'),
  });
  assert.equal(result.status, 'invalid_response');
  assert.equal(result.document, null);
  assert.equal(result.error?.code, 'HTTP_ERROR');
});
