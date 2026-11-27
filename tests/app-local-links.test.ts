import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

// Behavior reference: official Typora 1.14.15, recorded in docs/typora-acceptance.md.
describe('local links through the real app', () => {
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
  const other = 'D:/验收/Other.MD', pdf = 'D:/验收/Doc.pdf';
  async function open(source: string, config = {}) {
    await openFileApp(page, baseURL, {
      files: { [currentFile]: source, [other]: '# Other\n\n## Target\n' },
      linkTargets: { 'Other.MD': { path: other, markdown: true }, Other: { path: other, markdown: true }, 'Doc.pdf': { path: pdf, markdown: false } },
      ...config,
    });
    await focusApp(page, 'rich');
  }
  const click = (label: string) => page.locator('.ProseMirror :is(.md-link, .md-html-link)').filter({ hasText: label }).click({ modifiers: ['Control'] });
  const calls = (cmd: string) => page.evaluate(cmd => (window as any).fileApp.calls.filter((c: any) => c.cmd === cmd).map((c: any) => c.args), cmd);
  const selection = () => page.evaluate(() => {
    const s = (window as any).fileApp.surface.richView().state.selection;
    return [s.$from.parent.textContent, s.$from.parentOffset, s.from];
  });
  it.each(['Other.MD', 'Other', 'Other.MD#Target'])('opens %s through the document session', async href => {
    await open('[跳转](' + href + ')\n');
    await click('跳转');
    await page.waitForFunction(path => (window as any).fileApp.session.path === path, other);
    await page.locator('.ProseMirror h2').waitFor();
    expect(await calls('resolve_document_link')).toEqual([{ documentPath: currentFile, address: href.split('#')[0] }]);
    if (href.includes('#')) expect((await selection()).slice(0, 2)).toEqual(['Target', 0]);
  });
  it('respects the unsaved prompt and only jumps after the file opens', async () => {
    await open('[跳转](Other#Target)\n\n尾\n');
    await page.locator('.ProseMirror p').last().click(); await page.keyboard.press('End'); await page.keyboard.type('!');
    await click('跳转');
    await page.getByRole('button', {name:'取消',exact:true}).click();
    expect(await page.evaluate(() => (window as any).fileApp.surface.getMarkdown())).toBe('[跳转](Other#Target)\n\n尾!\n');
    expect((await calls('read_document')).map(a=>a.path)).toEqual([currentFile]);
    await click('跳转'); await page.getByRole('button', {name:'不保存',exact:true}).click();
    await page.locator('.ProseMirror h2').waitFor();
    expect((await selection()).slice(0, 2)).toEqual(['Target', 0]);
  });
  it('reveals other files and reports missing targets', async () => {
    await open('<a href="Doc.pdf">资料</a> 和 [丢失](missing.md)\n');
    await click('资料'); expect(await calls('reveal_export')).toEqual([{path:pdf}]);
    await click('丢失'); expect(await page.locator('#toast').textContent()).toBe('找不到文件：missing.md');
  });
  it('asks to save a new document before resolving relative paths', async () => {
    await open('', { initial: null });
    await page.evaluate(async () => { await (window as any).fileApp.surface.load('[链接](missing.md)\n'); });
    await click('链接'); expect(await page.locator('#toast').textContent()).toContain('请先保存文档');
    expect(await calls('resolve_document_link')).toEqual([{documentPath:null,address:'missing.md'}]);
  });
  it('matches custom IDs, decoded titles, numbered duplicates and Typora slugs', async () => {
    await open('[自定](#mine) [中文](#%E4%B8%AD%E6%96%87) [重复](#中文-1) [别名](#hello-world) [缺少](#无此标题)\n\n# 自定义 {#mine}\n\n# 中文\n\n# 中文\n\n# Hello, World!\n');
    await click('自定'); expect((await selection()).slice(0,2)).toEqual(['自定义 {#mine}',0]);
    await click('中文'); const first = await selection(); expect(first.slice(0,2)).toEqual(['中文',0]);
    await click('重复'); const second = await selection(); expect(second.slice(0,2)).toEqual(['中文',0]); expect(second[2]).toBeGreaterThan(first[2]);
    await click('别名'); expect((await selection()).slice(0,2)).toEqual(['Hello, World!',0]);
    await click('缺少'); expect(await page.locator('#toast').textContent()).toBe('找不到标题：无此标题');
  });
  it('switches the actual hovered cursor on stationary Ctrl, move and blur', async () => {
    await open('[目标](Other.MD) 普通文字\n');
    const link = page.locator('.ProseMirror .md-link'), plain = page.locator('.ProseMirror p');
    const box = (await link.boundingBox())!;
    const x = box.x + box.width/2, y = box.y + box.height/2;
    const cursor = (x: number, y: number) => page.evaluate(([x,y]) => getComputedStyle(document.elementFromPoint(x,y)!).cursor, [x,y]);
    await page.mouse.move(x,y); expect(await cursor(x,y)).not.toBe('pointer');
    await page.keyboard.down('Control'); expect(await cursor(x,y)).toBe('pointer');
    const paragraph = (await plain.boundingBox())!;
    const away = paragraph.x + paragraph.width - 1;
    await page.mouse.move(away,y); expect(await cursor(away,y)).not.toBe('pointer');
    await page.mouse.move(x,y); await page.keyboard.up('Control'); expect(await cursor(x,y)).not.toBe('pointer');
    await page.keyboard.down('Control'); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await cursor(x,y)).not.toBe('pointer'); await page.keyboard.up('Control');
  });
});
