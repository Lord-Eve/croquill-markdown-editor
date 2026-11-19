import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { defaultSearchOptions, findSourceMatches } from '../src/search-core';

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
      import { richMarkdownTransforms } from '/src/rich-markdown.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const h = window.searchHarness = {richRoot, sourceRoot, richMarkdownTransforms, edits: [], errors: []};
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

  const currentRange = () => page.evaluate(() => {
    const current = [...CSS.highlights.entries()].find(([name]) => name.endsWith('-current'));
    const range = current && [...current[1]][0] as Range;
    return range && [range.startContainer.textContent, range.startOffset, range.endContainer.textContent, range.endOffset];
  });

  it.each(['\n', '<br>', '  \n', '\\\n'])('does not paint a false ab across %j', async br => {
    await load('a' + br + 'b ab\n', 'rich');
    await page.keyboard.press('Control+f'); await query().fill('ab');
    expect(await count()).toBe('1 / 1');
    expect(await currentRange()).toEqual(['b ab', 2, 'b ab', 4]);
  });

  it.each(['\n', '\r\n'])('maps a multiline source match to the correct DOM lines (%j)', async eol => {
    const source = 'a<br>b a' + eol + 'b ab' + eol;
    await load(source, 'rich');
    // The find box is single-line. Exercise its production matcher and painter directly.
    const query = 'a' + eol + 'b';
    const matches = findSourceMatches(source, query, defaultSearchOptions);
    expect(matches).toHaveLength(1);
    await page.evaluate(args => (window as any).searchHarness.surface.paintSearch(
      args.source, args.matches, 0, args.query, args.options), { source, matches, query, options: defaultSearchOptions });
    expect(await currentRange()).toEqual(['b a', 2, 'b ab', 1]);
  });

  it('scrolls to the current occurrence within a tall multiline paragraph', async () => {
    const source = ['ab', 'a', 'b', ...Array(120).fill('中间行'), '末行 ab', ''].join('\n');
    await load(source, 'rich'); await page.keyboard.press('Control+f'); await query().fill('ab');
    await command('next'); expect(await count()).toBe('2 / 2');
    expect(await currentRange()).toEqual(['末行 ab', 3, '末行 ab', 5]);
    const visible = await page.evaluate(() => {
      const current = [...CSS.highlights.entries()].find(([name]) => name.endsWith('-current'))!;
      const rect = ([...current[1]][0] as Range).getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    expect(visible).toBe(true);
  });

  it.each([20, 400])('shares the full-document transformation across %i matching multiline paragraphs', async paragraphs => {
    const source = Array.from({ length: paragraphs }, (_, i) => `第${i}段第一行文字\n第二行继续写正文`).join('\n\n');
    await load(source, 'rich'); await page.keyboard.press('Control+f');
    const passes = await page.evaluate(() => {
      const transforms = (window as any).searchHarness.richMarkdownTransforms;
      let calls = 0;
      // Count executions of the real transform pipeline after the editor has loaded.
      transforms.push(() => (tree: unknown) => { calls++; return tree; });
      try {
        const input = document.querySelector<HTMLInputElement>('[aria-label="查找内容"]')!;
        input.value = '文字'; input.dispatchEvent(new Event('input', { bubbles: true }));
        const initial = calls;
        document.querySelector<HTMLButtonElement>('[data-search-command="next"]')!.click();
        return [initial, calls - initial];
      } finally { transforms.pop(); }
    });
    expect(await count()).toBe('2 / ' + paragraphs);
    expect(passes).toEqual([1, 1]);
  });

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

  // Inline Markdown is source text in the rich document, so a match is the same
  // characters in both modes, markers included.
  it('finds and replaces words and markers of inline formatting in rich mode', async () => {
    const source = '甲 **加粗** 乙 `码` 与 \\*星\\* 丙\n'; await load(source, 'rich');
    const painted = () => page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => name.startsWith('croquill-search-') && !name.endsWith('current')).flatMap(([, highlight]) => [...highlight].map(range => range.toString())));
    await page.keyboard.press('Control+h'); await query().fill('加粗'); expect(await count()).toBe('1 / 1'); expect(await painted()).toEqual(['加粗']);
    await query().fill('甲 **加'); expect(await count()).toBe('1 / 1'); expect(await painted()).toEqual(['甲 **加']);
    const markersShown = () => page.evaluate(() => [...document.querySelectorAll('.ProseMirror .md-marker')].filter(node => getComputedStyle(node).display !== 'none').length);
    expect(await markersShown()).toBe(0);
    // Matches on hidden markers bring every marker on screen, without editing anything.
    await query().fill('**'); expect(await count()).toBe('1 / 2'); expect(await markdown()).toBe(source); expect(await markersShown()).toBe(6);
    await query().fill('加粗'); expect(await markersShown()).toBe(0); await query().fill('**');
    await query().fill('加粗'); await replacement().fill('替换'); await command('all'); expect(await markdown()).toBe(source.replace('加粗', '替换'));
    expect(await page.locator('.ProseMirror strong').textContent()).toBe('替换');
    await query().fill('**'); await replacement().fill('__'); await command('all'); expect(await markdown()).toBe('甲 __替换__ 乙 `码` 与 \\*星\\* 丙\n');
    expect(await page.locator('.ProseMirror strong').textContent()).toBe('替换');
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe(source.replace('加粗', '替换')); await page.keyboard.press('Control+z'); expect(await markdown()).toBe(source);
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

  it.each(['rich', 'source'])('replaces inside raw blocks and rendered inline HTML without rebuilding spelling (%s)', async mode => {
    const source = '# 标题\r\n\r\n前<span style="color:red">目标**原文**</span>后\r\n\r\n| 甲 | 乙 |\r\n| --- | :---: |\r\n| <kbd>目标\\|保留</kbd> | 不动<BR />行 |\r\n\r\n<div class="x">\r\n目标\r\n</div>\r\n';
    await load(source, mode); await page.keyboard.press('Control+h'); await query().fill('目标'); expect(await count()).toBe('1 / 3');
    if (mode === 'rich') {
      const painted = await page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => name.startsWith('croquill-search-') && !name.endsWith('current')).flatMap(([, highlight]) => [...highlight].map(range => range.toString())));
      expect(painted).toEqual(['目标', '目标', '目标']);
    }
    await replacement().fill('替换'); await command('all'); expect(await markdown()).toBe(source.split('目标').join('替换'));
    await page.keyboard.press('Control+z'); expect(await markdown()).toBe(source);
    if (mode === 'rich') {
      const styled = await page.evaluate(() => {
        const root = (window as any).searchHarness.richRoot as HTMLElement;
        return {
          span: [...root.querySelectorAll('span.md-html')].map(node => node.textContent).join(''),
          key: [...root.querySelectorAll('kbd.md-html')].map(node => node.textContent).join(''),
          fragments: root.querySelectorAll('[data-croquill-inline-raw]').length,
        };
      });
      expect(styled).toEqual({ span: '目标**原文**', key: '目标\\|保留', fragments: 0 });
    }
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
    // The caret is at the start of the paragraph, which is before the ** it now begins with.
    expect((await markdown()).replace(/\r\n/g, '\n')).toBe(spelling.replace('**粗体**', '新**粗体**').replace(/\r\n/g, '\n'));
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
