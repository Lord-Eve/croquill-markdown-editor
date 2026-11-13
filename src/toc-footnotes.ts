import type { Ctx } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { footnoteDefinitionSchema, footnoteReferenceSchema } from '@milkdown/kit/preset/gfm';
import { Fragment, type Node as RichNode } from '@milkdown/kit/prose/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import type { Root } from '@milkdown/kit/transformer';
import { $inputRule, $node, $prose } from '@milkdown/kit/utils';
import type { Handle } from 'mdast-util-to-markdown';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { normalizeFootnoteLabel, tocMarkerOf, type DocumentSyntaxNode } from './document-syntax';
import { literalFootnotes } from './footnote-literals';
import { blockSpans, visibleText } from './inline-source-view';
import './toc-footnotes.css';

/** The existing remark definition owns every paragraph, list and code block. */
export function parseTocFootnotes() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? '');
    function visit(node: DocumentSyntaxNode): void {
      const marker = tocMarkerOf(node, source);
      if (marker) { node.type = 'croquillToc'; node.value = marker; delete node.children; return; }
      if (node.type === 'footnoteReference') {
        const from = node.position?.start.offset, to = node.position?.end.offset;
        node.data = { ...node.data, croquillFootnoteRaw: from != null && to != null ? source.slice(from, to) : `[^${node.label || node.identifier}]` };
      }
      if (node.type === 'footnoteDefinition') {
        const from = node.position?.start.offset;
        const prefix = from == null ? '' : /^\[\^(?:\\.|[^\]\\\r\n])+\]:[ \t]*/.exec(source.slice(from))?.[0] || '';
        node.data = { ...node.data, croquillFootnotePrefix: prefix };
      }
      if (['code', 'inlineCode', 'html', 'math', 'inlineMath', 'croquillRawBlock', 'croquillInlineRaw', 'croquillHtmlComment'].includes(node.type)) return;
      node.children = node.children?.flatMap(child => {
        const ranges = literalFootnotes(child, source);
        if (!ranges.length) { visit(child); return [child]; }
        const parts: DocumentSyntaxNode[] = []; let index = 0, rawStart = child.position!.start.offset!;
        for (const range of ranges) {
          if (range.index > index) parts.push({ type: 'text', value: child.value!.slice(index, range.index), position: { start: { offset: rawStart }, end: { offset: range.from } } });
          parts.push({ type: 'footnoteReference', identifier: normalizeFootnoteLabel(range.label), label: range.label,
            data: { croquillFootnoteRaw: range.raw }, position: { start: { offset: range.from }, end: { offset: range.to } } });
          index = range.endIndex; rawStart = range.to;
        }
        if (index < child.value!.length) parts.push({ type: 'text', value: child.value!.slice(index), position: { start: { offset: rawStart }, end: { offset: child.position!.end.offset } } });
        return parts;
      });
    }
    visit(tree as unknown as DocumentSyntaxNode);
    return tree;
  };
}

export const tocBlock = $node('croquill_toc', () => ({
  group: 'block', atom: true, selectable: true,
  attrs: { value: { default: '[TOC]', validate: 'string' } },
  toDOM: node => ['nav', { 'data-croquill-toc': String(node.attrs.value), contenteditable: 'false', 'aria-label': '文章目录' }, String(node.attrs.value)],
  parseDOM: [{ tag: 'nav[data-croquill-toc]', getAttrs: dom => ({ value: dom.getAttribute('data-croquill-toc') || '[TOC]' }) }],
  leafText: node => String(node.attrs.value),
  parseMarkdown: { match: node => node.type === 'croquillToc', runner: (state, node, type) => { state.addNode(type, { value: String(node.value) }); } },
  toMarkdown: { match: node => node.type.name === 'croquill_toc', runner: (state, node) => { state.addNode('html', undefined, String(node.attrs.value)); } },
}));

export const footnoteInputRule = $inputRule(ctx => new InputRule(/(?<!\\)\[\^([^\[\]\\\r\n]+)\]$/, (state, match, start, end) => {
  if (!match[1].trim()) return null;
  // Inline code is source text now: a marker typed between its backticks stays literal.
  const $start = state.doc.resolve(start), offset = $start.parentOffset;
  if (blockSpans($start.parent).some(span => span.kind === 'code' && span.innerFrom <= offset && offset <= span.innerTo)) return null;
  return state.tr.replaceWith(start, end, footnoteReferenceSchema.type(ctx).create({ label: match[1], identifier: normalizeFootnoteLabel(match[1]), raw: match[0] }));
}));

const writeDefinition: Handle = (node, _parent, state, info) => {
  const definition = node as unknown as DocumentSyntaxNode;
  const savedPrefix = String(definition.data?.croquillFootnotePrefix || '');
  const marker = savedPrefix || `[^${definition.label || definition.identifier}]: `;
  const prefix = /[ \t]$/.test(marker) ? marker : marker + ' ';
  const exit = state.enter('footnoteDefinition');
  const tracker = state.createTracker(info); tracker.move(prefix); tracker.shift(4);
  const body = state.containerFlow(node as Parameters<typeof state.containerFlow>[0], tracker.current());
  const result = body ? prefix + state.indentLines(body, (line, index, blank) => index === 0 || blank ? line : '    ' + line) : marker.trimEnd();
  exit(); return result;
};

export function configureTocFootnotes(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, options => ({ ...options, handlers: { ...options.handlers, footnoteDefinition: writeDefinition } }));
  ctx.update(footnoteReferenceSchema.key, previous => innerCtx => ({
    ...previous(innerCtx),
    attrs: { label: { default: '', validate: 'string' }, identifier: { default: '', validate: 'string' }, raw: { default: '', validate: 'string' } },
    toDOM: node => ['sup', { 'data-footnote-reference': String(node.attrs.identifier), 'data-label': String(node.attrs.label), 'data-footnote-raw': JSON.stringify(node.attrs.raw), contenteditable: 'false' }, String(node.attrs.label)],
    parseDOM: [{ tag: 'sup[data-footnote-reference]', priority: 100, getAttrs: dom => {
      const label = dom.getAttribute('data-label') || dom.textContent || '';
      let raw = `[^${label}]`;
      try { const value: unknown = JSON.parse(dom.getAttribute('data-footnote-raw') || 'null'); if (typeof value === 'string') raw = value; } catch { /* Use the visible label for ordinary clipboard HTML. */ }
      return { label, identifier: dom.getAttribute('data-footnote-reference') || normalizeFootnoteLabel(label), raw };
    } }],
    leafText: node => String(node.attrs.raw || `[^${node.attrs.label}]`),
    parseMarkdown: { match: node => node.type === 'footnoteReference', runner: (state, node, type) => {
      state.addNode(type, { label: String(node.label || node.identifier), identifier: String(node.identifier || normalizeFootnoteLabel(String(node.label))), raw: String((node.data as Record<string, unknown> | undefined)?.croquillFootnoteRaw || `[^${node.label || node.identifier}]`) });
    } },
    toMarkdown: { match: node => node.type.name === 'footnote_reference', runner: (state, node) => { state.addNode('html', undefined, String(node.attrs.raw || `[^${node.attrs.label}]`)); } },
  }));
  ctx.update(footnoteDefinitionSchema.key, previous => innerCtx => ({
    ...previous(innerCtx), isolating: true,
    attrs: { label: { default: '', validate: 'string' }, identifier: { default: '', validate: 'string' }, prefix: { default: '', validate: 'string' } },
    toDOM: node => ['dl', { 'data-footnote-definition': String(node.attrs.identifier), 'data-type': 'footnote_definition', 'data-label': String(node.attrs.label), 'data-footnote-prefix': JSON.stringify(node.attrs.prefix) },
      ['dt', { contenteditable: 'false' }, String(node.attrs.label)], ['dd', 0]],
    parseDOM: [{ tag: 'dl[data-footnote-definition]', priority: 100, contentElement: 'dd', getAttrs: dom => {
      const label = dom.getAttribute('data-label') || '';
      let prefix = '';
      try { const value: unknown = JSON.parse(dom.getAttribute('data-footnote-prefix') || 'null'); if (typeof value === 'string') prefix = value; } catch { /* Ordinary copied definitions use the canonical marker. */ }
      return { label, identifier: dom.getAttribute('data-footnote-definition') || normalizeFootnoteLabel(label), prefix };
    } }],
    parseMarkdown: { match: node => node.type === 'footnoteDefinition', runner: (state, node, type) => {
      state.openNode(type, { label: String(node.label || node.identifier), identifier: String(node.identifier || normalizeFootnoteLabel(String(node.label))), prefix: String((node.data as Record<string, unknown> | undefined)?.croquillFootnotePrefix || '') });
      if (node.children?.length) state.next(node.children); else state.openNode(state.schema.nodes.paragraph).closeNode();
      state.closeNode();
    } },
    toMarkdown: { match: node => node.type.name === 'footnote_definition', runner: (state, node) => {
      state.openNode('footnoteDefinition', undefined, { label: String(node.attrs.label), identifier: String(node.attrs.identifier), data: { croquillFootnotePrefix: String(node.attrs.prefix) } });
      if (!(node.childCount === 1 && node.firstChild?.type.name === 'paragraph' && !node.firstChild.content.size)) state.next(node.content);
      state.closeNode();
    } },
  }));
}

/** Convert only a plain marker paragraph, keeping IME Enter native. */
export function handleTocFootnoteKey(view: EditorView, event: KeyboardEvent): boolean {
  const { selection, schema, tr } = view.state;
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && selection.empty && selection.$from.parent.type.name === 'paragraph' && /^\[toc\]$/i.test(selection.$from.parent.textContent.trim())) {
    const paragraph = selection.$from.parent;
    if (!Array.from({ length: paragraph.childCount }, (_, index) => paragraph.child(index)).every(node => node.isText && !node.marks.length)) return false;
    if (event.isComposing || view.composing) return true;
    const from = selection.$from.before(), to = selection.$from.after();
    const replacement = Fragment.fromArray([schema.nodes.croquill_toc.create({ value: paragraph.textContent.trim() }), schema.nodes.paragraph.create()]);
    const parent = selection.$from.node(selection.$from.depth - 1), index = selection.$from.index(selection.$from.depth - 1);
    if (!parent.canReplace(index, index + 1, replacement)) return false;
    event.preventDefault(); tr.replaceWith(from, to, replacement);
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2))).scrollIntoView()); return true;
  }
  if (!['Backspace', 'Delete'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return false;
  const selected = selection instanceof NodeSelection && selection.node.type.name === 'footnote_reference';
  if (!selected && !selection.empty) return false;
  const adjacent = event.key === 'Backspace' ? selection.$from.nodeBefore : selection.$from.nodeAfter;
  if (!selected && adjacent?.type.name !== 'footnote_reference') return false;
  if (event.isComposing || view.composing) return true;
  event.preventDefault();
  view.dispatch(selected ? tr.deleteSelection() : event.key === 'Backspace' ? tr.delete(selection.from - 1, selection.from) : tr.delete(selection.from, selection.from + 1)); return true;
}

interface HeadingTarget { pos: number; level: number; text: string }
interface DefinitionTarget { pos: number; text: string }
interface DocumentIndex { headings: HeadingTarget[]; definitions: Map<string, DefinitionTarget> }
const indexKey = new PluginKey<DocumentIndex>('croquill-document-index');
const rawParser = unified().use(remarkParse).use(remarkGfm);
const rawIndexes = new WeakMap<RichNode, { headings: Omit<HeadingTarget, 'pos'>[]; definitions: { label: string; text: string }[] }>();
function syntaxText(node: DocumentSyntaxNode): string { return node.value || node.children?.map(syntaxText).join('') || ''; }
function indexOf(doc: RichNode): DocumentIndex {
  const headings: HeadingTarget[] = [], definitions = new Map<string, DefinitionTarget>();
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') headings.push({ pos, level: Number(node.attrs.level), text: visibleText(node.textContent) });
    if (node.type.name === 'footnote_definition') {
      const label = normalizeFootnoteLabel(String(node.attrs.identifier || node.attrs.label));
      if (!definitions.has(label)) definitions.set(label, { pos, text: visibleText(node.textBetween(0, node.content.size, '\n\n')) });
    }
    if (node.type.name === 'croquill_raw_block') {
      if (!rawIndexes.has(node)) {
        const index = { headings: [] as Omit<HeadingTarget, 'pos'>[], definitions: [] as { label: string; text: string }[] };
        function visit(child: DocumentSyntaxNode): void {
          if (child.type === 'heading') index.headings.push({ level: child.depth || 1, text: syntaxText(child) });
          if (child.type === 'footnoteDefinition') index.definitions.push({ label: normalizeFootnoteLabel(child.identifier || child.label || ''), text: child.children?.map(syntaxText).join('\n\n') || '' });
          child.children?.forEach(visit);
        }
        visit(rawParser.parse(String(node.attrs.value)) as unknown as DocumentSyntaxNode); rawIndexes.set(node, index);
      }
      const index = rawIndexes.get(node)!;
      index.headings.forEach(heading => headings.push({ ...heading, pos }));
      index.definitions.forEach(definition => { if (!definitions.has(definition.label)) definitions.set(definition.label, { pos, text: definition.text }); });
    }
    return true;
  });
  return { headings, definitions };
}

function jumpTo(view: EditorView, position: number): void {
  if (view.composing) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(position + 1, view.state.doc.content.size)))).scrollIntoView());
  const dom = view.nodeDOM(position); if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start' });
  view.focus();
}

/** UI-only indexes do not serialize Markdown or put generated text in the document. */
export const tocFootnotePlugin = $prose(() => {
  const live = new Set<{ refresh: () => void }>();
  let hidePreview = () => {};
  return new Plugin<DocumentIndex>({
    key: indexKey,
    state: { init: (_config, state) => indexOf(state.doc), apply: (transaction, previous) => transaction.docChanged ? indexOf(transaction.doc) : previous },
    props: {
      nodeViews: {
        croquill_toc(node, view) {
          const dom = document.createElement('nav'); dom.dataset.croquillToc = String(node.attrs.value); dom.contentEditable = 'false'; dom.setAttribute('aria-label', '文章目录');
          let signature = '';
          const instance = { refresh: () => {
            const headings = indexKey.getState(view.state)?.headings || [];
            const next = JSON.stringify(headings.map(({ level, text }) => ({ level, text })));
            if (next === signature) return; signature = next;
            const fragment = document.createDocumentFragment();
            headings.forEach((heading, index) => {
              const button = document.createElement('button'); button.type = 'button'; button.textContent = heading.text || '（空标题）'; button.dataset.level = String(heading.level); button.style.setProperty('--toc-level', String(heading.level));
              button.onmousedown = event => { if (view.composing) event.preventDefault(); };
              button.onclick = event => { event.preventDefault(); hidePreview(); const target = indexKey.getState(view.state)?.headings[index]; if (target) jumpTo(view, target.pos); };
              fragment.append(button);
            });
            if (!headings.length) { const empty = document.createElement('span'); empty.textContent = '暂无标题'; fragment.append(empty); }
            dom.replaceChildren(fragment);
          } };
          live.add(instance); instance.refresh();
          return { dom, ignoreMutation: () => true, stopEvent: () => true, destroy: () => { live.delete(instance); } } satisfies NodeView;
        },
        footnote_reference(node, view) {
          const dom = document.createElement('sup'); dom.contentEditable = 'false';
          const identifier = normalizeFootnoteLabel(String(node.attrs.identifier || node.attrs.label));
          dom.dataset.footnoteReference = identifier; dom.dataset.label = String(node.attrs.label); dom.dataset.footnoteRaw = JSON.stringify(node.attrs.raw);
          let resolved: boolean | undefined;
          const instance = { refresh: () => {
            const defined = !!indexKey.getState(view.state)?.definitions.has(identifier);
            const text = defined ? String(node.attrs.label) : String(node.attrs.raw || `[^${node.attrs.label}]`);
            if (dom.textContent !== text) dom.textContent = text;
            if (defined === resolved) return;
            resolved = defined;
            if (defined) { delete dom.dataset.footnoteOrphan; dom.tabIndex = 0; dom.setAttribute('role', 'link'); dom.setAttribute('aria-label', `脚注 ${node.attrs.label}，跳转到定义`); }
            else { dom.dataset.footnoteOrphan = ''; dom.tabIndex = -1; dom.removeAttribute('role'); dom.setAttribute('aria-label', '未定义脚注'); }
          } };
          live.add(instance); instance.refresh();
          // Own the whole pointer gesture on a defined reference. If the press reaches the
          // editor root, the table block schedules "select this body cell" for the next
          // frame, which lands after the click and undoes the jump.
          const definition = () => indexKey.getState(view.state)?.definitions.get(identifier);
          for (const type of ['pointerdown', 'mousedown'] as const) dom.addEventListener(type, event => {
            if (!definition()) return;
            event.stopPropagation(); if (type === 'mousedown') event.preventDefault();
          });
          dom.addEventListener('click', event => {
            const target = definition();
            if (!target) return;
            event.preventDefault(); event.stopPropagation(); hidePreview(); jumpTo(view, target.pos);
          });
          return { dom, ignoreMutation: () => true, destroy: () => { live.delete(instance); } } satisfies NodeView;
        },
      },
      handleKeyDown(view, event) {
        if (event.isComposing || view.composing || !['Enter', ' '].includes(event.key)) return false;
        const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-footnote-reference]') : null;
        const target = element && indexKey.getState(view.state)?.definitions.get(element.dataset.footnoteReference || '');
        if (!target) return false; event.preventDefault(); hidePreview(); jumpTo(view, target.pos); return true;
      },
    },
    view(view) {
      const tooltip = document.createElement('div'); tooltip.dataset.footnoteTooltip = ''; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true; view.dom.parentElement!.append(tooltip);
      let hovered: HTMLElement | null = null;
      const hide = () => { hovered = null; tooltip.hidden = true; };
      hidePreview = hide;
      const show = (element: HTMLElement) => {
        const definition = indexKey.getState(view.state)?.definitions.get(element.dataset.footnoteReference || '');
        if (!definition) { hide(); return; }
        hovered = element; tooltip.textContent = definition.text || '（空脚注）'; tooltip.hidden = false;
        const rect = element.getBoundingClientRect();
        tooltip.style.left = Math.max(6, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 6)) + 'px';
        tooltip.style.top = Math.max(6, rect.bottom + tooltip.offsetHeight + 8 <= window.innerHeight ? rect.bottom + 6 : rect.top - tooltip.offsetHeight - 6) + 'px';
      };
      const enter = (event: Event) => { const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-footnote-reference]') : null; if (element) show(element); };
      const leave = (event: Event) => { if (hovered && !(event instanceof MouseEvent && event.relatedTarget instanceof Node && hovered.contains(event.relatedTarget))) hide(); };
      view.dom.addEventListener('mouseover', enter); view.dom.addEventListener('focusin', enter); view.dom.addEventListener('mouseout', leave); view.dom.addEventListener('focusout', leave);
      return {
        update(current, previous) { if (current.state.doc === previous.doc) return; live.forEach(instance => instance.refresh()); if (hovered?.isConnected) show(hovered); else hide(); },
        destroy() { view.dom.removeEventListener('mouseover', enter); view.dom.removeEventListener('focusin', enter); view.dom.removeEventListener('mouseout', leave); view.dom.removeEventListener('focusout', leave); tooltip.remove(); live.clear(); },
      };
    },
  });
});
