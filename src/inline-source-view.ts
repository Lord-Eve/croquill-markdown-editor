import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { Fragment, type Mark, type Node as RichNode } from '@milkdown/kit/prose/model';
import { INLINE_OBJECT, inlineMarkers, inlineSourceText, inlineSyntaxSpans, type InlineKind, type InlineSpan } from './inline-source';

interface BlockSyntax { run: string; spans: InlineSpan[] }
const blocks = new WeakMap<RichNode, BlockSyntax>();

const isSourceBlock = (node: RichNode) => node.isTextblock && !node.type.spec.code;

/**
 * One text block as the Markdown it will be saved as, with spans mapped back to offsets
 * inside the block. A link contributes its brackets (so emphasis cannot straddle it, as
 * in the file) and every other inline node one object character.
 */
function blockSyntax(block: RichNode): BlockSyntax {
  const known = blocks.get(block);
  if (known) return known;
  let run = '';
  const map: number[] = [];
  let link: Mark | undefined;
  const add = (text: string, offset: number, width: number) => { for (let index = 0; index < text.length; index++) map.push(offset + Math.min(index, width)); run += text; };
  block.forEach((child, offset) => {
    const current = child.marks.find(mark => mark.type.name === 'link');
    if (current !== link && !(current && link && current.eq(link))) {
      if (link) add(']()', offset, 0);
      if (current) add('[', offset, 0);
      link = current;
    }
    if (child.isText) add(child.text!, offset, child.nodeSize);
    else if (child.type.name === 'hardbreak' && !child.attrs.croquillHtmlBreak) add('\n', offset, 1);
    else add(INLINE_OBJECT.repeat(child.nodeSize), offset, child.nodeSize);
  });
  if (link) add(']()', block.content.size, 0);
  map.push(block.content.size);
  const spans = inlineSyntaxSpans(run).map(span => ({ ...span, from: map[span.from], to: map[span.to], innerFrom: map[span.innerFrom], innerTo: map[span.innerTo] }));
  const result = { run, spans };
  blocks.set(block, result);
  return result;
}

/** Syntax spans of a text block, as offsets into its content. */
export function blockSpans(block: RichNode): InlineSpan[] { return isSourceBlock(block) ? blockSyntax(block).spans : []; }

/** A block's text as the reader sees it (for the table of contents and previews). */
export function visibleText(text: string): string { return inlineSourceText(text); }

const element: Partial<Record<InlineKind, string>> = { strong: 'strong', em: 'em', strike: 'del', code: 'code', highlight: 'mark' };

function decorateBlock(block: RichNode, position: number, selectionFrom: number, selectionTo: number): Decoration[] {
  const base = position + 1, decorations: Decoration[] = [];
  for (const span of blockSpans(block)) {
    const from = base + span.from, to = base + span.to, innerFrom = base + span.innerFrom, innerTo = base + span.innerTo;
    // Touching counts: the caret right before `**` already shows it, as in Typora.
    const active = selectionFrom <= to && selectionTo >= from;
    const marker = { class: active ? 'md-marker' : 'md-marker md-hidden' };
    if (innerFrom > from) decorations.push(Decoration.inline(from, innerFrom, marker));
    if (to > innerTo) decorations.push(Decoration.inline(innerTo, to, marker));
    const nodeName = element[span.kind];
    // Inclusive: text typed at either edge of the content belongs to it. While an IME
    // composition is open the decorations are only mapped, and this keeps the composing
    // text inside the element the browser is typing it into.
    if (nodeName && innerTo > innerFrom) decorations.push(Decoration.inline(innerFrom, innerTo, { nodeName, class: 'md-' + span.kind }, { inclusiveStart: true, inclusiveEnd: true }));
    // Known and left alone: with the caret right after a marker, an IME types its
    // composing letters into the marker's grey node until they are committed. Putting
    // an anchor element there to redirect the caret made Chromium lose the composition
    // (letters stayed, the committed word was appended), so nothing may sit at the caret.
    if (span.kind === 'entity' && !active) {
      const value = span.value || '';
      decorations.push(Decoration.widget(from, () => {
        const dom = document.createElement('span'); dom.className = 'md-entity'; dom.textContent = value; return dom;
      }, { side: -1, key: 'entity:' + value, ignoreSelection: true }));
    }
  }
  return decorations;
}

function decorateRange(doc: RichNode, from: number, to: number, selection: { from: number; to: number }, visit: (position: number, block: RichNode, decorations: Decoration[]) => void): void {
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, position) => {
    if (!node.isTextblock) return true;
    if (isSourceBlock(node)) visit(position, node, decorateBlock(node, position, selection.from, selection.to));
    return false;
  });
}

interface ViewState { decorations: DecorationSet; stale: boolean }
export const inlineSourceKey = new PluginKey<ViewState>('croquill-inline-source');

function build(state: EditorState): ViewState {
  const all: Decoration[] = [];
  decorateRange(state.doc, 0, state.doc.content.size, state.selection, (_position, _block, decorations) => { all.push(...decorations); });
  return { decorations: DecorationSet.create(state.doc, all), stale: false };
}

const syntaxMarks = ['strong', 'emphasis', 'strike_through', 'inlineCode', 'croquill_highlight'];
function markMarkers(mark: Mark, text: string): [string, string] {
  const marker = String(mark.attrs.marker || '*');
  if (mark.type.name === 'strong') return [marker + marker, marker + marker];
  if (mark.type.name === 'emphasis') return [marker, marker];
  if (mark.type.name === 'strike_through') return ['~~', '~~'];
  if (mark.type.name === 'croquill_highlight') return ['==', '=='];
  return inlineMarkers('code', text);
}

/**
 * Formatting marks only arrive from outside (pasted HTML, a stock command). Write them
 * out as the source characters they stand for, so the document has one representation.
 */
function dissolveMarks(state: EditorState, from: number, to: number): Transaction | null {
  let tr: Transaction | null = null;
  const targets: { position: number; block: RichNode }[] = [];
  state.doc.nodesBetween(Math.max(0, from), Math.min(state.doc.content.size, to), (node, position) => {
    if (!node.isTextblock) return true;
    let marked = false;
    if (isSourceBlock(node)) node.forEach(child => { if (child.marks.some(mark => syntaxMarks.includes(mark.type.name))) marked = true; });
    if (marked) targets.push({ position, block: node });
    return false;
  });
  // Later blocks first, so earlier positions stay valid.
  for (const { position, block } of targets.reverse()) {
    const children: RichNode[] = [], offsets: { oldStart: number; oldEnd: number; newStart: number; closing: number }[] = [];
    let open: Mark[] = [], size = 0, previousPlain: readonly Mark[] = [];
    const emit = (text: string, marks: readonly Mark[]) => { if (text) { children.push(state.schema.text(text, marks)); size += text.length; } };
    const closeFrom = (keep: number) => { let length = 0; for (const mark of open.slice(keep).reverse()) { const text = markMarkers(mark, '')[1]; emit(text, previousPlain); length += text.length; } open = open.slice(0, keep); return length; };
    block.forEach((child, offset) => {
      const syntax = child.marks.filter(mark => syntaxMarks.includes(mark.type.name)), plain = child.marks.filter(mark => !syntaxMarks.includes(mark.type.name));
      let common = 0;
      while (common < open.length && common < syntax.length && open[common].eq(syntax[common])) common++;
      const closed = closeFrom(common);
      if (offsets.length) offsets.at(-1)!.closing = closed;
      for (const mark of syntax.slice(common)) { emit(markMarkers(mark, child.text || '')[0], plain); open.push(mark); }
      offsets.push({ oldStart: offset, oldEnd: offset + child.nodeSize, newStart: size, closing: 0 });
      children.push(child.mark(plain)); size += child.nodeSize; previousPlain = plain;
    });
    const closed = closeFrom(0);
    if (offsets.length) offsets.at(-1)!.closing = closed;
    const start = position + 1, selection = (tr || state.tr).selection;
    const mapOffset = (absolute: number) => {
      const offset = absolute - start;
      if (offset < 0 || offset > block.content.size) return null;
      const child = offsets.find(entry => offset > entry.oldStart && offset <= entry.oldEnd) || offsets[0];
      if (!child || offset === 0) return start;
      return start + child.newStart + (offset - child.oldStart) + (offset === child.oldEnd ? child.closing : 0);
    };
    const anchor = mapOffset(selection.anchor), head = mapOffset(selection.head);
    tr = (tr || state.tr).replaceWith(start, start + block.content.size, Fragment.fromArray(children));
    if (anchor != null && head != null && selection instanceof TextSelection) tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  }
  return tr;
}

function changedRange(transactions: readonly Transaction[]): { from: number; to: number } | null {
  let from = Infinity, to = -Infinity;
  transactions.forEach((transaction, order) => {
    transaction.mapping.maps.forEach((map, index) => map.forEach((_oldStart, _oldEnd, start, end) => {
      // Carry each range forward to the final document.
      let a = transaction.mapping.slice(index + 1).map(start, -1), b = transaction.mapping.slice(index + 1).map(end, 1);
      for (const later of transactions.slice(order + 1)) { a = later.mapping.map(a, -1); b = later.mapping.map(b, 1); }
      from = Math.min(from, a); to = Math.max(to, b);
    }));
  });
  return from <= to ? { from, to } : null;
}

export function inlineSourcePlugin(): Plugin<ViewState> {
  let editor: EditorView | undefined;
  return new Plugin<ViewState>({
    key: inlineSourceKey,
    state: {
      init: (_config, state) => build(state),
      apply(transaction, value, oldState, newState) {
        if (transaction.getMeta(inlineSourceKey) === 'rebuild') return build(newState);
        // Never restyle around an open IME composition; catch up when it closes.
        if (editor?.composing) return { decorations: value.decorations.map(transaction.mapping, transaction.doc), stale: true };
        if (value.stale) return build(newState);
        if (!transaction.docChanged && oldState.selection.eq(newState.selection)) return value;
        let decorations = value.decorations.map(transaction.mapping, transaction.doc);
        const ranges = [
          { from: transaction.mapping.map(oldState.selection.from, -1), to: transaction.mapping.map(oldState.selection.to, 1) },
          { from: newState.selection.from, to: newState.selection.to },
        ];
        const changed = transaction.docChanged ? changedRange([transaction]) : null;
        if (changed) ranges.push(changed);
        const refreshed = new Set<number>();
        for (const range of ranges) decorateRange(newState.doc, range.from, range.to, newState.selection, (position, block, fresh) => {
          if (refreshed.has(position)) return;
          refreshed.add(position);
          decorations = decorations.remove(decorations.find(position, position + block.nodeSize)).add(newState.doc, fresh);
        });
        return { decorations, stale: false };
      },
    },
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some(transaction => transaction.docChanged)) return null;
      const changed = changedRange(transactions);
      return changed ? dissolveMarks(newState, Math.min(changed.from, newState.doc.content.size), Math.min(changed.to, newState.doc.content.size)) : null;
    },
    props: {
      decorations(state) { return inlineSourceKey.getState(state)?.decorations; },
      handleDOMEvents: {
        compositionend(view) {
          setTimeout(() => {
            if (view.isDestroyed || view.composing || !inlineSourceKey.getState(view.state)?.stale) return;
            view.dispatch(view.state.tr.setMeta(inlineSourceKey, 'rebuild').setMeta('addToHistory', false));
          }, 60);
          return false;
        },
      },
    },
    view(view) { editor = view; return { destroy() { editor = undefined; } }; },
  });
}

/**
 * Left/Right next to a span whose markers are still hidden. The browser moves the caret
 * by what is on screen, so from the right it steps over a hidden `**` straight to the end
 * of the words, and two fast presses outrun the redraw that shows the markers. Bring the
 * editor's selection up to date first, and take the one step onto a hidden span's edge
 * ourselves; once the markers are showing, the browser's own movement is right.
 */
export function handleSourceArrow(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || view.composing) return false;
  // The previous key's caret move reaches the editor on a later selectionchange.
  (view as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
  const { selection } = view.state, { $head } = selection;
  if (!selection.empty || !isSourceBlock($head.parent)) return false;
  const left = event.key === 'ArrowLeft', offset = $head.parentOffset, target = offset + (left ? -1 : 1);
  const crossed = left ? $head.nodeBefore : $head.nodeAfter;
  if (!crossed?.isText || target < 0 || target > $head.parent.content.size) return false;
  // Leave a surrogate pair to the browser, which moves over both halves.
  const code = $head.parent.textBetween(Math.min(offset, target), Math.max(offset, target)).charCodeAt(0);
  if (code >= 0xD800 && code <= 0xDFFF) return false;
  const touches = (position: number, span: InlineSpan) => span.from <= position && position <= span.to;
  if (!blockSpans($head.parent).some(span => touches(target, span) && !touches(offset, span))) return false;
  event.preventDefault();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $head.start() + target)).scrollIntoView());
  return true;
}

/**
 * Enter inside formatted text: close the open markers before the break and reopen them
 * after it, so both halves keep their formatting instead of two dangling `**`.
 * Only adds the characters; the editor's own Enter then splits the block.
 */
export function handleSourceEnter(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || view.composing) return false;
  const { selection } = view.state, { $from } = selection;
  if (!selection.empty || !isSourceBlock($from.parent)) return false;
  const block = $from.parent, offset = $from.parentOffset;
  const open = blockSpans(block).filter(span => !['escape', 'entity'].includes(span.kind) && span.innerFrom < offset && offset < span.innerTo);
  if (!open.length) return false;
  const text = (from: number, to: number) => block.textBetween(from, to, '\n', INLINE_OBJECT);
  // Outer spans come first: close inner-to-outer, reopen outer-to-inner.
  const closing = open.map(span => text(span.innerTo, span.to)).reverse().join(''), opening = open.map(span => text(span.from, span.innerFrom)).join('');
  const position = $from.pos;
  const tr = view.state.tr.insertText(closing + opening, position);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, position + closing.length)));
  return false;
}

/** `[文字](地址 "标题")` and `<https://…>` become a link as their last character is typed. */
export function linkInputHandlers(): { match: RegExp; handler: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null }[] {
  const outsideCode = (state: EditorState, start: number) => {
    const $start = state.doc.resolve(start), offset = $start.parentOffset;
    return isSourceBlock($start.parent) && !blockSpans($start.parent).some(span => span.kind === 'code' && span.from <= offset && offset < span.to);
  };
  return [{
    match: /(?<![\\!])\[([^[\]\n]+)\]\(([^()\s]+)(?:[ \t]+"([^"\n]*)")?\)$/,
    handler: (state, match, start, end) => {
      const link = state.schema.marks.link;
      if (!link || !outsideCode(state, start)) return null;
      return state.tr.replaceWith(start, end, state.schema.text(match[1], [link.create({ href: match[2], title: match[3] || null })])).removeStoredMark(link);
    },
  }, {
    match: /(?<!\\)<((?:https?|ftp):\/\/[^\s<>]+)>$/,
    handler: (state, match, start, end) => {
      const link = state.schema.marks.link;
      if (!link || !outsideCode(state, start)) return null;
      return state.tr.replaceWith(start, end, state.schema.text(match[1], [link.create({ href: match[1] })])).removeStoredMark(link);
    },
  }];
}

type FormatKind = 'strong' | 'em' | 'strike' | 'code' | 'highlight';

/** Ctrl+B and friends: add or remove the marker characters around the selection. */
export function toggleInlineSyntax(view: EditorView, kind: FormatKind): boolean {
  const { state } = view, { $from, $to } = state.selection;
  if (!$from.sameParent($to) || !isSourceBlock($from.parent)) return false;
  const block = $from.parent, base = $from.start(), from = $from.parentOffset, to = $to.parentOffset;
  const inside = blockSpans(block).filter(span => span.kind === kind && span.from <= from && to <= span.to).at(-1);
  const tr = state.tr;
  if (inside) tr.delete(base + inside.innerTo, base + inside.to).delete(base + inside.from, base + inside.innerFrom);
  else {
    const selected = block.textBetween(from, to, '\n', INLINE_OBJECT);
    const lead = /^\s*/.exec(selected)![0].length, trail = selected.trim() ? /\s*$/.exec(selected)![0].length : 0;
    if (!selected.trim()) {
      const [opening, closing] = inlineMarkers(kind);
      tr.insertText(opening + closing, base + to);
      tr.setSelection(TextSelection.create(tr.doc, base + to + opening.length));
    } else {
      // Markers must hug the text: `** 粗 **` is not strong.
      const start = from + lead, end = to - trail;
      const [opening, closing] = inlineMarkers(kind, selected.slice(lead, selected.length - trail));
      tr.insertText(closing, base + end).insertText(opening, base + start);
      tr.setSelection(TextSelection.create(tr.doc, base + start + opening.length, base + end + opening.length));
    }
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}
