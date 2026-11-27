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

const SPREAD_LIST_TYPES = new Set(['list_item', 'bullet_list', 'ordered_list']);

function sameNodeMarkup(a: RichNode, b: RichNode): boolean {
  if (a.type !== b.type) return false;
  if (a.type.name === 'heading') return a.attrs.level === b.attrs.level;
  // Splitting a list item inherits spread:true on a newly 1-paragraph item while remark parses spread:false.
  if (SPREAD_LIST_TYPES.has(a.type.name)) return a.hasMarkup(b.type, { ...b.attrs, spread: a.attrs.spread }, b.marks);
  return a.sameMarkup(b);
}

/** Markdown carries neither the generated heading ID nor Crepe's final caret paragraph. */
export function matchesRichDocument(parsed: RichNode, edited: RichNode): boolean {
  if (parsed.childCount !== edited.childCount && !(edited.childCount === parsed.childCount + 1 &&
      edited.lastChild?.type.name === 'paragraph' && !edited.lastChild.content.size)) return false;
  function same(a: RichNode, b: RichNode): boolean {
    if (a.eq(b)) return true;
    if (a.type !== b.type || a.isText || a.childCount !== b.childCount) return false;
    if (!sameNodeMarkup(a, b)) return false;
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

interface ParagraphLine { prefix: string; content: string; hardBreak: string; eol: string; raw: string }

function splitContinuationPrefix(line: string, quoteDepth: number): { prefix: string; body: string } {
  let i = 0;
  for (let q = 0; q < quoteDepth; q++) {
    const match = /^[ \t]*>/.exec(line.slice(i));
    if (!match) break;
    i += match[0].length;
  }
  i += /^[ \t]*/.exec(line.slice(i))?.[0].length ?? 0;
  return { prefix: line.slice(0, i), body: line.slice(i) };
}

function collectHardBreaks(node: SourceNode, src: string, breaks: Map<number, string>): void {
  if (node.type === 'break') {
    const s = node.position?.start.offset, e = node.position?.end.offset;
    if (s != null && e != null) {
      const raw = src.slice(s, e);
      if (/\r\n|\r|\n$/.test(raw)) breaks.set(e, raw.replace(/\r\n|\r|\n$/, ''));
    }
    return;
  }
  node.children?.forEach(child => collectHardBreaks(child, src, breaks));
}

function paragraphLines(node: SourceNode, src: string, quoteDepth: number): ParagraphLine[] | null {
  const pStart = node.position?.start.offset, pEnd = node.position?.end.offset;
  if (pStart == null || pEnd == null) return null;
  const firstLineStart = Math.max(src.lastIndexOf('\n', pStart - 1), src.lastIndexOf('\r', pStart - 1)) + 1;
  const breaks = new Map<number, string>();
  collectHardBreaks(node, src, breaks);
  const lines: ParagraphLine[] = [];
  const eolRe = /\r\n|\r|\n/g;
  eolRe.lastIndex = firstLineStart;
  let lineStart = firstLineStart;
  while (lineStart <= pEnd) {
    const match = eolRe.exec(src);
    const hasEol = !!match && match.index < pEnd;
    const lineEnd = hasEol ? match.index : pEnd;
    const lineEol = hasEol ? match[0] : '';
    const raw = src.slice(lineStart, lineEnd);
    const split = lines.length === 0
      ? { prefix: src.slice(firstLineStart, pStart), body: src.slice(pStart, lineEnd) }
      : splitContinuationPrefix(raw, quoteDepth);
    const br = hasEol ? (breaks.get(lineEnd + lineEol.length) ?? '') : '';
    const hardBreak = br && split.body.endsWith(br) ? br : '';
    const content = hardBreak ? split.body.slice(0, split.body.length - hardBreak.length) : split.body;
    lines.push({ prefix: split.prefix, content, hardBreak, eol: lineEol, raw });
    if (!hasEol) break;
    lineStart = lineEnd + lineEol.length;
  }
  return lines;
}

const normalizeLineContent = (line: ParagraphLine) => line.content.replace(/[ \t]+$/, '');

function sameLine(oldLine: ParagraphLine, newLine: ParagraphLine): boolean {
  if (Boolean(oldLine.hardBreak) !== Boolean(newLine.hardBreak)) return false;
  const left = normalizeLineContent(oldLine), right = normalizeLineContent(newLine);
  return left === right || (!!left && !!right && hasEquivalentMarkdownStructure(oldLine.content, newLine.content));
}

function quoteMarkerPrefix(oldLines: ParagraphLine[], splitIdx: number, quoteDepth: number): string | null {
  if (quoteDepth <= 0) return null;
  for (let k = Math.min(splitIdx, oldLines.length - 1); k >= 0; k--) {
    const prefix = oldLines[k].prefix;
    if (/^[ \t>]*$/.test(prefix) && (prefix.match(/>/g)?.length ?? 0) >= quoteDepth) return prefix;
  }
  return null;
}

function renderCarriedLines(
  oldTail: ParagraphLine[],
  newTail: ParagraphLine[],
  defaultPrefix: string | null,
  eol: string,
): { parts: string[]; eols: string[] } {
  const tailMap = correspondence(oldTail.map(normalizeLineContent), newTail.map(normalizeLineContent));
  const parts: string[] = [];
  const eols: string[] = [];
  for (let t = 0; t < newTail.length; t++) {
    const m = tailMap[t];
    const oldLine = m !== undefined ? oldTail[m] : undefined;
    const newLine = newTail[t];
    if (oldLine && sameLine(oldLine, newLine)) {
      parts.push(oldLine.raw);
    } else if (oldLine) {
      parts.push(oldLine.prefix + newLine.content + (newLine.hardBreak ? (oldLine.hardBreak || newLine.hardBreak) : ''));
    } else {
      parts.push((defaultPrefix ?? newLine.prefix) + newLine.content + newLine.hardBreak);
    }
    eols.push(oldLine?.eol || eol);
  }
  return { parts, eols };
}

function joinParts(parts: string[], eols: string[], fallbackEol: string): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < parts.length - 1) out += eols[i] || fallbackEol;
  }
  return out;
}

function renderParagraphEdit(
  oldNode: SourceNode,
  newNode: SourceNode,
  oldSrc: string,
  nextSrc: string,
  quoteDepth: number,
  eol: string,
  splitAnchor?: number,
): string | null {
  const oldLines = paragraphLines(oldNode, oldSrc, quoteDepth);
  const newLines = paragraphLines(newNode, nextSrc, quoteDepth);
  if (!oldLines?.length || !newLines?.length) return null;
  if (splitAnchor !== undefined) {
    const anchor = oldLines[splitAnchor];
    const line0 = anchor && sameLine(anchor, newLines[0])
      ? anchor.content + anchor.hardBreak
      : newLines[0].content + (newLines[0].hardBreak ? (anchor?.hardBreak || newLines[0].hardBreak) : '');
    if (newLines.length === 1) return line0;
    const carried = renderCarriedLines(oldLines.slice(splitAnchor + 1), newLines.slice(1), null, eol);
    return joinParts([line0, ...carried.parts], [anchor?.eol || eol, ...carried.eols], eol);
  }
  const map = correspondence(oldLines.map(normalizeLineContent), newLines.map(normalizeLineContent));
  const parts: string[] = [];
  const eols: string[] = [];
  for (let i = 0; i < newLines.length; i++) {
    const m = map[i];
    const oldLine = m !== undefined ? oldLines[m] : undefined;
    const newLine = newLines[i];
    if (i === 0) {
      if (oldLine && sameLine(oldLine, newLine)) {
        parts.push(oldLine.content + oldLine.hardBreak);
      } else {
        parts.push(newLine.content + (newLine.hardBreak ? ((oldLine?.hardBreak || oldLines[0].hardBreak) || newLine.hardBreak) : ''));
      }
      eols.push(oldLine?.eol || oldLines[0].eol || eol);
    } else if (oldLine && sameLine(oldLine, newLine)) {
      parts.push(oldLine.raw);
      eols.push(oldLine.eol || eol);
    } else if (oldLine) {
      parts.push(oldLine.prefix + newLine.content + (newLine.hardBreak ? (oldLine.hardBreak || newLine.hardBreak) : ''));
      eols.push(oldLine.eol || eol);
    } else {
      parts.push(newLine.raw);
      eols.push(eol);
    }
  }
  return joinParts(parts, eols, eol);
}

function renderSplitParagraphs(
  oldNode: SourceNode,
  newNodes: SourceNode[],
  oldSrc: string,
  nextSrc: string,
  quoteDepth: number,
  eol: string,
  containerType: string,
  containerGap: (prevRight: SourceNode, nextRight: SourceNode) => string,
): string | null {
  const oldLines = paragraphLines(oldNode, oldSrc, quoteDepth);
  const allNew = newNodes.map(node => paragraphLines(node, nextSrc, quoteDepth));
  if (!oldLines?.length || allNew.some(lines => !lines?.length)) return null;
  const typedNew = allNew as ParagraphLine[][];
  const firstLines = typedNew[0];
  const splitIdx = firstLines.length - 1;
  if (splitIdx >= oldLines.length) return null;

  const lineBoundary = splitIdx + 1 < oldLines.length &&
    normalizeLineContent(firstLines[splitIdx]) === normalizeLineContent(oldLines[splitIdx]);

  const firstParts: string[] = [];
  const firstEols: string[] = [];
  for (let j = 0; j < firstLines.length; j++) {
    const oldLine = oldLines[j], newLine = firstLines[j];
    if (j === splitIdx && lineBoundary && !newLine.hardBreak) {
      firstParts.push((j === 0 ? '' : oldLine.prefix) + oldLine.content);
    } else if (j < firstLines.length - 1 && sameLine(oldLine, newLine)) {
      firstParts.push(j === 0 ? oldLine.content + oldLine.hardBreak : oldLine.raw);
    } else {
      const prefix = j === 0 ? '' : oldLine.prefix;
      firstParts.push(prefix + newLine.content + (newLine.hardBreak ? (oldLine.hardBreak || newLine.hardBreak) : ''));
    }
    firstEols.push(oldLine.eol || eol);
  }
  let out = joinParts(firstParts, firstEols, eol);

  const linePrefix = quoteMarkerPrefix(oldLines, splitIdx, quoteDepth);
  const quoteSep = linePrefix !== null ? eol + linePrefix.replace(/[ \t]+$/, '') + eol : null;

  for (let p = 1; p < typedNew.length; p++) {
    out += quoteSep ?? containerGap(newNodes[p - 1], newNodes[p]);
    const lines = typedNew[p];
    if (p === typedNew.length - 1 && lineBoundary) {
      const carried0 = oldLines[splitIdx + 1];
      let prefix0 = '';
      if (quoteDepth > 0) {
        prefix0 = /^[ \t>]*$/.test(carried0.prefix) && (carried0.prefix.match(/>/g)?.length ?? 0) >= quoteDepth
          ? carried0.prefix
          : (linePrefix ?? lines[0].prefix);
      } else if (containerType === 'root') {
        prefix0 = /^ {0,3}$/.test(carried0.prefix) ? carried0.prefix : '';
      }
      const body0 = sameLine(carried0, lines[0])
        ? carried0.content + carried0.hardBreak
        : lines[0].content + (lines[0].hardBreak ? (carried0.hardBreak || lines[0].hardBreak) : '');
      const line0 = prefix0 + body0;
      if (lines.length === 1) {
        out += line0;
      } else {
        const carried = renderCarriedLines(oldLines.slice(splitIdx + 2), lines.slice(1), linePrefix, eol);
        out += joinParts([line0, ...carried.parts], [carried0.eol || eol, ...carried.eols], eol);
      }
    } else if (p === typedNew.length - 1) {
      const prefix0 = quoteDepth > 0 ? (linePrefix ?? lines[0].prefix) : '';
      const carriedHardBreak = !firstLines[splitIdx].hardBreak ? oldLines[splitIdx].hardBreak : '';
      const line0 = prefix0 + lines[0].content + (lines[0].hardBreak ? (carriedHardBreak || lines[0].hardBreak) : '');
      if (lines.length === 1) {
        out += line0;
      } else {
        const carried = renderCarriedLines(oldLines.slice(splitIdx + 1), lines.slice(1), linePrefix, eol);
        out += joinParts([line0, ...carried.parts], [oldLines[splitIdx].eol || eol, ...carried.eols], eol);
      }
    } else {
      const prefix0 = quoteDepth > 0 ? (linePrefix ?? lines[0].prefix) : '';
      const midParts = [
        prefix0 + lines[0].content + lines[0].hardBreak,
        ...lines.slice(1).map(l => (linePrefix ?? l.prefix) + l.content + l.hardBreak),
      ];
      out += midParts.join(eol);
    }
  }
  return out;
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
  function render(a: SourceNode, b: SourceNode, oldRich?: RichNode, newRich?: RichNode, quoteDepth = 0): string {
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
    if (!wholeBlocksOnly && a.type === 'paragraph' && b.type === 'paragraph' &&
        (newline.test(raw) || newline.test(slice(next.body, b))) &&
        (left.length !== right.length || left.some(c => c.type !== 'text') || right.some(c => c.type !== 'text'))) {
      const edited = renderParagraphEdit(a, b, old.body, next.body, quoteDepth, eol);
      if (edited !== null) return edited;
    }
    const nextQuoteDepth = quoteDepth + (a.type === 'blockquote' ? 1 : 0);
    const richChildren = (rich: RichNode | undefined, count: number) => rich && (rich.childCount === count ||
      a.type === 'root' && rich.childCount === count + 1 && rich.lastChild?.type.name === 'paragraph' && !rich.lastChild.content.size);
    const sequence = ['root', 'list', 'table', 'blockquote', 'listItem'].includes(a.type);
    const aligned = sequence && oldRich?.type.name !== 'croquill_alert' && newRich?.type.name !== 'croquill_alert' &&
      richChildren(oldRich, left.length) && richChildren(newRich, right.length);
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
    const newlines = (s: string) => s.match(/\r\n|\r|\n/g)?.length ?? 0;
    const insertedGap = (i: number, prevRight: SourceNode, nextRight: SourceNode) => {
      const nextGap = next.body.slice(end(prevRight), start(nextRight)).replace(/\r\n|\r|\n/g, eol);
      const sampleGap = sequence && left.length > 1 ? gap(Math.min((map[i - 1] ?? 0) + 1, left.length - 1)) : undefined;
      return sampleGap !== undefined && (a.type === 'list' || newlines(sampleGap) >= newlines(nextGap)) ? sampleGap : nextGap;
    };
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
        else result += insertedGap(i, right[i - 1], right[i]);
      }
      if (!wholeBlocksOnly && at !== undefined && ['root', 'blockquote', 'listItem'].includes(a.type) &&
          left[at].type === 'paragraph' && right[i].type === 'paragraph') {
        let k = i;
        while (k + 1 < right.length && map[k + 1] === undefined && right[k + 1].type === 'paragraph') k++;
        if (k > i) {
          const splitText = renderSplitParagraphs(
            left[at], right.slice(i, k + 1), old.body, next.body, nextQuoteDepth, eol, a.type,
            (prevR, nextR) => insertedGap(i + 1, prevR, nextR),
          );
          if (splitText !== null) {
            result += indent(at) + splitText;
            i = k;
            continue;
          }
        }
      }
      if (!wholeBlocksOnly && a.type === 'list' && i > 0 && at === undefined) {
        const prevAt = map[i - 1];
        const prevOld = prevAt !== undefined ? left[prevAt] : undefined;
        const prevNew = right[i - 1], curNew = right[i];
        const splitChildIdx = (prevNew.children?.length ?? 0) - 1;
        if (prevOld?.type === 'listItem' && prevNew.type === 'listItem' && curNew.type === 'listItem' &&
            prevOld.children?.length && curNew.children?.length === 1 &&
            splitChildIdx >= 0 && splitChildIdx < prevOld.children.length &&
            prevOld.children[splitChildIdx].type === 'paragraph' &&
            prevNew.children![splitChildIdx].type === 'paragraph' &&
            curNew.children[0].type === 'paragraph') {
          const prevOldLines = paragraphLines(prevOld.children[splitChildIdx], old.body, nextQuoteDepth);
          const prevFirst = paragraphLines(prevNew.children![splitChildIdx], next.body, nextQuoteDepth);
          const splitHint = prevFirst ? prevFirst.length - 1 : 0;
          const listLineBoundary = !!prevOldLines && !!prevFirst && splitHint + 1 < prevOldLines.length &&
            normalizeLineContent(prevFirst[splitHint]) === normalizeLineContent(prevOldLines[splitHint]);
          const anchorIdx = listLineBoundary ? splitHint + 1 : splitHint;
          const marker = old.body.slice(start(prevOld), start(prevOld.children[0]));
          const body = renderParagraphEdit(prevOld.children[splitChildIdx], curNew.children[0], old.body, next.body, nextQuoteDepth, eol, anchorIdx);
          if (body !== null) {
            result += marker + body + old.body.slice(end(prevOld.children.at(-1)!), end(prevOld));
            continue;
          }
        }
      }
      const template = at ?? (a.type === 'table' || a.type === 'list' ? map[i - 1] ?? 0 : undefined);
      if (at !== undefined) result += indent(at);
      result += template === undefined ? fresh(right[i]) : render(left[template], right[i],
        aligned ? oldRich!.child(template) : undefined, aligned ? newRich!.child(i) : undefined, nextQuoteDepth);
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
