import { NodeSelection, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { EditorView as CodeView } from '@codemirror/view';

export function writingDecorations(state: EditorState): DecorationSet {
  const { selection } = state, { $head } = selection;
  const marks: Decoration[] = [];
  if ($head.depth) {
    const node = $head.parent;
    const syntax = node.type.name === 'heading' && node.attrs.level >= 4 ? '#'.repeat(node.attrs.level)
      : node.type.name === 'blockquote' ? '>' : '';
    marks.push(Decoration.node($head.before(), $head.after(), { class: 'tx-active-block', 'data-syntax': syntax }));
  }
  let depth = $head.depth;
  for (let i = depth; i > 0; i--) {
    if (['table_row', 'table_header_row'].includes($head.node(i).type.name)) { depth = i; break; }
  }
  if (selection instanceof NodeSelection && selection.node.isBlock && depth === $head.depth) {
    marks.push(Decoration.node(selection.from, selection.to, { class: 'tx-focus-block' }));
  } else if (depth) {
    marks.push(Decoration.node($head.before(depth), $head.after(depth), { class: 'tx-focus-block' }));
  }
  return DecorationSet.create(state.doc, marks);
}

// The HTML block's textarea owns its caret; the outer selection covers the whole block.
function textareaCaret(field: HTMLTextAreaElement): DOMRect {
  const style = getComputedStyle(field), box = field.getBoundingClientRect();
  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none', boxSizing: 'border-box',
    top: (box.top + field.clientTop - field.scrollTop) + 'px', left: '0', width: field.clientWidth + 'px',
    font: style.font, lineHeight: style.lineHeight, padding: style.padding, tabSize: style.tabSize,
    whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, letterSpacing: style.letterSpacing,
  });
  const text = mirror.appendChild(document.createTextNode(field.value + '\u200b'));
  document.body.append(mirror);
  const range = document.createRange();
  range.setStart(text, field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd);
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  mirror.remove();
  return rect;
}

/** Center only in response to a writing gesture. Programmatic selections never start a scroll. */
export class Typewriter {
  private frame = 0;
  private readonly listeners = new AbortController();
  private composing = false;
  private pointerDown = false;
  private keyboardSelection = false;

  constructor(private root: HTMLElement, private scroller: HTMLElement, private view: () => EditorView) {
    const capture = { capture: true, signal: this.listeners.signal };
    root.addEventListener('keydown', event => {
      if (event.isComposing || event.altKey) return;
      const key = event.key.toLowerCase();
      if (/^(arrow(up|down|left|right)|home|end|pageup|pagedown|backspace|delete|enter)$/.test(key) ||
          ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(key))) {
        this.keyboardSelection = this.root.classList.contains('typewriter');
        this.schedule(event.target);
      }
    }, capture);
    // Native Home/End and arrow keys can move the DOM caret after keydown's layout frame.
    document.addEventListener('selectionchange', () => {
      if (!this.keyboardSelection) return;
      this.keyboardSelection = false;
      this.schedule(document.activeElement);
    }, { signal: this.listeners.signal });
    root.addEventListener('input', event => this.schedule(event.target), capture);
    root.addEventListener('paste', event => this.schedule(event.target), capture);
    root.addEventListener('compositionstart', () => { this.composing = true; this.cancel(); }, capture);
    root.addEventListener('compositionend', event => { this.composing = false; this.schedule(event.target); }, capture);
    root.addEventListener('focusout', () => { this.composing = false; this.cancel(); }, capture);
    document.addEventListener('pointerdown', () => { this.pointerDown = true; this.cancel(); }, capture);
    const release = () => { this.pointerDown = false; };
    document.addEventListener('pointerup', release, capture);
    document.addEventListener('pointercancel', release, capture);
    window.addEventListener('blur', release, capture);
    scroller.addEventListener('wheel', () => this.cancel(), { ...capture, passive: true });
  }

  setEnabled(enabled: boolean): void {
    this.cancel();
    const editor = this.root.querySelector<HTMLElement>('.ProseMirror');
    const preserve = !enabled && !this.root.hidden && editor && this.root.classList.contains('typewriter');
    const scroll = this.scroller.scrollTop;
    const padding = preserve ? parseFloat(getComputedStyle(editor).paddingTop) : 0;
    this.root.classList.toggle('typewriter', enabled);
    if (enabled) this.schedule(document.activeElement);
    else if (preserve) {
      this.scroller.scrollTop = scroll + parseFloat(getComputedStyle(editor).paddingTop) - padding;
    }
  }

  schedule(target: EventTarget | null): void {
    if (this.frame || this.composing || this.pointerDown || this.root.hidden || !this.root.classList.contains('typewriter') ||
        !(target instanceof Element) || !target.closest('.ProseMirror')) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const active = document.activeElement;
      if (this.root.hidden || !active?.closest('.ProseMirror') || !this.root.contains(active)) return;
      const view = this.view();
      if (view.composing) return;
      const codeEditor = active.closest<HTMLElement>('.cm-editor');
      const cm = codeEditor && CodeView.findFromDOM(codeEditor);
      const selection = document.getSelection();
      const head = !cm && selection?.focusNode && view.dom.contains(selection.focusNode)
        ? view.posAtDOM(selection.focusNode, selection.focusOffset) : view.state.selection.head;
      const rect = active instanceof HTMLTextAreaElement ? textareaCaret(active)
        : cm ? cm.coordsAtPos(cm.state.selection.main.head) : view.coordsAtPos(head);
      if (!rect) return;
      const viewport = this.scroller.getBoundingClientRect();
      this.scroller.scrollTop += (rect.top + rect.bottom - viewport.top - viewport.bottom) / 2;
    });
  }

  cancel(): void { cancelAnimationFrame(this.frame); this.frame = 0; this.keyboardSelection = false; }
  destroy(): void { this.cancel(); this.listeners.abort(); }
}
