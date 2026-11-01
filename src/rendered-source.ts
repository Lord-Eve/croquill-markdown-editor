import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { alertTypeOf } from './alert-types';
import { isHtmlComment } from './html-comments';
import { tocMarkerOf } from './document-syntax';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
interface SourceNode {
  type: string;
  value?: string;
  children?: SourceNode[];
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['position', 'data'].includes(key)).map(([key, child]) =>
    [key, key === 'value' && typeof child === 'string' ? child.replace(/\r\n?/g, '\n') : semantic(child)]));
}
function proseOf(node: SourceNode): string {
  if (node.type === 'text') return node.value || '';
  if (['code', 'math'].includes(node.type)) return '\n';
  if (['inlineCode', 'inlineMath', 'html'].includes(node.type)) return '\0';
  return node.children?.map(proseOf).join('') || '';
}
function hasRenderedSyntax(node: SourceNode, source: string): boolean {
  if (node.type === 'footnoteDefinition' || node.type === 'footnoteReference' || tocMarkerOf(node, source)) return true;
  if (node.type === 'text' && /\[\^[^\]\r\n]+\]/.test(node.value || '')) return true;
  if (node.type === 'html') return isHtmlComment(node.value || '');
  if (['code', 'inlineCode', 'math', 'inlineMath'].includes(node.type)) return false;
  return !!alertTypeOf(node, source) ||
    ['paragraph', 'heading', 'tableCell'].includes(node.type) && /==[^\n]+==/.test(proseOf(node)) ||
    !!node.children?.some(child => hasRenderedSyntax(child, source));
}
function range(node: SourceNode, source: string, separator = true): { from: number; to: number } | null {
  const from = node.position?.start.offset, end = node.position?.end.offset;
  if (from == null || end == null) return null;
  return { from, to: end + (separator ? /^[ \t\r\n]*/.exec(source.slice(end))?.[0].length || 0 : 0) };
}

function containerContext(node: SourceNode, source: string, context: string): string {
  return node.type === 'root' ? context : context + JSON.stringify({
    type: node.type, ordered: node.ordered ?? null, start: node.start ?? null,
    checked: node.checked ?? null, alert: alertTypeOf(node, source),
  });
}

interface SourceQueue { nodes: SourceNode[]; next: number }
function enqueue(queues: Map<string, SourceQueue>, key: string, node: SourceNode): void {
  const queue = queues.get(key);
  if (queue) queue.nodes.push(node);
  else queues.set(key, { nodes: [node], next: 0 });
}

/** Restore unchanged extension-bearing blocks, including their literal separators. */
export function preserveRenderedSource(original: string, serialized: string): string {
  if (!/==|<!--|\[!|\[\^|\[toc\]/i.test(original)) return serialized;
  const before = parser.parse(original), after = parser.parse(serialized);
  // Content queues allow unrelated blocks to be inserted, removed or moved.
  // Consume every original match once, retaining the order of repeated content
  // without an O(n*m) document alignment on long files.
  const sources = new Map<string, SourceQueue>();
  for (const node of before.children as SourceNode[]) {
    enqueue(sources, JSON.stringify(semantic(node)), node);
  }
  type Change = { from: number; to: number; text: string };
  const wholeBlocks = new Map<SourceNode, Change>();
  for (const right of after.children as SourceNode[]) {
    const queue = sources.get(JSON.stringify(semantic(right)));
    const left = queue?.nodes[queue.next++];
    if (!left || !hasRenderedSyntax(left, original)) continue;
    const a = range(left, original), b = range(right, serialized);
    if (a && b) wholeBlocks.set(right, { ...b, text: original.slice(a.from, a.to) });
  }
  // Comments can remain untouched while a sibling paragraph in the same
  // quote/list changes. Match them only inside the same container hierarchy:
  // old continuation prefixes must never leak into a new paste/drop target.
  const comments = new Map<string, SourceQueue>();
  function collectComments(node: SourceNode, context: string): void {
    if (node.type === 'html' && isHtmlComment(node.value || '')) enqueue(comments, context + JSON.stringify(semantic(node)), node);
    const nextContext = containerContext(node, original, context);
    node.children?.forEach(child => collectComments(child, nextContext));
  }
  collectComments(before as SourceNode, '');
  const changes: Change[] = [];
  function restoreComments(node: SourceNode, context: string, covered: boolean): void {
    const wholeBlock = wholeBlocks.get(node);
    if (wholeBlock) changes.push(wholeBlock);
    covered ||= !!wholeBlock;
    if (node.type === 'html' && isHtmlComment(node.value || '')) {
      const queue = comments.get(context + JSON.stringify(semantic(node)));
      const left = queue?.nodes[queue.next++];
      // Consume matches even inside an already-restored block so a later copy
      // cannot reuse that source or take the wrong duplicate's spelling.
      if (left && !covered) {
        const a = range(left, original, false), b = range(node, serialized, false);
        if (a && b) changes.push({ ...b, text: original.slice(a.from, a.to) });
      }
    }
    const nextContext = containerContext(node, serialized, context);
    node.children?.forEach(child => restoreComments(child, nextContext, covered));
  }
  restoreComments(after as SourceNode, '', false);
  let result = serialized;
  for (const change of changes.reverse()) result = result.slice(0, change.from) + change.text + result.slice(change.to);
  // Never accept a source splice that changes the document's parsed structure.
  return JSON.stringify(semantic(parser.parse(result))) === JSON.stringify(semantic(after)) ? result : serialized;
}
