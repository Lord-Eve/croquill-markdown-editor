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

  it('prefers allocated heading IDs when custom IDs collide in both directions', async () => {
    await open('[甲](#甲) [乙](#甲-1)\n\n# 甲\n\n# 乙 {#甲}\n');
    await click('甲'); expect((await selection()).slice(0, 2)).toEqual(['甲', 0]);
    await click('乙'); expect((await selection()).slice(0, 2)).toEqual(['乙 {#甲}', 0]);

    await open('[甲](#乙) [乙](#乙-1)\n\n# 甲 {#乙}\n\n# 乙\n');
    await click('甲'); expect((await selection()).slice(0, 2)).toEqual(['甲 {#乙}', 0]);
    await click('乙'); expect((await selection()).slice(0, 2)).toEqual(['乙', 0]);
  });

  it('jumps to protected-block headings, sequences subsequent duplicates, and skips HTML headings', async () => {
    await open('[保护](#重名) [后续](#重名-1) [忽略](#忽略)\n\n> [!UNKNOWN]\n> # 重名\n\n中间段\n\n# 重名\n\n<div>\n\n<h1>忽略</h1>\n\n</div>\n');
    await click('保护');
    expect((await selection()).slice(0, 2)).toEqual(['中间段', 0]);
    await click('后续');
    expect((await selection()).slice(0, 2)).toEqual(['重名', 0]);
    await click('忽略');
    expect(await page.locator('#toast').textContent()).toBe('找不到标题：忽略');
  });

  it('jumps to nested headings in source mode without changing outline items', async () => {
    const doc = '# 顶层\n\n- ## 列表标题\n\n> ### 引用标题\n\n> [!NOTE]\n> #### 提示标题\n';
    await open(doc);
    await page.evaluate(async () => {
      const app = (window as any).fileApp;
      await app.surface.setMode('source');
    });
    expect(await page.evaluate(() => (window as any).fileApp.surface.getOutline().length)).toBe(1);
    for (const [fragment, expectedLine] of [['列表标题', '- ## 列表标题'], ['引用标题', '> ### 引用标题'], ['提示标题', '> #### 提示标题']] as const) {
      const lineText = await page.evaluate(fragment => {
        const s = (window as any).fileApp.surface;
        const ok = s.jumpToFragment(fragment);
        const cm = s.source;
        const line = cm.state.doc.lineAt(cm.state.selection.main.head);
        return { ok, text: line.text, offset: cm.state.selection.main.head - line.from };
      }, fragment);
      expect(lineText).toEqual({ ok: true, text: expectedLine, offset: 0 });
    }
  });

  it('matches every heading ID emitted by HTML export across rich and source modes', async () => {
    const doc = '# 甲\n\n# 乙 {#甲}\n\n- ## 列表项标题\n\n> ### 引用内标题\n\n> [!NOTE]\n> #### 提示内标题\n\n# 保护标题 [TOC]\n';
    await open(doc);
    const exportedHeadings = await page.evaluate(async markdown => {
      const { exportDocument } = await (new Function('p', 'return import(p)'))('/src/export-document.ts');
      const html = await exportDocument(markdown, 'test.md', 'light', 'html', async () => '');
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      return Array.from(parsed.querySelectorAll('#write h1,#write h2,#write h3,#write h4,#write h5,#write h6'))
        .map(el => ({ id: el.id, text: (el.textContent || '').trim() }));
    }, doc);
    expect(exportedHeadings.map(h => h.id)).toEqual(['甲', '甲-1', '列表项标题', '引用内标题', '提示内标题']);
    for (const { id, text } of exportedHeadings) {
      expect(await page.evaluate(id => (window as any).fileApp.surface.jumpToFragment(id), id)).toBe(true);
      expect((await selection())[0]).toContain(text);
    }
    expect(await page.evaluate(() => (window as any).fileApp.surface.jumpToFragment('保护标题 [TOC]'))).toBe(true);
    await page.evaluate(async () => { await (window as any).fileApp.surface.setMode('source'); });
    for (const { id, text } of [...exportedHeadings, { id: '保护标题 [TOC]', text: '保护标题 [TOC]' }]) {
      const line = await page.evaluate(id => {
        const s = (window as any).fileApp.surface;
        return s.jumpToFragment(id) ? s.source.state.doc.lineAt(s.source.state.selection.main.head).text : null;
      }, id);
      expect(line).toContain(text);
    }
  });

  it('opens allowed links inside block HTML on Ctrl+click, shows pointer on Ctrl hover, and keeps normal click editing', async () => {
    await open('<div><a href="Other.MD">本地块链</a> <a href="https://example.com">外部块链</a> <a href="#目标块">锚点块链</a> <a href="javascript:alert(1)">危险块链</a></div>\n\n<details><summary>展开</summary><a href="Other.MD">细节链接</a></details>\n\n# 目标块\n');
    const preview = page.locator('.croquill-html-preview');
    const htmlLink = (label: string) => preview.locator('a').filter({ hasText: label });

    const localBox = (await htmlLink('本地块链').boundingBox())!;
    const badBox = (await htmlLink('危险块链').boundingBox())!;
    const cursor = (x: number, y: number) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [x, y]);
    const lx = localBox.x + localBox.width / 2, ly = localBox.y + localBox.height / 2;
    const bx = badBox.x + badBox.width / 2, by = badBox.y + badBox.height / 2;

    await page.mouse.move(lx, ly);
    expect(await cursor(lx, ly)).not.toBe('pointer');
    await page.keyboard.down('Control');
    expect(await cursor(lx, ly)).toBe('pointer');
    expect(await cursor(bx, by)).not.toBe('pointer');
    await page.keyboard.up('Control');
    expect(await cursor(lx, ly)).not.toBe('pointer');

    await htmlLink('危险块链').click({ modifiers: ['Control'] });
    expect(await page.locator('.croquill-html-editing').count()).toBe(0);
    expect(await calls('open_external_link')).toEqual([]);
    expect(await calls('resolve_document_link')).toEqual([]);

    await htmlLink('外部块链').click({ modifiers: ['Control'] });
    expect(await page.locator('.croquill-html-editing').count()).toBe(0);
    expect(await calls('open_external_link')).toEqual([{ url: 'https://example.com' }]);

    await htmlLink('锚点块链').click({ modifiers: ['Control'] });
    expect(await page.locator('.croquill-html-editing').count()).toBe(0);
    expect((await selection()).slice(0, 2)).toEqual(['目标块', 0]);

    await preview.locator('summary').click();
    expect(await preview.locator('details').evaluate(el => (el as HTMLDetailsElement).open)).toBe(true);
    expect(await page.locator('.croquill-html-editing').count()).toBe(0);

    await htmlLink('本地块链').click();
    expect(await page.locator('.croquill-html-editing').count()).toBe(1);
    await page.keyboard.press('Escape');
    expect(await page.locator('.croquill-html-editing').count()).toBe(0);

    await htmlLink('本地块链').click({ modifiers: ['Control'] });
    await page.waitForFunction(path => (window as any).fileApp.session.path === path, other);
    expect(await calls('resolve_document_link')).toEqual([{ documentPath: currentFile, address: 'Other.MD' }]);
  });
});
