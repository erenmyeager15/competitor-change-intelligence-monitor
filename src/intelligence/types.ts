import type { ChangeType } from '../types.js';

export const INTELLIGENCE_SCHEMA_VERSION = 1 as const;

export type FactSource = 'json_ld' | 'pricing_selector' | 'policy_selector' | 'changelog_selector' | 'metadata' | 'visible_text';

export interface ConfidenceSignals {
  structured: boolean;
  stableSelector: boolean;
  identifierPresent: boolean;
  multipleSources: boolean;
  packOrUnitKnown: boolean;
  completePair: boolean;
}

export interface NormalizedFact {
  factId: string;
  category: ChangeType;
  field: string;
  value: string | number | boolean | null | string[];
  evidence: string;
  sources: FactSource[];
  currency?: string;
  unit?: string;
  signals: ConfidenceSignals;
}

export interface NormalizedProduct {
  id: string;
  name: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  model: string | null;
  originalModel: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  url: string | null;
}

export interface NormalizedPricingPlan {
  id: string;
  name: string;
  price: number | null;
  currency: string | null;
  billingInterval: string | null;
  availability: string | null;
  features: string[];
  limits: Record<string, number>;
}

export interface NormalizedSnapshot extends Record<string, unknown> {
  intelligenceSchemaVersion: typeof INTELLIGENCE_SCHEMA_VERSION;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  headings: string[];
  products: NormalizedProduct[];
  pricingPlans: NormalizedPricingPlan[];
  policies: Array<{ id: string; heading: string | null; text: string; effectiveDate: string | null }>;
  changelog: Array<{ id: string; heading: string | null; text: string; date: string | null; version: string | null }>;
  generalContent: string | null;
  facts: NormalizedFact[];
}
