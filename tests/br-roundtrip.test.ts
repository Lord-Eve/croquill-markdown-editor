import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { hasEquivalentMarkdownStructure, preservedMarkdownBlocks } from '../src/fidelity';
import { launchTestBrowser } from './browser';

const table = [
  '| 写法 | 内容 | 备注 |',
  '| :--- | ---: | :---: |',
  '| 四种 | 甲<br>乙<br/>丙<br />丁<BR>戊 | 待改 |',
  '| 连续 | 首<Br/><BR /><br>尾 | 不动 |',
  '',
].join('\n');

describe('bare HTML line break protection', () => {
  it.each(['<br>', '<br/>', '<br />', '<BR>', '<Br/>', '<BR />'])('allows %s in paragraphs and tables', br => {
    expect(preservedMarkdownBlocks('第一行' + br + '第二行')).toEqual([]);
    expect(preservedMarkdownBlocks('| 内容 |\n| --- |\n| 甲' + br + '乙 |\n')).toEqual([]);
  });

  it.each(['甲<br class="x">乙', '甲<br><span>乙</span>', '甲<br><kbd>乙</kbd>'])('protects the entire table containing %s', cell => {
    const original = '| 内容 | 备注 |\n| --- | --- |\n| ' + cell + ' | 原样 |\n';
    expect(preservedMarkdownBlocks(original)).toEqual([{ from: 0, to: original.length, raw: original, categories: ['HTML'] }]);
  });

  it('still distinguishes literal br spellings at the structure gate', () => {
    expect(hasEquivalentMarkdownStructure('甲<br/>乙', '甲<br>乙')).toBe(false);
    expect(hasEquivalentMarkdownStructure('甲<BR>乙', '甲<br>乙')).toBe(false);
  });
});

// Exercise the real editing surface and its save port in headless Chromium.
// This verifies DOM/key behavior, not native desktop or Typora acceptance.
describe('bare HTML line breaks through the production editor', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.tools/**', '**/src-tauri/**'] } },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(baseURL + '/tests/harness.html');
    await page.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      import { DocumentSession } from '/src/session.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const h = window.brHarness = { richRoot, sourceRoot, saved: '' };
      h.session = new DocumentSession({ write: async (_path, text) => { h.saved = text; return { revision: 'test' }; } });
      h.session.path = 'D:/notes/br.md';
      h.surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: text => h.session.edit(text), resolveImage: async src => src });
      h.save = async () => { h.session.edit(h.surface.getMarkdown()); await h.session.save(); return h.saved; };
      h.selectText = (text, offset = 0) => {
        const view = h.surface.richView(); let position;
        view.state.doc.descendants((node, pos) => { if (node.isText && node.text === text && position === undefined) position = pos + offset; });
        if (position === undefined) throw Error('Text not found: ' + text);
        view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(position)))); view.focus();
      };
    ` });
    await page.waitForFunction(() => 'brHarness' in window);
  });
  afterEach(async () => {
    await page?.evaluate(async () => { await (window as any).brHarness?.surface.destroy(); });
    await page?.close();
  });

  it.each(['LF', 'CRLF'])('renders mixed spellings and saves untouched %s bytes across modes', async newline => {
    const original = newline === 'CRLF' ? table.replace(/\n/g, '\r\n') : table;
    const result = await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original);
      const initial = { mode: h.surface.mode, reason: h.surface.getSafetyReason(), rawBlocks: h.richRoot.querySelectorAll('[data-croquill-raw]').length, tables: h.richRoot.querySelectorAll('.milkdown-table-block table.children').length, breaks: h.richRoot.querySelectorAll('td br').length };
      const saved = await h.save();
      for (let i = 0; i < 3; i++) { await h.surface.setMode('source'); await h.surface.setMode('rich'); }
      return { ...initial, saved, switched: await h.save(), finalMode: h.surface.mode };
    }, original);
    expect(result).toMatchObject({ mode: 'rich', reason: null, rawBlocks: 0, tables: 1, breaks: 7, finalMode: 'rich' });
    expect(Buffer.from(result.saved).equals(Buffer.from(original))).toBe(true);
    expect(Buffer.from(result.switched).equals(Buffer.from(original))).toBe(true);
  }, 30000);

  it.each(['LF', 'CRLF'])('edits another cell without changing any other table bytes (%s)', async newline => {
    const original = newline === 'CRLF' ? table.replace(/\n/g, '\r\n') : table;
    const result = await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original);
      h.selectText('待改');
      const view = h.surface.richView(), from = view.state.selection.from;
      view.dispatch(view.state.tr.insertText('已改', from, from + 2));
      const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { saved, switched: await h.save(), mode: h.surface.mode, breaks: h.richRoot.querySelectorAll('td br').length };
    }, original);
    expect(result.saved).toBe(original.replace('待改', '已改'));
    expect(result.switched).toBe(result.saved);
    expect(result).toMatchObject({ mode: 'rich', breaks: 7 });
  }, 30000);

  it.each(['<br>', '<br/>', '<br />', '<BR>'])('renders a paragraph break and preserves %s after editing', async br => {
    const original = '第一行' + br + '第二行\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original);
      const paragraph = Array.from(h.richRoot.querySelectorAll('.ProseMirror > p')).find((p: any) => p.textContent === '第一行第二行') as HTMLElement | undefined;
      const shape = paragraph ? Array.from(paragraph.childNodes).map(node => node.nodeName) : [];
      h.selectText('第二行');
      const view = h.surface.richView(); view.dispatch(view.state.tr.insertText('新', view.state.selection.from));
      return { shape, mode: h.surface.mode, saved: await h.save(), rawBlocks: h.richRoot.querySelectorAll('[data-croquill-raw]').length };
    }, original);
    expect(result).toMatchObject({ shape: ['#text', 'BR', '#text'], mode: 'rich', rawBlocks: 0 });
    expect(result.saved).toBe('第一行' + br + '新第二行\n');
  }, 30000);

  it('saves Shift+Enter inside a cell as <br> and removes it with Backspace', async () => {
    const original = '| 内容 | 备注 |\n| --- | --- |\n| 甲乙 | 不动 |\n';
    await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original); h.selectText('甲乙', 1);
    }, original);
    await page.keyboard.press('Shift+Enter');
    const inserted = await page.evaluate(async () => {
      const h = (window as any).brHarness;
      return { saved: await h.save(), breaks: h.richRoot.querySelectorAll('td br').length };
    });
    expect(inserted).toEqual({ saved: original.replace('甲乙', '甲<br>乙'), breaks: 1 });
    await page.keyboard.press('Backspace');
    expect(await page.evaluate(() => (window as any).brHarness.save())).toBe(original);
    expect(await page.locator('td br').count()).toBe(0);
  }, 30000);

  it('deletes an existing original <br/> from the saved cell', async () => {
    const original = '| 内容 | 备注 |\n| --- | --- |\n| 甲<br/>乙 | 不动 |\n';
    await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original); h.selectText('乙');
    }, original);
    await page.keyboard.press('Backspace');
    const saved = await page.evaluate(() => (window as any).brHarness.save());
    expect(saved).toBe(original.replace('<br/>', ''));
    expect(await page.locator('td br').count()).toBe(0);
  }, 30000);

  it.each([
    { name: 'table cell', original: '| 内容 | 备注 |\n| --- | --- |\n| 甲<br/> | 待改 |\n', editable: '待改' },
    { name: 'table header', original: '| 标题<BR /> | 备注 |\n| --- | --- |\n| 甲 | 待改 |\n', editable: '待改' },
    { name: 'paragraph', original: '首行<Br/>\n', editable: '首行' },
  ])('preserves a trailing original br in a $name before and after edits', async ({ original, editable }) => {
    const result = await page.evaluate(async ({ original, editable }) => {
      const h = (window as any).brHarness;
      await h.surface.init(original);
      const untouched = await h.save();
      h.selectText(editable);
      const view = h.surface.richView(); view.dispatch(view.state.tr.insertText('新', view.state.selection.from));
      const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { untouched, saved, switched: await h.save(), mode: h.surface.mode };
    }, { original, editable });
    expect(result.untouched).toBe(original);
    expect(result.saved).toBe(original.replace(editable, '新' + editable));
    expect(result.switched).toBe(result.saved);
    expect(result.mode).toBe('rich');
  }, 30000);

  it('inserts consecutive breaks in the middle of a cell with a trailing br and supports header breaks', async () => {
    const original = '| 内容<BR> | 备注 |\n| --- | --- |\n| 甲乙<br/> | 不动 |\n';
    await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original); h.selectText('甲乙', 1);
    }, original);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    expect(await page.evaluate(() => (window as any).brHarness.save())).toBe(original.replace('甲乙', '甲<br><br>乙'));
    await page.evaluate(() => (window as any).brHarness.selectText('内容', 1));
    await page.keyboard.press('Shift+Enter');
    const result = await page.evaluate(async () => {
      const h = (window as any).brHarness;
      const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { saved, switched: await h.save(), mode: h.surface.mode };
    });
    expect(result.saved).toBe(original.replace('甲乙', '甲<br><br>乙').replace('内容', '内<br>容'));
    expect(result.switched).toBe(result.saved);
    expect(result.mode).toBe('rich');
  }, 30000);

  it('keeps all paragraph text when inserting before a trailing original br', async () => {
    const original = '甲乙<br/>\n';
    await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original); h.selectText('甲乙', 1);
    }, original);
    await page.keyboard.press('Shift+Enter');
    const result = await page.evaluate(async () => {
      const h = (window as any).brHarness;
      const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { saved, switched: await h.save(), mode: h.surface.mode };
    });
    expect(hasEquivalentMarkdownStructure('甲\\\n乙<br/>\n', result.saved)).toBe(true);
    expect(result.saved).toContain('<br/>');
    expect(result.switched).toBe(result.saved);
    expect(result.mode).toBe('rich');
  }, 30000);

  it.each(['event flag', 'active composition'])('leaves table Shift+Enter to the IME during %s', async composing => {
    const original = '| 内容 | 备注 |\n| --- | --- |\n| 甲乙<br/> | 不动 |\n';
    const result = await page.evaluate(async ({ original, composing }) => {
      const h = (window as any).brHarness;
      await h.surface.init(original); h.selectText('甲乙', 1);
      const view = h.surface.richView();
      if (composing === 'active composition') view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '字', bubbles: true }));
      const active = view.composing;
      const event = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true,
        isComposing: composing === 'event flag', bubbles: true, cancelable: true,
      });
      view.dom.dispatchEvent(event);
      return { saved: await h.save(), prevented: event.defaultPrevented, active };
    }, { original, composing });
    expect(result.saved).toBe(original);
    expect(result.prevented).toBe(false);
    expect(result.active).toBe(composing === 'active composition');
  }, 30000);

  it('inserts consecutive breaks at the end of a cell without splitting the table', async () => {
    const original = '| 内容 | 备注 |\n| --- | --- |\n| 甲乙<br/> | 不动 |\n';
    await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original);
      const view = h.surface.richView(); let position: number | undefined;
      view.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'hardbreak' && node.attrs.croquillHtmlBreak === '<br/>') position = pos + node.nodeSize;
      });
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(position!))));
      view.focus();
    }, original);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    const result = await page.evaluate(async () => {
      const h = (window as any).brHarness;
      const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { saved, switched: await h.save(), tables: h.richRoot.querySelectorAll('.milkdown-table-block table.children').length };
    });
    expect(result.saved).toBe(original.replace('<br/>', '<br/><br><br>'));
    expect(result.switched).toBe(result.saved);
    expect(result.tables).toBe(1);
  }, 30000);

  it.each(['甲<br class="x">乙', '甲<br><span>乙</span>'])('keeps a table with other HTML opaque: %s', async cell => {
    const original = '| 内容 |\n| --- |\n| ' + cell + ' |\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).brHarness;
      await h.surface.init(original);
      return { mode: h.surface.mode, blocks: h.richRoot.querySelectorAll('[data-croquill-raw]').length, tables: h.richRoot.querySelectorAll('table').length, saved: await h.save() };
    }, original);
    expect(result).toEqual({ mode: 'rich', blocks: 1, tables: 0, saved: original });
  }, 30000);
});
