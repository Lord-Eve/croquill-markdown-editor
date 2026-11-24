import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

// Behavior reference: official Typora 1.14.15, recorded in docs/typora-acceptance.md.
describe('block boundary keys through the real app', () => {
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
  async function caret(label: string, end = false) {
    await page.evaluate(({label, end}) => {
      const v = (window as any).fileApp.surface.richView();
      let pos: number | undefined;
      v.state.doc.descendants((n: any, at: number) => {
        if (n.type.name === 'paragraph' && n.textContent === label) pos = at + 1 + (end ? n.content.size : 0);
      });
      if (pos === undefined) throw Error('Missing paragraph: ' + label);
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(pos))));
      v.focus();
    }, {label, end});
  }
  async function open(source: string, label = '乙') {
    await openFileApp(page, baseURL, { files: { [currentFile]: source } });
    await focusApp(page, 'rich'); await caret(label);
  }
  async function press(key: string, expected: string) {
    await page.keyboard.press(key);
    expect(await text()).toBe(expected);
  }

  const table = '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 末尾 |';
  const raw = '<div>\n\n正文中的 [TOC] 标记\n\n</div>';
  const cases = [
    ['围栏代码', '~~~js\n末尾\n~~~', '~~~js\n末尾乙\n~~~', '~~~js\n末乙\n~~~'],
    ['空代码', '~~~\n~~~', '乙', '乙'],
    ['公式', '$$\n末尾\n$$', '$$\n末尾乙\n$$', '$$\n末乙\n$$', '$$\n乙\n$$'],
    ['引用', '> 末尾', '> 末尾乙', '> 末乙'],
    ['列表', '- 末尾', '- 末尾乙', '- 末乙'],
    ['表格', table, table.replace('末尾', '末尾乙'), table.replace('末尾', '末乙'), table.replace('末尾', '乙')],
    ['分割线', '---', '乙', '乙'],
    ['HTML', '<div>x</div>', '<div>x</div>乙', '<div>x</div乙', '<div>x</di乙'],
  ];
  it.each(cases)('%s joins or removes once and keeps the caret at the seam', async (name, block, first, second, third) => {
    const original = block + '\n\n乙\n';
    await open(original);
    await press('Backspace', first + '\n');
    await press('Control+z', original);
    const selection = await page.evaluate(() => {
      const s = (window as any).fileApp.surface.richView().state.selection;
      return [s.$from.parent.type.name, s.$from.parentOffset];
    });
    expect(selection).toEqual(['paragraph', 0]);
    await press('Backspace', first + '\n');
    await press('Backspace', second + '\n');
    if (third) await press('Backspace', third + '\n');
    if (name === '公式' || name === '表格') {
      await press('Backspace', third + '\n');
      const parent = await page.evaluate(() => {
        const s = (window as any).fileApp.surface.richView().state.selection;
        return [s.$from.parent.textContent, s.$from.parentOffset];
      });
      expect(parent).toEqual(name === '表格' ? ['丙', 1] : ['乙', 0]);
    }
  });

  it.each(['[TOC]', raw, '<!-- 原文 -->'])('protects %s from repeated backspace', async block => {
    const original = block + '\n\n乙\n'; await open(original);
    for (const key of ['Backspace', 'Backspace', 'Control+z']) await press(key, original);
  });
  it.each([table, '$$\nx\n$$', '<div>块</div>', raw])('protects %s below a paragraph on Delete', async block => {
    const original = '乙\n\n' + block + '\n'; await open(original); await caret('乙', true);
    await press('Delete', original); await press('Delete', original);
  });
  it('joins the last cell inside a quote', async () => {
    const quote = (s: string) => s.split('\n').map(line => '> ' + line).join('\n');
    const original = quote(table) + '\n>\n> 乙\n';
    await open(original); await press('Backspace', quote('| 甲 | 乙   |\n| - | --- |\n| 丙 | 末尾乙 |') + '\n');
    await press('Control+z', original);
  });
  it('joins a code block in the same list item', async () => {
    const original = '- 项\n\n  ~~~\n  末尾\n  ~~~\n\n  乙\n';
    await open(original); await press('Backspace', '- 项\n\n  ```\n  末尾乙\n  ```\n');
    await press('Control+z', original);
  });
  it.each(['\n', '\r\n'])('saves only the affected blocks (%j)', async eol => {
    const make = (s: string) => ('*   原样\n\n\n' + s + '\n\n## 后记 ##\n').replaceAll('\n', eol);
    await open(make('<div>x</div>\n\n乙')); await press('Backspace', make('<div>x</div>乙'));
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
    expect(await page.evaluate(() => (window as any).fileApp.writes[0].text)).toBe(make('<div>x</div>乙'));
  });
  it.each([['公式', '$$\nx\n$$'], ['表格', table], ['HTML', '<div>x</div>']])('merges an empty paragraph into %s', async (_name, block) => {
    await open(block + '\n\n乙\n');
    await page.keyboard.press('Delete');
    const original = await text();
    await press('Backspace', block + '\n');
    await press('Control+z', original);
    expect(await page.evaluate(() => {
      const s = (window as any).fileApp.surface.richView().state.selection;
      return [s.$from.parent.type.name, s.$from.parent.content.size];
    })).toEqual(['paragraph', 0]);
  });
  it('leaves the document alone during composition', async () => {
    const original = table + '\n\n乙\n'; await open(original);
    const prevented = await page.evaluate(() => {
      const target = document.activeElement!;
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const key = new KeyboardEvent('keydown', { key: 'Backspace', isComposing: true, bubbles: true, cancelable: true });
      target.dispatchEvent(key); return key.defaultPrevented;
    });
    expect(prevented).toBe(false); expect(await text()).toBe(original);
  });
});
