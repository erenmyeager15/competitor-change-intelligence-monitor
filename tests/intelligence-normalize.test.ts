import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractDocument } from '../src/extraction/extract.js';
import {
  normalizeCurrency,
  normalizeDate,
  normalizeDecimal,
  normalizeDocument,
  normalizeModelIdentifier,
  normalizePackQuantity,
  normalizeUnit,
  normalizeUrl,
  suppressNoise,
} from '../src/intelligence/normalize.js';
import type { TargetInput } from '../src/types.js';

const target: TargetInput = {
  name: 'Northstar pricing',
  url: 'https://example.com/pricing',
  changeTypes: ['price', 'availability', 'product_feature', 'pricing_plan', 'terms_policy'],
  currency: 'USD',
};

test('normalizes decimal, currency, unit, pack, model, date, and URL values conservatively', () => {
  assert.equal(normalizeDecimal('USD 1,299.50'), 1299.5);
  assert.equal(normalizeDecimal('EUR 1.299,50'), 1299.5);
  assert.equal(normalizeDecimal('29,99'), 29.99);
  assert.equal(normalizeDecimal('(1,250)'), -1250);
  assert.equal(normalizeCurrency('EUR 29'), 'EUR');
  assert.equal(normalizeCurrency('$29', 'usd'), 'USD');
  assert.equal(normalizeCurrency('$29'), null);
  assert.equal(normalizeUnit('500 milliliters'), 'ml');
  assert.equal(normalizeUnit('$29 per month'), 'month');
  assert.equal(normalizePackQuantity('Pack of 12 bottles'), '12');
  assert.equal(normalizePackQuantity('24 pcs'), '24');
  assert.equal(normalizePackQuantity('Model 123'), null);
  assert.equal(normalizeModelIdentifier(' ab-12 / x '), 'AB12X');
  assert.equal(normalizeDate('September 1, 2026'), '2026-09-01');
  assert.equal(normalizeDate('03/04/2026'), '03/04/2026');
  assert.equal(
    normalizeUrl('/product?utm_source=test&variant=blue&cachebuster=3#details', 'https://example.com/pricing'),
    'https://example.com/product?variant=blue',
  );
});

test('suppresses volatile noise while retaining business-critical values', () => {
  const value = suppressNoise(
    'Version 2.4 costs $29 effective 2026-09-01. Session ID: abcdef123. Page rendered at 2026-07-21T10:20:30Z. Ignore this.',
    ['Ignore this.'],
  );
  assert.match(value, /Version 2\.4 costs \$29 effective 2026-09-01/);
  assert.doesNotMatch(value, /abcdef123|2026-07-21T10:20:30Z|Ignore this/);
});

test('extracts one product from nested Product and Offer JSON-LD and creates selected normalized facts', async () => {
  const body = await readFile(new URL('../../fixtures/change-page-v1.html', import.meta.url), 'utf8');
  const document = extractDocument(body, 'text/html; charset=utf-8', target);
  assert.equal(document.productOffers.length, 1);
  const snapshot = normalizeDocument(document, target);
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0]?.price, 29);
  assert.equal(snapshot.products[0]?.currency, 'USD');
  assert.equal(snapshot.pricingPlans[0]?.limits.dashboards, 10);
  assert.ok(snapshot.facts.some((fact) => fact.factId === 'product:northteam:price'));
  assert.ok(snapshot.facts.some((fact) => fact.factId === 'plan:team:limit:dashboards'));
  assert.ok(snapshot.facts.some((fact) => fact.category === 'terms_policy'));
  assert.equal(snapshot.facts.some((fact) => fact.category === 'general_content'), false);
});

test('does not emit facts outside the target change-type selection', async () => {
  const body = await readFile(new URL('../../fixtures/change-page-v1.html', import.meta.url), 'utf8');
  const priceOnly: TargetInput = { ...target, changeTypes: ['price'] };
  const snapshot = normalizeDocument(extractDocument(body, 'text/html', priceOnly), priceOnly);
  assert.ok(snapshot.facts.length > 0);
  assert.ok(snapshot.facts.every((fact) => fact.category === 'price'));
});

test('stores only a bounded general-content excerpt while comparing a full normalized hash', () => {
  const generalTarget: TargetInput = { ...target, changeTypes: ['general_content'] };
  const document = extractDocument(`Stable price $29. ${'public content '.repeat(400)}`, 'text/plain', generalTarget);
  const snapshot = normalizeDocument(document, generalTarget);
  const fact = snapshot.facts.find((entry) => entry.category === 'general_content');
  assert.equal(snapshot.generalContent?.length, 2_000);
  assert.equal(typeof fact?.value, 'string');
  assert.equal((fact?.value as string).length, 64);
  assert.ok((fact?.evidence.length ?? 0) <= 2_000);
});
