import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseActorInput } from '../src/input.js';

async function smokeInput(): Promise<unknown> {
  return JSON.parse(await readFile('fixtures/input-smoke.json', 'utf8'));
}

test('safe example.com smoke input parses with bounded defaults', async () => {
  const parsed = parseActorInput(await smokeInput());
  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0]?.url, 'https://example.com/');
  assert.equal(parsed.confirmAuthorizedUse, false);
  assert.equal(parsed.baselineAction, 'compare_only');
  assert.equal(parsed.notificationMode, 'none');
  assert.equal(parsed.dryRun, true);
});

test('non-demo targets require existing authorization confirmation', () => {
  assert.throws(
    () => parseActorInput({
      targets: [{ name: 'Authorized site', url: 'https://authorized.example/', changeTypes: ['price'] }],
      confirmAuthorizedUse: false,
    }),
    /confirmAuthorizedUse=true is required/,
  );
});

test('strict top-level and target fields reject silent configuration mistakes', async () => {
  const raw = await smokeInput() as Record<string, unknown>;
  assert.throws(() => parseActorInput({ ...raw, surprise: true }), /unsupported field/);
  assert.throws(
    () => parseActorInput({
      ...raw,
      targets: [{ name: 'Demo', url: 'https://example.com/', changeTypes: ['general_content'], surprise: true }],
    }),
    /unsupported field/,
  );
});

test('target names must be unique case-insensitively', () => {
  assert.throws(
    () => parseActorInput({
      targets: [
        { name: 'Pricing', url: 'https://example.com/', changeTypes: ['price'] },
        { name: 'PRICING', url: 'https://example.com/', changeTypes: ['availability'] },
      ],
      confirmAuthorizedUse: false,
    }),
    /unique case-insensitively/,
  );
});

test('candidate promotion requires exact reviewed lineage', () => {
  const hash = 'a'.repeat(64);
  const parsed = parseActorInput({
    targets: [{ name: 'Demo', url: 'https://example.com/', changeTypes: ['general_content'] }],
    confirmAuthorizedUse: false,
    baselineAction: 'promote_candidate',
    candidateId: 'candidate_20260721',
    expectedCandidateHash: hash,
    expectedTrustedParentHash: 'NO_PARENT',
  });
  assert.equal(parsed.candidateId, 'candidate_20260721');
  assert.equal(parsed.expectedCandidateHash, hash);
  assert.equal(parsed.expectedTrustedParentHash, 'NO_PARENT');

  assert.throws(
    () => parseActorInput({
      targets: [{ name: 'Demo', url: 'https://example.com/', changeTypes: ['general_content'] }],
      confirmAuthorizedUse: false,
      baselineAction: 'promote_candidate',
      candidateId: 'candidate_20260721',
      expectedCandidateHash: 'not-a-hash',
      expectedTrustedParentHash: 'NO_PARENT',
    }),
    /expectedCandidateHash/,
  );
});

test('candidate fields are rejected outside promotion mode', () => {
  assert.throws(
    () => parseActorInput({
      targets: [{ name: 'Demo', url: 'https://example.com/', changeTypes: ['general_content'] }],
      confirmAuthorizedUse: false,
      candidateId: 'unexpected',
    }),
    /accepted only when baselineAction is promote_candidate/,
  );
});

test('notification modes require a matching secret HTTPS webhook', () => {
  assert.throws(
    () => parseActorInput({
      targets: [{ name: 'Demo', url: 'https://example.com/', changeTypes: ['general_content'] }],
      confirmAuthorizedUse: false,
      notificationMode: 'immediate',
    }),
    /alertWebhookUrl is required/,
  );
  assert.throws(
    () => parseActorInput({
      targets: [{ name: 'Demo', url: 'https://example.com/', changeTypes: ['general_content'] }],
      confirmAuthorizedUse: false,
      notificationMode: 'immediate',
      alertWebhookUrl: 'http://localhost/hook',
    }),
    /must use HTTPS/,
  );
});

test('v1 ignores only literal or simple glob text patterns', () => {
  assert.throws(
    () => parseActorInput({
      targets: [{
        name: 'Demo',
        url: 'https://example.com/',
        changeTypes: ['general_content'],
        ignoreTextPatterns: ['(a+)+$'],
      }],
      confirmAuthorizedUse: false,
    }),
    /not regular expressions/,
  );
});

test('URL credentials, fragments, and non-HTTPS targets are rejected', () => {
  const base = (url: string) => ({
    targets: [{ name: 'Target', url, changeTypes: ['general_content'] }],
    confirmAuthorizedUse: true,
  });
  assert.throws(() => parseActorInput(base('http://example.com/')), /must use HTTPS/);
  assert.throws(() => parseActorInput(base('https://user:pass@example.com/')), /must not contain URL credentials/);
  assert.throws(() => parseActorInput(base('https://example.com/#section')), /must not contain a fragment/);
});

test('numeric limits and IANA timezone are enforced', async () => {
  const raw = await smokeInput() as Record<string, unknown>;
  assert.throws(() => parseActorInput({ ...raw, maxRetries: 3 }), /maxRetries must be an integer from 0 to 2/);
  assert.throws(() => parseActorInput({ ...raw, timezone: 'Not/A_Real_Zone' }), /valid IANA timezone/);
});

test('dry runs are restricted to immutable compare-only mode', async () => {
  const raw = await smokeInput() as Record<string, unknown>;
  assert.throws(
    () => parseActorInput({ ...raw, dryRun: true, baselineAction: 'initialize_trusted' }),
    /dryRun=true requires baselineAction=compare_only/,
  );
  const parsed = parseActorInput({ ...raw, dryRun: false, baselineAction: 'initialize_trusted' });
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.baselineAction, 'initialize_trusted');
});
