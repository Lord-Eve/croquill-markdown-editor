import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';

describe('find and replace through both production editing surfaces', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    const address = server.httpServer!.address(); if (!address || typeof address === 'string') throw Error('No server');
    baseURL = 'http://127.0.0.1:' + address.port; browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.route('**/tests/search.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>body{max-width:960px;margin:20px auto}.milkdown .ProseMirror{padding:30px}[hidden]{display:none!important}</style><body></body></html>' }));
    await page.goto(baseURL + '/tests/search.html');
    await page.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      import { DocumentSession } from '/src/session.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const h = window.searchHarness = {richRoot, sourceRoot, edits: [], errors: []};
      h.session = new DocumentSession({write: async (_path, text) => {h.saved = text;return {revision:'test'};}});
      h.session.path = 'D:/验收/查找.md';
      h.surface = new MarkdownSurface({richRoot, sourceRoot, onChange: text => {h.edits.push(text);h.session.edit(text);}, resolveImage: async src => src});
      h.save = async () => {h.session.edit(h.surface.getMarkdown());await h.session.save();return h.saved;};
      h.load = async (text, mode) => {await h.surface.load(text);if(mode === 'source')await h.surface.setMode('source');h.surface.focus();};
      h.type = text => {const view = h.surface.richView();view.dispatch(view.state.tr.insertText(text,1));view.focus();};
      h.markdown = () => h.surface.getMarkdown();
    ` });
    await page.waitForFunction(() => !!(window as any).searchHarness?.surface);
  });
  afterEach(async () => { await page?.evaluate(async () => { await (window as any).searchHarness?.surface.destroy(); }); await page?.close(); });
  const load = async (source: string, mode: string) => {
    const actual = await page.evaluate(async ({ source, mode }) => { const h = (window as any).searchHarness; await h.load(source, mode); return { mode: h.surface.mode, reason: h.surface.getSafetyReason() }; }, { source, mode });
    expect(actual, actual.reason || '').toMatchObject({ mode });
  };
  const markdown = async () => page.evaluate(() => (window as any).searchHarness.markdown());
  const query = () => page.getByRole('textbox', { name: '查找内容', exact: true });
  const replacement = () => page.getByRole('textbox', { name: '替换为', exact: true });
  const count = async () => page.locator('[data-search-count]').textContent();
  const command = async (name: string) => page.locator(`[data-search-command="${name}"]`).click();

  it.each(['\n', '\r\n'])('opens the manual sample, searches without editing, and preserves bytes over modes (%j)', async eol => {
    const source = readFileSync(new URL('../examples/search-replace.md', import.meta.url), 'utf8').replace(/\r?\n/g, eol);
    await load(source, 'rich'); await page.keyboard.press('Control+f'); await query().fill('更深一级的目录条目应正常横排');
    expect(await count()).toBe('1 / 1');
    const ranges = await page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => name.startsWith('croquill-search-') && !name.endsWith('current')).flatMap(([, highlight]) => [...highlight].map(range => range.toString())));
    expect(ranges).toEqual(['更深一级的目录条目应正常横排']);
    expect(await page.evaluate(async () => (window as any).searchHarness.save())).toBe(source);
    await page.evaluate(async () => { const h = (window as any).searchHarness; await h.surface.setMode('source'); await h.surface.setMode('rich'); });
    expect(await count()).toBe('1 / 1'); expect(await markdown()).toBe(source);
  });

  it.each(['rich', 'source'])('opens shortcuts, paints all matches and navigates/filters without changing %s bytes', async mode => {
    const source = 'cat cats CAT cat_ _cat cat2 cat\n\n中文，中文词；中文。\n'; await load(source, mode);
    await page.keyboard.press('Control+f'); await query().fill('cat'); expect(await count()).toBe('1 / 7');
    const paint = await page.evaluate(mode => mode === 'source' ? document.querySelectorAll('.croquill-search-match,.croquill-search-current').length : [...CSS.highlights.entries()].filter(([name]) => name.startsWith('croquill-search-') && !name.endsWith('current')).reduce((sum, [, highlight]) => sum + highlight.size, 0), mode);
    expect(paint).toBe(7);
    await command('next'); expect(await count()).toBe('2 / 7'); await command('previous'); expect(await count()).toBe('1 / 7');
    await command('previous'); expect(await count()).toBe('7 / 7'); await query().press('Enter'); expect(await count()).toBe('1 / 7');
    await command('case'); expect(await count()).toBe('1 / 6'); await command('word'); expect(await count()).toBe('1 / 2');
    await query().fill('中文'); expect(await count()).toBe('1 / 2'); await query().fill('不存在'); expect(await count()).toBe('0 / 0');
    await query().press('Escape'); expect(await page.locator('[data-search-panel]').isVisible()).toBe(false);
    expect(await markdown()).toBe(source);
    await page.keyboard.press('Control+h'); expect(await replacement().isVisible()).toBe(true);
    await query().press('Control+h'); expect(await page.locator('[data-search-panel]').isVisible()).toBe(false);
  });

  for (const mode of ['rich', 'source']) for (const eol of ['\n', '\r\n']) {
    it(`patches single/all matches byte for byte and undoes/redoes once (${mode}, ${eol.length === 1 ? 'LF' : 'CRLF'})`, async () => {
      const source = '\uFEFF' + ['# 查找标题', '', '__查找__ 和 查找  ', '', '| 格 | 不动 |', '| :----- | ---: |', '| 查找<br/>尾 | <span x="1">原样\\|字</span> |', '', '> [!NOTE]', '> 不动', '', '<div class="x">', '原文查找', '</div>', ''].join(eol);
      await load(source, mode); expect(await markdown()).toBe(source);
      await page.keyboard.press('Control+h'); await query().fill('查找'); expect(await count()).toBe('1 / 5'); await replacement().fill('$&新');
      await command('replace'); const single = source.replace('查找', '$$&新'); expect(await markdown()).toBe(single);
      await page.keyboard.press('Control+z'); expect(await markdown()).toBe(source);
      await page.keyboard.press('Control+y'); expect(await markdown()).toBe(single);
      await command('all'); const all = source.split('查找').join('$&新'); expect(await markdown()).toBe(all);
      await page.keyboard.press('Control+z'); expect(await markdown()).toBe(single);
      await page.keyboard.press('Control+y'); expect(await markdown()).toBe(all);
      expect(await page.evaluate(async () => (window as any).searchHarness.save())).toBe(all);
      await page.evaluate(async () => { const h = (window as any).searchHarness; await h.surface.setMode('source'); await h.surface.setMode('rich'); });
      expect(await markdown()).toBe(all);
    });
  }

  it.each(['rich', 'source'])('replaces inside raw blocks and inline atoms using source without rebuilding spelling (%s)', async mode => {
    const source = '# 标题\r\n\r\n前<span style="color:red">目标**原文**</span>后\r\n\r\n| 甲 | 乙 |\r\n| --- | :---: |\r\n| <kbd>目标\\|保留</kbd> | 不动<BR />行 |\r\n\r\n<div class="x">\r\n目标\r\n</div>\r\n';
    await load(source, mode); await page.keyboard.press('Control+h'); await query().fill('目标'); expect(await count()).toBe('1 / 3');
    if (mode === 'rich') {
      const painted = await page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => name.startsWith('croquill-search-') && !name.endsWith('current')).flatMap(([, highlight]) => [...highlight].map(range => range.toString())));
      expect(painted).toEqual(['目标', '目标', '目标']);
    }
    await replacement().fill('替换'); await command('all'); expect(await markdown()).toBe(source.split('目标').join('替换'));
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe(source);
    if (mode === 'rich') expect(await page.evaluate(() => (window as any).searchHarness.richRoot.querySelectorAll('[data-croquill-inline-raw]').length)).toBe(2);
  });

  it.each(['rich', 'source'])('suppresses find updates and shortcuts throughout input composition (%s)', async mode => {
    const source = '初始 中文 中文词\n'; await load(source, mode); await page.keyboard.press('Control+f'); await query().fill('初始'); expect(await count()).toBe('1 / 1');
    await query().evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      (input as HTMLInputElement).value = '中'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '中' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'h', ctrlKey: true, isComposing: true }));
    });
    expect(await count()).toBe('1 / 1'); expect(await replacement().isVisible()).toBe(false);
    await query().evaluate(input => {
      (input as HTMLInputElement).value = '中文'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '中文' }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    });
    expect(await count()).toBe('1 / 2'); expect(await query().inputValue()).toBe('中文'); expect(await markdown()).toBe(source);
  });

  it.each(['rich', 'source'])('refreshes results after ordinary edits, mode changes and loading another document (%s)', async mode => {
    await load('目标 目标\n', mode); await page.keyboard.press('Control+f'); await query().fill('目标'); expect(await count()).toBe('1 / 2');
    await page.evaluate(mode => { const h = (window as any).searchHarness; if (mode === 'source') { const v = h.surface.source; v.dispatch({ changes: { from: 0, insert: '目标 ' } }); } else h.type('目标 '); }, mode);
    await page.waitForFunction(() => document.querySelector('[data-search-count]')?.textContent === '1 / 3');
    await page.evaluate(async () => { const h = (window as any).searchHarness; await h.surface.setMode('source'); await h.surface.setMode('rich'); }); expect(await count()).toBe('1 / 3');
    await load('新文档目标\r\n', mode); expect(await count()).toBe('1 / 1'); expect(await markdown()).toBe('新文档目标\r\n');
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe('新文档目标\r\n');
  });

  it('keeps source-only rich replacements in history even when rendered content is identical', async () => {
    const source = '\uFEFF---\r\ntitle: 原标题\r\n---\r\n\r\n__粗体__\r\n'; await load(source, 'rich'); await page.keyboard.press('Control+h');
    await query().fill('原标题'); await replacement().fill('新标题'); await command('all'); const metadata = source.replace('原标题', '新标题'); expect(await markdown()).toBe(metadata);
    await query().fill('__'); await replacement().fill('**'); await command('all'); const spelling = metadata.split('__').join('**'); expect(await markdown()).toBe(spelling);
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe(metadata); await page.keyboard.press('Control+z'); expect(await markdown()).toBe(source);
    await page.keyboard.press('Control+y'); expect(await markdown()).toBe(metadata); await page.keyboard.press('Control+y'); expect(await markdown()).toBe(spelling);
    await page.evaluate(() => (window as any).searchHarness.type('新'));
    expect((await markdown()).replace(/\r\n/g, '\n')).toBe(spelling.replace('**粗体**', '**新粗体**').replace(/\r\n/g, '\n'));
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe(spelling);
  });

  it('separates a rich replacement from the preceding typing history', async () => {
    await load('目标\n', 'rich'); await page.evaluate(() => (window as any).searchHarness.type('先写 '));
    await page.keyboard.press('Control+h'); await query().fill('目标'); await replacement().fill('替换'); await command('all'); expect(await markdown()).toBe('先写 替换\n');
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe('先写 目标\n');
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe('目标\n');
    await page.keyboard.press('Control+y'); expect(await markdown()).toBe('先写 目标\n'); await page.keyboard.press('Control+y'); expect(await markdown()).toBe('先写 替换\n');
  });

  it('retains mixed source line endings after replacements and ordinary source typing', async () => {
    const source = '\uFEFF目标\r\n\r\n第二段目标\n\n不动\r\n'; await load(source, 'source'); await page.keyboard.press('Control+h'); await query().fill('目标'); await replacement().fill('新的'); await command('all');
    const replaced = source.split('目标').join('新的'); expect(await markdown()).toBe(replaced);
    await page.evaluate(() => { const v = (window as any).searchHarness.surface.source; v.dispatch({ changes: { from: 1, insert: '新' }, userEvent: 'input' }); v.focus(); });
    expect(await markdown()).toBe(replaced.replace('新的', '新新的')); await page.keyboard.press('Control+z'); expect(await markdown()).toBe(replaced); await page.keyboard.press('Control+z'); expect(await markdown()).toBe(source);
  });

  it.each(['rich', 'source'])('rejects a replacement that would split a table without changing the document (%s)', async mode => {
    const source = '| 格 | 备注 |\r\n| --- | --- |\r\n| <span>目标\\|保留</span> | 不动 |\r\n'; await load(source, mode);
    await page.keyboard.press('Control+h'); await query().fill('目标'); await replacement().fill('拆|格'); await command('all'); expect(await markdown()).toBe(source);
    expect(await page.locator('[data-search-error]').textContent()).toContain('表格结构');
    await replacement().fill('合法\\|格'); await command('all'); expect(await markdown()).toBe(source.replace('目标', '合法\\|格'));
  });
});
