import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';

const rows = ['| A | B |', '| :------ | -------: |', '| 一<br/>二<BR>三 |   旧字  |', '| 剩下 | 不动 |'];
const contexts = [
  { name: 'blockquote', first: '> ', rest: '> ', intro: '' },
  { name: 'list', first: '  ', rest: '  ', intro: '- 父项\n\n' },
  { name: 'nested blockquotes', first: '>> ', rest: '>> ', intro: '' },
  { name: 'quote list quote', first: '>   > ', rest: '>   > ', intro: '> - 父项\n>\n' },
  { name: 'nested lists', first: '    ', rest: '    ', intro: '- 外层\n  - 内层\n\n' },
  { name: 'ordered list', first: '    ', rest: '    ', intro: '10. 父项\n\n' },
];
const samples = contexts.flatMap(context => ['LF', 'CRLF'].map(newline => ({
  name: context.name, newline,
  // Only the table uses the selected line ending. The editable introductory
  // paragraphs are separate from the table region that must retain its bytes.
  source: context.intro + (rows.map((row, index) => (index ? context.rest : context.first) + row).join('\n') + '\n').replace(/\n/g, newline === 'CRLF' ? '\r\n' : '\n'),
})));

describe('nested BR tables through the production editor', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer();
    await server.listen(); const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage(); await page.goto(baseURL + '/tests/harness.html');
    await page.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      import { DocumentSession } from '/src/session.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div'); document.body.append(richRoot, sourceRoot);
      const h = window.nestedHarness = { richRoot, saved: '' };
      h.session = new DocumentSession({ write: async (_path, text) => { h.saved = text; return { revision: 'test' }; } }); h.session.path = 'D:/notes/nested.md';
      h.surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: text => h.session.edit(text), resolveImage: async src => src });
      h.save = async () => { h.session.edit(h.surface.getMarkdown()); await h.session.save(); return h.saved; };
    ` });
    await page.waitForFunction(() => 'nestedHarness' in window);
  }, 30000);
  afterEach(async () => { await page?.evaluate(() => (window as any).nestedHarness?.surface.destroy()); await page?.close(); });

  it.each(samples)('only edits the chosen cell in $name ($newline), including across modes', async ({ source }) => {
    const result = await page.evaluate(async original => {
      const h = (window as any).nestedHarness; await h.surface.init(original);
      if (h.surface.mode !== 'rich') throw Error(h.surface.getSafetyReason() || 'Rich editor unavailable');
      const untouched = await h.save(), view = h.surface.richView(); let position: number | undefined;
      view.state.doc.descendants((node: any, pos: number) => { if (node.isText && node.text === '旧字') position = pos; });
      if (position === undefined) throw Error('Cell text unavailable: ' + h.surface.getSafetyReason());
      view.dispatch(view.state.tr.insertText('新字', position, position + 2));
      const saved = await h.save(); await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { untouched, saved, switched: await h.save(), mode: h.surface.mode, breaks: h.richRoot.querySelectorAll('td br').length };
    }, source);
    expect(result.untouched).toBe(source);
    expect(result.saved).toBe(source.replace('旧字', '新字'));
    expect(result.switched).toBe(result.saved);
    expect(result).toMatchObject({ mode: 'rich', breaks: 2 });
  }, 30000);

  it.each(samples.filter(sample => sample.newline === 'CRLF'))('preserves the $name table after editing an unrelated heading', async ({ source }) => {
    const result = await page.evaluate(async table => {
      const h = (window as any).nestedHarness; await h.surface.init('# 前文\n\n' + table);
      if (h.surface.mode !== 'rich') throw Error(h.surface.getSafetyReason() || 'Rich editor unavailable');
      h.surface.format('heading2'); const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { saved, switched: await h.save(), mode: h.surface.mode };
    }, source);
    expect(result.saved).toBe('## 前文\n\n' + source);
    expect(result.switched).toBe(result.saved);
    expect(result.mode).toBe('rich');
  }, 30000);
});
