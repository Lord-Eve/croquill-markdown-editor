import { isHtmlComment } from './html-comments';
import { sanitizeInlineHtml, type InlineHtmlElement } from './html-sanitize';

export interface InlineSyntaxNode {
  type: string;
  value?: string;
  children?: InlineSyntaxNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export type InlineHtmlRange = { from: number; to: number; raw: string } & (
  { element: InlineHtmlElement; innerFrom: number; innerTo: number } | { element?: undefined }
);

const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
// Keep block containers under the existing guard. Script, iframe and center
// tokens inside phrasing content can be kept as opaque inline source instead.
const blockTags = new Set(('address article aside base basefont blockquote body caption col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html legend li link main menu menuitem nav noframes ol optgroup option p param pre search section source style summary table tbody td textarea tfoot th thead title tr track ul').split(' '));

export const isInlineHtmlRun = (node: InlineSyntaxNode): boolean => ['paragraph', 'heading', 'tableCell'].includes(node.type);

interface HtmlToken {
  node: InlineSyntaxNode;
  parent: InlineSyntaxNode;
  from: number;
  to: number;
}

/** Null means a tag crosses Markdown boundaries or has no reliable match. */
export function inlineHtmlRanges(node: InlineSyntaxNode, source: string, editing = false): InlineHtmlRange[] | null {
  if (!isInlineHtmlRun(node)) return null;
  const tokens: HtmlToken[] = [];
  let invalid = false;
  function collect(parent: InlineSyntaxNode): void {
    for (const child of parent.children || []) {
      if (['code', 'inlineCode', 'math', 'inlineMath'].includes(child.type)) continue;
      if (child.type === 'html') {
        const from = child.position?.start.offset, to = child.position?.end.offset;
        if (from == null || to == null || from < 0 || to <= from || to > source.length) invalid = true;
        else tokens.push({ node: child, parent, from, to });
      } else collect(child);
    }
  }
  collect(node);
  if (invalid) return null;
  const ranges: InlineHtmlRange[] = [];
  const stack: { tag: string; token: HtmlToken; tail: string; firstChild: number }[] = [];
  function discardUnmatched(): void {
    if (stack.length) ranges.length = stack[0].firstChild;
    stack.length = 0;
  }
  for (const token of tokens) {
    const value = token.node.value || '';
    const literal = { from: token.from, to: token.to, raw: source.slice(token.from, token.to) };
    if (isHtmlComment(value)) {
      ranges.push(literal);
      continue;
    }
    // Quotes may contain >. The parser already classified this as an HTML
    // token; this check only identifies the tag without reconstructing it.
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>$/.exec(value);
    if (!match || blockTags.has(match[2].toLowerCase())) {
      if (!editing) return null;
      discardUnmatched();
      continue;
    }
    const closing = !!match[1], tag = match[2].toLowerCase(), tail = match[3];
    if (closing) {
      const opening = stack.at(-1);
      // A pair must not consume half of a Markdown wrapper, such as
      // **<span>x**</span>, which crosses a strong node.
      if (!opening || opening.tag !== tag || opening.token.parent !== token.parent || !/^[\t \r\n]*$/.test(tail)) {
        if (!editing) return null;
        discardUnmatched();
        continue;
      }
      stack.pop();
      const from = opening.token.from, to = token.to;
      const element = sanitizeInlineHtml(tag, opening.tail, true);
      const whole = { from, to, raw: source.slice(from, to) };
      if (!element) ranges.length = opening.firstChild; // A literal atom owns its entire subtree.
      ranges.push(element ? { ...whole, element, innerFrom: opening.token.to, innerTo: token.from } : whole);
    } else if (voidTags.has(tag) || /\/[\t \r\n]*$/.test(tail)) {
      if (/^<br(?: ?\/)?>$/i.test(value)) continue;
      const element = sanitizeInlineHtml(tag, tail, false);
      ranges.push(element ? { ...literal, element, innerFrom: token.to, innerTo: token.to } : literal);
    } else stack.push({ tag, tail, token, firstChild: ranges.length });
  }
  if (stack.length && !editing) return null;
  discardUnmatched();
  return ranges.sort((a, b) => a.from - b.from);
}
/** The tag text to hide, leaving the contents (including Markdown) intact. */
export function renderedHtmlTagRanges(ranges: InlineHtmlRange[]): { from: number; to: number }[] {
  return ranges.flatMap(range => {
    if (!range.element) return [];
    const opening = { from: range.from, to: range.innerFrom };
    return range.innerTo < range.to ? [opening, { from: range.innerTo, to: range.to }] : [opening];
  });
}
