import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { EditorView } from '@milkdown/kit/prose/view';
import { preservedMarkdownBlocks, splitFrontmatter } from './fidelity';
import { findSourceMatches, type SearchMatch, type SearchOptions } from './search-core';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
let sequence = 0;

/** Paint DOM ranges without inserting markup into the editable document. */
export class RichSearchPainter {
  private readonly name = `croquill-search-${++sequence}`;
  private readonly currentName = this.name + '-current';
  private readonly style = document.createElement('style');
  private ranges: (Range | undefined)[] = [];
  constructor(private readonly root: HTMLElement) {
    this.style.textContent = `::highlight(${this.name}){background:#ffe18a;color:#222}::highlight(${this.currentName}){background:#ffab53;color:#111}`;
    document.head.append(this.style);
  }
  paint(source: string, view: EditorView, matches: SearchMatch[], current: number, query: string, options: SearchOptions): void {
    this.clear(); if (!matches.length) return;
    const { prefix, body } = splitFrontmatter(source);
    const nodes = parser.parse(body).children;
    const protectedBlocks = preservedMarkdownBlocks(body);
    const blocks: { from: number; to: number }[] = [];
    for (const node of nodes) {
      const from = node.position?.start.offset, to = node.position?.end.offset;
      if (from == null || to == null) continue;
      const opaque = protectedBlocks.find(block => from >= block.from && from < block.to);
      if (opaque) { if (from === opaque.from) blocks.push({ from: prefix.length + opaque.from, to: prefix.length + opaque.to }); }
      else blocks.push({ from: prefix.length + from, to: prefix.length + to });
    }
    const rich: { position: number; node: typeof view.state.doc }[] = [];
    view.state.doc.forEach((node, position) => rich.push({ node, position }));
    this.ranges = Array(matches.length);
    let richIndex = 0, matchIndex = 0;
    blocks.forEach(block => {
      while (richIndex < rich.length - 1 && rich[richIndex].node.type.name === 'paragraph' && !rich[richIndex].node.content.size) richIndex++;
      const target = rich[richIndex++]; if (!target) return;
      const dom = view.nodeDOM(target.position); if (!(dom instanceof HTMLElement)) return;
      while (matchIndex < matches.length && matches[matchIndex].from < block.from) matchIndex++;
      const indices: number[] = [];
      while (matchIndex < matches.length && matches[matchIndex].from < block.to) indices.push(matchIndex++);
      if (!indices.length) return;
      const visible = this.visibleRanges(dom, query, options);
      indices.forEach((index, ordinal) => {
        if (visible[ordinal]) this.ranges[index] = visible[ordinal];
        else { const range = document.createRange(); range.selectNodeContents(dom); this.ranges[index] = range; }
      });
    });
    // A match on a hidden inline marker (searching for ** or ==) would be painted on
    // nothing. Show every marker while such a search is on screen; this is a class on
    // the root only, so the document and the painted ranges are untouched.
    const hidden = (node: Node) => !!(node instanceof Element ? node : node.parentElement)?.closest('.md-marker.md-hidden');
    this.root.classList.toggle('md-reveal-markers', this.ranges.some(range => !!range && (hidden(range.startContainer) || hidden(range.endContainer))));
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(this.name, new Highlight(...this.ranges.filter((range): range is Range => !!range)));
      const selected = this.ranges[current]; if (selected) CSS.highlights.set(this.currentName, new Highlight(selected));
    }
  }
  private visibleRanges(element: HTMLElement, query: string, options: SearchOptions): Range[] {
    const groups = new Map<Element, Text[]>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[data-croquill-toc],[data-footnote-tooltip],button,input,textarea,.cm-gutters,.katex-mathml')) continue;
      const group = parent.closest('p,h1,h2,h3,h4,h5,h6,pre,dt,.cm-line') || element;
      if (!groups.has(group)) groups.set(group, []); groups.get(group)!.push(node as Text);
    }
    const ranges: Range[] = [];
    for (const texts of groups.values()) {
      const joined = texts.map(text => text.data).join('');
      for (const match of findSourceMatches(joined, query, options)) {
        let offset = 0; const range = document.createRange(); let started = false;
        for (const text of texts) {
          if (!started && match.from < offset + text.length) { range.setStart(text, match.from - offset); started = true; }
          if (started && match.to <= offset + text.length) { range.setEnd(text, match.to - offset); ranges.push(range); break; }
          offset += text.length;
        }
      }
    }
    return ranges;
  }
  reveal(index: number): void {
    const range = this.ranges[index], element = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
    if (!element) { this.root.scrollIntoView({ block: 'start' }); return; }
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    let parent: HTMLElement | null = element instanceof HTMLElement ? element : element.parentElement;
    while (parent && parent !== this.root.parentElement) {
      if (parent.scrollWidth > parent.clientWidth && /auto|scroll/.test(getComputedStyle(parent).overflowX)) {
        const rect = range!.getBoundingClientRect(), bounds = parent.getBoundingClientRect();
        if (rect.right > bounds.right) parent.scrollLeft += rect.right - bounds.right + 12;
        if (rect.left < bounds.left) parent.scrollLeft -= bounds.left - rect.left + 12;
      }
      parent = parent.parentElement;
    }
  }
  clear(): void {
    if (typeof CSS !== 'undefined' && CSS.highlights) { CSS.highlights.delete(this.name); CSS.highlights.delete(this.currentName); }
    this.ranges = []; this.root.classList.remove('md-reveal-markers');
  }
  destroy(): void { this.clear(); this.style.remove(); }
}
