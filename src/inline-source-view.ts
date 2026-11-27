import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { Fragment, type Mark, type Node as RichNode } from '@milkdown/kit/prose/model';
import { INLINE_OBJECT, canOpenLink, headingAttributes, withoutHeadingAttributes, type HeadingAttribute, escapeLinkValue, inlineMarkers, inlineSourceText, inlineSyntaxSpans, type InlineKind, type InlineSpan } from './inline-source';
import { createInlineHtmlImage, inlineHtmlStyle, type InlineHtmlImage } from './html-sanitize';

interface BlockSyntax { run: string; map: number[]; spans: InlineSpan[]; attributes: HeadingAttribute[] }
const blocks = new WeakMap<RichNode, BlockSyntax>();

const isSourceBlock = (node: RichNode) => node.isTextblock && !node.type.spec.code;

function mapSpans(spans: InlineSpan[], map: number[]): InlineSpan[] {
  return spans.map(span => ({
    ...span,
    from: map[span.from],
    to: map[span.to],
    innerFrom: map[span.innerFrom],
    innerTo: map[span.innerTo],
    ...(span.urlFrom != null && span.urlTo != null ? { urlFrom: map[span.urlFrom], urlTo: map[span.urlTo] } : {}),
    ...(span.titleFrom != null && span.titleTo != null ? { titleFrom: map[span.titleFrom], titleTo: map[span.titleTo] } : {}),
  })).filter(span => !(span.kind === 'link' && span.from === span.innerFrom && span.to === span.innerTo));
}

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
  const attributes = block.type.name === 'heading'
    ? headingAttributes(run).map(({ from, to }) => ({ from: map[from], to: map[to] }))
    : [];
  const result = { run, map, attributes, spans: mapSpans(inlineSyntaxSpans(run), map) };
  blocks.set(block, result);
  return result;
}

/** Syntax spans of a text block, as offsets into its content. */
export function blockSpans(block: RichNode): InlineSpan[] { return isSourceBlock(block) ? blockSyntax(block).spans : []; }

function blockEditSpans(block: RichNode): InlineSpan[] {
  if (!isSourceBlock(block)) return [];
  const { run, map } = blockSyntax(block);
  return mapSpans(inlineSyntaxSpans(run, { emptyLinks: true }), map);
}

/** A block's text as the reader sees it (for the table of contents and previews). */
export function visibleText(text: string, heading = false): string { return inlineSourceText(heading ? withoutHeadingAttributes(text) : text); }

const element: Partial<Record<InlineKind, string>> = { strong: 'strong', em: 'em', strike: 'del', code: 'code', highlight: 'mark' };
const UNSAFE_HREF = /^(?:javascript|vbscript|data):/i;
const isUnsafeHref = (href: string) => UNSAFE_HREF.test(href.replace(/[\u0000-\u0020]+/g, ''));

function decorateLink(block: RichNode, base: number, span: InlineSpan, active: boolean, decorations: Decoration[]): void {
  const from = base + span.from, to = base + span.to, innerFrom = base + span.innerFrom, innerTo = base + span.innerTo;
  const cursor = canOpenLink(span.href || '') ? ' md-openable-link' : '';
  const marker = { class: (active ? 'md-marker' : 'md-marker md-hidden') + cursor };
  if (innerFrom > from) decorations.push(Decoration.inline(from, innerFrom, marker));
  if (innerTo > innerFrom) {
    const attrs: Record<string, string> = { class: 'md-link' + cursor };
    const href = span.href ?? '';
    if (isUnsafeHref(href)) attrs['data-href'] = href;
    else attrs.href = href;
    if (span.title != null && span.title !== '') attrs.title = span.title;
    decorations.push(Decoration.inline(innerFrom, innerTo, { nodeName: 'a', ...attrs }, { inclusiveStart: true, inclusiveEnd: true }));
  }
  if (!active || span.kind === 'autolink' || span.urlFrom == null || span.urlTo == null) {
    if (to > innerTo) decorations.push(Decoration.inline(innerTo, to, marker));
    return;
  }
  const urlFrom = base + span.urlFrom, urlTo = base + span.urlTo;
  const bracketed = span.urlFrom > span.innerTo + 2 && span.urlTo + 1 < span.to &&
    block.textBetween(span.urlFrom - 1, span.urlFrom) === '<' && block.textBetween(span.urlTo, span.urlTo + 1) === '>';
  if (innerTo + 2 <= to) decorations.push(Decoration.inline(innerTo, innerTo + 2, marker));
  if (bracketed) decorations.push(Decoration.inline(urlFrom - 1, urlFrom, marker));
  if (urlTo > urlFrom) decorations.push(Decoration.inline(urlFrom, urlTo, { class: 'md-link-url' + cursor }, { inclusiveStart: true, inclusiveEnd: true }));
  if (bracketed) decorations.push(Decoration.inline(urlTo, urlTo + 1, marker));
  if (span.titleFrom != null && span.titleTo != null && span.titleTo > span.titleFrom) {
    decorations.push(Decoration.inline(base + span.titleFrom, base + span.titleTo, { class: 'md-link-title' + cursor }, { inclusiveStart: true, inclusiveEnd: true }));
  }
  if (to - 1 > innerTo) decorations.push(Decoration.inline(to - 1, to, marker));
}

type ImagePreview = (image: InlineHtmlImage) => string | undefined;

function decorateHtml(block: RichNode, base: number, span: InlineSpan, active: boolean, preview: ImagePreview, decorations: Decoration[]): void {
  const html = span.html!;
  const from = base + span.from, to = base + span.to, innerFrom = base + span.innerFrom, innerTo = base + span.innerTo;
  const cursor = html.tag === 'a' && canOpenLink(span.href || '') ? ' md-openable-link' : '';
  const marker = { class: 'md-marker md-html-marker' + cursor };
  if (html.tag === 'img') {
    const src = active ? undefined : preview(html);
    decorations.push(Decoration.inline(from, to, src ? { class: marker.class + ' md-hidden' } : marker));
    if (src) {
      const key = 'html-image:' + block.textBetween(span.from, span.to);
      decorations.push(Decoration.widget(from, (view, getPos) => {
        const img = createInlineHtmlImage(src, html)!;
        img.addEventListener('mousedown', event => {
          const pos = getPos();
          if (pos == null || event.button !== 0 || view.composing) return;
          event.preventDefault();
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + '<img'.length)).scrollIntoView());
          view.focus();
        });
        return img;
      }, { side: -1, key, ignoreSelection: true }));
    }
    return;
  }
  if (!active) marker.class += ' md-hidden';
  decorations.push(Decoration.inline(from, innerFrom, marker), Decoration.inline(innerTo, to, marker));
  if (innerFrom === innerTo) return;
  const attrs: Record<string, string> = { nodeName: html.tag, class: 'md-html' };
  if (html.tag === 'a') {
    // Navigation is handled by the editor. A span also keeps nested Markdown
    // links valid DOM, and unsupported protocols never become DOM attributes.
    attrs.nodeName = 'span';
    attrs.class += ' md-html-link' + cursor;
  }
  if (html.title) attrs.title = html.title;
  const style = html.styles?.length ? inlineHtmlStyle(html.styles) : '';
  if (style) attrs.style = style;
  decorations.push(Decoration.inline(innerFrom, innerTo, attrs, { inclusiveStart: true, inclusiveEnd: true }));
}

function decorateBlock(block: RichNode, position: number, selectionFrom: number, selectionTo: number, preview: ImagePreview): Decoration[] {
  const base = position + 1, decorations: Decoration[] = [];
  const activeHeading = selectionFrom <= base + block.content.size && selectionTo >= base;
  for (const { from, to } of blockSyntax(block).attributes) {
    decorations.push(Decoration.inline(base + from, base + to, { class: activeHeading ? 'md-marker' : 'md-marker md-hidden' }));
  }
  for (const span of blockSpans(block)) {
    const from = base + span.from, to = base + span.to, innerFrom = base + span.innerFrom, innerTo = base + span.innerTo;
    // Touching counts: the caret right before `**` already shows it, as in Typora.
    const active = selectionFrom <= to && selectionTo >= from;
    if (span.html) {
      decorateHtml(block, base, span, active, preview, decorations);
      continue;
    }
    if (span.kind === 'link' || span.kind === 'autolink') {
      decorateLink(block, base, span, active, decorations);
      continue;
    }
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

function decorateRange(doc: RichNode, from: number, to: number, selection: { from: number; to: number }, preview: ImagePreview, visit: (position: number, block: RichNode, decorations: Decoration[]) => void): void {
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, position) => {
    if (!node.isTextblock) return true;
    if (isSourceBlock(node)) visit(position, node, decorateBlock(node, position, selection.from, selection.to, preview));
    return false;
  });
}

interface ViewState { decorations: DecorationSet; stale: boolean }
export const inlineSourceKey = new PluginKey<ViewState>('croquill-inline-source');

function build(state: EditorState, preview: ImagePreview): ViewState {
  const all: Decoration[] = [];
  decorateRange(state.doc, 0, state.doc.content.size, state.selection, preview, (_position, _block, decorations) => { all.push(...decorations); });
  return { decorations: DecorationSet.create(state.doc, all), stale: false };
}

const syntaxMarks = ['link', 'strong', 'emphasis', 'strike_through', 'inlineCode', 'croquill_highlight'];
function markMarkers(mark: Mark, text: string): [string, string] {
  const marker = String(mark.attrs.marker || '*');
  if (mark.type.name === 'strong') return [marker + marker, marker + marker];
  if (mark.type.name === 'emphasis') return [marker, marker];
  if (mark.type.name === 'strike_through') return ['~~', '~~'];
  if (mark.type.name === 'croquill_highlight') return ['==', '=='];
  return inlineMarkers('code', text);
}

function balancedParens(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')') { if (depth === 0) return false; depth--; }
  }
  return depth === 0;
}

function linkMarkers(href: string, title: string, entries: { child: RichNode; syntax: Mark[] }[]): { markers: [string, string]; escapeBrackets: boolean } {
  const plainAutolink = !title && /^(?:https?|ftp):\/\/\S+$/i.test(href) && !/[<>\u0000-\u001f\u007f]/.test(href) &&
    entries.every(entry => entry.child.isText && entry.syntax.length === 1) &&
    entries.map(entry => entry.child.text || '').join('') === href;
  if (plainAutolink) return { markers: ['<', '>'], escapeBrackets: false };
  const escapedHref = escapeLinkValue(href);
  const destination = /[\s\u0000-\u001f\u007f]/.test(href) || href.startsWith('<') || !balancedParens(href)
    ? `<${escapedHref.replace(/[<>]/g, '\\$&')}>`
    : escapedHref;
  const suffix = title ? ` "${escapeLinkValue(title).replace(/"/g, '\\"')}"` : '';
  return { markers: ['[', `](${destination}${suffix})`], escapeBrackets: true };
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
    interface Entry {
      child: RichNode;
      offset: number;
      syntax: Mark[];
      plain: Mark[];
      linkMarkers?: [string, string];
    }
    const entries: Entry[] = [];
    block.forEach((child, offset) => {
      // Link always wraps outermost so `[**bold**](url)` dissolves as one link.
      const syntax = [
        ...child.marks.filter(mark => mark.type.name === 'link'),
        ...child.marks.filter(mark => mark.type.name !== 'link' && syntaxMarks.includes(mark.type.name)),
      ];
      const plain = child.marks.filter(mark => !syntaxMarks.includes(mark.type.name));
      entries.push({ child, offset, syntax, plain });
    });
    const escapedIndices = entries.map(() => new Set<number>());
    for (let start = 0; start < entries.length;) {
      const link = entries[start].syntax[0]?.type.name === 'link' ? entries[start].syntax[0] : null;
      if (!link) { start++; continue; }
      let end = start + 1;
      while (end < entries.length && entries[end].syntax[0]?.type.name === 'link' && link.eq(entries[end].syntax[0])) end++;
      const href = String(link.attrs.href ?? '');
      const title = link.attrs.title ? String(link.attrs.title) : '';
      const info = linkMarkers(href, title, entries.slice(start, end));
      for (let i = start; i < end; i++) entries[i].linkMarkers = info.markers;
      if (info.escapeBrackets) {
        const openStack: { entryIndex: number; charIndex: number }[] = [];
        for (let entryIndex = start; entryIndex < end; entryIndex++) {
          const entry = entries[entryIndex];
          if (!entry.child.isText || entry.syntax.some(mark => mark.type.name === 'inlineCode')) continue;
          const text = entry.child.text || '';
          for (let charIndex = 0; charIndex < text.length; charIndex++) {
            const char = text[charIndex];
            // Pasted HTML backslashes are literal characters, so escape each one before pairing brackets.
            if (char === '\\') { escapedIndices[entryIndex].add(charIndex); continue; }
            if (char === '[') openStack.push({ entryIndex, charIndex });
            else if (char === ']') {
              if (openStack.length) openStack.pop();
              else escapedIndices[entryIndex].add(charIndex);
            }
          }
        }
        for (const { entryIndex, charIndex } of openStack) escapedIndices[entryIndex].add(charIndex);
      }
      start = end;
    }

    const children: RichNode[] = [];
    const offsets: { oldStart: number; oldEnd: number; newStart: number; newEnd: number; closing: number; posMap?: number[] }[] = [];
    let open: { mark: Mark; close: string }[] = [], size = 0, previousPlain: readonly Mark[] = [];
    const emit = (text: string, marks: readonly Mark[]) => { if (text) { children.push(state.schema.text(text, marks)); size += text.length; } };
    const closeFrom = (keep: number) => {
      let length = 0;
      for (const item of open.slice(keep).reverse()) { emit(item.close, previousPlain); length += item.close.length; }
      open = open.slice(0, keep);
      return length;
    };
    entries.forEach((entry, entryIndex) => {
      let common = 0;
      while (common < open.length && common < entry.syntax.length && open[common].mark.eq(entry.syntax[common])) common++;
      const closed = closeFrom(common);
      if (offsets.length) offsets.at(-1)!.closing = closed;
      for (const mark of entry.syntax.slice(common)) {
        const [opening, closing] = mark.type.name === 'link' ? entry.linkMarkers! : markMarkers(mark, entry.child.text || '');
        emit(opening, entry.plain);
        open.push({ mark, close: closing });
      }
      let nextChild = entry.child.mark(entry.plain);
      let posMap: number[] | undefined;
      if (escapedIndices[entryIndex].size && entry.child.isText) {
        const raw = entry.child.text || '';
        let escapedText = '';
        posMap = [0];
        for (let i = 0; i < raw.length; i++) {
          if (escapedIndices[entryIndex].has(i)) escapedText += '\\';
          escapedText += raw[i];
          posMap.push(escapedText.length);
        }
        nextChild = state.schema.text(escapedText, entry.plain);
      }
      offsets.push({ oldStart: entry.offset, oldEnd: entry.offset + entry.child.nodeSize, newStart: size, newEnd: size + nextChild.nodeSize, closing: 0, posMap });
      children.push(nextChild); size += nextChild.nodeSize; previousPlain = entry.plain;
    });
    const closed = closeFrom(0);
    if (offsets.length) offsets.at(-1)!.closing = closed;
    const start = position + 1, selection = (tr || state.tr).selection;
    const mapOffset = (absolute: number) => {
      const offset = absolute - start;
      if (offset < 0 || offset > block.content.size) return null;
      const child = offsets.find(entry => offset > entry.oldStart && offset <= entry.oldEnd) || offsets[0];
      if (!child || offset === 0) return start;
      if (offset === child.oldEnd) return start + child.newEnd + child.closing;
      const inner = offset - child.oldStart;
      return start + child.newStart + (child.posMap ? child.posMap[inner] : inner);
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

export function inlineSourcePlugin(resolveImage: (src: string) => Promise<string>): Plugin<ViewState> {
  let editor: EditorView | undefined;
  let destroyed = false;
  let imagesChanged = false;
  const imageSources = new Map<string, string>();
  function refresh(view: EditorView): void {
    if (view.isDestroyed || view.composing || !(imagesChanged || inlineSourceKey.getState(view.state)?.stale)) return;
    view.dispatch(view.state.tr.setMeta(inlineSourceKey, 'rebuild').setMeta('addToHistory', false));
  }
  const preview: ImagePreview = image => {
    if (!imageSources.has(image.src)) {
      // An empty entry keeps the source visible and avoids repeated reads while
      // loading or after failure.
      imageSources.set(image.src, '');
      void (async () => {
        const resolved = image.local ? await resolveImage(image.src) : image.src;
        if (destroyed) return;
        const img = createInlineHtmlImage(resolved, image);
        if (!img) return;
        await img.decode();
        if (destroyed) return;
        imageSources.set(image.src, resolved);
        imagesChanged = true;
        if (editor) refresh(editor);
      })().catch(() => { /* Keep the editable source visible. */ });
    }
    return imageSources.get(image.src);
  };
  return new Plugin<ViewState>({
    key: inlineSourceKey,
    state: {
      init: (_config, state) => build(state, preview),
      apply(transaction, value, oldState, newState) {
        // Never restyle around an open IME composition; catch up when it closes.
        if (editor?.composing) return { decorations: value.decorations.map(transaction.mapping, transaction.doc), stale: true };
        if (value.stale || imagesChanged || transaction.getMeta(inlineSourceKey) === 'rebuild') {
          imagesChanged = false;
          return build(newState, preview);
        }
        if (!transaction.docChanged && oldState.selection.eq(newState.selection)) return value;
        const changed = transaction.docChanged ? changedRange([transaction]) : null;
        // A bulk transaction (including initial heading IDs) touches most of
        // the tree. Rebuilding once avoids mapping and replacing each span.
        if (changed && changed.to - changed.from >= newState.doc.content.size / 2) return build(newState, preview);
        let decorations = value.decorations.map(transaction.mapping, transaction.doc);
        const ranges = [
          { from: transaction.mapping.map(oldState.selection.from, -1), to: transaction.mapping.map(oldState.selection.to, 1) },
          { from: newState.selection.from, to: newState.selection.to },
        ];
        if (changed) ranges.push(changed);
        const refreshed = new Set<number>();
        for (const range of ranges) decorateRange(newState.doc, range.from, range.to, newState.selection, preview, (position, block, fresh) => {
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
          setTimeout(() => refresh(view), 60);
          return false;
        },
      },
    },
    view(view) {
      editor = view;
      if (imagesChanged) queueMicrotask(() => refresh(view));
      return { destroy() { destroyed = true; editor = undefined; } };
    },
  });
}

// At either outer edge delete the attribute as a unit. Inside it the source is editable.
export function deleteHeadingAttribute(view: EditorView, event: KeyboardEvent): boolean {
  if (!['Delete', 'Backspace'].includes(event.key) || event.isComposing || view.composing ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const { $from, empty } = view.state.selection;
  if (!empty || $from.parent.type.name !== 'heading') return false;
  const range = blockSyntax($from.parent).attributes.find(({ from, to }) =>
    event.key === 'Backspace' ? to === $from.parentOffset : from === $from.parentOffset ||
    (from + 1 === $from.parentOffset && $from.parent.textBetween(from, from + 1) === ' '));
  if (!range) return false;
  event.preventDefault();
  view.dispatch(view.state.tr.delete($from.start() + range.from, $from.start() + range.to).scrollIntoView());
  return true;
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
  if (!blockSpans($head.parent).some(span => (span.innerFrom > span.from || span.to > span.innerTo) && touches(target, span) && !touches(offset, span))) return false;
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
  const open = blockSpans(block).filter(span => !['escape', 'entity', 'autolink'].includes(span.kind) && span.innerFrom < offset && offset < span.innerTo);
  if (!open.length) return false;
  const text = (from: number, to: number) => block.textBetween(from, to, '\n', INLINE_OBJECT);
  // Outer spans come first: close inner-to-outer, reopen outer-to-inner.
  const closing = open.map(span => text(span.innerTo, span.to)).reverse().join(''), opening = open.map(span => text(span.from, span.innerFrom)).join('');
  const position = $from.pos;
  const tr = view.state.tr.insertText(closing + opening, position);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, position + closing.length)));
  return false;
}

/** Ctrl+K and Format -> Link: edit existing inline link URL, or insert source link brackets. */
export function insertOrEditLink(view: EditorView): boolean {
  const { state } = view, { $from, $to, empty } = state.selection;
  if (!$from.sameParent($to) || !isSourceBlock($from.parent)) return false;
  const block = $from.parent, base = $from.start(), from = $from.parentOffset, to = $to.parentOffset;
  const spans = blockEditSpans(block);
  const insideCode = spans.some(span => span.kind === 'code' && (empty ? span.from < from && from < span.to : span.from < to && from < span.to && !(from <= span.from && span.to <= to)));
  const insideAutolink = spans.some(span => span.kind === 'autolink' && span.from <= from && to <= span.to);
  if (insideCode || insideAutolink) return false;
  const existing = spans.filter(span => span.kind === 'link' && span.from <= from && to <= span.to).at(-1);
  const tr = state.tr;
  if (existing) {
    if (existing.urlFrom != null && existing.urlTo != null) {
      tr.setSelection(TextSelection.create(tr.doc, base + existing.urlFrom, base + existing.urlTo));
    } else {
      const tail = block.textBetween(existing.innerTo, existing.to, '\n', INLINE_OBJECT);
      const openParen = tail.indexOf('(');
      if (openParen < 0) return false;
      tr.setSelection(TextSelection.create(tr.doc, base + existing.innerTo + openParen + 1));
    }
  } else if (empty) {
    tr.insertText('[]()', base + from);
    tr.setSelection(TextSelection.create(tr.doc, base + from + 1));
  } else {
    const overlapsLink = spans.some(span => (span.kind === 'link' || span.kind === 'autolink') && span.from < to && from < span.to);
    if (overlapsLink) return false;
    tr.insertText(']()', base + to).insertText('[', base + from);
    tr.setSelection(TextSelection.create(tr.doc, base + to + 3));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

function rectContains(rect: DOMRect, x: number, y: number): boolean {
  return rect.width > 0 && rect.height > 0 && x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1;
}

function spanContainsPoint(view: EditorView, fromPos: number, toPos: number, clientX: number, clientY: number): boolean {
  if (toPos <= fromPos || fromPos < 0 || toPos > view.state.doc.content.size) return false;
  try {
    const start = view.domAtPos(fromPos), end = view.domAtPos(toPos);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return Array.from(range.getClientRects()).some(rect => rectContains(rect, clientX, clientY));
  } catch {
    return false;
  }
}

/** Find the inline `link` / `autolink` span directly beneath a pointer coordinate. */
export function linkAtCoords(view: EditorView, clientX: number, clientY: number, target: EventTarget | null): InlineSpan | null {
  if (target instanceof Element && target.closest('[data-croquill-html], .croquill-html-source, [data-croquill-toc], [data-footnote-reference], .milkdown-code-block, .md-html-image, pre')) {
    return null;
  }
  const coords = view.posAtCoords({ left: clientX, top: clientY });
  if (!coords) return null;
  const $pos = view.state.doc.resolve(coords.pos);
  if (!isSourceBlock($pos.parent)) return null;
  const blockStart = $pos.start(), offset = $pos.parentOffset;
  return blockSpans($pos.parent).filter(span =>
    (span.kind === 'link' || span.kind === 'autolink' || span.html?.tag === 'a') &&
    span.from <= offset && offset <= span.to &&
    (spanContainsPoint(view, blockStart + span.from, blockStart + span.to, clientX, clientY) ||
      spanContainsPoint(view, blockStart + span.innerFrom, blockStart + span.innerTo, clientX, clientY)),
  ).at(-1) || null;
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
