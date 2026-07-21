import type { ExtractedDocument, ExtractedPricingPlan, ProductOfferFacts } from '../extraction/extract.js';
import { sha256 } from '../baseline/canonical.js';
import { redactText, redactUrl } from '../security/redaction.js';
import type { TargetInput } from '../types.js';
import {
  INTELLIGENCE_SCHEMA_VERSION,
  type ConfidenceSignals,
  type NormalizedFact,
  type NormalizedPricingPlan,
  type NormalizedProduct,
  type NormalizedSnapshot,
} from './types.js';

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };
const VOLATILE_QUERY = /^(?:utm_.+|gclid|fbclid|msclkid|cache(?:buster)?|cb|_|timestamp|ts|session(?:id)?)$/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const VOLATILE_LABEL = /\b(?:session|request|render|cache)[ _-]?(?:id|key|token)\s*[:=]\s*[A-Za-z0-9._-]{6,}\b/gi;
const RENDER_TIMESTAMP = /\b(?:page\s+rendered|generated|rendered)\s+(?:at|on)\s+\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+(?:Z|UTC)?\b/gi;

export function normalizeDocument(document: ExtractedDocument, target: TargetInput): NormalizedSnapshot {
  const products = document.productOffers.map((product, index) => normalizeProduct(product, index, target));
  const pricingPlans = document.semanticSections.pricingPlans.map((plan) => normalizePricingPlan(plan, target));
  const policies = document.semanticSections.policies.map((section, index) => {
    const text = suppressNoise(section.text, target.ignoreTextPatterns);
    return {
      id: slug(section.heading ?? `section-${index + 1}`),
      heading: nullable(section.heading),
      text,
      effectiveDate: extractDate(text),
    };
  }).filter((section) => section.text);
  const changelog = document.semanticSections.changelog.map((section, index) => {
    const text = suppressNoise(section.text, target.ignoreTextPatterns);
    return {
      id: slug(section.heading ?? `entry-${index + 1}`),
      heading: nullable(section.heading),
      text,
      date: extractDate(text),
      version: text.match(/\bv(?:ersion)?\s*([0-9]+(?:\.[0-9A-Za-z-]+)+)\b/i)?.[1] ?? null,
    };
  }).filter((section) => section.text);
  const facts: NormalizedFact[] = [];
  const structuredPriceExists = products.some((product) => product.price !== null);

  for (const product of products) addProductFacts(facts, product);
  for (const plan of pricingPlans) addPricingPlanFacts(facts, plan, document.semanticSections.pricingPlans, structuredPriceExists);
  for (const policy of policies) {
    addFact(facts, target, {
      factId: `policy:${policy.id}:text`, category: 'terms_policy', field: `policy.${policy.id}.text`, value: policy.text,
      evidence: policy.text, sources: ['policy_selector'], signals: selectorSignals(false),
    });
    if (policy.effectiveDate) addFact(facts, target, {
      factId: `policy:${policy.id}:effective-date`, category: 'terms_policy', field: `policy.${policy.id}.effectiveDate`, value: policy.effectiveDate,
      evidence: policy.text, sources: ['policy_selector'], signals: selectorSignals(false),
    });
  }
  for (const entry of changelog) {
    addFact(facts, target, {
      factId: `changelog:${entry.id}:text`, category: 'launch_changelog', field: `changelog.${entry.id}.text`, value: entry.text,
      evidence: entry.text, sources: ['changelog_selector'], signals: selectorSignals(false),
    });
    if (entry.version) addFact(facts, target, {
      factId: `changelog:${entry.id}:version`, category: 'launch_changelog', field: `changelog.${entry.id}.version`, value: entry.version,
      evidence: entry.text, sources: ['changelog_selector'], signals: selectorSignals(false),
    });
  }

  const normalizedGeneralContent = target.changeTypes.includes('general_content')
    ? suppressNoise(document.visibleText, target.ignoreTextPatterns)
    : null;
  const generalContent = normalizedGeneralContent?.slice(0, 2_000) ?? null;
  if (normalizedGeneralContent) addFact(facts, target, {
    factId: 'page:general-content', category: 'general_content', field: 'page.generalContentHash', value: sha256(normalizedGeneralContent),
    evidence: generalContent ?? '', sources: ['visible_text'], signals: textSignals(),
  });

  return {
    intelligenceSchemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    canonicalUrl: normalizeUrl(document.canonicalUrl ?? target.url, target.url),
    title: nullable(suppressNoise(document.title ?? '', target.ignoreTextPatterns)),
    description: nullable(suppressNoise(document.description ?? '', target.ignoreTextPatterns)),
    headings: document.headings.map((heading) => suppressNoise(heading, target.ignoreTextPatterns)).filter(Boolean).slice(0, 100),
    products: products.sort((left, right) => left.id.localeCompare(right.id)),
    pricingPlans: pricingPlans.sort((left, right) => left.id.localeCompare(right.id)),
    policies: policies.sort((left, right) => left.id.localeCompare(right.id)),
    changelog: changelog.sort((left, right) => left.id.localeCompare(right.id)),
    generalContent,
    facts: deduplicateFacts(facts)
      .filter((fact) => target.changeTypes.includes(fact.category))
      .sort((left, right) => left.factId.localeCompare(right.factId)),
  };
}

export function suppressNoise(value: string, ignorePatterns: string[] = []): string {
  let result = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  result = result.replace(UUID, '[volatile-id]').replace(VOLATILE_LABEL, '[volatile-id]').replace(RENDER_TIMESTAMP, '[render-time]');
  for (const pattern of ignorePatterns.slice(0, 10)) {
    const expression = globExpression(pattern);
    result = result.replace(expression, ' ');
  }
  return redactText(result.replace(/\s+/g, ' ').trim(), 50_000);
}

export function normalizeDecimal(value: string): number | null {
  const negative = /^\s*-/.test(value) || /^\s*\(.*\)\s*$/.test(value);
  let numeric = value.replace(/[^0-9.,]/g, '');
  if (!numeric) return null;
  const comma = numeric.lastIndexOf(',');
  const dot = numeric.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    numeric = numeric.replace(thousands, '').replace(decimal, '.');
  } else {
    const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
    if (separator) {
      const parts = numeric.split(separator);
      const last = parts.at(-1) ?? '';
      numeric = last.length > 0 && last.length <= 2
        ? `${parts.slice(0, -1).join('')}.${last}`
        : parts.join('');
    }
  }
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

export function normalizeCurrency(value: string, fallback?: string): string | null {
  const explicit = value.match(/\b[A-Z]{3}\b/i)?.[0].toUpperCase();
  if (explicit) return explicit;
  for (const [symbol, currency] of Object.entries(CURRENCY_SYMBOLS)) if (value.includes(symbol)) return currency;
  if (value.includes('$')) return fallback?.toUpperCase() ?? null;
  return fallback?.toUpperCase() ?? null;
}

export function normalizeUnit(value: string): string | null {
  const normalized = value.toLowerCase().replace(/\./g, '').trim();
  const units: Array<[RegExp, string]> = [
    [/\b(?:kilograms?|kgs?)\b/, 'kg'], [/\b(?:grams?|gms?)\b/, 'g'], [/\b(?:litres?|liters?|ltrs?)\b/, 'l'],
    [/\b(?:millilitres?|milliliters?|mls?)\b/, 'ml'], [/\b(?:metres?|meters?|mtrs?)\b/, 'm'], [/\b(?:centimetres?|centimeters?|cms?)\b/, 'cm'],
    [/\b(?:pieces?|pcs?)\b/, 'piece'], [/\b(?:months?|mo)\b/, 'month'], [/\b(?:years?|yr)\b/, 'year'],
  ];
  return units.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

export function normalizePackQuantity(value: string): string | null {
  const match = value.match(/\b(?:pack\s+of|qty|quantity)\s*[:=]?\s*(\d{1,5})\b/i)
    ?? value.match(/\b(\d{1,5})\s*(?:pack|pk|pcs?|pieces?|units?)\b/i)
    ?? value.match(/\b(\d{1,5})\s*[x×]\b/i);
  return match?.[1] ?? null;
}

export function normalizeModelIdentifier(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const iso = trimmed.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso && validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const monthFirst = trimmed.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (monthFirst) return dateParts(Number(monthFirst[3]), monthNumber(monthFirst[1]!), Number(monthFirst[2]), trimmed);
  const dayFirst = trimmed.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (dayFirst) return dateParts(Number(dayFirst[3]), monthNumber(dayFirst[2]!), Number(dayFirst[1]), trimmed);
  return suppressNoise(trimmed);
}

export function normalizeUrl(value: string, base: string): string {
  try {
    const url = new URL(value, base);
    for (const key of [...url.searchParams.keys()]) if (VOLATILE_QUERY.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    url.hash = '';
    return redactUrl(url.toString());
  } catch {
    return redactText(value, 2_048);
  }
}

function normalizeProduct(product: ProductOfferFacts, index: number, target: TargetInput): NormalizedProduct {
  const originalModel = nullable(product.model);
  const idSource = product.sku ?? product.gtin ?? product.mpn ?? product.model ?? product.name ?? `product-${index + 1}`;
  return {
    id: slug(normalizeModelIdentifier(idSource) || `product-${index + 1}`),
    name: nullable(product.name),
    sku: nullable(product.sku),
    gtin: nullable(product.gtin),
    mpn: nullable(product.mpn),
    brand: nullable(product.brand),
    model: originalModel ? normalizeModelIdentifier(originalModel) : null,
    originalModel,
    price: product.price ? normalizeDecimal(product.price) : null,
    currency: normalizeCurrency(product.priceCurrency ?? product.price ?? '', target.currency),
    availability: product.availability ? normalizeAvailability(product.availability) : null,
    url: product.url ? normalizeUrl(product.url, target.url) : null,
  };
}

function normalizePricingPlan(plan: ExtractedPricingPlan, target: TargetInput): NormalizedPricingPlan {
  const features = plan.features.map((feature) => suppressNoise(feature, target.ignoreTextPatterns)).filter(Boolean).sort();
  const limits: Record<string, number> = {};
  for (const feature of features) {
    const match = feature.match(/\b(\d[\d,.]*)\s+([A-Za-z][A-Za-z0-9 -]{1,40})\b/);
    const value = match ? normalizeDecimal(match[1]!) : null;
    if (match && value !== null) limits[slug(match[2]!)] = value;
  }
  const priceText = plan.priceText ?? '';
  return {
    id: slug(plan.name),
    name: suppressNoise(plan.name),
    price: normalizeDecimal(priceText),
    currency: normalizeCurrency(priceText, target.currency),
    billingInterval: normalizeUnit(priceText),
    availability: plan.availabilityText ? normalizeAvailability(plan.availabilityText) : null,
    features,
    limits: Object.fromEntries(Object.entries(limits).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function addProductFacts(facts: NormalizedFact[], product: NormalizedProduct): void {
  const signals = structuredSignals(Boolean(product.sku || product.gtin || product.mpn || product.model));
  if (product.price !== null) facts.push({
    factId: `product:${product.id}:price`, category: 'price', field: `product.${product.id}.price`, value: product.price,
    evidence: `${product.name ?? product.id}: ${product.currency ?? ''} ${product.price}`.trim(), sources: ['json_ld'],
    ...(product.currency ? { currency: product.currency } : {}), signals,
  });
  if (product.currency) facts.push({
    factId: `product:${product.id}:currency`, category: 'price', field: `product.${product.id}.currency`, value: product.currency,
    evidence: `${product.name ?? product.id}: ${product.currency}`, sources: ['json_ld'], signals,
  });
  if (product.availability) facts.push({
    factId: `product:${product.id}:availability`, category: 'availability', field: `product.${product.id}.availability`, value: product.availability,
    evidence: `${product.name ?? product.id}: ${product.availability}`, sources: ['json_ld'], signals,
  });
}

function addPricingPlanFacts(facts: NormalizedFact[], plan: NormalizedPricingPlan, rawPlans: ExtractedPricingPlan[], structuredPriceExists: boolean): void {
  const raw = rawPlans.find((candidate) => slug(candidate.name) === plan.id);
  const evidence = raw?.evidence ?? plan.name;
  const signals = selectorSignals(false);
  facts.push({ factId: `plan:${plan.id}:exists`, category: 'pricing_plan', field: `pricingPlan.${plan.id}.exists`, value: true, evidence, sources: ['pricing_selector'], signals });
  if (!structuredPriceExists && plan.price !== null) facts.push({
    factId: `plan:${plan.id}:price`, category: 'price', field: `pricingPlan.${plan.id}.price`, value: plan.price,
    evidence, sources: ['pricing_selector'], ...(plan.currency ? { currency: plan.currency } : {}), signals,
  });
  if (plan.billingInterval) facts.push({
    factId: `plan:${plan.id}:billing`, category: 'pricing_plan', field: `pricingPlan.${plan.id}.billingInterval`, value: plan.billingInterval,
    evidence, sources: ['pricing_selector'], signals,
  });
  facts.push({
    factId: `plan:${plan.id}:features`, category: 'product_feature', field: `pricingPlan.${plan.id}.features`, value: plan.features,
    evidence, sources: ['pricing_selector'], signals,
  });
  for (const [name, value] of Object.entries(plan.limits)) facts.push({
    factId: `plan:${plan.id}:limit:${name}`, category: 'pricing_plan', field: `pricingPlan.${plan.id}.limit.${name}`, value,
    evidence, sources: ['pricing_selector'], signals,
  });
  if (plan.availability) facts.push({
    factId: `plan:${plan.id}:availability`, category: 'availability', field: `pricingPlan.${plan.id}.availability`, value: plan.availability,
    evidence, sources: ['pricing_selector'], signals,
  });
}

function addFact(facts: NormalizedFact[], target: TargetInput, fact: NormalizedFact): void {
  if (target.changeTypes.includes(fact.category)) facts.push(fact);
}

function deduplicateFacts(facts: NormalizedFact[]): NormalizedFact[] {
  const result = new Map<string, NormalizedFact>();
  for (const fact of facts) if (!result.has(fact.factId)) result.set(fact.factId, fact);
  return [...result.values()];
}

function structuredSignals(identifierPresent: boolean): ConfidenceSignals {
  return { structured: true, stableSelector: false, identifierPresent, multipleSources: false, packOrUnitKnown: false, completePair: true };
}

function selectorSignals(identifierPresent: boolean): ConfidenceSignals {
  return { structured: false, stableSelector: true, identifierPresent, multipleSources: false, packOrUnitKnown: false, completePair: true };
}

function textSignals(): ConfidenceSignals {
  return { structured: false, stableSelector: false, identifierPresent: false, multipleSources: false, packOrUnitKnown: false, completePair: true };
}

function normalizeAvailability(value: string): string {
  const normalized = value.toLowerCase();
  if (/outofstock|out[ -]?of[ -]?stock|unavailable|sold[ -]?out/.test(normalized)) return 'out_of_stock';
  if (/instock|in[ -]?stock|available/.test(normalized)) return 'in_stock';
  if (/preorder|pre-order/.test(normalized)) return 'preorder';
  return slug(value);
}

function extractDate(value: string): string | null {
  const match = value.match(/\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i);
  return match ? normalizeDate(match[0]) : null;
}

function globExpression(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.{0,500}?').replace(/\?/g, '.');
  return new RegExp(escaped, 'gi');
}

function monthNumber(value: string): number {
  return ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(value.toLowerCase()) + 1;
}

function dateParts(year: number, month: number, day: number, fallback: string): string {
  return validDate(year, month, day) ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : fallback;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nullable(value: string | undefined | null): string | null {
  const normalized = value ? suppressNoise(value) : '';
  return normalized || null;
}

function slug(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'unknown';
}
