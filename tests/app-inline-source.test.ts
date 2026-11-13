import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

// Inline Markdown is source text in the rich document (src/inline-source.ts). Expected
// caret and marker behaviour is the official Typora record in docs/typora-acceptance.md.
describe('inline Markdown as source text through the real app', () => {
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

  const markdown = () => page.evaluate(() => (window as any).fileApp.surface.getMarkdown());
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function open(source: string, config: Record<string, unknown> = {}) {
    await openFileApp(page, baseURL, { files: { [currentFile]: source }, ...config }); await focusApp(page, 'rich');
    // ProseMirror undoes a jump to the document start for 200ms after focus (see
    // app-heading-keys.test.ts); none of these tests should race that window.
    await page.waitForFunction(() => Date.now() - (window as any).fileApp.surface.richView().input.lastFocus > 200);
  }
  /** Put the caret `offset` characters into the first occurrence of `text`. */
  const caret = (text: string, offset = 0, length = 0) => page.evaluate(({ text, offset, length }) => {
    const view = (window as any).fileApp.surface.richView(); let position: number | undefined;
    view.state.doc.descendants((node: any, pos: number) => { if (position === undefined && node.isText && node.text.includes(text)) position = pos + node.text.indexOf(text) + offset; });
    if (position === undefined) throw Error('Text not found: ' + text);
    const Selection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, position, position + length))); view.focus();
  }, { text, offset, length });
  /** The caret's block as source with `|` at the caret, the markers on screen, and the text on screen. */
  const look = () => page.evaluate(() => {
    const view = (window as any).fileApp.surface.richView(), $head = view.state.selection.$head, source = $head.parent.textContent;
    const block = view.domAtPos($head.start()).node as HTMLElement, element = (block.nodeType === 1 ? block : block.parentElement)!.closest('p,h1,h2,h3,h4,h5,h6') as HTMLElement;
    return {
      caret: source.slice(0, $head.parentOffset) + '|' + source.slice($head.parentOffset),
      shown: [...element.querySelectorAll('.md-marker:not(.md-hidden)')].map(node => node.textContent).join(' '),
      hidden: element.querySelectorAll('.md-marker.md-hidden').length,
      text: element.innerText,
    };
  });
  const model = (predicate: string) => page.waitForFunction(`(() => { const s = window.fileApp.surface.richView().state.selection; return ${predicate}; })()`);
  async function press(key: string, times = 1) {
    for (let index = 0; index < times; index++) {
      const before = await page.evaluate(() => (window as any).fileApp.surface.richView().state.selection.head);
      await page.keyboard.press(key);
      // The DOM caret moves first; wait for the editor model to follow it.
      await page.waitForFunction(before => (window as any).fileApp.surface.richView().state.selection.head !== before, before, { timeout: 3000 }).catch(() => {});
    }
    await settle();
  }
  const sample = '前文 **加粗文字** 中间 *斜体文字* 以及 `行内代码` 和 ~~删除线~~ 与 ==高亮== 结尾\n\n普通段落\n';

  it('shows formatted text with every marker hidden, without touching the document', async () => {
    await open(sample); await caret('普通段落');
    const result = await page.evaluate(() => {
      const h = (window as any).fileApp, root = document.querySelector('#rich-root')!, first = root.querySelector('p') as HTMLElement;
      const tags = ['strong', 'em', 'code', 'del', 'mark'].map(tag => first.querySelector(tag)?.textContent);
      return { tags, text: first.innerText, shown: first.querySelectorAll('.md-marker:not(.md-hidden)').length, hidden: first.querySelectorAll('.md-marker.md-hidden').length,
        weight: getComputedStyle(first.querySelector('strong')!).fontWeight, style: getComputedStyle(first.querySelector('em')!).fontStyle,
        dirty: h.session.dirty, markdown: h.surface.getMarkdown() };
    });
    expect(result).toMatchObject({ tags: ['加粗文字', '斜体文字', '行内代码', '删除线', '高亮'], shown: 0, hidden: 10, style: 'italic', dirty: false, markdown: sample });
    expect(result.text).toBe('前文 加粗文字 中间 斜体文字 以及 行内代码 和 删除线 与 高亮 结尾');
    expect(Number(result.weight)).toBeGreaterThanOrEqual(600);
  }, 30000);

  it('shows only the markers of the span the caret is in, and clicking never marks the document changed', async () => {
    await open(sample); await caret('普通段落');
    const point = await page.evaluate(() => { const rect = document.querySelector('#rich-root strong')!.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
    await page.mouse.click(point.x, point.y); await model('s.$head.parent.textContent.startsWith("前文")'); await settle();
    const clicked = await look();
    expect(clicked.shown).toBe('** **'); expect(clicked.hidden).toBe(8); expect(clicked.caret).toMatch(/^前文 \*\*加粗?\|/);
    for (const [text, markers] of [['斜体文字', '* *'], ['行内代码', '` `'], ['删除线', '~~ ~~'], ['高亮', '== ==']] as const) {
      await caret(text, 1); await settle(); expect((await look()).shown).toBe(markers);
    }
    await caret('普通段落'); await settle();
    const state = await page.evaluate(() => { const h = (window as any).fileApp; return { dirty: h.session.dirty, writes: h.writes.length, title: document.title }; });
    expect(state).toMatchObject({ dirty: false, writes: 0 }); expect(state.title.startsWith('● ')).toBe(false);
    expect(await markdown()).toBe(sample);
  }, 30000);

  it('walks the caret through the markers exactly as Typora does', async () => {
    await open(sample); await caret('加粗文字', 2); await settle();
    const steps: string[] = [];
    for (let index = 0; index < 5; index++) { await press('ArrowRight'); const now = await look(); steps.push(now.caret.replace(/(中间).*$/, '$1') + ' / ' + (now.shown || '无')); }
    expect(steps).toEqual([
      '前文 **加粗文|字** 中间 / ** **',
      '前文 **加粗文字|** 中间 / ** **',
      '前文 **加粗文字*|* 中间 / ** **',
      '前文 **加粗文字**| 中间 / ** **',
      '前文 **加粗文字** |中间 / 无',
    ]);
  }, 30000);

  it.each([['ArrowRight', '前文', 0, 12], ['ArrowLeft', '中间', 2, 12], ['ArrowLeft', '结尾', 2, 10]] as const)('never swallows a %s press around hidden markers (from %s)', async (key, text, offset, count) => {
    await open(sample); await caret(text, offset); await settle();
    let previous = (await look()).caret; const stuck: string[] = [];
    for (let index = 0; index < count; index++) { await press(key); const now = (await look()).caret; if (now === previous) stuck.push(now); previous = now; }
    expect(stuck).toEqual([]);
  }, 30000);

  it('re-renders at once when a marker is edited, and undo restores it after the caret has left', async () => {
    await open(sample); await caret('加粗文字**', 5); await settle();
    expect((await look()).caret).toContain('加粗文字*|*');
    await page.keyboard.press('Backspace'); await page.waitForFunction(() => (window as any).fileApp.surface.getMarkdown().includes('**加粗文字* 中间'));
    await settle();
    const edited = await page.evaluate(() => { const first = document.querySelector('#rich-root p')!; return { strong: first.querySelectorAll('strong').length, em: first.querySelector('em')?.textContent }; });
    expect(edited).toEqual({ strong: 0, em: '加粗文字' });
    await caret('普通段落', 2); await settle();
    expect(await page.evaluate(() => (document.querySelector('#rich-root p') as HTMLElement).innerText)).toContain('前文 *加粗文字 中间');
    await page.keyboard.press('Control+z'); await page.waitForFunction(sample => (window as any).fileApp.surface.getMarkdown() === sample, sample); await settle();
    const restored = await look();
    expect(restored.caret).toContain('加粗文字*|*'); expect(restored.shown).toBe('** **');
    expect(await page.evaluate(() => document.querySelector('#rich-root p strong')?.textContent)).toBe('加粗文字');
  }, 30000);

  it('turns typed markers into formatting as the closing one arrives', async () => {
    await open('普通文字\n'); await caret('普通文字', 2);
    for (const [typed, strong] of [['*', 0], ['*', 0], ['粗', 0], ['*', 0], ['*', 1]] as const) {
      await page.keyboard.insertText(typed); await settle();
      expect(await page.locator('#rich-root p strong').count()).toBe(strong);
    }
    expect(await markdown()).toBe('普通**粗**文字\n');
    expect(await page.locator('#rich-root p strong').textContent()).toBe('粗');
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !(window as any).fileApp.surface.getMarkdown().includes('**粗**'));
  }, 30000);

  it('types and deletes inside a span as plain text, undoable after leaving', async () => {
    await open(sample); await caret('加粗文字', 2);
    await page.keyboard.insertText('新'); await settle();
    expect(await markdown()).toBe(sample.replace('加粗文字', '加粗新文字'));
    expect(await page.locator('#rich-root p strong').first().textContent()).toBe('加粗新文字');
    await caret('普通段落'); await page.keyboard.press('Control+z');
    await page.waitForFunction(sample => (window as any).fileApp.surface.getMarkdown() === sample, sample);
  }, 30000);

  for (const eol of ['\n', '\r\n']) for (const bom of [false, true]) {
    it(`keeps every original spelling byte for byte while another paragraph is edited (${JSON.stringify(eol)}, BOM=${bom})`, async () => {
      const lines = [
        '待改正文', '',
        '__下划线加粗__ 和 _下划线斜体_ 与 ~单波浪~', '',
        '转义 \\*不是斜体\\*、\\_、\\[括号\\] 和 \\\\ 反斜杠', '',
        '``含`反引号`` 与 `` ` `` 及 实体 &amp; &lt; &copy; &#x4E2D;', '',
        'a*b 与 2*3*4，未闭合 **加粗 和 孤立 * 星号', '',
        '**跨行', '加粗** 之后', '',
        '> *引用里', '> 跨行斜体* 结束', '',
        '- 项目 **粗**', '  续行 ~~删~~ 与 `码`', '',
        '## 标题 **粗** 与 `码` \\#', '',
        '[**粗链接**](https://example.com "标题") 与 <https://example.org>', '',
        '| 列 | 值 |', '| --- | --- |', '| ==亮== a \\| b | `x\\|y` 与 **粗** |', '',
        '尾段 ==高亮 **内粗**== 结束', '',
      ];
      const original = lines.join(eol);
      await open(original, { bom }); await caret('待改正文');
      await page.keyboard.insertText('新'); await settle();
      await page.keyboard.press('Control+s'); await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
      const write = await page.evaluate(() => (window as any).fileApp.writes[0]);
      // Rich mode hands the native writer LF text plus the file's newline kind.
      expect(write.text.replace(/\r\n/g, '\n')).toBe(('新' + original).replace(/\r\n/g, '\n'));
      expect(write.bom).toBe(bom); expect(write.newline).toBe(eol === '\r\n' ? 'crlf' : 'lf');
      // And nothing about the untouched document is lost on the way back in.
      await page.keyboard.press('Control+z'); await page.waitForFunction(original => (window as any).fileApp.surface.getMarkdown() === original, original);
    }, 30000);
  }

  it('renders escapes and entities as the characters they stand for, and their source at the caret', async () => {
    await open('转义 \\*星号\\* 与 实体 &amp; 和 &lt;标签&gt; 尾\n\n普通段落\n'); await caret('普通段落'); await settle();
    const first = () => page.evaluate(() => (document.querySelector('#rich-root p') as HTMLElement).innerText);
    expect(await first()).toBe('转义 *星号* 与 实体 & 和 <标签> 尾');
    await caret('&amp;', 2); await settle(); expect(await first()).toBe('转义 *星号* 与 实体 &amp; 和 <标签> 尾');
    await caret('\\*星号', 1); await settle(); expect(await first()).toBe('转义 \\*星号* 与 实体 & 和 <标签> 尾');
    expect(await page.evaluate(() => (window as any).fileApp.session.dirty)).toBe(false);
  }, 30000);

  it('escapes typed text only where it would otherwise start another block', async () => {
    await open('第一行\n第二行\n\n段落\n'); await caret('第二行');
    await page.keyboard.insertText('# 不是标题 '); await caret('段落');
    await page.evaluate(() => { const view = (window as any).fileApp.surface.richView(); view.dispatch(view.state.tr.insertText('1. 不是列表 ')); });
    const saved = await markdown();
    expect(saved).toBe('第一行\n\\# 不是标题 第二行\n\n1\\. 不是列表 段落\n');
    // Reopening gives the same two paragraphs, with the escapes out of sight.
    await page.evaluate(async saved => { await (window as any).fileApp.surface.load(saved); }, saved);
    const reopened = await page.evaluate(() => ({ blocks: [...document.querySelectorAll('#rich-root .ProseMirror > :not(.prosemirror-virtual-cursor):not(.ProseMirror-widget)')].map(node => node.tagName), text: [...document.querySelectorAll('#rich-root p')].map(node => (node as HTMLElement).innerText) }));
    expect(reopened.blocks.filter(tag => tag !== 'P')).toEqual([]);
    // A soft line break is displayed as a space.
    expect(reopened.text.slice(0, 2)).toEqual(['第一行 # 不是标题 第二行', '1. 不是列表 段落']);
  }, 30000);

  it('keeps a pipe typed in a table cell inside that cell', async () => {
    const table = '| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n';
    await open(table); await caret('一', 1);
    await page.keyboard.insertText('|竖线'); await settle();
    const saved = await markdown();
    expect(saved).toContain('一\\|竖线');
    await page.evaluate(async saved => { await (window as any).fileApp.surface.load(saved); }, saved);
    expect(await page.evaluate(() => [...document.querySelectorAll('#rich-root tr')].map(row => row.querySelectorAll('th,td').length))).toEqual([2, 2]);
  }, 30000);

  it('writes pasted rich text as Markdown source', async () => {
    await open('开头\n'); await caret('开头', 2);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/html', '<p>甲<b>粗</b>乙<i>斜</i>丙<code>码</code>丁<del>删</del></p>'); data.setData('text/plain', '甲粗乙斜丙码丁删');
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => (window as any).fileApp.surface.getMarkdown().includes('甲'));
    expect(await markdown()).toBe('开头甲**粗**乙*斜*丙`码`丁~~删~~\n');
    expect(await page.evaluate(() => JSON.stringify((window as any).fileApp.surface.richView().state.doc.toJSON()).includes('"marks"'))).toBe(false);
    await page.keyboard.press('Control+z'); await page.waitForFunction(() => (window as any).fileApp.surface.getMarkdown() === '开头\n');
  }, 30000);

  it('keeps the table of contents and outline free of marker characters', async () => {
    await open('[TOC]\n\n## 标题 **粗** 与 `码` \\*\n\n正文\n'); await caret('正文'); await settle();
    expect(await page.locator('[data-croquill-toc] button').allTextContents()).toEqual(['标题 粗 与 码 *']);
    await page.evaluate(() => { const h = (window as any).fileApp; h.updateStats(); h.setSidebarTab('outline'); });
    expect(await page.locator('#outline button').allTextContents()).toEqual(['标题 粗 与 码 *']);
  }, 30000);
});
