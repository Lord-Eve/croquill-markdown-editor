import type { Ctx } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import type { Root } from '@milkdown/kit/transformer';
import type { Handle } from 'mdast-util-to-markdown';
import { escapeCellPipes, escapeLiteralText, guardLineStart } from './inline-source';

interface SourceNode {
  type: string;
  value?: string;
  children?: SourceNode[];
  data?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const softBreak = (): SourceNode => ({ type: 'break', data: { isInline: true } });
const isSoftBreak = (node: SourceNode | undefined) => node?.type === 'text' && node.value === '\n';

/**
 * Reading: keep the source spelling of every piece of inline text. Emphasis, strong,
 * strikethrough and code spans dissolve into their own source characters; ordinary text
 * keeps its backslash escapes and entities. Runs after the plugins that need parsed
 * positions (inline HTML, footnotes, HTML breaks) and before the alert marker is cut off.
 */
export function flattenInlineSource() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? '');
    /** One source range as text, with a soft break wherever the source has a line ending. */
    function pieces(from: number, to: number): SourceNode[] {
      const result: SourceNode[] = [];
      let start = from;
      source.slice(from, to).split(/\r\n|\r|\n/).forEach((line, index, lines) => {
        let value = line, offset = start;
        if (index > 0) {
          // A continuation line begins with its containers' markers and indentation.
          // The paragraph's own text cannot start with either, so this is exact.
          const prefix = /^[ \t>]*/.exec(line)![0].length;
          value = line.slice(prefix); offset += prefix;
          result.push(softBreak());
        }
        if (value) result.push({ type: 'text', value, position: { start: { offset }, end: { offset: offset + value.length } } });
        start += line.length + (index < lines.length - 1 ? /^(?:\r\n|\r|\n)/.exec(source.slice(start + line.length))![0].length : 0);
      });
      return result;
    }
    function trimRightSpaces(from: number, to: number): number {
      while (to > from && (source[to - 1] === ' ' || source[to - 1] === '\t')) to--;
      return to;
    }
    function contentBounds(node: SourceNode): { from: number; to: number } | null {
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (from == null || to == null) return null;
      if (node.type === 'paragraph') return { from, to: trimRightSpaces(from, to) };
      if (node.type === 'heading') {
        const raw = source.slice(from, to);
        const atxOpen = /^#{1,6}(?:[ \t]+|$)/.exec(raw);
        if (atxOpen) {
          const start = from + atxOpen[0].length;
          let end = trimRightSpaces(start, to);
          const atxClose = /(?:^|[ \t]+)#+$/.exec(source.slice(start, end));
          if (atxClose) end = trimRightSpaces(start, end - atxClose[0].length);
          return { from: start, to: end };
        }
        const setextEnd = raw.replace(/\r?\n[ \t>]*[=-]+[ \t]*$/, '').length;
        return { from, to: trimRightSpaces(from, from + setextEnd) };
      }
      if (node.type === 'tableCell') {
        const raw = source.slice(from, to);
        const lead = /^[ \t]*\|?[ \t]*/.exec(raw)![0].length;
        const start = from + lead;
        let end = trimRightSpaces(start, to);
        if (end > start && source[end - 1] === '|') {
          let slashes = 0;
          for (let at = end - 2; at >= start && source[at] === '\\'; at--) slashes++;
          if (slashes % 2 === 0) end = trimRightSpaces(start, end - 1);
        }
        return { from: start, to: end };
      }
      if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
        const marker = node.type === 'strong' ? 2 : node.type === 'emphasis' ? 1
          : source.startsWith('~~', from) && source.endsWith('~~', to) ? 2 : 1;
        return { from: from + marker, to: Math.max(from + marker, to - marker) };
      }
      return { from, to };
    }
    function flatten(children: SourceNode[], parentFrom?: number, parentTo?: number): SourceNode[] {
      const result: SourceNode[] = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const from = child.position?.start.offset, to = child.position?.end.offset;
        if (from == null && to == null && (child.type === 'text' || child.type === 'link')) {
          const prevEnd = i > 0 ? children[i - 1].position?.end.offset : parentFrom;
          let j = i;
          while (j + 1 < children.length && children[j + 1].position?.start.offset == null &&
              (children[j + 1].type === 'text' || children[j + 1].type === 'link')) j++;
          const nextStart = j + 1 < children.length ? children[j + 1].position?.start.offset : parentTo;
          if (prevEnd != null && nextStart != null && prevEnd <= nextStart) {
            result.push(...pieces(prevEnd, nextStart));
            i = j;
            continue;
          }
        }
        if (child.type === 'text' || child.type === 'croquillInlineHtmlTag') {
          if (from != null && to != null) result.push(...pieces(from, to));
          else if (child.value) result.push({ type: 'text', value: child.value === '\n' ? '\n' : escapeLiteralText(child.value) });
        } else if (child.type === 'inlineCode' && from != null && to != null) result.push(...pieces(from, to));
        else if (['strong', 'emphasis', 'delete'].includes(child.type) && from != null && to != null && child.children?.length) {
          const bounds = contentBounds(child)!;
          const innerFrom = child.children[0].position?.start.offset ?? bounds.from;
          const innerTo = child.children.at(-1)!.position?.end.offset ?? bounds.to;
          result.push(...pieces(from, innerFrom), ...flatten(child.children, innerFrom, innerTo), ...pieces(innerTo, to));
        } else if (child.type === 'link') {
          if (from != null && to != null) {
            if (!child.children?.length) result.push(...pieces(from, to));
            else if (child.children[0].position?.start.offset != null && child.children.at(-1)!.position?.end.offset != null) {
              const innerFrom = child.children[0].position!.start.offset!, innerTo = child.children.at(-1)!.position!.end.offset!;
              result.push(...pieces(from, innerFrom), ...flatten(child.children, innerFrom, innerTo), ...pieces(innerTo, to));
            } else {
              child.children = flatten(child.children);
              result.push(child);
            }
          } else if (child.children?.length === 1 && child.children[0].type === 'text' && child.children[0].value != null) {
            // Fallback for positionless bare autolinks when parent bounds are unavailable.
            result.push({ type: 'text', value: child.children[0].value });
          } else {
            if (child.children) child.children = flatten(child.children);
            result.push(child);
          }
        } else {
          if (child.children && !['croquillInlineRaw', 'croquillRawBlock'].includes(child.type)) child.children = flatten(child.children);
          result.push(child);
        }
      }
      // Neighbouring pieces are one run of text for the editor.
      return result.reduce<SourceNode[]>((merged, node) => {
        const previous = merged.at(-1);
        if (node.type === 'text' && previous?.type === 'text' && previous.position && node.position && previous.position.end.offset === node.position.start.offset) {
          previous.value = previous.value! + node.value; previous.position = { start: previous.position.start, end: node.position.end };
        } else merged.push(node);
        return merged;
      }, []);
    }
    function visit(node: SourceNode): void {
      if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
        const bounds = contentBounds(node);
        node.children = flatten(node.children || [], bounds?.from, bounds?.to);
        return;
      }
      if (['code', 'html', 'math', 'croquillRawBlock', 'croquillHtmlComment', 'croquillToc'].includes(node.type)) return;
      node.children?.forEach(visit);
    }
    visit(tree as unknown as SourceNode);
    return tree;
  };
}

/** Writing: text is already Markdown source. Only keep it from starting another block. */
const writeSourceText: Handle = (node, parent, state, info) => {
  let value = String((node as SourceNode).value ?? '');
  if (value === '\n' || !value) return value;
  if (state.stack.includes('tableCell')) return escapeCellPipes(value);
  const siblings = ((parent as SourceNode | undefined)?.children || []) as SourceNode[], index = siblings.indexOf(node as SourceNode);
  const next = siblings[index + 1];
  // A backslash or two spaces before a line ending would turn a soft break into a hard one.
  if (isSoftBreak(next)) {
    if (/(?:^|[^\\])(?:\\\\)*\\$/.test(value)) value += '\\';
    else if (/ {2,}$/.test(value)) value = value.slice(0, -1) + '&#x20;';
  }
  if (info.before !== '\n' && info.before !== '\r' && info.before !== '') return value;
  if (!state.stack.includes('paragraph')) return value;
  let rest = '';
  for (let at = index + 1; at < siblings.length && !isSoftBreak(siblings[at]); at++) rest += siblings[at].type === 'text' ? siblings[at].value : 'x';
  return guardLineStart(value, value + rest, !siblings.slice(0, Math.max(index, 0)).some(isSoftBreak));
};

export function configureInlineSource(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, options => ({ ...options, handlers: { ...options.handlers, text: writeSourceText } }));
}
