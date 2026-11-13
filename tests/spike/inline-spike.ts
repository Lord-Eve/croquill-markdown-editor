// SPIKE (2026-11): "inline Markdown stays in the document as source text; markers are
// hidden by decorations unless the caret touches their span". Not product code.
import { EditorState, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, EditorView } from '@milkdown/kit/prose/view';
import { Schema } from '@milkdown/kit/prose/model';
import { history, undo, redo } from '@milkdown/kit/prose/history';
import { keymap } from '@milkdown/kit/prose/keymap';
import { baseKeymap } from '@milkdown/kit/prose/commands';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: {},
  },
});

interface Span { kind: 'strong' | 'em' | 'strike' | 'code'; from: number; to: number; innerFrom: number; innerTo: number }
const parser = unified().use(remarkParse).use(remarkGfm);
const kinds: Record<string, Span['kind']> = { strong: 'strong', emphasis: 'em', delete: 'strike', inlineCode: 'code' };

/** Syntax spans of one paragraph's source text, as offsets into that text. */
export function inlineSpans(text: string): Span[] {
  const spans: Span[] = [];
  const visit = (node: any) => {
    const kind = kinds[node.type];
    if (kind && node.position) {
      const from = node.position.start.offset, to = node.position.end.offset;
      let innerFrom: number, innerTo: number;
      if (kind === 'code') {
        const fence = /^`+/.exec(text.slice(from, to))![0].length; innerFrom = from + fence; innerTo = to - fence;
      } else {
        innerFrom = node.children[0]?.position.start.offset ?? to; innerTo = node.children.at(-1)?.position.end.offset ?? from;
      }
      spans.push({ kind, from, to, innerFrom, innerTo });
    }
    for (const child of node.children || []) visit(child);
  };
  // A paragraph's text never contains a newline here, so block syntax cannot start mid-way;
  // a leading "# " or "- " would, which the real integration avoids by parsing inline only.
  const root: any = parser.parse(text);
  if (root.children.length === 1 && root.children[0].type === 'paragraph') visit(root.children[0]);
  return spans;
}

const key = new PluginKey('inline-source');
let frozen: DecorationSet | null = null;
function decorate(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [], head = state.selection.head;
  state.doc.forEach((block, offset) => {
    const base = offset + 1;
    for (const span of inlineSpans(block.textContent)) {
      const from = base + span.from, to = base + span.to, innerFrom = base + span.innerFrom, innerTo = base + span.innerTo;
      const active = head >= from && head <= to;
      const marker = { class: 'md-marker' + (active ? '' : ' md-hidden') };
      if (innerFrom > from) decorations.push(Decoration.inline(from, innerFrom, marker));
      if (to > innerTo) decorations.push(Decoration.inline(innerTo, to, marker));
      if (innerTo > innerFrom) decorations.push(Decoration.inline(innerFrom, innerTo, { class: 'md-' + span.kind }));
    }
  });
  return DecorationSet.create(state.doc, decorations);
}

// eslint-disable-next-line prefer-const
let view: EditorView;
view = new EditorView(document.querySelector('#editor')!, {
  state: EditorState.create({
    schema,
    plugins: [
      history(), keymap({ 'Mod-z': undo, 'Mod-y': redo }), keymap(baseKeymap),
      new Plugin({ key, props: { decorations(state) {
        // Never restyle while an IME composition is open.
        if (view?.composing && frozen) return frozen.map(state.tr.mapping, state.doc);
        return frozen = decorate(state);
      } } }),
    ],
  }),
});

const api = {
  view,
  load(lines: string[]) {
    const doc = schema.node('doc', null, lines.map(line => schema.node('paragraph', null, line ? [schema.text(line)] : [])));
    view.updateState(EditorState.create({ schema, doc, plugins: view.state.plugins }));
  },
  /** The whole document as Markdown: the paragraphs' text, verbatim. */
  markdown: () => { const lines: string[] = []; view.state.doc.forEach(block => { lines.push(block.textContent); }); return lines.join('\n\n') + '\n'; },
  caret(block: number, offset: number) {
    let position = 1; view.state.doc.forEach((node, at, index) => { if (index === block) position = at + 1 + offset; });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position))); view.focus();
  },
  /** What the user sees and where the caret is, for assertions. */
  snapshot() {
    const head = view.state.selection.head, $head = view.state.doc.resolve(head), text = $head.parent.textContent;
    const visible = [...view.dom.querySelectorAll('.md-marker:not(.md-hidden)')].map(node => node.textContent).join(' ');
    const hidden = view.dom.querySelectorAll('.md-marker.md-hidden').length;
    const styled = [...view.dom.querySelectorAll('.md-strong,.md-em,.md-strike,.md-code')].map(node => node.className.replace('md-', '') + ':' + node.textContent).join(' ');
    const rect = view.coordsAtPos(head);
    return { caret: text.slice(0, $head.parentOffset) + '|' + text.slice($head.parentOffset), visible, hidden, styled, x: Math.round(rect.left) };
  },
};
(window as any).spike = api;
