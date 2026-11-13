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
    function flatten(children: SourceNode[]): SourceNode[] {
      const result: SourceNode[] = [];
      for (const child of children) {
        const from = child.position?.start.offset, to = child.position?.end.offset;
        if (child.type === 'text') {
          if (from != null && to != null) result.push(...pieces(from, to));
          else if (child.value) result.push({ type: 'text', value: child.value === '\n' ? '\n' : escapeLiteralText(child.value) });
        } else if (child.type === 'inlineCode' && from != null && to != null) result.push(...pieces(from, to));
        else if (['strong', 'emphasis', 'delete'].includes(child.type) && from != null && to != null && child.children?.length &&
            child.children[0].position?.start.offset != null && child.children.at(-1)!.position?.end.offset != null) {
          const innerFrom = child.children[0].position!.start.offset!, innerTo = child.children.at(-1)!.position!.end.offset!;
          result.push(...pieces(from, innerFrom), ...flatten(child.children), ...pieces(innerTo, to));
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
      if (['paragraph', 'heading', 'tableCell'].includes(node.type)) { node.children = flatten(node.children || []); return; }
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
