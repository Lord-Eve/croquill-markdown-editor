import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

// Behavior reference: official Typora 1.14.15, recorded in docs/typora-acceptance.md.
describe('heading level keys through the real app', () => {
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
  const text = () => page.evaluate(() => (window as any).fileApp.surface.getMarkdown());
  const waitText = (expected: string) => page.waitForFunction(expected => (window as any).fileApp.surface.getMarkdown() === expected, expected, { timeout: 5000 });
  /** Open the document, focus the mode, and put the model caret at `offset` inside the first block's text. */
  async function open(source: string, mode: string, offset = 0, bom = false) {
    await openFileApp(page, baseURL, { files: { [currentFile]: source }, bom }); await focusApp(page, mode);
    await page.evaluate(({ offset, prefix }) => {
      const s = (window as any).fileApp.surface;
      if (s.mode === 'source') s.source.dispatch({ selection: { anchor: prefix + offset } });
      else { const view = s.richView(); view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(1 + offset)))); }
      s.focus();
    }, { offset, prefix: /^#+ /.exec(source)?.[0].length ?? 0 });
  }
  /** Press each key and require the exact Markdown after it. */
  async function steps(sequence: [string, string][]) {
    for (const [key, expected] of sequence) {
      await page.keyboard.press(key);
      try { await waitText(expected); } catch { expect({ key, text: await text() }).toEqual({ key, text: expected }); }
    }
  }

  it('turns a heading into a paragraph with one Backspace at its start, as one undo step', async () => {
    const original = '### 标题甲\n\n正文乙\n';
    await open(original, 'rich');
    await steps([['Backspace', '标题甲\n\n正文乙\n'], ['Control+z', original]]);
    // A further Backspace at the start of the first block is a no-op, not a second conversion.
    await steps([['Backspace', '标题甲\n\n正文乙\n'], ['Backspace', '标题甲\n\n正文乙\n']]);
  }, 30000);

  it('keeps ordinary Backspace inside a heading, and with a selection at its start', async () => {
    await open('## 标题甲\n', 'rich', 2);
    await steps([['Backspace', '## 标甲\n']]);
    // For 200ms after the editor gains focus, ProseMirror treats "caret jumped to the very
    // start of the document" as a browser glitch and puts it back, so a Home on the first
    // line sent that soon after open() is undone (traced on 2026-11-10). Wait for that
    // window to close, then wait for the editor model after each key (the DOM caret moves
    // first, see caretTo in app-operation-focus.test.ts).
    await page.waitForFunction(() => Date.now() - (window as any).fileApp.surface.richView().input.lastFocus > 200);
    await page.keyboard.press('Home');
    await page.waitForFunction(() => { const r = (window as any).fileApp.surface.richView().state.selection; return r.empty && r.$from.parentOffset === 0; });
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(() => { const r = (window as any).fileApp.surface.richView().state.selection; return r.$from.parentOffset === 0 && r.to - r.from === 1; });
    await steps([['Backspace', '## 甲\n']]);
  }, 30000);

  it('does not convert a heading while an IME composition is active', async () => {
    const original = '## 标题甲\n';
    await open(original, 'rich');
    const prevented = await page.evaluate(() => {
      const results: boolean[] = [];
      // A real IME opens the composition before its keydowns reach the page.
      document.activeElement!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const init of [{ key: 'Backspace', code: 'Backspace' }, { key: '0', code: 'Digit0', ctrlKey: true }, { key: '=', code: 'Equal', ctrlKey: true }, { key: '-', code: 'Minus', ctrlKey: true }, { key: 'Process', code: 'Digit3', ctrlKey: true }]) {
        const event = new KeyboardEvent('keydown', { ...init, isComposing: true, bubbles: true, cancelable: true });
        document.activeElement!.dispatchEvent(event); results.push(event.defaultPrevented);
      }
      return results;
    });
    expect(prevented).toEqual([false, false, false, false, false]); expect(await text()).toBe(original);
  }, 30000);

  it.each(['rich', 'source'])('applies Ctrl+digit, Ctrl+0, Ctrl+= and Ctrl+- in %s mode', async mode => {
    await open('正文甲\n', mode);
    await steps([
      ['Control+=', '###### 正文甲\n'], ['Control+=', '##### 正文甲\n'], ['Control+-', '###### 正文甲\n'], ['Control+-', '正文甲\n'],
      ['Control+2', '## 正文甲\n'], ['Control+=', '# 正文甲\n'], ['Control+4', '#### 正文甲\n'], ['Control+4', '正文甲\n'],
      ['Control+3', '### 正文甲\n'], ['Control+0', '正文甲\n'],
    ]);
    // Keys with nothing to do leave the document alone and clean.
    for (const key of ['Control+-', 'Control+0']) await page.keyboard.press(key);
    await page.keyboard.press('Control+1'); await waitText('# 正文甲\n'); await page.keyboard.press('Control+=');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await text()).toBe('# 正文甲\n');
  }, 30000);

  it.each(['rich', 'source'])('undoes a level change in one step in %s mode', async mode => {
    const original = '## 标题甲\n\n正文乙\n';
    await open(original, mode, 1);
    await steps([['Control+5', '##### 标题甲\n\n正文乙\n'], ['Control+z', original], ['Control+0', '标题甲\n\n正文乙\n'], ['Control+z', original]]);
  }, 30000);

  for (const mode of ['rich', 'source']) for (const eol of ['\n', '\r\n']) for (const bom of [false, true]) {
    it(`changes only the heading prefix in ${mode} mode (${JSON.stringify(eol)}, BOM=${bom})`, async () => {
      // Rich mode still rewrites `*` bullets to `-` on any edit (known, docs/roadmap.md), so
      // only the source sample carries one.
      const rest = ['', '正文  两个空格', '', ...(mode === 'source' ? ['* 星号列表', ''] : []), '__加粗__ 和 *斜体*', ''].join(eol);
      await open('## 标题甲' + eol + rest, mode, 0, bom);
      // An edited rich document is handed to the native writer with LF plus the file's
      // newline kind; documents.rs restores CRLF on disk. Source mode keeps CRLF itself.
      const out = (value: string) => mode === 'rich' ? value.replace(/\r\n/g, '\n') : value;
      await steps([['Control+3', out('### 标题甲' + eol + rest)], ['Control+0', out('标题甲' + eol + rest)], ['Control+=', out('###### 标题甲' + eol + rest)]]);
      await page.keyboard.press('Control+s');
      await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
      const write = await page.evaluate(() => (window as any).fileApp.writes[0]);
      expect(write.bom).toBe(bom); expect(write.newline).toBe(eol === '\r\n' ? 'crlf' : 'lf');
      expect(write.text).toBe(out('###### 标题甲' + eol + rest));
    }, 30000);
  }

  it('offers the Typora paragraph-menu entries', async () => {
    await open('正文甲\n', 'rich');
    const items = await page.locator('summary[data-menu-key="p"]').locator('..').locator('.menu button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.format).filter(Boolean));
    expect(items).toEqual(expect.arrayContaining(['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'paragraph', 'heading-up', 'heading-down']));
    await page.evaluate(() => (document.querySelector('.menubar [data-format="heading-up"]') as HTMLElement).click());
    await waitText('###### 正文甲\n');
  }, 30000);
});
