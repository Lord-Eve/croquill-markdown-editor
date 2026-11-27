import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { currentFile, openFileApp } from './app-files-fixture';
import { launchTestBrowser } from './browser';
import { createTestServer } from './server';

const sample = readFileSync(new URL('../examples/inline-html.md', import.meta.url), 'utf8');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqQAAAAASUVORK5CYII=';

describe('rendered inline HTML in the app', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;

  beforeAll(async () => {
    server = await createTestServer();
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('No server');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);

  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => { page = await browser.newPage({ viewport: { width: 1200, height: 800 } }); });
  afterEach(async () => {
    await page?.evaluate(() => (window as any).fileApp?.surface.destroy());
    await page?.close();
  });

  async function open(source: string, config: Record<string, unknown> = {}) {
    await openFileApp(page, baseURL, { files: { [currentFile]: source }, ...config });
    const result = await page.evaluate(() => {
      const { surface } = (window as any).fileApp;
      return { mode: surface.mode, reason: surface.getSafetyReason() };
    });
    expect(result).toEqual({ mode: 'rich', reason: null });
  }

  const root = () => page.locator('#rich-root .ProseMirror');
  const markdown = () => page.evaluate(() => (window as any).fileApp.surface.getMarkdown() as string);
  const head = () => page.evaluate(() => (window as any).fileApp.surface.richView().state.selection.head as number);
  const expanded = () => root().locator('.md-html-marker:not(.md-hidden)').allTextContents();
  const literal = () => root().locator('[data-croquill-inline-raw]').allTextContents();

  async function caret(snippet: string, offset = 0, length = 0) {
    await page.evaluate(({ snippet, offset, length }) => {
      const view = (window as any).fileApp.surface.richView();
      let position: number | undefined;
      view.state.doc.descendants((node: any, pos: number) => {
        if (position === undefined && node.isText && node.text.includes(snippet)) position = pos + node.text.indexOf(snippet) + offset;
      });
      if (position === undefined) throw Error('Missing source text: ' + snippet);
      const caret = view.state.selection.constructor.near(view.state.doc.resolve(position));
      const selection = length ? caret.constructor.create(view.state.doc, position, position + length) : caret;
      view.dispatch(view.state.tr.setSelection(selection));
      view.focus();
    }, { snippet, offset, length });
  }

  it('renders every allowed tag and keeps HTML entirely in text nodes', async () => {
    const tags = ['span', 'kbd', 'sup', 'sub', 'u', 'ins', 's', 'del', 'mark', 'b', 'strong', 'i', 'em', 'small', 'a'];
    const html = tags.map(tag => '<' + tag + '>' + tag + '</' + tag + '>').join(' ');
    const source = '前 ' + html + ' <img src="data:image/png;base64,' + png + '"> 后\n';
    await open(source);
    await root().locator('img.md-html-image').waitFor();
    expect(await root().locator('.md-html').evaluateAll(nodes => nodes.map(node => [node.localName, node.textContent]))).toEqual(
      tags.map(tag => [tag === 'a' ? 'span' : tag, tag]),
    );
    expect(await expanded()).toEqual([]);
    const documentNodes = await page.evaluate(() => (window as any).fileApp.surface.richView().state.doc.firstChild.toJSON());
    expect(documentNodes).toEqual({ type: 'paragraph', content: [{ type: 'text', text: source.trimEnd() }] });
  });

  it('displays complete unsafe tags literally and keeps broken boundaries protected', async () => {
    const rejected = [
      '<span OnClick="window.inlineHtmlExecuted = true">点击</span>',
      '<kbd style="color:red">样式</kbd>',
      '<span TITLE="甲" title="乙">重复属性</span>',
      '<img src="java&#x73;cript:alert(1)">',
      '<img src="//example.com/x.png">',
      '<img src="data:text/html,test">',
      '<script>window.inlineHtmlExecuted = true</script>',
      '<iframe src="https://example.com/must-not-load">框架</iframe>',
      '<button><kbd>按键</kbd></button>', '<input>', '<font>颜色</font>', '<center>居中</center>',
      '<br class="x">', '<wbr>', '<!-- 备注 -->',
    ];
    const source = '前 ' + rejected.join('、') + ' 后\n\n前<span>未闭合。\n\n跨段<kbd>开。\n\n闭</kbd>结束。\n';
    await open(source);
    expect(await literal()).toEqual(rejected);
    expect(await root().locator('script, iframe, button, input, font, center, img, kbd, span[onclick]').count()).toBe(0);
    expect(await root().locator('[data-croquill-raw]').allTextContents()).toEqual([
      '前<span>未闭合。\n\n', '跨段<kbd>开。\n\n', '闭</kbd>结束。\n',
    ]);
    expect(await page.evaluate(() => (window as any).inlineHtmlExecuted)).toBeUndefined();
    expect(await markdown()).toBe(source);
  });

  it('applies only the six allowed CSS declarations and leaves document attributes inert', async () => {
    const source = '前 <span class="ignored" id="inert" lang="ja" dir="rtl" title="提示"' +
      ' style="color:red; background-color:lightblue; font-weight:700; font-style:italic; text-decoration:underline; position:fixed; font-size:80px; color:u&#x72;l(https://example.com/pixel); background-color:expression(alert(1)); color: var(--x, &lt;); color:\\72 ed; background-image:url(x;color:green;)">样式</span>' +
      ' <span style="text-decoration-line:line-through">划线</span> 后\n';
    await open(source);
    const rendered = await root().locator('span.md-html').evaluateAll(nodes => nodes.map(node => {
      const css = getComputedStyle(node);
      return {
        title: node.getAttribute('title'), attributes: node.getAttributeNames().sort(),
        names: (node.getAttribute('style') ?? '').split(';').map(declaration => declaration.trim().split(':')[0]).filter(Boolean).sort(),
        color: css.color, background: css.backgroundColor, weight: css.fontWeight, italic: css.fontStyle,
        decoration: css.textDecorationLine, position: css.position,
      };
    }));
    expect(rendered[0]).toMatchObject({
      title: '提示', attributes: ['class', 'style', 'title'],
      names: ['background-color', 'color', 'font-style', 'font-weight', 'text-decoration'],
      color: 'rgb(255, 0, 0)', background: 'rgb(173, 216, 230)', weight: '700',
      italic: 'italic', decoration: 'underline', position: 'static',
    });
    expect(rendered[1]).toMatchObject({ names: ['text-decoration-line'], decoration: 'line-through' });
  });

  it('expands only tags touched by the caret and renders nested HTML and Markdown', async () => {
    const source = '前 <span style="color:red">外侧 <b><i>内层</i></b> **粗体** [链接](https://example.com)</span> 与 **<u>下划线</u>** <kbd>Ctrl</kbd> 后\n';
    await open(source);
    expect(await expanded()).toEqual([]);
    expect(await root().locator('strong.md-strong u.md-html').textContent()).toBe('下划线');
    expect(await root().locator('span.md-html strong.md-strong').textContent()).toBe('粗体');
    expect(await root().locator('span.md-html a.md-link').textContent()).toBe('链接');
    await caret('外侧', 1);
    expect(await expanded()).toEqual(['<span style="color:red">', '</span>']);
    await caret('内层', 1);
    expect(await expanded()).toEqual(['<span style="color:red">', '<b>', '<i>', '</i>', '</b>', '</span>']);
    expect(await root().locator('b.md-html i.md-html').textContent()).toBe('内层');
    await caret('<kbd>');
    expect(await expanded()).toEqual(['<kbd>', '</kbd>']);
    await caret('</kbd>', '</kbd>'.length);
    expect(await expanded()).toEqual(['<kbd>', '</kbd>']);
    await caret(' 后', 2);
    expect(await expanded()).toEqual([]);
    expect(await markdown()).toBe(source);
  });

  it('keeps navigation and deletion in the source text of visible tags', async () => {
    const source = '<kbd>A</kbd> 中间 <sup>2</sup>\n';
    await open(source);
    await caret('中间', 1);
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('.md-html-marker:not(.md-hidden)')?.textContent === '<kbd>');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.md-html-marker:not(.md-hidden)')?.textContent === '<sup>');
    await caret(' <sup>');
    const before = await head();
    await page.keyboard.press('ArrowRight');
    expect(await head()).toBe(before + 1);
    expect(await expanded()).toEqual(['<sup>', '</sup>']);
    await page.keyboard.press('Delete');
    expect(await markdown()).toBe(source.replace('<sup>', 'sup>'));
    expect(await root().locator('sup.md-html').count()).toBe(0);
    expect(await root().locator('kbd.md-html').textContent()).toBe('A');
  });

  it('edits Chinese text and leaves an editable caret between emptied tags', async () => {
    const source = '前 <span style="color:red">原字</span> 后\n';
    await open(source);
    await caret('原字', 1);
    await page.keyboard.insertText('中');
    expect(await markdown()).toBe(source.replace('原字', '原中字'));
    await page.keyboard.press('Backspace');
    expect(await markdown()).toBe(source);
    await caret('原字', 0, 2);
    const position = await head() - 2;
    await page.keyboard.press('Delete');
    expect(await markdown()).toBe(source.replace('原字', ''));
    expect(await head()).toBe(position);
    expect(await expanded()).toEqual(['<span style="color:red">', '</span>']);
    await page.keyboard.insertText('新');
    expect(await markdown()).toBe(source.replace('原字', '新'));
    expect(await root().locator('span.md-html').textContent()).toBe('新');
  });

  it('freezes tag decorations throughout a Chromium IME composition', async () => {
    const source = '前 <span style="color:red">原字</span> 与 <kbd>Ctrl</kbd> 后\n';
    await open(source);
    await caret('原字', 1);
    await page.evaluate(() => {
      const h = (window as any).fileApp, view = h.surface.richView();
      const dispatch = view.dispatch.bind(view);
      h.rebuilds = [];
      view.dispatch = (tr: any) => {
        if (Object.keys(tr.meta).some(key => key.startsWith('croquill-inline-source'))) h.rebuilds.push(view.composing);
        dispatch(tr);
      };
    });
    const cdp = await page.context().newCDPSession(page);
    for (const text of ['zhong', 'zhongwen']) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
      await page.waitForFunction(text => {
        const view = (window as any).fileApp.surface.richView();
        return view.composing && view.state.doc.textContent.includes('原' + text + '字');
      }, text);
      expect(await expanded()).toEqual(['<span style="color:red">', '</span>']);
      expect(await page.evaluate(() => (window as any).fileApp.rebuilds)).toEqual([]);
    }
    await cdp.send('Input.insertText', { text: '中文' });
    await page.waitForFunction(expected => (window as any).fileApp.surface.getMarkdown() === expected, source.replace('原字', '原中文字'));
    expect(await root().locator('span.md-html').textContent()).toBe('原中文字');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(source => (window as any).fileApp.surface.getMarkdown() === source, source);
  });

  it('renders a pair at the final typed character and keeps typed unsafe HTML plain until reopen', async () => {
    await open('前文 \n');
    await caret('前文', 2);
    await page.keyboard.type(' <kbd>');
    expect(await root().locator('kbd.md-html').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fileApp.surface.getSafetyReason())).toBeNull();
    await page.keyboard.type('A</kbd');
    expect(await root().locator('kbd.md-html').count()).toBe(0);
    await page.keyboard.type('>');
    expect(await root().locator('kbd.md-html').textContent()).toBe('A');
    await page.keyboard.type(' <button>plain</button>');
    expect(await literal()).toEqual([]);
    const saved = await markdown();
    expect(saved).toBe('前文 <kbd>A</kbd> <button>plain</button>\n');
    await page.evaluate(async saved => (window as any).fileApp.surface.load(saved), saved);
    expect(await literal()).toEqual(['<button>plain</button>']);
  });

  it.each([
    { eol: '\n', bom: false }, { eol: '\r\n', bom: false }, { eol: '\r\n', bom: true },
  ])('preserves sample bytes with $eol and BOM=$bom, including a paragraph and cell edit', async ({ eol, bom }) => {
    const original = sample.replace(/\r\n|\n/g, eol);
    await open(original, { bom });
    expect(await markdown()).toBe(original);
    async function saveAndCheck(index: number, expected: string) {
      await page.keyboard.press('Control+s');
      await page.waitForFunction(index => (window as any).fileApp.writes.length === index + 1, index);
      const write = await page.evaluate(index => (window as any).fileApp.writes[index], index);
      expect(write.newline).toBe(eol === '\n' ? 'lf' : 'crlf');
      const bytes = Buffer.from((write.bom ? '\uFEFF' : '') + write.text.replace(/\r\n|\n/g, eol));
      expect(bytes.equals(Buffer.from((bom ? '\uFEFF' : '') + expected)), write.text).toBe(true);
    }
    await saveAndCheck(0, original);
    await caret('红色正文', 0, 1);
    await page.keyboard.insertText('彩');
    const edited = original.replace('红色正文', '彩色正文');
    await saveAndCheck(1, edited);
    await caret('单元格文字', 0, 1);
    await page.keyboard.insertText('新');
    await saveAndCheck(2, edited.replace('单元格文字', '新元格文字'));
  }, 30000);

  it('handles pending, loaded and failed images and puts the caret inside the clicked tag', async () => {
    const remote = 'https://example.com/inline.png';
    await page.route(remote, route => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
    const localTag = '<img src="local.png" alt="本地" width="36" height="12px">';
    const remoteTag = '<img src="' + remote + '" alt="远程" width="30%" height="-5">';
    const failedTag = '<img src="missing.png" alt="读图失败">';
    const source = '前 ' + localTag + ' 中 ' + remoteTag + ' 后 ' + failedTag + ' 尾\n';
    await open(source, { holdImage: 'local.png', missingImages: ['missing.png'] });
    await page.waitForFunction(() => !!(window as any).fileApp.releaseImage);
    const localImage = root().getByAltText('本地');
    const remoteImage = root().getByAltText('远程');
    await remoteImage.waitFor();
    expect(await remoteImage.evaluate(node => [(node as HTMLImageElement).style.width, (node as HTMLImageElement).style.height])).toEqual(['30%', '']);
    expect(await localImage.count()).toBe(0);
    expect(await expanded()).toEqual([localTag, failedTag]);
    await page.evaluate(() => { (window as any).fileApp.releaseImage(); });
    await localImage.waitFor();
    expect(await localImage.evaluate(node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height])).toEqual([36, 12]);
    const reads = await page.evaluate(() => (window as any).fileApp.calls.filter((call: any) => call.cmd === 'read_local_image').map((call: any) => call.args.src));
    expect(reads).toEqual(['local.png', 'missing.png']);
    await localImage.click();
    expect(await head()).toBe(source.indexOf(localTag) + '<img'.length + 1);
    expect(await expanded()).toEqual([localTag, failedTag]);
    expect(await localImage.count()).toBe(0);
    expect(await page.evaluate(() => document.getSelection()?.anchorNode?.nodeType)).toBe(3);
    await caret('前');
    await localImage.waitFor();
    await caret(localTag, localTag.length);
    await page.keyboard.press('Backspace');
    expect(await markdown()).toBe(source.replace(localTag, localTag.slice(0, -1)));
    expect(await localImage.count()).toBe(0);
  });

  it('retains multiline attributes, extra blank lines and mixed newlines when editing inline text', async () => {
    const source = '前 <span title="多行\r\n  提示" style="color:red">原字</span> 后\r\n\r\n\r\n下一段\n';
    await open(source);
    await caret('原字', 0, 1);
    await page.keyboard.insertText('新');
    expect(await markdown()).toBe(source.replace('原字', '新字'));
  });

  it('opens allowed HTML link schemes through the command and shows the existing hints', async () => {
    const source = '前 <a href="https://example.com/?a=1&amp;b=2">安全链接</a> <a href="java&#115;cript:alert(1)">危险链接</a> <a href="local.md">相对链接</a> <a>空链接</a> 后\n';
    await open(source);
    const links = root().locator('.md-html-link');
    expect(await links.allTextContents()).toEqual(['安全链接', '危险链接', '相对链接', '空链接']);
    await links.filter({ hasText: '安全链接' }).click();
    expect(await page.locator('#toast').textContent()).toBe('按 Ctrl + 点击以打开此链接');
    await links.filter({ hasText: '安全链接' }).click({ modifiers: ['Control'] });
    const opened = () => page.evaluate(() => (window as any).fileApp.calls.filter((call: any) => call.cmd === 'open_external_link').map((call: any) => call.args.url));
    expect(await opened()).toEqual(['https://example.com/?a=1&b=2']);
    for (const text of ['危险链接', '空链接']) {
      const link = links.filter({ hasText: text });
      expect(await link.getAttribute('href')).toBeNull();
      await link.click({ modifiers: ['Control'] });
      expect(await page.locator('#toast').textContent()).toBe('暂不支持打开此类链接');
    }
    await links.filter({ hasText: '相对链接' }).click({ modifiers: ['Control'] });
    expect(await page.locator('#toast').textContent()).toBe('找不到文件：local.md');
    expect(await opened()).toEqual(['https://example.com/?a=1&b=2']);
  });

  it('omits tags from the outline, TOC and count while allowing searches for source tags', async () => {
    const source = '[TOC]\n\n# 菜单 <kbd>Ctrl</kbd> <span title="菜单提示">编辑</span> <img src="demo.png" alt="示意图">\n';
    await open(source);
    await page.evaluate(() => { const h = (window as any).fileApp; h.updateStats(); h.setSidebarTab('outline'); });
    expect((await page.locator('#outline button').textContent())?.trim()).toBe('菜单 Ctrl 编辑');
    expect((await root().locator('[data-croquill-toc] button').textContent())?.trim()).toBe('菜单 Ctrl 编辑');
    expect(await page.locator('#word-count').textContent()).toBe('6 字');
    await caret('菜单');
    await page.keyboard.press('Control+f');
    const search = page.getByRole('textbox', { name: '查找内容', exact: true });
    const highlights = () => page.evaluate(() => [...CSS.highlights.entries()]
      .filter(([name]) => name.startsWith('croquill-search-') && !name.endsWith('current'))
      .flatMap(([, highlight]) => [...highlight].map(range => range.toString())));
    await search.fill('编辑');
    expect(await highlights()).toEqual(['编辑']);
    expect(await page.locator('#rich-root.md-reveal-markers').count()).toBe(0);
    await search.fill('kbd');
    expect(await highlights()).toEqual(['kbd', 'kbd']);
    expect(await page.locator('#rich-root.md-reveal-markers').count()).toBe(1);
    expect(await markdown()).toBe(source);
  });
});
