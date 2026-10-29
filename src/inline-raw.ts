import type { Root } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as RichNode } from '@milkdown/kit/prose/model';
import { inlineHtmlRanges, type InlineSyntaxNode } from './inline-html-ranges';

/** A GFM cell cannot contain physical newlines or an unescaped pipe. */
function fitsTableCell(raw: string): boolean {
  let escaped = false;
  for (const char of raw) {
    if (char === '\r' || char === '\n' || char === '|' && !escaped) return false;
    escaped = char === '\\' ? !escaped : false;
  }
  return true;
}

/** Reject the whole transaction, including any source deletion in a drag move. */
export function hasUnsafeInlineTableContent(doc: RichNode): boolean {
  let unsafe = false;
  doc.descendants(node => {
    if (unsafe) return false;
    if (['table_cell', 'table_header'].includes(node.type.name)) {
      node.descendants(child => {
        if (child.type.name === 'croquill_inline_raw' && !fitsTableCell(String(child.attrs.value))) unsafe = true;
        return !unsafe;
      });
      return false;
    }
    return !node.isTextblock;
  });
  return unsafe;
}

/** Replace complete source ranges before HTML or soft-line transforms can rewrite them. */
export function preserveInlineHtml() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? '');
    function visit(node: InlineSyntaxNode): void {
      if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
        const ranges = inlineHtmlRanges(node, source);
        if (!ranges?.length) return;
        function replace(parent: InlineSyntaxNode): void {
          parent.children = parent.children?.flatMap(child => {
            const from = child.position?.start.offset, to = child.position?.end.offset;
            const range = ranges!.find(range => from != null && to != null && from >= range.from && to <= range.to);
            if (range) return from === range.from ? [{ type: 'croquillInlineRaw', value: range.raw, position: {
              start: { offset: range.from }, end: { offset: range.to },
            } }] : [];
            replace(child);
            return [child];
          });
        }
        replace(node);
        return;
      }
      node.children?.forEach(visit);
    }
    visit(tree as unknown as InlineSyntaxNode);
    return tree;
  };
}

/** Atom deletion must take one keypress; leave composing events to the native IME. */
export function handleInlineRawKey(view: EditorView, event: KeyboardEvent): boolean {
  if (!['Backspace', 'Delete'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return false;
  const { selection, tr } = view.state;
  const selected = selection instanceof NodeSelection && selection.node.type.name === 'croquill_inline_raw';
  const adjacent = selection.empty && (event.key === 'Backspace' ? selection.$from.nodeBefore : selection.$from.nodeAfter);
  if (!selected && (!adjacent || adjacent.type.name !== 'croquill_inline_raw')) return false;
  if (event.isComposing || view.composing) return true;
  event.preventDefault();
  if (selected) tr.deleteSelection();
  else if (event.key === 'Backspace') tr.delete(selection.from - 1, selection.from);
  else tr.delete(selection.from, selection.from + 1);
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function createInlineRawMarkdown() {
  let serializing = false;
  const replacements = new Map<string, string>();
  const node = $node('croquill_inline_raw', () => ({
    inline: true, group: 'inline', atom: true, selectable: true,
    attrs: { value: { default: '', validate: 'string' } },
    toDOM: node => ['span', {
      'data-croquill-inline-raw': '', 'data-croquill-inline-value': JSON.stringify(String(node.attrs.value)),
      contenteditable: 'false', 'aria-label': '行内原文片段',
    }, String(node.attrs.value)],
    parseDOM: [{ tag: 'span[data-croquill-inline-raw]', getAttrs: dom => {
      try {
        const value: unknown = JSON.parse(dom.getAttribute('data-croquill-inline-value') || 'null');
        if (typeof value === 'string') return { value };
      } catch { /* Ordinary copied DOM still has literal text as a fallback. */ }
      return { value: dom.textContent || '' };
    } }],
    leafText: node => String(node.attrs.value),
    parseMarkdown: {
      match: node => node.type === 'croquillInlineRaw',
      runner: (state, node, type) => { state.addNode(type, { value: String(node.value ?? '') }); },
    },
    toMarkdown: {
      match: node => node.type.name === 'croquill_inline_raw',
      runner: (state, node) => {
        let raw = String(node.attrs.value);
        // Blockquote/list writers indent physical lines. Restore multiline source
        // afterwards so its original CRLF and existing prefixes survive exactly.
        if (serializing && /[\r\n]/.test(raw)) {
          const token = `<croquill-inline-${crypto.randomUUID()}>`;
          replacements.set(token, raw);
          raw = token;
        }
        state.addNode('html', undefined, raw);
      },
    },
  }));
  return {
    node,
    serialize(write: () => string): string {
      replacements.clear();
      serializing = true;
      try {
        let result = write();
        for (const [token, raw] of replacements) result = result.split(token).join(raw);
        return result;
      } finally { serializing = false; replacements.clear(); }
    },
  };
}
