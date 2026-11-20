import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, openFileApp } from './app-files-fixture';

describe('文件菜单导出与自动保存', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    const address = server.httpServer!.address(); if (!address || typeof address === 'string') throw Error('No server');
    baseURL = 'http://127.0.0.1:' + address.port; browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => { page = await browser.newPage(); });
  afterEach(async () => { await page?.close(); });

  it.each(['typora-feel','inline-source','highlight-alert','toc-footnotes','wikilinks-attributes'])('%s 导出正文、跳转和可复制文字', async name => {
    const body = readFileSync(new URL('../examples/' + name + '.md', import.meta.url), 'utf8');
    await openFileApp(page, baseURL, { files:{ [currentFile]:body }, saveSelected:'D:/导出/当前.html' });
    const result = await page.evaluate(async () => {
      const h = (window as any).fileApp;
      await h.action('export-html');
      const saved = h.writes.at(-1);
      if (!saved) throw Error(document.querySelector('dialog')?.textContent || '未导出');
      const frame = document.createElement('iframe'); frame.srcdoc = saved.text;
      const loaded = new Promise(resolve => frame.onload = resolve); document.body.append(frame); await loaded;
      const doc = frame.contentDocument!;
      const title = doc.title, text = doc.body.innerText;
      const ids = [...doc.querySelectorAll('[id]')].map(e => e.id);
      const badLinks = [...doc.querySelectorAll('nav a,sup a,.footnote a[href^="#"]')].filter(a => !doc.getElementById(a.getAttribute('href')!.slice(1)));
      const paragraphs: string[] = [];
      h.surface.richView().state.doc.forEach((node:any) => {
        if (node.type.name === 'paragraph' && node.childCount === 1 && node.firstChild?.isText) paragraphs.push(h.visibleText(node.firstChild.text));
      });
      return { title, text, headings:doc.querySelectorAll('h1[id],h2[id]').length, css:doc.querySelector('style')?.textContent,
        unsafe:!!doc.querySelector('script,[contenteditable],.md-marker,.tx-active-block,.cm-editor'), unique:new Set(ids).size === ids.length,
        missing:badLinks.length, missingText:paragraphs.filter(t => !text.replaceAll('\u00a0',' ').includes(t.replaceAll('\u00a0',' '))),
        toc:doc.querySelectorAll('nav a').length, refs:doc.querySelectorAll('sup a').length, alerts:doc.querySelectorAll('[data-croquill-alert]').length,
        syntax:doc.querySelectorAll('pre .tok-keyword').length, dirty:h.session.dirty, markdown:h.surface.getMarkdown() };
    });
    expect(result.title).toBe('当前'); expect(result.headings).toBeGreaterThan(0); expect(result.unique).toBe(true);
    expect(result.css).toContain('--syntax-keyword'); expect(result.unsafe).toBe(false);
    expect(result.missing).toBe(0); expect(result.missingText).toEqual([]); expect(result.dirty).toBe(false); expect(result.markdown).toBe(body);
    if (name === 'typora-feel') expect(result.syntax).toBeGreaterThan(0);
    if (name === 'highlight-alert') expect(result.alerts).toBeGreaterThanOrEqual(5);
    if (name === 'toc-footnotes') { expect(result.toc).toBeGreaterThan(0); expect(result.refs).toBeGreaterThan(0); }
  });

  it('导出复用当前文本，保持编辑状态、选区和撤销；源码、查找及写作模式结果相同', async () => {
    await openFileApp(page, baseURL, { files:{ [currentFile]:'# 正文\r\n\r\n**粗体**\r\n' }, saveSelected:'D:/导出/当前.html' });
    const result = await page.evaluate(async () => {
      const h = (window as any).fileApp, v = h.surface.richView();
      v.dispatch(v.state.tr.insertText('刚写', 1)); const state = v.state, text = h.surface.getMarkdown();
      const output = async () => { await h.action('export-html'); return h.writes.at(-1).text; };
      const original = await output(), kept = v.state === state;
      await h.action('focus-mode'); await h.action('typewriter'); h.surface.openSearch(false);
      const input = document.querySelector<HTMLInputElement>('[aria-label="查找内容"]')!;
      input.value = '正文'; input.dispatchEvent(new Event('input', { bubbles:true }));
      const writing = await output(); await h.surface.setMode('source'); const source = await output();
      await h.action('dark'); const night = await output();
      return { kept, text, dirty:h.session.dirty, current:h.surface.getMarkdown(), identical:original === writing && original === source,
        light:original.includes('data-theme="light"'), dark:night.includes('data-theme="dark"') };
    });
    expect(result.kept).toBe(true); expect(result.dirty).toBe(true); expect(result.current).toBe(result.text);
    expect(result.identical && result.light && result.dark).toBe(true);
  });

  it('PDF 使用浅色、内嵌本地图片和分页规则，HTML 保留图片地址', async () => {
    const body = '$a^2$\n\n![本地](folder/a.png)\n\n<div><img src="folder/a.png"></div>\n\n- [x] 已完成\n';
    await openFileApp(page, baseURL, { files:{ [currentFile]:body }, saveSelected:'D:/导出/当前.pdf' });
    const result = await page.evaluate(async () => {
      const h = (window as any).fileApp; await h.action('dark'); await h.action('export-pdf');
      const html = h.calls.find((c:any) => c.cmd === 'export_pdf').args.html;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      h.saveSelected = 'D:/导出/当前.html'; await h.action('export-html');
      const second = new DOMParser().parseFromString(h.writes.at(-1).text,'text/html');
      return { theme:doc.documentElement.dataset.theme, imgs:[...doc.images].map(i => i.getAttribute('src')),
        paths:[...second.images].map(i => i.getAttribute('src')), math:!!doc.querySelector('math'), check:!!doc.querySelector('input[checked][disabled]'),
        css:doc.querySelector('style')!.textContent };
    });
    expect(result.theme).toBe('light'); expect(result.imgs).toHaveLength(2); expect(result.imgs.every(s => s.startsWith('data:image/'))).toBe(true);
    expect(result.paths).toEqual(['folder/a.png','folder/a.png']); expect(result.math && result.check).toBe(true);
    expect(result.css).toContain('A4 portrait'); expect(result.css).toContain('break-inside:avoid'); expect(result.css).toContain('table-layout:fixed');
  });

  it.each(['html','pdf'])('%s 渲染嵌套定义的引用、可见标题锚点与脚注，省略作者注释', async format => {
    const body = [
      '# 河岸散步', '[TOC]', '## 桥头 {.wide #bridge}', '## **重名**', '## `重名`', '## 重名',
      '## `{#literal}`', '## fn-1', '[去河岸](#河岸散步) [去桥头](#bridge) 注[^a]',
      '见 [**加粗** &amp; \\*][id]、[**普通链接** &amp; \\*](#bridge) 和 ![示意图][pic]。',
      '> [pic]: images/a.png', '- [id]: https://example.com', '[id]: https://later.example',
      '<!-- 作者备注 -->', '前<!-- 行内小注 -->后', '`<!-- 代码字面量 -->`',
      '保护段落 [[笔记]] <!-- 保护段备注 -->未闭合 <kbd> 字面标签。',
      '保留 <span data-x="literal">原样<!-- 片段备注 --></span>。', '[^a]: 说明',
    ].join('\n\n');
    await openFileApp(page, baseURL, { files:{ [currentFile]:body }, saveSelected:'D:/导出/当前.' + format });
    const result = await page.evaluate(async format => {
      const h = (window as any).fileApp;
      await h.action('export-' + format);
      const html = format === 'html' ? h.writes.at(-1).text : h.calls.find((c:any) => c.cmd === 'export_pdf').args.html;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>('p a'));
      const footnote = doc.querySelector('.footnote')!, sup = doc.querySelector('sup')!;
      return {
        titles:[...doc.querySelectorAll('h1,h2')].map(e => e.id),
        toc:[...doc.querySelectorAll('nav a')].map(e => e.getAttribute('href')),
        destinations:links.filter(e => e.textContent?.startsWith('去')).map(e => doc.getElementById(e.hash.slice(1))?.textContent ??
          doc.getElementById(decodeURIComponent(e.hash.slice(1)))?.textContent),
        formatted:links.filter(e => e.querySelector('strong')).map(e => [e.getAttribute('href'),e.textContent,e.querySelector('strong')?.textContent]),
        src:doc.querySelector('img')?.getAttribute('src'), remarks:/作者备注|行内小注|保护段备注|片段备注/.test(html), text:doc.body.textContent,
        footnote:footnote.id, forward:sup.querySelector('a')?.getAttribute('href') === '#' + footnote.id,
        back:footnote.querySelector('a')?.getAttribute('href') === '#' + sup.id,
      };
    }, format);
    const ids = ['河岸散步','bridge','重名','重名-1','重名-2','{#literal}','fn-1'];
    expect(result.titles).toEqual(ids); expect(result.toc).toEqual(ids.map(id => '#' + id));
    expect(result.destinations).toEqual(['河岸散步','桥头']);
    expect(result.formatted).toEqual([['https://example.com','加粗 & *','加粗'],['#bridge','普通链接 & *','普通链接']]);
    if (format === 'html') expect(result.src).toBe('images/a.png');
    else expect(result.src).toMatch(/^data:image\//);
    expect(result.remarks).toBe(false); expect(result.text).toContain('前后'); expect(result.text).toContain('<!-- 代码字面量 -->');
    expect(result.footnote).not.toBe('fn-1'); expect(result.forward && result.back).toBe(true);
  });

  it.each(['rich','source'])('%s 自动保存冲突在上屏后才弹窗', async mode => {
    await openFileApp(page, baseURL, { files:{ [currentFile]:'乙' }, holdWrite:true });
    await page.clock.install();
    await page.evaluate(async mode => {
      const h = (window as any).fileApp;
      await h.surface.setMode(mode); h.surface.focus(); await h.action('autosave');
    }, mode);
    await page.keyboard.press('Control+Home'); await page.keyboard.insertText('甲');
    await page.clock.runFor(1000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text:'nihao', selectionStart:5, selectionEnd:5 });
    await page.evaluate(() => {
      const h = (window as any).fileApp;
      h.composingEditor = document.activeElement;
      h.rejectWrite('原文件已被其他程序修改或移走');
    });
    const during = await page.evaluate(() => {
      const h = (window as any).fileApp, editor = h.composingEditor;
      return { composing:h.surface.hasFocusedComposition(), dialog:!!document.querySelector('dialog[open]'),
        focus:editor === document.activeElement && document.querySelector('#editor-scroll')!.contains(editor) };
    });
    expect(during).toEqual({ composing:true, dialog:false, focus:true });
    await cdp.send('Input.insertText', { text:'你好' });
    await page.waitForSelector('dialog[open]');
    expect(await page.locator('dialog').textContent()).toContain('自动保存已暂停');
    await page.getByRole('button', { name:'返回文档' }).click();
    await page.clock.runFor(5000);
    const after = await page.evaluate(() => {
      const h = (window as any).fileApp;
      return [h.surface.getMarkdown().trimEnd(), h.session.dirty, h.writes.length, h.files[h.initial]];
    });
    expect(after).toEqual(['甲你好乙',true,1,'乙']);
  });

  it('自动保存等待写盘时正文可继续输入，焦点、选区和滚动位置保持', async () => {
    await openFileApp(page, baseURL, { holdWrite:true });
    await page.clock.install(); await page.evaluate(async () => {
      const h = (window as any).fileApp; await h.action('autosave');
      const v = h.surface.richView(); v.focus(); v.dispatch(v.state.tr.insertText('甲'));
      h.selection = v.state.selection.from; h.scroll = document.querySelector('#editor-scroll')!.scrollTop;
    });
    await page.clock.runFor(1000);
    const held = await page.evaluate(() => {
      const h = (window as any).fileApp, v = h.surface.richView(), scroller = document.getElementById('editor-scroll')!;
      const same = v.hasFocus() && v.state.selection.from === h.selection && scroller.scrollTop === h.scroll;
      const check = document.querySelector('[data-action="autosave"]')!.getAttribute('aria-checked');
      v.dispatch(v.state.tr.insertText('乙')); h.holdWrite = false; h.releaseWrite();
      return { same, check, inert:scroller.inert, dirty:h.session.dirty };
    });
    expect(held).toEqual({ same:true, check:'true', inert:false, dirty:true });
    await page.clock.runFor(1000);
    const saved = await page.evaluate(() => { const h = (window as any).fileApp; return [h.writes.length,h.session.dirty,h.files[h.initial]]; });
    expect(saved[0]).toBe(2); expect(saved[1]).toBe(false); expect(saved[2]).toContain('甲乙');
  });
});
