import { closeHistory } from '@milkdown/kit/prose/history';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { openHtmlSourceAt, RAW_BLOCK_NODE_NAME, splitRawTail } from './raw-markdown';

function protectedBlock(node: Node) {
  return node.isAtom || node.type.name === 'table' || node.type.name === 'code_block';
}

/** Handle a collapsed caret at the edge of a block before the generic join/select commands. */
export function handleBlockBoundary(view: EditorView, event: KeyboardEvent,
  paragraphSource: (node: Node) => { text: string; tail?: string }): boolean {
  const back = event.key === 'Backspace';
  if ((!back && event.key !== 'Delete') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.isComposing || view.composing) return false;
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== (back ? 0 : $from.parent.content.size)) return false;
  if (back && $from.parent.type.name !== 'paragraph') return false;
  const tr = closeHistory(view.state.tr);
  const handled = () => { event.preventDefault(); return true; };

  // A cell is an isolating boundary. Move to the preceding cell, including across rows.
  for (let depth = $from.depth - 1; depth > 0; depth--) {
    if (!['table_cell', 'table_header'].includes($from.node(depth).type.name)) continue;
    if (!back || $from.pos !== $from.start(depth) + 1) break;
    const previous = TextSelection.findFrom(doc.resolve($from.before(depth)), -1, true);
    if (previous && previous.from > $from.before(depth - 2)) view.dispatch(tr.setSelection(previous).scrollIntoView());
    return handled();
  }

  let edge = $from.depth;
  while (edge > 0) {
    const boundary = doc.resolve(back ? $from.before(edge) : $from.after(edge));
    const other = back ? boundary.nodeBefore : boundary.nodeAfter;
    if (!other) { edge--; continue; }
    const pos = back ? boundary.pos - other.nodeSize : boundary.pos;
    // At different nesting depths let normal paragraph/list joins work, but never
    // feed an atom, table or code block on the facing edge to the generic keymap.
    let facing = other;
    while (!protectedBlock(facing) && !facing.isTextblock && facing.childCount)
      facing = (back ? facing.lastChild : facing.firstChild)!;
    if (!protectedBlock(facing)) return false;
    if (!back || edge !== $from.depth || facing !== other) return handled();

    const name = other.type.name;
    if (name === 'hr' || (name === 'code_block' && other.attrs.language !== 'LaTeX' && !other.content.size)) {
      view.dispatch(tr.delete(pos, boundary.pos).scrollIntoView());
      return handled();
    }
    if (name === 'table') {
      const end = TextSelection.findFrom(doc.resolve(boundary.pos), -1, true);
      if (!end || end.from <= pos || !end.$from.parent.canReplace(end.$from.index(), end.$from.index(), $from.parent.content)) return handled();
      tr.delete(boundary.pos, $from.after()).insert(end.from, $from.parent.content);
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end.from)).scrollIntoView());
      return handled();
    }
    if (name === 'code_block') {
      const math = other.attrs.language === 'LaTeX';
      if (!math) return false;
      const end = boundary.pos - 1;
      tr.delete(boundary.pos, $from.after()).insertText(paragraphSource($from.parent).text.replace(/\r\n?/g, '\n'), end);
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView());
      const dom = view.nodeDOM(pos);
      if (dom instanceof HTMLElement && dom.querySelector('.codemirror-host.hidden')) {
        dom.querySelector<HTMLButtonElement>('.preview-toggle-button')?.click();
        queueMicrotask(() => dom.querySelector<HTMLElement>('.cm-content')?.focus());
      }
      return handled();
    }
    if (name === RAW_BLOCK_NODE_NAME && other.attrs.kind === 'html') {
      const { body, tail, lineEnding } = splitRawTail(other.attrs.value);
      const source = paragraphSource($from.parent);
      const appended = source.text.replace(/\r?\n/g, lineEnding);
      tr.delete(boundary.pos, $from.after()).setNodeMarkup(pos, undefined, { ...other.attrs, value: body + appended + (source.tail ?? tail) });
      view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView());
      openHtmlSourceAt(view, pos, body.replace(/\r\n?/g, '\n').length);
    }
    return handled();
  }
  return false;
}
