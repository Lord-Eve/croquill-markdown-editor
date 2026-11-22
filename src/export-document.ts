import katex from 'katex';
import { DOMSerializer } from '@milkdown/kit/prose/model';
import { alertTitle, type AlertType } from './alerts';
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { parsePositionedRichMarkdown } from './rich-markdown';
import { splitFrontmatter } from './fidelity';
import { headingAttributes, INLINE_OBJECT, inlineSyntaxSpans, type InlineSpan } from './inline-source';
import { inlineHtmlStyle, sanitizeHtmlFragment } from './html-sanitize';
import { parseMarkdownAst } from './markdown-ast';
import type { Nodes } from 'mdast';
import { isHtmlComment } from './html-comments';
import theme from './markdown-theme.css?raw';
import alerts from './alerts.css?raw';
import styles from './export.css?raw';

export type ExportFormat = 'html' | 'pdf';
export function exportName(path: string, format: ExportFormat) {
  return path.replace(/\.[^./\\]+$/, '') + '.' + format;
}

interface Block {
  type: string; value?: string; children?: Block[]; depth?: number; kind?: string;
  position?: { start: { offset?: number } };
  lang?: string; alertType?: AlertType; url?: string; title?: string; alt?: string;
  checked?: boolean; ordered?: boolean; start?: number; align?: (string | null)[];
  identifier?: string; label?: string; data?: Record<string, unknown>;
}

export async function exportDocument(markdown: string, name: string, activeTheme: string, format: ExportFormat,
    readImage: (src: string) => Promise<string>): Promise<string> {
  const doc = document.implementation.createHTMLDocument(name);
  const element = (tag: string, text?: string) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  doc.documentElement.lang = 'zh-CN';
  doc.documentElement.dataset.theme = format === 'pdf' ? 'light' : activeTheme === 'dark' ? 'dark' : 'light';
  const charset = element('meta'); charset.setAttribute('charset', 'utf-8');
  const policy = element('meta'); policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', "default-src 'none'; img-src 'self' file: data: https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  doc.head.prepend(charset, policy);
  doc.head.append(element('style', theme.replaceAll('.milkdown .milkdown-code-block', '#write pre') +
    alerts.replaceAll('.milkdown .ProseMirror', '#write') + styles));
  const main = element('article'); main.id = 'write'; doc.body.append(main);
  const { body } = splitFrontmatter(markdown);
  const tree: Block = parsePositionedRichMarkdown(body) as Block;
  const destinations = new Map<string, { url: string; title?: string | null }>();
  const notes = new Map<string, { refs: HTMLElement[]; target?: HTMLElement }>();
  const comments: { from: number; to: number }[] = [];
  function indexSource(node: Nodes) {
    if (node.type === 'definition' && !destinations.has(node.identifier)) destinations.set(node.identifier, node);
    if (node.type === 'html' && isHtmlComment(node.value)) {
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (from !== undefined && to !== undefined) comments.push({ from, to });
    }
    if ('children' in node) node.children.forEach(indexSource);
  }
  indexSource(parseMarkdownAst(body));
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
  const headings: HTMLElement[] = [], tocs: HTMLElement[] = [], pending: Promise<void>[] = [];
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
    const tags = { strong:'strong', em:'em', strike:'del', code:'code', highlight:'mark' };
    const el = span.href !== undefined ? link(span.href) : element(html?.tag ?? tags[span.kind as keyof typeof tags] ?? 'span');
    if (span.title || html?.title) el.title = span.title || html!.title!;
    if (html?.styles) el.style.cssText = inlineHtmlStyle(html.styles);
    return el;
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
    for (const range of attributes) {
      hide(range.from, range.to);
      const id = /#([^\s}]+)/u.exec(run.slice(range.from, range.to))?.[1];
      if (id && !preferredIds.has(parent)) preferredIds.set(parent, id);
    }
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
      else container.append(run.slice(at, offsets[i + 1]));
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
          box.toggleAttribute('checked', node.checked); el.className = 'task'; (el.querySelector(':scope > p') ?? el).prepend(box, ' ');
        }
        return el;
      }
      case 'croquillAlert': {
        const el = element('blockquote'), type = node.alertType!;
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
        const language = node.lang && LanguageDescription.matchLanguageName(languages, node.lang);
        if (language) pending.push(language.load().then(support => {
          const fragment = doc.createDocumentFragment(); let last = 0;
          highlightTree(support.language.parser.parse(value), classHighlighter, (from, to, classes) => {
            const token = element('span', value.slice(from, to)); token.className = classes;
            fragment.append(value.slice(last, from), token); last = to;
          });
          fragment.append(value.slice(last)); code.replaceChildren(fragment);
        }));
        return pre;
      }
      case 'math': case 'inlineMath': {
        // Native MathML uses the browser's local math font; no web fonts or scripts.
        const el = element(node.type === 'math' ? 'div' : 'span');
        katex.render(value, el, { displayMode: node.type === 'math', output: 'mathml', throwOnError: false, trust: false });
        return el;
      }
      case 'footnoteReference': {
        const label = node.label || node.identifier!, entry = note(node.identifier || label);
        const sup = element('sup', label);
        entry.refs.push(sup); return sup;
      }
      case 'footnoteDefinition': {
        const entry = note(node.identifier!), el = children('aside'); el.className = 'footnote';
        el.prepend(element('strong', node.label || node.identifier)); entry.target = el; return el;
      }
      case 'croquillRawBlock': case 'html': {
        if (node.kind === 'html' || node.type === 'html') return sanitizeHtmlFragment(value, { exportDocument: doc, sourceIds: htmlSourceIds });
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
      case 'croquillHtmlComment': return doc.createTextNode('');
      case 'croquillInlineRaw': {
        if (isHtmlComment(value)) return doc.createTextNode('');
        const el = element('span', rawText(node, value)); el.className = 'comment'; return el;
      }
      default: return doc.createTextNode(value);
    }
  }
  for (const child of tree.children ?? []) main.append(render(child, true));
  const elementsWithIds = Array.from(doc.querySelectorAll('[id]'));
  const usedIds = new Set(elementsWithIds.filter(el => !htmlSourceIds.has(el)).map(el => el.id));
  const nextSuffix = new Map<string, number>();
  function uniqueId(base: string) {
    let id = base, suffix = nextSuffix.get(base) ?? 1;
    while (usedIds.has(id)) id = base + '-' + suffix++;
    usedIds.add(id); nextSuffix.set(base, suffix);
    return id;
  }
  // Keep the sanitizer's ID on surviving HTML elements and redirect authored links to it.
  const htmlAnchors = new Map<string, string>();
  for (const el of elementsWithIds) {
    const original = htmlSourceIds.get(el);
    if (original === undefined) continue;
    el.id = uniqueId(el.id);
    if (original && !htmlAnchors.has(original)) htmlAnchors.set(original, el.id);
  }
  for (const original of htmlAnchors.keys()) usedIds.add(original);
  for (const a of main.querySelectorAll('a[href^="#"]')) {
    let fragment = a.getAttribute('href')!.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch { /* Literal percent in the ID. */ }
    const target = htmlAnchors.get(fragment);
    if (target) a.setAttribute('href', '#' + encodeURIComponent(target));
  }
  for (const entry of notes.values()) if (!entry.target) {
    for (const sup of entry.refs) sup.replaceWith('[^' + sup.textContent + ']');
  }
  for (const h of main.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    if (!h.id) h.id = uniqueId(preferredIds.get(h) || h.textContent?.trim() || 'heading');
  }
  for (const toc of tocs) for (const h of headings) {
    const a = link('#' + h.id, h.textContent || '（空标题）'); a.style.setProperty('--level', h.tagName.slice(1)); toc.append(a);
  }
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
  if (format === 'pdf') {
    const cache = new Map<string, Promise<string>>();
    for (const img of main.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src')!;
      if (/^(https?:|data:|\/\/)/i.test(src)) continue;
      if (!cache.has(src)) cache.set(src, readImage(src));
      pending.push(cache.get(src)!.then(data => { img.setAttribute('src', data); }));
    }
  }
  await Promise.all(pending);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
