import type { Root } from '@milkdown/kit/transformer';
import { $node, $prose } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { redo as richRedo, undo as richUndo } from '@milkdown/kit/prose/history';
import { NodeSelection, Plugin, Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { preservedMarkdownBlocks } from './fidelity';
import { sanitizeHtmlFragment } from './html-sanitize';

export type RawBlockKind = '' | 'html';

interface RawTreeNode {
  type: string;
  value?: string;
  kind?: RawBlockKind;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: RawTreeNode[];
}

export interface HtmlBlockPluginOptions {
  resolveImage?: (src: string) => Promise<string>;
}

const RAW_BLOCK_NODE_NAME = 'croquill_raw_block';
const TRAILING_SPACE_RE = /([ \t\r\n]*)$/;
const FIRST_NEWLINE_RE = /\r\n|\r|\n/;

const composingTextareas = new WeakSet<HTMLTextAreaElement>();
const htmlViewsByDom = new WeakMap<HTMLElement, HtmlBlockNodeView>();

function rawBlockKind(value: unknown): RawBlockKind {
  return value === 'html' ? 'html' : '';
}

function normalizeDisplayNewlines(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

function splitRawTail(value: string): { body: string; tail: string; lineEnding: string } {
  const match = TRAILING_SPACE_RE.exec(value);
  const tail = match ? match[1] : '';
  const body = tail ? value.slice(0, value.length - tail.length) : value;
  const lineEnding = FIRST_NEWLINE_RE.exec(value)?.[0] || '\n';
  return { body, tail, lineEnding };
}

function mapSelectionOffset(oldText: string, nextText: string, offset: number): number {
  let prefix = 0;
  const minLen = Math.min(oldText.length, nextText.length);
  while (prefix < minLen && oldText[prefix] === nextText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < nextText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldEnd = oldText.length - suffix;
  if (offset < prefix) return offset;
  if (offset >= oldEnd) return Math.max(prefix, nextText.length - (oldText.length - offset));
  return nextText.length - suffix;
}

function restoreTextareaSelection(
  textarea: HTMLTextAreaElement,
  oldText: string,
  nextText: string,
  oldStart: number,
  oldEnd: number,
): void {
  const nextStart = mapSelectionOffset(oldText, nextText, oldStart);
  const nextEnd = oldEnd === oldStart ? nextStart : mapSelectionOffset(oldText, nextText, oldEnd);
  textarea.setSelectionRange(Math.min(nextStart, nextEnd), Math.max(nextStart, nextEnd));
}

function isFormattingShortcut(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === 'x';
  return key === 'b' || key === 'i' || key === 'k' || /^[0-6]$/.test(key) || key === '=' || key === '-'
    || /^Digit[0-6]$/.test(event.code) || /^Numpad[0-6]$/.test(event.code) || event.code === 'Equal' || event.code === 'Minus';
}

/** Reports whether an active HTML block source textarea inside `root` is currently composing via IME. */
export function isHtmlSourceComposing(root: HTMLElement): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && root.contains(active) && active.classList.contains('croquill-html-source')) {
    return composingTextareas.has(active);
  }
  for (const textarea of root.querySelectorAll<HTMLTextAreaElement>('textarea.croquill-html-source')) {
    if (composingTextareas.has(textarea)) return true;
  }
  return false;
}

/** Reports whether keyboard focus is currently inside a block HTML source textarea within `root`. */
export function isFocusedHtmlSource(root: HTMLElement): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement && root.contains(active) && active.classList.contains('croquill-html-source');
}

class HtmlBlockNodeView implements NodeView {
  readonly dom: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly preview: HTMLDivElement;
  private node: ProseNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly resolveImage?: (src: string) => Promise<string>;
  private savedTail: string;
  private lineEnding: string;
  private editing = false;
  private composing = false;
  private destroyed = false;
  private renderToken = 0;
  private suppressPreviewClick = false;

  constructor(
    node: ProseNode,
    view: EditorView,
    getPos: () => number | undefined,
    resolveImage?: (src: string) => Promise<string>,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.resolveImage = resolveImage;

    const split = splitRawTail(String(node.attrs.value ?? ''));
    this.savedTail = split.tail;
    this.lineEnding = split.lineEnding;

    this.dom = document.createElement('div');
    this.dom.setAttribute('data-croquill-raw', '');
    this.dom.setAttribute('data-croquill-html', '');
    this.dom.setAttribute('data-croquill-raw-kind', 'html');
    this.dom.contentEditable = 'false';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'croquill-html-source';
    this.textarea.spellcheck = false;
    this.textarea.setAttribute('aria-label', 'HTML 源码');
    this.textarea.hidden = true;
    this.textarea.value = normalizeDisplayNewlines(split.body);

    this.preview = document.createElement('div');
    this.preview.className = 'croquill-html-preview';

    this.dom.append(this.textarea, this.preview);
    this.syncDomAttributes();
    this.renderPreview();
    htmlViewsByDom.set(this.dom, this);

    this.preview.addEventListener('mousedown', this.onPreviewMouseDown);
    this.preview.addEventListener('click', this.onPreviewClick);
    this.textarea.addEventListener('compositionstart', this.onCompositionStart);
    this.textarea.addEventListener('compositionend', this.onCompositionEnd);
    this.textarea.addEventListener('input', this.onTextareaInput);
    this.textarea.addEventListener('keydown', this.onTextareaKeyDown);
    this.textarea.addEventListener('blur', this.onTextareaBlur);
  }

  private syncDomAttributes(): void {
    this.dom.setAttribute('data-croquill-raw-value', JSON.stringify(String(this.node.attrs.value ?? '')));
  }

  private syncVisibility(): void {
    this.textarea.hidden = !this.editing;
    this.dom.classList.toggle('croquill-html-editing', this.editing);
  }

  private autoResize(): void {
    if (this.textarea.hidden) return;
    this.textarea.style.height = 'auto';
    const border = this.textarea.offsetHeight - this.textarea.clientHeight;
    if (this.textarea.scrollHeight > 0) {
      this.textarea.style.height = `${this.textarea.scrollHeight + border}px`;
    }
  }

  private renderPreview(): void {
    const token = ++this.renderToken;
    const raw = String(this.node.attrs.value ?? '');
    const { body } = splitRawTail(raw);
    const fragment = sanitizeHtmlFragment(body, {
      resolveImage: this.resolveImage,
      isStale: () => this.destroyed || token !== this.renderToken,
    });
    this.preview.replaceChildren(fragment);
  }

  enterEdit(): void {
    if (this.destroyed || this.editing) return;
    const pos = this.getPos();
    if (pos != null) {
      const { selection } = this.view.state;
      if (!(selection instanceof NodeSelection && selection.from === pos)) {
        this.view.dispatch(
          this.view.state.tr
            .setSelection(NodeSelection.create(this.view.state.doc, pos))
            .setMeta('addToHistory', false),
        );
      }
    }
    const split = splitRawTail(String(this.node.attrs.value ?? ''));
    this.savedTail = split.tail;
    this.lineEnding = split.lineEnding;
    this.textarea.value = normalizeDisplayNewlines(split.body);
    this.editing = true;
    this.syncVisibility();
    this.autoResize();
    this.textarea.focus();
    const end = this.textarea.value.length;
    this.textarea.setSelectionRange(end, end);
  }

  private commitDraft(): void {
    if (this.destroyed) return;
    const pos = this.getPos();
    if (pos == null) return;
    const currentRaw = String(this.node.attrs.value ?? '');
    const currentBody = currentRaw.endsWith(this.savedTail)
      ? currentRaw.slice(0, currentRaw.length - this.savedTail.length)
      : splitRawTail(currentRaw).body;
    const draftDisplay = normalizeDisplayNewlines(this.textarea.value);
    if (draftDisplay === normalizeDisplayNewlines(currentBody)) return;
    const nextRaw = draftDisplay.replace(/\n/g, this.lineEnding) + this.savedTail;
    if (nextRaw === currentRaw) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value: nextRaw }),
    );
  }

  private replaceWithEmptyParagraph(reason: 'escape' | 'up' | 'down' | 'blur'): void {
    const pos = this.getPos();
    if (pos == null) return;
    const paragraphType = this.view.state.schema.nodes.paragraph;
    if (!paragraphType) return;
    const paragraph = paragraphType.create();
    let tr = this.view.state.tr.replaceWith(pos, pos + this.node.nodeSize, paragraph);
    if (reason === 'blur') {
      this.view.dispatch(tr);
      return;
    }
    if (reason === 'escape') {
      const caretPos = Math.min(pos + 1, tr.doc.content.size);
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(caretPos))).scrollIntoView();
      this.view.dispatch(tr);
      this.view.focus();
      return;
    }
    const probePos = reason === 'up' ? pos : pos + paragraph.nodeSize;
    const clampedProbe = Math.min(probePos, tr.doc.content.size);
    const adjacent = Selection.findFrom(tr.doc.resolve(clampedProbe), reason === 'up' ? -1 : 1)
      ?? TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size)));
    this.view.dispatch(tr.setSelection(adjacent).scrollIntoView());
    this.view.focus();
  }

  private leaveEdit(reason: 'escape' | 'up' | 'down' | 'blur'): void {
    if (!this.editing) return;
    const wasComposing = this.composing;
    this.composing = false;
    composingTextareas.delete(this.textarea);
    if (wasComposing) this.commitDraft();
    this.editing = false;
    this.syncVisibility();

    if (!normalizeDisplayNewlines(this.textarea.value).trim()) {
      this.replaceWithEmptyParagraph(reason);
      return;
    }
    if (reason === 'blur') return;

    const pos = this.getPos();
    if (pos == null) return;
    let target: Selection | null = null;
    if (reason === 'up') {
      target = Selection.findFrom(this.view.state.doc.resolve(pos), -1);
    } else if (reason === 'down') {
      target = Selection.findFrom(this.view.state.doc.resolve(pos + this.node.nodeSize), 1);
    }
    if (!target) {
      target = NodeSelection.create(this.view.state.doc, pos);
    }
    this.view.dispatch(this.view.state.tr.setSelection(target).setMeta('addToHistory', false).scrollIntoView());
    this.view.focus();
  }

  private onPreviewMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.suppressPreviewClick = this.editing;
    if (this.editing) {
      window.addEventListener('mouseup', () => {
        setTimeout(() => { this.suppressPreviewClick = false; }, 0);
      }, { once: true });
    }
  };

  private onPreviewClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (target?.closest('a')) event.preventDefault();
    if (event.button !== 0) return;
    if (this.suppressPreviewClick) {
      this.suppressPreviewClick = false;
      return;
    }
    if (target?.closest('summary')) return;
    this.enterEdit();
  };

  private onCompositionStart = (): void => {
    this.composing = true;
    composingTextareas.add(this.textarea);
  };

  private onCompositionEnd = (): void => {
    this.composing = false;
    composingTextareas.delete(this.textarea);
    this.autoResize();
    this.commitDraft();
  };

  private onTextareaInput = (): void => {
    this.autoResize();
    if (!this.composing) this.commitDraft();
  };

  private onTextareaBlur = (): void => {
    this.leaveEdit('blur');
  };

  private onTextareaKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || this.composing) return;
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
    const key = event.key.toLowerCase();

    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) richRedo(this.view.state, this.view.dispatch, this.view);
      else richUndo(this.view.state, this.view.dispatch, this.view);
      return;
    }
    if (mod && !event.shiftKey && key === 'y') {
      event.preventDefault();
      richRedo(this.view.state, this.view.dispatch, this.view);
      return;
    }
    if (isFormattingShortcut(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      this.leaveEdit('escape');
      return;
    }
    if (
      event.key === 'ArrowUp' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      this.textarea.selectionStart === 0 &&
      this.textarea.selectionEnd === 0
    ) {
      event.preventDefault();
      this.leaveEdit('up');
      return;
    }
    if (
      event.key === 'ArrowDown' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      this.textarea.selectionStart === this.textarea.value.length &&
      this.textarea.selectionEnd === this.textarea.value.length
    ) {
      event.preventDefault();
      this.leaveEdit('down');
    }
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type || rawBlockKind(node.attrs.kind) !== 'html') return false;
    const oldValue = String(this.node.attrs.value ?? '');
    const newValue = String(node.attrs.value ?? '');
    this.node = node;
    this.syncDomAttributes();

    let body: string;
    if (this.editing && newValue.endsWith(this.savedTail)) {
      body = newValue.slice(0, newValue.length - this.savedTail.length);
    } else {
      const split = splitRawTail(newValue);
      this.savedTail = split.tail;
      this.lineEnding = split.lineEnding;
      body = split.body;
    }

    if (newValue !== oldValue) this.renderPreview();

    const nextDisplay = normalizeDisplayNewlines(body);
    if (!this.composing && normalizeDisplayNewlines(this.textarea.value) !== nextDisplay) {
      const oldText = this.textarea.value;
      const start = this.textarea.selectionStart ?? oldText.length;
      const end = this.textarea.selectionEnd ?? start;
      const hadFocus = document.activeElement === this.textarea;
      this.textarea.value = nextDisplay;
      if (hadFocus) restoreTextareaSelection(this.textarea, oldText, nextDisplay, start, end);
      this.autoResize();
    }
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  stopEvent(event: Event): boolean {
    const target = event.target as Node | null;
    if (!target) return false;
    if (target === this.textarea || this.textarea.contains(target)) {
      return !event.type.startsWith('drag') && event.type !== 'drop';
    }
    if (target === this.preview || this.preview.contains(target)) {
      return event.type === 'mousedown' || event.type === 'mouseup' || event.type === 'click' || event.type === 'dblclick';
    }
    return false;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.editing = false;
    this.composing = false;
    composingTextareas.delete(this.textarea);
    htmlViewsByDom.delete(this.dom);
    this.preview.removeEventListener('mousedown', this.onPreviewMouseDown);
    this.preview.removeEventListener('click', this.onPreviewClick);
    this.textarea.removeEventListener('compositionstart', this.onCompositionStart);
    this.textarea.removeEventListener('compositionend', this.onCompositionEnd);
    this.textarea.removeEventListener('input', this.onTextareaInput);
    this.textarea.removeEventListener('keydown', this.onTextareaKeyDown);
    this.textarea.removeEventListener('blur', this.onTextareaBlur);
  }
}

/** Handles Enter on a selected HTML raw block to enter inline source editing. */
export function handleHtmlBlockKey(view: EditorView, event: KeyboardEvent): boolean {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing ||
    view.composing
  ) {
    return false;
  }
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection)) return false;
  if (selection.node.type.name !== RAW_BLOCK_NODE_NAME || rawBlockKind(selection.node.attrs.kind) !== 'html') {
    return false;
  }
  const dom = view.nodeDOM(selection.from);
  const nodeView = dom instanceof HTMLElement ? htmlViewsByDom.get(dom) : undefined;
  if (!nodeView) return false;
  event.preventDefault();
  nodeView.enterEdit();
  return true;
}

/** Registers the ProseMirror node view plugin that renders pure HTML raw blocks in WYSIWYG mode. */
export function htmlBlockPlugin(options: HtmlBlockPluginOptions = {}) {
  return $prose(() => new Plugin({
    props: {
      nodeViews: {
        [RAW_BLOCK_NODE_NAME]: (node, view, getPos) => (
          rawBlockKind(node.attrs.kind) === 'html'
            ? new HtmlBlockNodeView(node, view, getPos, options.resolveImage)
            // Fall back to default NodeViewDesc / toDOM for non-HTML preserved blocks.
            : (undefined as unknown as NodeView)
        ),
      },
    },
  }));
}

/** Runs before the editor's HTML/GFM transforms, using the actual parse input. */
export function preserveRawMarkdown() {
  return (tree: Root, file: { value: unknown }) => {
    const rawTree = tree as unknown as RawTreeNode;
    const source = String(file.value ?? '');
    const blocks = preservedMarkdownBlocks(source);
    if (!blocks.length || !rawTree.children) return tree;
    const next: RawTreeNode[] = [];
    let index = 0;
    for (const child of rawTree.children) {
      const from = child.position?.start.offset;
      while (from != null && blocks[index] && from >= blocks[index].to) index++;
      const block = blocks[index];
      if (block && from != null && from >= block.from && from < block.to) {
        if (from === block.from) {
          const kind: RawBlockKind = block.categories.length === 1 && block.categories[0] === 'HTML' ? 'html' : '';
          next.push({ type: 'croquillRawBlock', value: block.raw, kind, position: child.position });
        }
      } else next.push(child);
    }
    rawTree.children = next;
    return tree;
  };
}

export const rawMarkdownBlock = $node(RAW_BLOCK_NODE_NAME, () => ({
  group: 'block', atom: true, selectable: true, draggable: true,
  attrs: {
    value: { default: '', validate: 'string' },
    kind: { default: '', validate: 'string' },
  },
  toDOM: node => (
    rawBlockKind(node.attrs.kind) === 'html'
      ? ['pre', {
        'data-croquill-raw': '',
        'data-croquill-html': '',
        'data-croquill-raw-kind': 'html',
        'data-croquill-raw-value': JSON.stringify(String(node.attrs.value)),
        'aria-label': 'HTML 原文块',
      }, String(node.attrs.value)]
      : ['pre', { 'data-croquill-raw': '', 'aria-label': '原文块，请在源码模式编辑' }, String(node.attrs.value)]
  ),
  parseDOM: [{
    tag: '[data-croquill-raw]',
    priority: 100,
    getAttrs: dom => {
      const element = dom as HTMLElement;
      const encodedValue = element.getAttribute('data-croquill-raw-value');
      let value = element.textContent || '';
      if (encodedValue != null) {
        try {
          const parsed = JSON.parse(encodedValue);
          if (typeof parsed === 'string') value = parsed;
        } catch {
          // Ignore malformed JSON and fall back to textContent.
        }
      }
      return { value, kind: rawBlockKind(element.getAttribute('data-croquill-raw-kind')) };
    },
  }],
  parseMarkdown: {
    match: node => node.type === 'croquillRawBlock',
    runner: (state, node, type) => {
      const kind = rawBlockKind((node as RawTreeNode).kind);
      state.addNode(type, { value: String(node.value ?? ''), kind });
    },
  },
  toMarkdown: {
    match: node => node.type.name === RAW_BLOCK_NODE_NAME,
    // The HTML writer emits value verbatim; this is source, never live DOM HTML.
    runner: (state, node) => { state.addNode('html', undefined, String(node.attrs.value), { data: { croquillRaw: true } }); },
  },
}));
