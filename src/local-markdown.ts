import { Fragment, type Node as RichNode } from '@milkdown/kit/prose/model';
import type { RootContent } from 'mdast';
import { parseMarkdownAst, preservedMarkdownBlocks, splitFrontmatter, markdownNodeSignature } from './fidelity';
import { hasPlainExtension } from './rendered-source';
import { matchesRichDocument } from './untouched-source';

interface BlockRange { from: number; to: number; blocked: boolean; origin: string | null }
interface BlockIndex { ranges: BlockRange[]; metadata: boolean; definitions: boolean; plainExtension: boolean }

function hasDefinitions(node: { type: string; children?: readonly RootContent[] }): boolean {
  return node.type === 'definition' || node.type === 'footnoteDefinition' || !!node.children?.some(hasDefinitions);
}

function matchesType(node: RootContent, rich: RichNode): boolean {
  const type = rich.type.name;
  switch (node.type) {
    case 'list': return type === (node.ordered ? 'ordered_list' : 'bullet_list');
    case 'heading': return type === 'heading' && rich.attrs.level === node.depth;
    case 'paragraph': return ['paragraph', 'image-block', 'croquill_toc'].includes(type);
    case 'blockquote': return type === 'blockquote' || type === 'croquill_alert';
    case 'thematicBreak': return type === 'hr';
    case 'html': return type === 'croquill_html_comment';
    case 'code': return type === 'code_block';
    case 'math': return type === 'math_block' || type === 'code_block' && rich.attrs.language === 'LaTeX';
    case 'footnoteDefinition': return type === 'footnote_definition';
    default: return type === node.type;
  }
}

/** Offsets are UTF-16 source offsets, so slicing never transcodes BOM, CRLF or Unicode. */
export function indexMarkdown(raw: string, doc: RichNode): BlockIndex | null {
  const { prefix, body } = splitFrontmatter(raw), nodes = parseMarkdownAst(body).children;
  const protectedBlocks = preservedMarkdownBlocks(body);
  const ranges: BlockRange[] = [];
  let p = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], start = node.position?.start.offset;
    let end = node.position?.end.offset;
    const rich = doc.maybeChild(ranges.length);
    if (start == null || end == null || !rich) return null;
    const protectedBlock = protectedBlocks[p];
    const opaque = protectedBlock?.from === start;
    if (opaque) {
      if (rich.type.name !== 'croquill_raw_block') return null;
      while (i + 1 < nodes.length && nodes[i + 1].position!.start.offset! < protectedBlock.to) i++;
      end = nodes[i].position!.end.offset!;
      p++;
    } else if (!matchesType(node, rich)) return null;
    const blocked = opaque || node.type === 'html' || hasDefinitions(node) || rich.type.name === 'croquill_toc';
    ranges.push({ from: prefix.length + start, to: prefix.length + end, origin: body.slice(start, end), blocked });
  }
  if (doc.childCount === ranges.length + 1 && doc.lastChild?.type.name === 'paragraph' && !doc.lastChild.content.size) {
    ranges.push({ from: raw.length, to: raw.length, origin: '', blocked: true });
  }
  if (ranges.length !== doc.childCount) return null;
  return { ranges, metadata: !!prefix.replace('\uFEFF', ''), definitions: nodes.some(hasDefinitions), plainExtension: hasPlainExtension(raw) };
}

type Serialize = (before: RichNode, after: RichNode, old: string, origin: string, plainExtension: boolean) => string;
const supported = new Set(['paragraph', 'heading', 'table', 'bullet_list', 'ordered_list', 'blockquote', 'croquill_alert', 'code_block', 'math_block']);

function fragment(doc: RichNode, from: number, to: number): RichNode {
  return doc.copy(Fragment.fromArray(Array.from({ length: to - from }, (_, i) => doc.child(from + i))));
}

/** Only publish after the fragment and both separators survive Markdown parsing in context. */
export function localMarkdown(index: BlockIndex, raw: string, before: RichNode, after: RichNode,
  serialize: Serialize, parseRich: (source: string) => RichNode): string | null {
  const { ranges } = index;
  let first = 0, oldEnd = before.childCount, newEnd = after.childCount;
  while (first < oldEnd && first < newEnd && before.child(first) === after.child(first)) first++;
  while (first < oldEnd && first < newEnd && before.child(oldEnd - 1) === after.child(newEnd - 1)) { oldEnd--; newEnd--; }
  if (first === oldEnd || first === newEnd || (index.metadata && first === 0)) return null;
  const left = Math.max(0, first - 1), right = Math.min(ranges.length, oldEnd + 1);
  if (ranges.slice(left, right).some(range => range.blocked)) return null;
  const oldDoc = fragment(before, first, oldEnd), newDoc = fragment(after, first, newEnd);
  for (const doc of [oldDoc, newDoc]) for (let i = 0; i < doc.childCount; i++) {
    if (!supported.has(doc.child(i).type.name) || !doc.child(i).content.size) return null;
  }
  const start = ranges[first].from, end = ranges[oldEnd - 1].to;
  const old = raw.slice(start, end);
  // The full writer can restore original table/list spellings on subsequent edits.
  // A multi-block edit without a contiguous original slice uses that writer.
  if (oldEnd - first > 1 && ranges.slice(first, oldEnd).some(r => r.origin !== raw.slice(r.from, r.to))) return null;
  let origin = oldEnd === first + 1 ? ranges[first].origin : old;
  // Newly split or replaced blocks can lack an opening counterpart. For plain
  // prose none of the opening-source restorers apply to the new Markdown.
  if (origin === null && newDoc.childCount === 1 && newDoc.firstChild!.type.name === 'paragraph' &&
      newDoc.firstChild!.childCount === 1 && newDoc.firstChild!.firstChild!.isText &&
      /^[\p{L}\p{N} 。，！？、]+$/u.test(newDoc.firstChild!.textContent)) origin = '';
  if (origin === null || splitFrontmatter(old).prefix || splitFrontmatter(origin).prefix) return null;
  const written = serialize(oldDoc, newDoc, old, origin, index.plainExtension);
  const nodes = parseMarkdownAst(written).children;
  if (nodes.length !== newDoc.childCount || nodes.some(hasDefinitions) || preservedMarkdownBlocks(written).length) return null;
  // The writer appends a newline. Only replace the blocks themselves, never their surrounding whitespace.
  const writtenEnd = nodes.at(-1)?.position?.end.offset;
  if (writtenEnd == null || nodes[0].position?.start.offset !== 0 || /\S/.test(written.slice(writtenEnd))) return null;
  const text = written.slice(0, writtenEnd);
  if ((first === 0 && /^(?:---|\+\+\+)(?:\s|$)/.test(text)) || (index.definitions && /\[/.test(old + text))) return null;
  const previousType = first > 0 && before.child(first - 1).type.name;
  const firstText = newDoc.firstChild?.textContent || '';
  if ((previousType === 'table' && /^\s*\|/.test(firstText)) ||
      ((previousType === 'bullet_list' || previousType === 'ordered_list') && /^\s*[-+*]\s/.test(firstText))) return null;
  let parsed: RichNode;
  try { parsed = parseRich(text); } catch { return null; }
  if (!matchesRichDocument(parsed, newDoc)) return null;

  // Include indentation before the first node and trailing spaces after the last.
  // Either can affect Markdown parsing at the edge of a verification window.
  const leftStart = ranges[left].from, rightEnd = ranges[right - 1].to;
  let windowStart = leftStart;
  while (windowStart > 0 && (raw[windowStart - 1] === ' ' || raw[windowStart - 1] === '\t')) windowStart--;
  const windowEnd = rightEnd + (/^[ \t]*/.exec(raw.slice(rightEnd))![0].length);
  const oldWindow = raw.slice(windowStart, windowEnd);
  const window = raw.slice(windowStart, start) + text + raw.slice(end, windowEnd);
  const previous = parseMarkdownAst(oldWindow).children, current = parseMarkdownAst(window).children;
  if (previous.length !== right - left || current.length !== previous.length + newEnd - oldEnd) return null;
  if (index.definitions && /\[/.test(oldWindow + window)) return null;
  if (previous.some((node, i) => node.position!.start.offset !== ranges[left + i].from - windowStart ||
      node.position!.end.offset !== ranges[left + i].to - windowStart)) return null;
  const delta = text.length - old.length;
  for (const [i, node] of current.entries()) {
    const changed = i >= first - left && i < newEnd - left;
    const other = changed ? nodes[i + left - first] : previous[i < first - left ? i : i + oldEnd - newEnd];
    const shift = changed ? start - windowStart : i < first - left ? 0 : delta;
    if (node.position!.start.offset !== other.position!.start.offset! + shift ||
        node.position!.end.offset !== other.position!.end.offset! + shift ||
        markdownNodeSignature(node, window) !== markdownNodeSignature(other, changed ? written : oldWindow)) return null;
  }
  const replacement = nodes.map((node, i) => {
    const from = node.position!.start.offset!, to = node.position!.end.offset!;
    return { from: start + from, to: start + to, blocked: false,
      origin: nodes.length === oldEnd - first ? ranges[first + i].origin : null };
  });
  for (let i = oldEnd; i < ranges.length; i++) { ranges[i].from += delta; ranges[i].to += delta; }
  ranges.splice(first, oldEnd - first, ...replacement);
  const result = raw.slice(0, start) + text + raw.slice(end);
  index.plainExtension = hasPlainExtension(result);
  return result;
}
