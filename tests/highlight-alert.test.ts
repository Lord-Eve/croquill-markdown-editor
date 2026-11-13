import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { preservedMarkdownBlocks } from '../src/fidelity';
import { readFileSync } from 'node:fs';

const alertTypes = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
const literalSamples = [
  { name: 'formatted highlight', syntax: '前==**粗体**与*斜体*、`code`==后' },
  { name: 'multi-paragraph alert', syntax: '> [!NOTE]\n> 保留 __原始写法__ 与 ==高亮==。\n>\n> 第二段落。\n>\n> - 列表甲\n> - 列表乙' },
  { name: 'nested alert', syntax: '- 父项\n\n  > [!TIP]\n  > 保留 __嵌套内容__。' },
  { name: 'block comment', syntax: '<!-- 注释\n  ==注释原文==与[TOC]不是排版\n-->' },
  { name: 'inline comment', syntax: '前<!-- 原样 \\| 注释 -->后' },
];

describe('rendered Markdown extension protection boundaries', () => {
  it.each(literalSamples)('releases $name from whole-block protection', ({ syntax }) => {
    expect(preservedMarkdownBlocks(syntax)).toEqual([]);
  });

  it.each([
    '前==高亮==与[TOC]后',
    '前==高亮==与[[双链]]后',
    '前==高亮==与[^a]和[[双链]]后\n\n[^a]: 定义',
    '> [!NOTE]\n> 提示与[TOC]',
    '> [!WARNING]\n> 提示与[[双链]]',
    '> [!TIP]\n> 提示[^a]与[[双链]]\n\n[^a]: 定义',
    '前<!-- 注释 -->与[TOC]后',
    '<div>\n==高亮==\n</div>',
    '> [!UNKNOWN]\n> 未支持类型',
    '<!-- 未闭合注释',
  ])('retains protection when unsupported syntax remains: %s', syntax => {
    expect(preservedMarkdownBlocks(syntax).length).toBeGreaterThan(0);
  });
});

// DOM/keyboard tests in Chromium, separate from Windows/Typora desktop acceptance.
describe('highlight, alerts and comments in the production editor', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer();
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
    // Pay the cold start here, inside the 60s setup budget: the first editor in a fresh
    // Vite server compiles and loads every editor module, which took about 15s on the
    // Windows CI runner (run 42902057670) and used to land on the first test's 5s limit.
    const warm = await browser.newPage();
    await warm.goto(baseURL + '/tests/harness.html');
    await warm.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: () => {}, onDirty: () => {}, resolveImage: async src => src });
      surface.init('==预热==\\n\\n> [!NOTE]\\n> 预热\\n\\n<!-- 预热 -->\\n').then(() => surface.destroy()).then(() => { window.warmed = 'ok'; }, error => { window.warmed = String(error); });
    ` });
    await warm.waitForFunction(() => 'warmed' in window, undefined, { timeout: 50000 });
    expect(await warm.evaluate(() => (window as any).warmed)).toBe('ok');
    await warm.close();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(baseURL + '/tests/harness.html');
    await page.addStyleTag({ url: baseURL + '/src/style.css' });
    await page.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      import { DocumentSession } from '/src/session.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const h = window.extensionHarness = { richRoot, sourceRoot, saved: '', changes: [], dirty: 0 };
      h.session = new DocumentSession({ write: async (_path, text) => { h.saved = text; return { revision: 'test' }; } });
      h.session.path = 'D:/notes/extensions.md';
      h.surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: text => { h.changes.push(text); h.session.edit(text); }, onDirty: () => h.dirty++, resolveImage: async src => src });
      h.save = async () => { h.session.edit(h.surface.getMarkdown()); await h.session.save(); return h.saved; };
      h.selectText = (text, offset = 0, length = 0) => {
        const view = h.surface.richView(); let position;
        view.state.doc.descendants((node, pos) => { if (node.isText && node.text.includes(text) && position === undefined) position = pos + node.text.indexOf(text) + offset; });
        if (position === undefined) throw Error('Text not found: ' + text);
        const textSelection = view.state.selection.constructor.near(view.state.doc.resolve(position));
        view.dispatch(view.state.tr.setSelection(textSelection.constructor.create(view.state.doc, position, position + length))); view.focus();
      };
      h.insert = text => { const view = h.surface.richView(); view.dispatch(view.state.tr.insertText(text)); };
    ` });
    await page.waitForFunction(() => 'extensionHarness' in window);
  });
  afterEach(async () => {
    await page?.evaluate(async () => { await (window as any).extensionHarness?.surface.destroy(); });
    await page?.close();
  });

  it('opens the public manual acceptance sample in rich mode and saves its exact bytes', async () => {
    const original = readFileSync(new URL('../examples/highlight-alert.md', import.meta.url), 'utf8');
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      return { mode: h.surface.mode, reason: h.surface.getSafetyReason(), saved: await h.save(),
        highlights: h.richRoot.querySelectorAll('mark').length,
        alerts: h.richRoot.querySelectorAll('[data-croquill-alert]').length,
        comments: h.richRoot.querySelectorAll('[data-croquill-comment]').length };
    }, original);
    expect(result).toMatchObject({ mode: 'rich', reason: null, saved: original });
    expect(result.highlights).toBeGreaterThan(0);
    expect(result.alerts).toBeGreaterThanOrEqual(5);
    expect(result.comments).toBeGreaterThan(0);
  });

  it.each([
    { name: 'paragraph', original: '前==重点==后\n', selector: 'p mark' },
    { name: 'heading', original: '# 前==重点==后\n', selector: 'h1 mark' },
    { name: 'list', original: '- 前==重点==后\n', selector: 'li mark' },
    { name: 'quote', original: '> 前==重点==后\n', selector: 'blockquote mark' },
    { name: 'table', original: '| 内容 |\n| --- |\n| 前==重点==后 |\n', selector: 'td mark' },
  ])('renders editable yellow highlighting in a $name', async ({ original, selector }) => {
    const result = await page.evaluate(async ({ original, selector }) => {
      const h = (window as any).extensionHarness;
      await h.surface.init(original);
      const mark = h.richRoot.querySelector(selector) as HTMLElement | null;
      return { mode: h.surface.mode, reason: h.surface.getSafetyReason(), raw: h.richRoot.querySelectorAll('[data-croquill-raw]').length,
        text: mark?.textContent, editable: mark?.isContentEditable, background: mark && getComputedStyle(mark).backgroundColor, saved: await h.save() };
    }, { original, selector });
    expect(result).toMatchObject({ mode: 'rich', reason: null, raw: 0, text: '重点', editable: true });
    expect(result.background).toMatch(/^rgb(?:a)?\(/);
    expect(result.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(result.saved).toBe(original);
  });

  it('keeps bold, emphasis and inline code inside a single highlighted range', async () => {
    const result = await page.evaluate(async () => {
      const h = (window as any).extensionHarness;
      await h.surface.init('前==**粗体**与*斜体*、`code`==后\n');
      return { raw: h.richRoot.querySelectorAll('[data-croquill-raw]').length,
        strong: h.richRoot.querySelector('mark strong,strong mark')?.textContent, emphasis: h.richRoot.querySelector('mark em,em mark')?.textContent,
        code: h.richRoot.querySelector('mark code,code mark')?.textContent, saved: await h.save() };
    });
    expect(result).toMatchObject({ raw: 0, strong: '粗体', emphasis: '斜体', code: 'code', saved: '前==**粗体**与*斜体*、`code`==后\n' });
  });

  it('renders a highlight after entering its delimiters one key at a time', async () => {
    await page.evaluate(async () => {
      const h = (window as any).extensionHarness; await h.surface.init('正文\n'); h.selectText('正文', 2);
    });
    await page.keyboard.type('==');
    await page.keyboard.insertText('重点');
    await page.keyboard.press('=');
    expect(await page.locator('mark').count()).toBe(0);
    await page.keyboard.press('=');
    const result = await page.evaluate(async () => {
      const h = (window as any).extensionHarness, mark = h.richRoot.querySelector('mark');
      return { text: mark?.textContent, background: mark && getComputedStyle(mark).backgroundColor, saved: await h.save() };
    });
    expect(result.text).toBe('重点');
    expect(result.background).toMatch(/^rgb(?:a)?\(/);
    expect(result.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(result.saved).toBe('正文==重点==\n');
  });

  it('distinguishes real highlight delimiters from entities and escaped equals in the same text', async () => {
    const original = '待改正文\n\n前&#61;&#61;实体&#x3D;&#x3D;与\\==转义\\==，真正==重点==后\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      const initial = Array.from(h.richRoot.querySelectorAll('mark')).map((node: any) => node.textContent);
      h.selectText('待改正文'); h.insert('新');
      const saved = await h.save(); await h.surface.load(saved);
      return { initial, saved, reopened: await h.save(), mode: h.surface.mode,
        final: Array.from(h.richRoot.querySelectorAll('mark')).map((node: any) => node.textContent),
        // innerText is what is displayed: hidden markers and raw entities are not part of it.
        text: h.richRoot.querySelectorAll('p')[1]?.innerText };
    }, original);
    expect(result).toEqual({ initial: ['重点'], final: ['重点'], saved: original.replace('待改正文', '新待改正文'),
      reopened: original.replace('待改正文', '新待改正文'), mode: 'rich', text: '前==实体==与==转义==，真正重点后' });
  });

  it('does not highlight escaped delimiters, inline code, fenced code or an unmatched opener', async () => {
    const original = '\\==字面\\== 与 `==代码==` 与 ==未闭合\n\n```text\n==围栏代码==\n```\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      return { count: h.richRoot.querySelectorAll('mark').length, mode: h.surface.mode, saved: await h.save() };
    }, original);
    expect(result).toEqual({ count: 0, mode: 'rich', saved: original });
  });

  it('renders all five alerts with distinct borders, icons and English titles', async () => {
    const original = alertTypes.map(type => `> [!${type}]\n> ${type} 正文。`).join('\n\n') + '\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      return { mode: h.surface.mode, raw: h.richRoot.querySelectorAll('[data-croquill-raw]').length,
        alerts: Array.from(h.richRoot.querySelectorAll('blockquote[data-croquill-alert]')).map((node: any) => ({
          type: node.getAttribute('data-croquill-alert'), text: node.textContent, border: getComputedStyle(node).borderLeftColor,
          width: getComputedStyle(node).borderLeftWidth, icon: !!node.querySelector('svg'), editable: !!node.querySelector('p')?.isContentEditable,
        })), saved: await h.save() };
    }, original);
    expect(result).toMatchObject({ mode: 'rich', raw: 0, saved: original });
    expect(result.alerts.map(alert => alert.type)).toEqual(alertTypes);
    for (const [index, title] of ['Note', 'Tip', 'Important', 'Warning', 'Caution'].entries()) {
      expect(result.alerts[index].text).toContain(title);
      expect(result.alerts[index].text).toContain(alertTypes[index] + ' 正文。');
      expect(result.alerts[index]).toMatchObject({ icon: true, editable: true });
      expect(parseFloat(result.alerts[index].width)).toBeGreaterThan(0);
    }
    expect(new Set(result.alerts.map(alert => alert.border)).size).toBe(5);
  });

  it.each(['LF', 'CRLF'])('preserves untouched %s bytes over save, mode changes and reopen', async newline => {
    const originalLF = '\uFEFF普通 __原写法__。\n\n' + literalSamples.map(sample => sample.syntax).join('\n\n');
    const original = newline === 'CRLF' ? originalLF.replace(/\n/g, '\r\n') : originalLF;
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      const saved = await h.save();
      for (let index = 0; index < 3; index++) { await h.surface.setMode('source'); await h.surface.setMode('rich'); }
      const switched = await h.save(); await h.surface.load(switched);
      return { saved, switched, reopened: await h.save(), mode: h.surface.mode, raw: h.richRoot.querySelectorAll('[data-croquill-raw]').length };
    }, original);
    expect(result).toMatchObject({ saved: original, switched: original, reopened: original, mode: 'rich', raw: 0 });
  });

  it.each(['LF', 'CRLF'])('preserves literal extension source while editing an unrelated paragraph (%s)', async newline => {
    const originalLF = '待改正文\n\n' + literalSamples.map(sample => sample.syntax).join('\n\n') + '\n';
    const original = newline === 'CRLF' ? originalLF.replace(/\n/g, '\r\n') : originalLF;
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      h.selectText('待改正文'); h.insert('新'); const saved = await h.save();
      await h.surface.setMode('source'); await h.surface.setMode('rich');
      return { saved, switched: await h.save(), raw: h.richRoot.querySelectorAll('[data-croquill-raw]').length };
    }, original);
    expect(result.saved).toMatch(/^新待改正文(?:\r?\n){2}/);
    // The changed plain paragraph uses the ordinary writer; every extension
    // after its separator must retain its complete original source bytes.
    expect(result.saved.replace(/^新待改正文(?:\r?\n){2}/, '')).toBe(original.replace(/^待改正文(?:\r?\n){2}/, ''));
    expect(result.switched).toBe(result.saved);
    expect(result.raw).toBe(0);
  });

  it('edits highlighted text using the keyboard and writes back == delimiters', async () => {
    await page.evaluate(async () => {
      const h = (window as any).extensionHarness; await h.surface.init('前==重点==后\n'); h.selectText('重点', 1);
    });
    await page.keyboard.insertText('新');
    expect(await page.evaluate(() => (window as any).extensionHarness.save())).toBe('前==重新点==后\n');
    expect(await page.locator('mark').textContent()).toBe('重新点');
    await page.evaluate(() => (window as any).extensionHarness.surface.format('undo'));
    expect(await page.evaluate(() => (window as any).extensionHarness.save())).toBe('前==重点==后\n');
  });

  // The delimiters are ordinary source characters: deleting the words between them leaves
  // the four equals signs as literal text, exactly what the file then contains.
  it('deletes highlighted contents, leaving the delimiters as text, and restores them with undo', async () => {
    await page.evaluate(async () => {
      const h = (window as any).extensionHarness; await h.surface.init('前==重点==后\n'); h.selectText('重点', 0, 2);
    });
    await page.keyboard.press('Backspace');
    expect(await page.evaluate(() => (window as any).extensionHarness.save())).toBe('前====后\n');
    expect(await page.locator('mark').count()).toBe(0);
    expect(await page.locator('.ProseMirror p').first().innerText()).toBe('前====后');
    await page.evaluate(() => (window as any).extensionHarness.surface.format('undo'));
    expect(await page.evaluate(() => (window as any).extensionHarness.save())).toBe('前==重点==后\n');
  });

  // Typing == inside a highlight is typing a delimiter: the highlight ends there, on
  // screen at once and identically after saving and reopening.
  it('ends a highlight where == is typed inside it, the same before and after reopening', async () => {
    await page.evaluate(async () => {
      const h = (window as any).extensionHarness; await h.surface.init('前==甲乙==后\n'); h.selectText('甲乙', 1);
    });
    await page.keyboard.insertText('==');
    const before = await page.evaluate(() => (window as any).extensionHarness.richRoot.querySelector('mark')?.textContent);
    const result = await page.evaluate(async () => {
      const h = (window as any).extensionHarness; const saved = await h.save(); await h.surface.load(saved);
      return { saved, mode: h.surface.mode, text: h.richRoot.querySelector('p')?.innerText, highlight: h.richRoot.querySelector('mark')?.textContent };
    });
    expect(before).toBe('甲');
    expect(result).toEqual({ saved: '前==甲==乙==后\n', mode: 'rich', text: '前甲乙==后', highlight: '甲' });
  });

  it('keeps a BOM before a leading horizontal rule while editing later text', async () => {
    const result = await page.evaluate(async () => {
      const h = (window as any).extensionHarness; await h.surface.init('\uFEFF---\r\n\r\n前==重点==后\r\n\r\n正文\r\n');
      h.selectText('正文'); h.insert('新'); const saved = await h.save(); await h.surface.load(saved);
      return { bom: saved.startsWith('\uFEFF'), mode: h.surface.mode, reason: h.surface.getSafetyReason(), highlight: h.richRoot.querySelector('mark')?.textContent, text: h.richRoot.textContent };
    });
    expect(result).toMatchObject({ bom: true, mode: 'rich', reason: null, highlight: '重点' });
    expect(result.text).toContain('新正文');
  });

  it.each(alertTypes)('edits %s alert text without leaking the title or escaping its marker', async type => {
    const original = `> [!${type}]\n> 正文与==高亮==。\n`;
    await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original); h.selectText('正文');
    }, original);
    await page.keyboard.insertText('新');
    expect(await page.evaluate(() => (window as any).extensionHarness.save())).toBe(original.replace('正文', '新正文'));
    await page.evaluate(() => (window as any).extensionHarness.surface.format('undo'));
    expect(await page.evaluate(() => (window as any).extensionHarness.save())).toBe(original);
  });

  it('copies and pastes an alert without inserting its generated title into the Markdown body', async () => {
    const result = await page.evaluate(async () => {
      const h = (window as any).extensionHarness;
      await h.surface.init('> [!NOTE]\n> 提示正文\n\n粘贴处\n');
      const view = h.surface.richView();
      let range: { from: number; to: number } | undefined;
      view.state.doc.descendants((node: any, position: number) => {
        if (node.type.name === 'croquill_alert' && !range) range = { from: position, to: position + node.nodeSize };
      });
      if (!range) throw Error('Alert node not found');
      const clipboard = view.serializeForClipboard(view.state.doc.slice(range.from, range.to));
      const data = new DataTransfer();
      data.setData('text/html', clipboard.dom.innerHTML); data.setData('text/plain', clipboard.text);
      h.selectText('粘贴处', 3);
      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const saved = await h.save(); await h.surface.load(saved);
      return { saved, reopened: await h.save(), alerts: h.richRoot.querySelectorAll('[data-croquill-alert="NOTE"]').length, mode: h.surface.mode };
    });
    expect(result.alerts).toBe(2);
    expect(result.mode).toBe('rich');
    expect(result.saved.match(/> \[!NOTE\]/g)).toHaveLength(2);
    expect(result.saved.match(/提示正文/g)).toHaveLength(2);
    expect(result.saved).not.toContain('Note');
    expect(result.reopened).toBe(result.saved);
  });

  it.each(['LF', 'CRLF'])('preserves a highlighted table while another cell changes (%s)', async newline => {
    const originalLF = '|   内容   | 备注 |\n| :-------- | ----: |\n| 前==**高亮**==后 | 待改 |\n';
    const original = newline === 'CRLF' ? originalLF.replace(/\n/g, '\r\n') : originalLF;
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original); h.selectText('待改'); h.insert('新');
      return { saved: await h.save(), mark: h.richRoot.querySelector('td mark strong,td strong mark')?.textContent };
    }, original);
    expect(result).toEqual({ saved: original.replace('待改', '新待改'), mark: '高亮' });
  });

  it('keeps composition beside a highlight without swallowing text, moving the caret or invoking a shortcut', async () => {
    const result = await page.evaluate(async () => {
      const h = (window as any).extensionHarness; await h.surface.init('前==重点==后\n'); h.selectText('后');
      const view = h.surface.richView();
      view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '字', bubbles: true }));
      h.insert('组词');
      const position = view.state.selection.from;
      const keyboard = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
      view.dom.dispatchEvent(keyboard);
      const during = { composing: view.composing, position: view.state.selection.from, expected: position, headings: h.richRoot.querySelectorAll('h2').length };
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '组词', bubbles: true }));
      return { during, saved: await h.save(), text: h.richRoot.querySelector('p')?.innerText };
    });
    expect(result.during).toMatchObject({ composing: true, headings: 0 });
    expect(result.during.position).toBe(result.during.expected);
    expect(result.saved).toBe('前==重点==组词后\n');
    // The caret sits right after the closing ==, so the delimiters are on screen.
    expect(result.text).toBe('前==重点==组词后');
  });

  it('shows inline and block HTML comments as dimmed literal source without executing markup', async () => {
    const original = '前<!-- <img src=x onerror="window.commentExecuted=true"> -->后\n\n<!-- 多行\n第二行 -->\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      const comments = Array.from(h.richRoot.querySelectorAll('[data-croquill-comment]')) as HTMLElement[];
      return { mode: h.surface.mode, raw: h.richRoot.querySelectorAll('[data-croquill-raw]').length, count: comments.length,
        texts: comments.map(node => node.textContent), styles: comments.map(node => ({ opacity: getComputedStyle(node).opacity, color: getComputedStyle(node).color })),
        proseColor: getComputedStyle(h.richRoot.querySelector('.ProseMirror')).color,
        executed: !!(window as any).commentExecuted, liveImages: h.richRoot.querySelectorAll('img').length, saved: await h.save() };
    }, original);
    expect(result).toMatchObject({ mode: 'rich', raw: 0, count: 2, executed: false, liveImages: 0, saved: original });
    expect(result.texts).toEqual(['<!-- <img src=x onerror="window.commentExecuted=true"> -->', '<!-- 多行\n第二行 -->']);
    for (const style of result.styles) expect(Number(style.opacity) < 1 || style.color !== result.proseColor).toBe(true);
  });

  it('keeps an entire alert protected when its content contains another protected syntax', async () => {
    const original = '> [!NOTE]\n> ==高亮==和[TOC]一起保护。\n';
    const result = await page.evaluate(async original => {
      const h = (window as any).extensionHarness; await h.surface.init(original);
      return { raw: h.richRoot.querySelectorAll('[data-croquill-raw]').length, alerts: h.richRoot.querySelectorAll('[data-croquill-alert]').length,
        marks: h.richRoot.querySelectorAll('mark').length, saved: await h.save() };
    }, original);
    expect(result).toEqual({ raw: 1, alerts: 0, marks: 0, saved: original });
  });
});
