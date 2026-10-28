import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
interface SyntaxNode {
  type: string;
  value?: string;
  children?: SyntaxNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
export interface PreservedBlock { from: number; to: number; raw: string; categories: string[] }
export interface MarkdownParts { prefix: string; frontmatter: string; body: string; incomplete: boolean }

/** Only a closed header at the document start is removed from the rich body. */
export function splitFrontmatter(markdown: string): MarkdownParts {
  const opening = /^\uFEFF?---[ \t]*(?:\r\n|\n|\r)/.exec(markdown);
  if (!opening) return { prefix: '', frontmatter: '', body: markdown, incomplete: false };
  const rest = markdown.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?=\r?$|\r)/m.exec(rest);
  if (!closing) {
    return { prefix: '', frontmatter: '', body: markdown, incomplete: /^[ \t]*[\w\u0080-\uFFFF-]+[ \t]*:/m.test(rest) };
  }
  const end = opening[0].length + closing.index + closing[0].length;
  const separator = /^(?:\r\n|\n|\r)(?:[ \t]*(?:\r\n|\n|\r))*/.exec(markdown.slice(end))?.[0] || '';
  const prefix = markdown.slice(0, end + separator.length);
  return { prefix, frontmatter: markdown.slice(0, end), body: markdown.slice(prefix.length), incomplete: false };
}

function categoriesOf(node: SyntaxNode): Set<string> {
  const categories = new Set<string>();
  const text: string[] = [];
  function visit(child: SyntaxNode): void {
    if (['code', 'inlineCode', 'math', 'inlineMath'].includes(child.type)) { text.push('\n'); return; }
    if (child.type === 'html') categories.add('HTML');
    if (child.type === 'listItem' && !child.children?.length) categories.add('空列表项');
    if (child.type === 'footnoteDefinition' || child.type === 'footnoteReference') categories.add('脚注');
    if (child.type === 'text') text.push(child.value || '');
    child.children?.forEach(visit);
  }
  visit(node);
  const prose = text.join('');
  if (/\[\^[^\]\n]+\]/.test(prose)) categories.add('脚注');
  if (/==[^=\n]+==/.test(prose)) categories.add('高亮');
  if (/\[TOC\]/i.test(prose)) categories.add('目录');
  if (/!?\[\[[\s\S]+?\]\]/.test(prose)) categories.add('双链');
  if (/(?:^|\n)\s*:{3,}/.test(prose)) categories.add('容器');
  if (/\{[.#][^}\n]+\}/.test(prose)) categories.add('属性');
  if (node.type === 'blockquote' && /^\[![A-Z]+\]/.test(prose)) categories.add('提示块');
  if (/(?:^|\s)\^[\w-]+\s*$/.test(prose)) categories.add('块引用标识');
  return categories;
}

/** Parsed HTML and extension-bearing blocks are opaque locally, never executed. */
export function preservedMarkdownBlocks(body: string): PreservedBlock[] {
  const nodes = markdownParser.parse(body).children as SyntaxNode[];
  const blocks: PreservedBlock[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const categories = categoriesOf(node);
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
    for (let j = i + 1; j <= last; j++) categoriesOf(nodes[j]).forEach(value => categories.add(value));
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
    copy[key] = semanticTree(node[key], source);
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

export function markdownOutline(markdown: string): { level: number; text: string; line: number }[] {
  const rows = markdown.split('\n');
  const first = rows[0]?.replace(/^\uFEFF/, '').trim();
  if (first === '---' || first === '+++') {
    const closing = rows.findIndex((row, index) => index > 0 && (row.trim() === first || first === '---' && row.trim() === '...'));
    const length = closing < 0 ? rows.length : closing + 1;
    for (let index = 0; index < length; index++) rows[index] = '';
  }
  const ast = markdownParser.parse(rows.join('\n'));
  const headings: { level: number; text: string; line: number }[] = [];
  function textOf(node: unknown): string {
    const item = node as { value?: string; alt?: string; children?: unknown[] };
    return item.value ?? item.alt ?? item.children?.map(textOf).join('') ?? '';
  }
  for (const child of ast.children) {
    if (child.type === 'heading') {
      headings.push({ level: child.depth, text: textOf(child), line: child.position?.start.line ?? 1 });
    }
  }
  return headings;
}
