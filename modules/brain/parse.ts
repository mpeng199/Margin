/**
 * [[Wikilinks]] and #tags. Pure functions shared by the daemon (indexing, renames) and the web half
 * (rendering, autocomplete), so both sides agree on what a link is.
 */

/** Links match titles case-insensitively with whitespace collapsed: [[lim lab]] finds “Lim Lab”. */
export const titleKey = (t: string) => t.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

export const TITLE_MAX = 120;

/** Characters that would break a [[link]] are dropped; empty titles become “Untitled”. */
export function cleanTitle(t: string): string {
  const s = t.normalize('NFC').replace(/[[\]|#^\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
  return s || 'Untitled';
}

/** [[Target]], [[Target#Heading]], [[Target|shown text]] */
export const WIKILINK = /\[\[([^[\]|#\n]+)(?:#([^[\]|\n]*))?(?:\|([^[\]\n]*))?\]\]/g;
/** #tag or #area/sub, after a space or line start; at least one letter so “#1” stays a number. */
export const TAG = /(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

const stripCode = (md: string) => md.replace(CODE, ' ');

export function links(md: string): string[] {
  const out = new Map<string, string>();
  for (const m of stripCode(md).matchAll(WIKILINK)) {
    const target = m[1].trim();
    if (target) out.set(titleKey(target), target);
  }
  return [...out.values()];
}

export function cleanTag(raw: string): string | null {
  const t = raw.replace(/[/-]+$/, '').toLowerCase();
  return /\p{L}/u.test(t) ? t : null;
}

export function tags(md: string): string[] {
  const out = new Set<string>();
  for (const m of stripCode(md).matchAll(TAG)) {
    const t = cleanTag(m[2]);
    if (t) out.add(t);
  }
  return [...out];
}

/** Rewrite links to a renamed note, keeping #headings and |shown text. */
export function renameLinks(md: string, from: string, to: string): string {
  const key = titleKey(from);
  return md.replace(WIKILINK, (all, target: string, heading?: string, alias?: string) =>
    titleKey(target) === key ? `[[${to}${heading !== undefined ? `#${heading}` : ''}${alias !== undefined ? `|${alias}` : ''}]]` : all);
}

/** A short excerpt around the first match of any term (plain text, markdown punctuation thinned out). */
export function snippet(text: string, terms: string[], width = 160): string {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~]+/g, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
  const lower = plain.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return plain.slice(0, width) + (plain.length > width ? '…' : '');
  const start = Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? '…' : '') + plain.slice(start, start + width).trim() + (start + width < plain.length ? '…' : '');
}
