import { canonicalStringify, sha256 } from '../baseline/canonical.js';
import { redactText } from '../security/redaction.js';
import type { ClassifiedChange, ConfidenceBand, Severity } from '../types.js';
import type { ConfidenceSignals, NormalizedFact, NormalizedSnapshot } from './types.js';

const SEVERITY_SCORE: Record<Severity, number> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface ClassifyChangesInput {
  targetIdentityHash: string;
  previous: NormalizedSnapshot;
  current: NormalizedSnapshot;
}

export function classifyChanges(input: ClassifyChangesInput): ClassifiedChange[] {
  const previousFacts = new Map(input.previous.facts.map((fact) => [fact.factId, fact]));
  const currentFacts = new Map(input.current.facts.map((fact) => [fact.factId, fact]));
  const changes: ClassifiedChange[] = [];

  for (const key of [...new Set([...previousFacts.keys(), ...currentFacts.keys()])].sort()) {
    const previous = previousFacts.get(key);
    const current = currentFacts.get(key);
    if (previous && current && canonicalStringify(previous.value) === canonicalStringify(current.value)) continue;
    const reference = current ?? previous;
    if (!reference) continue;
    changes.push(buildChange(input.targetIdentityHash, reference, previous, current));
  }

  return changes
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity)
      || right.confidenceScore - left.confidenceScore
      || left.field.localeCompare(right.field))
    .slice(0, 100);
}

export function severityRank(value: Severity): number {
  return SEVERITY_SCORE[value];
}

export function meetsMateriality(value: Severity, minimum: Severity): boolean {
  return severityRank(value) >= severityRank(minimum);
}

export function highestSeverity(changes: ClassifiedChange[]): Severity {
  return changes.reduce<Severity>(
    (highest, change) => severityRank(change.severity) > severityRank(highest) ? change.severity : highest,
    'informational',
  );
}

function buildChange(
  targetIdentityHash: string,
  reference: NormalizedFact,
  previous: NormalizedFact | undefined,
  current: NormalizedFact | undefined,
): ClassifiedChange {
  const previousValue = previous?.value ?? null;
  const currentValue = current?.value ?? null;
  const delta = numericDelta(previousValue, currentValue);
  const deltaPercent = numericPercent(previousValue, delta);
  const severity = classifySeverity(reference, previous, current, deltaPercent);
  const confidenceScore = confidence(previous, current);
  const band = confidenceBand(confidenceScore);
  const changeId = sha256(canonicalStringify({
    targetIdentityHash,
    category: reference.category,
    field: reference.field,
    previousValue,
    currentValue,
  }));
  return {
    changeId,
    category: reference.category,
    field: reference.field,
    previousValue,
    currentValue,
    delta,
    deltaPercent,
    severity,
    confidenceScore,
    confidence: band,
    explanation: explanation(reference, previous, current, delta, deltaPercent),
    recommendedAction: recommendedAction(reference, severity, previous, current),
    evidence: {
      previousExcerpt: excerpt(previous?.evidence),
      currentExcerpt: excerpt(current?.evidence),
      sources: [...new Set([...(previous?.sources ?? []), ...(current?.sources ?? [])])].sort().slice(0, 10),
    },
  };
}

function classifySeverity(
  fact: NormalizedFact,
  previous: NormalizedFact | undefined,
  current: NormalizedFact | undefined,
  deltaPercent: number | null,
): Severity {
  const removed = Boolean(previous && !current);
  if (removed && ['price', 'availability', 'pricing_plan', 'terms_policy'].includes(fact.category)) return 'high';
  if (fact.category === 'terms_policy') return 'high';
  if (fact.category === 'price') {
    if (deltaPercent !== null && Math.abs(deltaPercent) >= 25) return 'high';
    if (fact.field.endsWith('.currency') || (deltaPercent !== null && Math.abs(deltaPercent) >= 2)) return 'medium';
    return 'low';
  }
  if (fact.category === 'availability') return 'medium';
  if (fact.category === 'product_feature' || fact.category === 'pricing_plan' || fact.category === 'launch_changelog') return 'medium';
  return 'informational';
}

function confidence(previous: NormalizedFact | undefined, current: NormalizedFact | undefined): number {
  const signals = mergeSignals(previous?.signals, current?.signals);
  let score = signals.structured ? 88 : signals.stableSelector ? 76 : 52;
  if (signals.identifierPresent) score += 5;
  if (signals.multipleSources) score += 3;
  if (signals.packOrUnitKnown) score += 2;
  if (previous && current) score += 4;
  else score -= 10;
  if (!signals.completePair) score -= 5;
  return Math.min(98, Math.max(20, Math.round(score)));
}

function mergeSignals(previous?: ConfidenceSignals, current?: ConfidenceSignals): ConfidenceSignals {
  const empty: ConfidenceSignals = {
    structured: false,
    stableSelector: false,
    identifierPresent: false,
    multipleSources: false,
    packOrUnitKnown: false,
    completePair: false,
  };
  if (!previous && !current) return empty;
  const sources = [previous, current].filter((value): value is ConfidenceSignals => Boolean(value));
  return {
    structured: sources.some((value) => value.structured),
    stableSelector: sources.some((value) => value.stableSelector),
    identifierPresent: sources.some((value) => value.identifierPresent),
    multipleSources: sources.some((value) => value.multipleSources),
    packOrUnitKnown: sources.some((value) => value.packOrUnitKnown),
    completePair: Boolean(previous && current && sources.every((value) => value.completePair)),
  };
}

function confidenceBand(score: number): ConfidenceBand {
  if (score >= 80) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

function numericDelta(previous: unknown, current: unknown): number | null {
  if (typeof previous !== 'number' || typeof current !== 'number') return null;
  return round(current - previous);
}

function numericPercent(previous: unknown, delta: number | null): number | null {
  if (typeof previous !== 'number' || previous === 0 || delta === null) return null;
  return round((delta / previous) * 100);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function explanation(
  fact: NormalizedFact,
  previous: NormalizedFact | undefined,
  current: NormalizedFact | undefined,
  delta: number | null,
  deltaPercent: number | null,
): string {
  if (!previous) return `${label(fact.category)} was added at ${fact.field}.`;
  if (!current) return `${label(fact.category)} was removed from ${fact.field}.`;
  if (delta !== null) {
    const direction = delta > 0 ? 'increased' : 'decreased';
    const percent = deltaPercent === null ? '' : ` (${Math.abs(deltaPercent)}%)`;
    return `${label(fact.category)} ${direction} by ${Math.abs(delta)}${percent} at ${fact.field}.`;
  }
  return `${label(fact.category)} changed at ${fact.field}.`;
}

function recommendedAction(
  fact: NormalizedFact,
  severity: Severity,
  previous: NormalizedFact | undefined,
  current: NormalizedFact | undefined,
): string {
  if (severity === 'critical') return 'Stop automation and investigate this safety-critical change immediately.';
  if (fact.category === 'terms_policy') return 'Review the new terms or policy language before taking action.';
  if (fact.category === 'price') return 'Review pricing, margin, and positioning before changing your offer.';
  if (fact.category === 'availability') return 'Confirm availability at the source and review stock or launch implications.';
  if (fact.category === 'pricing_plan') return 'Review plan packaging, limits, and billing implications.';
  if (fact.category === 'product_feature') return 'Verify the feature change and assess its competitive impact.';
  if (fact.category === 'launch_changelog') return 'Review the release details and update product intelligence if relevant.';
  if (!previous || !current) return 'Verify the added or removed content at the source.';
  return 'Review the source page if this content affects a tracked decision.';
}

function excerpt(value: string | undefined): string | null {
  if (!value) return null;
  return redactText(value, 300);
}

function label(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase());
}
