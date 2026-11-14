import { Crepe } from '@milkdown/crepe';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { dropIndicatorPlugin } from '@milkdown/kit/plugin/cursor';
import { isImageFile } from './images';
import { hasFileTransfer } from './file-drop';
import { commandsCtx, editorViewCtx, nodesCtx, parserCtx, serializerCtx, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { docSchema, emphasisKeymap, emphasisStarInputRule, emphasisUnderscoreInputRule, inlineCodeInputRule, inlineCodeKeymap, strongInputRule, strongKeymap } from '@milkdown/kit/preset/commonmark';
import { insertTableCommand, strikethroughInputRule, strikethroughKeymap } from '@milkdown/kit/preset/gfm';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, TextSelection, type Command } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView as RichView } from '@milkdown/kit/prose/view';
import { setBlockType, wrapIn } from '@milkdown/kit/prose/commands';
import { wrapInList, liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import { closeHistory, undo as richUndo, redo as richRedo } from '@milkdown/kit/prose/history';
import type { Node as RichNode } from '@milkdown/kit/prose/model';
import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, undo, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { classHighlighter, tagHighlighter, tags } from '@lezer/highlight';
import { highlightSelectionMatches } from '@codemirror/search';
import { detectUnsafeMarkdown, hasEquivalentMarkdownStructure, markdownOutline, preservedMarkdownBlocks, splitFrontmatter } from './fidelity';
import { handleHtmlBlockKey, htmlBlockPlugin, isFocusedHtmlSource, isHtmlSourceComposing, preserveRawMarkdown, rawMarkdownBlock } from './raw-markdown';
import { configureHtmlBreaks, handleHtmlBreakKey, parseHtmlBreaks } from './html-break';
import { preserveTableSource } from './table-source';
import { configureEmptyListItems, preserveEmptyListSource } from './empty-list';
import { createInlineRawMarkdown, handleInlineRawKey, hasUnsafeInlineTableContent, preserveInlineHtml, parseHtmlComments } from './inline-raw';
import { alertBlock, configureAlerts, parseAlerts } from './alerts';
import { highlightMark } from './highlight';
import { configureInlineSource, flattenInlineSource } from './inline-source-markdown';
import { handleSourceArrow, handleSourceEnter, inlineSourcePlugin, linkInputHandlers, toggleInlineSyntax } from './inline-source-view';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { $inputRule } from '@milkdown/kit/utils';
import { preserveRenderedSource } from './rendered-source';
import { configureTocFootnotes, footnoteInputRule, handleTocFootnoteKey, parseTocFootnotes, tocBlock, tocFootnotePlugin } from './toc-footnotes';
import { SearchPanel, type SearchReplaceResult } from './search-panel';
import { RichSearchPainter } from './rich-search';
import { applySourceChanges, normalizedOffset, normalizedSource, replacementProblem, sourceOffset, type SearchMatch, type SearchOptions, type SourceChange } from './search-core';
import { setSourceMatches, setSourceVersion, sourceSearchHighlights, sourceVersion, sourceVersionHistory } from './source-search-state';
import { nextHeadingLevel, sourceHeadingChange } from './heading-level';
import './rendered-syntax.css';

/** Ctrl+0 / Ctrl+= / Ctrl+-; `code` covers layouts and IME states that change `key`. */
function headingLevelShortcut(event: KeyboardEvent): string | null {
  if (event.shiftKey) return null;
  if (event.key === '0' || event.code === 'Digit0') return 'paragraph';
  if (event.key === '=' || event.code === 'Equal') return 'heading-up';
  if (event.key === '-' || event.code === 'Minus') return 'heading-down';
  return null;
}

/** Typora: Backspace at the very start of a heading turns it into a paragraph in one step. */
function handleHeadingBackspace(view: RichView, event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' || event.isComposing || view.composing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const { $from, empty } = view.state.selection, { heading, paragraph } = view.state.schema.nodes;
  if (!empty || $from.parent.type !== heading || $from.parentOffset !== 0) return false;
  if (!setBlockType(paragraph)(view.state, view.dispatch, view)) return false;
  event.preventDefault();
  return true;
}
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

export type EditingMode = 'rich' | 'source';
const UNRELIABLE_ROUND_TRIP = '此文档的部分结构无法可靠往返转换，已保留原文并启用源码保护';
export interface MarkdownSurfaceOptions {
  richRoot: HTMLElement;
  sourceRoot: HTMLElement;
  onChange: (markdown: string) => void;
  onDirty?: () => void;
  onWarning?: (message: string) => void;
  resolveImage: (src: string) => Promise<string>;
  onImageFiles?: (files: File[], clipboard: boolean) => void;
  uploadImage?: (file: File) => Promise<string | null>;
}

/** Two mature editing surfaces, with the unmodified Markdown kept independently. */
export class MarkdownSurface {
  private crepe?: Crepe;
  private inlineRaw?: ReturnType<typeof createInlineRawMarkdown>;
  private source?: EditorView;
  private raw = '';
  private richNotice: string | null = null;
  private richInput?: string;
  private sourceInput?: string;
  private richSnapshot?: RichNode;
  private richOriginDocument?: RichNode;
  private richOriginText = '';
  private sourceOriginDocument = '';
  private sourceOriginText = '';
  private currentMode: EditingMode = 'rich';
  private safetyReason: string | null = null;
  private suppress = false;
  private richTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private deferredFocus?: () => void;
  private readonly find: SearchPanel;
  private readonly searchPainter: RichSearchPainter;
  private replacementVersion = 0;
  private sourceUpdating = false;
  private richExactSources = new Map<string, string>();
  private sourceExactSources = new Map<string, string>();
  private richContextVersion = '';
  private unreliableRich?: string;
  private richContexts = new Map<string, { base: string; origin: RichNode | undefined; originText: string; notice: string | null }>();

  constructor(private readonly options: MarkdownSurfaceOptions) {
    this.searchPainter = new RichSearchPainter(options.richRoot);
    this.find = new SearchPanel({
      text: () => this.getMarkdown(), focus: () => this.focus(),
      replace: (matches, replacement) => this.replaceSearchMatches(matches, replacement),
      paint: (text, matches, current, query, settings) => this.paintSearch(text, matches, current, query, settings),
      reveal: (index, match) => {
        if (this.currentMode === 'rich') this.searchPainter.reveal(index);
        else if (this.source) { const from = normalizedOffset(this.raw, match.from), to = normalizedOffset(this.raw, match.to); this.source.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) }); }
      },
      clear: () => { this.searchPainter.clear(); this.source?.dispatch({ effects: setSourceMatches.of({ matches: [], current: 0 }) }); },
    });
    this.find.mount(options.richRoot);
    for (const root of [options.richRoot, options.sourceRoot]) {
      root.addEventListener('paste', this.handleImagePaste, { capture: true });
      root.addEventListener('drop', this.handleImageDrop, { capture: true });
      root.addEventListener('dragover', this.handleImageDragOver, { capture: true });
      root.addEventListener('keydown', this.handleSearchShortcut, { capture: true });
    }
  }

  private handleSearchShortcut = (event: KeyboardEvent): void => {
    if (event.isComposing || this.isComposing() || event.altKey || !(event.ctrlKey || event.metaKey) || !['f', 'h'].includes(event.key.toLowerCase())) return;
    event.preventDefault(); event.stopPropagation(); this.toggleSearch(event.key.toLowerCase() === 'h');
  };
  openSearch(replace = false): void {
    if (this.hasFocusedComposition()) return;
    let selection = '';
    if (this.currentMode === 'source' && this.source) { const range = this.source.state.selection.main; selection = this.source.state.sliceDoc(range.from, range.to); }
    else if (this.crepe) { const view = this.richView(); selection = view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n'); }
    this.find.open(replace, selection);
  }
  toggleSearch(replace = false): void { if (!this.hasFocusedComposition()) this.find.toggle(replace); }
  private publishChange(text: string): void {
    this.options.onChange(text);
    if (this.sourceUpdating) queueMicrotask(() => { if (!this.destroyed) this.find.documentChanged(); });
    else this.find.documentChanged();
  }
  private paintSearch(text: string, matches: SearchMatch[], current: number, query: string, settings: SearchOptions): void {
    if (this.currentMode === 'rich' && this.crepe) this.searchPainter.paint(text, this.richView(), matches, current, query, settings);
    else {
      this.searchPainter.clear();
      this.source?.dispatch({ effects: setSourceMatches.of({ matches: matches.map(match => ({ from: normalizedOffset(text, match.from), to: normalizedOffset(text, match.to) })), current }) });
    }
  }

  private handleImagePaste = (event: ClipboardEvent): void => {
    const html = event.clipboardData?.getData('text/html') || '';
    // A copied web image keeps its URL instead of uploading a browser-provided bitmap.
    if (/<img\b[^>]*\bsrc=["']https?:/i.test(html)) return;
    const files = Array.from(event.clipboardData?.files || []).filter(isImageFile);
    if (!files.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!this.isComposing()) this.options.onImageFiles?.(files, true);
  };
  private handleImageDrop = (event: DragEvent): void => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    // Ignore non-image files too: neither the browser nor an editor plugin may open them.
    event.preventDefault(); event.stopImmediatePropagation();
    const files = Array.from(event.dataTransfer?.files || []).filter(isImageFile);
    if (!files.length || this.isComposing()) return;
    this.placeImageCursor(event.clientX, event.clientY);
    this.options.onImageFiles?.(files, false);
  };
  private handleImageDragOver = (event: DragEvent): void => {
    if (hasFileTransfer(event.dataTransfer)) event.preventDefault();
  };

  placeImageCursor(x: number, y: number): void {
    if (this.isComposing()) return;
    if (this.currentMode === 'source' && this.source) {
      const pos = this.source.posAtCoords({ x, y });
      if (pos !== null) this.source.dispatch({ selection: { anchor: pos } });
    } else if (this.crepe) {
      const view = this.richView();
      const pos = view.posAtCoords({ left: x, top: y });
      if (pos) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos.pos))));
    }
  }

  insertImage(src: string): void {
    if (this.isComposing() || this.destroyed) return;
    if (this.currentMode === 'source' && this.source) {
      const { from, to } = this.source.state.selection.main;
      const text = `![](${src})`;
      this.source.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input' });
    } else if (this.crepe) {
      const view = this.richView();
      const type = view.state.schema.nodes['image-block'];
      view.dispatch(view.state.tr.replaceSelectionWith(type.create({ src, alt: '' })).scrollIntoView());
      this.notifyRichChange();
    }
  }

  get mode(): EditingMode { return this.currentMode; }
  getSafetyReason(): string | null { return this.safetyReason; }
  getRichNotice(): string | null { return this.currentMode === 'rich' ? this.richNotice : null; }

  async init(markdownText: string): Promise<void> { await this.load(markdownText); }

  async load(markdownText: string): Promise<void> {
    this.cancelRichTimer();
    this.suppress = true;
    this.raw = markdownText;
    this.richNotice = null;
    this.richInput = undefined;
    this.sourceInput = undefined;
    this.richSnapshot = undefined;
    this.richExactSources.clear(); this.sourceExactSources.clear(); this.richContexts.clear(); this.richContextVersion = '';
    this.safetyReason = detectUnsafeMarkdown(markdownText);
    this.source?.destroy();
    this.source = undefined;
    if (this.crepe) await this.crepe.destroy();
    this.crepe = undefined;
    this.options.richRoot.replaceChildren();
    this.options.sourceRoot.replaceChildren();
    try {
      if (this.safetyReason) {
        this.currentMode = 'source';
        this.ensureSource();
      } else {
        this.currentMode = 'rich';
        await this.ensureRich();
        if (this.safetyReason) {
          this.currentMode = 'source';
          this.ensureSource();
        }
      }
      this.applyVisibility();
    } finally { this.suppress = false; }
    this.find.mount(this.options.richRoot); this.find.documentChanged();
  }

  async setMode(mode: EditingMode): Promise<void> {
    if (this.hasFocusedComposition()) return;
    this.getMarkdown();
    if (mode === 'rich') {
      this.safetyReason = detectUnsafeMarkdown(this.raw);
      if (this.safetyReason) {
        this.currentMode = 'source';
        this.ensureSource();
      } else {
        await this.ensureRich();
        this.currentMode = this.safetyReason ? 'source' : 'rich';
        if (this.safetyReason) this.ensureSource();
      }
    } else {
      this.ensureSource();
      this.currentMode = 'source';
    }
    this.applyVisibility();
    this.focus();
    this.find.documentChanged();
  }

  /** Flush synchronously, so Ctrl+S immediately after a keystroke saves that keystroke. */
  getMarkdown(): string {
    if (!this.suppress && this.currentMode === 'rich' && this.crepe && this.richSnapshot) {
      const document = this.richView().state.doc;
      if (!document.eq(this.richSnapshot)) {
        const version = String(document.attrs.croquillSourceVersion || '');
        if (version !== this.richContextVersion) {
          const context = this.richContexts.get(version);
          if (context) { this.richInput = context.base; this.richOriginDocument = context.origin; this.richOriginText = context.originText; this.richNotice = context.notice; }
          this.richContextVersion = version;
        }
        const exact = this.richExactSources.size ? this.richExactSources.get(JSON.stringify(document.toJSON())) : undefined;
        this.raw = exact !== undefined ? exact : this.richOriginDocument?.eq(document) ? this.richOriginText : this.serializeRich();
        this.richSnapshot = document;
        this.richInput = this.raw;
        this.cancelRichTimer();
        this.publishChange(this.raw);
      }
    }
    return this.raw;
  }

  focus(): void {
    if (this.deferredFocus) { this.deferredFocus(); return; }
    if (this.currentMode === 'source') this.source?.focus();
    else if (this.crepe) this.richView().focus();
  }

  /** An inert editor cannot focus. Replay focus only after the operation unlocks it. */
  deferFocus(): () => void {
    const previous = document.activeElement;
    const ownsFocus = (element: Element | null) => !!element &&
      (!!this.source?.contentDOM.contains(element) || !!this.crepe && this.richView().dom.contains(element));
    let requested = ownsFocus(previous);
    this.deferredFocus = () => { requested = true; };
    return () => {
      this.deferredFocus = undefined;
      if (!requested || this.destroyed || document.querySelector('dialog[open], [popover]:popover-open')) return;
      const current = document.activeElement;
      // Respect a dialog/control the user moved to while native IO was pending.
      if (current && current !== document.body && current !== previous && !ownsFocus(current)) return;
      // Both editors keep their model selection through blur. focus() syncs it to
      // the DOM without adding a history step or overwriting an inserted image's caret.
      this.focus();
    };
  }

  isComposing(): boolean {
    return this.find.composing || (this.currentMode === 'source' ? !!this.source?.composing : !!this.crepe && (this.richView().composing || isHtmlSourceComposing(this.options.richRoot)));
  }

  /** A blurred editor may retain its IME flag until the platform sends end. */
  hasFocusedComposition(): boolean {
    const focused = document.activeElement;
    if (focused && this.find.root.contains(focused)) return this.find.composing;
    const root = this.currentMode === 'source' ? this.options.sourceRoot : this.options.richRoot;
    if (!focused || !root.contains(focused)) return false;
    if (this.currentMode === 'source') return !!this.source?.composing;
    return isFocusedHtmlSource(this.options.richRoot) ? isHtmlSourceComposing(this.options.richRoot) : !!this.crepe && this.richView().composing;
  }

  getOutline(): { level: number; text: string; line: number }[] { return markdownOutline(this.getMarkdown()); }

  scrollToHeading(index: number): void {
    if (this.currentMode === 'source' && this.source) {
      const heading = this.getOutline()[index];
      if (!heading) return;
      const position = this.source.state.doc.line(Math.min(heading.line, this.source.state.doc.lines)).from;
      this.source.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start' }) });
      this.source.focus();
    } else {
      const heading = this.options.richRoot.querySelectorAll('h1,h2,h3,h4,h5,h6')[index];
      heading?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  format(action: string): void {
    if (this.isComposing()) return;
    if (this.currentMode === 'source') { this.formatSource(action); return; }
    if (!this.crepe) return;
    const view = this.richView();
    if (isFocusedHtmlSource(this.options.richRoot)) {
      if (action === 'undo') { richUndo(view.state, view.dispatch, view); this.notifyRichChange(); }
      else if (action === 'redo') { richRedo(view.state, view.dispatch, view); this.notifyRichChange(); }
      return;
    }
    const { schema } = view.state;
    const command = (fn: Command) => fn(view.state, view.dispatch, view);
    const syntax = ({ bold: 'strong', italic: 'em', strike: 'strike', code: 'code', 'inline-code': 'code', highlight: 'highlight' } as const)[action];
    if (syntax) toggleInlineSyntax(view, syntax);
    else if (nextHeadingLevel(action, 0) !== null) {
      const block = view.state.selection.$from.parent;
      const level = nextHeadingLevel(action, block.type === schema.nodes.heading ? Number(block.attrs.level) : 0)!;
      command(level ? setBlockType(schema.nodes.heading, { level }) : setBlockType(schema.nodes.paragraph));
    }
    else if (action === 'undo') command(richUndo);
    else if (action === 'redo') command(richRedo);
    else if (action === 'quote') command(wrapIn(schema.nodes.blockquote));
    else if (action === 'bullet' || action === 'unordered-list') command(wrapInList(schema.nodes.bullet_list));
    else if (action === 'ordered' || action === 'ordered-list') command(wrapInList(schema.nodes.ordered_list));
    else if (action === 'task') {
      command(wrapInList(schema.nodes.bullet_list));
      const { $from } = view.state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name === 'list_item') {
          view.dispatch(view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: node.attrs.checked == null ? false : null }));
          break;
        }
      }
    }
    else if (action === 'indent') command(sinkListItem(schema.nodes.list_item));
    else if (action === 'outdent') command(liftListItem(schema.nodes.list_item));
    else if (action === 'code-block' || action === 'codeblock') command(setBlockType(schema.nodes.code_block, { language: '' }));
    else if (action === 'table') this.crepe.editor.action((ctx) => ctx.get(commandsCtx).call(insertTableCommand.key, { row: 3, col: 3 }));
    else if (action === 'image') {
      const type = schema.nodes['image-block'];
      if (type) view.dispatch(view.state.tr.replaceSelectionWith(type.create({ src: '', alt: '' })).scrollIntoView());
    }
    else if (action === 'link') {
      const { from, to } = view.state.selection;
      const label = view.state.doc.textBetween(from, to) || '链接文字';
      const node = schema.text(label, [schema.marks.link.create({ href: 'https://example.com' })]);
      const transaction = view.state.tr.replaceSelectionWith(node, false);
      view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, from + label.length)));
    }
    view.focus();
    this.notifyRichChange();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.cancelRichTimer();
    for (const root of [this.options.richRoot, this.options.sourceRoot]) {
      root.removeEventListener('paste', this.handleImagePaste, { capture: true });
      root.removeEventListener('drop', this.handleImageDrop, { capture: true });
      root.removeEventListener('dragover', this.handleImageDragOver, { capture: true });
      root.removeEventListener('keydown', this.handleSearchShortcut, { capture: true });
    }
    this.find.destroy(); this.searchPainter.destroy();
    this.source?.destroy();
    await this.crepe?.destroy();
  }

  private richView(): RichView { return this.crepe!.editor.action((ctx) => ctx.get(editorViewCtx)); }

  private serializeRich(): string {
    return this.serializeRichDocument(this.richView().state.doc, this.richInput ?? this.raw, this.richOriginText);
  }

  private serializeRichDocument(document: RichNode, input: string, origin: string): string {
    // The previous save also covers removal of the last newly inserted <br>.
    const { body: previousBody, prefix } = splitFrontmatter(input);
    const serialized = preserveRenderedSource(previousBody, preserveTableSource(previousBody, this.inlineRaw!.serialize(() => this.crepe!.editor.action(ctx => ctx.get(serializerCtx)(document)))));
    const originBody = splitFrontmatter(origin).body;
    const body = preserveRenderedSource(originBody, preserveEmptyListSource(originBody, preserveTableSource(originBody, serialized)));
    const separator = prefix && prefix !== '\uFEFF' && !/[\r\n]$/.test(prefix) && body ? '\n\n' : '';
    return prefix + separator + body;
  }

  private replaceSearchMatches(matches: SearchMatch[], replacement: string): SearchReplaceResult {
    if (this.isComposing()) return { ok: false, message: '请先完成输入法组词。' };
    const before = this.getMarkdown(), changes = matches.map(match => ({ ...match, insert: replacement }));
    let next: string;
    try { next = applySourceChanges(before, changes); } catch (error) { return { ok: false, message: String(error) }; }
    if (next === before) return { ok: true };
    const problem = replacementProblem(before, next, changes); if (problem) return { ok: false, message: problem };
    const version = `replace-${++this.replacementVersion}`;
    if (this.currentMode === 'source' && this.source) {
      const state = this.source.state;
      if (!this.sourceExactSources.size) this.sourceExactSources.set(JSON.stringify(['', this.sourceOriginDocument]), this.sourceOriginText);
      this.sourceExactSources.set(JSON.stringify([state.field(sourceVersion), state.doc.toString()]), before);
      this.sourceExactSources.set(JSON.stringify([version, normalizedSource(next)]), next);
      this.source.dispatch({
        changes: changes.map(change => ({ from: normalizedOffset(before, change.from), to: normalizedOffset(before, change.to), insert: normalizedSource(change.insert) })),
        effects: setSourceVersion.of(version), annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.replace')],
      });
      return { ok: true };
    }
    if (!this.crepe) return { ok: false, message: '编辑器尚未就绪。' };
    const reason = detectUnsafeMarkdown(next); if (reason) return { ok: false, message: `${reason}。请在源码模式进行这次替换。` };
    const parts = splitFrontmatter(next);
    let parsed: RichNode;
    try {
      parsed = this.crepe.editor.action(ctx => ctx.get(parserCtx)(parts.body));
      if (!hasEquivalentMarkdownStructure(next, this.serializeRichDocument(parsed, next, next))) return { ok: false, message: '替换后的结构无法可靠显示，未执行。请在源码模式进行这次替换。' };
    } catch { return { ok: false, message: '替换后的结构无法可靠显示，未执行。' }; }
    const view = this.richView(), old = view.state.doc, oldVersion = String(old.attrs.croquillSourceVersion || '');
    if (!this.richExactSources.size && this.richOriginDocument) this.richExactSources.set(JSON.stringify(this.richOriginDocument.toJSON()), this.richOriginText);
    this.richExactSources.set(JSON.stringify(old.toJSON()), before);
    this.richContexts.set(oldVersion, { base: before, origin: this.richOriginDocument, originText: this.richOriginText, notice: this.richNotice });
    const suppressed = this.suppress; this.suppress = true; this.cancelRichTimer();
    try {
      view.dispatch(closeHistory(view.state.tr.replaceWith(0, old.content.size, parsed.content).setDocAttribute('croquillSourceVersion', version)));
      if (view.state.doc.attrs.croquillSourceVersion !== version) return { ok: false, message: '替换会破坏编辑结构，未执行。请检查替换内容。' };
      view.dispatch(closeHistory(view.state.tr));
      const document = view.state.doc;
      this.raw = next; this.richInput = next; this.richSnapshot = document; this.richOriginDocument = document; this.richOriginText = next; this.richContextVersion = version;
      this.richNotice = [parts.frontmatter ? '本文含元数据，可在源码模式中编辑' : '', preservedMarkdownBlocks(parts.body).length ? '部分语法以原文块保留，可在源码模式中编辑这些块' : ''].filter(Boolean).join('；') || null;
      this.richExactSources.set(JSON.stringify(document.toJSON()), next);
      this.richContexts.set(version, { base: next, origin: document, originText: next, notice: this.richNotice });
    } finally { this.suppress = suppressed; }
    this.publishChange(next); return { ok: true };
  }

  private async ensureRich(): Promise<void> {
    if (this.crepe && this.richInput === this.raw) {
      // Leaving and re-entering rich mode must not forget a failed round trip.
      if (this.unreliableRich === this.raw) this.safetyReason = UNRELIABLE_ROUND_TRIP;
      return;
    }
    this.unreliableRich = undefined;
    const oldSuppress = this.suppress;
    this.suppress = true;
    try {
      if (this.crepe) await this.crepe.destroy();
      this.options.richRoot.replaceChildren();
      this.richExactSources.clear(); this.richContexts.clear(); this.richContextVersion = '';
      const parts = splitFrontmatter(this.raw);
      const blocks = preservedMarkdownBlocks(parts.body);
      this.richNotice = [parts.frontmatter ? '本文含元数据，可在源码模式中编辑' : '', blocks.length ? '部分语法以原文块保留，可在源码模式中编辑这些块' : ''].filter(Boolean).join('；') || null;
      const crepe = new Crepe({
        root: this.options.richRoot,
        defaultValue: parts.body,
        features: {
          [Crepe.Feature.BlockEdit]: false,
          [Crepe.Feature.Toolbar]: false,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.AI]: false,
          [Crepe.Feature.Latex]: true,
        },
        featureConfigs: {
          [Crepe.Feature.Placeholder]: { text: '从这里开始写作…', mode: 'doc' },
          [Crepe.Feature.LinkTooltip]: {
            inputPlaceholder: '输入链接地址',
          },
          [Crepe.Feature.ImageBlock]: {
            inlineUploadButton: '选择图片', inlineConfirmButton: '确定',
            inlineUploadPlaceholderText: '输入图片地址或相对路径',
            blockUploadButton: '选择图片', blockConfirmButton: '确定',
            blockCaptionPlaceholderText: '图片说明', blockUploadPlaceholderText: '输入图片地址或相对路径',
            proxyDomURL: async (url: string) => this.options.resolveImage(url),
            onUpload: async (file: File) => (await this.options.uploadImage?.(file)) || '',
          },
          [Crepe.Feature.CodeMirror]: {
            theme: [syntaxHighlighting(classHighlighter), syntaxHighlighting(tagHighlighter([
              { tag: tags.bracket, class: 'tok-bracket' },
              { tag: tags.tagName, class: 'tok-tagName' },
              { tag: tags.attributeName, class: 'tok-attributeName' },
              { tag: [tags.standard(tags.variableName), tags.standard(tags.typeName)], class: 'tok-builtin' },
            ]))],
            searchPlaceholder: '搜索语言', noResultText: '未找到语言',
            copyText: '复制', previewLabel: '预览',
            previewLoading: '正在渲染…', previewOnlyByDefault: true,
            previewToggleText: (previewOnly) => previewOnly ? '编辑' : '收起源码',
          },
          [Crepe.Feature.Latex]: { inlineEditConfirm: '确定' },
        },
      });
      this.crepe = crepe;
      this.inlineRaw = createInlineRawMarkdown();
      crepe.editor.use(rawMarkdownBlock).use(htmlBlockPlugin({ resolveImage: this.options.resolveImage })).use(this.inlineRaw.node).use(this.inlineRaw.commentNode).use(alertBlock).use(highlightMark).use($prose(() => inlineSourcePlugin())).use(linkInputHandlers().map(rule => $inputRule(() => new InputRule(rule.match, rule.handler)))).use(tocBlock).use(tocFootnotePlugin).use(footnoteInputRule);
      crepe.editor.config(ctx => {
        configureHtmlBreaks(ctx);
        configureEmptyListItems(ctx);
        configureInlineSource(ctx);
        configureAlerts(ctx);
        configureTocFootnotes(ctx);
        ctx.update(remarkPluginsCtx, plugins => [
          { plugin: preserveRawMarkdown, options: {} },
          { plugin: parseHtmlComments, options: {} },
          { plugin: preserveInlineHtml, options: {} },
          { plugin: parseTocFootnotes, options: {} },
          { plugin: parseHtmlBreaks, options: {} },
          { plugin: flattenInlineSource, options: {} },
          { plugin: parseAlerts, options: {} }, ...plugins,
        ]);
      });
      // Crepe's block-only drop indicator also handles text selections, snapping
      // them to block boundaries. Keep ProseMirror's native inline/block drops.
      await crepe.editor.remove(dropIndicatorPlugin);
      // Inline formatting is source text here (src/inline-source.ts). The stock rules and
      // shortcuts would turn it back into marks.
      await crepe.editor.remove([strongInputRule, emphasisStarInputRule, emphasisUnderscoreInputRule, inlineCodeInputRule, strikethroughInputRule, strongKeymap, emphasisKeymap, inlineCodeKeymap, strikethroughKeymap].flat());
      // A source-only replacement (e.g. YAML or Markdown spelling) can leave
      // the rendered content identical. Keep its revision in native history.
      await crepe.editor.remove(docSchema);
      crepe.editor.use(ctx => {
        const run = docSchema(ctx);
        return async () => {
          const ready = run(); // $node registers its spec synchronously.
          ctx.update(nodesCtx, nodes => nodes.map(([name, spec]) => [name, name === 'doc' ? { ...spec, attrs: { ...spec.attrs, croquillSourceVersion: { default: '', validate: 'string' } } } : spec]));
          const cleanup = await ready;
          return async () => { await cleanup?.(); };
        };
      });
      // Root capture handlers own binary paste/drop, including cancellation. Disable
      // Crepe's fallback uploader so it cannot leave an upload placeholder behind.
      crepe.editor.config((ctx) => ctx.update(uploadConfig.key, (options) => ({ ...options, uploader: async () => [] })));
      crepe.editor.config((ctx) => ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options, bullet: '-' as const,
        join: [...(options.join || []), (left) => {
          if (left.type === 'html' && left.data && 'croquillRaw' in left.data && left.data.croquillRaw) {
            const tail = /[ \t\r\n]*$/.exec(left.value)![0];
            const newlines = (tail.match(/\r\n|\n|\r/g) || []).length;
            return Math.max(-1, 1 - newlines);
          }
        }],
      })));
      // Crepe encodes image-block resize ratios in Markdown alt text by default.
      // Ordinary .md files need their real alternative text retained instead.
      crepe.editor.config((ctx) => ctx.update(imageBlockSchema.key, (previous) => (innerCtx) => {
        const schema = previous(innerCtx);
        return {
          ...schema,
          attrs: { ...schema.attrs, alt: { default: '', validate: 'string' } },
          parseMarkdown: {
            ...schema.parseMarkdown,
            runner: (state, node, type) => {
              state.addNode(type, { src: String(node.url || ''), caption: String(node.title || ''), alt: String(node.alt || ''), ratio: 1 });
            },
          },
          toMarkdown: {
            ...schema.toMarkdown,
            runner: (state, node) => {
              state.openNode('paragraph');
              state.addNode('image', undefined, undefined, { title: node.attrs.caption || null, url: node.attrs.src, alt: node.attrs.alt });
              state.closeNode();
            },
          },
        };
      }));
      crepe.editor.use($prose(() => new Plugin({
        filterTransaction: transaction => {
          if (!transaction.docChanged || !hasUnsafeInlineTableContent(transaction.doc)) return true;
          this.options.onWarning?.('多行或含未转义竖线的原文片段不能放入表格，请在表格外粘贴。');
          return false;
        },
        props: {
          handleDOMEvents: { keydown: (view, event) => handleHtmlBlockKey(view, event) || handleTocFootnoteKey(view, event) || handleInlineRawKey(view, event) || handleHtmlBreakKey(view, event) || handleHeadingBackspace(view, event) || handleSourceEnter(view, event) || handleSourceArrow(view, event) },
          handleKeyDown: (view, event) => {
            if (event.isComposing || view.composing || !(event.ctrlKey || event.metaKey) || event.altKey) return false;
            const key = event.key.toLowerCase();
            const action = /^[1-6]$/.test(key) ? `heading${key}` : headingLevelShortcut(event) ?? (key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'k' ? 'link' : key === 'x' && event.shiftKey ? 'strike' : null);
            if (!action) return false;
            event.preventDefault();
            this.format(action);
            return true;
          },
          decorations(state) {
            const { $from } = state.selection;
            if (!$from.depth) return DecorationSet.empty;
            const node = $from.parent;
            const syntax = node.type.name === 'heading' ? '#'.repeat(Number(node.attrs.level)) : node.type.name === 'blockquote' ? '>' : '';
            return DecorationSet.create(state.doc, [Decoration.node($from.before(), $from.after(), { class: 'tx-active-block', 'data-syntax': syntax })]);
          },
        },
        view: () => ({ update: (view, previous) => {
          if (!view.state.doc.eq(previous.doc)) this.notifyRichChange();
        } }),
      })));
      await crepe.create();
      // Let the kernel initialize its trailing caret paragraph before recording
      // the origin, including after editable lists and tables. Otherwise undo
      // retains that later-added paragraph and cannot restore the original bytes.
      const readyView = this.richView();
      readyView.dispatch(readyView.state.tr.setMeta('addToHistory', false));
      this.richInput = this.raw;
      this.richSnapshot = this.richView().state.doc;
      this.richOriginDocument = this.richSnapshot;
      this.richOriginText = this.raw;
      if (!hasEquivalentMarkdownStructure(this.raw, this.serializeRich())) {
        this.safetyReason = UNRELIABLE_ROUND_TRIP; this.unreliableRich = this.raw;
      }
    } finally { this.suppress = oldSuppress; }
  }

  private cancelRichTimer(): void {
    if (this.richTimer !== undefined) clearTimeout(this.richTimer);
    this.richTimer = undefined;
  }

  private scheduleRichSerialization(): void {
    this.cancelRichTimer();
    this.richTimer = setTimeout(() => {
      this.richTimer = undefined;
      if (this.suppress || this.destroyed || this.currentMode !== 'rich') return;
      if (this.isComposing()) { this.scheduleRichSerialization(); return; }
      this.getMarkdown();
    }, 300);
  }

  /** Keep pending full-document work off an active wheel/scroll sequence. */
  deferPendingSerialization(): void {
    if (this.richTimer !== undefined) this.scheduleRichSerialization();
  }

  private notifyRichChange(): void {
    if (this.suppress || this.destroyed || this.currentMode !== 'rich') return;
    if (this.richSnapshot?.eq(this.richView().state.doc)) {
      if (this.richTimer !== undefined) {
        this.cancelRichTimer();
        this.publishChange(this.raw);
      }
      return;
    }
    const firstPendingChange = this.richTimer === undefined;
    this.scheduleRichSerialization();
    if (firstPendingChange) this.options.onDirty?.();
  }

  private ensureSource(): void {
    if (this.source && this.sourceInput === this.raw) return;
    this.sourceExactSources.clear();
    const extensions = [
      history(), lineNumbers(), highlightActiveLine(), drawSelection(),
      sourceVersion, sourceVersionHistory, sourceSearchHighlights,
      markdown(), syntaxHighlighting(defaultHighlightStyle), bracketMatching(), highlightSelectionMatches(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码编辑器', spellcheck: 'false' }),
      EditorState.phrases.of({
        'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个', 'all': '全部',
        'match case': '区分大小写', 'by word': '全词', 'regexp': '正则表达式',
        'replace': '替换', 'replace all': '全部替换', 'close': '关闭', 'No matches': '没有匹配结果',
        'Go to line': '跳转到行', 'go': '跳转',
      }),
      keymap.of([
        { key: 'Mod-b', run: () => { this.formatSource('bold'); return true; } },
        { key: 'Mod-i', run: () => { this.formatSource('italic'); return true; } },
        { key: 'Mod-k', run: () => { this.formatSource('link'); return true; } },
        { key: 'Mod-Shift-x', run: () => { this.formatSource('strike'); return true; } },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-${level}`, run: () => { this.formatSource(`heading${level}`); return true; } })),
        { key: 'Mod-0', run: () => { this.formatSource('paragraph'); return true; } },
        { key: 'Mod-=', run: () => { this.formatSource('heading-up'); return true; } },
        { key: 'Mod--', run: () => { this.formatSource('heading-down'); return true; } },
        ...defaultKeymap, ...historyKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        const versionChanged = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setSourceVersion)));
        if ((!update.docChanged && !versionChanged) || this.suppress || this.currentMode !== 'source') return;
        const text = update.state.doc.toString();
        const exact = this.sourceExactSources.get(JSON.stringify([update.state.field(sourceVersion), text]));
        if (exact !== undefined) this.raw = exact;
        else if (text === this.sourceOriginDocument) this.raw = this.sourceOriginText;
        else {
          const changes: SourceChange[] = [], previous = this.raw, newline = /\r\n|\r|\n/.exec(previous)?.[0] || '\n';
          update.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from: sourceOffset(previous, from), to: sourceOffset(previous, to), insert: inserted.toString().replace(/\n/g, newline) }));
          this.raw = applySourceChanges(previous, changes);
        }
        this.sourceInput = this.raw;
        this.safetyReason = detectUnsafeMarkdown(this.raw);
        this.sourceUpdating = true;
        try { this.publishChange(this.raw); } finally { this.sourceUpdating = false; }
      }),
    ];
    const state = EditorState.create({ doc: this.raw, extensions });
    if (this.source) this.source.setState(state);
    else this.source = new EditorView({ state, parent: this.options.sourceRoot });
    this.sourceInput = this.raw;
    this.sourceOriginDocument = state.doc.toString();
    this.sourceOriginText = this.raw;
  }

  private formatSource(action: string): void {
    const view = this.source;
    if (!view || view.composing) return;
    if (action === 'undo') { undo(view); return; }
    if (action === 'redo') { redo(view); return; }
    const range = view.state.selection.main;
    const selected = view.state.sliceDoc(range.from, range.to);
    const wrappers: Record<string, [string, string, string]> = {
      bold: ['**', '**', '加粗文字'], italic: ['*', '*', '斜体文字'], strike: ['~~', '~~', '删除线文字'],
      code: ['`', '`', '代码'], 'inline-code': ['`', '`', '代码'],
      link: ['[', '](https://example.com)', '链接文字'],
      image: ['![', '](图片.png)', '图片说明'],
      'code-block': ['\n```text\n', '\n```\n', '代码'], codeblock: ['\n```text\n', '\n```\n', '代码'],
    };
    if (wrappers[action]) {
      const [prefix, suffix, fallback] = wrappers[action];
      const content = selected || fallback;
      view.dispatch({ changes: { from: range.from, to: range.to, insert: prefix + content + suffix }, selection: EditorSelection.range(range.from + prefix.length, range.from + prefix.length + content.length), userEvent: 'input' });
    } else if (action === 'table') {
      view.dispatch({ changes: { from: range.from, to: range.to, insert: '\n| 标题一 | 标题二 | 标题三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n' }, userEvent: 'input' });
    } else if (nextHeadingLevel(action, 0) !== null) {
      // Rewrite only each line's ATX prefix, so the rest of the line keeps its bytes.
      const changes: { from: number; to: number; insert: string }[] = [];
      const first = view.state.doc.lineAt(range.from).number, last = view.state.doc.lineAt(range.to).number;
      for (let number = first; number <= last; number++) {
        const line = view.state.doc.line(number), change = sourceHeadingChange(line.text, action);
        if (change) changes.push({ from: line.from + change.from, to: line.from + change.to, insert: change.insert });
      }
      if (changes.length) view.dispatch({ changes, userEvent: 'input' });
    } else {
      const prefix =
        action === 'quote' ? '> ' : action === 'bullet' || action === 'unordered-list' ? '- ' :
        action === 'ordered' || action === 'ordered-list' ? '1. ' : action === 'task' ? '- [ ] ' : null;
      if (prefix !== null) {
        const from = view.state.doc.lineAt(range.from).from;
        const to = view.state.doc.lineAt(range.to).to;
        const insert = view.state.sliceDoc(from, to).split('\n').map((line) => prefix + line).join('\n');
        view.dispatch({ changes: { from, to, insert }, userEvent: 'input' });
      }
    }
    view.focus();
  }

  private applyVisibility(): void {
    this.options.richRoot.hidden = this.currentMode !== 'rich';
    this.options.sourceRoot.hidden = this.currentMode !== 'source';
  }
}
