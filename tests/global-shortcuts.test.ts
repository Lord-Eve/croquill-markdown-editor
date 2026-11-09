import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentText, focusApp, openFileApp } from './app-files-fixture';

const locations = ['rich', 'source', 'find', 'replace', 'tree', 'outline', 'menu', 'raw', 'inline'];
describe('global shortcuts at the real application boundary', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => { server = await createTestServer(); await server.listen(); const a = server.httpServer!.address(); if (!a || typeof a === 'string') throw Error('No server'); baseURL = 'http://127.0.0.1:' + a.port; browser = await launchTestBrowser(); }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => { page = await browser.newPage(); await openFileApp(page, baseURL); });
  afterEach(async () => { await page?.evaluate(() => (window as any).fileApp?.surface.destroy()); await page?.close(); });

  it.each(locations)('saves the pending document once from %s and acknowledges success in the status bar', async location => {
    await page.evaluate(() => { const h = (window as any).fileApp, v = h.surface.richView(); v.dispatch(v.state.tr.insertText('新', 1)); });
    await focusApp(page, location); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
    expect(await page.evaluate(() => (window as any).fileApp.writes[0].text)).toBe(currentText.replace('# 标题', '# 新标题'));
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#editor-scroll')!.inert);
    expect(await page.locator('#save-status').textContent()).toContain('已保存');
  });

  it.each(locations)('routes every global command once before focused controls at %s can consume it', async location => {
    await focusApp(page, location); await page.evaluate(() => (window as any).fileApp.captureCommands());
    const commands = ['Control+s', 'Control+o', 'Control+n', 'Control+Shift+s', 'Control+f', 'Control+h', 'Control+/'];
    for (const keys of commands) await page.keyboard.press(keys);
    expect(await page.evaluate(() => (window as any).fileApp.commands)).toEqual(['save', 'open', 'new', 'saveAs', 'find', 'replace', 'mode']);
  });

  it('uses physical letter codes when the keyboard layout changes the key value', async () => {
    await page.evaluate(() => { const h = (window as any).fileApp; h.captureCommands(); document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ы', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(await page.evaluate(() => (window as any).fileApp.commands)).toEqual(['save']);
  });

  it('handles the shortcut before window-level editor capture handlers', async () => {
    await focusApp(page, 'source');
    await page.evaluate(() => { window.addEventListener('keydown', event => { if (event.ctrlKey) event.stopImmediatePropagation(); }, true); });
    await page.keyboard.press('Control+s'); expect(await page.evaluate(() => (window as any).fileApp.writes.length)).toBe(1);
  });

  it.each(['rich', 'find'])('ignores stale %s composition state after focus has moved to the sidebar', async kind => {
    await focusApp(page, 'tree'); await page.evaluate(kind => { const h = (window as any).fileApp; if (kind === 'rich') h.surface.richView().input.composing = true; else h.surface.find.composing = true; }, kind);
    await page.keyboard.press('Control+s'); expect(await page.evaluate(() => (window as any).fileApp.writes.length)).toBe(1);
  });

  it('leaves active composition alone and ignores repeat keydown', async () => {
    await page.evaluate(() => {
      const h = (window as any).fileApp; h.captureCommands();
      const view = h.surface.richView(); view.focus(); view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }));
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, repeat: true, bubbles: true, cancelable: true }));
    });
    expect(await page.evaluate(() => (window as any).fileApp.commands || [])).toEqual([]);
  });

  it('does not run file commands while the existing unsaved dialog is awaiting a decision', async () => {
    await page.evaluate(() => { const h=(window as any).fileApp,v=h.surface.richView();v.dispatch(v.state.tr.insertText('新',1)); });
    await page.keyboard.press('Control+n');await page.locator('.app-dialog').waitFor();await page.keyboard.press('Control+s');
    expect(await page.evaluate(()=>(window as any).fileApp.writes)).toEqual([]);await page.getByRole('button',{name:'取消',exact:true}).click();
    expect(await page.evaluate(()=>(window as any).fileApp.surface.getMarkdown())).toBe(currentText.replace('# 标题','# 新标题'));
  });

  it('executes a requested save after an operation already in progress finishes', async () => {
    await page.evaluate(() => { const h = (window as any).fileApp; h.run(() => new Promise(resolve => { h.finishOperation = resolve; })); });
    await page.keyboard.press('Control+s'); expect(await page.evaluate(() => (window as any).fileApp.writes.length)).toBe(0);
    await page.evaluate(() => (window as any).fileApp.finishOperation());
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
  });
});
