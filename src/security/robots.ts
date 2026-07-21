import { createRequire } from 'node:module';
import { MONITOR_USER_AGENT, safeFetch, type OriginRateLimiter, type SafeFetchOptions, type SafeHttpResponse } from './network.js';
import { validatePublicHttpsUrl } from './target.js';

interface RobotsParserInstance {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

const require = createRequire(import.meta.url);
const robotsParser = require('robots-parser') as (url: string, text: string) => RobotsParserInstance;

export interface RobotsDecision {
  allowed: boolean;
  robotsUrl: string;
  status: number;
  reason: string;
}

export interface RobotsDependencies {
  fetchRobots?: (url: string, options: SafeFetchOptions) => Promise<SafeHttpResponse>;
}

export async function checkRobotsCompliance(
  targetUrl: string,
  options: { timeoutMs: number; rateLimiter?: OriginRateLimiter },
  dependencies: RobotsDependencies = {},
): Promise<RobotsDecision> {
  const target = validatePublicHttpsUrl(targetUrl);
  const robotsUrl = new URL('/robots.txt', target.origin).toString();
  const fetchRobots = dependencies.fetchRobots ?? safeFetch;
  const response = await fetchRobots(robotsUrl, {
    timeoutMs: options.timeoutMs,
    maxResponseBytes: 262_144,
    maxRedirects: 2,
    rateLimiter: options.rateLimiter,
    headers: { Accept: 'text/plain,*/*;q=0.1' },
  });

  if (response.status === 404 || response.status === 410) {
    return { allowed: true, robotsUrl, status: response.status, reason: 'No robots.txt policy was published.' };
  }
  if (response.status === 204) {
    return { allowed: true, robotsUrl, status: response.status, reason: 'Empty robots.txt policy.' };
  }
  if (response.status === 401 || response.status === 403) {
    return { allowed: false, robotsUrl, status: response.status, reason: 'robots.txt was access-restricted; target fetch stopped conservatively.' };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`robots.txt returned HTTP ${response.status}; target fetch stopped conservatively.`);
  }

  const parser = robotsParser(robotsUrl, response.body);
  let exact: boolean | undefined;
  let wildcard: boolean | undefined;
  try {
    exact = parser.isAllowed(target.toString(), MONITOR_USER_AGENT);
    wildcard = parser.isAllowed(target.toString(), '*');
  } catch {
    return { allowed: false, robotsUrl, status: response.status, reason: 'robots.txt could not be evaluated safely.' };
  }
  const allowed = exact !== false && wildcard !== false;
  return {
    allowed,
    robotsUrl,
    status: response.status,
    reason: allowed ? 'Actor-specific and wildcard robots policies allow this target.' : 'robots.txt disallows this target.',
  };
}
