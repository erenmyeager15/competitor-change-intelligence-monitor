import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedPublicTarget } from '../src/security/target.js';
import { MAX_WEBHOOK_PAYLOAD_BYTES, WebhookDeliveryError, sendWebhook, validateWebhookUrl } from '../src/delivery/webhook.js';
import type { WebhookPayload } from '../src/delivery/types.js';

const target: ResolvedPublicTarget = {
  url: new URL('https://hooks.example.com/incoming'),
  address: '93.184.216.34',
  family: 4,
  resolvedAddresses: ['93.184.216.34'],
};

function payload(explanation = 'Price changed.'): WebhookPayload {
  return {
    schemaVersion: 1,
    deliveryId: 'a'.repeat(64),
    mode: 'immediate',
    generatedAt: '2026-07-21T10:00:00.000Z',
    runUrl: null,
    totalEligibleChanges: 1,
    changes: [{
      changeId: 'change-1', targetName: 'Northstar', targetUrl: 'https://example.com/pricing',
      category: 'price', field: 'price', severity: 'high', confidenceScore: 95, confidence: 'high',
      explanation, recommendedAction: 'Review margin.', previousExcerpt: '$10', currentExcerpt: '$12',
    }],
  };
}

test('webhook validation rejects local, private, and credential-bearing URLs', () => {
  for (const url of [
    'https://localhost/hook',
    'https://127.0.0.1/hook',
    'https://hooks.example.com/hook?token=secret',
    'http://hooks.example.com/hook',
  ]) assert.throws(() => validateWebhookUrl(url), WebhookDeliveryError);
});

test('transient HTTP errors retry with fresh DNS resolution', async () => {
  let resolutions = 0;
  let requests = 0;
  const result = await sendWebhook('https://hooks.example.com/incoming', payload(), { timeoutMs: 3_000, maxRetries: 2 }, {
    resolveTarget: async () => { resolutions += 1; return target; },
    requestPinned: async () => { requests += 1; return { statusCode: requests === 1 ? 500 : 204, responseBytes: 0 }; },
    sleep: async () => undefined,
  });
  assert.equal(result.attempts, 2);
  assert.equal(resolutions, 2);
  assert.equal(requests, 2);
});

test('redirect responses fail closed without retrying', async () => {
  let attempts = 0;
  await assert.rejects(
    sendWebhook('https://hooks.example.com/incoming', payload(), { timeoutMs: 3_000, maxRetries: 2 }, {
      resolveTarget: async () => target,
      requestPinned: async () => { attempts += 1; return { statusCode: 302, responseBytes: 0 }; },
      sleep: async () => undefined,
    }),
    (error: unknown) => error instanceof WebhookDeliveryError && error.code === 'WEBHOOK_REDIRECT',
  );
  assert.equal(attempts, 1);
});

test('oversize payloads fail before DNS or network work', async () => {
  let resolved = false;
  await assert.rejects(
    sendWebhook('https://hooks.example.com/incoming', payload('x'.repeat(MAX_WEBHOOK_PAYLOAD_BYTES)), {}, {
      resolveTarget: async () => { resolved = true; return target; },
    }),
    (error: unknown) => error instanceof WebhookDeliveryError && error.code === 'WEBHOOK_PAYLOAD_TOO_LARGE',
  );
  assert.equal(resolved, false);
});

test('network failures use bounded retries and redact secret query values', async () => {
  let attempts = 0;
  await assert.rejects(
    sendWebhook('https://hooks.example.com/incoming', payload(), { timeoutMs: 3_000, maxRetries: 1 }, {
      resolveTarget: async () => target,
      requestPinned: async () => {
        attempts += 1;
        throw new Error('network failed at https://hooks.example.com/incoming?token=do-not-leak');
      },
      sleep: async () => undefined,
    }),
    (error: unknown) => error instanceof WebhookDeliveryError
      && error.code === 'WEBHOOK_NETWORK_ERROR'
      && !error.message.includes('do-not-leak'),
  );
  assert.equal(attempts, 2);
});
