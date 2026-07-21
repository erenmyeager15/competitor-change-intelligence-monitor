import dns from 'node:dns/promises';
import net from 'node:net';
import type { LookupAddress } from 'node:dns';

const blockedIpv4 = new net.BlockList();
const blockedIpv6 = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedIpv4.addSubnet(address, prefix, 'ipv4');

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blockedIpv6.addSubnet(address, prefix, 'ipv6');

const BLOCKED_HOSTS = new Set([
  'instance-data',
  'metadata',
  'metadata.google.internal',
  'kubernetes.default.svc',
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan', '.arpa'];
const CREDENTIAL_QUERY_KEY = /^(?:auth|authorization|cookie|token|access_token|secret|api[-_]?key|password|credential|session|signature|sig|key)$/i;

export interface AddressSafety {
  blocked: boolean;
  normalizedAddress?: string;
  reason?: string;
}

export interface ResolvedPublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  resolvedAddresses: string[];
}

export interface DnsResolver {
  lookup(hostname: string, options: { all: true; verbatim: true }): Promise<LookupAddress[]>;
}

export class TargetSafetyError extends Error {
  constructor(public readonly code: 'INVALID_URL' | 'BLOCKED_TARGET' | 'DNS_FAILURE', message: string) {
    super(message);
    this.name = 'TargetSafetyError';
  }
}

export function normalizeHostname(value: string): string {
  let result = value.trim().toLowerCase().replace(/\.$/, '');
  try {
    while (result.includes('%')) {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded.toLowerCase();
    }
  } catch {
    throw new TargetSafetyError('INVALID_URL', 'Hostname contains malformed percent encoding.');
  }
  if (result.startsWith('[') && result.endsWith(']')) result = result.slice(1, -1);
  return result;
}

function parseIpv4Representation(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const value = BigInt(host);
    if (value <= 4_294_967_295n) {
      return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.');
    }
  }
  if (/^0x[0-9a-f]{1,8}$/i.test(host)) {
    const value = Number.parseInt(host, 16);
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
  }
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !part)) return null;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part) && part.length > 1) value = Number.parseInt(part, 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }
  if (values.length === 4 && values.every((value) => value <= 255)) return values.join('.');
  if (values.length === 3 && values[0]! <= 255 && values[1]! <= 255 && values[2]! <= 65_535) {
    return `${values[0]}.${values[1]}.${(values[2]! >>> 8) & 255}.${values[2]! & 255}`;
  }
  if (values.length === 2 && values[0]! <= 255 && values[1]! <= 16_777_215) {
    return `${values[0]}.${(values[1]! >>> 16) & 255}.${(values[1]! >>> 8) & 255}.${values[1]! & 255}`;
  }
  if (values.length === 1 && values[0]! <= 4_294_967_295) {
    return [24, 16, 8, 0].map((shift) => (values[0]! >>> shift) & 255).join('.');
  }
  return null;
}

export function inspectAddress(value: string): AddressSafety {
  const normalized = normalizeHostname(value);
  if (normalized === 'localhost' || normalized === 'localhost.localdomain' || BLOCKED_HOSTS.has(normalized)
    || BLOCKED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return { blocked: true, normalizedAddress: normalized, reason: 'Local, internal, metadata, or non-public hostname.' };
  }
  const ipv4 = parseIpv4Representation(normalized);
  if (ipv4) {
    return blockedIpv4.check(ipv4, 'ipv4')
      ? { blocked: true, normalizedAddress: ipv4, reason: 'Private, loopback, link-local, metadata-capable, documentation, benchmarking, multicast, or reserved IPv4 range.' }
      : { blocked: false, normalizedAddress: ipv4 };
  }
  if (net.isIP(normalized) === 6) {
    return blockedIpv6.check(normalized, 'ipv6')
      ? { blocked: true, normalizedAddress: normalized, reason: 'Private, loopback, mapped, translation, link-local, documentation, tunneling, multicast, or reserved IPv6 range.' }
      : { blocked: false, normalizedAddress: normalized };
  }
  return { blocked: false };
}

export function validatePublicHttpsUrl(rawUrl: string): URL {
  if (!rawUrl || rawUrl.length > 2_048) throw new TargetSafetyError('INVALID_URL', 'URL must contain 1-2048 characters.');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TargetSafetyError('INVALID_URL', 'URL must be absolute and parseable.');
  }
  if (url.protocol !== 'https:') throw new TargetSafetyError('INVALID_URL', 'Only HTTPS targets are supported.');
  if (url.username || url.password) throw new TargetSafetyError('INVALID_URL', 'URL credentials are prohibited.');
  if (url.hash) throw new TargetSafetyError('INVALID_URL', 'URL fragments are prohibited.');
  if (url.port && url.port !== '443') throw new TargetSafetyError('INVALID_URL', 'Custom ports are prohibited.');
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEY.test(key)) throw new TargetSafetyError('INVALID_URL', 'Credential-shaped query parameters are prohibited.');
  }
  const hostname = normalizeHostname(url.hostname);
  const hostSafety = inspectAddress(hostname);
  if (hostSafety.blocked) throw new TargetSafetyError('BLOCKED_TARGET', `Target hostname is not public: ${hostSafety.reason}`);
  url.hostname = hostname;
  return url;
}

export async function resolvePublicTarget(rawUrl: string, resolver: DnsResolver = dns): Promise<ResolvedPublicTarget> {
  const url = validatePublicHttpsUrl(rawUrl);
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = net.isIP(hostname);
  const records: LookupAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver.lookup(hostname, { all: true, verbatim: true }).catch((error: unknown) => {
      throw new TargetSafetyError('DNS_FAILURE', `DNS resolution failed: ${(error as Error).message}`);
    });
  if (!records.length) throw new TargetSafetyError('DNS_FAILURE', 'DNS resolution returned no addresses.');
  for (const record of records) {
    const safety = inspectAddress(record.address);
    if (safety.blocked) {
      throw new TargetSafetyError('BLOCKED_TARGET', `DNS resolution returned a non-public address: ${safety.reason}`);
    }
  }
  const sorted = [...records].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  const selected = sorted[0]!;
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
    resolvedAddresses: sorted.map((record) => record.address),
  };
}

export function allowedOrigins(targetUrl: string, explicitlyAuthorizedOrigins: string[] = []): Set<string> {
  const origins = new Set([validatePublicHttpsUrl(targetUrl).origin]);
  for (const origin of explicitlyAuthorizedOrigins) {
    const url = validatePublicHttpsUrl(origin);
    if (url.pathname !== '/' || url.search) throw new TargetSafetyError('INVALID_URL', 'Authorized redirect entries must be origins without paths or queries.');
    origins.add(url.origin);
  }
  return origins;
}
