import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** Ignore syntax inside code: it must remain ordinary code, not trigger protection. */
export function proseOnly(markdown: string): string {
  let fence: { char: string; length: number } | undefined;
  return markdown.split(/\r?\n/).map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length) fence = undefined;
      return '';
    }
    if (match) {
      fence = { char: match[1][0], length: match[1].length };
      return '';
    }
    if (/^(?: {4}|\t)/.test(line)) return '';
    return line.replace(/(`+)(.*?)\1/g, '');
  }).join('\n');
}

/** Known extensions are kept in source until we can reliably edit their structure. */
export function detectUnsafeMarkdown(markdown: string): string | null {
  if (/^\uFEFF?(?:---|\+\+\+)[ \t]*\r?\n/.test(markdown)) {
    return '文档含 YAML / TOML frontmatter，已启用源码保护';
  }
  const prose = proseOnly(markdown);
  if (/<(?:!--|!DOCTYPE\b|\?xml\b|\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s|\/?\>))/.test(prose)) {
    return '文档含原始 HTML，已启用源码保护';
  }
  if (/\[\^[^\]]+\]|!?\[\[[^\]]+\]\]|^\s*:::+|^\s*\[TOC\]\s*$|\{[.#][^}\n]+\}|==[^=\n]+==|(?:^|\s)\^[\w-]+\s*$|^\s*>\s*\[![A-Z]+\]/m.test(prose)) {
    return '文档含暂不支持的扩展语法，已启用源码保护';
  }
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

/** Formatting normalization is accepted only when CommonMark/GFM structure agrees. */
export function hasEquivalentMarkdownStructure(before: string, after: string): boolean {
  return JSON.stringify(semanticTree(markdownParser.parse(before), before)) ===
    JSON.stringify(semanticTree(markdownParser.parse(after), after));
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
