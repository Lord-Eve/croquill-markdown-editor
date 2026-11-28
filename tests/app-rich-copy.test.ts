import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

interface ClipboardResult {
  html: string;
  plain: string;
  internal: string;
  prevented: boolean;
}

describe('formatted clipboard copy and cut through the real app', () => {
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

  async function open(source: string) {
    await openFileApp(page, baseURL, { files: { [currentFile]: source } });
    await focusApp(page, 'rich');
    await page.waitForFunction(() => Date.now() - (window as any).fileApp.surface.richView().input.lastFocus > 200);
  }

  async function selectRange(fromNeedle: string, fromOffset: number, toNeedle = fromNeedle, toOffset?: number) {
    await page.evaluate(({ fromNeedle, fromOffset, toNeedle, toOffset }) => {
      const v = (window as any).fileApp.surface.richView();
      let fromPos: number | undefined, toPos: number | undefined;
      v.state.doc.descendants((node: any, pos: number) => {
        if (!node.isText) return;
        const text = node.text as string;
        if (fromPos === undefined) {
          const i = text.indexOf(fromNeedle);
          if (i >= 0) fromPos = pos + i + fromOffset;
        }
        const j = text.indexOf(toNeedle);
        if (j >= 0 && (fromPos !== undefined || toNeedle !== fromNeedle)) {
          toPos = pos + j + (toOffset ?? toNeedle.length);
        }
      });
      if (fromPos === undefined || toPos === undefined) throw Error(`Missing range: ${fromNeedle} -> ${toNeedle}`);
      const BaseSelection = Object.getPrototypeOf(v.state.selection.constructor);
      v.dispatch(v.state.tr.setSelection(BaseSelection.fromJSON(v.state.doc, { type: 'text', anchor: fromPos, head: toPos })));
      v.focus();
    }, { fromNeedle, fromOffset, toNeedle, toOffset });
  }

  async function selectAllDoc() {
    await page.keyboard.press('Control+a');
  }

  function dispatchClipboard(type: 'copy' | 'cut'): Promise<ClipboardResult> {
    return page.evaluate(type => {
      const target = document.querySelector('#rich-root .ProseMirror') as HTMLElement;
      const clipboardData = new DataTransfer();
      const event = new ClipboardEvent(type, { clipboardData, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return {
        html: clipboardData.getData('text/html'),
        plain: clipboardData.getData('text/plain'),
        internal: clipboardData.getData('application/x-croquill-html'),
        prevented: event.defaultPrevented,
      };
    }, type);
  }

  async function dispatchPaste(payload: { html: string; plain: string; internal?: string }) {
    await page.evaluate(({ html, plain, internal }) => {
      const target = document.querySelector('#rich-root .ProseMirror') as HTMLElement;
      const clipboardData = new DataTransfer();
      if (html) clipboardData.setData('text/html', html);
      if (plain) clipboardData.setData('text/plain', plain);
      if (internal) clipboardData.setData('application/x-croquill-html', internal);
      const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    }, payload);
  }

  it('copies formatted HTML covering every inline format, block, inline styles, and no markers or comments', async () => {
    const doc = [
      '# 标题文字 {#custom-id}',
      '',
      '甲 **加粗** __下粗__ *斜体* _下斜_ ~~删除~~ `行码` ==高亮== [链接](https://a.com "题") <https://b.com> https://c.com <span style="color:red">红字</span> \\*转义\\* &amp; &copy; $a^2$ 前<!-- 行内注 -->后',
      '',
      '首行<br />次行<br>三行',
      '',
      '- 无序项',
      '',
      '1. 有序项',
      '',
      '- [x] 任务项',
      '',
      '> 普通引用',
      '',
      '> [!NOTE]',
      '> 提示内容',
      '',
      '| 列头一 | 列头二 |',
      '| :--- | ---: |',
      '| 格一 | 格二 |',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '---',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '正文脚注[^n]',
      '',
      '[^n]: 脚注内容',
      '',
      '::: note\n保护块内容\n:::',
      '',
      '<div align="center">HTML块内容</div>',
      '',
      '<!-- 块级作者注释 -->',
      '',
    ].join('\n');
    await open(doc);
    await selectAllDoc();
    const { html, plain, internal, prevented } = await dispatchClipboard('copy');
    expect(prevented).toBe(true);
    expect(internal).toContain('data-pm-slice');
    expect(plain).toContain('**加粗**');

    // Tags and decoded text.
    const parsed = await page.evaluate(html => {
      const box = document.createElement('div');
      box.innerHTML = html;
      return {
        h1Text: box.querySelector('h1')?.textContent ?? null,
        h1Id: box.querySelector('h1')?.getAttribute('id') ?? null,
        strongCount: box.querySelectorAll('strong').length,
        emCount: box.querySelectorAll('em').length,
        delText: box.querySelector('del')?.textContent ?? null,
        inlineCodeStyle: Array.from(box.querySelectorAll('code')).find(c => !c.closest('pre'))?.getAttribute('style') ?? '',
        preStyle: box.querySelector('pre')?.getAttribute('style') ?? '',
        markStyle: box.querySelector('mark')?.getAttribute('style') ?? '',
        hrefs: Array.from(box.querySelectorAll('a')).map(a => a.getAttribute('href')),
        spanStyle: Array.from(box.querySelectorAll('span')).find(s => s.textContent === '红字')?.getAttribute('style') ?? '',
        thStyle: box.querySelector('th')?.getAttribute('style') ?? '',
        tdStyle: box.querySelector('td')?.getAttribute('style') ?? '',
        quoteStyle: Array.from(box.querySelectorAll('blockquote'))[0]?.getAttribute('style') ?? '',
        alertQuoteStyle: Array.from(box.querySelectorAll('blockquote'))[1]?.getAttribute('style') ?? '',
        mathCount: box.querySelectorAll('math').length,
        brCount: box.querySelectorAll('br').length,
        ulCount: box.querySelectorAll('ul').length,
        olCount: box.querySelectorAll('ol').length,
        taskChecked: box.querySelector('input[type="checkbox"]')?.hasAttribute('checked') ?? false,
        hrCount: box.querySelectorAll('hr').length,
        supText: box.querySelector('sup')?.textContent ?? null,
        asideText: box.querySelector('aside')?.textContent ?? null,
        text: box.textContent ?? '',
      };
    }, html);

    expect(parsed.h1Text).toBe('标题文字');
    expect(parsed.h1Id).toBeNull();
    expect(parsed.strongCount).toBeGreaterThanOrEqual(2);
    expect(parsed.emCount).toBeGreaterThanOrEqual(2);
    expect(parsed.delText).toBe('删除');
    expect(parsed.hrefs).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    expect(parsed.spanStyle).toContain('color: red');
    expect(parsed.text).toContain('*转义*');
    expect(parsed.text).toContain('& ©');
    expect(parsed.text).toContain('保护块内容');
    expect(parsed.text).toContain('HTML块内容');
    expect(parsed.mathCount).toBeGreaterThanOrEqual(2);
    expect(parsed.brCount).toBeGreaterThanOrEqual(2);
    expect(parsed.ulCount).toBeGreaterThanOrEqual(2);
    expect(parsed.olCount).toBeGreaterThanOrEqual(1);
    expect(parsed.taskChecked).toBe(true);
    expect(parsed.hrCount).toBeGreaterThanOrEqual(1);
    expect(parsed.supText).toBe('n');
    expect(parsed.asideText).toContain('脚注内容');

    // Inline styles required for Word / WeChat.
    expect(parsed.inlineCodeStyle).toMatch(/monospace/i);
    expect(parsed.inlineCodeStyle).toContain('#f7f7f7');
    expect(parsed.preStyle).toMatch(/monospace/i);
    expect(parsed.preStyle).toContain('#f8f8f8');
    expect(parsed.markStyle).toContain('#fff3a3');
    expect(parsed.thStyle).toContain('1px solid #dfe2e5');
    expect(parsed.thStyle).toContain('font-weight: 700');
    expect(parsed.tdStyle).toContain('1px solid #dfe2e5');
    expect(parsed.quoteStyle).toContain('border-left');
    expect(parsed.quoteStyle).toContain('#777777');
    expect(parsed.alertQuoteStyle).toContain('border-left');

    // Forbidden marker characters, internal attributes/classes, and comments.
    expect(html).not.toContain('#custom-id');
    expect(html).not.toContain('行内注');
    expect(html).not.toContain('块级作者注释');
    expect(html).not.toMatch(/\*\*|__|~~|==|`|\[|\]\(/);
    expect(html).not.toMatch(/data-croquill-alert|croquill-alert-title|class="task"|class="footnote"|class="katex"|md-marker|data-pm-slice/);
  });

  it('keeps light-theme clipboard colors under dark mode with no white text or dark backgrounds', async () => {
    const doc = '# 深色测试\n\n含 `码` 与 ==高亮==。\n\n> 引用\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    await open(doc);
    await selectAllDoc();
    const light = await dispatchClipboard('copy');

    await page.evaluate(() => (window as any).fileApp.action('dark'));
    await selectAllDoc();
    const dark = await dispatchClipboard('copy');

    expect(dark.html).toBe(light.html);
    expect(dark.html.toLowerCase()).not.toMatch(/color:\s*(?:#fff\b|#ffffff\b|white\b|rgb\(255,\s*255,\s*255\)|#b8bfc6|rgb\(184,\s*191,\s*198\))/);
    expect(dark.html.toLowerCase()).not.toMatch(/background(?:-color)?:\s*(?:#363b40|#2e3338|#756013|#333333|rgb\(54,\s*59,\s*64\)|rgb\(46,\s*51,\s*56\))/);
  });

  it('reconstructs inline formatting on partial selections including table CellSelection', async () => {
    await open('甲**加粗**乙\n');
    await selectRange('加粗', 1, '加粗', 2);
    let clip = await dispatchClipboard('copy');
    expect(clip.html).toBe('<strong>粗</strong>');
    expect(clip.html).not.toContain('**');
    expect(clip.plain).toBe('粗');

    await open('甲**加粗**乙\n');
    await selectRange('加粗**乙', 1, '加粗**乙', 5);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toBe('<strong>粗</strong>乙');
    expect(clip.html).not.toContain('**');

    await open('**加 粗**\n');
    await selectRange('加 粗', 1, '加 粗', 3);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toBe(' <strong>粗</strong>');
    expect(clip.html).not.toContain('**');

    await open('[链接文字](https://a.com)\n');
    await selectRange('链接文字', 2, '链接文字', 4);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toBe('<a href="https://a.com">文字</a>');
    expect(clip.html).not.toMatch(/\[|\]\(/);

    await open('上段**一二**\n\n**三四**下段\n');
    await selectRange('一二', 1, '三四', 1);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toBe('<p><strong>二</strong></p><p><strong>三</strong></p>');
    expect(clip.html).not.toContain('**');

    // Table CellSelection: 2 body cells keep border styling without inventing <th>.
    await open('| 头一 | 头二 |\n| --- | --- |\n| 格一 | **格二** |\n');
    const selectCells = (fromIdx: number, toIdx: number) => page.evaluate(({ fromIdx, toIdx }) => {
      const v = (window as any).fileApp.surface.richView();
      const cells: number[] = [];
      v.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'table_cell' || node.type.name === 'table_header') cells.push(pos);
      });
      const BaseSelection = Object.getPrototypeOf(v.state.selection.constructor);
      const sel = BaseSelection.fromJSON(v.state.doc, { type: 'cell', anchor: cells[fromIdx], head: cells[toIdx] });
      v.dispatch(v.state.tr.setSelection(sel));
      v.focus();
    }, { fromIdx, toIdx });
    await selectCells(2, 3);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toContain('<table');
    expect(clip.html).toContain('<td');
    expect(clip.html).not.toContain('<th');
    expect(clip.html).toContain('1px solid #dfe2e5');
    expect(clip.html).toContain('<strong>格二</strong>');

    // Table CellSelection spanning header + body keeps <thead><th> bold and <tbody><td>.
    await selectCells(0, 2);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toContain('<thead');
    expect(clip.html).toContain('<th');
    expect(clip.html).toContain('font-weight: 700');
    expect(clip.html).toContain('<td');

    // Selecting text inside a single cell does not wrap a <table>.
    await selectRange('格二', 0, '格二', 1);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toBe('<strong>格</strong>');
  });

  it('resolves reference links inside table cells from definitions outside the table', async () => {
    await open('| 列头一 | 列头二 |\n| --- | --- |\n| 占位 | 格二 |\n\n<div>\n\n[r]: https://r.com\n\n</div>\n');
    expect(await page.evaluate(() => (window as any).fileApp.surface.mode)).toBe('rich');

    // Type/insert a reference link `[文][r]` into the first body cell, matching real rich editing.
    await selectRange('占位', 0, '占位', 2);
    await page.keyboard.insertText('[文][r]');
    await page.evaluate(() => (window as any).fileApp.surface.getMarkdown());

    const selectCells = (fromIdx: number, toIdx: number) => page.evaluate(({ fromIdx, toIdx }) => {
      const v = (window as any).fileApp.surface.richView();
      const cells: number[] = [];
      v.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'table_cell' || node.type.name === 'table_header') cells.push(pos);
      });
      const BaseSelection = Object.getPrototypeOf(v.state.selection.constructor);
      const sel = BaseSelection.fromJSON(v.state.doc, { type: 'cell', anchor: cells[fromIdx], head: cells[toIdx] });
      v.dispatch(v.state.tr.setSelection(sel));
      v.focus();
    }, { fromIdx, toIdx });

    // Copying only the cell containing `[文][r]` (and multi-cell row) keeps the external href.
    await selectCells(2, 2);
    let clip = await dispatchClipboard('copy');
    expect(clip.html).toContain('<a href="https://r.com">文</a>');
    expect(clip.html).toContain('<table');
    expect(clip.html).toContain('1px solid #dfe2e5');

    await selectCells(2, 3);
    clip = await dispatchClipboard('copy');
    expect(clip.html).toContain('<a href="https://r.com">文</a>');

    // Copying the whole table preserves `<a href="https://r.com">文</a>` with table headers and borders.
    await page.evaluate(() => {
      const v = (window as any).fileApp.surface.richView();
      const table = v.state.doc.firstChild;
      const BaseSelection = Object.getPrototypeOf(v.state.selection.constructor);
      v.dispatch(v.state.tr.setSelection(BaseSelection.fromJSON(v.state.doc, { type: 'text', anchor: 0, head: table.nodeSize })));
      v.focus();
    });
    clip = await dispatchClipboard('copy');
    expect(clip.html).toContain('<a href="https://r.com">文</a>');
    expect(clip.html).toContain('<table');
    expect(clip.html).toContain('<th');
    expect(clip.html).toContain('<td');
  });

  it('keeps plain text Markdown identical for representative selections', async () => {
    await open('前__粗__与*斜*\n\n# 标题 {#id}\n\n> 引一\n>\n> 引二\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n');
    await selectRange('前', 0, '*斜*', 3);
    expect((await dispatchClipboard('copy')).plain).toBe('前__粗__与*斜*');

    await selectRange('标题', 0, '标题', 2);
    expect((await dispatchClipboard('copy')).plain).toBe('标题');

    await selectRange('引一', 0, '引二', 2);
    expect((await dispatchClipboard('copy')).plain).toBe('> 引一\n>\n> 引二\n');
  });

  it('preserves exact source spelling when pasting copied Croquill content back into Croquill', async () => {
    const cases: { source: string; mode: 'inline' | 'block' | 'raw'; expected: string }[] = [
      {
        source: '__粗__ 和 *斜* 与 _斜_',
        mode: 'inline',
        expected: '__粗__ 和 *斜* 与 _斜_\n\n目标点__粗__ 和 *斜* 与 _斜_\n',
      },
      {
        source: '<span style="color:red">红</span>',
        mode: 'inline',
        expected: '<span style="color:red">红</span>\n\n目标点<span style="color:red">红</span>\n',
      },
      {
        source: '前<!-- 作者注 -->后',
        mode: 'raw',
        expected: '前<!-- 作者注 -->后\n\n目标点<!-- 作者注 -->\n',
      },
      {
        source: '# 标题 {#id}',
        mode: 'block',
        expected: '# 标题 {#id}\n\n目标点\n\n# 标题 {#id}\n',
      },
      {
        source: '> 引用一\n>\n> 引用二',
        mode: 'block',
        expected: '> 引用一\n>\n> 引用二\n\n目标点\n\n> 引用一\n>\n> 引用二\n',
      },
    ];
    for (const item of cases) {
      await open(item.source + '\n\n目标点\n');
      if (item.mode === 'block') {
        await page.evaluate(() => {
          const v = (window as any).fileApp.surface.richView();
          const first = v.state.doc.firstChild;
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 0, first.nodeSize)));
        });
      } else if (item.mode === 'raw') {
        await page.evaluate(() => {
          const v = (window as any).fileApp.surface.richView();
          let pos = -1;
          v.state.doc.descendants((node: any, at: number) => {
            if (pos < 0 && node.type.name === 'croquill_inline_raw') pos = at;
          });
          const BaseSelection = Object.getPrototypeOf(v.state.selection.constructor);
          v.dispatch(v.state.tr.setSelection(BaseSelection.fromJSON(v.state.doc, { type: 'node', anchor: pos })));
        });
      } else if (item.source.includes('span')) {
        await page.evaluate(() => {
          const v = (window as any).fileApp.surface.richView();
          const p = v.state.doc.firstChild;
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, 1 + p.content.size)));
        });
      } else {
        await selectRange('__粗__', 0, '_斜_');
      }
      const copied = await dispatchClipboard('copy');
      if (item.mode === 'raw') {
        expect(copied.html).toBe('');
        expect(copied.plain).toBe('<!-- 作者注 -->');
        expect(copied.internal).toContain('data-croquill-inline-raw');
      } else {
        expect(copied.html).not.toContain('__');
        expect(copied.html).not.toContain('{#id}');
      }

      // Move caret to end of 目标点 and paste the exact DataTransfer.
      await page.evaluate(() => {
        const v = (window as any).fileApp.surface.richView();
        let pos = 0;
        v.state.doc.descendants((node: any, at: number) => {
          if (node.isText && node.text === '目标点') pos = at + 3;
        });
        const BaseSelection = Object.getPrototypeOf(v.state.selection.constructor);
        v.dispatch(v.state.tr.setSelection(BaseSelection.fromJSON(v.state.doc, { type: 'text', anchor: pos, head: pos })));
      });
      await dispatchPaste(copied);
      expect(await markdown()).toBe(item.expected);
    }

    // Table paste keeps original source structure intact.
    const table = '| 甲 | 乙 |\n| --- | --- |\n| 一 | __二__ |\n';
    await open(table + '\n目标段\n');
    await page.evaluate(() => {
      const v = (window as any).fileApp.surface.richView();
      const t = v.state.doc.firstChild;
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 0, t.nodeSize)));
    });
    const copiedTable = await dispatchClipboard('copy');
    expect(copiedTable.html).toContain('<table');
    expect(copiedTable.html).not.toContain('__');
    await page.evaluate(() => {
      const v = (window as any).fileApp.surface.richView();
      let pos = 0;
      v.state.doc.descendants((node: any, at: number) => { if (node.isText && node.text === '目标段') pos = at + 3; });
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, pos)));
    });
    await dispatchPaste(copiedTable);
    expect(await markdown()).toBe(`${table}\n目标段\n\n| 甲  | 乙     |\n| :- | :---- |\n| 一  | __二__ |\n`);
  });

  it('writes identical clipboard formats on cut, removes the selection, and restores in one Ctrl+z', async () => {
    const original = '前缀**加粗**后缀\n';
    await open(original);
    await selectRange('加粗', 0, '加粗', 2);
    const copied = await dispatchClipboard('copy');
    const cut = await dispatchClipboard('cut');

    expect(cut.html).toBe(copied.html);
    expect(cut.plain).toBe(copied.plain);
    expect(await markdown()).toBe('前缀****后缀\n');

    await page.keyboard.press('Control+z');
    expect(await markdown()).toBe(original);
  });

  it('does not intercept copy/cut during IME composition or inside raw HTML textarea', async () => {
    await open('甲**粗**乙\n');
    await selectRange('粗', 0, '粗', 1);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await page.waitForFunction(() => (window as any).fileApp.surface.richView().composing);
    const blockedComposing = await page.evaluate(() => {
      const target = document.querySelector('#rich-root .ProseMirror') as HTMLElement;
      const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(blockedComposing).toBe(false);
    await cdp.detach();

    await open('<div>源码内容</div>\n');
    await page.locator('.croquill-html-preview').click();
    const textareaPrevented = await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      textarea.select();
      const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(textareaPrevented).toBe(false);
  });
});
