import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { hasEquivalentMarkdownStructure, preservedMarkdownBlocks } from '../src/fidelity';
import { launchTestBrowser } from './browser';

const snippets = [
  '<span style="color:red">**粗**</span>', '<kbd>Ctrl</kbd>', '<sup>2</sup>',
  '<img src="local.png" alt="图片">', '<!-- 备注 -->', '<br class="x">', '<u>下划线</u>', '<wbr>',
];
const contexts = [
  { name: 'paragraph', wrap: (text: string) => '前' + text + '后\n', selector: '.ProseMirror > p' },
  { name: 'heading', wrap: (text: string) => '# 前' + text + '后\n', selector: '.ProseMirror > h1' },
  { name: 'table cell', wrap: (text: string) => '| 标题 | 备注 |\n| --- | --- |\n| 前' + text + '后 | 不动 |\n', selector: 'td' },
  { name: 'table header', wrap: (text: string) => '| 前' + text + '后 | 备注 |\n| --- | --- |\n| 内容 | 不动 |\n', selector: 'th' },
  { name: 'list item', wrap: (text: string) => '- 前' + text + '后\n', selector: 'li p' },
  { name: 'quote paragraph', wrap: (text: string) => '> 前' + text + '后\n', selector: 'blockquote p' },
];
const protectedSamples = [
  { name: 'block div', original: '<div>\n正文\n</div>\n' },
  { name: 'block table', original: '<table>\n<tr><td>内容</td></tr>\n</table>\n' },
  { name: 'block details', original: '<details>\n<summary>标题</summary>\n内容\n</details>\n' },
  { name: 'unclosed inline tag', original: '前<span>未闭合\n' },
  { name: 'tag crossing paragraphs', original: '前<span>第一段\n\n第二段</span>后\n' },
  { name: 'tag crossing cells', original: '| 一 | 二 |\n| --- | --- |\n| 前<span>第一格 | 第二格</span>后 |\n' },
  { name: 'inline HTML plus highlighting', original: '前<kbd>Ctrl</kbd>与==高亮==后\n' },
  { name: 'inline HTML plus TOC', original: '前<kbd>Ctrl</kbd>与[TOC]后\n' },
  { name: 'inline HTML plus footnote', original: '前<kbd>Ctrl</kbd>与[^a]后\n\n[^a]: 脚注\n' },
];

describe('inline HTML protection boundaries', () => {
  it.each(contexts)('allows each supported snippet in a $name', ({ wrap }) => {
    for (const snippet of snippets) expect(preservedMarkdownBlocks(wrap(snippet)), snippet).toEqual([]);
  });

  it.each(protectedSamples)('retains block protection for $name', ({ original }) => {
    expect(preservedMarkdownBlocks(original).length).toBeGreaterThan(0);
  });
});

// These tests exercise production DOM, clipboard and save behavior. Composition
// events are simulated; native IME and desktop acceptance remain separate.
describe('inline HTML source fragments through the production editor', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.tools/**', '**/src-tauri/**'] } } });
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
      const h = window.inlineHarness = { richRoot, sourceRoot, saved: '', warnings: [] };
      h.session = new DocumentSession({ write: async (_path, text) => { h.saved = text; return { revision: 'test' }; } });
      h.session.path = 'D:/notes/inline.md';
      h.surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: text => h.session.edit(text), onWarning: text => h.warnings.push(text), resolveImage: async src => src });
      h.save = async () => { h.session.edit(h.surface.getMarkdown()); await h.session.save(); return h.saved; };
      h.selectText = (text, offset = 0) => {
        const view = h.surface.richView(); let position;
        view.state.doc.descendants((node, pos) => { if (node.isText && node.text === text && position === undefined) position = pos + offset; });
        if (position === undefined) throw Error('Text not found: ' + text);
        view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, position))); view.focus();
      };
      h.selectRaw = (boundary) => {
        const view = h.surface.richView(); let position, size;
        view.state.doc.descendants((node, pos) => {
          if (node.type.name === 'croquill_inline_raw' && position === undefined) { position = pos; size = node.nodeSize; }
        });
        if (position === undefined) throw Error('Inline fragment not found');
        const Selection = view.state.selection.constructor;
        const selection = boundary === 'node' ? Selection.create(view.state.doc, position, position + size) : Selection.create(view.state.doc, position + (boundary === 'after' ? size : 0));
        view.dispatch(view.state.tr.setSelection(selection)); view.focus();
      };
    ` });
    await page.waitForFunction(() => 'inlineHarness' in window);
  });
  afterEach(async () => {
    await page?.evaluate(async () => { await (window as any).inlineHarness?.surface.destroy(); });
    await page?.close();
  });

  it.each(contexts)('shows one literal, noneditable fragment per tag in a $name', async ({ wrap, selector }) => {
    const original = wrap(snippets.join('，'));
    const result = await page.evaluate(async ({ original, selector }) => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original);
      const fragments = Array.from(h.richRoot.querySelectorAll(selector + ' span[data-croquill-inline-raw]')) as HTMLElement[];
      return {
        mode: h.surface.mode, reason: h.surface.getSafetyReason(), blocks: h.richRoot.querySelectorAll('[data-croquill-raw]').length,
        literals: fragments.map(node => node.textContent), editable: fragments.map(node => node.contentEditable),
        liveHTML: fragments.some(node => node.querySelector('img,span,kbd,sup,u,br,wbr,strong') !== null), saved: await h.save(),
      };
    }, { original, selector });
    expect(result).toMatchObject({ mode: 'rich', reason: null, blocks: 0, literals: snippets, editable: snippets.map(() => 'false'), liveHTML: false });
    expect(result.saved).toBe(original);
  }, 30000);

  it('styles source fragments as gray monospace with a distinct appearance from inline code', async () => {
    await page.addStyleTag({ url: baseURL + '/src/style.css' });
    const result = await page.evaluate(async () => {
      const h = (window as any).inlineHarness;
      await h.surface.init('前<kbd>Ctrl</kbd>与`code`后\n');
      const raw = h.richRoot.querySelector('[data-croquill-inline-raw]'), code = h.richRoot.querySelector('code');
      if (!raw || !code) throw Error('Fragment or inline code missing');
      const quote = document.createElement('span'); quote.style.color = 'var(--quote)'; document.body.append(quote);
      const rawStyle = getComputedStyle(raw), codeStyle = getComputedStyle(code);
      return {
        fontFamily: rawStyle.fontFamily, color: rawStyle.color, quoteColor: getComputedStyle(quote).color,
        rawBorder: rawStyle.borderBottomStyle, codeBorder: codeStyle.borderBottomStyle,
        rawBackground: rawStyle.backgroundColor, codeBackground: codeStyle.backgroundColor,
      };
    });
    expect(result.fontFamily).toContain('monospace');
    expect(result.color).toBe(result.quoteColor);
    expect(result.rawBorder).toBe('dashed');
    expect(result.codeBorder).toBe('solid');
    expect(result.rawBackground).not.toBe(result.codeBackground);
  }, 30000);

  it.each(['LF', 'CRLF'])('saves original %s bytes across repeated mode changes', async newline => {
    const content = contexts.map(({ wrap }) => wrap(snippets.join('，'))).join('\n');
    const original = newline === 'CRLF' ? content.replace(/\n/g, '\r\n') : content;
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original);
      const saved = await h.save();
      for (let index = 0; index < 3; index++) { await h.surface.setMode('source'); await h.surface.setMode('rich'); }
      const switched = await h.save();
      await h.surface.load(saved);
      return { saved, switched, reopened: await h.save(), mode: h.surface.mode, fragments: h.richRoot.querySelectorAll('[data-croquill-inline-raw]').length };
    }, original);
    expect(Buffer.from(result.saved).equals(Buffer.from(original))).toBe(true);
    expect(Buffer.from(result.switched).equals(Buffer.from(original))).toBe(true);
    expect(Buffer.from(result.reopened).equals(Buffer.from(original))).toBe(true);
    expect(result.mode).toBe('rich');
    expect(result.fragments).toBe(contexts.length * snippets.length);
  }, 30000);

  it('preserves nested tags and Markdown inside their exact original source range while editing nearby text', async () => {
    const raw = '<SpAn data-note="a > b"  class="red"><span>内部</span>**粗**与`代码`</SpAn>';
    const original = '前' + raw + '后\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectText('后');
      const view = h.surface.richView(); view.dispatch(view.state.tr.insertText('新', view.state.selection.from));
      return { saved: await h.save(), literals: Array.from(h.richRoot.querySelectorAll('[data-croquill-inline-raw]')).map((node: any) => node.textContent) };
    }, original);
    expect(result.literals).toEqual([raw]);
    expect(result.saved).toBe(original.replace('后', '新后'));
  }, 30000);

  it.each(['paragraph', 'quote', 'list'].flatMap(context => ['LF', 'CRLF'].map(newline => ({ context, newline }))))('preserves a multiline source range in a $context with $newline', async ({ context, newline }) => {
    const lines = ['前<span data-x="原样">', '**粗**与文字', '</span>后'];
    const source = lines.map((line, index) => context === 'quote' ? '> ' + line : context === 'list' ? (index === 0 ? '- ' : '  ') + line : line).join('\n') + '\n';
    const original = newline === 'CRLF' ? source.replace(/\n/g, '\r\n') : source;
    const raw = original.slice(original.indexOf('<span'), original.indexOf('</span>') + '</span>'.length);
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original);
      const untouched = await h.save(); h.selectText('后');
      const view = h.surface.richView(); view.dispatch(view.state.tr.insertText('新', view.state.selection.from));
      const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      const switched = await h.save(); await h.surface.load(saved);
      return { untouched, saved, switched, reopened: await h.save(), mode: h.surface.mode, literal: h.richRoot.querySelector('[data-croquill-inline-raw]')?.textContent };
    }, original);
    expect(result.untouched).toBe(original);
    expect(result.saved).toContain(raw);
    expect(hasEquivalentMarkdownStructure(original.replace('后', '新后'), result.saved)).toBe(true);
    expect(result.switched).toBe(result.saved);
    expect(result.reopened).toBe(result.saved);
    expect(result.literal).toBe(raw);
    expect(result.mode).toBe('rich');
  }, 30000);

  it.each(['LF', 'CRLF'])('preserves all other table bytes and escaped pipes after editing another cell (%s)', async newline => {
    const raw = '<span data-x="甲\\|乙">**字\\|字**</span>';
    const content = '| 内容 |  备注  |\n| :------ | ------: |\n| 前' + raw + '后 |   待改  |\n| <kbd>Tab</kbd> | 不动 |\n';
    const original = newline === 'CRLF' ? content.replace(/\n/g, '\r\n') : content;
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectText('待改');
      const view = h.surface.richView(), position = view.state.selection.from;
      view.dispatch(view.state.tr.insertText('已改', position, position + 2));
      const saved = await h.save(); await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { saved, switched: await h.save(), mode: h.surface.mode, literal: h.richRoot.querySelector('[data-croquill-inline-raw]')?.textContent };
    }, original);
    expect(result.saved).toBe(original.replace('待改', '已改'));
    expect(result.switched).toBe(result.saved);
    expect(result.literal).toBe(raw);
    expect(result.mode).toBe('rich');
  }, 30000);

  it.each(['<!-- 甲\n乙 -->', '<!-- 甲\r\n乙 -->', '<kbd>A|B</kbd>', '<kbd>A\\\\|B</kbd>'])('rejects an unrepresentable fragment pasted or moved into a cell: %s', async raw => {
    const original = '前' + raw + '后\n\n| 内容 | 备注 |\n| --- | --- |\n| 目标 | 不动 |\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectRaw('node');
      const view = h.surface.richView(), data = new DataTransfer();
      view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      h.selectText('目标', 2);
      const position = view.state.selection.from;
      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const pasted = await h.save(), pasteCaret = view.state.selection.from;
      let atom: any, from = -1;
      view.state.doc.descendants((node: any, pos: number) => { if (node.type.name === 'croquill_inline_raw') { atom = node; from = pos; } });
      const tr = view.state.tr.delete(from, from + atom.nodeSize);
      view.dispatch(tr.insert(tr.mapping.map(position), atom));
      return { pasted, moved: await h.save(), position, pasteCaret, warnings: h.warnings };
    }, original);
    expect(result.pasted).toBe(original);
    expect(result.moved).toBe(original);
    expect(result.pasteCaret).toBe(result.position);
    expect(result.warnings).toHaveLength(2);
  }, 30000);

  it('allows a copied fragment with an escaped pipe inside a table cell', async () => {
    const raw = '<kbd>A\\|B</kbd>';
    const original = '前' + raw + '后\n\n| 内容 | 备注 |\n| --- | --- |\n| 目标 | 不动 |\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectRaw('node');
      const view = h.surface.richView(), data = new DataTransfer();
      view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      h.selectText('目标', 2);
      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const saved = await h.save(); await h.surface.load(saved);
      return { saved, mode: h.surface.mode, fragments: h.richRoot.querySelectorAll('[data-croquill-inline-raw]').length, warnings: h.warnings };
    }, original);
    expect(result.saved).toBe(original.replace('目标', '目标' + raw));
    expect(result).toMatchObject({ mode: 'rich', fragments: 2, warnings: [] });
  }, 30000);

  it.each([
    { key: 'Backspace', boundary: 'after', table: false }, { key: 'Delete', boundary: 'before', table: false },
    { key: 'Backspace', boundary: 'after', table: true }, { key: 'Delete', boundary: 'before', table: true },
  ])('deletes the whole fragment with $key (table=$table)', async ({ key, boundary, table }) => {
    const raw = '<span data-x="原样">**粗**</span>';
    const original = table ? '| 内容 | 备注 |\n| --- | --- |\n| 前' + raw + '后 | 不动 |\n' : '前' + raw + '后\n';
    await page.evaluate(async ({ original, boundary }) => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectRaw(boundary);
    }, { original, boundary });
    await page.keyboard.press(key);
    expect(await page.evaluate(() => (window as any).inlineHarness.save())).toBe(original.replace(raw, ''));
    expect(await page.locator('[data-croquill-inline-raw]').count()).toBe(0);
    const undo = await page.evaluate(async () => {
      const h = (window as any).inlineHarness;
      h.surface.format('undo');
      return { saved: await h.save(), literal: h.richRoot.querySelector('[data-croquill-inline-raw]')?.textContent };
    });
    expect(undo).toEqual({ saved: original, literal: raw });
  }, 30000);

  it('retains escaped pipes when the cell containing the fragment itself is edited', async () => {
    const raw = '<kbd data-x="甲\\|乙">Ctrl\\|S</kbd>';
    const original = '| 内容 | 备注 |\n| --- | --- |\n| 前' + raw + '后 | 不动 |\n';
    const saved = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectText('后');
      const view = h.surface.richView(); view.dispatch(view.state.tr.insertText('新', view.state.selection.from));
      return h.save();
    }, original);
    expect(saved).toBe(original.replace('后', '新后'));
  }, 30000);

  it('copies and pastes an internal fragment as one literal atom', async () => {
    const raw = '<kbd data-x="原样">Ctrl</kbd>';
    const original = '前' + raw + '后\n\n粘贴处\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectRaw('node');
      const view = h.surface.richView(), data = new DataTransfer();
      view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      h.selectText('粘贴处', 3);
      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return { saved: await h.save(), literals: Array.from(h.richRoot.querySelectorAll('[data-croquill-inline-raw]')).map((node: any) => node.textContent), clipboardHTML: data.getData('text/html') };
    }, original);
    expect(result.clipboardHTML).toContain('data-croquill-inline-raw');
    expect(result.literals).toEqual([raw, raw]);
    expect(result.saved).toBe(original.replace('粘贴处', '粘贴处' + raw));
  }, 30000);

  it.each([
    { name: 'multiline CRLF comment', raw: '<!-- 第一行\r\n  第二行 -->' },
    { name: 'escaped pipes', raw: '<kbd data-x="甲\\|乙">Ctrl\\|S</kbd>' },
  ])('keeps a copied $name fragment literal after reopening the saved document', async ({ raw }) => {
    const original = '前' + raw + '后\n\n粘贴处\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectRaw('node');
      const view = h.surface.richView(), data = new DataTransfer();
      view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      h.selectText('粘贴处', 3);
      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const saved = await h.save();
      await h.surface.load(saved);
      return { saved, reopened: await h.save(), mode: h.surface.mode, literals: Array.from(h.richRoot.querySelectorAll('[data-croquill-inline-raw]')).map((node: any) => node.textContent) };
    }, original);
    expect(result.saved).toBe(original.replace('粘贴处', '粘贴处' + raw));
    expect(result.reopened).toBe(result.saved);
    expect(result.mode).toBe('rich');
    expect(result.literals).toEqual([raw, raw]);
  }, 30000);

  it.each([
    { name: 'blockquote', intro: '', prefix: '> ' },
    { name: 'list', intro: '- 父项\n\n', prefix: '  ' },
    { name: 'quote list quote', intro: '> - 父项\n>\n', prefix: '>   > ' },
  ].flatMap(context => ['LF', 'CRLF'].map(newline => ({ ...context, newline }))))('preserves nested $name table bytes with $newline while editing both cells', async ({ intro, prefix, newline }) => {
    const raw = '<span data-x="甲\\|乙">**字\\|字**</span>';
    const rows = ['| 内容 | 备注 |', '| :------- | -------: |', '| 前' + raw + '后 |  待改  |', '| <kbd>Tab</kbd> | 不动 |'];
    const original = intro + rows.map(row => prefix + row).join(newline === 'CRLF' ? '\r\n' : '\n') + (newline === 'CRLF' ? '\r\n' : '\n');
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original);
      if (h.surface.mode !== 'rich') throw Error(h.surface.getSafetyReason() || 'Rich editor unavailable');
      h.selectText('待改');
      let view = h.surface.richView(), position = view.state.selection.from;
      view.dispatch(view.state.tr.insertText('已改', position, position + 2));
      const firstSave = await h.save();
      h.selectText('后'); view = h.surface.richView();
      view.dispatch(view.state.tr.insertText('新', view.state.selection.from));
      const saved = await h.save();
      await h.surface.load(saved);
      return { firstSave, saved, reopened: await h.save(), mode: h.surface.mode, literals: Array.from(h.richRoot.querySelectorAll('[data-croquill-inline-raw]')).map((node: any) => node.textContent) };
    }, original);
    expect(result.firstSave).toBe(original.replace('待改', '已改'));
    expect(result.saved).toBe(original.replace('待改', '已改').replace('后', '新后'));
    expect(result.reopened).toBe(result.saved);
    expect(result.mode).toBe('rich');
    expect(result.literals).toEqual([raw, '<kbd>Tab</kbd>']);
  }, 30000);

  it.each([
    { boundary: 'before', composing: 'event flag' }, { boundary: 'after', composing: 'event flag' },
    { boundary: 'before', composing: 'active composition' }, { boundary: 'after', composing: 'active composition' },
  ])('does not delete a fragment or move the caret during IME input $boundary it ($composing)', async ({ boundary, composing }) => {
    const raw = '<kbd>Ctrl</kbd>', original = '前' + raw + '后\n';
    const result = await page.evaluate(async ({ original, boundary, composing }) => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original); h.selectRaw(boundary);
      const view = h.surface.richView(), position = view.state.selection.from;
      if (composing === 'active composition') view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '中', bubbles: true }));
      const event = new KeyboardEvent('keydown', { key: boundary === 'after' ? 'Backspace' : 'Delete', keyCode: boundary === 'after' ? 8 : 46, isComposing: composing === 'event flag', bubbles: true, cancelable: true });
      view.dom.dispatchEvent(event);
      return { position, after: view.state.selection.from, unchanged: await h.save(), prevented: event.defaultPrevented };
    }, { original, boundary, composing });
    expect(result.after).toBe(result.position);
    expect(result.unchanged).toBe(original);
    expect(result.prevented).toBe(false);
    await page.keyboard.insertText('中文');
    const edited = await page.evaluate(async composing => {
      const h = (window as any).inlineHarness, view = h.surface.richView();
      if (composing === 'active composition') view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
      return { saved: await h.save(), caret: view.state.selection.from };
    }, composing);
    expect(edited.saved).toBe(boundary === 'before' ? original.replace('前', '前中文') : original.replace('后', '中文后'));
    expect(edited.caret).toBe(result.position + 2);
  }, 30000);

  it.each(protectedSamples)('keeps $name opaque and unchanged through modes', async ({ original }) => {
    const result = await page.evaluate(async original => {
      const h = (window as any).inlineHarness;
      await h.surface.init(original);
      const blocks = h.richRoot.querySelectorAll('[data-croquill-raw]').length;
      const fragments = h.richRoot.querySelectorAll('[data-croquill-inline-raw]').length;
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { blocks, fragments, saved: await h.save(), mode: h.surface.mode };
    }, original);
    expect(result.blocks).toBeGreaterThan(0);
    expect(result.fragments).toBe(0);
    expect(result.saved).toBe(original);
    expect(result.mode).toBe('rich');
  }, 30000);
});
