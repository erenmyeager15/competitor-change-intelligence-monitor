import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractDocument } from '../src/extraction/extract.js';
import { classifyChanges, highestSeverity, meetsMateriality } from '../src/intelligence/classify.js';
import { normalizeDocument } from '../src/intelligence/normalize.js';
import type { ConfidenceSignals, NormalizedFact, NormalizedSnapshot } from '../src/intelligence/types.js';
import type { ChangeType, TargetInput } from '../src/types.js';

const target: TargetInput = {
  name: 'Northstar pricing',
  url: 'https://example.com/pricing',
  changeTypes: ['price', 'availability', 'product_feature', 'pricing_plan', 'terms_policy'],
  currency: 'USD',
};

async function fixture(version: 1 | 2): Promise<NormalizedSnapshot> {
  const body = await readFile(new URL(`../../fixtures/change-page-v${version}.html`, import.meta.url), 'utf8');
  return normalizeDocument(extractDocument(body, 'text/html; charset=utf-8', target), target);
}

test('classifies fixture changes with stable IDs, deltas, materiality, confidence, and evidence', async () => {
  const input = { targetIdentityHash: 'a'.repeat(64), previous: await fixture(1), current: await fixture(2) };
  const first = classifyChanges(input);
  const second = classifyChanges(input);
  assert.deepEqual(first.map((change) => change.changeId), second.map((change) => change.changeId));
  assert.deepEqual([...new Set(first.map((change) => change.category))].sort(), ['price', 'pricing_plan', 'product_feature', 'terms_policy']);
  const price = first.find((change) => change.field.endsWith('.price'));
  assert.equal(price?.previousValue, 29);
  assert.equal(price?.currentValue, 35);
  assert.equal(price?.delta, 6);
  assert.equal(price?.deltaPercent, 20.6897);
  assert.equal(price?.severity, 'medium');
  assert.equal(price?.confidence, 'high');
  assert.ok((price?.confidenceScore ?? 0) <= 100);
  assert.equal(highestSeverity(first), 'high');
  assert.equal(first.some((change) => change.category === 'terms_policy' && change.severity === 'high'), true);
  assert.equal(meetsMateriality('medium', 'medium'), true);
  assert.equal(meetsMateriality('low', 'medium'), false);
  for (const change of first) {
    assert.equal(change.changeId.length, 64);
    assert.ok((change.evidence.previousExcerpt?.length ?? 0) <= 300);
    assert.ok((change.evidence.currentExcerpt?.length ?? 0) <= 300);
  }
});

test('classifies removals conservatively and redacts evidence excerpts', () => {
  const signals: ConfidenceSignals = {
    structured: true,
    stableSelector: false,
    identifierPresent: true,
    multipleSources: false,
    packOrUnitKnown: false,
    completePair: true,
  };
  const availability: NormalizedFact = {
    factId: 'product:one:availability',
    category: 'availability',
    field: 'product.one.availability',
    value: 'in_stock',
    evidence: 'Available; owner@example.com',
    sources: ['json_ld'],
    signals,
  };
  const previous = snapshot([availability]);
  const current = snapshot([]);
  const [change] = classifyChanges({ targetIdentityHash: 'b'.repeat(64), previous, current });
  assert.equal(change?.severity, 'high');
  assert.equal(change?.currentValue, null);
  assert.match(change?.evidence.previousExcerpt ?? '', /\[REDACTED_EMAIL\]/);
});

test('covers every change category, severity tier, and confidence band deterministically', () => {
  const structured: ConfidenceSignals = {
    structured: true, stableSelector: false, identifierPresent: true, multipleSources: false, packOrUnitKnown: true, completePair: true,
  };
  const selector: ConfidenceSignals = {
    structured: false, stableSelector: true, identifierPresent: false, multipleSources: false, packOrUnitKnown: false, completePair: true,
  };
  const text: ConfidenceSignals = {
    structured: false, stableSelector: false, identifierPresent: false, multipleSources: false, packOrUnitKnown: false, completePair: true,
  };
  const previous = snapshot([
    fact('price', 'price', 100, text),
    fact('availability', 'availability', 'in_stock', structured),
    fact('feature', 'product_feature', ['Weekly exports'], selector),
    fact('plan', 'pricing_plan', true, selector),
    fact('terms', 'terms_policy', 'Cancel any time', selector),
    fact('release', 'launch_changelog', 'Version 1.0', selector),
    fact('content', 'general_content', 'hash-one', text),
  ]);
  const current = snapshot([
    fact('price', 'price', 101, text),
    fact('availability', 'availability', 'out_of_stock', structured),
    fact('feature', 'product_feature', ['Daily exports'], selector),
    fact('terms', 'terms_policy', 'Annual commitment', selector),
    fact('release', 'launch_changelog', 'Version 1.1', selector),
    fact('content', 'general_content', 'hash-two', text),
    fact('new-plan', 'pricing_plan', true, selector),
  ]);
  const changes = classifyChanges({ targetIdentityHash: 'c'.repeat(64), previous, current });
  assert.deepEqual([...new Set(changes.map((change) => change.category))].sort(), [
    'availability', 'general_content', 'launch_changelog', 'price', 'pricing_plan', 'product_feature', 'terms_policy',
  ]);
  assert.equal(changes.find((change) => change.field === 'test.price')?.severity, 'low');
  assert.equal(changes.find((change) => change.field === 'test.content')?.severity, 'informational');
  assert.equal(changes.find((change) => change.field === 'test.plan')?.severity, 'high');
  assert.equal(changes.find((change) => change.field === 'test.availability')?.confidence, 'high');
  assert.equal(changes.find((change) => change.field === 'test.price')?.confidence, 'low');
  assert.equal(changes.find((change) => change.field === 'test.new-plan')?.confidence, 'medium');
});

function snapshot(facts: NormalizedFact[]): NormalizedSnapshot {
  return {
    intelligenceSchemaVersion: 1,
    canonicalUrl: 'https://example.com/',
    title: null,
    description: null,
    headings: [],
    products: [],
    pricingPlans: [],
    policies: [],
    changelog: [],
    generalContent: null,
    facts,
  };
}

function fact(factId: string, category: ChangeType, value: NormalizedFact['value'], signals: ConfidenceSignals): NormalizedFact {
  return {
    factId,
    category,
    field: `test.${factId}`,
    value,
    evidence: `${factId}: ${String(value)}`,
    sources: signals.structured ? ['json_ld'] : signals.stableSelector ? ['pricing_selector'] : ['visible_text'],
    signals,
  };
}
