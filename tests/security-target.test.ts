import assert from 'node:assert/strict';
import test from 'node:test';
import type { LookupAddress } from 'node:dns';
import {
  allowedOrigins,
  inspectAddress,
  resolvePublicTarget,
  TargetSafetyError,
  validatePublicHttpsUrl,
  type DnsResolver,
} from '../src/security/target.js';

function resolver(records: LookupAddress[]): DnsResolver {
  return { lookup: async () => records };
}

test('blocks private, metadata, mapped, translated, and alternate IPv4 representations', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '2130706433',
    '0x7f000001', '0177.0.0.1', '127.1', '::1', '::ffff:127.0.0.1',
    '64:ff9b::7f00:1', 'fe80::1', 'fc00::1', '2001:db8::1',
  ]) assert.equal(inspectAddress(address).blocked, true, address);
});

test('allows ordinary public IPv4 and IPv6 addresses', () => {
  assert.equal(inspectAddress('93.184.216.34').blocked, false);
  assert.equal(inspectAddress('2606:4700:4700::1111').blocked, false);
});

test('requires a clean HTTPS URL on the standard port', () => {
  for (const url of [
    'http://example.com', 'https://user:pass@example.com', 'https://example.com/#private',
    'https://example.com:8443/', 'https://example.com/?api_key=secret', 'https://localhost/',
  ]) assert.throws(() => validatePublicHttpsUrl(url), TargetSafetyError, url);
  assert.equal(validatePublicHttpsUrl('https://example.com/catalog?q=shoes').toString(), 'https://example.com/catalog?q=shoes');
});

test('rejects a hostname when any DNS answer is non-public', async () => {
  await assert.rejects(
    resolvePublicTarget('https://shop.example/', resolver([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])),
    (error: unknown) => error instanceof TargetSafetyError && error.code === 'BLOCKED_TARGET',
  );
});

test('returns a deterministic public pinned address', async () => {
  const result = await resolvePublicTarget('https://shop.example/path', resolver([
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '93.184.216.35', family: 4 },
    { address: '93.184.216.34', family: 4 },
  ]));
  assert.equal(result.address, '93.184.216.34');
  assert.deepEqual(result.resolvedAddresses, ['93.184.216.34', '93.184.216.35', '2606:4700:4700::1111']);
});

test('authorized redirect entries must be clean origins', () => {
  const origins = allowedOrigins('https://example.com/a', ['https://cdn.example.com']);
  assert.deepEqual([...origins], ['https://example.com', 'https://cdn.example.com']);
  assert.throws(() => allowedOrigins('https://example.com', ['https://cdn.example.com/path']), TargetSafetyError);
});
