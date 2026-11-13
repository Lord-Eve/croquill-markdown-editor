import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

/**
 * Inline Markdown stays in the rich document as its source text. `**加粗**` is seven
 * characters of ordinary text; the view layer hides the markers and styles the content,
 * and shows the markers while the caret touches the span. Moving the caret therefore
 * never changes the document, and the original spelling is saved character for character.
 * Design and measurements: docs/inline-source-spike.md.
 */
export type InlineKind = 'strong' | 'em' | 'strike' | 'code' | 'highlight' | 'escape' | 'entity';
export interface InlineSpan {
  kind: InlineKind;
  /** The whole construct, markers included. */
  from: number; to: number;
  /** The content between the markers. Escapes keep the escaped character here. */
  innerFrom: number; innerTo: number;
  /** The character an entity stands for. */
  value?: string;
}

interface SourceNode {
  type: string;
  value?: string;
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

const entityParser = unified().use(remarkParse);
const entities = new Map<string, string>();
function decodeEntity(raw: string): string {
  if (!entities.has(raw)) {
    const paragraph = entityParser.parse(raw).children[0] as SourceNode | undefined;
    const first = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
    entities.set(raw, first?.type === 'text' && paragraph!.children!.length === 1 ? first.value || raw : raw);
  }
  return entities.get(raw)!;
}

function offsets(node: SourceNode): { from: number; to: number } | null {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  // The guard shares a text node with the run's first characters.
  return from == null || to == null || to <= GUARD.length ? null : { from: Math.max(0, from - GUARD.length), to: to - GUARD.length };
}

const cache = new Map<string, InlineSpan[]>();
/**
 * The syntax spans of one text block's source, as offsets into `run`. Soft line breaks
 * are "\n" and non-text inline nodes are INLINE_OBJECT, so offsets map 1:1 to positions.
 */
export function inlineSyntaxSpans(run: string): InlineSpan[] {
  if (!/[*_`~=\\&]/.test(run)) return [];
  const cached = cache.get(run);
  if (cached) return cached;
  const spans: InlineSpan[] = [];
  function visit(node: SourceNode): void {
    const kind = kinds[node.type], range = offsets(node);
    if (kind && range && range.from >= 0) {
      if (kind === 'code') {
        const fence = /^`+/.exec(run.slice(range.from, range.to))?.[0].length || 0;
        if (fence && range.to - range.from >= fence * 2) spans.push({ kind, ...range, innerFrom: range.from + fence, innerTo: range.to - fence });
      } else {
        const first = node.children?.[0] && offsets(node.children[0]), last = node.children?.length ? offsets(node.children.at(-1)!) : null;
        if (first && last) spans.push({ kind, ...range, innerFrom: first.from, innerTo: last.to });
      }
    }
    if (!node.children) return;
    // `==` pairs only among the direct text of one parent, as the previous parser did.
    const delimiters: { from: number; to: number }[] = [];
    for (const child of node.children) {
      const childRange = child.type === 'text' ? offsets(child) : null;
      if (childRange && childRange.from >= 0) {
        const raw = run.slice(childRange.from, childRange.to);
        for (let index = 0; index < raw.length;) {
          const rest = raw.slice(index), at = childRange.from + index;
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
  visit(parser.parse(GUARD + run) as unknown as SourceNode);
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  if (cache.size > 4000) cache.clear();
  cache.set(run, spans);
  return spans;
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
  if (firstLine && (/^\[(?:\\.|[^\]\\])+\]:/.test(line) || /^<\/?[A-Za-z][^<>]*>[ \t]*$/.test(line))) return '\\' + value;
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
