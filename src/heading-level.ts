/**
 * Heading level commands, matching official Typora 1.14.15 as observed on 2026-11-10
 * (docs/typora-acceptance.md). Level 0 is a plain paragraph.
 *
 * - heading1..6: set that level; pressing the current level again returns to a paragraph.
 * - paragraph: always a paragraph.
 * - heading-up: paragraph -> H6, Hn -> Hn-1, H1 stays H1.
 * - heading-down: Hn -> Hn+1, H6 -> paragraph, paragraph stays.
 */
export function nextHeadingLevel(action: string, current: number): number | null {
  if (action === 'paragraph') return 0;
  if (action === 'heading-up') return current === 0 ? 6 : Math.max(1, current - 1);
  if (action === 'heading-down') return current === 0 || current === 6 ? 0 : current + 1;
  const match = /^(?:h|heading-?)([1-6])$/.exec(action);
  if (!match) return null;
  return Number(match[1]) === current ? 0 : Number(match[1]);
}

/** ATX prefix of one source line: up to three spaces, 1-6 `#`, then blank or end of line. */
const atxPrefix = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

/**
 * The replacement for one source line's ATX prefix, as a range relative to the line start.
 * Returns null when the action is not a heading command or the line needs no change, so
 * untouched lines keep their exact bytes.
 */
export function sourceHeadingChange(line: string, action: string): { from: number; to: number; insert: string } | null {
  const match = atxPrefix.exec(line), current = match ? match[2].length : 0;
  const level = nextHeadingLevel(action, current);
  if (level === null || level === current) return null;
  const from = match ? match[1].length : 0, to = match ? match[0].length : 0;
  return { from, to, insert: level ? '#'.repeat(level) + ' ' : '' };
}
