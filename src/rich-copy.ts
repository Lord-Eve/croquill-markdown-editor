import { Fragment, Slice, type Node as RichNode, type Schema } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as RichView } from '@milkdown/kit/prose/view';
import { selectionSourceMarkers } from './inline-source-view';
import { applyClipboardStyles, collectReferenceDefinitions, renderMarkdownDom, type ReferenceDefinitions } from './render-markdown';

/** Carries ProseMirror's original lossless slice HTML for internal Croquill paste. */
export const CROQUILL_CLIPBOARD_MIME = 'application/x-croquill-html';

function insertIntoTextblock(block: RichNode, offset: number, inserted: string, schema: Schema): RichNode {
  if (!inserted) return block;
  const clamped = Math.max(0, Math.min(offset, block.content.size));
  const next: RichNode[] = [];
  let pos = 0, done = false;
  block.forEach(child => {
    const end = pos + child.nodeSize;
    if (!done && clamped <= pos) {
      next.push(schema.text(inserted));
      done = true;
    }
    if (!done && clamped < end && child.isText) {
      const inner = clamped - pos;
      next.push(schema.text(child.text!.slice(0, inner) + inserted + child.text!.slice(inner), child.marks));
      done = true;
    } else {
      next.push(child);
    }
    pos = end;
  });
  if (!done) next.push(schema.text(inserted));
  return block.copy(Fragment.fromArray(next));
}

function updateEdgeTextblock(fragment: Fragment, edge: 'first' | 'last', transform: (block: RichNode) => RichNode): { fragment: Fragment; found: boolean } {
  const count = fragment.childCount;
  for (let idx = 0; idx < count; idx++) {
    const i = edge === 'first' ? idx : count - 1 - idx;
    const child = fragment.child(i);
    if (child.isTextblock) {
      return { fragment: fragment.replaceChild(i, transform(child)), found: true };
    }
    if (child.childCount > 0) {
      const inner = updateEdgeTextblock(child.content, edge, transform);
      if (inner.found) return { fragment: fragment.replaceChild(i, child.copy(inner.fragment)), found: true };
    }
  }
  return { fragment, found: false };
}

function repairSliceMarkers(slice: Slice, selection: RichView['state']['selection'], schema: Schema): Slice {
  if (!(selection instanceof TextSelection) || selection.empty) return slice;
  const { $from, $to } = selection;
  let content = slice.content;
  if ($from.sameParent($to)) {
    const { prefix, suffix, trimLead, trimTrail } = selectionSourceMarkers($from.parent, $from.parentOffset, $to.parentOffset);
    if (!prefix && !suffix) return slice;
    content = updateEdgeTextblock(content, 'first', block => {
      let next = block;
      if (suffix) next = insertIntoTextblock(next, next.content.size - trimTrail, suffix, schema);
      if (prefix) next = insertIntoTextblock(next, trimLead, prefix, schema);
      return next;
    }).fragment;
    return new Slice(content, slice.openStart, slice.openEnd);
  }
  const startMarkers = selectionSourceMarkers($from.parent, $from.parentOffset, $from.parent.content.size);
  if (startMarkers.prefix) {
    content = updateEdgeTextblock(content, 'first', block =>
      insertIntoTextblock(block, startMarkers.trimLead, startMarkers.prefix, schema),
    ).fragment;
  }
  const endMarkers = selectionSourceMarkers($to.parent, 0, $to.parentOffset);
  if (endMarkers.suffix) {
    content = updateEdgeTextblock(content, 'last', block =>
      insertIntoTextblock(block, block.content.size - endMarkers.trimTrail, endMarkers.suffix, schema),
    ).fragment;
  }
  return new Slice(content, slice.openStart, slice.openEnd);
}

/** Match prosemirror-view's single-wrapper unwrapping so an inner text selection does not drag its outer container along. */
function unwrapOpenSingleBlock(slice: Slice): Fragment {
  let { content, openStart, openEnd } = slice;
  while (openStart > 1 && openEnd > 1 && content.childCount === 1 && content.firstChild!.childCount === 1) {
    openStart--;
    openEnd--;
    content = content.firstChild!.content;
  }
  return content;
}

function renderCellContent(doc: Document, cell: RichNode, schema: Schema,
  writeRichBody: (doc: RichNode) => string, referenceDefinitions: ReferenceDefinitions): Node[] {
  const tempDoc = schema.topNodeType.createAndFill(null, cell.content);
  if (!tempDoc) return [doc.createTextNode(cell.textContent)];
  const md = writeRichBody(tempDoc);
  const holder = doc.createElement('div');
  renderMarkdownDom(doc, holder, md, { forCopy: true, referenceDefinitions });
  if (holder.childElementCount === 1 && holder.firstElementChild?.tagName === 'P') {
    return Array.from(holder.firstElementChild.childNodes);
  }
  return Array.from(holder.childNodes);
}

function renderTableRowsForCopy(doc: Document, rows: RichNode[], schema: Schema,
  writeRichBody: (doc: RichNode) => string, referenceDefinitions: ReferenceDefinitions): HTMLTableElement {
  const table = doc.createElement('table');
  let thead: HTMLTableSectionElement | null = null;
  let tbody: HTMLTableSectionElement | null = null;
  for (const row of rows) {
    const header = row.type.name === 'table_header_row';
    const section = header ? (thead ??= table.createTHead()) : (tbody ??= table.createTBody());
    const tr = section.insertRow();
    row.forEach(cell => {
      const el = doc.createElement(cell.type.name === 'table_header' || header ? 'th' : 'td');
      if (cell.attrs.colspan > 1) el.colSpan = Number(cell.attrs.colspan);
      if (cell.attrs.rowspan > 1) el.rowSpan = Number(cell.attrs.rowspan);
      if (cell.attrs.alignment) el.style.textAlign = String(cell.attrs.alignment);
      el.append(...renderCellContent(doc, cell, schema, writeRichBody, referenceDefinitions));
      tr.append(el);
    });
  }
  applyClipboardStyles(table);
  return table;
}

const ROW_TYPES = new Set(['table_row', 'table_header_row']);

/** Build synchronous, light-themed clipboard HTML for the current rich editor selection. */
export function buildRichClipboardHtml(view: RichView, slice: Slice,
  writeRichBody: (doc: RichNode) => string, fullMarkdown: string): string {
  const { selection, schema } = view.state;
  const repaired = repairSliceMarkers(slice, selection, schema);
  const content = unwrapOpenSingleBlock(repaired);
  const doc = document.implementation.createHTMLDocument('');
  const container = doc.createElement('div');
  const referenceDefinitions = collectReferenceDefinitions(fullMarkdown);

  const blocks: RichNode[] = [];
  content.forEach(node => blocks.push(node));

  const flushBlocks = (pending: RichNode[]) => {
    if (!pending.length) return;
    const nodes = pending.every(n => n.isInline) && schema.nodes.paragraph
      ? [schema.nodes.paragraph.createAndFill(null, Fragment.fromArray(pending))].filter((n): n is RichNode => !!n)
      : pending;
    const tempDoc = schema.topNodeType.createAndFill(null, Fragment.fromArray(nodes));
    if (tempDoc) {
      renderMarkdownDom(doc, container, writeRichBody(tempDoc), { forCopy: true, referenceDefinitions });
      return;
    }
    for (const block of pending) {
      const single = schema.topNodeType.createAndFill(null, block);
      if (single) renderMarkdownDom(doc, container, writeRichBody(single), { forCopy: true, referenceDefinitions });
      else {
        const p = doc.createElement('p');
        p.textContent = block.textContent;
        container.append(p);
      }
    }
  };

  let pending: RichNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const node = blocks[i];
    if (ROW_TYPES.has(node.type.name)) {
      flushBlocks(pending); pending = [];
      const rows: RichNode[] = [node];
      while (i + 1 < blocks.length && ROW_TYPES.has(blocks[i + 1].type.name)) rows.push(blocks[++i]);
      container.append(renderTableRowsForCopy(doc, rows, schema, writeRichBody, referenceDefinitions));
    } else {
      pending.push(node);
    }
  }
  flushBlocks(pending);

  const inlineSelection = (
    selection instanceof TextSelection && selection.$from.sameParent(selection.$to) &&
    selection.$from.parent.type.name === 'paragraph' &&
    (selection.$from.parentOffset > 0 || selection.$to.parentOffset < selection.$from.parent.content.size)
  ) || (blocks.length > 0 && blocks.every(n => n.isInline));
  if (inlineSelection && container.childElementCount === 1 && container.firstElementChild?.tagName === 'P') {
    const inlineOnly = container.firstElementChild;
    container.replaceChildren(...inlineOnly.childNodes);
  }
  return container.innerHTML;
}

/** Populate formatted HTML + unchanged plain Markdown + internal Croquill slice on copy/cut. */
export function handleRichCopyCut(view: RichView, event: ClipboardEvent,
  writeRichBody: (doc: RichNode) => string, fullMarkdown: string): boolean {
  if (view.composing || view.state.selection.empty || !event.clipboardData) return false;
  if (event.target instanceof Element && event.target.closest('textarea, input, .cm-editor, .croquill-html-source')) return false;
  const data = event.clipboardData;
  const slice = view.state.selection.content();
  const { dom: originalDom, text: plainText } = view.serializeForClipboard(slice);
  const richHtml = buildRichClipboardHtml(view, slice, writeRichBody, fullMarkdown);
  event.preventDefault();
  data.clearData();
  data.setData('text/html', richHtml);
  data.setData('text/plain', plainText);
  data.setData(CROQUILL_CLIPBOARD_MIME, originalDom.innerHTML);
  if (event.type === 'cut' && view.editable) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
  }
  return true;
}
