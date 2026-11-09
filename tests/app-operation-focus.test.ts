import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

describe('editor focus and history across application operations', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('No server');
    baseURL = 'http://127.0.0.1:' + address.port; browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => { page = await browser.newPage({ viewport: { width: 1200, height: 850 } }); });
  afterEach(async () => { await page?.evaluate(() => (window as any).fileApp?.surface.destroy()); await page?.close(); });
  const idle = () => page.waitForFunction(() => !document.querySelector<HTMLElement>('#editor-scroll')!.inert);
  const text = () => page.evaluate(() => (window as any).fileApp.surface.getMarkdown());
  const focused = () => page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.tagName, editor: !!active?.closest('.ProseMirror, .cm-content') };
  });
  async function paste(value = '粘贴内容') {
    await page.evaluate(value => {
      const data = new DataTransfer(); data.setData('text/plain', value);
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, value);
  }
  async function save() {
    await page.evaluate(() => { const h = (window as any).fileApp; h.holdWrite = true; h.releaseWrite = null; });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !!(window as any).fileApp.releaseWrite);
    // Native IPC crosses frames; an immediately resolved mock can mask inert's blur.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => (window as any).fileApp.releaseWrite()); await idle();
  }

  it.each(['rich', 'source'])('diagnoses inert blur without erasing %s history: refocus then undo', async mode => {
    const original = '原文\n';
    await openFileApp(page, baseURL, { files: { [currentFile]: original }, holdWrite: true });
    await focusApp(page, mode); await page.keyboard.press('Control+Home'); await paste();
    expect(await text()).toContain('粘贴内容');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !!(window as any).fileApp.releaseWrite);
    await page.waitForFunction(() => document.activeElement === document.body);
    expect(await focused()).toEqual({ tag: 'BODY', editor: false });
    await page.evaluate(() => (window as any).fileApp.releaseWrite()); await idle();
    // On 1c7b930 this is still BODY. Explicit focus recovers the unchanged undo stack.
    await page.evaluate(() => (window as any).fileApp.surface.focus());
    await page.keyboard.press('Control+z'); expect(await text()).toBe(original);
  }, 30000);

  it.each(['rich', 'source'])('keeps %s focus and selection after saving, so the next undo reaches the editor', async mode => {
    const original = '原文尾巴\n';
    await openFileApp(page, baseURL, { files: { [currentFile]: original } });
    await focusApp(page, mode); await page.keyboard.press('Control+Home'); await paste();
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(() => {
      const s = (window as any).fileApp.surface, r = s.mode === 'source' ? s.source.state.selection.main : s.richView().state.selection;
      return r.to > r.from;
    });
    const selection = () => page.evaluate(() => {
      const surface = (window as any).fileApp.surface;
      const range = surface.mode === 'source' ? surface.source.state.selection.main : surface.richView().state.selection;
      return { from: range.from, to: range.to, anchor: range.anchor, head: range.head };
    });
    const before = await selection(), selectedText = await page.evaluate(() => window.getSelection()?.toString()); await save();
    expect((await focused()).editor).toBe(true); expect(await selection()).toEqual(before);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selectedText);
    await page.keyboard.press('Control+z'); expect(await text()).toBe(original);
  }, 30000);

  for (const mode of ['rich', 'source']) for (const eol of ['\n', '\r\n']) for (const bom of [false, true]) {
    it(`${mode} undo/redo crosses saves byte-exactly (${JSON.stringify(eol)}, BOM=${bom})`, async () => {
      const original = ['# 标题', '', '原文__加粗__尾巴', ''].join(eol);
      await openFileApp(page, baseURL, { files: { [currentFile]: original }, bom }); await focusApp(page, mode);
      await page.keyboard.press('Control+End'); await paste('新增文本');
      const edited = await text(); expect(edited).not.toBe(original); await save();
      const bytes = (value: string) => Buffer.from((bom ? '\ufeff' : '') + value, 'utf8');
      async function written(expected: string) {
        const write = await page.evaluate(() => (window as any).fileApp.writes.at(-1));
        expect(write.bom).toBe(bom); expect(Buffer.from((write.bom ? '\ufeff' : '') + write.text, 'utf8')).toEqual(bytes(expected));
      }
      async function dirty(expected: boolean) {
        await page.waitForFunction(expected => (window as any).fileApp.session.dirty === expected &&
          document.querySelector<HTMLElement>('#dirty-dot')!.hidden === !expected && document.title.startsWith('● ') === expected, expected);
      }
      await written(edited); await dirty(false);
      await page.keyboard.press('Control+z'); await dirty(true); expect(await text()).toBe(original);
      await page.keyboard.press('Control+y'); await dirty(false); expect(await text()).toBe(edited);
      // No write is needed for the clean marker to return to the saved point.
      expect(await page.evaluate(() => (window as any).fileApp.writes.length)).toBe(1);
      await page.keyboard.press('Control+z'); await save(); await written(original); await dirty(false);
      await page.keyboard.press('Control+y'); await dirty(true); expect(await text()).toBe(edited);
      await save(); await written(edited); await dirty(false);
    }, 30000);
  }

  it.each(['rich', 'source'])('places the caret on the first click after a %s save', async mode => {
    await openFileApp(page, baseURL, { files: { [currentFile]: '第一行\n\n第二行\n' } }); await focusApp(page, mode);
    await page.keyboard.press('Control+End'); await paste(); await save();
    const point = await page.evaluate(() => {
      const surface = (window as any).fileApp.surface;
      if (surface.mode === 'source') { const rect = surface.source.coordsAtPos(1); return { x: rect.left, y: (rect.top + rect.bottom) / 2 }; }
      const rect = surface.richView().coordsAtPos(2); return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
    });
    await page.mouse.click(point.x, point.y); await page.keyboard.insertText('点');
    expect(await text()).toMatch(/^第点一行/);
  }, 30000);

  it.each(['rich', 'source'])('saves from BODY and honors a second Ctrl+S while a %s save is pending', async mode => {
    await openFileApp(page, baseURL, { files: { [currentFile]: '原文\n' }, holdWrite: true }); await focusApp(page, mode);
    await paste(); const edited = await text(); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !!(window as any).fileApp.releaseWrite);
    await page.waitForFunction(() => document.activeElement === document.body);
    expect((await focused()).tag).toBe('BODY');
    await page.keyboard.press('Control+s');
    await page.evaluate(() => { const h = (window as any).fileApp; h.holdWrite = false; h.releaseWrite(); });
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 2); await idle();
    expect((await focused()).editor).toBe(true);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect((await focused()).tag).toBe('BODY'); await save();
    expect(await page.evaluate(() => (window as any).fileApp.writes.map((write: any) => write.text))).toEqual([edited, edited, edited]);
    // Ctrl+S works without editor focus, and must not invent a new focus owner.
    expect((await focused()).tag).toBe('BODY');
  }, 30000);

  for (const mode of ['rich', 'source']) for (const command of ['folder', 'image', 'saveAs', 'open']) {
    it(`restores ${mode} focus after the native ${command} dialog completes`, async () => {
      const next = command === 'folder' ? 'D:/验收' : command === 'image' ? 'D:/图片.png' : 'D:/下一篇.md';
      await openFileApp(page, baseURL, { files: { [currentFile]: '原文尾巴\n', [next]: '新文件\n' } }); await focusApp(page, mode);
      await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => { const s = (window as any).fileApp.surface; return s.mode === 'source' ? s.source.state.selection.main.from === 1 : s.richView().state.selection.from === 2; });
      const before = await page.evaluate(() => { const s = (window as any).fileApp.surface; const r = s.mode === 'source' ? s.source.state.selection.main : s.richView().state.selection; return { from: r.from, to: r.to }; });
      await page.evaluate(({ command, next }) => {
        const h = (window as any).fileApp; h.openSelected = next; h.saveSelected = next; h.holdDialog = true; h.operation = h.action(command);
      }, { command, next });
      await page.waitForFunction(() => !!(window as any).fileApp.releaseDialog);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect((await focused()).tag).toBe('BODY');
      await page.evaluate(async () => { const h = (window as any).fileApp; h.releaseDialog(); await h.operation; }); await idle();
      expect((await focused()).editor).toBe(true);
      if (command === 'folder' || command === 'saveAs') {
        const after = await page.evaluate(() => { const s = (window as any).fileApp.surface; const r = s.mode === 'source' ? s.source.state.selection.main : s.richView().state.selection; return { from: r.from, to: r.to }; });
        expect(after).toEqual(before);
        const offset = before.from - (mode === 'rich' ? 1 : 0);
        await page.keyboard.insertText('焦点'); expect(await text()).toBe('原文尾巴\n'.slice(0, offset) + '焦点' + '原文尾巴\n'.slice(offset));
      } else if (command === 'image') {
        expect(await text()).toContain('当前.assets/图片.png');
      } else {
        expect(await text()).toBe('新文件\n'); await page.keyboard.press('Control+z'); expect(await text()).toBe('新文件\n');
      }
    }, 30000);
  }

  it.each(['rich', 'source'])('focuses the replacement editor after %s mode switches and new documents', async mode => {
    await openFileApp(page, baseURL); await focusApp(page, mode); await page.keyboard.press('Control+/'); await idle();
    expect((await focused()).editor).toBe(true);
    expect(await page.evaluate(() => (window as any).fileApp.surface.mode)).toBe(mode === 'rich' ? 'source' : 'rich');
    await page.keyboard.press('Control+n'); await idle(); expect((await focused()).editor).toBe(true);
    await page.keyboard.insertText('新文档'); expect(await text()).toBe('新文档\n');
  }, 30000);

  it.each(['rich', 'source'])('retains %s focus on canceled native dialogs', async mode => {
    await openFileApp(page, baseURL); await focusApp(page, mode);
    for (const command of ['saveAs', 'open', 'image', 'folder']) {
      await page.evaluate(command => {
        const h = (window as any).fileApp; h.holdDialog = true; h.releaseDialog = null; h.operation = h.action(command);
      }, command);
      await page.waitForFunction(() => !!(window as any).fileApp.releaseDialog);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(async () => { const h = (window as any).fileApp; h.releaseDialog(); await h.operation; });
      expect((await focused()).editor).toBe(true);
    }
  }, 30000);

  it.each(['rich', 'source'])('focuses %s after image insertion starts with sidebar focus', async mode => {
    await openFileApp(page, baseURL, { openSelected: 'D:/图片.png' }); await focusApp(page, mode);
    await page.evaluate(() => document.querySelector<HTMLElement>('#files-tab')!.focus());
    await page.evaluate(async () => (window as any).fileApp.action('image')); await idle();
    expect((await focused()).editor).toBe(true);
    await page.evaluate(mode => {
      document.querySelector<HTMLElement>('#files-tab')!.focus();
      const data = new DataTransfer(); data.items.add(new File(['png'], '拖入.png', { type: 'image/png' }));
      const root = document.querySelector(mode === 'rich' ? '#rich-root' : '#source-root')!, rect = root.getBoundingClientRect();
      root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.x + 30, clientY: rect.y + 40 }));
    }, mode);
    await page.waitForFunction(() => (window as any).fileApp.calls.filter((call: any) => call.cmd === 'import_image').length === 2); await idle();
    expect((await focused()).editor).toBe(true);
  }, 30000);

  it.each(['rich', 'source'])('focuses the reloaded document after Save As rebases images from %s mode', async mode => {
    await openFileApp(page, baseURL, { files: { [currentFile]: '文字\n\n![图](image.png)\n' }, saveSelected: 'D:/新目录/副本.md' });
    await focusApp(page, mode); await page.keyboard.press('Control+Home'); await paste();
    await page.keyboard.press('Control+Shift+s'); await idle();
    const rebased = await text(); expect(rebased).toContain('../验收/image.png');
    expect((await focused()).editor).toBe(true);
    await page.keyboard.press('Control+z'); expect(await text()).toBe(rebased);
  }, 30000);

  it.each(['rich', 'source'])('keeps a %s save error dialog focused and restores the editor only after dismissal', async mode => {
    await openFileApp(page, baseURL, { writeError: '保存失败' }); await focusApp(page, mode);
    await page.keyboard.press('Control+s'); await page.locator('.app-dialog').waitFor();
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
    await page.getByRole('button', { name: '返回文档' }).click(); await idle(); expect((await focused()).editor).toBe(true);
  }, 30000);

  it.each(['tree', 'find', 'menu'])('does not take focus from %s when saving', async location => {
    await openFileApp(page, baseURL); await focusApp(page, location);
    await page.evaluate(() => { (window as any).beforeSaveFocus = document.activeElement; });
    await save();
    expect((await focused()).editor).toBe(false);
    if (location === 'tree') expect(await page.evaluate(() => document.activeElement === (window as any).beforeSaveFocus)).toBe(true);
  }, 30000);

  it.each(['dialog', 'popover', 'sidebar'])('does not steal focus if a %s is opened while run is pending', async target => {
    await openFileApp(page, baseURL); await focusApp(page, 'source');
    await page.evaluate(target => {
      const h = (window as any).fileApp;
      h.operation = h.run(() => new Promise(resolve => { h.finishOperation = resolve; }));
      if (target === 'sidebar') document.querySelector<HTMLElement>('#files-tab')!.focus();
      else {
        const overlay = document.createElement(target === 'dialog' ? 'dialog' : 'div');
        overlay.id = 'focus-overlay'; overlay.innerHTML = '<button>保持焦点</button>'; document.body.append(overlay);
        if (target === 'dialog') (overlay as HTMLDialogElement).showModal();
        else { overlay.setAttribute('popover', 'auto'); overlay.showPopover(); }
        overlay.querySelector('button')!.focus();
      }
      h.overlayFocus = document.activeElement;
    }, target);
    await page.evaluate(async () => { const h = (window as any).fileApp; h.finishOperation(); await h.operation; });
    expect(await page.evaluate(() => document.activeElement === (window as any).fileApp.overlayFocus)).toBe(true);
  }, 30000);
});
