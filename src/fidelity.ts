import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { inlineHtmlRanges, isInlineHtmlRun, renderedHtmlTagRanges, type InlineHtmlRange } from './inline-html-ranges';
import { isHtmlComment } from './html-comments';
import { alertTypeOf } from './alert-types';
import { tocMarkerOf } from './document-syntax';

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
interface SyntaxNode {
  type: string;
  value?: string;
  children?: SyntaxNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
export interface PreservedBlock { from: number; to: number; raw: string; categories: string[] }
export interface MarkdownParts { prefix: string; frontmatter: string; body: string; incomplete: boolean }

/** Only these attribute-free spellings can be edited as a literal HTML break. */
export function isBareHtmlBreak(value: string): boolean { return /^<br(?: ?\/)?>$/i.test(value); }

/** Keep a transport BOM and a closed header outside the rich body. */
export function splitFrontmatter(markdown: string): MarkdownParts {
  const opening = /^\uFEFF?---[ \t]*(?:\r\n|\n|\r)/.exec(markdown);
  if (!opening) return { prefix: markdown.startsWith('\uFEFF') ? '\uFEFF' : '', frontmatter: '', body: markdown.replace(/^\uFEFF/, ''), incomplete: false };
  const rest = markdown.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?=\r?$|\r)/m.exec(rest);
  if (!closing) {
    return { prefix: markdown.startsWith('\uFEFF') ? '\uFEFF' : '', frontmatter: '', body: markdown.replace(/^\uFEFF/, ''), incomplete: /^[ \t]*[\w\u0080-\uFFFF-]+[ \t]*:/m.test(rest) };
  }
  const end = opening[0].length + closing.index + closing[0].length;
  const separator = /^(?:\r\n|\n|\r)(?:[ \t]*(?:\r\n|\n|\r))*/.exec(markdown.slice(end))?.[0] || '';
  const prefix = markdown.slice(0, end + separator.length);
  return { prefix, frontmatter: markdown.slice(0, end), body: markdown.slice(prefix.length), incomplete: false };
}

type SourceRange = { from: number; to: number };

function categoriesOf(node: SyntaxNode, source: string, renderedTags?: SourceRange[]): Set<string> {
  const categories = new Set<string>();
  const text: string[] = [];
  function visit(child: SyntaxNode, html?: { tags: Set<number>; literals: InlineHtmlRange[] } | null): void {
    if (tocMarkerOf(child, source)) return;
    if (isInlineHtmlRun(child)) {
      const ranges = inlineHtmlRanges(child, source);
      const tags = ranges && renderedHtmlTagRanges(ranges);
      html = ranges && tags ? { tags: new Set(tags.map(tag => tag.from)), literals: ranges.filter(range => !range.element) } : null;
      if (tags && renderedTags) for (const tag of tags) renderedTags.push(tag);
    }
    if (['code', 'inlineCode', 'math', 'inlineMath'].includes(child.type)) { text.push('\n'); return; }
    const from = child.position?.start.offset, to = child.position?.end.offset;
    if (from != null && to != null && html?.literals.some(range => range.from <= from && to <= range.to)) { text.push('\0'); return; }
    if (child.type === 'html' && !isBareHtmlBreak(child.value || '') && !isHtmlComment(child.value || '') && !html?.tags.has(from ?? -1)) {
      categories.add('HTML');
      // Malformed inline syntax still belongs to a protected Markdown block.
      // Only actual HTML blocks should use the block renderer.
      if (html === null) categories.add('行内 HTML 边界');
    }
    if (child.type === 'blockquote' && /^\[![A-Z]+\]/.test(child.children?.[0]?.children?.[0]?.value || '') && !alertTypeOf(child, source)) categories.add('提示块');
    if (child.type === 'text') text.push(child.value || '');
    child.children?.forEach(nested => visit(nested, html));
  }
  visit(node);
  const prose = text.join('');
  if (/\[TOC\]/i.test(prose)) categories.add('目录');
  if (/!?\[\[[\s\S]+?\]\]/.test(prose)) categories.add('双链');
  if (/(?:^|\n)\s*:{3,}/.test(prose)) categories.add('容器');
  if (/\{[.#][^}\n]+\}/.test(prose)) categories.add('属性');
  if (/(?:^|\s)\^[\w-]+\s*$/.test(prose)) categories.add('块引用标识');
  return categories;
}

/** Parsed HTML and extension-bearing blocks are opaque locally, never executed. */
export function preservedMarkdownBlocks(body: string): PreservedBlock[] {
  // remark treats a leading BOM as transport metadata, excluding it from offsets.
  if (body.startsWith('\uFEFF')) return preservedMarkdownBlocks(body.slice(1)).map(block => ({ ...block, from: block.from + 1, to: block.to + 1 }));
  const nodes = markdownParser.parse(body).children as SyntaxNode[];
  const blocks: PreservedBlock[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const categories = categoriesOf(node, body);
    if (!categories.size) continue;
    let last = i;
    // CommonMark can split HTML containers around blank lines. Keep the complete
    // paired region together, including Markdown-like text between the tags.
    if (node.type === 'html') {
      const tag = /^\s*<([A-Za-z][\w-]*)(?:\s[^>]*|\s*)>/.exec(node.value || '')?.[1];
      if (tag && !['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'embed', 'source', 'wbr'].includes(tag.toLowerCase())) {
        const tokens = new RegExp(`<(/?)${tag}(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
        let balance = 0;
        for (let j = i; j < nodes.length; j++) {
          if (nodes[j].type !== 'html') continue;
          const html = (nodes[j].value || '').replace(/<!--[\s\S]*?-->/g, '');
          for (const token of html.matchAll(tokens)) {
            if (token[1]) balance--;
            else if (!/\/\s*>$/.test(token[0])) balance++;
          }
          if (balance <= 0) { last = j; break; }
        }
      }
    }
    if (categories.has('容器')) {
      const start = node.position?.start.offset ?? 0, end = node.position?.end.offset ?? start;
      const raw = body.slice(start, end);
      if (/^\s*:{3,}\s*\S/.test(raw) && !/\n\s*:{3,}[ \t]*$/.test(raw)) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (nodes[j].type === 'paragraph' && /(?:^|\n)\s*:{3,}[ \t]*$/.test(body.slice(nodes[j].position?.start.offset, nodes[j].position?.end.offset))) { last = Math.max(last, j); break; }
        }
      }
    }
    const from = node.position?.start.offset;
    let to = nodes[last].position?.end.offset;
    if (from == null || to == null) continue;
    for (let j = i + 1; j <= last; j++) categoriesOf(nodes[j], body).forEach(value => categories.add(value));
    // Keep original separator whitespace too (e.g. CRLF between a footnote reference and definition).
    const nextStart = nodes[last + 1]?.position?.start.offset ?? body.length;
    if (/^[ \t\r\n]*$/.test(body.slice(to, nextStart))) to = nextStart;
    blocks.push({ from, to, raw: body.slice(from, to), categories: [...categories] });
    i = last;
  }
  return blocks;
}

/** Protection is reserved for metadata we cannot safely separate yet. */
export function detectUnsafeMarkdown(markdown: string): string | null {
  if (/^\uFEFF?\+\+\+[ \t]*(?:\r\n|\n|\r)/.test(markdown)) return 'TOML 元数据暂未支持原样拆分，已启用源码保护';
  if (splitFrontmatter(markdown).incomplete) return '文首 YAML 元数据缺少结束标记，已启用源码保护';
  return null;
}

function semanticTree(value: unknown, source: string): unknown {
  if (Array.isArray(value)) {
    const children = value.map((child) => semanticTree(child, source));
    return children.reduce<Record<string, unknown>[]>((merged, child) => {
      const current = child as Record<string, unknown>;
      const previous = merged.at(-1);
      if (current?.type === 'text' && previous?.type === 'text') previous.value = String(previous.value) + String(current.value);
      else merged.push(current);
      return merged;
    }, []);
  }
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  if (node.type === 'inlineMath') {
    const positions = node.position as { start: { offset: number }; end: { offset: number } } | undefined;
    if (positions && source[positions.start.offset + 1] !== '$') {
      const raw = source.slice(positions.start.offset, positions.end.offset);
      if (/^\$\s/.test(raw) || /\s\$$/.test(raw) || /\d/.test(source[positions.end.offset] || '')) return { type: 'text', value: raw };
    }
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(node).sort()) {
    if (key === 'position' || key === 'data' || key === 'spread') continue;
    // A line ending inside a value (a soft break, a code block) is the file's newline
    // style, which is kept separately; CRLF and LF there are the same structure.
    copy[key] = key === 'value' && typeof node[key] === 'string' ? (node[key] as string).replace(/\r\n?/g, '\n') : semanticTree(node[key], source);
  }
  return copy;
}

/** Keep the semantic last gate, with metadata compared as its literal source. */
export function hasEquivalentMarkdownStructure(before: string, after: string): boolean {
  const a = splitFrontmatter(before), b = splitFrontmatter(after);
  return a.frontmatter === b.frontmatter &&
    JSON.stringify(semanticTree(markdownParser.parse(a.body), a.body)) ===
    JSON.stringify(semanticTree(markdownParser.parse(b.body), b.body));
}

/** A top-level Markdown heading extracted for the document outline. */
export interface MarkdownOutlineItem {
  level: number;
  text: string;
  line: number;
}

/** Extracts visible plain text from a Remark AST node tree. */
export function astNodeVisibleText(node: unknown, hiddenTags?: Set<number>): string {
  const item = node as SyntaxNode & { alt?: string };
  if (item.type === 'html' && hiddenTags?.has(item.position?.start.offset ?? -1)) return '';
  return item.value ?? item.alt ?? item.children?.map(child => astNodeVisibleText(child, hiddenTags)).join('') ?? '';
}

/** Keep the existing source-based count, omitting the tags of rendered inline HTML. */
export function markdownWithoutRenderedHtmlTags(markdown: string): string {
  if (!/<[a-z]/i.test(markdown)) return markdown;
  const { prefix, body } = splitFrontmatter(markdown);
  const tags: SourceRange[] = [];
  for (const block of markdownParser.parse(body).children) {
    const start = tags.length;
    if (categoriesOf(block, body, tags).size) tags.length = start;
  }
  if (!tags.length) return markdown;
  let result = prefix, from = 0;
  for (const tag of tags.sort((a, b) => a.from - b.from)) {
    result += body.slice(from, tag.from);
    from = tag.to;
  }
  return result + body.slice(from);
}

/** Parses Markdown using Croquill's shared Remark parser. */
export function parseMarkdownAst(markdown: string) {
  return markdownParser.parse(markdown);
}

/** Counts direct top-level heading nodes in a Markdown fragment (e.g. a protected raw block). */
export function countTopLevelAstHeadings(markdown: string): number {
  const ast = markdownParser.parse(markdown);
  let count = 0;
  for (const child of ast.children) {
    if (child.type === 'heading') count += 1;
  }
  return count;
}

export function markdownOutline(markdown: string): MarkdownOutlineItem[] {
  const rows = markdown.split('\n');
  const first = rows[0]?.replace(/^\uFEFF/, '').trim();
  if (first === '---' || first === '+++') {
    const closing = rows.findIndex((row, index) => index > 0 && (row.trim() === first || first === '---' && row.trim() === '...'));
    const length = closing < 0 ? rows.length : closing + 1;
    for (let index = 0; index < length; index++) rows[index] = '';
  }
  const source = rows.join('\n').replace(/^\uFEFF/, '');
  const ast = markdownParser.parse(source);
  const headings: MarkdownOutlineItem[] = [];
  for (const child of ast.children) {
    if (child.type === 'heading') {
      const ranges = inlineHtmlRanges(child, source);
      const hidden = ranges?.length ? new Set(renderedHtmlTagRanges(ranges).map(tag => tag.from)) : undefined;
      headings.push({ level: child.depth, text: astNodeVisibleText(child, hidden), line: child.position?.start.line ?? 1 });
    }
  }
  return headings;
}
