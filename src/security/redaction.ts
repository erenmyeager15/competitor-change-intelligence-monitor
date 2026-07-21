const SENSITIVE_KEY = /authorization|cookie|token|secret|api[-_]?key|password|credential|session|signature|^sig$|^key$/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<![\w])(?:\+?\d[\d ().-]{6,}\d)(?![\w])/g;
const BEARER = /\b(bearer|basic)\s+[a-z0-9._~+/=:-]+/gi;
const QUERY_SECRET = /([?&](?:token|access_token|api[_-]?key|key|secret|signature|sig|password|session)=)[^&#\s]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const PREFIXED_TOKEN = /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/gi;
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|api[-_]?key|access[-_]?token|token|session|signature|sig)\s*[:=]\s*[^\s,;]+/gi;

export function redactText(value: string, maxLength = 2_000): string {
  return value
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(BEARER, '$1 [REDACTED]')
    .replace(QUERY_SECRET, '$1[REDACTED]')
    .replace(JWT, '[REDACTED]')
    .replace(PREFIXED_TOKEN, '[REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(PHONE, (candidate) => isPhoneLike(candidate) ? '[REDACTED_PHONE]' : candidate)
    .trim()
    .slice(0, Math.min(Math.max(maxLength, 0), 50_000));
}

function isPhoneLike(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return trimmed.startsWith('+') || /[ ().-]/.test(trimmed);
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      const current = url.searchParams.get(key) ?? '';
      url.searchParams.set(key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactText(current, 256));
    }
    url.hash = '';
    return url.toString();
  } catch {
    return redactText(value, 2_048);
  }
}

export function redactUnknown(value: unknown, key = '', depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => redactUnknown(entry, key, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 500)) {
      if (['__proto__', 'prototype', 'constructor'].includes(childKey)) continue;
      result[redactText(childKey, 128)] = redactUnknown(childValue, childKey, depth + 1);
    }
    return result;
  }
  return value;
}
