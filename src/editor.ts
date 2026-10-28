import { Crepe } from '@milkdown/crepe';
import { commandsCtx, editorViewCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { insertTableCommand } from '@milkdown/kit/preset/gfm';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, TextSelection, type Command } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView as RichView } from '@milkdown/kit/prose/view';
import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands';
import { wrapInList, liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import { undo as richUndo, redo as richRedo } from '@milkdown/kit/prose/history';
import type { Node as RichNode } from '@milkdown/kit/prose/model';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { classHighlighter, tagHighlighter, tags } from '@lezer/highlight';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { detectUnsafeMarkdown, hasEquivalentMarkdownStructure, markdownOutline } from './fidelity';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

export type EditingMode = 'rich' | 'source';
export interface MarkdownSurfaceOptions {
  richRoot: HTMLElement;
  sourceRoot: HTMLElement;
  onChange: (markdown: string) => void;
  resolveImage: (src: string) => Promise<string>;
}

/** Two mature editing surfaces, with the unmodified Markdown kept independently. */
export class MarkdownSurface {
  private crepe?: Crepe;
  private source?: EditorView;
  private raw = '';
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
  private richPending = false;
  private destroyed = false;

  constructor(private readonly options: MarkdownSurfaceOptions) {}

  get mode(): EditingMode { return this.currentMode; }
  getSafetyReason(): string | null { return this.safetyReason; }

  async init(markdownText: string): Promise<void> { await this.load(markdownText); }

  async load(markdownText: string): Promise<void> {
    this.suppress = true;
    this.raw = markdownText;
    this.richInput = undefined;
    this.sourceInput = undefined;
    this.richSnapshot = undefined;
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
  }

  async setMode(mode: EditingMode): Promise<void> {
    if (this.isComposing()) return;
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
  }

  /** Flush synchronously, so Ctrl+S immediately after a keystroke saves that keystroke. */
  getMarkdown(): string {
    if (!this.suppress && this.currentMode === 'rich' && this.crepe && this.richSnapshot) {
      const document = this.richView().state.doc;
      if (!document.eq(this.richSnapshot)) {
        this.raw = this.richOriginDocument?.eq(document) ? this.richOriginText : this.crepe.getMarkdown();
        this.richSnapshot = document;
        this.richInput = this.raw;
      }
    }
    return this.raw;
  }

  focus(): void {
    if (this.currentMode === 'source') this.source?.focus();
    else if (this.crepe) this.richView().focus();
  }

  isComposing(): boolean {
    return this.currentMode === 'source' ? !!this.source?.composing : !!this.crepe && this.richView().composing;
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
    const { schema } = view.state;
    const command = (fn: Command) => fn(view.state, view.dispatch, view);
    const markNames: Record<string, string[]> = {
      bold: ['strong'], italic: ['emphasis', 'em'], strike: ['strike_through', 'strikethrough'],
      code: ['inlineCode', 'code'], 'inline-code': ['inlineCode', 'code'],
    };
    if (markNames[action]) {
      const mark = markNames[action].map((name) => schema.marks[name]).find(Boolean);
      if (mark) command(toggleMark(mark));
    } else if (/^(?:h|heading-?)[1-6]$/.test(action)) {
      command(setBlockType(schema.nodes.heading, { level: Number(action.at(-1)) }));
    } else if (action === 'paragraph') command(setBlockType(schema.nodes.paragraph));
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
    this.source?.destroy();
    await this.crepe?.destroy();
  }

  private richView(): RichView { return this.crepe!.editor.action((ctx) => ctx.get(editorViewCtx)); }

  private async ensureRich(): Promise<void> {
    if (this.crepe && this.richInput === this.raw) return;
    const oldSuppress = this.suppress;
    this.suppress = true;
    try {
      if (this.crepe) await this.crepe.destroy();
      this.options.richRoot.replaceChildren();
      const crepe = new Crepe({
        root: this.options.richRoot,
        defaultValue: this.raw,
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
            onUpload: async (file: File) => {
              // Embedded images remain portable across reopen and Save As.
              return new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error('读取图片失败'));
                reader.readAsDataURL(file);
              });
            },
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
      crepe.editor.config((ctx) => ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: '-' as const })));
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
        props: {
          handleKeyDown: (view, event) => {
            if (event.isComposing || view.composing || !(event.ctrlKey || event.metaKey) || event.altKey) return false;
            const key = event.key.toLowerCase();
            const action = /^[1-6]$/.test(key) ? `heading${key}` : key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'k' ? 'link' : key === 'x' && event.shiftKey ? 'strike' : null;
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
      this.richInput = this.raw;
      this.richSnapshot = this.richView().state.doc;
      this.richOriginDocument = this.richSnapshot;
      this.richOriginText = this.raw;
      if (!hasEquivalentMarkdownStructure(this.raw, crepe.getMarkdown())) {
        this.safetyReason = '此文档的部分结构无法可靠往返转换，已保留原文并启用源码保护';
      }
    } finally { this.suppress = oldSuppress; }
  }

  private notifyRichChange(): void {
    if (this.suppress || this.destroyed || this.currentMode !== 'rich' || this.richPending) return;
    this.richPending = true;
    queueMicrotask(() => {
      this.richPending = false;
      if (!this.suppress && !this.destroyed && this.currentMode === 'rich') this.options.onChange(this.getMarkdown());
    });
  }

  private ensureSource(): void {
    if (this.source && this.sourceInput === this.raw) return;
    const extensions = [
      history(), lineNumbers(), highlightActiveLine(), drawSelection(),
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
        ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || this.suppress || this.currentMode !== 'source') return;
        const text = update.state.doc.toString();
        this.raw = text === this.sourceOriginDocument ? this.sourceOriginText : text;
        this.sourceInput = this.raw;
        this.safetyReason = detectUnsafeMarkdown(this.raw);
        this.options.onChange(this.raw);
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
    } else {
      const prefix = /^(?:h|heading-?)[1-6]$/.test(action) ? '#'.repeat(Number(action.at(-1))) + ' ' :
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
