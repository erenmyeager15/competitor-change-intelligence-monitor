import { load } from 'cheerio';

const UNSAFE_PSEUDO = /:(?:has|contains|matches|nth-child|nth-last-child|nth-of-type|nth-last-of-type)\s*\(/i;

export function validateSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length > 256) throw new Error('Selector must contain 1-256 characters.');
  if (trimmed.includes('\0')) throw new Error('Selector contains a null character.');
  if (UNSAFE_PSEUDO.test(trimmed)) throw new Error('Selector uses a complexity-sensitive pseudo-class that is unsupported in v1.');
  if (trimmed === '*' || trimmed === 'html' || trimmed === 'body *') throw new Error('Selector is too broad for bounded monitoring.');
  if (trimmed.split(',').length > 5) throw new Error('Selector may contain at most five groups.');
  if ((trimmed.match(/[>+~ ]+/g) ?? []).length > 8) throw new Error('Selector contains too many combinators.');
  if ((trimmed.match(/\[/g) ?? []).length > 8) throw new Error('Selector contains too many attribute tests.');
  try {
    load('<main><div class="probe"></div></main>')('main').find(trimmed);
  } catch {
    throw new Error('Selector is not valid CSS for the supported parser.');
  }
  return trimmed;
}

export function validateSelectors(selectors: string[] | undefined): string[] {
  return (selectors ?? []).map(validateSelector);
}
