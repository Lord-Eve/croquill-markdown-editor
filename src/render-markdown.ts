import katex from 'katex';
import { DOMSerializer } from '@milkdown/kit/prose/model';
import { alertTitle, type AlertType } from './alerts';
import { parsePositionedRichMarkdown } from './rich-markdown';
import { splitFrontmatter } from './fidelity';
import { allocateIds, customHeadingId, headingId } from './heading-anchors';
import { headingAttributes, INLINE_OBJECT, inlineSyntaxSpans, type InlineSpan } from './inline-source';
import { inlineHtmlStyle, sanitizeHtmlFragment } from './html-sanitize';
import { parseMarkdownAst } from './markdown-ast';
import type { Nodes } from 'mdast';
import { isHtmlComment } from './html-comments';

interface Block {
  type: string; value?: string; children?: Block[]; depth?: number; kind?: string;
  position?: { start: { offset?: number } };
  lang?: string; alertType?: AlertType; url?: string; title?: string; alt?: string;
  checked?: boolean; ordered?: boolean; start?: number; align?: (string | null)[];
  identifier?: string; label?: string; data?: Record<string, unknown>;
}

export interface ReferenceDefinition {
  label: string;
  url: string;
  title?: string | null;
}

export interface ReferenceDefinitions {
  map: ReadonlyMap<string, ReferenceDefinition>;
  /** Compact GFM definition lines built once from the full document for resolving `[text][id]` in partial renders. */
  block: string;
}

const EMPTY_REFERENCE_DEFINITIONS: ReferenceDefinitions = { map: new Map(), block: '' };

function indexReferenceDefinitions(node: Nodes, target: Map<string, ReferenceDefinition>): void {
  if (node.type === 'definition' && !target.has(node.identifier)) {
    target.set(node.identifier, { label: node.label || node.identifier, url: node.url, title: node.title });
  }
  if ('children' in node) node.children.forEach(child => indexReferenceDefinitions(child, target));
}

function formatDefinitionLine(def: ReferenceDefinition): string {
  const label = def.label.replace(/[\r\n]+/g, ' ').replace(/([\\[\]])/g, '\\$1');
  const url = `<${def.url.replace(/[<>\\\r\n]/g, ch => encodeURIComponent(ch))}>`;
  const title = def.title ? ` "${def.title.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"` : '';
  return `[${label}]: ${url}${title}`;
}

/** Collect link/image reference definitions from a Markdown document once for reuse across partial renders. */
export function collectReferenceDefinitions(markdown: string): ReferenceDefinitions {
  if (!markdown.includes(']:')) return EMPTY_REFERENCE_DEFINITIONS;
  const map = new Map<string, ReferenceDefinition>();
  indexReferenceDefinitions(parseMarkdownAst(splitFrontmatter(markdown).body), map);
  if (!map.size) return EMPTY_REFERENCE_DEFINITIONS;
  const lines: string[] = [];
  for (const def of map.values()) lines.push(formatDefinitionLine(def));
  return { map, block: lines.join('\n') };
}

export interface RenderMarkdownOptions {
  /** Synchronous light-mode HTML suitable for pasting into external rich text apps. */
  forCopy?: boolean;
  /** Pre-collected link/image reference definitions shared across blocks and table cells in one copy operation. */
  referenceDefinitions?: ReferenceDefinitions;
  /** Optional full-document Markdown used to resolve link/image reference definitions in partial copies. */
  referenceSource?: string;
  /** Optional code syntax highlighter callback (used asynchronously by export). */
  highlightCode?: (lang: string, value: string, code: HTMLElement) => void;
}

const ALERT_COLORS: Record<AlertType, string> = {
  NOTE: '#0969da',
  TIP: '#1a7f37',
  IMPORTANT: '#8250df',
  WARNING: '#9a6700',
  CAUTION: '#d1242f',
};

const ALERT_TITLES: Record<AlertType, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

const CODE_FONT = "'Cascadia Code', Consolas, monospace";

/** Apply light-theme inline styles required when pasting into Word, WeChat, or mail clients. */
export function applyClipboardStyles(container: HTMLElement): void {
  for (const pre of container.querySelectorAll<HTMLElement>('pre')) {
    pre.setAttribute('style', `font-family: ${CODE_FONT}; font-size: 0.9em; padding: 8px 12px; background-color: #f8f8f8; border: 1px solid #e7eaed; border-radius: 3px; color: #333333; white-space: pre-wrap;`);
    for (const nested of pre.querySelectorAll<HTMLElement>('code')) {
      nested.setAttribute('style', `font-family: ${CODE_FONT}; background-color: transparent; padding: 0; border: 0; color: inherit; font-size: inherit;`);
    }
  }
  for (const code of container.querySelectorAll<HTMLElement>('code, kbd')) {
    if (code.closest('pre')) continue;
    code.setAttribute('style', `font-family: ${CODE_FONT}; font-size: 0.88em; padding: 0.14em 0.35em; background-color: #f7f7f7; border: 1px solid #e8e9eb; border-radius: 3px; color: #333333;`);
  }
  for (const mark of container.querySelectorAll<HTMLElement>('mark')) {
    mark.setAttribute('style', 'background-color: #fff3a3; color: #333333;');
  }
  const tables = container.tagName === 'TABLE'
    ? [container, ...Array.from(container.querySelectorAll<HTMLElement>('table'))]
    : Array.from(container.querySelectorAll<HTMLElement>('table'));
  for (const table of tables) {
    table.setAttribute('style', 'border-collapse: collapse; width: 100%;');
  }
  for (const th of container.querySelectorAll<HTMLElement>('th')) {
    const align = th.style.textAlign;
    th.setAttribute('style', `border: 1px solid #dfe2e5; padding: 6px 13px; font-weight: 700; background-color: #f8f8f8; color: #333333;${align ? ` text-align: ${align};` : ''}`);
  }
  for (const td of container.querySelectorAll<HTMLElement>('td')) {
    const align = td.style.textAlign;
    td.setAttribute('style', `border: 1px solid #dfe2e5; padding: 6px 13px; color: #333333;${align ? ` text-align: ${align};` : ''}`);
  }
  for (const quote of container.querySelectorAll<HTMLElement>('blockquote')) {
    if (quote.style.borderLeft) continue;
    quote.setAttribute('style', 'border-left: 4px solid #e8e9eb; padding: 0 15px; margin: 0.8em 0; color: #777777;');
  }
}

/** Synchronously render Markdown syntax tree into a DOM container, shared between export and clipboard copy. */
export function renderMarkdownDom(doc: Document, container: HTMLElement, markdown: string, options: RenderMarkdownOptions = {}): void {
  const forCopy = !!options.forCopy;
  const element = (tag: string, text?: string) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const { body } = splitFrontmatter(markdown);
  const externalDefs = options.referenceDefinitions ??
    (options.referenceSource && options.referenceSource !== markdown ? collectReferenceDefinitions(options.referenceSource) : undefined);
  const candidate = externalDefs?.block && body.includes('[') ? `${body}\n\n${externalDefs.block}` : null;
  const candidateAst = candidate ? parseMarkdownAst(candidate) : null;
  const swallowed = candidateAst?.children.some(child =>
    (child.position?.start.offset ?? 0) < body.length && (child.position?.end.offset ?? 0) > body.length,
  );
  const parseInput = candidate && candidateAst && !swallowed ? candidate : body;
  const ast = candidate && candidateAst && !swallowed ? candidateAst : parseMarkdownAst(body);
  const tree: Block = parsePositionedRichMarkdown(parseInput) as Block;
  const destinations = new Map<string, ReferenceDefinition>();
  const notes = new Map<string, { refs: HTMLElement[]; target?: HTMLElement }>();
  const comments: { from: number; to: number }[] = [];

  function indexComments(node: Nodes) {
    if (node.type === 'html' && isHtmlComment(node.value)) {
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (from !== undefined && to !== undefined) comments.push({ from, to });
    }
    if ('children' in node) node.children.forEach(indexComments);
  }
  indexReferenceDefinitions(ast, destinations);
  indexComments(ast);

  // Protected fragments retain their original spelling, including code examples.
  // Remove only the ranges the Markdown parser identified as actual comments.
  function rawText(node: Block, value: string) {
    const from = node.position?.start.offset;
    if (from === undefined || !value.includes('<!--')) return value;
    let text = '', cursor = from;
    for (const comment of comments) {
      if (comment.from >= from + value.length) break;
      if (comment.from < from || comment.to > from + value.length) continue;
      text += value.slice(cursor - from, comment.from - from);
      cursor = comment.to;
    }
    return text + value.slice(cursor - from);
  }

  const headings: HTMLElement[] = [], tocs: HTMLElement[] = [];
  const preferredIds = new Map<HTMLElement, string>();
  const htmlSourceIds = new WeakMap<Element, string>();

  function note(label: string) {
    const key = label.toLowerCase();
    if (!notes.has(key)) notes.set(key, { refs: [] });
    return notes.get(key)!;
  }
  function link(href: string, label?: string) {
    const el = element('a', label);
    if (!/^(?:[a-z][\w+.-]*:)/i.test(href.replace(/[\x00-\x20]/g, '')) || /^(?:https?:\/\/|mailto:)/i.test(href)) el.setAttribute('href', href);
    return el;
  }
  function inlineElement(span: InlineSpan) {
    const html = span.html;
    if (html?.tag === 'img') {
      const img = element('img'); img.setAttribute('src', html.src); img.setAttribute('alt', html.alt);
      if (html.title) img.title = html.title;
      if (html.width) img.style.width = html.width;
      if (html.height) img.style.height = html.height;
      return img;
    }
    const tags = { strong: 'strong', em: 'em', strike: 'del', code: 'code', highlight: 'mark' };
    const el = span.href !== undefined ? link(span.href) : element(html?.tag ?? tags[span.kind as keyof typeof tags] ?? 'span');
    if (span.title || html?.title) el.title = span.title || html!.title!;
    if (html?.styles) el.style.cssText = inlineHtmlStyle(html.styles);
    return el;
  }
  function appendTextChunk(target: HTMLElement, chunk: string) {
    if (!forCopy || !chunk.includes('\n')) {
      target.append(chunk);
      return;
    }
    const parts = chunk.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) target.append(element('br'));
      if (parts[index]) target.append(parts[index]);
    }
  }

  // Build the same logical text run as the rich editor. Non-text inline nodes
  // occupy one position, including when wrapped in emphasis or a Markdown link.
  function phrasing(parent: HTMLElement, block: Block) {
    let run = '';
    const objects = new Map<number, Block>();
    for (const child of block.children ?? []) {
      if (child.type === 'text') run += child.value;
      else if (child.type === 'break' && !child.data?.croquillHtmlBreak) run += '\n';
      else { objects.set(run.length, child); run += INLINE_OBJECT; }
    }
    const spans = inlineSyntaxSpans(run);
    const attributes = block.type === 'heading' ? headingAttributes(run) : [];
    const points = new Set([0, run.length]);
    const openings = new Map<number, InlineSpan[]>(), closings = new Map<number, InlineSpan[]>();
    const hidden = new Map<number, number>();
    function hide(from: number, to: number) {
      if (from >= to) return;
      points.add(from); points.add(to);
      hidden.set(from, (hidden.get(from) ?? 0) + 1);
      hidden.set(to, (hidden.get(to) ?? 0) - 1);
    }
    for (const span of spans) {
      points.add(span.from); points.add(span.to);
      if (!openings.has(span.from)) openings.set(span.from, []);
      if (!closings.has(span.to)) closings.set(span.to, []);
      openings.get(span.from)!.push(span); closings.get(span.to)!.push(span);
      hide(span.from, span.innerFrom); hide(span.innerTo, span.to);
    }
    for (const range of attributes) hide(range.from, range.to);
    const custom = customHeadingId(run, attributes);
    if (custom) preferredIds.set(parent, custom);
    for (const offset of objects.keys()) { points.add(offset); points.add(offset + 1); }
    const offsets = [...points].sort((a, b) => a - b);
    const active = new Set<InlineSpan>();
    let concealed = 0;
    let wrappers: { span: InlineSpan; el: HTMLElement }[] = [];
    for (let i = 0; i + 1 < offsets.length; i++) {
      const at = offsets[i];
      for (const span of closings.get(at) ?? []) active.delete(span);
      const opening = openings.get(at) ?? [];
      for (const span of opening) active.add(span);
      concealed += hidden.get(at) ?? 0;
      const insert = opening.find(s => s.kind === 'entity' || s.html?.tag === 'img');
      if (concealed && !insert) continue;
      const chain = [...active].filter(s => s.kind !== 'entity' && s.kind !== 'escape' && s.html?.tag !== 'img');
      let shared = 0;
      while (shared < chain.length && chain[shared] === wrappers[shared]?.span) shared++;
      wrappers = wrappers.slice(0, shared);
      let container = wrappers.at(-1)?.el ?? parent;
      for (const span of chain.slice(shared)) {
        const el = inlineElement(span); container.append(el); container = el;
        wrappers.push({ span, el });
      }
      if (insert) container.append(insert.html ? inlineElement(insert) : insert.value ?? '');
      else if (objects.has(at)) container.append(render(objects.get(at)!));
      else appendTextChunk(container, run.slice(at, offsets[i + 1]));
    }
  }

  function render(node: Block, top = false): Node {
    const value = node.value ?? '', kids = node.children ?? [];
    const children = (tag: string) => {
      const el = element(tag);
      for (const child of kids) el.append(render(child));
      return el;
    };
    switch (node.type) {
      case 'heading': case 'paragraph': case 'tableCell': {
        const el = element(node.type === 'heading' ? 'h' + node.depth : node.type === 'tableCell' ? 'td' : 'p');
        phrasing(el, node);
        if (top && node.type === 'heading') headings.push(el);
        return el;
      }
      case 'croquillToc': { const el = element('nav'); tocs.push(el); return el; }
      case 'break': return element('br');
      case 'thematicBreak': return element('hr');
      case 'blockquote': return children('blockquote');
      case 'list': {
        const el = children(node.ordered ? 'ol' : 'ul');
        if (node.ordered && node.start !== 1 && node.start != null) el.setAttribute('start', String(node.start));
        return el;
      }
      case 'listItem': {
        const el = children('li');
        if (node.checked != null) {
          const box = doc.createElement('input'); box.type = 'checkbox'; box.disabled = true;
          box.toggleAttribute('checked', node.checked);
          if (forCopy) el.style.listStyle = 'none';
          else el.className = 'task';
          (el.querySelector(':scope > p') ?? el).prepend(box, ' ');
        }
        return el;
      }
      case 'croquillAlert': {
        const el = element('blockquote'), type = node.alertType ?? 'NOTE';
        if (forCopy) {
          const color = ALERT_COLORS[type] ?? ALERT_COLORS.NOTE;
          el.setAttribute('style', `border-left: 4px solid ${color}; padding: 0 15px; margin: 0.8em 0; color: #333333;`);
          const title = element('p', ALERT_TITLES[type] ?? 'Note');
          title.setAttribute('style', `margin: 0 0 0.5em; font-weight: 600; color: ${color};`);
          el.append(title);
          for (const child of kids) el.append(render(child));
          return el;
        }
        el.dataset.croquillAlert = type;
        const title = DOMSerializer.renderSpec(doc, alertTitle(type)).dom;
        const content = children('div'); content.className = 'croquill-alert-body'; el.append(title, content); return el;
      }
      case 'table': {
        const table = doc.createElement('table'), head = table.createTHead(), tbody = table.createTBody();
        kids.forEach((row, i) => {
          const tr = (i ? tbody : head).insertRow();
          row.children?.forEach((cell, j) => {
            const el = element(i ? 'td' : 'th'); phrasing(el, cell);
            if (node.align?.[j]) el.style.textAlign = node.align[j]!;
            tr.append(el);
          });
        });
        return table;
      }
      case 'code': {
        const pre = element('pre'), code = element('code', value); pre.append(code);
        if (node.lang && options.highlightCode) options.highlightCode(node.lang, value, code);
        return pre;
      }
      case 'math': case 'inlineMath': {
        // Native MathML uses the browser's local math font; no web fonts or scripts.
        const el = element(node.type === 'math' ? 'div' : 'span');
        katex.render(value, el, { displayMode: node.type === 'math', output: 'mathml', throwOnError: false, trust: false });
        if (forCopy) {
          const math = el.querySelector('math');
          if (node.type === 'inlineMath' && math) return math;
          if (node.type === 'math' && math) {
            el.setAttribute('style', 'margin: 1em 0;');
            el.replaceChildren(math);
          }
        }
        return el;
      }
      case 'footnoteReference': {
        const label = node.label || node.identifier!, entry = note(node.identifier || label);
        const sup = element('sup', label);
        entry.refs.push(sup); return sup;
      }
      case 'footnoteDefinition': {
        const entry = note(node.identifier!), el = children('aside');
        if (forCopy) el.setAttribute('style', 'border-top: 1px solid #e8e9eb; padding-top: 0.5em;');
        else el.className = 'footnote';
        el.prepend(element('strong', node.label || node.identifier)); entry.target = el; return el;
      }
      case 'croquillRawBlock': case 'html': {
        if (node.kind === 'html' || node.type === 'html') {
          return sanitizeHtmlFragment(value, forCopy ? { exportDocument: doc } : { exportDocument: doc, sourceIds: htmlSourceIds });
        }
        const el = element('pre', rawText(node, value).trimEnd());
        const definition = /^\[\^([^\]]+)\]:/.exec(value);
        if (definition) note(definition[1]).target = el;
        return el;
      }
      case 'image': case 'imageReference': {
        const src = node.url ?? destinations.get(node.identifier!)?.url;
        const img = element('img'); img.setAttribute('alt', node.alt ?? '');
        if (src) img.setAttribute('src', src);
        if (node.title) img.title = node.title;
        return img;
      }
      case 'link': case 'linkReference': {
        const el = link(node.url ?? destinations.get(node.identifier!)?.url ?? '');
        phrasing(el, node);
        return el;
      }
      case 'croquillHtmlComment': case 'definition': return doc.createTextNode('');
      case 'croquillInlineRaw': {
        if (isHtmlComment(value)) return doc.createTextNode('');
        const el = element('span', rawText(node, value));
        if (forCopy) el.setAttribute('style', 'color: #96999e;');
        else el.className = 'comment';
        return el;
      }
      default: return doc.createTextNode(value);
    }
  }

  for (const child of tree.children ?? []) container.append(render(child, true));
  const elementsWithIds = forCopy ? [] : Array.from(doc.querySelectorAll('[id]'));
  const usedIds = new Set(elementsWithIds.filter(el => !htmlSourceIds.has(el)).map(el => el.id));
  const uniqueId = allocateIds(usedIds);
  if (!forCopy) {
    // Keep the sanitizer's ID on surviving HTML elements and redirect authored links to it.
    const htmlAnchors = new Map<string, string>();
    for (const el of elementsWithIds) {
      const original = htmlSourceIds.get(el);
      if (original === undefined) continue;
      el.id = uniqueId(el.id);
      if (original && !htmlAnchors.has(original)) htmlAnchors.set(original, el.id);
    }
    for (const original of htmlAnchors.keys()) usedIds.add(original);
    for (const a of container.querySelectorAll('a[href^="#"]')) {
      let fragment = a.getAttribute('href')!.slice(1);
      try { fragment = decodeURIComponent(fragment); } catch { /* Literal percent in the ID. */ }
      const target = htmlAnchors.get(fragment);
      if (target) a.setAttribute('href', '#' + encodeURIComponent(target));
    }
  }
  for (const entry of notes.values()) if (!entry.target) {
    for (const sup of entry.refs) sup.replaceWith('[^' + sup.textContent + ']');
  }
  if (!forCopy) {
    for (const h of container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
      if (!h.id) h.id = headingId(h.textContent || '', preferredIds.get(h), uniqueId);
    }
  }
  for (const toc of tocs) for (const h of headings) {
    if (forCopy) {
      const a = element('a', h.textContent || '（空标题）');
      const level = Math.max(1, Number(h.tagName.slice(1)) || 1);
      a.setAttribute('style', `display: block; padding-left: ${(level - 1) * 1.2}em;`);
      toc.append(a);
    } else {
      const a = link('#' + h.id, h.textContent || '（空标题）'); a.style.setProperty('--level', h.tagName.slice(1)); toc.append(a);
    }
  }
  if (!forCopy) {
    let noteNumber = 0;
    for (const entry of notes.values()) {
      if (!entry.target) continue;
      const id = uniqueId('fn-' + ++noteNumber);
      entry.target.id = id;
      for (const [index, sup] of entry.refs.entries()) {
        sup.id = uniqueId(id + '-ref-' + (index + 1));
        sup.replaceChildren(link('#' + id, sup.textContent ?? ''));
        entry.target.append(' ', link('#' + sup.id, '↩'));
      }
    }
  }
  if (forCopy) applyClipboardStyles(container);
}
