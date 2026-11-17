import { describe, expect, it } from 'vitest';
import {
  buildOutlineMeta,
  isOutlineHeadingHidden,
  pickVisibleHeadingIndex,
  visibleOutlineTarget,
} from '../src/outline-tree';

describe('outline tree and visibility rules', () => {
  it('computes parent, descendants across skipped levels, and duplicate keys', () => {
    const meta = buildOutlineMeta([
      { level: 1, text: '总览' },
      { level: 3, text: '概述' },
      { level: 2, text: '章节一' },
      { level: 2, text: '概述' },
      { level: 1, text: '总览' },
      { level: 2, text: '概述' },
    ]);

    expect(meta[0]).toEqual({ key: '1\u0000总览\u00000', parent: -1, endIndex: 4, hasChildren: true });
    expect(meta[1]).toEqual({ key: '3\u0000概述\u00000', parent: 0, endIndex: 2, hasChildren: false });
    expect(meta[2]).toEqual({ key: '2\u0000章节一\u00000', parent: 0, endIndex: 3, hasChildren: false });
    expect(meta[3]).toEqual({ key: '2\u0000概述\u00000', parent: 0, endIndex: 4, hasChildren: false });
    expect(meta[4]).toEqual({ key: '1\u0000总览\u00001', parent: -1, endIndex: 6, hasChildren: true });
    expect(meta[5]).toEqual({ key: '2\u0000概述\u00001', parent: 4, endIndex: 6, hasChildren: false });
  });

  it('hides descendants while keeping independent child collapse memory', () => {
    const meta = buildOutlineMeta([
      { level: 1, text: '章一' },
      { level: 2, text: '节一' },
      { level: 3, text: '小节一' },
      { level: 2, text: '节二' },
    ]);

    const collapsed = new Set<string>([meta[1].key, meta[0].key]);
    expect(isOutlineHeadingHidden(meta, collapsed, 0)).toBe(false);
    expect(isOutlineHeadingHidden(meta, collapsed, 1)).toBe(true);
    expect(isOutlineHeadingHidden(meta, collapsed, 2)).toBe(true);
    expect(isOutlineHeadingHidden(meta, collapsed, 3)).toBe(true);

    // Expanding 章一 leaves 节一 collapsed and 小节一 still hidden.
    collapsed.delete(meta[0].key);
    expect(isOutlineHeadingHidden(meta, collapsed, 1)).toBe(false);
    expect(isOutlineHeadingHidden(meta, collapsed, 2)).toBe(true);
    expect(isOutlineHeadingHidden(meta, collapsed, 3)).toBe(false);
  });

  it('falls back active highlight to the nearest visible ancestor when folded', () => {
    const meta = buildOutlineMeta([
      { level: 1, text: '章' },
      { level: 2, text: '节' },
      { level: 3, text: '目' },
    ]);

    expect(visibleOutlineTarget(meta, new Set(), 2)).toBe(2);
    expect(visibleOutlineTarget(meta, new Set([meta[1].key]), 2)).toBe(1);
    // Double collapse: target 小节 -> collapsed 节 -> collapsed 章, nearest visible ancestor is 章 (0).
    expect(visibleOutlineTarget(meta, new Set([meta[1].key, meta[0].key]), 2)).toBe(0);
    expect(visibleOutlineTarget(meta, new Set(), -1)).toBe(-1);
  });

  it('selects active heading by exposed overlap, nearest above, or none at document top', () => {
    const boxes = [
      { top: 120, bottom: 160 },
      { top: 520, bottom: 560 },
      { top: 960, bottom: 1000 },
    ];

    // Before first heading enters viewport (scrolled above first heading): none.
    expect(pickVisibleHeadingIndex(boxes, 0, 100)).toBe(-1);

    // First heading overlaps viewport.
    expect(pickVisibleHeadingIndex(boxes, 100, 400)).toBe(0);

    // Partially overlapping heading at top of viewport still wins.
    expect(pickVisibleHeadingIndex(boxes, 145, 450)).toBe(0);

    // Between heading 0 (above) and heading 1 (below), no overlap -> nearest above (0).
    expect(pickVisibleHeadingIndex(boxes, 200, 500)).toBe(0);

    // Heading 0 completely above, heading 1 inside viewport -> topmost overlapping heading (1) wins.
    expect(pickVisibleHeadingIndex(boxes, 170, 550)).toBe(1);

    // Scrolled past all headings -> last heading above (2).
    expect(pickVisibleHeadingIndex(boxes, 1100, 1500)).toBe(2);
  });
});
