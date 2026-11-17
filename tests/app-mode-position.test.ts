import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';
import type { AlignedBlock } from '../src/mode-position';

const examplesPath = fileURLToPath(new URL('../examples/', import.meta.url));

function publicMarkdownPaths(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'private') return publicMarkdownPaths(path);
    return entry.isFile() && /\.md$/i.test(entry.name) ? [path] : [];
  });
}

describe('mode switch caret and scroll preservation through the real app', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;

  beforeAll(async () => {
    server = await createTestServer();
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('No server');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  });

  afterEach(async () => {
    await page?.evaluate(() => (window as any).fileApp?.surface.destroy());
    await page?.close();
  });

  const settleFrames = (count = 4) =>
    page.evaluate(
      n =>
        new Promise<void>(resolve => {
          let i = 0;
          const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
      count,
    );

  async function open(source: string) {
    await openFileApp(page, baseURL, { files: { [currentFile]: source } });
    await focusApp(page, 'rich');
    await settleFrames();
  }

  async function pressModeToggle() {
    const beforeMode = await page.evaluate(() => (window as any).fileApp.surface.mode);
    await page.keyboard.press('Control+/');
    await page.waitForFunction(m => (window as any).fileApp.surface.mode !== m, beforeMode);
    await settleFrames(4);
  }

  const setRichCaretBySubstring = (snippet: string, offsetInside = 0) =>
    page.evaluate(
      ({ snippet, offsetInside }) => {
        const view = (window as any).fileApp.surface.richView();
        let target: number | null = null;
        view.state.doc.descendants((node: any, pos: number) => {
          if (target === null && node.isText && node.text.includes(snippet)) {
            target = pos + node.text.indexOf(snippet) + offsetInside;
          }
        });
        if (target === null) throw new Error('Snippet not found in Rich doc: ' + snippet);
        const selection = view.state.selection.constructor.near(view.state.doc.resolve(target));
        view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
        view.focus();
      },
      { snippet, offsetInside },
    );

  const sourceHeadOffset = () =>
    page.evaluate(() => (window as any).fileApp.surface.source.state.selection.main.head as number);

  const richHeadPos = () =>
    page.evaluate(() => (window as any).fileApp.surface.richView().state.selection.head as number);

  it('opens the manual outline-position sample in rich mode', async () => {
    const source = readFileSync(join(examplesPath, 'outline-position.md'), 'utf8');
    await openFileApp(page, baseURL, { files: { [currentFile]: source } });
    const state = await page.evaluate(() => {
      const { surface } = (window as any).fileApp;
      return { mode: surface.mode, reason: surface.getSafetyReason() };
    });
    expect(state).toEqual({ mode: 'rich', reason: null });
  });

  it.each([
    ['> [!NOTE]\n> 提示正文 ALERTX 结束\n\n后文 AFTERX 结束\n', ['ALERTX', 'AFTERX']],
    [
      '前文 BEFOREX 结束\n\n> [!TIP]\n> 提示正文 ALERTX 结束\n> 第二行 WRAPX\n>\n> 另一段 PARAX\n>\n> - 清单里面 LISTX\n\n后文 AFTERX 结束\n',
      ['BEFOREX', 'ALERTX', 'WRAPX', 'PARAX', 'LISTX', 'AFTERX'],
    ],
  ] as const)('keeps alert body carets exact and the marker inside its own alert (%#)', async (doc, snippets) => {
    await open(doc);
    for (const snippet of snippets) {
      await setRichCaretBySubstring(snippet, 2);
      const richHead = await richHeadPos();
      await pressModeToggle();
      expect(await sourceHeadOffset()).toBe(doc.indexOf(snippet) + 2);
      await pressModeToggle();
      expect(await richHeadPos()).toBe(richHead);
    }

    await setRichCaretBySubstring('提示正文');
    const alertStart = await richHeadPos();
    await pressModeToggle();
    await page.evaluate(offset => {
      const cm = (window as any).fileApp.surface.source;
      cm.dispatch({ selection: { anchor: offset } });
    }, doc.indexOf('[!') + 2);
    await pressModeToggle();
    expect(await richHeadPos()).toBe(alertStart);
  });

  it.each([
    { doc: '前段 BEFOREX 结束\n\n包含 $x^2$ 的后段 MATHX 结束\n\n尾段 TAILX\n', first: '包含', after: 'MATHX' },
    { doc: '前段 BEFOREX 结束\n\n文字 ![图](a.png) 之后 IMGX 结束\n\n尾段 TAILX\n', first: '文字', after: 'IMGX' },
  ])('round-trips exact text caret offsets around the inline node before $after', async ({ doc, first, after }) => {
    await open(doc);
    for (const snippet of ['BEFOREX', first, after, 'TAILX']) {
      await setRichCaretBySubstring(snippet, 1);
      const richHead = await richHeadPos();
      await pressModeToggle();
      expect(await sourceHeadOffset()).toBe(doc.indexOf(snippet) + 1);
      await pressModeToggle();
      expect(await richHeadPos()).toBe(richHead);
    }
  });

  it('inserts an external image at the drop point after restoring a raw block selection', async () => {
    const doc = '前段\n\n<div>原文块</div>\n\n中隔 BARRIERX\n\n投放前 DROPX 投放后\n\n尾段 TAILX\n';
    await open(doc);
    await pressModeToggle();
    await page.evaluate(offset => {
      const cm = (window as any).fileApp.surface.source;
      cm.dispatch({ selection: { anchor: offset } });
    }, doc.indexOf('原文块') + 1);
    await pressModeToggle();

    const drop = await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const selectedNode = view.state.selection.node?.type.name;
      let target = -1;
      const document: PMNode = view.state.doc;
      document.descendants((node, pos) => {
        if (node.isText && node.text?.includes('DROPX')) target = pos + node.text.indexOf('DROPX') + 2;
      });
      if (target < 0) throw new Error('Missing drop target');
      const point = view.coordsAtPos(target);
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'drop.png', { type: 'image/png' }));
      const event = new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer, clientX: point.left, clientY: (point.top + point.bottom) / 2,
      });
      view.dom.dispatchEvent(event);
      return { selectedNode, handled: event.defaultPrevented };
    });
    expect(drop).toEqual({ selectedNode: 'croquill_raw_block', handled: true });
    await page.waitForFunction(() => (window as any).fileApp.session.text.includes('当前.assets/图片.png'));
    const markdown = await page.evaluate(() => (window as any).fileApp.session.text as string);
    expect(markdown).toContain('<div>原文块</div>');
    const before = markdown.indexOf('投放前');
    const image = markdown.indexOf('当前.assets/图片.png');
    const after = markdown.indexOf('投放后');
    expect(before).toBeGreaterThan(markdown.indexOf('BARRIERX'));
    expect(image).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(image);
  });

  it('scans text caret alignment in every public example that opens in rich mode', async () => {
    const samples = publicMarkdownPaths(examplesPath).sort().map(path => ({
      name: relative(examplesPath, path).replaceAll('\\', '/'),
      raw: readFileSync(path, 'utf8'),
    }));
    await page.goto(`${baseURL}/tests/harness.html`);
    await page.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      import * as alignment from '/src/mode-position.ts';
      window.positionScan = { MarkdownSurface, ...alignment };
    ` });
    await page.waitForFunction(() => 'positionScan' in window);
    const reports = await page.evaluate(async samples => {
      const { MarkdownSurface, buildDocumentAlignment, mapRichSelectionToRawOffset, mapRawOffsetToRichSelection } = (window as any).positionScan;
      const richRoot = document.createElement('div');
      const sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const surface = new MarkdownSurface({ richRoot, sourceRoot, resolveImage: async () => '', onChange: () => {} });
      try {
        const reports = [];
        for (const { name, raw } of samples) {
          await surface.load(raw);
          if (surface.mode !== 'rich') {
            reports.push({ name, skipped: true as const });
            continue;
          }
          const view = (surface as any).richView();
          const doc: PMNode = view.state.doc;
          const alignment = buildDocumentAlignment(raw, doc);
          const failures: string[] = [];
          let prevOffset = 0;
          let positions = 0;
          let alertTextPositions = 0;
          doc.descendants((block, pos) => {
            if (!block.isTextblock) return true;
            const parent = doc.resolve(pos);
            const ancestors = Array.from({ length: parent.depth }, (_, i) => parent.node(i + 1).type.name);
            const ordinary = ['paragraph', 'heading'].includes(block.type.name) &&
              !ancestors.some(type => ['table_cell', 'table_header', 'footnote_definition'].includes(type));
            const aligned = alignment.blocks.find((entry: AlignedBlock) => entry.richPos === pos && entry.isTextblock);
            for (let offset = 0; offset <= block.content.size; offset++) {
              const head = pos + 1 + offset;
              const selection = view.state.selection.constructor.near(doc.resolve(head));
              const rawOffset = mapRichSelectionToRawOffset(alignment, raw.length, selection);
              positions++;
              if (rawOffset < prevOffset && failures.length < 8) {
                failures.push(`${block.type.name} ${head}: offset ${rawOffset} goes back from ${prevOffset}`);
              }
              prevOffset = rawOffset;
              // Block-level fallback structures, and positions before breaks or atoms, have no ordinary character to compare.
              const next = block.childAfter(offset);
              if (ordinary && aligned?.segments === null) {
                const restored = mapRawOffsetToRichSelection(alignment, doc, rawOffset).head;
                const inRawBlock = rawOffset >= aligned.rawStart && rawOffset <= aligned.rawEnd;
                const inRichBlock = restored > pos && restored < pos + block.nodeSize;
                if ((!inRawBlock || !inRichBlock) && failures.length < 8) {
                  failures.push(`${block.type.name} ${head}: fallback left the block at source ${rawOffset}, restored ${restored}`);
                }
              } else if (ordinary && next.node?.isText) {
                if (ancestors.includes('croquill_alert')) alertTextPositions++;
                const expected = next.node.text![offset - next.offset];
                const restored = mapRawOffsetToRichSelection(alignment, doc, rawOffset).head;
                if ((raw[rawOffset] !== expected || restored !== head) && failures.length < 8) {
                  failures.push(`${block.type.name} ${head}: source ${rawOffset} has ${JSON.stringify(raw[rawOffset])}, expected ${JSON.stringify(expected)}; restored ${restored}`);
                }
              }
            }
            return false;
          });
          reports.push({ name, skipped: false as const, positions, alertTextPositions, failures });
        }
        return reports;
      } finally {
        await surface.destroy();
      }
    }, samples);

    const skipped = reports.filter(report => report.skipped).map(report => report.name);
    const scanned = reports.filter(report => !report.skipped);
    console.log(`Public examples in source protection: ${skipped.join(', ') || 'none'}`);
    console.log(`Scanned ${scanned.reduce((total, report) => total + report.positions, 0)} text caret positions across ${scanned.length} public examples`);
    expect(scanned.find(report => report.name === 'highlight-alert.md')?.alertTextPositions).toBeGreaterThan(0);
    expect(scanned.filter(report => report.failures.length).map(({ name, failures }) => ({ name, failures }))).toEqual([]);
  }, 60000);

  it('preserves exact character offsets inside inline syntax markers, CJK text, headings, lists, task items, and blockquotes', async () => {
    const doc = [
      '# 一级 **标题**',
      '',
      '普通中文 **加粗文字** 与 *斜体* 与 ~~删除~~ 与 `代码` 与 ==高亮== 与 [文字](https://example.com/a "t") 与 <https://angle.example> 与 \\*转义。',
      '',
      '1. 有序一项',
      '   - [x] 已完成任务 **子项**',
      '   - [ ] 未完成任务',
      '2. ',
      '',
      '> 引用第一行',
      '> 引用第二行 **内部**',
    ].join('\n');

    await open(doc);

    // 1. Inside inline markers in heading & paragraph & link URL & angle autolink & escape
    const checks: [string, number][] = [
      ['**标题**', 2], // between ** and 标
      ['**加粗文字**', 4], // between 加粗 and 文字
      ['~~删除~~', 3], // inside 删除
      ['`代码`', 2], // inside 代码
      ['==高亮==', 3], // inside 高亮
      ['(https://example.com/a "t")', 10], // inside link URL
      ['<https://angle.example>', 9], // inside angle autolink
      ['\\*转义', 1], // between backslash and asterisk
      ['已完成任务 **子项**', 8], // inside task item nested strong
      ['引用第二行 **内部**', 8], // inside line 2 of blockquote paragraph
    ];

    for (const [snippet, offset] of checks) {
      await setRichCaretBySubstring(snippet, offset);
      const expectedRichHead = await richHeadPos();
      await pressModeToggle();
      const expectedSourceOffset = doc.indexOf(snippet) + offset;
      expect(await sourceHeadOffset()).toBe(expectedSourceOffset);

      await pressModeToggle();
      expect(await richHeadPos()).toBe(expectedRichHead);
    }

    // 2. Non-empty Rich selection head wins cleanly on Rich -> Source
    await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const targetStart = view.state.doc.textBetween(0, view.state.doc.content.size, '\0', '\0').length;
      let pPos: number | null = null;
      view.state.doc.descendants((node: any, pos: number) => {
        if (pPos === null && node.isText && node.text.includes('有序一项')) pPos = pos + node.text.indexOf('有序一项');
      });
      if (pPos === null || targetStart < 0) throw new Error('missing');
      const Sel = view.state.selection.constructor;
      view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, pPos + 4, pPos + 1)).setMeta('addToHistory', false));
      view.focus();
    });
    await pressModeToggle();
    expect(await sourceHeadOffset()).toBe(doc.indexOf('有序一项') + 1);

    // 3. Empty ordered list item ('2. ') roundtrips cleanly
    await page.evaluate(pos => {
      const cm = (window as any).fileApp.surface.source;
      cm.dispatch({ selection: { anchor: pos } });
      cm.focus();
    }, doc.indexOf('2. ') + 3);
    await pressModeToggle();
    await pressModeToggle();
    expect(await sourceHeadOffset()).toBe(doc.indexOf('2. ') + 3);
  });

  it('maps soft breaks, double-space hard breaks, backslash breaks, and <br /> breaks across Rich <-> Source', async () => {
    const doc = [
      '软行一',
      '软行二',
      '',
      '硬行一  ',
      '硬行二\\',
      '硬行三<br />硬行四',
    ].join('\n');

    await open(doc);

    for (const marker of ['软行二', '硬行二', '硬行三', '硬行四']) {
      await page.evaluate(targetMarker => {
        const surface = (window as any).fileApp.surface;
        if (surface.mode === 'rich') {
          const view = surface.richView();
          let p: number | null = null;
          view.state.doc.descendants((node: any, pos2: number) => {
            if (p === null && node.isText && node.text.includes(targetMarker)) p = pos2 + node.text.indexOf(targetMarker);
          });
          if (p === null) throw new Error('missing ' + targetMarker);
          const Sel = view.state.selection.constructor;
          view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, p)).setMeta('addToHistory', false));
          view.focus();
        }
      }, marker);

      const richBefore = await richHeadPos();
      await pressModeToggle();
      expect(await sourceHeadOffset()).toBe(doc.indexOf(marker));
      await pressModeToggle();
      expect(await richHeadPos()).toBe(richBefore);
    }
  });

  it.each([
    { doc: '前段 BEFOREX 结束\r\r第一行 CRX 结束\r第二行\r', snippets: ['BEFOREX', 'CRX', '第二行'] },
    {
      doc: '> 首行\r> 软换行 SOFTX  \r> 空格硬换行 SPACEX\\\r> 反斜杠硬换行 SLASHX<br />\r> 标签后 NEXTX\r',
      snippets: ['SOFTX', 'SPACEX', 'SLASHX', 'NEXTX'],
    },
  ])('preserves exact offsets across standalone CR line breaks (%#)', async ({ doc, snippets }) => {
    await open(doc);
    for (const snippet of snippets) {
      await setRichCaretBySubstring(snippet, 1);
      const richHead = await richHeadPos();
      await pressModeToggle();
      expect(await sourceHeadOffset()).toBe(doc.indexOf(snippet) + 1);
      await pressModeToggle();
      expect(await richHeadPos()).toBe(richHead);
    }
    expect(await page.evaluate(() => (window as any).fileApp.surface.getMarkdown())).toBe(doc);
  });

  it('preserves exact offsets with YAML frontmatter, UTF-8 BOM, and CRLF without modifying document bytes', async () => {
    const doc = '\uFEFF---\r\ntitle: 前置元数据\r\n---\r\n\r\n# 正文标题\r\n\r\n正文第一段中文 **高亮** 内容。\r\n\r\n> 多行引用一\r\n> 多行引用二\r\n';
    await open(doc);

    await setRichCaretBySubstring('正文第一段中文', 4);
    const richBefore = await richHeadPos();
    await pressModeToggle();

    // Verify Source caret line and column match 正文第一段中文 + 4
    const cmPos = await page.evaluate(() => {
      const cm = (window as any).fileApp.surface.source;
      const line = cm.state.doc.lineAt(cm.state.selection.main.head);
      return { text: line.text, ch: cm.state.selection.main.head - line.from };
    });
    expect(cmPos.text).toBe('正文第一段中文 **高亮** 内容。');
    expect(cmPos.ch).toBe(4);

    // Move Source caret into YAML frontmatter -> Source -> Rich falls back cleanly to doc start without touching bytes
    await page.evaluate(() => {
      const cm = (window as any).fileApp.surface.source;
      cm.dispatch({ selection: { anchor: 10 } });
      cm.focus();
    });
    await pressModeToggle();
    const afterFmRichHead = await richHeadPos();
    expect(afterFmRichHead).toBeLessThanOrEqual(4);

    // Move back to 正文第一段中文 in Rich, bounce back & forth, verify exact bytes & dirty === false
    await setRichCaretBySubstring('正文第一段中文', 4);
    expect(await richHeadPos()).toBe(richBefore);
    await pressModeToggle();
    await pressModeToggle();
    expect(await richHeadPos()).toBe(richBefore);

    const stateCheck = await page.evaluate(() => ({
      dirty: (window as any).fileApp.session.dirty,
      raw: (window as any).fileApp.surface.getMarkdown(),
    }));
    expect(stateCheck.dirty).toBe(false);
    expect(stateCheck.raw).toBe(doc);
  });

  it('falls back degenerate blocks strictly to THAT block start and never jumps to adjacent blocks', async () => {
    const doc = [
      '前置普通段',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| 值1 | 值2 |',
      '',
      '```ts',
      'const firstLine = 1;',
      'const secondLine = 2;',
      '```',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '<div>\n<p>HTML 块内段</p>\n</div>',
      '',
      '# 原文保护标题 {#raw-anchor}',
      '',
      '![示意图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)',
      '',
      '[TOC]',
      '',
      '[^note]: 脚注定义内容',
      '',
      '尾随普通段',
    ].join('\n');

    await open(doc);

    const blockTargets: { needle: string; blockStart: string }[] = [
      { needle: '值2', blockStart: '| 列一 | 列二 |' },
      { needle: 'secondLine', blockStart: '```ts' },
      { needle: 'E = mc^2', blockStart: '$$' },
      { needle: 'HTML 块内段', blockStart: '<div>' },
      { needle: '#raw-anchor', blockStart: '# 原文保护标题 {#raw-anchor}' },
      { needle: '示意图', blockStart: '![示意图](' },
      { needle: '[TOC]', blockStart: '[TOC]' },
      { needle: '脚注定义内容', blockStart: '[^note]: 脚注定义内容' },
    ];

    for (const { needle, blockStart } of blockTargets) {
      // Source -> Rich inside degenerate block must stay inside THAT block, and Rich -> Source lands at THAT block start
      await pressModeToggle(); // ensure Source or toggle to Source
      const curMode = await page.evaluate(() => (window as any).fileApp.surface.mode);
      if (curMode !== 'source') await pressModeToggle();

      const insideOffset = doc.indexOf(needle) + 1;
      await page.evaluate(pos => {
        const cm = (window as any).fileApp.surface.source;
        cm.dispatch({ selection: { anchor: pos } });
        cm.focus();
      }, insideOffset);

      await pressModeToggle(); // -> Rich
      const richBounds = await page.evaluate(() => {
        const view = (window as any).fileApp.surface.richView();
        const sel = view.state.selection;
        return {
          from: sel.from,
          head: sel.head,
          textAround: view.state.doc.textBetween(Math.max(0, sel.from - 2), Math.min(view.state.doc.content.size, sel.to + 12), ' '),
        };
      });
      // Must NOT jump into 前置普通段 or 尾随普通段
      expect(richBounds.textAround).not.toContain('前置普通段');
      expect(richBounds.textAround).not.toContain('尾随普通段');

      await pressModeToggle(); // -> Source
      expect(await sourceHeadOffset()).toBe(doc.indexOf(blockStart));
    }
  });

  it.each([
    {
      name: 'HTML split by blank lines',
      doc: '<div>\n\n内容甲\n\n内容乙\n\n</div>\n\n后续正文 TAILA 结束\n\n另一段 TAILB 结束\n',
      needles: ['TAILA', 'TAILB'],
    },
    {
      name: 'a protected container between paragraphs',
      doc: '前文\n\n::: note\n\n内容甲\n\n内容乙\n\n:::\n\n后续正文 TAILA 结束\n\n另一段 TAILB 结束\n',
      needles: ['前文', 'TAILA', 'TAILB'],
    },
    {
      name: 'details with Markdown-like content',
      doc: '<details>\n<summary>标题</summary>\n\n隐藏 **内容**\n\n- 项一\n- 项二\n\n</details>\n\n## 后续标题 TAILH\n\n正文 TAILP 结束\n',
      needles: ['TAILH', 'TAILP'],
    },
  ])('preserves exact offsets on both mode switches around $name', async ({ doc, needles }) => {
    await open(doc);
    for (const needle of needles) {
      await setRichCaretBySubstring(needle, 1);
      const richHead = await richHeadPos();
      await pressModeToggle();
      expect(await sourceHeadOffset()).toBe(doc.indexOf(needle) + 1);
      await pressModeToggle();
      expect(await richHeadPos()).toBe(richHead);
    }
  });

  it.each([
    ['list', '段一\n\n- 项一\n- 项二 LASTITEM\n'],
    ['table', '段一\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n'],
  ])('maps the synthetic empty paragraph after a final %s to source EOF and back', async (_, doc) => {
    await open(doc);
    const richHead = await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const paragraph = view.state.doc.lastChild;
      if (paragraph.type.name !== 'paragraph' || paragraph.content.size !== 0) throw new Error('Missing trailing caret paragraph');
      const pos = view.state.doc.content.size - 1;
      const selection = view.state.selection.constructor.create(view.state.doc, pos);
      view.dispatch(view.state.tr.setSelection(selection));
      return pos;
    });
    await pressModeToggle();
    expect(await sourceHeadOffset()).toBe(doc.length);
    await pressModeToggle();
    expect(await richHeadPos()).toBe(richHead);
  });

  it('keeps relative viewport position within 24 CSS px when caret is visible and aligns topmost block when caret is offscreen', async () => {
    const filler = (label: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${label} 第 ${i + 1} 段用于构造多屏长文档，测试视图切换前后滚动对齐精度。`).join('\n\n');

    const doc = [
      '# 顶部锚点',
      filler('前部段落', 18),
      '## 中间对齐段落标题',
      '目标定位句：将光标置于此处并在视口中间测算坐标偏移。',
      filler('后部段落', 22),
      '# 结尾',
    ].join('\n\n');

    await open(doc);

    // Case A: Caret INSIDE viewport
    await setRichCaretBySubstring('目标定位句', 5);
    await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const scroller = document.getElementById('editor-scroll')!;
      const coords = view.coordsAtPos(view.state.selection.head);
      const vp = scroller.getBoundingClientRect();
      scroller.scrollTop += coords.top - (vp.top + vp.height * 0.45);
    });
    await settleFrames();

    const richRelY = await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const scroller = document.getElementById('editor-scroll')!;
      return view.coordsAtPos(view.state.selection.head).top - scroller.getBoundingClientRect().top;
    });

    await pressModeToggle(); // Rich -> Source
    const sourceRelY = await page.evaluate(() => {
      const cm = (window as any).fileApp.surface.source;
      const scroller = document.getElementById('editor-scroll')!;
      const coords = cm.coordsAtPos(cm.state.selection.main.head)!;
      return coords.top - scroller.getBoundingClientRect().top;
    });
    expect(Math.abs(sourceRelY - richRelY)).toBeLessThanOrEqual(24);

    await pressModeToggle(); // Source -> Rich
    const richRelYAfter = await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const scroller = document.getElementById('editor-scroll')!;
      return view.coordsAtPos(view.state.selection.head).top - scroller.getBoundingClientRect().top;
    });
    expect(Math.abs(richRelYAfter - sourceRelY)).toBeLessThanOrEqual(24);

    // Case B: Caret OUTSIDE viewport (place caret at top, scroll deep down to '后部段落 第 12 段')
    await setRichCaretBySubstring('前部段落 第 1 段', 2);
    const exposedBefore = await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      const targetP = Array.from(document.querySelectorAll('#rich-root p')).find(el =>
        el.textContent?.includes('后部段落 第 12 段'),
      ) as HTMLElement;
      const vp = scroller.getBoundingClientRect();
      scroller.scrollTop += targetP.getBoundingClientRect().top - vp.top - 10;
      const scrollAfter = scroller.scrollTop;
      const relTop = targetP.getBoundingClientRect().top - vp.top;
      return { scrollAfter, relTop };
    });
    await settleFrames();

    await pressModeToggle(); // Rich -> Source with offscreen caret
    const exposedInSource = await page.evaluate(() => {
      const cm = (window as any).fileApp.surface.source;
      const scroller = document.getElementById('editor-scroll')!;
      const text = cm.state.doc.toString();
      const idx = text.indexOf('后部段落 第 12 段');
      const block = cm.lineBlockAt(idx);
      const vp = scroller.getBoundingClientRect();
      const headCoords = cm.coordsAtPos(cm.state.selection.main.head);
      const caretVisible = Boolean(headCoords && headCoords.bottom > vp.top && headCoords.top < vp.bottom);
      return {
        scrollTop: scroller.scrollTop,
        caretVisible,
        relTop: cm.documentTop + block.top - vp.top,
      };
    });
    expect(exposedInSource.caretVisible).toBe(false);
    expect(exposedInSource.scrollTop).toBeGreaterThan(300);
    expect(Math.abs(exposedInSource.relTop - exposedBefore.relTop)).toBeLessThanOrEqual(24);

    await pressModeToggle(); // Source -> Rich with offscreen caret
    const exposedBackRich = await page.evaluate(() => {
      const scroller = document.getElementById('editor-scroll')!;
      const targetP = Array.from(document.querySelectorAll('#rich-root p')).find(el =>
        el.textContent?.includes('后部段落 第 12 段'),
      ) as HTMLElement;
      const vp = scroller.getBoundingClientRect();
      const view = (window as any).fileApp.surface.richView();
      const headCoords = view.coordsAtPos(view.state.selection.head);
      return {
        caretVisible: headCoords.bottom > vp.top && headCoords.top < vp.bottom,
        relTop: targetP.getBoundingClientRect().top - vp.top,
      };
    });
    expect(exposedBackRich.caretVisible).toBe(false);
    expect(Math.abs(exposedBackRich.relTop - exposedInSource.relTop)).toBeLessThanOrEqual(24);
  });

  it('produces zero dirty flags, zero history steps, exact byte identity, and respects IME composition', async () => {
    const doc = '初始 **文字** 内容。';
    await open(doc);

    await page.evaluate(() => {
      const surface = (window as any).fileApp.surface;
      let calls = 0;
      const orig = surface.options.onChange;
      surface.options.onChange = (t: string) => {
        calls += 1;
        orig(t);
      };
      (window as any).__onChangeCount = () => calls;
    });

    await setRichCaretBySubstring('文字', 1);
    await pressModeToggle();
    await pressModeToggle();

    const afterClean = await page.evaluate(() => ({
      dirty: (window as any).fileApp.session.dirty,
      changes: (window as any).__onChangeCount(),
      raw: (window as any).fileApp.surface.getMarkdown(),
      // Verify no extra span nodes injected around caret in inline-source view
      extraSpansAtCaret: document.querySelectorAll('#rich-root p span:not(.croquill-inline-syntax)').length,
    }));
    expect(afterClean.dirty).toBe(false);
    expect(afterClean.changes).toBe(0);
    expect(afterClean.raw).toBe(doc);

    // Edit once, switch modes back and forth, and confirm single Ctrl+Z undoes the edit
    await focusApp(page, 'rich');
    await setRichCaretBySubstring('文字', 2);
    await page.keyboard.type('ABC');
    await page.waitForFunction(() => (window as any).fileApp.surface.getMarkdown().includes('文字ABC'));

    await pressModeToggle();
    await pressModeToggle();

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !(window as any).fileApp.surface.getMarkdown().includes('ABC'));
    expect(await page.evaluate(() => (window as any).fileApp.surface.getMarkdown())).toBe(doc);

    // IME composition blocks Ctrl+/
    await page.evaluate(() => {
      const dom = (window as any).fileApp.surface.richView().dom;
      dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.keyboard.press('Control+/');
    await settleFrames();
    expect(await page.evaluate(() => (window as any).fileApp.surface.mode)).toBe('rich');

    await page.evaluate(() => {
      const dom = (window as any).fileApp.surface.richView().dom;
      dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    });
  });
});
