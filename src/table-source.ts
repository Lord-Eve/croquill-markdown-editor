import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { isBareHtmlBreak } from './fidelity';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
interface SourceNode {
  type: string;
  value?: string;
  children?: SourceNode[];
  align?: (string | null)[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function semantic(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(semantic);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'position' && key !== 'data').map(([key, value]) => [key, semantic(value)]));
}

function hasBareBreak(node: SourceNode): boolean {
  return node.type === 'html' && isBareHtmlBreak(node.value || '') || !!node.children?.some(hasBareBreak);
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
  const start = before.position?.start.offset, end = before.position?.end.offset;
  if (start == null || end == null || !before.children || !after.children ||
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
  let result = original.slice(start, end);
  for (const change of changes.reverse()) result = result.slice(0, change.from - start) + change.text + result.slice(change.to - start);
  // Keep the normal writer's output if a source splice would change its meaning.
  const reparsed = parser.parse(result).children;
  if (reparsed.length !== 1 || JSON.stringify(semantic(reparsed[0])) !== JSON.stringify(semantic(after))) return null;
  return result;
}

/** Preserve the layout of editable BR tables while applying actual cell edits. */
export function preserveTableSource(original: string, serialized: string): string {
  if (!/<br(?: ?\/)?>/i.test(original + serialized)) return serialized;
  const before = parser.parse(original).children as unknown as SourceNode[];
  const after = parser.parse(serialized).children as unknown as SourceNode[];
  const oldTables = before.filter(node => node.type === 'table');
  const newTables = after.filter(node => node.type === 'table');
  if (oldTables.length !== newTables.length) return serialized;
  const changes: { from: number; to: number; text: string }[] = [];
  for (let index = 0; index < oldTables.length; index++) {
    const left = oldTables[index], right = newTables[index];
    if (!hasBareBreak(left) && !hasBareBreak(right)) continue;
    const text = patchTable(original, left, serialized, right);
    let oldEnd = left.position?.end.offset, newEnd = right.position?.end.offset;
    const newStart = right.position?.start.offset;
    if (text == null || oldEnd == null || newEnd == null || newStart == null) continue;
    // Preserve the original separator and final newline with the table too.
    const oldNext = before[before.indexOf(left) + 1]?.position?.start.offset ?? original.length;
    const newNext = after[after.indexOf(right) + 1]?.position?.start.offset ?? serialized.length;
    const oldTail = original.slice(oldEnd, oldNext), newTail = serialized.slice(newEnd, newNext);
    const preserveTail = /^[ \t\r\n]*$/.test(oldTail) && /^[ \t\r\n]*$/.test(newTail);
    changes.push({ from: newStart, to: preserveTail ? newNext : newEnd, text: text + (preserveTail ? oldTail : '') });
  }
  let result = serialized;
  for (const change of changes.reverse()) result = result.slice(0, change.from) + change.text + result.slice(change.to);
  return result;
}
