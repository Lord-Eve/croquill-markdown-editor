import type { EditorView } from '@milkdown/kit/prose/view';
import { parseMarkdownAst, preservedMarkdownBlocks, splitFrontmatter } from './fidelity';
import { findSourceMatches, type SearchMatch, type SearchOptions } from './search-core';
import { createSourceSegmentLookup, type SourceSegmentLookup } from './mode-position';

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
    const nodes = parseMarkdownAst(body).children;
    const segmentsAt = createSourceSegmentLookup(body, prefix.length);
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
      const visible = this.visibleRanges(dom, query, options, source, view, segmentsAt);
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
  private visibleRanges(element: HTMLElement, query: string, options: SearchOptions, source: string, view: EditorView, segmentsAt: SourceSegmentLookup): Range[] {
    const groups = new Map<Element, (Text | HTMLBRElement)[]>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text || node instanceof HTMLBRElement) || node instanceof HTMLBRElement && node.classList.contains('ProseMirror-trailingBreak')) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest('[data-croquill-toc],[data-footnote-tooltip],button,input,textarea,.cm-gutters,.katex-mathml')) continue;
      const group = parent.closest('p,h1,h2,h3,h4,h5,h6,pre,dt,.cm-line') || element;
      if (!groups.has(group)) groups.set(group, []); groups.get(group)!.push(node);
    }
    const ranges: Range[] = [];
    for (const nodes of groups.values()) {
      // A rendered break occupies a DOM node even when its source is CRLF,
      // a backslash + newline, or a literal <br>. Never join its adjacent words.
      let breaks: Map<number, string> | undefined;
      const parts = nodes.map(node => {
        if (node instanceof Text) return node.data;
        const pos = view.state.doc.resolve(view.posAtDOM(node, 0, -1));
        if (pos.nodeAfter?.type.name !== 'hardbreak') return '\n';
        if (!breaks) {
          const segments = segmentsAt(pos) || [];
          breaks = new Map(segments.filter(s => s.kind === 'gap').map(s => [s.pmFrom, source.slice(s.rawFrom, s.rawTo)]));
        }
        return breaks.get(pos.parentOffset) ?? (pos.nodeAfter.attrs.croquillHtmlBreak || '\n');
      });
      const joined = parts.join('');
      for (const match of findSourceMatches(joined, query, options)) {
        let offset = 0; const range = document.createRange(); let started = false;
        for (const [i, node] of nodes.entries()) {
          const end = offset + parts[i].length;
          if (!started && match.from < end) {
            if (node instanceof Text) range.setStart(node, match.from - offset);
            else range.setStartBefore(node);
            started = true;
          }
          if (started && match.to <= end) {
            if (node instanceof Text) range.setEnd(node, match.to - offset);
            else range.setEndAfter(node);
            ranges.push(range); break;
          }
          offset = end;
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
    while (parent) {
      const viewport = parent === document.scrollingElement;
      if (parent.scrollHeight > parent.clientHeight && (viewport || /auto|scroll/.test(getComputedStyle(parent).overflowY))) {
        const rect = range!.getClientRects()[0];
        const top = viewport ? 0 : parent.getBoundingClientRect().top + parent.clientTop;
        if (rect && (rect.top < top || rect.bottom > top + parent.clientHeight)) {
          parent.scrollTop += (rect.top + rect.bottom - parent.clientHeight) / 2 - top;
        }
      }
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
