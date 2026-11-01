import type { Ctx } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import type { Root } from '@milkdown/kit/transformer';
import { $inputRule, $mark } from '@milkdown/kit/utils';
import { markRule } from '@milkdown/kit/prose';
import type { Handle } from 'mdast-util-to-markdown';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

declare module 'mdast-util-to-markdown' {
  interface ConstructNameMap { croquillHighlight: 'croquillHighlight' }
}

interface InlineNode {
  type: string;
  value?: string;
  children?: InlineNode[];
  originalSource?: string;
  originalSignature?: string;
  data?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
}

/** Compare editable content, ignoring parser positions and writer-only metadata. */
function contentValue(node: InlineNode): unknown {
  if (node.type === 'croquillInlineRaw') return { type: 'html', value: node.value };
  if (node.type === 'break' && node.data?.croquillHtmlBreak) return { type: 'html', value: node.data.croquillHtmlBreak };
  if (node.type === 'footnoteReference' && node.data?.croquillFootnoteRaw) return { type: 'html', value: node.data.croquillFootnoteRaw };
  return Object.fromEntries(Object.keys(node).sort().filter(key =>
    node[key] !== undefined && !(key === 'children' && !node.children?.length) &&
    !['position', 'data', 'marker', 'isMark', 'originalSource', 'originalSignature'].includes(key)
  ).map(key => [key, key === 'children' ? contentValues(node.children || []) : node[key]]));
}
function contentValues(children: InlineNode[]): unknown[] {
  const values: Record<string, unknown>[] = [];
  for (const child of children) {
    const value = contentValue(child) as Record<string, unknown>, previous = values.at(-1);
    if (value.type === 'text' && previous?.type === 'text') previous.value = String(previous.value) + String(value.value);
    else values.push(value);
  }
  return values;
}

const entityParser = unified().use(remarkParse);
const entities = new Map<string, string>();
function decodeEntity(raw: string): string {
  if (!entities.has(raw)) {
    const paragraph = entityParser.parse(raw).children[0];
    entities.set(raw, paragraph?.type === 'paragraph' && paragraph.children[0]?.type === 'text' ? paragraph.children[0].value : raw);
  }
  return entities.get(raw)!;
}

/** Source positions distinguish real delimiters from escapes and decoded entities. */
function splitDelimiters(node: InlineNode, source: string): InlineNode[] {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  if (node.type !== 'text' || from == null || to == null || !node.value?.includes('==')) return [node];
  const raw = source.slice(from, to), valueLines = node.value.split('\n');
  const delimiters: { index: number; from: number; to: number }[] = [];
  let rawStart = from, valueStart = 0;
  for (const [lineIndex, rawLine] of raw.split(/\r\n|\r|\n/).entries()) {
    let decoded = '';
    const candidates: { index: number; from: number; to: number }[] = [];
    for (let index = 0; index < rawLine.length;) {
      const rest = rawLine.slice(index);
      const escaped = /^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.exec(rest);
      const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/.exec(rest);
      if (escaped) { decoded += escaped[0][1]; index += 2; }
      else if (entity) { decoded += decodeEntity(entity[0]); index += entity[0].length; }
      else {
        if (rest.startsWith('==') && rawLine[index - 1] !== '=' && rawLine[index + 2] !== '=') {
          candidates.push({ index: decoded.length, from: rawStart + index, to: rawStart + index + 2 });
        }
        decoded += rawLine[index++];
      }
    }
    const line = valueLines[lineIndex] ?? '';
    // On continuation lines remark omits quote/list container prefixes.
    if (decoded.endsWith(line)) for (const candidate of candidates) {
      const index = candidate.index - (decoded.length - line.length);
      if (index >= 0) delimiters.push({ ...candidate, index: valueStart + index });
    }
    valueStart += line.length + 1;
    const ending = /^(?:\r\n|\r|\n)/.exec(source.slice(rawStart + rawLine.length))?.[0] || '';
    rawStart += rawLine.length + ending.length;
  }
  const pieces: InlineNode[] = [];
  let start = 0;
  for (const delimiter of delimiters) {
    if (delimiter.index > start) pieces.push({ type: 'text', value: node.value.slice(start, delimiter.index) });
    pieces.push({ type: 'croquillHighlightDelimiter', value: '==', position: { start: { offset: delimiter.from }, end: { offset: delimiter.to } } });
    start = delimiter.index + 2;
  }
  if (start < node.value.length) pieces.push({ type: 'text', value: node.value.slice(start) });
  return pieces.length ? pieces : [node];
}

/** Keep Markdown children editable, including strong/emphasis/code within ==. */
export function parseHighlights() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? '');
    function visit(node: InlineNode): void {
      if (!node.children || ['code', 'inlineCode', 'html', 'croquillInlineRaw', 'croquillRawBlock'].includes(node.type)) return;
      node.children.forEach(visit);
      const pieces = node.children.flatMap(child => splitDelimiters(child, source));
      const result: InlineNode[] = [];
      for (let index = 0; index < pieces.length; index++) {
        const opening = pieces[index];
        if (opening.type !== 'croquillHighlightDelimiter') { result.push(opening); continue; }
        const closingIndex = pieces.findIndex((piece, next) => next > index && piece.type === 'croquillHighlightDelimiter');
        const children = pieces.slice(index + 1, closingIndex);
        const textOf = (child: InlineNode): string => child.value ?? child.children?.map(textOf).join('') ?? '';
        const text = children.map(textOf).join('');
        if (closingIndex < 0 || !text || /^\s|\s$|[\r\n]/.test(text)) {
          result.push({ type: 'text', value: '==' }); continue;
        }
        const closing = pieces[closingIndex];
        result.push({ type: 'croquillHighlight', children,
          originalSource: source.slice(opening.position!.start.offset!, closing.position!.end.offset!),
          originalSignature: JSON.stringify(contentValues(children)),
        });
        index = closingIndex;
      }
      node.children = result;
    }
    visit(tree as unknown as InlineNode);
    return tree;
  };
}

const writeHighlight: Handle = (node, _parent, state, info) => {
  const highlight = node as unknown as InlineNode;
  if (highlight.originalSource && highlight.originalSignature === JSON.stringify(contentValues(highlight.children || []))) return highlight.originalSource;
  const exit = state.enter('phrasing');
  const exitHighlight = state.enter('croquillHighlight');
  const tracker = state.createTracker(info);
  tracker.move('==');
  const value = '==' + state.containerPhrasing(node as Parameters<typeof state.containerPhrasing>[0], {
    ...tracker.current(), before: '=', after: '=',
  }) + '==';
  exitHighlight(); exit();
  return value;
};

export function configureHighlights(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, options => ({
    ...options, handlers: { ...options.handlers, croquillHighlight: writeHighlight },
    unsafe: [...(options.unsafe || []), { character: '=', inConstruct: 'croquillHighlight' as const }],
  }));
}

export const highlightMark = $mark('croquill_highlight', () => ({
  priority: 20, inclusive: false,
  attrs: { originalSource: { default: '', validate: 'string' }, originalSignature: { default: '', validate: 'string' } },
  parseDOM: [{ tag: 'mark', getAttrs: dom => ({ originalSource: dom.getAttribute('data-croquill-highlight-source') || '', originalSignature: dom.getAttribute('data-croquill-highlight-signature') || '' }) }],
  toDOM: mark => ['mark', { 'data-croquill-highlight-source': mark.attrs.originalSource, 'data-croquill-highlight-signature': mark.attrs.originalSignature }, 0],
  parseMarkdown: {
    match: node => node.type === 'croquillHighlight',
    runner: (state, node, type) => {
      state.openMark(type, { originalSource: node.originalSource || '', originalSignature: node.originalSignature || '' }).next(node.children).closeMark(type);
    },
  },
  toMarkdown: {
    match: mark => mark.type.name === 'croquill_highlight',
    runner: (state, mark) => { state.withMark(mark, 'croquillHighlight', undefined, { originalSource: mark.attrs.originalSource, originalSignature: mark.attrs.originalSignature }); },
  },
}));

export const highlightInputRule = $inputRule(ctx => markRule(/(?<![=\\])==([^=\n]+)==$/, highlightMark.type(ctx)));
