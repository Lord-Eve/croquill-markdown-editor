import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { isHtmlComment } from '../src/html-comments';

describe('HTML comment boundaries', () => {
  it('accepts exactly one closed comment plus optional source padding', () => {
    for (const source of ['<!---->', '<!-- 备注 -->', '  <!-- 两格缩进 -->', '<!-- 多行\r\n\r\n原文 --> \t']) expect(isHtmlComment(source)).toBe(true);
    for (const source of ['<!-- 未闭合', '<!-- 备注 -->后文', '<!-- 一 --><!-- 二 -->', '<div>正文</div>']) expect(isHtmlComment(source)).toBe(false);
  });
});

describe('dimmed HTML comments through the production editor', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer();
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
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const h = window.commentHarness = { richRoot, sourceRoot };
      h.surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async src => src });
      h.select = (type, offset = 0, nodeSelection = false) => {
        const view = h.surface.richView(); let found;
        view.state.doc.descendants((node, pos) => { if (node.type.name === type && found === undefined) found = pos; });
        if (found === undefined) throw Error('Node not found: ' + type);
        const Selection = view.state.selection.constructor;
        view.dispatch(view.state.tr.setSelection(nodeSelection ? Selection.near(view.state.doc.resolve(found)) : Selection.create(view.state.doc, found + offset)));
        view.focus();
      };
    ` });
    await page.waitForFunction(() => 'commentHarness' in window);
  });
  afterEach(async () => {
    await page?.evaluate(async () => { await (window as any).commentHarness?.surface.destroy(); });
    await page?.close();
  });

  it.each(['LF', 'CRLF'])('renders inline and standalone comments literally and preserves untouched %s bytes', async newline => {
    let original = '修改这里\n\n前<!-- 行内 <script>不执行</script> -->后\n\n  <!-- 单行注释 -->\n\n<!-- 多行\n  保留缩进与 **Markdown**\n-->\n';
    if (newline === 'CRLF') original = original.replace(/\n/g, '\r\n');
    const result = await page.evaluate(async original => {
      const h = (window as any).commentHarness;
      await h.surface.init(original);
      const comments = [...h.richRoot.querySelectorAll('[data-croquill-comment]')];
      const untouched = h.surface.getMarkdown();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      const switched = h.surface.getMarkdown();
      await h.surface.load(switched);
      return {
        mode: h.surface.mode, reason: h.surface.getSafetyReason(), untouched, switched, reopened: h.surface.getMarkdown(),
        kinds: comments.map(node => node.getAttribute('data-croquill-comment')),
        literals: comments.map(node => node.textContent), rawBlocks: h.richRoot.querySelectorAll('[data-croquill-raw]').length,
        executedHTML: h.richRoot.querySelector('script') !== null,
      };
    }, original);
    expect(result).toMatchObject({ mode: 'rich', reason: null, untouched: original, switched: original, reopened: original, kinds: ['inline', 'block', 'block'], rawBlocks: 0, executedHTML: false });
    expect(result.literals[0]).toBe('<!-- 行内 <script>不执行</script> -->');
    expect(result.literals[2]).toContain('保留缩进与 **Markdown**');
  });

  it.each(['LF', 'CRLF'])('preserves exact standalone and nested comment source when editing elsewhere (%s)', async newline => {
    let original = '修改这里\n\n<!--  空白  \n\n  继续 -->\n\n> <!-- 引用\n> 第二行 -->\n>\n> 引用正文\n\n- 列表正文\n\n  <!-- 列表\n  第二行 -->\n';
    if (newline === 'CRLF') original = original.replace(/\n/g, '\r\n');
    const result = await page.evaluate(async original => {
      const h = (window as any).commentHarness;
      await h.surface.init(original);
      h.surface.format('heading2');
      const edited = h.surface.getMarkdown();
      const literals = [...h.richRoot.querySelectorAll('[data-croquill-comment]')].map(node => node.textContent);
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { edited, literals, switched: h.surface.getMarkdown(), blocks: h.richRoot.querySelectorAll('[data-croquill-raw]').length };
    }, original);
    expect(result.blocks).toBe(0);
    expect(result.literals).toHaveLength(3);
    for (const raw of result.literals) expect(result.edited).toContain(raw);
    expect(result.switched).toBe(result.edited);
    expect(result.edited).toContain('<!--  空白  ' + (newline === 'CRLF' ? '\r\n\r\n' : '\n\n') + '  继续 -->');
  });

  it('deletes one standalone comment atom and restores its source with undo', async () => {
    const original = '正文\n\n<!-- 删除我\r\n保留原换行 -->\n\n结尾\n';
    await page.evaluate(async original => {
      const h = (window as any).commentHarness;
      await h.surface.init(original); h.select('croquill_html_comment', 0, true);
    }, original);
    await page.keyboard.press('Backspace');
    const deleted = await page.evaluate(() => (window as any).commentHarness.surface.getMarkdown());
    expect(deleted).not.toContain('<!--');
    expect(deleted).toContain('正文'); expect(deleted).toContain('结尾');
    await page.evaluate(() => (window as any).commentHarness.surface.format('undo'));
    expect(await page.evaluate(() => (window as any).commentHarness.surface.getMarkdown())).toBe(original);
  });

  it('dims inline and standalone source without executing it as HTML', async () => {
    await page.addStyleTag({ url: baseURL + '/src/style.css' });
    const result = await page.evaluate(async () => {
      const h = (window as any).commentHarness;
      await h.surface.init('普通正文<!-- 行内备注 -->\n\n<!-- 独占备注 -->\n');
      const ordinary = h.richRoot.querySelector('.ProseMirror > p');
      const normal = getComputedStyle(ordinary).color;
      return [...h.richRoot.querySelectorAll('[data-croquill-comment]')].map(node => ({
        color: getComputedStyle(node).color, normal, opacity: Number(getComputedStyle(node).opacity),
      }));
    });
    expect(result).toHaveLength(2);
    for (const item of result) expect(item.color !== item.normal || item.opacity < 1).toBe(true);
  });

  it('pastes a copied standalone comment as one literal comment atom', async () => {
    const raw = '<!-- 第一行\r\n  第二行 -->';
    const result = await page.evaluate(async raw => {
      const h = (window as any).commentHarness;
      await h.surface.init('开头\n\n' + raw + '\n\n粘贴这里\n');
      const comment = h.richRoot.querySelector('[data-croquill-comment="block"]');
      if (!comment) throw Error('Comment missing');
      const html = comment.outerHTML;
      const view = h.surface.richView(); let position;
      view.state.doc.descendants((node, pos) => { if (node.isText && node.text === '粘贴这里') position = pos; });
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, position)));
      view.focus();
      const data = new DataTransfer(); data.setData('text/html', html); data.setData('text/plain', raw);
      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const saved = h.surface.getMarkdown();
      return { count: h.richRoot.querySelectorAll('[data-croquill-comment="block"]').length, saved };
    }, raw);
    expect(result.count).toBe(2);
    expect(result.saved.split(raw)).toHaveLength(3);
  });

  it.each([
    { name: 'root to quote', source: '<!-- 第一行\r\n  第二行 -->\n\n> 粘贴目标\n', container: 'blockquote:not([data-croquill-alert])' },
    { name: 'root to list', source: '<!-- 第一行\r\n  第二行 -->\n\n- 粘贴目标\n', container: 'li' },
    { name: 'root to alert', source: '<!-- 第一行\r\n  第二行 -->\n\n> [!NOTE]\n> 粘贴目标\n', container: '[data-croquill-alert="NOTE"]' },
    { name: 'quote to root', source: '> <!-- 第一行\r\n>   第二行 -->\n\n粘贴目标\n', container: '.ProseMirror' },
  ])('keeps a copied multiline comment in its new container after reopening: $name', async ({ source, container }) => {
    const result = await page.evaluate(async ({ source, container }) => {
      const h = (window as any).commentHarness;
      await h.surface.init(source);
      const comment = h.richRoot.querySelector('[data-croquill-comment="block"]');
      if (!comment) throw Error('Comment missing');
      const data = new DataTransfer(); data.setData('text/html', comment.outerHTML); data.setData('text/plain', comment.textContent || '');
      const view = h.surface.richView(); let position;
      view.state.doc.descendants((node, pos) => { if (node.isText && node.text === '粘贴目标') position = pos; });
      if (position === undefined) throw Error('Paste destination missing');
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(position + '粘贴目标'.length)))); view.focus();
      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const saved = h.surface.getMarkdown();
      await h.surface.load(saved);
      const comments = [...h.richRoot.querySelectorAll('[data-croquill-comment="block"]')];
      const target = h.richRoot.querySelector(container);
      return {
        saved, mode: h.surface.mode, reason: h.surface.getSafetyReason(), comments: comments.length,
        inTarget: target?.querySelectorAll('[data-croquill-comment="block"]').length,
        rootComments: comments.filter(node => node.parentElement?.classList.contains('ProseMirror')).length,
        logical: comments.map(node => JSON.parse(node.getAttribute('data-croquill-comment-logical') || 'null')),
      };
    }, { source, container });
    expect(result, result.saved).toMatchObject({ mode: 'rich', reason: null, comments: 2 });
    expect(result.logical, result.saved).toEqual(['<!-- 第一行\r\n  第二行 -->', '<!-- 第一行\r\n  第二行 -->']);
    if (container === '.ProseMirror') expect(result.rootComments, result.saved).toBe(1);
    else expect(result.inTarget, result.saved).toBe(1);
    expect(result.saved).toContain('粘贴目标');
  });

  it('preserves comment CRLF and original continuation prefixes while editing another paragraph in the same quote', async () => {
    const original = '>  <!-- 原样\r\n>\t续行文字\r\n> -->\r\n>\r\n> 修改引用这里\r\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).commentHarness;
      await h.surface.init(original);
      const comment = h.richRoot.querySelector('[data-croquill-comment="block"]');
      if (!comment) throw Error('Comment missing');
      const raw = comment.textContent;
      const view = h.surface.richView(); let position;
      view.state.doc.descendants((node, pos) => { if (node.isText && node.text === '修改引用这里') position = pos; });
      if (position === undefined) throw Error('Editable quote paragraph missing');
      view.dispatch(view.state.tr.insertText('新增', position));
      const saved = h.surface.getMarkdown();
      await h.surface.load(saved);
      return { raw, saved, comments: h.richRoot.querySelectorAll('[data-croquill-comment="block"]').length, mode: h.surface.mode };
    }, original);
    expect(result.saved).toContain(result.raw);
    expect(result.saved).toContain('新增修改引用这里');
    expect(result).toMatchObject({ comments: 1, mode: 'rich' });
  });

  it.each(['<!-- 未闭合', '前<!-- 备注 -->与[TOC]后\n', '> <!-- 备注 -->\n> 内容[^a]与[[双链]]\n\n[^a]: 脚注\n'])('keeps unsupported or mixed protected syntax opaque: %s', async original => {
    const result = await page.evaluate(async original => {
      const h = (window as any).commentHarness;
      await h.surface.init(original);
      return { rawBlocks: h.richRoot.querySelectorAll('[data-croquill-raw]').length, saved: h.surface.getMarkdown() };
    }, original);
    expect(result.rawBlocks).toBeGreaterThan(0);
    expect(result.saved).toBe(original);
  });
});
