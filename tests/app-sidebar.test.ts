import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';

// Exercise the real sidebar -> main.run -> DocumentSession boundary, including
// an input still waiting for the editor's 300ms serialization timer.
describe('file sidebar in the application shell', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer();
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.route('**/src/main.ts', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()) + '\nwindow.shellTest={surface,session,fileSidebar,setSidebarTab,action};' });
    });
    await page.goto(baseURL);
    await page.waitForFunction(() => !!(window as any).shellTest);
    await page.evaluate(async () => {
      const h = (window as any).shellTest;
      h.writes = []; h.reads = []; h.confirmations = 0; h.choice = 'cancel';
      h.session.port.confirmSave = async () => { h.confirmations++; return h.choice; };
      h.session.port.write = async (path: string, text: string) => {
        h.writes.push({ path, text }); return { revision: 'saved' };
      };
      h.session.port.read = async (path: string) => {
        h.reads.push(path);
        if (h.readError) throw Error('测试读取失败');
        return { path, text: '下一篇\n', bom: false, newline: 'lf', revision: 'next' };
      };
      h.session.path = 'D:/笔记/当前.md';
      h.session.edit('原文\n'); h.session.savedText = '原文\n';
      await h.surface.load('原文\n');
      h.fileSidebar.options.pickFolder = async () => 'D:/笔记';
      h.fileSidebar.options.listFolder = async () => ({ root: 'D:/笔记', path: 'D:/笔记', entries: [
        { name: '当前.md', path: 'D:/笔记/当前.md', isDirectory: false },
        { name: '下一篇.md', path: 'D:/笔记/下一篇.md', isDirectory: false },
      ] });
      await h.fileSidebar.chooseFolder();
      h.fileSidebar.setActiveFile(h.session.path);
      h.setSidebarTab('files');
      h.insert = (text: string) => {
        const view = h.surface.richView();
        view.dispatch(view.state.tr.insertText(text, view.state.doc.firstChild.nodeSize - 1));
      };
      h.clickNext = () => {
        const row = [...document.querySelectorAll<HTMLButtonElement>('#files-pane .file-row')]
          .find(button => button.textContent?.includes('下一篇.md'));
        if (!row) throw Error('Missing next document row');
        row.click();
      };
    });
  });
  afterEach(async () => {
    await page?.evaluate(async () => { await (window as any).shellTest?.surface.destroy(); });
    await page?.close();
  });

  it.each(['cancel', 'discard', 'save'] as const)('respects %s when switching immediately after an edit', async choice => {
    const pending = await page.evaluate(choice => {
      const h = (window as any).shellTest;
      h.choice = choice; h.insert('末字');
      const beforeSwitch = { text: h.session.text, dirty: h.session.dirty };
      h.clickNext();
      return beforeSwitch;
    }, choice);
    expect(pending).toEqual({ text: '原文\n', dirty: true });
    await page.waitForFunction(() => (window as any).shellTest.confirmations === 1 && !document.querySelector<HTMLElement>('#editor-scroll')!.inert);
    const result = await page.evaluate(() => {
      const h = (window as any).shellTest;
      return { path: h.session.path, text: h.surface.getMarkdown(), dirty: h.session.dirty, writes: h.writes, reads: h.reads };
    });
    if (choice === 'cancel') {
      expect(result).toEqual({ path: 'D:/笔记/当前.md', text: '原文末字\n', dirty: true, writes: [], reads: [] });
    } else {
      expect(result.path).toBe('D:/笔记/下一篇.md');
      expect(result.text).toBe('下一篇\n');
      expect(result.dirty).toBe(false);
      expect(result.reads).toEqual(['D:/笔记/下一篇.md']);
      expect(result.writes).toEqual(choice === 'save' ? [{ path: 'D:/笔记/当前.md', text: '原文末字\n' }] : []);
    }
  });

  it('retains the current document when reading a selected file fails', async () => {
    await page.evaluate(() => {
      const h = (window as any).shellTest;
      h.choice = 'discard'; h.readError = true; h.insert('保留'); h.clickNext();
    });
    await page.locator('.app-dialog').waitFor();
    expect(await page.locator('.app-dialog').innerText()).toContain('测试读取失败');
    await page.getByRole('button', { name: '返回文档' }).click();
    const result = await page.evaluate(() => {
      const h = (window as any).shellTest;
      return { path: h.session.path, text: h.surface.getMarkdown(), dirty: h.session.dirty, writes: h.writes };
    });
    expect(result).toEqual({ path: 'D:/笔记/当前.md', text: '原文保留\n', dirty: true, writes: [] });
  });

  it('keeps pending input while switching tabs, resizing and hiding the sidebar', async () => {
    await page.evaluate(() => (window as any).shellTest.insert('界面操作'));
    await page.locator('#outline-tab').click();
    expect(await page.locator('#outline-tab').getAttribute('aria-selected')).toBe('true');
    expect(await page.locator('#outline-pane').isVisible()).toBe(true);
    expect(await page.locator('#files-pane').isVisible()).toBe(false);
    await page.locator('#files-tab').click();
    const before = (await page.locator('#sidebar').boundingBox())!.width;
    await page.locator('#sidebar-resize').focus();
    await page.keyboard.press('ArrowRight');
    const after = (await page.locator('#sidebar').boundingBox())!.width;
    expect(after).toBeGreaterThan(before);
    await page.locator('.statusbar [data-action="sidebar"]').click();
    expect(await page.locator('#sidebar').isVisible()).toBe(false);
    await page.locator('.statusbar [data-action="sidebar"]').click();
    expect(await page.locator('#sidebar').isVisible()).toBe(true);
    const result = await page.evaluate(() => {
      const h = (window as any).shellTest;
      return { text: h.surface.getMarkdown(), dirty: h.session.dirty, confirmations: h.confirmations, writes: h.writes };
    });
    expect(result).toEqual({ text: '原文界面操作\n', dirty: true, confirmations: 0, writes: [] });
  });

  it('keeps the shell within a 760px window in both themes', async () => {
    await page.setViewportSize({ width: 760, height: 540 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const layout = await page.evaluate(() => {
        const workspace = document.querySelector('.workspace')!;
        const status = document.querySelector('.statusbar')!;
        const editor = document.querySelector('#editor-scroll')!;
        return {
          body: document.body.scrollWidth <= innerWidth,
          workspace: workspace.scrollWidth <= workspace.clientWidth,
          status: status.scrollWidth <= status.clientWidth,
          editor: editor.scrollWidth <= editor.clientWidth,
        };
      });
      expect(layout).toEqual({ body: true, workspace: true, status: true, editor: true });
    }
  });
});
