import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { splitFrontmatter } from './fidelity';
import { applySourceChanges } from './search-core';

interface SyntaxNode { type: string; url?: string; identifier?: string; value?: string; children?: SyntaxNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }
interface ImageDestination { from: number; to: number; src: string }
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function closingBracket(raw: string, start: number): number {
  let depth = 1;
  for (let index = start + 1; index < raw.length; index++) {
    if (raw[index] === '\\') index++;
    else if (raw[index] === '[') depth++;
    else if (raw[index] === ']' && --depth === 0) return index + 1;
  }
  throw Error('无法可靠定位图片路径，尚未另存为。请在源码中检查图片语法。');
}
function markdownUrl(raw: string): string | undefined {
  return (parser.parse('![x](<' + raw + '>)') as unknown as SyntaxNode).children?.[0]?.children?.find(node => node.type === 'image')?.url;
}
function destination(raw: string, start: number, quoteDepth: number): { from: number; to: number } {
  let index = start;
  while (index < raw.length) {
    if (raw[index] === '\r' || raw[index] === '\n') {
      if (raw[index++] === '\r' && raw[index] === '\n') index++;
      for (let quote = 0; quote < quoteDepth; quote++) { while (/[ \t]/.test(raw[index] || '') && index < raw.length) index++; if (raw[index] === '>') index++; }
    } else if (/[ \t]/.test(raw[index])) index++;
    else break;
  }
  const angled = raw[index] === '<', from = angled ? ++index : index;
  let depth = 0;
  for (; index < raw.length; index++) {
    if (raw[index] === '\\') index++;
    else if (angled && raw[index] === '>') break;
    else if (!angled) {
      if (raw[index] === '(') depth++;
      else if (raw[index] === ')' && depth > 0) depth--;
      else if (raw[index] === ')' || /\s/.test(raw[index])) break;
    }
  }
  return { from, to: index };
}
function localSource(src: string): boolean {
  if (!src || /^(?:[\\/]{2}|[?#])/.test(src)) return false;
  if (/^[A-Za-z]:[\\/]/.test(src)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(src);
}
function pathEnd(raw: string, decode: (value: string) => string | undefined): number {
  // HTML accepts numeric references without a semicolon; Markdown requires it.
  // Keep the source spelling of the delimiter together with its suffix.
  for (const match of raw.matchAll(/\\[?#]|&(?:#[xX][\da-fA-F]+;?|#\d+;?|[A-Za-z][A-Za-z\d]*;)|[?#]/g)) {
    const value = decode(match[0]);
    if (value === '#' || value === '?') return match.index!;
    if (value === match[0]) { const marker = value.search(/[?#]/); if (marker >= 0) return match.index! + marker; }
  }
  return raw.length;
}
function htmlValue(raw: string): string {
  // A template is inert: decoding an attribute cannot fetch or execute the tag.
  const template = document.createElement('template'); template.innerHTML = '<img src="' + raw.replace(/"/g, '&quot;') + '">';
  return template.content.firstElementChild!.getAttribute('src') || '';
}

/** Return only real image URL ranges; code, prose, alt text and titles stay out. */
export function imageDestinations(source: string): ImageDestination[] {
  const { body, prefix } = splitFrontmatter(source), tree = parser.parse(body) as unknown as SyntaxNode;
  const references = new Set<string>(), nodes: SyntaxNode[] = [], result: ImageDestination[] = [];
  function collect(node: SyntaxNode): void { nodes.push(node); if (node.type === 'imageReference' && node.identifier) references.add(node.identifier); node.children?.forEach(collect); }
  collect(tree);
  for (const node of nodes) {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start == null || end == null) continue;
    const raw = body.slice(start, end);
    if ((node.type === 'image' || node.type === 'definition' && references.has(node.identifier || '')) && node.url && localSource(node.url)) {
      const bracket = closingBracket(raw, node.type === 'image' ? 1 : 0), offset = bracket + 1;
      const lineStart = body.lastIndexOf('\n', start - 1) + 1, quotes = (body.slice(lineStart, start).match(/>/g) || []).length;
      const range = destination(raw, offset, quotes), value = raw.slice(range.from, range.to);
      if (markdownUrl(value) !== node.url) throw Error('无法可靠定位图片路径，尚未另存为。请在源码中检查图片语法。');
      result.push({ from: prefix.length + start + range.from, to: prefix.length + start + range.from + pathEnd(value, markdownUrl), src: node.url });
    }
    if (node.type === 'html') {
      let literal: string | null = null;
      for (const token of raw.matchAll(/<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
        if (!token[2]) continue;
        const tag = token[2].toLowerCase();
        if (literal) { if (token[1] && tag === literal) literal = null; continue; }
        if (!token[1] && ['script', 'style', 'textarea'].includes(tag)) { literal = tag; continue; }
        if (token[1] || tag !== 'img') continue;
        const attribute = /\s(src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(token[0]);
        if (!attribute) continue;
        const value = attribute[2] ?? attribute[3] ?? attribute[4], src = htmlValue(value);
        if (!localSource(src)) continue;
        const valueFrom = attribute.index + attribute[0].indexOf('=') + 1;
        const relativeFrom = valueFrom + /^\s*["']?/.exec(token[0].slice(valueFrom))![0].length;
        const from = prefix.length + start + token.index! + relativeFrom;
        result.push({ from, to: from + pathEnd(value, htmlValue), src });
      }
    }
  }
  return result.sort((left, right) => left.from - right.from);
}

/** Apply native path rebasing as source patches, never serialize the document. */
export async function rebaseImageSources(source: string, resolve: (sources: string[]) => Promise<(string | null)[]>): Promise<string> {
  const destinations = imageDestinations(source); if (!destinations.length) return source;
  const unique = [...new Set(destinations.map(item => item.src))], rebased = await resolve(unique);
  if (rebased.length !== unique.length || rebased.some(value => value !== null && (typeof value !== 'string' || !value || /[\s<>"'`\\]/.test(value)))) throw Error('图片路径转换结果无效，尚未另存为。');
  const mapping = new Map(unique.map((src, index) => [src, rebased[index]]));
  return applySourceChanges(source, destinations.flatMap(item => { const insert = mapping.get(item.src)!; return insert === null ? [] : [{ from: item.from, to: item.to, insert }]; }));
}
