import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitFrontmatter } from './fidelity';

export interface SearchOptions { caseSensitive: boolean; wholeWord: boolean }
export interface SearchMatch { from: number; to: number }
export interface SourceChange { from: number; to: number; insert: string }
export const defaultSearchOptions: SearchOptions = { caseSensitive: false, wholeWord: false };

const word = /[\p{L}\p{N}\p{M}_]/u;
function before(text: string, position: number): string {
  const unit = text.charCodeAt(position - 1);
  return text.slice(position - (unit >= 0xdc00 && unit <= 0xdfff ? 2 : 1), position);
}

/** Literal Unicode search: replacement strings are never interpreted as regex. */
export function findSourceMatches(text: string, query: string, options: SearchOptions): SearchMatch[] {
  if (!query) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'gu' : 'giu');
  const matches: SearchMatch[] = [];
  for (const match of text.matchAll(expression)) {
    const from = match.index!, to = from + match[0].length;
    if (options.wholeWord && (from > 0 && word.test(before(text, from)) || to < text.length && word.test(String.fromCodePoint(text.codePointAt(to)!)))) continue;
    matches.push({ from, to });
  }
  return matches;
}

export function applySourceChanges(source: string, changes: SourceChange[]): string {
  let previous = 0, result = '';
  for (const change of changes) {
    if (change.from < previous || change.to < change.from || change.to > source.length) throw Error('替换范围已失效');
    result += source.slice(previous, change.from) + change.insert; previous = change.to;
  }
  return result + source.slice(previous);
}

/** CodeMirror stores one character per line ending; the file retains its bytes. */
export function normalizedSource(source: string): string { return source.replace(/\r\n?|\n/g, '\n'); }
export function sourceOffset(source: string, normalizedOffset: number): number {
  let raw = 0, logical = 0;
  while (raw < source.length && logical < normalizedOffset) { if (source[raw] === '\r' && source[raw + 1] === '\n') raw++; raw++; logical++; }
  return raw;
}
export function normalizedOffset(source: string, rawOffset: number): number {
  let offset = rawOffset;
  for (let index = 0; index < rawOffset; index++) if (source[index] === '\r' && source[index + 1] === '\n') { offset--; index++; }
  return offset;
}

const parser = unified().use(remarkParse).use(remarkGfm);
interface SyntaxNode { type: string; children?: SyntaxNode[]; align?: unknown; position?: { start: { offset?: number }; end: { offset?: number } } }
function tableShapes(tree: SyntaxNode): unknown[] {
  const shapes: unknown[] = [];
  function visit(node: SyntaxNode): void { if (node.type === 'table') shapes.push({ align: node.align, cells: node.children?.map(row => row.children?.length) }); node.children?.forEach(visit); }
  visit(tree); return shapes;
}

/** A replacement must not silently split a GFM table or drop a row/column. */
export function replacementProblem(before: string, after: string, changes?: SourceChange[]): string | null {
  const previous = splitFrontmatter(before), next = splitFrontmatter(after);
  const previousTree = parser.parse(previous.body) as unknown as SyntaxNode, nextTree = parser.parse(next.body) as unknown as SyntaxNode;
  if (!changes) {
    let from = 0, endBefore = before.length, endAfter = after.length;
    while (from < endBefore && from < endAfter && before[from] === after[from]) from++;
    while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
    changes = [{ from, to: endBefore, insert: after.slice(from, endAfter) }];
  }
  let splitsCell = false;
  function visit(node: SyntaxNode): void {
    if (node.type === 'tableCell') {
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (from != null && to != null && changes!.some(change => change.from >= from + previous.prefix.length && change.from <= to + previous.prefix.length && /[\r\n]/.test(change.insert))) splitsCell = true;
    }
    node.children?.forEach(visit);
  }
  visit(previousTree);
  if (splitsCell) return '替换会改变表格结构，未执行。单元格内换行请使用 <br />。';
  if (JSON.stringify(tableShapes(previousTree)) !== JSON.stringify(tableShapes(nextTree))) return '替换会改变表格结构，未执行。请检查竖线、换行或分隔线。';
  return null;
}
