import { load, type CheerioAPI } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { TargetInput } from '../types.js';
import { redactText, redactUnknown, redactUrl } from '../security/redaction.js';
import { validateSelectors } from './selectors.js';

export type DocumentKind = 'html' | 'json' | 'xml' | 'text';

export interface ProductOfferFacts {
  name?: string;
  sku?: string;
  gtin?: string;
  mpn?: string;
  brand?: string;
  model?: string;
  price?: string;
  priceCurrency?: string;
  availability?: string;
  url?: string;
}

export interface ExtractedPricingPlan {
  name: string;
  priceText: string | null;
  availabilityText: string | null;
  features: string[];
  evidence: string;
}

export interface ExtractedTextSection {
  heading: string | null;
  text: string;
}

export interface ExtractedSemanticSections {
  pricingPlans: ExtractedPricingPlan[];
  policies: ExtractedTextSection[];
  changelog: ExtractedTextSection[];
}

export interface ExtractedDocument {
  kind: DocumentKind;
  contentType: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  headings: string[];
  visibleText: string;
  selectedSections: Array<{ selector: string; text: string }>;
  structuredFields: Record<string, string | number | boolean | null>;
  productOffers: ProductOfferFacts[];
  semanticSections: ExtractedSemanticSections;
}

const SUPPORTED_CONTENT = new Map<string, DocumentKind>([
  ['text/html', 'html'],
  ['application/xhtml+xml', 'html'],
  ['application/json', 'json'],
  ['application/ld+json', 'json'],
  ['application/xml', 'xml'],
  ['text/xml', 'xml'],
  ['text/plain', 'text'],
]);

export function contentKind(rawContentType: string | null): DocumentKind | null {
  const mediaType = rawContentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (SUPPORTED_CONTENT.has(mediaType)) return SUPPORTED_CONTENT.get(mediaType)!;
  if (mediaType.endsWith('+json')) return 'json';
  if (mediaType.endsWith('+xml')) return 'xml';
  return null;
}

export function extractDocument(body: string, rawContentType: string | null, target: TargetInput): ExtractedDocument {
  const kind = contentKind(rawContentType);
  if (!kind) throw new Error(`Unsupported content type '${rawContentType ?? 'missing'}'.`);
  const contentType = rawContentType?.split(';')[0]?.trim().toLowerCase() ?? 'text/plain';
  if (kind === 'html') return extractHtml(body, contentType, target);
  if (kind === 'json') return extractStructured(body, contentType, 'json');
  if (kind === 'xml') return extractStructured(body, contentType, 'xml');
  return {
    kind: 'text',
    contentType,
    canonicalUrl: null,
    title: null,
    description: null,
    headings: [],
    visibleText: cleanText(body, 50_000),
    selectedSections: [],
    structuredFields: {},
    productOffers: [],
    semanticSections: emptySemanticSections(),
  };
}

function extractHtml(body: string, contentType: string, target: TargetInput): ExtractedDocument {
  const $ = load(body);
  const includeSelectors = validateSelectors(target.includeSelectors);
  const excludeSelectors = validateSelectors(target.excludeSelectors);
  for (const selector of excludeSelectors) $(selector).remove();

  const productOffers = extractJsonLd($);
  const semanticSections = extractSemanticSections($);
  $('script, style, noscript, template, svg, canvas, iframe').remove();
  const selectedSections = includeSelectors.map((selector) => ({
    selector,
    text: cleanText($(selector).toArray().map((node) => $(node).text()).join(' '), 10_000),
  })).filter((entry) => entry.text);
  const visibleSource = includeSelectors.length
    ? selectedSections.map((entry) => entry.text).join(' ')
    : ($('body').text() || $.root().text());
  const canonicalHref = $('link[rel="canonical"]').first().attr('href');
  let canonicalUrl: string | null = null;
  if (canonicalHref) {
    try {
      canonicalUrl = redactUrl(new URL(canonicalHref, target.url).toString());
    } catch {
      canonicalUrl = null;
    }
  }
  const headings = $('h1, h2, h3').toArray()
    .map((node) => cleanText($(node).text(), 500))
    .filter(Boolean)
    .slice(0, 100);

  return {
    kind: 'html',
    contentType,
    canonicalUrl,
    title: nullableText($('title').first().text(), 500),
    description: nullableText($('meta[name="description"]').first().attr('content') ?? '', 1_000),
    headings,
    visibleText: cleanText(visibleSource, 50_000),
    selectedSections,
    structuredFields: flattenStructured(productOffers, 200),
    productOffers,
    semanticSections,
  };
}

function extractStructured(body: string, contentType: string, kind: 'json' | 'xml'): ExtractedDocument {
  let parsed: unknown;
  try {
    parsed = kind === 'json'
      ? JSON.parse(body)
      : new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        processEntities: false,
        htmlEntities: false,
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: true,
      }).parse(body);
  } catch {
    throw new Error(`${kind.toUpperCase()} response could not be parsed safely.`);
  }
  const redacted = redactUnknown(parsed);
  const structuredFields = flattenStructured(redacted, 200);
  return {
    kind,
    contentType,
    canonicalUrl: null,
    title: null,
    description: null,
    headings: [],
    visibleText: cleanText(Object.values(structuredFields).map(String).join(' '), 50_000),
    selectedSections: [],
    structuredFields,
    productOffers: [],
    semanticSections: emptySemanticSections(),
  };
}

function extractSemanticSections($: CheerioAPI): ExtractedSemanticSections {
  const pricingPlans: ExtractedPricingPlan[] = [];
  $('[data-plan], .pricing-plan, [class*="pricing-plan"], .plan-card').slice(0, 50).each((_index, node) => {
    const element = $(node);
    const name = cleanText(element.attr('data-plan') ?? element.find('h1, h2, h3, [class*="name"]').first().text(), 200);
    if (!name) return;
    const priceText = nullableText(element.find('.price, [itemprop="price"], [data-price], [class*="price"]').first().text(), 500);
    const availabilityText = nullableText(element.find('.availability, [itemprop="availability"], [class*="stock"]').first().text(), 500);
    const features = element.find('li').toArray()
      .map((entry) => cleanText($(entry).text(), 500))
      .filter(Boolean)
      .slice(0, 100);
    pricingPlans.push({
      name,
      priceText,
      availabilityText,
      features,
      evidence: cleanText(element.text(), 2_000),
    });
  });

  const sections = (selector: string): ExtractedTextSection[] => $(selector).slice(0, 50).toArray()
    .map((node) => {
      const element = $(node);
      return {
        heading: nullableText(element.find('h1, h2, h3').first().text(), 300),
        text: cleanText(element.text(), 2_000),
      };
    })
    .filter((entry) => entry.text);

  return {
    pricingPlans,
    policies: sections('.terms, [class*="terms"], [class*="policy"], [id*="terms"], [id*="policy"]'),
    changelog: sections('.changelog, [class*="changelog"], [class*="release-note"], [id*="changelog"]'),
  };
}

function emptySemanticSections(): ExtractedSemanticSections {
  return { pricingPlans: [], policies: [], changelog: [] };
}

function extractJsonLd($: CheerioAPI): ProductOfferFacts[] {
  const records: ProductOfferFacts[] = [];
  const consumedNestedOffers = new WeakSet<object>();
  $('script[type="application/ld+json"]').slice(0, 50).each((_index, node) => {
    const raw = $(node).text();
    if (!raw || raw.length > 131_072) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const queue: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
    let visited = 0;
    while (queue.length && records.length < 20 && visited < 500) {
      const current = queue.shift()!;
      visited += 1;
      if (current.depth > 8 || !current.value || typeof current.value !== 'object') continue;
      if (Array.isArray(current.value)) {
        current.value.slice(0, 100).forEach((value) => queue.push({ value, depth: current.depth + 1 }));
        continue;
      }
      const item = current.value as Record<string, unknown>;
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      const isProduct = types.some((type) => type === 'Product');
      const isOffer = types.some((type) => type === 'Offer' || type === 'AggregateOffer');
      if (isProduct) {
        const nestedOffer = firstObject(item.offers);
        if (nestedOffer) consumedNestedOffers.add(nestedOffer);
        records.push(productOffer(item));
      } else if (isOffer && !consumedNestedOffers.has(item)) {
        records.push(productOffer(item));
      }
      Object.values(item).slice(0, 100).forEach((value) => queue.push({ value, depth: current.depth + 1 }));
    }
  });
  return records;
}

function productOffer(item: Record<string, unknown>): ProductOfferFacts {
  const nestedOffer = firstObject(item.offers);
  const brandValue = item.brand;
  const brand = typeof brandValue === 'string'
    ? brandValue
    : brandValue && typeof brandValue === 'object' && !Array.isArray(brandValue)
      ? scalar((brandValue as Record<string, unknown>).name)
      : undefined;
  const result: ProductOfferFacts = {
    name: scalar(item.name),
    sku: scalar(item.sku),
    gtin: scalar(item.gtin14 ?? item.gtin13 ?? item.gtin12 ?? item.gtin8 ?? item.gtin),
    mpn: scalar(item.mpn),
    brand,
    model: scalar(item.model),
    price: scalar(item.price ?? item.lowPrice ?? item.highPrice ?? nestedOffer?.price ?? nestedOffer?.lowPrice ?? nestedOffer?.highPrice),
    priceCurrency: scalar(item.priceCurrency ?? nestedOffer?.priceCurrency),
    availability: scalar(item.availability ?? nestedOffer?.availability),
    url: scalar(item.url ?? nestedOffer?.url),
  };
  return Object.fromEntries(Object.entries(result)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]))
    .map(([key, value]) => [key, key === 'url' ? redactUrl(value) : redactText(value, 500)])) as ProductOfferFacts;
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function flattenStructured(value: unknown, limit: number): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  const queue: Array<{ path: string; value: unknown; depth: number }> = [{ path: '$', value, depth: 0 }];
  while (queue.length && Object.keys(result).length < limit) {
    const current = queue.shift()!;
    if (current.depth > 8) continue;
    if (current.value === null || ['string', 'number', 'boolean'].includes(typeof current.value)) {
      result[current.path.slice(0, 512)] = typeof current.value === 'string' ? redactText(current.value, 2_000) : current.value as number | boolean | null;
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.slice(0, 100).forEach((entry, index) => queue.push({ path: `${current.path}[${index}]`, value: entry, depth: current.depth + 1 }));
    } else if (current.value && typeof current.value === 'object') {
      Object.entries(current.value).slice(0, 100).forEach(([key, entry]) => {
        if (!['__proto__', 'prototype', 'constructor'].includes(key)) {
          queue.push({ path: `${current.path}.${redactText(key, 128)}`, value: entry, depth: current.depth + 1 });
        }
      });
    }
  }
  return result;
}

function nullableText(value: string, limit: number): string | null {
  const result = cleanText(value, limit);
  return result || null;
}

function cleanText(value: string, limit: number): string {
  return redactText(value.replace(/\s+/g, ' ').trim(), limit);
}
