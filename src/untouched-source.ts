import type { Node as RichNode } from '@milkdown/kit/prose/model';
import { hasEquivalentMarkdownStructure, markdownNodeSignature, parseMarkdownAst, splitFrontmatter } from './fidelity';

interface SourceNode {
  type: string;
  value?: string;
  children?: SourceNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const start = (node: SourceNode) => node.position!.start.offset!;
const end = (node: SourceNode) => node.position!.end.offset!;
const slice = (text: string, node: SourceNode) => text.slice(start(node), end(node));
const newline = /\r\n|\r|\n/;

/** Markdown carries neither the generated heading ID nor Crepe's final caret paragraph. */
export function matchesRichDocument(parsed: RichNode, edited: RichNode): boolean {
  if (parsed.childCount !== edited.childCount && !(edited.childCount === parsed.childCount + 1 &&
      edited.lastChild?.type.name === 'paragraph' && !edited.lastChild.content.size)) return false;
  function same(a: RichNode, b: RichNode): boolean {
    if (a.eq(b)) return true;
    if (a.type !== b.type || a.isText || a.childCount !== b.childCount) return false;
    if (a.type.name === 'heading' ? a.attrs.level !== b.attrs.level : !a.sameMarkup(b)) return false;
    for (let i = 0; i < a.childCount; i++) if (!same(a.child(i), b.child(i))) return false;
    return true;
  }
  for (let i = 0; i < parsed.childCount; i++) if (!same(parsed.child(i), edited.child(i))) return false;
  return true;
}

/** Match unchanged siblings first, then pair replacements between those anchors.
 * Rich node identity distinguishes insertion/deletion among identically worded blocks. */
function correspondence(oldKeys: unknown[], newKeys: unknown[]): (number | undefined)[] {
  const positions = new Map<unknown, number[]>();
  for (let i = oldKeys.length - 1; i >= 0; i--) {
    const queue = positions.get(oldKeys[i]);
    if (queue) queue.push(i);
    else positions.set(oldKeys[i], [i]);
  }
  const result = new Array<number | undefined>(newKeys.length);
  let left = 0, right = 0;
  for (let i = 0; i <= newKeys.length; i++) {
    const queue = positions.get(newKeys[i]);
    while (queue?.length && queue.at(-1)! < left) queue.pop();
    const anchor = i === newKeys.length ? oldKeys.length : queue?.pop();
    if (anchor === undefined) continue;
    for (let j = 0; j < Math.min(anchor - left, i - right); j++) result[right + j] = left + j;
    if (i < newKeys.length) result[i] = anchor;
    left = anchor + 1;
    right = i + 1;
  }
  return result;
}

function joinSourceLines(lines: string[], source: string, oldIndices: (number | undefined)[], defaultEnding: string) {
  const endings = source.match(/\r\n|\r|\n/g) ?? [];
  return lines.map((line, i) => {
    if (i === lines.length - 1) return line;
    const old = oldIndices[i];
    return line + (old !== undefined && endings[old] || endings[0] || defaultEnding);
  }).join('');
}

/** Literal code and math values omit their delimiters and each line's container indent. */
function literalBlock(raw: string, oldValue: string, nextValue: string): string | null {
  const lines = raw.split(newline), before = oldValue.split(newline), after = nextValue.split(newline);
  const eol = raw.match(newline)?.[0] ?? '\n';
  const fenced = /^ {0,3}(?:\x60{3,}|~{3,}|\$\$)/.test(lines[0]);
  const first = fenced ? 1 : 0;
  const prefixes = before.map((value, i) => {
    const line = lines[first + i];
    return line !== undefined && line.endsWith(value) ? line.slice(0, line.length - value.length) : null;
  });
  if (prefixes.some(p => p === null)) return null;
  const mapping = correspondence(before, after);
  let indent = prefixes[0];
  const content = after.map((value, i) => {
    const old = mapping[i];
    if (old !== undefined) indent = prefixes[old];
    return indent + value;
  });
  const tail = first + before.length;
  const result = [...lines.slice(0, first), ...content, ...lines.slice(tail)];
  const indices = [...(first ? [0] : []), ...mapping.map(i => i === undefined ? undefined : first + i),
    ...lines.slice(tail).map((_, i) => tail + i)];
  return joinSourceLines(result, raw, indices, eol);
}

/** A text node can span soft line breaks inside quotes or indented paragraphs.
 * Its source slice contains the literal continuation prefixes; its value does not. */
function textLines(raw: string, written: string, oldValue: string, value: string): string {
  const oldLines = raw.split(newline), newLines = written.split(newline);
  const before = oldValue.split(newline), after = value.split(newline);
  if (before.length !== oldLines.length || after.length !== newLines.length) return written;
  const map = correspondence(before, after);
  const result = newLines.map((line, i) => {
    const j = map[i];
    if (j === undefined) return line;
    if (after[i] === before[j]) return oldLines[j];
    if (oldLines[j].endsWith(before[j]) && line.endsWith(after[i]))
      return oldLines[j].slice(0, oldLines[j].length - before[j].length) + after[i];
    return line;
  });
  return joinSourceLines(result, raw, map, written.match(newline)?.[0] ?? '\n');
}

/** Reuse the previous spelling inside a changed block. Offsets always belong to
 * their own parser input. A table's alignment row lives in the gap after its header. */
export function preserveUntouchedSource(original: string, serialized: string, before: RichNode, after: RichNode,
  accept: (markdown: string) => boolean): string {
  if (original === serialized) return serialized;
  const old = splitFrontmatter(original), next = splitFrontmatter(serialized);
  if (old.prefix !== next.prefix) return serialized;
  const oldRoot: SourceNode = parseMarkdownAst(old.body), newRoot: SourceNode = parseMarkdownAst(next.body);
  const eol = old.body.match(newline)?.[0] ?? old.prefix.match(newline)?.[0] ?? '\n';
  const fresh = (node: SourceNode) => slice(next.body, node).replace(/\r\n|\r|\n/g, eol);

  let wholeBlocksOnly = false;
  function render(a: SourceNode, b: SourceNode, oldRich?: RichNode, newRich?: RichNode): string {
    const raw = slice(old.body, a);
    if (a.type !== b.type) return fresh(b);
    if (oldRich && oldRich === newRich) return raw;
    if (wholeBlocksOnly && a.type !== 'root') return fresh(b);
    if (a.type !== 'root' && markdownNodeSignature(a, old.body) === markdownNodeSignature(b, next.body)) return raw;
    if (a.type === 'code' || a.type === 'math') return literalBlock(raw, a.value!, b.value!) ?? fresh(b);
    if (a.type === 'text' && newline.test(raw)) return textLines(raw, fresh(b), a.value!, b.value!);
    const left = a.children, right = b.children;
    const unpositioned = (node: SourceNode) => node.position?.start.offset == null || node.position.end.offset == null;
    if (left?.some(unpositioned) || right?.some(unpositioned)) return fresh(b);
    if (a.type === 'root' && (!left?.length || !right?.length)) {
      const tail = left?.length ? old.body.slice(end(left.at(-1)!)) : old.body;
      return right?.length ? next.body.slice(0, end(right.at(-1)!)).replace(/\r\n|\r|\n/g, eol) + tail : tail;
    }
    if (a.type === 'tableCell' && (!left?.length || !right?.length)) {
      const from = left?.length ? start(left[0]) - start(a) : /^\|?[ \t]*/.exec(raw)![0].length;
      const to = left?.length ? end(left.at(-1)!) - start(a) : from;
      return raw.slice(0, from) + (right?.length ? next.body.slice(start(right[0]), end(right.at(-1)!)) : '') + raw.slice(to);
    }
    if (a.type === 'listItem' && left?.length && !right?.length) return old.body.slice(start(a), start(left[0]));
    if (!left?.length || !right?.length) return fresh(b);
    // Keep syntax only while its attributes (e.g. heading level or checkbox) agree.
    if (markdownNodeSignature({ ...a, children: [] }, old.body) !== markdownNodeSignature({ ...b, children: [] }, next.body)) return fresh(b);
    const richChildren = (rich: RichNode | undefined, count: number) => rich && (rich.childCount === count ||
      a.type === 'root' && rich.childCount === count + 1 && rich.lastChild?.type.name === 'paragraph' && !rich.lastChild.content.size);
    const sequence = ['root', 'list', 'table'].includes(a.type);
    const aligned = sequence && richChildren(oldRich, left.length) && richChildren(newRich, right.length);
    const keys = (nodes: SourceNode[], text: string, rich?: RichNode) => nodes.map((node, i) =>
      aligned ? rich!.child(i) : markdownNodeSignature(node, text));
    const map = correspondence(keys(left, old.body, oldRich), keys(right, next.body, newRich));
    if (!sequence && left.length !== right.length) {
      // Keep the fences of a heading or the padding and pipes of a table cell.
      if (['heading', 'tableCell'].includes(a.type)) return old.body.slice(start(a), start(left[0])) +
        next.body.slice(start(right[0]), end(right.at(-1)!)) + old.body.slice(end(left.at(-1)!), end(a));
      return fresh(b);
    }
    const indent = (i: number) => a.type === 'root' ?
      /[ \t]*$/.exec(old.body.slice(i ? end(left[i - 1]) : 0, start(left[i])))![0] : '';
    const gap = (i: number) => old.body.slice(end(left[i - 1]), start(left[i]) - indent(i).length);
    let result = old.body.slice(start(a), start(left[0]) - indent(0).length);
    let tail = old.body.slice(end(left.at(-1)!), end(a));
    for (let i = 0; i < right.length; i++) {
      const at = map[i];
      if (i) {
        if (a.type === 'table' && i === 1) {
          result += left.length > 1 ? gap(1) : tail + eol;
          if (left.length === 1) tail = '';
        } else if (a.type === 'table') result += at !== undefined && at > 1 ? gap(at) : eol;
        else if (at !== undefined && at > 0) result += gap(at);
        else if (sequence && left.length > 1) result += gap(Math.min((map[i - 1] ?? 0) + 1, left.length - 1));
        else result += next.body.slice(end(right[i - 1]), start(right[i])).replace(/\r\n|\r|\n/g, eol);
      }
      const template = at ?? (a.type === 'table' || a.type === 'list' ? map[i - 1] ?? 0 : undefined);
      if (at !== undefined) result += indent(at);
      result += template === undefined ? fresh(right[i]) : render(left[template], right[i],
        aligned ? oldRich!.child(template) : undefined, aligned ? newRich!.child(i) : undefined);
    }
    return result + tail;
  }
  function verified(candidate: string) {
    return candidate === serialized || hasEquivalentMarkdownStructure(candidate, serialized) && accept(candidate);
  }
  const candidate = old.prefix + render(oldRoot, newRoot, before, after);
  if (verified(candidate)) return candidate;
  wholeBlocksOnly = true;
  const blocks = old.prefix + render(oldRoot, newRoot, before, after);
  return blocks !== candidate && verified(blocks) ? blocks : serialized;
}
