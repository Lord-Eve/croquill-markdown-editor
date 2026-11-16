import type { MarkdownOutlineItem } from './fidelity';

/** Structural metadata for an outline heading item. */
export interface OutlineMeta {
  key: string;
  parent: number;
  endIndex: number;
  hasChildren: boolean;
}

/** Vertical viewport coordinates (CSS px) of an outline heading in the active editor. */
export interface OutlineHeadingBox {
  top: number;
  bottom: number;
}

const OVERLAP_EPS = 0.5;
const PIN_SCROLL_TOLERANCE = 1.5;

/** Computes parent/child ranges and duplicate-safe identity keys for outline items. */
export function buildOutlineMeta(headings: readonly Pick<MarkdownOutlineItem, 'level' | 'text'>[]): OutlineMeta[] {
  const meta: OutlineMeta[] = new Array(headings.length);
  const counts = new Map<string, number>();
  const stack: number[] = [];

  for (let i = 0; i < headings.length; i++) {
    const { level, text } = headings[i];
    while (stack.length > 0 && headings[stack[stack.length - 1]].level >= level) {
      const closed = stack.pop()!;
      meta[closed].endIndex = i;
      meta[closed].hasChildren = i > closed + 1;
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : -1;
    const base = `${level}\0${text}`;
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    meta[i] = { key: `${base}\0${occurrence}`, parent, endIndex: headings.length, hasChildren: false };
    stack.push(i);
  }

  while (stack.length > 0) {
    const closed = stack.pop()!;
    meta[closed].endIndex = headings.length;
    meta[closed].hasChildren = headings.length > closed + 1;
  }

  return meta;
}

/** Returns true when any ancestor with children is currently collapsed. */
export function isOutlineHeadingHidden(
  meta: readonly OutlineMeta[],
  collapsedKeys: ReadonlySet<string>,
  index: number,
): boolean {
  let parent = meta[index]?.parent ?? -1;
  while (parent !== -1) {
    const item = meta[parent];
    if (item.hasChildren && collapsedKeys.has(item.key)) return true;
    parent = item.parent;
  }
  return false;
}

/** Falls back to the nearest visible ancestor when targetIndex is hidden inside a collapsed branch. */
export function visibleOutlineTarget(
  meta: readonly OutlineMeta[],
  collapsedKeys: ReadonlySet<string>,
  targetIndex: number,
): number {
  if (targetIndex < 0 || targetIndex >= meta.length) return -1;
  let visible = targetIndex;
  let parent = meta[targetIndex].parent;
  while (parent !== -1) {
    const item = meta[parent];
    if (item.hasChildren && collapsedKeys.has(item.key)) visible = parent;
    parent = item.parent;
  }
  return visible;
}

/**
 * Picks the active outline heading index for a viewport [vpTop, vpBottom]:
 * 1) topmost heading overlapping the viewport;
 * 2) nearest heading above the viewport;
 * 3) -1 when scrolled above the first heading with no overlap.
 */
export function pickVisibleHeadingIndex(
  boxes: readonly (OutlineHeadingBox | null)[],
  vpTop: number,
  vpBottom: number,
): number {
  const eps = vpBottom - vpTop > 2 * OVERLAP_EPS ? OVERLAP_EPS : 0;
  let bestIndex = -1;
  let bestTop = Infinity;

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box) continue;
    if (box.bottom > vpTop + eps && box.top < vpBottom - eps) {
      if (box.top < bestTop) {
        bestTop = box.top;
        bestIndex = i;
      }
    }
  }
  if (bestIndex !== -1) return bestIndex;

  for (let i = boxes.length - 1; i >= 0; i--) {
    const box = boxes[i];
    if (box && box.top <= vpTop + OVERLAP_EPS) return i;
  }
  return -1;
}

function createChevronSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 2.5L8 6L4 9.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export interface OutlineControllerOptions {
  container: HTMLElement;
  countEl: HTMLElement;
  scrollContainer: HTMLElement;
  measureBoxes: () => (OutlineHeadingBox | null)[];
  onJump: (index: number) => void;
  isOutlineVisible: () => boolean;
}

/** Manages the sidebar outline tree, scroll-follow highlighting, and per-document collapse memory. */
export class OutlineController {
  private headings: MarkdownOutlineItem[] = [];
  private meta: OutlineMeta[] = [];
  private rows: HTMLElement[] = [];
  private items: HTMLButtonElement[] = [];
  private toggles: (HTMLButtonElement | null)[] = [];
  private collapsedKeys = new Set<string>();
  private targetActiveIndex = -1;
  private visibleActiveIndex = -1;
  private pinnedIndex: number | null = null;
  private programmaticScrolling = false;
  private jumpStartScrollTop = 0;
  private jumpSawScroll = false;
  private jumpIdleFrames = 0;
  private jumpSettledScrollTop = 0;
  private jumpWatchRaf = 0;
  private syncRaf = 0;
  private revealPending = false;
  private destroyed = false;

  private readonly onUserScrollStart = () => {
    this.releasePin();
    this.scheduleSync();
  };

  private readonly onScroll = () => {
    if (this.programmaticScrolling) {
      this.jumpSawScroll = true;
      this.jumpIdleFrames = 0;
      this.jumpSettledScrollTop = this.options.scrollContainer.scrollTop;
      return;
    }
    if (this.pinnedIndex !== null) {
      const moved = Math.abs(this.options.scrollContainer.scrollTop - this.jumpSettledScrollTop);
      if (moved > PIN_SCROLL_TOLERANCE) this.pinnedIndex = null;
    }
    this.scheduleSync();
  };

  private readonly onScrollEnd = () => {
    if (!this.programmaticScrolling) return;
    this.finishJumpScroll();
  };

  constructor(private readonly options: OutlineControllerOptions) {
    const scroller = options.scrollContainer;
    scroller.addEventListener('wheel', this.onUserScrollStart, { passive: true });
    scroller.addEventListener('touchstart', this.onUserScrollStart, { passive: true });
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    scroller.addEventListener('scrollend', this.onScrollEnd, { passive: true });
  }

  /** Clears per-document collapse memory and active pin when opening/creating a document. */
  resetDocument(): void {
    this.collapsedKeys.clear();
    this.pinnedIndex = null;
    this.targetActiveIndex = -1;
    this.visibleActiveIndex = -1;
    this.stopJumpWatch();
  }

  /** Releases click pin after a real user edit and schedules outline follow update. */
  notifyDocumentEdited(): void {
    this.pinnedIndex = null;
    this.stopJumpWatch();
    this.scheduleSync();
  }

  /** Clears click pin immediately (e.g. when mode switches) without losing collapse state. */
  clearPin(): void {
    this.pinnedIndex = null;
    this.stopJumpWatch();
  }

  /** Rebuilds the outline DOM from headings while preserving scrollTop, active highlight, and collapse state. */
  rebuild(headings: MarkdownOutlineItem[]): void {
    const savedScrollTop = this.options.container.scrollTop;
    this.headings = headings;
    this.meta = buildOutlineMeta(headings);
    if (this.pinnedIndex !== null && this.pinnedIndex >= headings.length) this.pinnedIndex = null;

    this.options.countEl.textContent = String(headings.length || '');
    const frag = document.createDocumentFragment();
    this.rows = [];
    this.items = [];
    this.toggles = [];

    headings.forEach((heading, index) => {
      const itemMeta = this.meta[index];
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.dataset.index = String(index);
      row.style.setProperty('--level', String(heading.level));

      let toggleBtn: HTMLButtonElement | null = null;
      if (itemMeta.hasChildren) {
        const expanded = !this.collapsedKeys.has(itemMeta.key);
        toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'outline-toggle';
        toggleBtn.setAttribute('aria-expanded', String(expanded));
        toggleBtn.setAttribute('aria-label', expanded ? '折叠' : '展开');
        toggleBtn.append(createChevronSvg());
        toggleBtn.addEventListener('click', () => this.toggleCollapse(index));
        row.append(toggleBtn);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'outline-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        row.append(spacer);
      }

      const itemBtn = document.createElement('button');
      itemBtn.type = 'button';
      itemBtn.className = 'outline-item';
      itemBtn.textContent = heading.text;
      itemBtn.title = heading.text;
      itemBtn.addEventListener('click', () => this.jumpTo(index));
      row.append(itemBtn);

      row.hidden = isOutlineHeadingHidden(this.meta, this.collapsedKeys, index);
      frag.append(row);
      this.rows.push(row);
      this.items.push(itemBtn);
      this.toggles.push(toggleBtn);
    });

    if (!headings.length) {
      const empty = document.createElement('p');
      empty.className = 'outline-empty';
      empty.textContent = '暂无标题';
      frag.append(empty);
    }

    this.options.container.replaceChildren(frag);
    const maxScroll = Math.max(0, this.options.container.scrollHeight - this.options.container.clientHeight);
    this.options.container.scrollTop = Math.min(savedScrollTop, maxScroll);
    this.syncNow(this.visibleActiveIndex !== -1);
  }

  /** Schedules a single rAF-throttled follow sync unless mid programmatic click-scroll. */
  scheduleSync(revealIfHidden = false): void {
    if (this.destroyed) return;
    if (revealIfHidden) this.revealPending = true;
    if (this.programmaticScrolling && !this.revealPending) return;
    if (this.syncRaf) return;
    this.syncRaf = requestAnimationFrame(() => {
      this.syncRaf = 0;
      const reveal = this.revealPending;
      this.revealPending = false;
      if (!this.destroyed) this.syncNow(true, reveal);
    });
  }

  /** Synchronizes highlight immediately against current viewport or active pin. */
  syncNow(allowScrollIntoView = true, revealCurrent = false): void {
    if (!this.headings.length) {
      this.targetActiveIndex = -1;
      this.applyVisibleHighlight(-1, false);
      return;
    }

    if (this.pinnedIndex !== null && this.pinnedIndex < this.headings.length) {
      this.targetActiveIndex = this.pinnedIndex;
    } else if (!this.programmaticScrolling) {
      const vpRect = this.options.scrollContainer.getBoundingClientRect();
      const boxes = this.options.measureBoxes();
      // The published outline can be one edit behind the live ProseMirror headings.
      this.targetActiveIndex = boxes.length === this.headings.length
        ? pickVisibleHeadingIndex(boxes, vpRect.top, vpRect.bottom)
        : -1;
    }

    const visible = visibleOutlineTarget(this.meta, this.collapsedKeys, this.targetActiveIndex);
    this.applyVisibleHighlight(visible, allowScrollIntoView, revealCurrent);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.syncRaf) cancelAnimationFrame(this.syncRaf);
    this.stopJumpWatch();
    const scroller = this.options.scrollContainer;
    scroller.removeEventListener('wheel', this.onUserScrollStart);
    scroller.removeEventListener('touchstart', this.onUserScrollStart);
    scroller.removeEventListener('scroll', this.onScroll);
    scroller.removeEventListener('scrollend', this.onScrollEnd);
  }

  private toggleCollapse(index: number): void {
    const itemMeta = this.meta[index];
    if (!itemMeta?.hasChildren) return;
    if (this.collapsedKeys.has(itemMeta.key)) this.collapsedKeys.delete(itemMeta.key);
    else this.collapsedKeys.add(itemMeta.key);

    this.applyFoldVisibility();
    const visible = visibleOutlineTarget(this.meta, this.collapsedKeys, this.targetActiveIndex);
    this.applyVisibleHighlight(visible, false);
  }

  private jumpTo(index: number): void {
    if (index < 0 || index >= this.headings.length) return;
    this.pinnedIndex = index;
    this.targetActiveIndex = index;
    this.beginJumpScrollWatch();
    const visible = visibleOutlineTarget(this.meta, this.collapsedKeys, index);
    this.applyVisibleHighlight(visible, true);
    this.options.onJump(index);
  }

  private applyFoldVisibility(): void {
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i].hidden = isOutlineHeadingHidden(this.meta, this.collapsedKeys, i);
      const toggle = this.toggles[i];
      if (toggle) {
        const expanded = !this.collapsedKeys.has(this.meta[i].key);
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label', expanded ? '折叠' : '展开');
      }
    }
  }

  private applyVisibleHighlight(nextVisible: number, allowScrollIntoView: boolean, revealCurrent = false): void {
    const prevVisible = this.visibleActiveIndex;
    this.visibleActiveIndex = nextVisible;
    for (let i = 0; i < this.items.length; i++) {
      const btn = this.items[i];
      const active = i === nextVisible;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    }

    if (
      allowScrollIntoView &&
      nextVisible !== -1 &&
      (revealCurrent || nextVisible !== prevVisible) &&
      this.options.isOutlineVisible()
    ) {
      this.revealOutlineItem(this.items[nextVisible]);
    }
  }

  private revealOutlineItem(item: HTMLElement): void {
    const contRect = this.options.container.getBoundingClientRect();
    if (contRect.height <= 0) return;
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < contRect.top) {
      this.options.container.scrollTop += itemRect.top - contRect.top;
    } else if (itemRect.bottom > contRect.bottom) {
      this.options.container.scrollTop += itemRect.bottom - contRect.bottom;
    }
  }

  private releasePin(): void {
    this.pinnedIndex = null;
    this.stopJumpWatch();
  }

  private beginJumpScrollWatch(): void {
    this.stopJumpWatch();
    const scroller = this.options.scrollContainer;
    this.programmaticScrolling = true;
    this.jumpStartScrollTop = scroller.scrollTop;
    this.jumpSettledScrollTop = scroller.scrollTop;
    this.jumpSawScroll = false;
    this.jumpIdleFrames = 0;

    let prevTop = scroller.scrollTop;
    const tick = () => {
      if (!this.programmaticScrolling || this.destroyed) return;
      const curTop = scroller.scrollTop;
      if (Math.abs(curTop - prevTop) > 0.5) {
        this.jumpSawScroll = true;
        this.jumpIdleFrames = 0;
        prevTop = curTop;
      } else {
        this.jumpIdleFrames += 1;
      }
      // Smooth scroll in Chromium may take several frames before starting or emit scrollend when finished;
      // keep a conservative idle threshold so mid-animation pauses never drop the active pin early.
      const settledThreshold = this.jumpSawScroll ? 12 : 18;
      if (this.jumpIdleFrames >= settledThreshold) {
        this.finishJumpScroll();
        return;
      }
      this.jumpWatchRaf = requestAnimationFrame(tick);
    };
    this.jumpWatchRaf = requestAnimationFrame(tick);
  }

  private finishJumpScroll(): void {
    this.programmaticScrolling = false;
    this.jumpSettledScrollTop = this.options.scrollContainer.scrollTop;
    if (this.jumpWatchRaf) {
      cancelAnimationFrame(this.jumpWatchRaf);
      this.jumpWatchRaf = 0;
    }
  }

  private stopJumpWatch(): void {
    this.programmaticScrolling = false;
    if (this.jumpWatchRaf) {
      cancelAnimationFrame(this.jumpWatchRaf);
      this.jumpWatchRaf = 0;
    }
  }
}
