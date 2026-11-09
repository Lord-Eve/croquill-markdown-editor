import { defaultSearchOptions, findSourceMatches, type SearchMatch, type SearchOptions } from './search-core';
import './search.css';

export interface SearchReplaceResult { ok: boolean; message?: string }
interface SearchHost {
  text(): string;
  paint(source: string, matches: SearchMatch[], current: number, query: string, options: SearchOptions): void;
  reveal(index: number, match: SearchMatch): void;
  replace(matches: SearchMatch[], replacement: string): SearchReplaceResult;
  clear(): void;
  focus(): void;
}

export class SearchPanel {
  readonly root = document.createElement('section');
  composing = false;
  private query: HTMLInputElement;
  private replacement: HTMLInputElement;
  private count: HTMLOutputElement;
  private context: HTMLElement;
  private error: HTMLElement;
  private options = { ...defaultSearchOptions };
  private matches: SearchMatch[] = [];
  private current = 0;
  private source = '';
  private lastQuery = '';
  private lastOptions = '';
  private refreshing = false;
  private replaceMode = false;
  constructor(private readonly host: SearchHost) {
    this.root.dataset.searchPanel = ''; this.root.hidden = true; this.root.setAttribute('aria-label', '查找替换');
    this.root.innerHTML = `<div class="search-row"><input aria-label="查找内容" placeholder="查找" autocomplete="off" spellcheck="false"><output data-search-count aria-live="polite">0 / 0</output><button type="button" data-search-command="previous" title="Shift+Enter">上一个</button><button type="button" data-search-command="next" title="Enter">下一个</button><button type="button" data-search-command="case" aria-pressed="false">区分大小写</button><button type="button" data-search-command="word" aria-pressed="false">全字匹配</button><button type="button" data-search-command="close" aria-label="关闭查找">×</button></div><div class="search-row" data-search-replace hidden><input aria-label="替换为" placeholder="替换为" autocomplete="off" spellcheck="false"><button type="button" data-search-command="replace">替换</button><button type="button" data-search-command="all">全部替换</button></div><div class="search-scope">搜索 Markdown 原文，包含标记和原文片段</div><div data-search-context aria-label="当前匹配原文"></div><div data-search-error role="status" hidden></div>`;
    this.query = this.root.querySelector<HTMLInputElement>('[aria-label="查找内容"]')!;
    this.replacement = this.root.querySelector<HTMLInputElement>('[aria-label="替换为"]')!;
    this.count = this.root.querySelector('output')!; this.context = this.root.querySelector('[data-search-context]')!; this.error = this.root.querySelector('[data-search-error]')!;
    this.query.addEventListener('input', event => { if (!this.composing && !(event as InputEvent).isComposing) this.refresh(true); });
    this.root.addEventListener('compositionstart', () => { this.composing = true; });
    this.root.addEventListener('compositionend', () => { this.composing = false; this.refresh(true); });
    this.root.addEventListener('keydown', event => {
      if (event.isComposing || this.composing) return;
      if ((event.ctrlKey || event.metaKey) && ['f', 'h'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); this.toggle(event.key.toLowerCase() === 'h'); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (event.target === this.replacement) this.replace(false); else this.move(event.shiftKey ? -1 : 1); }
    });
    this.root.addEventListener('click', event => {
      if (this.composing) return;
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-search-command]') : null;
      if (!button) return;
      switch (button.dataset.searchCommand) {
        case 'previous': this.move(-1); break;
        case 'next': this.move(1); break;
        case 'close': this.close(); break;
        case 'case': this.options.caseSensitive = !this.options.caseSensitive; button.setAttribute('aria-pressed', String(this.options.caseSensitive)); this.refresh(true); break;
        case 'word': this.options.wholeWord = !this.options.wholeWord; button.setAttribute('aria-pressed', String(this.options.wholeWord)); this.refresh(true); break;
        case 'replace': this.replace(false); break;
        case 'all': this.replace(true); break;
      }
    });
  }
  mount(before: HTMLElement): void { if (this.root.parentElement !== before.parentElement) before.before(this.root); }
  toggle(replace: boolean): void { if (!this.root.hidden && this.replaceMode === replace) this.close(); else this.open(replace); }
  open(replace: boolean, selection = ''): void {
    if (!this.root.contains(document.activeElement)) this.composing = false;
    this.root.hidden = false; this.replaceMode = replace; this.root.querySelector<HTMLElement>('[data-search-replace]')!.hidden = !replace;
    if (selection && !/[\r\n]/.test(selection)) this.query.value = selection;
    this.refresh(true, true); this.query.focus(); this.query.select();
  }
  close(): void { this.root.hidden = true; this.host.clear(); this.context.replaceChildren(); this.host.focus(); }
  documentChanged(): void { if (!this.root.hidden) this.refresh(false, true); }
  private refresh(reset = false, force = false): void {
    if (this.root.hidden || this.composing || this.refreshing) return;
    this.refreshing = true;
    try {
      const source = this.host.text(), query = this.query.value, optionKey = JSON.stringify(this.options);
      if (!force && source === this.source && query === this.lastQuery && optionKey === this.lastOptions) return;
      const position = this.matches[this.current]?.from || 0;
      this.source = source; this.lastQuery = query; this.lastOptions = optionKey;
      this.matches = findSourceMatches(source, query, this.options);
      this.current = reset ? 0 : Math.max(0, this.matches.findIndex(match => match.from >= position));
      this.paint();
      if (reset && this.matches.length) this.host.reveal(this.current, this.matches[this.current]);
    } finally { this.refreshing = false; }
  }
  private paint(): void {
    this.count.value = `${this.matches.length ? this.current + 1 : 0} / ${this.matches.length}`;
    this.context.replaceChildren(); const match = this.matches[this.current];
    if (match) {
      const mark = document.createElement('mark'); mark.textContent = this.source.slice(match.from, match.to);
      this.context.append(document.createTextNode(this.source.slice(Math.max(0, match.from - 35), match.from)), mark, document.createTextNode(this.source.slice(match.to, match.to + 35)));
    }
    this.host.paint(this.source, this.matches, this.current, this.query.value, this.options);
  }
  private move(direction: number): void {
    this.refresh(); if (!this.matches.length) return;
    this.current = (this.current + direction + this.matches.length) % this.matches.length; this.paint(); this.host.reveal(this.current, this.matches[this.current]);
  }
  private replace(all: boolean): void {
    this.refresh(); if (!this.matches.length || this.composing) return;
    const selected = all ? this.matches : [this.matches[this.current]], position = selected[0].from + this.replacement.value.length;
    const result = this.host.replace(selected, this.replacement.value);
    this.error.hidden = result.ok; this.error.textContent = result.message || '';
    if (result.ok) {
      this.refresh(false, true); this.current = Math.max(0, this.matches.findIndex(match => match.from >= position)); this.paint(); this.host.focus();
      if (this.matches.length) this.host.reveal(this.current, this.matches[this.current]);
    }
  }
  destroy(): void { this.host.clear(); this.root.remove(); }
}
