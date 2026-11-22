import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Locator, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, openFileApp } from './app-files-fixture';

const sample = readFileSync(new URL('../examples/typora-feel.md', import.meta.url), 'utf8');
describe('writing modes through the application', () => {
  let server: ViteDevServer, browser: Browser, page: Page, url: string;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Missing test port');
    url = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => { page = await browser.newPage({ viewport: { width: 1200, height: 800 } }); });
  afterEach(async () => { await page.close(); });
  const open = async (source = sample, bom = false) => {
    await openFileApp(page, url, { files: { [currentFile]: source }, bom });
    expect(await page.evaluate(() => (window as any).fileApp.surface.mode)).toBe('rich');
  };
  const menu = async (name: string) => {
    await page.locator('[data-menu-key="v"]').click();
    await page.locator('[data-action="' + name + '"]').click();
  };
  const frames = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const scroll = () => page.locator('#editor-scroll').evaluate(el => el.scrollTop);
  const center = () => page.waitForFunction(() => {
    const view = (window as any).fileApp.surface.richView(), rect = view.coordsAtPos(view.state.selection.head);
    const box = document.querySelector('#editor-scroll')!.getBoundingClientRect();
    return Math.abs((rect.top + rect.bottom - box.top - box.bottom) / 2) <= box.height / 10;
  }, undefined, { timeout: 4000 });
  const text = () => page.evaluate(() => (window as any).fileApp.surface.getMarkdown());
  const waitForFocusedBlock = (target: Locator) =>
    target.and(page.locator('.tx-focus-block, .tx-focus-block *')).waitFor({ state: 'attached' });
  const splitMiddle = async () => {
    const paragraph = page.getByText('甲乙', { exact: true });
    await paragraph.click();
    await paragraph.evaluate(el => {
      const view = (window as any).fileApp.surface.richView(), selection = view.state.selection;
      view.dispatch(view.state.tr.setSelection(selection.constructor.create(view.state.doc, view.posAtDOM(el.firstChild!, 1))));
    });
    await page.keyboard.press('Shift+Enter');
  };
  const opacity = (selector: string) => page.locator(selector).first().evaluate(el => {
    let opacity = 1;
    for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return opacity;
  });

  it('remembers both menu and function-key switches across reload and source mode', async () => {
    await open();
    for (const [key, name] of [['F8', 'focus-mode'], ['F9', 'typewriter']]) {
      const item = page.locator('[data-action="' + name + '"]');
      await page.keyboard.press(key); expect(await item.getAttribute('aria-checked')).toBe('true');
      await menu(name); expect(await item.getAttribute('aria-checked')).toBe('false');
      await menu(name);
    }
    await page.reload(); await page.waitForFunction(() => (window as any).fileApp?.ready);
    expect(await page.locator('#rich-root.focus-mode.typewriter').isVisible()).toBe(true);
    await page.keyboard.press('Control+/'); await page.locator('#source-root').waitFor({ state: 'visible' });
    expect(await page.locator('#rich-root').isVisible()).toBe(false);
    expect(await opacity('#source-root .cm-line')).toBe(1);
    await page.keyboard.press('Control+/'); await page.locator('#rich-root.focus-mode.typewriter').waitFor({ state: 'visible' });
  });

  it('lights one paragraph, heading, list paragraph, table row or code block, in both themes', async () => {
    await open(); await page.keyboard.press('F8');
    const rich = page.locator('#rich-root');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => (window as any).fileApp.action(theme), theme);
      for (const [selector, dim] of [['h2', 'h1'], ['.ProseMirror > p', 'h2'], ['li p', 'li li p'],
        ['tbody td p', 'th p'], ['th p', 'td p'], ['.milkdown-code-block .cm-content', 'h2']]) {
        const target = rich.locator(selector).first();
        await target.click(); await waitForFocusedBlock(target);
        expect(await opacity('#rich-root ' + selector)).toBe(1);
        expect(await opacity('#rich-root ' + dim)).toBeLessThan(0.6);
        if (selector.includes('td') || selector.includes('th')) expect(await opacity('tr.tx-focus-block > :nth-child(2) p')).toBe(1);
        if (selector === 'li p') {
          expect(await opacity('li .label-wrapper')).toBe(1);
          expect(await opacity('li li .label-wrapper')).toBeLessThan(0.6);
        }
      }
    }
    await page.keyboard.press('Control+f');
    expect(await opacity('.milkdown-code-block .cm-content')).toBe(1);
  }, 30000);

  it('centers keyboard moves and edits, leaves clicks and outline jumps alone, and removes padding on F9', async () => {
    await open();
    await page.getByText('第24段。', { exact: false }).click();
    await page.keyboard.press('F9'); await center();
    for (const key of ['ArrowDown', 'Enter', 'x', 'Backspace', 'Control+z', 'Control+y', 'Delete', 'PageDown', 'PageUp', 'Control+End', 'Control+Home']) {
      await page.keyboard.press(key); await frames();
      const offset = await page.evaluate(() => {
        const view = (window as any).fileApp.surface.richView(), r = view.coordsAtPos(view.state.selection.head);
        const box = document.querySelector('#editor-scroll')!.getBoundingClientRect();
        return (r.top + r.bottom - box.top - box.bottom) / (2 * box.height);
      });
      expect(Math.abs(offset), key).toBeLessThanOrEqual(0.1);
    }
    const heading = page.locator('#rich-root h3').first();
    const before = await scroll(); await heading.click(); await frames();
    expect(await scroll()).toBe(before);
    await page.evaluate(() => { const h = (window as any).fileApp; h.updateStats(); h.setSidebarTab('outline'); });
    await page.getByRole('button', { name: '沿途记录', exact: true }).click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#rich-root h2:last-of-type')!.getBoundingClientRect().top -
      document.querySelector('#editor-scroll')!.getBoundingClientRect().top) <= 2);
    await page.getByText('第24段。', { exact: false }).click();
    await page.keyboard.press('End'); await center();
    const position = () => page.getByText('第24段。', { exact: false }).evaluate(el => el.getBoundingClientRect().top);
    const old = await position(); await page.keyboard.press('F9'); await frames();
    expect(Math.abs(await position() - old)).toBeLessThan(2);
    expect(await page.locator('#rich-root .ProseMirror').evaluate(el => getComputedStyle(el).paddingTop)).toBe('30px');
  }, 30000);

  it('centers the actual editing line in a multi-line HTML block', async () => {
    const lines = Array.from({ length: 35 }, (_, i) => '原文第' + (i + 1) + '行');
    await open(['之前', '', '<div>', ...lines, '</div>', '', '之后'].join('\n'));
    await page.locator('.croquill-html-preview').click();
    const field = page.locator('textarea.croquill-html-source:visible');
    await field.waitFor();
    await page.keyboard.press('F9'); await page.keyboard.press('Control+End');
    await page.keyboard.type('x');
    await page.waitForFunction(() => {
      const field = document.activeElement as HTMLTextAreaElement;
      if (!field.value?.endsWith('x') || field.selectionEnd !== field.value.length) return false;
      const rect = field.getBoundingClientRect(), style = getComputedStyle(field);
      const line = rect.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom) - parseFloat(style.lineHeight) / 2;
      const viewport = document.querySelector('#editor-scroll')!.getBoundingClientRect();
      return Math.abs(line - (viewport.top + viewport.bottom) / 2) < viewport.height / 10;
    });
  });

  it('retains the composition DOM and scroll position, then centers committed text on the continuation line', async () => {
    await open();
    const paragraph = page.locator('#rich-root p').filter({ hasText: '晨光落在桥面。' });
    await paragraph.click(); await page.keyboard.press('F8'); await waitForFocusedBlock(paragraph);
    await page.keyboard.press('F9'); await center();
    await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const p = document.querySelector('.tx-focus-block')!;
      const pos = view.posAtDOM(p.lastChild, 0);
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, pos)));
      (window as any).writingBlock = p;
      document.querySelector('#editor-scroll')!.scrollTop += 130;
    });
    await frames(); const before = await scroll();
    const cdp = await page.context().newCDPSession(page);
    for (const composing of ['zhong', 'zhongwen']) {
      await cdp.send('Input.imeSetComposition', { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
      await frames();
      expect(await scroll()).toBe(before);
      expect(await page.evaluate(() => document.querySelector('.tx-focus-block') === (window as any).writingBlock)).toBe(true);
    }
    await cdp.send('Input.insertText', { text: '中文' }); await center();
    expect(await text()).toBe(sample.replace('水鸟掠过栏杆。', '中文水鸟掠过栏杆。'));
    await cdp.detach();
  });

  it.each([['LF', '\n', false], ['CRLF', '\r\n', false], ['BOM + CRLF', '\r\n', true]] as const)(
    'preserves untouched %s bytes and displays each soft break on its own line', async (_, eol, bom) => {
      const source = ['正文甲', '正文乙', '', '- 列甲', '  列乙', '', '> 引甲', '> 引乙', '', '> [!NOTE]', '> 提甲', '> 提乙', '', '::: note', '容器', ':::', ''].join(eol);
      await open(source, bom);
      const lines = await page.locator('p br[data-is-inline]').evaluateAll(breaks => breaks.map(br => {
        const rect = (node: Node) => { const r = document.createRange(); r.selectNodeContents(node); return r.getBoundingClientRect(); };
        return rect(br.nextSibling!).top > rect(br.previousSibling!).top;
      }));
      expect(lines).toEqual(Array(6).fill(true));
      await page.keyboard.press('Control+s'); await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
      const write = await page.evaluate(() => (window as any).fileApp.writes[0]);
      expect(write.newline).toBe(eol === '\n' ? 'lf' : 'crlf');
      expect(Buffer.from((write.bom ? '\uFEFF' : '') + write.text)).toEqual(Buffer.from((bom ? '\uFEFF' : '') + source));
    });

  it.each([['- ', '\\- '], ['# ', '\\# '], ['1. ', '1\\. ']])('protects %s after Shift+Enter', async (prefix, escaped) => {
    await open('甲乙\n'); await splitMiddle(); await page.keyboard.type(prefix);
    const saved = await text(); expect(saved).toBe('甲\n' + escaped + '乙\n');
    await page.evaluate(raw => (window as any).fileApp.surface.load(raw), saved);
    expect(await page.locator('.ProseMirror > p').count()).toBe(1);
  });

  it('publishes an ordinary mid-paragraph Shift+Enter through the existing long-document index', async () => {
    const source = '开头\n\n第二段\n\n甲乙\n\n第四段\n\n第五段\n\n末尾\n';
    await open(source);
    await page.evaluate(() => { (window as any).oldIndex = (window as any).fileApp.surface.blockIndex; });
    await splitMiddle();
    expect(await text()).toBe(source.replace('甲乙', '甲\n乙'));
    expect(await page.evaluate(() => !!(window as any).oldIndex && (window as any).oldIndex === (window as any).fileApp.surface.blockIndex)).toBe(true);
  });
});
