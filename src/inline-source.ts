import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { decodeEntity } from './character-references';
import { inlineHtmlRanges } from './inline-html-ranges';
import type { InlineHtmlElement } from './html-sanitize';

/**
 * Inline Markdown stays in the rich document as its source text. `**加粗**` is seven
 * characters of ordinary text; the view layer hides the markers and styles the content,
 * and shows the markers while the caret touches the span. Moving the caret therefore
 * never changes the document, and the original spelling is saved character for character.
 * Design and measurements: docs/inline-source-spike.md.
 */
export type InlineKind = 'strong' | 'em' | 'strike' | 'code' | 'highlight' | 'escape' | 'entity' | 'link' | 'autolink' | 'html';
export interface InlineSpan {
  kind: InlineKind;
  /** The whole construct, markers included. */
  from: number; to: number;
  /** The content between the markers. Escapes keep the escaped character here. */
  innerFrom: number; innerTo: number;
  /** Parsed destination and title ranges inside an inline link's tail. */
  urlFrom?: number; urlTo?: number;
  titleFrom?: number; titleTo?: number;
  /** Resolved link destination (`remark` URL). */
  href?: string;
  /** Resolved link title when present. */
  title?: string;
  /** The character an entity stands for. */
  value?: string;
  html?: InlineHtmlElement;
}

interface SourceNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: SourceNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Stands for an inline node that is not text (image, footnote reference, raw HTML…). */
export const INLINE_OBJECT = '\uFFFC';
// Block syntax cannot start mid-line, and a space keeps the first delimiter's flanking
// exactly as it is at the start of a line.
const GUARD = 'a ';
const parser = unified().use(remarkParse).use(remarkGfm);
const kinds: Record<string, InlineKind> = { strong: 'strong', emphasis: 'em', delete: 'strike', inlineCode: 'code' };
const ESCAPE = /^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
const ENTITY = /^&(?:#[xX][\da-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z\d]{1,31});/;

const LINK_ENTITY_OR_BACKSLASH = new RegExp(`\\\\|${ENTITY.source.slice(1)}`, 'g');
export const hasExternalLinkScheme = (url: string): boolean => /^(?:https?:\/\/|mailto:)/i.test(url);
/** Escape backslashes and Markdown-decodable entities inside link destinations/titles so they roundtrip verbatim. */
export function escapeLinkValue(value: string): string {
  return value.replace(LINK_ENTITY_OR_BACKSLASH, match =>
    match === '\\' ? '\\\\' : decodeEntity(match) !== match ? `\\${match}` : match,
  );
}

function offsets(node: SourceNode): { from: number; to: number } | null {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  // The guard shares a text node with the run's first characters.
  return from == null || to == null || to <= GUARD.length ? null : { from: Math.max(0, from - GUARD.length), to: to - GUARD.length };
}

const isLinkSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\v' || char === '\f';
function unescapeMarkdownString(raw: string): string {
  let result = '';
  for (let index = 0; index < raw.length;) {
    const rest = raw.slice(index), escaped = ESCAPE.exec(rest), entity = escaped ? null : ENTITY.exec(rest);
    if (escaped) { result += escaped[0][1]; index += 2; }
    else if (entity && decodeEntity(entity[0]) !== entity[0]) { result += decodeEntity(entity[0]); index += entity[0].length; }
    else result += raw[index++];
  }
  return result;
}

function splitInlineLinkTail(
  run: string,
  tailFrom: number,
  to: number,
  expectedUrl: string,
  expectedTitle: string,
): { urlFrom?: number; urlTo?: number; titleFrom?: number; titleTo?: number } | null {
  const end = to - 1;
  if (tailFrom + 2 > end || !run.startsWith('](', tailFrom) || run[end] !== ')') return null;
  let index = tailFrom + 2;
  while (index < end && isLinkSpace(run[index])) index++;
  let urlFrom: number | undefined, urlTo: number | undefined, rawUrl = '', hadUrl = false;
  if (index === end) {
    urlFrom = index; urlTo = index;
  } else if (run[index] === '<') {
    let cursor = index + 1;
    while (cursor < end) {
      if (run[cursor] === '\\' && cursor + 1 < end) { cursor += 2; continue; }
      if (run[cursor] === '>') break;
      if (run[cursor] === '<' || run[cursor] === '\n' || run[cursor] === '\r') return null;
      cursor++;
    }
    if (cursor >= end || run[cursor] !== '>') return null;
    urlFrom = index + 1; urlTo = cursor; rawUrl = run.slice(urlFrom, urlTo);
    index = cursor + 1; hadUrl = true;
  } else {
    let cursor = index, depth = 0;
    while (cursor < end) {
      const char = run[cursor];
      if (isLinkSpace(char)) break;
      if (char === '\\' && cursor + 1 < end) { cursor += 2; continue; }
      if (char === '(') { depth++; cursor++; continue; }
      if (char === ')') { if (depth === 0) break; depth--; cursor++; continue; }
      cursor++;
    }
    if (depth !== 0) return null;
    urlFrom = index; urlTo = cursor; rawUrl = run.slice(urlFrom, urlTo);
    index = cursor; hadUrl = true;
  }
  const afterUrl = index;
  while (index < end && isLinkSpace(run[index])) index++;
  let titleFrom: number | undefined, titleTo: number | undefined, rawTitle = '';
  if (index < end) {
    if (hadUrl && index === afterUrl) return null;
    const open = run[index];
    if (open !== '"' && open !== "'" && open !== '(') return null;
    const close = open === '(' ? ')' : open;
    let cursor = index + 1;
    while (cursor < end) {
      if (run[cursor] === '\\' && cursor + 1 < end) { cursor += 2; continue; }
      if (run[cursor] === close) break;
      cursor++;
    }
    if (cursor >= end || run[cursor] !== close) return null;
    titleFrom = index; titleTo = cursor + 1; rawTitle = run.slice(index + 1, cursor);
    index = cursor + 1;
    while (index < end && isLinkSpace(run[index])) index++;
    if (index !== end) return null;
  }
  if (unescapeMarkdownString(rawUrl) !== expectedUrl || unescapeMarkdownString(rawTitle) !== expectedTitle) return null;
  return {
    ...(urlFrom != null && urlTo != null ? { urlFrom, urlTo } : {}),
    ...(titleFrom != null && titleTo != null ? { titleFrom, titleTo } : {}),
  };
}

const cache = new Map<string, InlineSpan[]>();
/**
 * The syntax spans of one text block's source, as offsets into `run`. Soft line breaks
 * are "\n" and non-text inline nodes are INLINE_OBJECT, so offsets map 1:1 to positions.
 */
export function inlineSyntaxSpans(run: string, options?: { emptyLinks?: boolean }): InlineSpan[] {
  if (!/[*_`~=\\&[<@]|(?:www\.|:\/\/)/i.test(run)) return [];
  if (!options?.emptyLinks) {
    const cached = cache.get(run);
    if (cached) return cached;
  }
  const spans: InlineSpan[] = [];
  function visit(node: SourceNode): void {
    const delimMarkerWidth = (n: SourceNode, r: { from: number; to: number }) =>
      n.type === 'strong' ? 2 : n.type === 'emphasis' ? 1
        : n.type === 'delete' ? (run.startsWith('~~', r.from) && run.endsWith('~~', r.to) ? 2 : 1) : 0;
    const isGuard = (n: SourceNode) => n.position?.end.offset != null && n.position.end.offset <= GUARD.length;
    if (node.type === 'link') {
      const range = offsets(node);
      if (!range || range.from < 0) return;
      const raw = run.slice(range.from, range.to), href = node.url ?? '';
      if (!node.children?.length) {
        if (!options?.emptyLinks || !raw.startsWith('[]')) return;
        const inner = range.from + 1;
        const parts = splitInlineLinkTail(run, inner, range.to, href, node.title ?? '');
        spans.push({
          kind: 'link', ...range, innerFrom: inner, innerTo: inner, href,
          ...(node.title != null ? { title: node.title } : {}),
          ...(parts || {}),
        });
        return;
      }
      const first = offsets(node.children[0]), last = offsets(node.children.at(-1)!);
      if (!first || !last) return;
      if (first.from === range.from && last.to === range.to) {
        spans.push({ kind: 'autolink', ...range, innerFrom: range.from, innerTo: range.to, href });
        return;
      }
      if (raw.startsWith('<') && raw.endsWith('>') && first.from === range.from + 1 && last.to === range.to - 1) {
        spans.push({ kind: 'autolink', ...range, innerFrom: first.from, innerTo: last.to, href });
        return;
      }
      const parts = splitInlineLinkTail(run, last.to, range.to, href, node.title ?? '');
      spans.push({
        kind: 'link', ...range, innerFrom: first.from, innerTo: last.to, href,
        ...(node.title != null ? { title: node.title } : {}),
        ...(parts || {}),
      });
    } else {
      const kind = kinds[node.type], range = offsets(node);
      if (kind && range && range.from >= 0) {
        if (kind === 'code') {
          const fence = /^`+/.exec(run.slice(range.from, range.to))?.[0].length || 0;
          if (fence && range.to - range.from >= fence * 2) spans.push({ kind, ...range, innerFrom: range.from + fence, innerTo: range.to - fence });
        } else {
          const marker = delimMarkerWidth(node, range);
          const first = node.children?.[0] && offsets(node.children[0]), last = node.children?.length ? offsets(node.children.at(-1)!) : null;
          const innerFrom = first ? first.from : range.from + marker;
          const innerTo = last ? last.to : range.to - marker;
          if (innerFrom <= innerTo) spans.push({ kind, ...range, innerFrom, innerTo });
        }
      }
    }
    function scanPlainText(from: number, to: number, delimiters: { from: number; to: number }[]): void {
      if (from < 0 || to <= from) return;
      const raw = run.slice(from, to);
      for (let index = 0; index < raw.length;) {
        const rest = raw.slice(index), at = from + index;
        const escaped = ESCAPE.exec(rest), entity = escaped ? null : ENTITY.exec(rest);
        if (escaped) { spans.push({ kind: 'escape', from: at, to: at + 2, innerFrom: at + 1, innerTo: at + 2 }); index += 2; }
        else if (entity && decodeEntity(entity[0]) !== entity[0]) {
          spans.push({ kind: 'entity', from: at, to: at + entity[0].length, innerFrom: at + entity[0].length, innerTo: at + entity[0].length, value: decodeEntity(entity[0]) });
          index += entity[0].length;
        } else {
          if (rest.startsWith('==') && raw[index - 1] !== '=' && raw[index + 2] !== '=') { delimiters.push({ from: at, to: at + 2 }); index += 2; }
          else index++;
        }
      }
    }
    if (!node.children) return;
    // `==` pairs only among the direct text of one parent, as the previous parser did.
    const delimiters: { from: number; to: number }[] = [];
    const nodeRange = offsets(node);
    const parentMarker = nodeRange ? delimMarkerWidth(node, nodeRange) : 0;
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (isGuard(child)) continue;
      const childRange = offsets(child);
      if (!childRange) {
        let j = i;
        while (j + 1 < node.children.length && !offsets(node.children[j + 1]) && !isGuard(node.children[j + 1])) j++;
        const prevEnd = i > 0 && !isGuard(node.children[i - 1]) ? offsets(node.children[i - 1])?.to : undefined;
        const nextStart = j + 1 < node.children.length ? offsets(node.children[j + 1])?.from : undefined;
        let cursor = prevEnd ?? (nodeRange ? Math.max(0, nodeRange.from + parentMarker) : -1);
        const limit = nextStart ?? (nodeRange ? nodeRange.to - parentMarker : -1);
        if (cursor >= 0 && limit >= cursor) {
          for (let k = i; k <= j; k++) {
            const sub = node.children[k];
            if (sub.type === 'link' && sub.children?.length === 1 && sub.children[0].type === 'text' && sub.children[0].value) {
              const raw = sub.children[0].value, at = run.indexOf(raw, cursor);
              if (at >= 0 && at + raw.length <= limit) {
                scanPlainText(cursor, at, delimiters);
                spans.push({ kind: 'autolink', from: at, to: at + raw.length, innerFrom: at, innerTo: at + raw.length, href: sub.url ?? '' });
                cursor = at + raw.length;
                continue;
              }
            }
            if (sub.type !== 'text') visit(sub);
          }
          scanPlainText(cursor, limit, delimiters);
        } else {
          for (let k = i; k <= j; k++) visit(node.children[k]);
        }
        i = j;
        continue;
      }
      if (child.type === 'text' && childRange.from >= 0) scanPlainText(childRange.from, childRange.to, delimiters);
      visit(child);
    }
    for (let index = 0; index < delimiters.length - 1; index++) {
      const opening = delimiters[index], closing = delimiters[index + 1];
      const inner = run.slice(opening.to, closing.from);
      if (!inner || /^\s|\s$|[\r\n]/.test(inner)) continue;
      spans.push({ kind: 'highlight', from: opening.from, to: closing.to, innerFrom: opening.to, innerTo: closing.from });
      index++;
    }
  }
  const source = GUARD + run, tree = parser.parse(source) as SourceNode;
  visit(tree);
  if (run.includes('<')) {
    for (const child of tree.children || []) {
      for (const range of inlineHtmlRanges(child, source, true) || []) {
        const from = range.from - GUARD.length, to = range.to - GUARD.length;
        if (range.element) {
          spans.push({
            kind: 'html', html: range.element, from, to,
            innerFrom: range.innerFrom - GUARD.length, innerTo: range.innerTo - GUARD.length,
            ...(range.element.tag === 'a' ? { href: range.element.href } : {}),
          });
        } else {
          // Typed literal HTML stays plain until reopening. Its contents
          // must not acquire Markdown decorations or active links meanwhile.
          for (let index = spans.length - 1; index >= 0; index--) {
            if (from <= spans[index].from && spans[index].to <= to) spans.splice(index, 1);
          }
        }
      }
    }
  }
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  if (!options?.emptyLinks) {
    if (cache.size > 4000) cache.clear();
    cache.set(run, spans);
  }
  return spans;
}

// Inline source boundaries exclude ATX fences and the Setext underline.
export function headingContentRange(raw: string): { from: number; to: number } {
  const opening = /^#{1,6}(?:[ \t]+|$)/.exec(raw);
  const from = opening?.[0].length ?? 0;
  let body = raw.slice(from).replace(/[ \t]+$/, '');
  body = opening ? body.replace(/(?:^|[ \t]+)#+$/, '') : body.replace(/\r?\n[ \t>]*[=-]+$/, '');
  return { from, to: from + body.replace(/[ \t]+$/, '').length };
}

export interface HeadingAttribute { from: number; to: number }

export function headingAttributes(run: string, atEnd = true): HeadingAttribute[] {
  const ranges: HeadingAttribute[] = [];
  for (const match of run.matchAll(/\{[.#][\p{L}\p{N}_-]+(?:[ \t]+[.#][\p{L}\p{N}_-]+)*\}/gu)) {
    const start = match.index, to = start + match[0].length;
    // Code spans, escaped braces, HTML tags and link destinations are literal syntax.
    if (inlineSyntaxSpans(run).some(span => start < span.to && span.from < to &&
        (span.kind === 'code' || span.kind === 'escape' && span.from <= start ||
         ['html', 'link', 'autolink'].includes(span.kind) && (start < span.innerFrom || to > span.innerTo)))) continue;
    const from = atEnd && to === run.length && run[start - 1] === ' ' ? start - 1 : start;
    ranges.push({ from, to });
  }
  return ranges;
}

export function withoutHeadingAttributes(run: string, atEnd = true): string {
  let result = run;
  for (const { from, to } of headingAttributes(run, atEnd).reverse()) result = result.slice(0, from) + result.slice(to);
  return result;
}

/** What the reader sees for a run: markers, escape backslashes and entities resolved. */
export function inlineSourceText(run: string): string {
  const spans = inlineSyntaxSpans(run);
  if (!spans.length) return run;
  const hidden = new Uint8Array(run.length), inserts = new Map<number, string>();
  for (const span of spans) {
    for (let index = span.from; index < span.innerFrom; index++) hidden[index] = 1;
    for (let index = span.innerTo; index < span.to; index++) hidden[index] = 1;
    if (span.kind === 'entity') inserts.set(span.from, span.value || '');
  }
  let text = '';
  for (let index = 0; index < run.length; index++) {
    if (inserts.has(index)) text += inserts.get(index);
    if (!hidden[index]) text += run[index];
  }
  return text;
}

/** The marker pair a formatting command writes. */
export function inlineMarkers(kind: InlineKind, content = ''): [string, string] {
  if (kind === 'strong') return ['**', '**'];
  if (kind === 'em') return ['*', '*'];
  if (kind === 'strike') return ['~~', '~~'];
  if (kind === 'highlight') return ['==', '=='];
  if (kind === 'code') {
    const longest = Math.max(0, ...(content.match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(longest + 1), pad = /^`|`$/.test(content) ? ' ' : '';
    return [fence + pad, pad + fence];
  }
  return ['', ''];
}

const HTML_BLOCK = /^<(?:(?:script|pre|style|textarea)(?=[\s>]|$)|!--|\?|![A-Za-z]|!\[CDATA\[|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s/>]|$))/i;

/**
 * Source text is written verbatim, so the one thing a line of it must never do is start
 * a different block when the file is read back. `line` is the whole physical line and
 * `value` its leading text; returns `value` with the minimum escape, or unchanged.
 */
export function guardLineStart(value: string, line: string, firstLine: boolean): string {
  if (!value) return value;
  if (/^[ \t]/.test(value)) return (value[0] === ' ' ? '&#x20;' : '&#x9;') + value.slice(1);
  const ordered = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(line);
  if (ordered && value.length > ordered[1].length) return ordered[1] + '\\' + value.slice(ordered[1].length);
  if (/^#{1,6}(?=[ \t]|$)/.test(line) || /^>/.test(line) || /^[-+*](?=[ \t]|$)/.test(line) ||
      /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line) || /^`{3,}[^`]*$/.test(line) || /^~{3,}/.test(line) || HTML_BLOCK.test(line)) return '\\' + value;
  if (firstLine && (/^\[(?:\\.|[^\]\\])+\]:/.test(line) || /^<(?:[A-Za-z][A-Za-z0-9-]*(?:(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?)|\/[A-Za-z][A-Za-z0-9-]*[ \t]*)>[ \t]*$/.test(line))) return '\\' + value;
  if (!firstLine && (/^(?:=+|-+)[ \t]*$/.test(line) || line.includes('|') && /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line))) return '\\' + value;
  return value;
}

/** A GFM cell ends at the first unescaped pipe. */
export function escapeCellPipes(value: string): string {
  let result = '', escaped = false;
  for (const char of value) {
    if (char === '|' && !escaped) result += '\\';
    result += char;
    escaped = char === '\\' ? !escaped : false;
  }
  return result;
}

/** Give text that never had a source spelling one that reads back as the same characters. */
export function escapeLiteralText(value: string): string {
  return value.replace(/[\\`*_~[\]<&]/g, '\\$&');
}
