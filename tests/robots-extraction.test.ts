import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractDocument, contentKind } from '../src/extraction/extract.js';
import { validateSelector } from '../src/extraction/selectors.js';
import { redactText, redactUnknown, redactUrl } from '../src/security/redaction.js';
import { checkRobotsCompliance } from '../src/security/robots.js';
import type { SafeHttpResponse } from '../src/security/network.js';
import type { TargetInput } from '../src/types.js';

function response(status: number, body: string): SafeHttpResponse {
  return { status, body, headers: new Headers({ 'content-type': 'text/plain' }), url: 'https://example.com/robots.txt', redirectOrigins: [], responseBytes: body.length, latencyMs: 1 };
}

const target: TargetInput = {
  name: 'Northstar pricing',
  url: 'https://example.com/pricing',
  changeTypes: ['price', 'pricing_plan'],
  includeSelectors: ['main'],
  excludeSelectors: ['.noise'],
};

test('robots policy allows, disallows, and fails closed for restricted policy files', async () => {
  const allowed = await checkRobotsCompliance(target.url, { timeoutMs: 1_000 }, {
    fetchRobots: async () => response(200, 'User-agent: *\nAllow: /'),
  });
  assert.equal(allowed.allowed, true);
  const blocked = await checkRobotsCompliance(target.url, { timeoutMs: 1_000 }, {
    fetchRobots: async () => response(200, 'User-agent: *\nDisallow: /pricing'),
  });
  assert.equal(blocked.allowed, false);
  assert.equal((await checkRobotsCompliance(target.url, { timeoutMs: 1_000 }, {
    fetchRobots: async () => response(404, ''),
  })).allowed, true);
  assert.equal((await checkRobotsCompliance(target.url, { timeoutMs: 1_000 }, {
    fetchRobots: async () => response(403, ''),
  })).allowed, false);
});

test('extracts bounded HTML facts and keeps nested offer facts on the product', async () => {
  const body = await readFile(new URL('../../fixtures/change-page-v1.html', import.meta.url), 'utf8');
  const document = extractDocument(body, 'text/html; charset=utf-8', target);
  assert.equal(document.kind, 'html');
  assert.ok(document.visibleText.includes('Northstar'));
  assert.equal(document.visibleText.includes('ignore me'), false);
  const product = document.productOffers.find((entry) => entry.sku === 'NORTH-TEAM');
  assert.equal(product?.price, '29');
  assert.equal(product?.priceCurrency, 'USD');
  assert.equal(product?.availability, 'https://schema.org/InStock');
});

test('extracts and redacts JSON, XML, and plain text without retaining raw markup', () => {
  const json = extractDocument('{"price":29,"token":"secret","email":"owner@example.com"}', 'application/json', target);
  assert.equal(json.structuredFields['$.token'], '[REDACTED]');
  assert.equal(json.structuredFields['$.email'], '[REDACTED_EMAIL]');
  const xml = extractDocument('<root><price>29</price><password>secret</password></root>', 'application/xml', target);
  assert.equal(xml.structuredFields['$.root.password'], '[REDACTED]');
  const text = extractDocument('Email owner@example.com or call +1 415 555 0100', 'text/plain', target);
  assert.ok(text.visibleText.includes('[REDACTED_EMAIL]'));
  assert.ok(text.visibleText.includes('[REDACTED_PHONE]'));
});

test('rejects unsupported content, invalid documents, and complexity-sensitive selectors', () => {
  assert.equal(contentKind('image/png'), null);
  assert.throws(() => extractDocument('x', 'image/png', target), /Unsupported content/);
  assert.throws(() => extractDocument('{bad', 'application/json', target), /could not be parsed safely/);
  for (const selector of ['*', 'body *', 'article:has(a)', 'li:nth-child(2)']) {
    assert.throws(() => validateSelector(selector), /Selector/, selector);
  }
  assert.equal(validateSelector('main .price[data-plan="team"]'), 'main .price[data-plan="team"]');
});

test('redacts secrets and contact data from text, URLs, and nested objects', () => {
  const text = redactText('Bearer abc.def secret=hello owner@example.com +44 20 7946 0958');
  assert.equal(text.includes('abc.def'), false);
  assert.ok(text.includes('[REDACTED_EMAIL]'));
  assert.ok(text.includes('[REDACTED_PHONE]'));
  const url = redactUrl('https://example.com/path?token=abc&q=owner%40example.com#frag');
  assert.equal(url.includes('abc'), false);
  assert.equal(url.includes('#'), false);
  assert.ok(url.includes('%5BREDACTED%5D'));
  assert.deepEqual(redactUnknown({ apiKey: 'abc', nested: { email: 'a@example.com' } }), {
    apiKey: '[REDACTED]', nested: { email: '[REDACTED_EMAIL]' },
  });
  assert.equal(redactText('Published 2026-07-21; GTIN 1234567890123'), 'Published 2026-07-21; GTIN 1234567890123');
});
