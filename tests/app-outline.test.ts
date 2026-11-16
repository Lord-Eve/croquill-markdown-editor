import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

describe('outline follow, folding, and top-level alignment in real app', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;

  beforeAll(async () => {
    server = await createTestServer();
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('No server');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1200, height: 680 } });
  });

  afterEach(async () => {
    await page?.evaluate(() => (window as any).fileApp?.surface.destroy());
    await page?.close();
  });

  const settleFrames = (count = 3) =>
    page.evaluate(
      n =>
        new Promise<void>(resolve => {
          let i = 0;
          const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
      count,
    );

  async function open(source: string, extraFiles: Record<string, string> = {}) {
    await openFileApp(page, baseURL, { files: { [currentFile]: source, ...extraFiles } });
    await page.evaluate(() => {
      const h = (window as any).fileApp;
      h.updateStats();
      h.setSidebarTab('outline');
    });
    await settleFrames();
  }

  function filler(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, i) => `${prefix} 第 ${i + 1} 段较长占位文字，用于拉高页面并制造清晰滚动距离。`).join('\n\n');
  }

  it('follows viewport headings in rich and source modes under topmost/above/none rules with aria-current', async () => {
    const doc = [
      filler('前置引子', 24),
      '# 第一章',
      filler('章一正文', 20),
      '## 第一节',
      filler('节一正文', 20),
      '# 第二章',
      filler('章二正文', 12),
    ].join('\n\n');

    await open(doc);

    // Scrolled to top above first heading (no heading overlaps viewport) -> no active item
    const atTop = await page.evaluate(() => ({
      active: Array.from(document.querySelectorAll('#outline .outline-item.active')).map(el => el.textContent),
      current: Array.from(document.querySelectorAll('#outline [aria-current="true"]')).length,
    }));
    expect(atTop).toEqual({ active: [], current: 0 });

    // Scroll so 第一章 is completely above viewport and body between 第一章 & 第一节 fills viewport -> nearest above (第一章)
    await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      const headings = Array.from(document.querySelectorAll('#rich-root h1, #rich-root h2')) as HTMLElement[];
      const h0 = headings[0].getBoundingClientRect();
      const vp = scroller.getBoundingClientRect();
      scroller.scrollTop += h0.bottom - vp.top + 30;
    });
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '第一章');
    expect(await page.locator('#outline [aria-current="true"]').textContent()).toBe('第一章');

    // Scroll until 第一节 overlaps viewport while 第一章 stays above -> topmost exposed heading (第一节) wins
    await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      const headings = Array.from(document.querySelectorAll('#rich-root h1, #rich-root h2')) as HTMLElement[];
      const h1 = headings[1].getBoundingClientRect();
      const vp = scroller.getBoundingClientRect();
      scroller.scrollTop += h1.top - vp.top - 120;
    });
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '第一节');

    // Switch to source mode and scroll to 第二章 line -> source outline follows same rule
    await page.evaluate(() => (window as any).fileApp.surface.setMode('source'));
    await settleFrames();
    await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '第二章');
  });

  it('pins clicked heading across smooth scroll and near bottom until user scrolls or edits', async () => {
    const doc = [
      '# 顶部章',
      filler('顶部正文', 16),
      '# 中部章',
      filler('中部正文', 16),
      '# 底部前章',
      '普通短句。',
      '## 底部末节',
      '结尾一行。',
    ].join('\n\n');

    await open(doc);

    // Track every aria-current mutation while clicking 中部章 (smooth jump must not flash intermediate items)
    await page.evaluate(() => {
      const history: string[] = [];
      (window as any).__activeHistory = history;
      const outline = document.getElementById('outline')!;
      const obs = new MutationObserver(() => {
        const cur = outline.querySelector('[aria-current="true"]')?.textContent ?? null;
        if (cur && history[history.length - 1] !== cur) history.push(cur);
      });
      obs.observe(outline, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-current'] });
      (window as any).__activeObs = obs;
    });

    await page.locator('#outline .outline-item', { hasText: '中部章' }).click();
    await page.waitForFunction(() => {
      const s = document.getElementById('editor-scroll')!;
      return s.scrollTop > 200;
    });
    await settleFrames(8);

    const midHistory = await page.evaluate(() => {
      (window as any).__activeObs.disconnect();
      return (window as any).__activeHistory as string[];
    });
    expect(midHistory).toEqual(['中部章']);

    // Click last heading near bottom (cannot scroll to viewport top because bottom is above vpTop)
    await page.locator('#outline .outline-item', { hasText: '底部末节' }).click();
    await settleFrames(8);
    expect(await page.locator('#outline .outline-item.active').textContent()).toBe('底部末节');

    // User wheel scroll up releases bottom pin
    await page.mouse.move(600, 300);
    await page.mouse.wheel(0, -500);
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent !== '底部末节');

    // Click 底部末节 again, then edit document -> pin releases cleanly
    await page.locator('#outline .outline-item', { hasText: '底部末节' }).click();
    await settleFrames(8);
    expect(await page.locator('#outline .outline-item.active').textContent()).toBe('底部末节');

    await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      scroller.scrollTop = 0;
    });
    await focusApp(page, 'rich');
    await page.keyboard.type('X');
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '顶部章');
  });

  it('auto-scrolls active outline item into view without stealing editor focus and preserves scrollTop on rebuild', async () => {
    const headings = Array.from({ length: 40 }, (_, i) =>
      i === 38
        ? `# 长大纲标题 ${i + 1}\n\n${filler('末前段', 25)}`
        : i === 39
          ? `# 长大纲标题 ${i + 1}\n\n${filler('末段', 10)}`
          : `# 长大纲标题 ${i + 1}\n\n正文 ${i + 1}`,
    ).join('\n\n');
    await open(headings);
    await focusApp(page, 'rich');

    // Scroll to last heading so 长大纲标题 40 is the topmost exposed heading
    await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      const h40 = document.querySelectorAll('#rich-root h1')[39] as HTMLElement;
      const vp = scroller.getBoundingClientRect();
      scroller.scrollTop += h40.getBoundingClientRect().top - vp.top - 8;
    });
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '长大纲标题 40');
    await settleFrames();

    const focusAndPos = await page.evaluate(() => {
      const outline = document.getElementById('outline')!;
      const active = outline.querySelector('.outline-item.active') as HTMLElement;
      const contRect = outline.getBoundingClientRect();
      const itemRect = active.getBoundingClientRect();
      return {
        richHasFocus: (window as any).fileApp.surface.richView().hasFocus(),
        outlineScrollTop: outline.scrollTop,
        inView: itemRect.top >= contRect.top - 1 && itemRect.bottom <= contRect.bottom + 1,
      };
    });
    expect(focusAndPos.richHasFocus).toBe(true);
    expect(focusAndPos.outlineScrollTop).toBeGreaterThan(0);
    expect(focusAndPos.inView).toBe(true);

    // Manually scroll #outline to middle, place caret inside 末段, and edit -> rebuild preserves active highlight and #outline.scrollTop
    await page.evaluate(() => {
      const outline = document.getElementById('outline')!;
      outline.scrollTop = 120;
      const view = (window as any).fileApp.surface.richView();
      let pos: number | null = null;
      view.state.doc.descendants((node: any, p: number) => {
        if (pos === null && node.isText && node.text.includes('末段')) pos = p + 1;
      });
      if (pos !== null) {
        const Sel = view.state.selection.constructor;
        view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, pos)).setMeta('addToHistory', false));
        view.focus();
      }
    });
    await page.keyboard.type('A');
    await page.waitForFunction(() => (window as any).fileApp.surface.getMarkdown().includes('末A'));
    await page.evaluate(() => (window as any).fileApp.updateStats());
    await settleFrames();

    const afterRebuild = await page.evaluate(() => ({
      active: document.querySelector('#outline .outline-item.active')?.textContent,
      scrollTop: document.getElementById('outline')!.scrollTop,
    }));
    expect(afterRebuild.active).toBe('长大纲标题 40');
    expect(Math.abs(afterRebuild.scrollTop - 120)).toBeLessThanOrEqual(2);
  });

  it.each(['files tab', 'collapsed sidebar'])('reveals the already-active item when returning from the %s', async hiddenBy => {
    const doc = Array.from({ length: 40 }, (_, i) => `# 标题 ${i + 1}\n\n${filler('正文', 6)}`).join('\n\n');
    await open(doc);
    const sidebarButton = page.locator('[data-action="sidebar"].icon-button');
    if (hiddenBy === 'files tab') await page.locator('#files-tab').click();
    else await sidebarButton.click();

    await page.evaluate(() => {
      const editor = document.getElementById('editor-scroll')!;
      editor.scrollTop = editor.scrollHeight;
    });
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '标题 40');

    if (hiddenBy === 'files tab') await page.locator('#outline-tab').click();
    else await sidebarButton.click();
    await settleFrames();
    expect(await page.evaluate(() => {
      const outline = document.getElementById('outline')!;
      const item = outline.querySelector('.outline-item.active')!;
      const bounds = outline.getBoundingClientRect();
      const row = item.getBoundingClientRect();
      return { text: item.textContent, inView: row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1 };
    })).toEqual({ text: '标题 40', inView: true });
  });

  it('follows input and scroll frames without serializing before idle or during composition', async () => {
    await page.clock.install();
    await open(Array.from({ length: 40 }, (_, i) => `# 标题 ${i + 1}\n\n正文`).join('\n\n'));
    await focusApp(page, 'rich');
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    await page.evaluate(() => {
      const app = (window as any).fileApp;
      const serialize = app.surface.serializeRich.bind(app.surface);
      app.serializations = 0;
      app.surface.serializeRich = () => { app.serializations++; return serialize(); };
      app.insertInHeading = (text: string) => {
        const view = app.surface.richView();
        view.dispatch(view.state.tr.insertText(text, view.state.doc.firstChild.nodeSize - 1));
      };
    });
    const serializations = () => page.evaluate(() => (window as any).fileApp.serializations as number);
    const firstHeading = page.locator('#outline .outline-item').first();

    for (const char of 'abcdefghij') {
      await page.evaluate(text => (window as any).fileApp.insertInHeading(text), char);
      await page.clock.runFor(30);
    }
    expect(await serializations()).toBe(0);
    expect(await firstHeading.textContent()).toBe('标题 1');

    await page.evaluate(() => {
      const app = (window as any).fileApp;
      app.insertInHeading('k');
      const editor = document.getElementById('editor-scroll')!;
      editor.scrollTop = editor.scrollHeight;
      editor.dispatchEvent(new Event('scroll'));
    });
    await page.clock.runFor(30);
    expect(await serializations()).toBe(0);
    expect(await page.locator('#outline .outline-item.active').count()).toBe(1);

    await page.clock.runFor(600);
    expect(await serializations()).toBe(1);
    expect(await firstHeading.textContent()).toBe('标题 1abcdefghijk');

    await page.evaluate(() => {
      const app = (window as any).fileApp;
      app.serializations = 0;
      app.surface.richView().dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '字', bubbles: true }));
      app.insertInHeading('组词');
    });
    await page.clock.runFor(600);
    expect(await page.evaluate(() => (window as any).fileApp.surface.richView().composing)).toBe(true);
    expect(await serializations()).toBe(0);
    expect(await firstHeading.textContent()).toBe('标题 1abcdefghijk');

    await page.evaluate(() => (window as any).fileApp.surface.richView().dom.dispatchEvent(
      new CompositionEvent('compositionend', { data: '组词', bubbles: true }),
    ));
    await page.clock.runFor(600);
    expect(await serializations()).toBe(1);
    expect(await firstHeading.textContent()).toBe('标题 1abcdefghijk组词');
  });

  it('folds descendants cleanly, keeps independent child states, blocks jump auto-expand, and uses nearest visible ancestor', async () => {
    const doc = [
      '# 章',
      '### 跳级节',
      filler('跳级正文', 10),
      '## 节',
      '### 子目',
      filler('子目正文', 10),
    ].join('\n\n');
    await open(doc);

    // Total heading count includes all 4 headings regardless of collapse
    expect(await page.locator('#heading-count').textContent()).toBe('4');

    // Equal width between .outline-toggle and .outline-spacer for childless headings
    const widths = await page.evaluate(() => {
      const toggle = document.querySelector('#outline .outline-toggle')!.getBoundingClientRect().width;
      const spacer = document.querySelector('#outline .outline-spacer')!.getBoundingClientRect().width;
      return { toggle, spacer };
    });
    expect(Math.abs(widths.toggle - widths.spacer)).toBeLessThanOrEqual(1);

    // Fold 节 (index 3) via keyboard Tab + Enter; verify 子目 hides without scrolling editor
    const toggleSub = page.locator('#outline .outline-row').nth(2).locator('.outline-toggle');
    expect(await page.locator('#outline .outline-row').nth(2).innerText()).toContain('节');
    await toggleSub.focus();
    const beforeScrollTop = await page.evaluate(() => document.getElementById('editor-scroll')!.scrollTop);
    await page.keyboard.press('Enter');
    expect(await toggleSub.getAttribute('aria-expanded')).toBe('false');
    expect(await toggleSub.getAttribute('aria-label')).toBe('展开');
    expect(await page.locator('#outline .outline-row').nth(3).isHidden()).toBe(true);
    expect(await page.evaluate(() => document.getElementById('editor-scroll')!.scrollTop)).toBe(beforeScrollTop);

    // Fold 章 (index 0) via click -> 跳级节 & 节 hide; total count stays 4
    const toggleRoot = page.locator('#outline .outline-row').nth(0).locator('.outline-toggle');
    await toggleRoot.click();
    expect(await toggleRoot.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#outline .outline-row').nth(1).isHidden()).toBe(true);
    expect(await page.locator('#outline .outline-row').nth(2).isHidden()).toBe(true);
    expect(await page.locator('#heading-count').textContent()).toBe('4');

    // Scroll to 子目 while doubly folded -> highlight falls back to nearest visible ancestor (章)
    await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '章');

    // Expand 章 -> 节 stays collapsed (child collapse state preserved) & active moves to nearest visible ancestor (节)
    await toggleRoot.click();
    expect(await page.locator('#outline .outline-row').nth(1).isHidden()).toBe(false);
    expect(await page.locator('#outline .outline-row').nth(2).isHidden()).toBe(false);
    expect(await page.locator('#outline .outline-row').nth(3).isHidden()).toBe(true);
    expect(await toggleSub.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#outline .outline-item.active').textContent()).toBe('节');

    // Clicking collapsed heading's label jumps without expanding 子目
    await page.locator('#outline .outline-row').nth(2).locator('.outline-item').click();
    await settleFrames(4);
    expect(await page.locator('#outline .outline-row').nth(3).isHidden()).toBe(true);
  });

  it('distinguishes duplicate headings in collapse memory and resets on opening another file or Ctrl+N', async () => {
    const doc1 = [
      '# 一',
      '## 同名',
      '### 子甲',
      '# 二',
      '## 同名',
      '### 子乙',
    ].join('\n\n');
    const doc2 = '# 一\n\n## 同名\n\n### 子甲';

    const otherPath = currentFile.replace(/[^\\/]+$/, 'other.md');
    await open(doc1, { [otherPath]: doc2 });

    // Collapse first 同名 -> only 子甲 hides; second 同名 stays expanded (子乙 visible)
    const rows = page.locator('#outline .outline-row');
    await rows.nth(1).locator('.outline-toggle').click();
    expect(await rows.nth(2).isHidden()).toBe(true);
    expect(await rows.nth(5).isHidden()).toBe(false);

    // Edit doc1 -> rebuild keeps first 同名 collapsed
    await focusApp(page, 'rich');
    await page.keyboard.type('改动');
    await page.waitForFunction(() => document.getElementById('heading-count')?.textContent === '6');
    await settleFrames();
    expect(await rows.nth(2).isHidden()).toBe(true);

    // Discard & open another document via file sidebar -> collapse state clears
    await page.evaluate(async nextPath => {
      const h = (window as any).fileApp;
      const dir = h.session.path.replace(/[\\/][^\\/]+$/, '');
      h.fileSidebar.options.pickFolder = async () => dir;
      h.fileSidebar.options.listFolder = async () => ({
        root: dir,
        path: dir,
        entries: [
          { name: '当前.md', path: h.session.path, isDirectory: false },
          { name: 'other.md', path: nextPath, isDirectory: false },
        ],
      });
      await h.fileSidebar.chooseFolder();
      h.setSidebarTab('files');
    }, otherPath);
    await page.locator('#files-pane .file-row', { hasText: 'other.md' }).click({ timeout: 1500 });
    await page.getByRole('button', { name: '不保存' }).click({ timeout: 1500 });
    await page.locator('#outline-tab').click({ timeout: 1500 });
    await page.waitForFunction(() => document.querySelectorAll('#outline .outline-row').length === 3, undefined, { timeout: 1500 });
    const rowsOther = page.locator('#outline .outline-row');
    expect(await rowsOther.nth(2).isHidden()).toBe(false);

    // Collapse again, then File -> New -> clears collapse state for fresh doc
    await rowsOther.nth(1).locator('.outline-toggle').click({ timeout: 1500 });
    expect(await rowsOther.nth(2).isHidden()).toBe(true);
    await page.locator('.menubar summary', { hasText: '文件' }).click({ timeout: 1500 });
    await page.locator('[data-action="new"]').click({ timeout: 1500 });
    await page.waitForFunction(() => document.querySelectorAll('#outline .outline-row').length === 0, undefined, { timeout: 1500 });
  });

  it('syncs outline follow on tab switch, sidebar resize, theme toggle, and excludes non-top-level headings without index drift', async () => {
    const doc = [
      '# 保护 {#raw-1}',
      filler('上段', 10),
      '> # 引用内标题（不进大纲）',
      '',
      '- # 列表内标题（不进大纲）',
      '',
      '<div>\n<h2>HTML内标题（不进大纲）</h2>\n</div>',
      '',
      '[^1]: # 脚注内标题（不进大纲）',
      '',
      '# 正常 [[wiki]] 标题',
      filler('中段', 10),
      '## 末尾常规标题',
      filler('底段', 6),
    ].join('\n\n');

    await open(doc);

    const texts = await page.locator('#outline .outline-item').allTextContents();
    expect(texts).toEqual(['保护 {#raw-1}', '正常 [[wiki]] 标题', '末尾常规标题']);

    // Switch to Files tab, scroll down to 末尾常规标题, switch back to Outline tab -> syncs immediately
    await page.evaluate(() => (window as any).fileApp.setSidebarTab('files'));
    await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      scroller.scrollTop = scroller.scrollHeight - 200;
    });
    await page.locator('#outline-tab').click();
    await page.waitForFunction(() => document.querySelector('#outline .outline-item.active')?.textContent === '末尾常规标题');

    // Clicking middle raw heading jumps cleanly to the exact 正常 [[wiki]] 标题 raw block (not HTML or normal heading)
    await page.locator('#outline .outline-item').nth(1).click();
    await settleFrames(8);
    expect(await page.locator('#outline .outline-item.active').textContent()).toBe('正常 [[wiki]] 标题');

    // Switch light <-> dark theme and verify active text contrast differs from background
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const colors = await page.evaluate(() => {
        const btn = document.querySelector('#outline .outline-item.active') as HTMLElement;
        const style = getComputedStyle(btn);
        return { color: style.color, bg: style.backgroundColor };
      });
      expect(colors.color).not.toBe(colors.bg);
    }

    // Resize sidebar narrows width -> still updates outline follow cleanly
    await page.setViewportSize({ width: 780, height: 500 });
    await settleFrames();
    expect(await page.locator('#outline .outline-item.active').count()).toBe(1);
  });
});
