import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
interface SourceNode {
  type: string;
  value?: string;
  children?: SourceNode[];
  align?: (string | null)[];
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface TableSource { node: SourceNode; context: string }

/** Tables may be nested inside any combination of quotes, lists and list items. */
function tablesOf(root: SourceNode): TableSource[] {
  const tables: TableSource[] = [];
  function visit(node: SourceNode, ancestors: unknown[]): void {
    if (node.type === 'table') { tables.push({ node, context: JSON.stringify(ancestors) }); return; }
    const context = node.type === 'root' ? ancestors : [...ancestors, {
      type: node.type, ordered: node.ordered ?? null, start: node.start ?? null, checked: node.checked ?? null,
    }];
    node.children?.forEach(child => visit(child, context));
  }
  visit(root, []);
  return tables;
}

/** Include the first row's container prefix and the original final line ending. */
function tableRange(node: SourceNode, source: string): { from: number; to: number } | null {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start == null || end == null) return null;
  const from = Math.max(source.lastIndexOf('\n', start - 1), source.lastIndexOf('\r', start - 1)) + 1;
  const tail = /^[ \t\r\n]*/.exec(source.slice(end))![0];
  return { from, to: end + tail.length };
}

function semantic(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(semantic);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'position' && key !== 'data').map(([key, value]) => [key, semantic(value)]));
}

function hasInlineSource(node: SourceNode): boolean {
  return node.type === 'html' || !!node.children?.some(hasInlineSource);
}

/** Child positions exclude both pipe delimiters and the cell's padding. */
function contentRange(cell: SourceNode, source: string): { from: number; to: number } | null {
  const first = cell.children?.[0]?.position?.start.offset;
  const last = cell.children?.at(-1)?.position?.end.offset;
  if (first != null && last != null) return { from: first, to: last };
  const start = cell.position?.start.offset, end = cell.position?.end.offset;
  if (start == null || end == null) return null;
  const raw = source.slice(start, end);
  // An empty cell has no child positions; insert after its existing left padding.
  const from = start + (/^\|?[ \t]*/.exec(raw)?.[0].length || 0);
  return { from, to: from };
}

function patchTable(original: string, before: SourceNode, serialized: string, after: SourceNode): string | null {
  const range = tableRange(before, original);
  if (!range || !before.children || !after.children ||
      before.children.length !== after.children.length || JSON.stringify(before.align) !== JSON.stringify(after.align)) return null;
  const changes: { from: number; to: number; text: string }[] = [];
  for (let row = 0; row < before.children.length; row++) {
    const left = before.children[row].children, right = after.children[row].children;
    if (!left || !right || left.length !== right.length) return null;
    for (let column = 0; column < left.length; column++) {
      if (JSON.stringify(semantic(left[column])) === JSON.stringify(semantic(right[column]))) continue;
      const oldRange = contentRange(left[column], original), newRange = contentRange(right[column], serialized);
      if (!oldRange || !newRange) return null;
      changes.push({ ...oldRange, text: serialized.slice(newRange.from, newRange.to) });
    }
  }
  let result = original.slice(range.from, range.to);
  for (const change of changes.reverse()) result = result.slice(0, change.from - range.from) + change.text + result.slice(change.to - range.from);
  return result;
}

/** Preserve the layout of tables with literal HTML or BR while applying cell edits. */
export function preserveTableSource(original: string, serialized: string): string {
  if (!original.includes('<') && !serialized.includes('<')) return serialized;
  const before = parser.parse(original) as unknown as SourceNode;
  const after = parser.parse(serialized) as unknown as SourceNode;
  const oldTables = tablesOf(before), newTables = tablesOf(after);
  if (oldTables.length !== newTables.length) return serialized;
  const changes: { from: number; to: number; text: string }[] = [];
  for (let index = 0; index < oldTables.length; index++) {
    const { node: left, context: oldContext } = oldTables[index];
    const { node: right, context: newContext } = newTables[index];
    if (oldContext !== newContext) continue;
    if (!hasInlineSource(left) && !hasInlineSource(right)) continue;
    const text = patchTable(original, left, serialized, right);
    const range = tableRange(right, serialized);
    if (text == null || !range) continue;
    changes.push({ ...range, text });
  }
  let result = serialized;
  for (const change of changes.reverse()) result = result.slice(0, change.from) + change.text + result.slice(change.to);
  // Check the complete document: a standalone reparse loses a nested table's
  // quote/list context and cannot detect whether a splice changed that context.
  return JSON.stringify(semantic(parser.parse(result))) === JSON.stringify(semantic(after)) ? result : serialized;
}
