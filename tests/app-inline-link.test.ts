import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, focusApp, openFileApp } from './app-files-fixture';

describe('inline link source editing through the real app', () => {
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
    await openFileApp(page, baseURL, { files: { [currentFile]: source }, ...config });
    expect(await page.evaluate(() => { const s = (window as any).fileApp.surface; return { mode: s.mode, reason: s.getSafetyReason() }; })).toEqual({ mode: 'rich', reason: null });
    await focusApp(page, 'rich');
    await page.waitForFunction(() => Date.now() - (window as any).fileApp.surface.richView().input.lastFocus > 200);
  }

  const caret = (text: string, offset = 0, length = 0) => page.evaluate(({ text, offset, length }) => {
    const view = (window as any).fileApp.surface.richView(); let position: number | undefined;
    view.state.doc.descendants((node: any, pos: number) => {
      if (position === undefined && node.isText && node.text.includes(text)) position = pos + node.text.indexOf(text) + offset;
    });
    if (position === undefined) throw Error('Text not found: ' + text);
    const SelBase = Object.getPrototypeOf(view.state.selection.constructor);
    const TextSel = SelBase.near(view.state.doc.resolve(position)).constructor;
    view.dispatch(view.state.tr.setSelection(TextSel.create(view.state.doc, position, position + length)));
    view.focus();
  }, { text, offset, length });

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

  async function press(key: string, times = 1) {
    for (let index = 0; index < times; index++) {
      const before = await page.evaluate(() => (window as any).fileApp.surface.richView().state.selection.head);
      await page.keyboard.press(key);
      await page.waitForFunction(before => (window as any).fileApp.surface.richView().state.selection.head !== before, before, { timeout: 3000 }).catch(() => {});
    }
    await settle();
  }

  it('keeps every original link spelling byte for byte while another paragraph is edited', async () => {
    const lines = [
      '[x](<a b> \'v\') 与 [n\\]n](u(1))',
      '',
      '裸网址：https://x.com/p 与 www.y.com 和 me@z.com',
      '',
      '[首](u) 行首',
      '',
      '<https://solo.com>',
      '',
      '<me@solo.com>',
      '',
      '> [引](https://q.com "qt") 与 <https://q2.com> 和 www.q3.com',
      '',
      '- [列](https://l.com) 与 <me@list.com> 和 list@l.com',
      '',
      '[甲\n乙](u)',
      '',
      '| 栏                       |',
      '| ----------------------- |',
      '| [表](https://a.com/x\\|y) |',
      '',
      '[t **b** `c`](u "v") 与 **[粗里链](u)** 与 [![im](p.png)](u)',
      '',
      '普通段落',
      '',
    ];
    const source = lines.join('\n');
    await open(source);
    await caret('普通段落', 4);
    await page.keyboard.insertText('改');
    await settle();
    const after = await markdown();
    expect(after).toBe(source.replace('普通段落', '普通段落改'));
  }, 30000);

  it.each([
    { eol: '\n', bom: false, name: 'LF' },
    { eol: '\r\n', bom: false, name: 'CRLF' },
    { eol: '\r\n', bom: true, name: 'BOM + CRLF' },
  ])('opens $name with all link syntaxes without editing or marking dirty', async ({ eol, bom }) => {
    const body = [
      '[文字](https://example.com "标题") 与 [x](<a b> \'v\')',
      '',
      '<https://solo.com>',
      '',
      '<me@q.com>',
      '',
      '裸：https://x.com/p www.y.com me@z.com',
      '',
    ].join(eol);
    const source = (bom ? '\uFEFF' : '') + body;
    await open(source, { bom });
    const state = await page.evaluate(() => {
      const h = (window as any).fileApp;
      return { dirty: h.session.dirty, markdown: h.surface.getMarkdown() };
    });
    expect(state.dirty).toBe(false);
    expect(state.markdown).toBe(source);
  }, 30000);

  it('keeps reference links in source protection while opening [](u) cleanly in rich mode', async () => {
    const refDoc = '参考 [r][1] 链接\n\n[1]: https://a.com\n';
    await openFileApp(page, baseURL, { files: { [currentFile]: refDoc } });
    const refState = await page.evaluate(() => {
      const s = (window as any).fileApp.surface;
      return { mode: s.mode, reason: s.getSafetyReason() };
    });
    expect(refState).toEqual({
      mode: 'source',
      reason: '此文档的部分结构无法可靠往返转换，已保留原文并启用源码保护',
    });

    const emptyTextDoc = '前 [](u) 后\n\n普通段落\n';
    await open(emptyTextDoc);
    expect(await page.locator('#rich-root a').count()).toBe(0);
    await caret('普通段落', 4);
    await page.keyboard.insertText('改');
    await settle();
    expect(await markdown()).toBe(emptyTextDoc.replace('普通段落', '普通段落改'));
  }, 30000);

  it('creates zero ProseMirror link marks when loading rich documents', async () => {
    await open('[文](https://a.com "t") <https://b.com> https://c.com www.d.com e@f.com [![i](p.png)](u)\n');
    const markCount = await page.evaluate(() => {
      let count = 0;
      (window as any).fileApp.surface.richView().state.doc.descendants((node: any) => {
        if (node.marks?.some((m: any) => m.type.name === 'link')) count++;
      });
      return count;
    });
    expect(markCount).toBe(0);
  }, 30000);

  it('hides brackets/tail outside caret, expands with marker/url/title classes inside, and keeps clean state', async () => {
    const sample = '前 [文字](https://example.com "链接标题") 后\n\n普通段落\n';
    await open(sample);
    await caret('普通段落');
    await settle();

    const collapsed = await page.evaluate(() => {
      const p = document.querySelector('#rich-root p') as HTMLElement;
      const a = p.querySelector('a') as HTMLAnchorElement | null;
      return {
        text: p.innerText,
        link: a && { text: a.textContent, href: a.getAttribute('href'), title: a.getAttribute('title'), className: a.className },
        shown: p.querySelectorAll('.md-marker:not(.md-hidden)').length,
        hidden: [...p.querySelectorAll('.md-marker.md-hidden')].map(n => n.textContent),
      };
    });
    expect(collapsed.text).toBe('前 文字 后');
    expect(collapsed.link).toEqual({ text: '文字', href: 'https://example.com', title: '链接标题', className: 'md-link' });
    expect(collapsed.shown).toBe(0);
    expect(collapsed.hidden).toEqual(['[', '](https://example.com "链接标题")']);

    const point = await page.evaluate(() => {
      const rect = document.querySelector('#rich-root p a')!.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    await settle();

    const expanded = await page.evaluate(() => {
      const p = document.querySelector('#rich-root p') as HTMLElement;
      const markers = [...p.querySelectorAll('.md-marker:not(.md-hidden)')].map(n => n.textContent);
      const url = p.querySelector('.md-link-url') as HTMLElement | null;
      const title = p.querySelector('.md-link-title') as HTMLElement | null;
      const gap = url?.nextSibling;
      return {
        text: p.innerText,
        markers,
        url: url && { text: url.textContent, decoration: getComputedStyle(url).textDecorationLine, color: getComputedStyle(url).color },
        title: title && { text: title.textContent, style: getComputedStyle(title).fontStyle },
        gapIsPlainText: gap?.nodeType === Node.TEXT_NODE && gap.textContent === ' ',
        accentColor: getComputedStyle(document.querySelector('#rich-root p a')!).color,
      };
    });
    expect(expanded.text).toBe('前 [文字](https://example.com "链接标题") 后');
    expect(expanded.markers).toEqual(['[', '](', ')']);
    expect(expanded.url?.text).toBe('https://example.com');
    expect(expanded.url?.decoration).toBe('underline');
    expect(expanded.url?.color).toBe(expanded.accentColor);
    expect(expanded.title).toEqual({ text: '"链接标题"', style: 'italic' });
    expect(expanded.gapIsPlainText).toBe(true);

    await caret('普通段落');
    await settle();
    expect(await page.locator('#rich-root p .md-marker:not(.md-hidden)').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fileApp.session.dirty)).toBe(false);
    expect(await markdown()).toBe(sample);
  }, 30000);

  it('displays angle-bracket autolinks with < > on enter and bare autolinks without hidden markers', async () => {
    await open('尖 <https://angle.com> 与裸 https://bare.com 和 www.site.com\n\n尾\n');
    await caret('尾');
    await settle();
    expect(await page.locator('#rich-root p a').allTextContents()).toEqual(['https://angle.com', 'https://bare.com', 'www.site.com']);
    expect(await page.locator('#rich-root p .md-marker:not(.md-hidden)').count()).toBe(0);
    expect((await look()).text).toBe('尾');

    await caret('angle.com', 2);
    await settle();
    expect(await page.locator('#rich-root p .md-marker:not(.md-hidden)').allTextContents()).toEqual(['<', '>']);

    await caret('bare.com', 2);
    await settle();
    expect(await page.locator('#rich-root p .md-marker').count()).toBe(2); // only < > from the angle link
  }, 30000);

  it('walks arrows step by step into url/markers and does not skip at 0ms or 30ms gaps', async () => {
    await open('前 [文字](https://a.com) 后\n');
    await caret('文字', 2);
    await settle();

    // Rightward from end of link text through `](https://a.com)`
    const tail = '](https://a.com)';
    for (let i = 0; i < tail.length; i++) {
      await press('ArrowRight');
      const now = await look();
      const expectedBefore = '前 [文字' + tail.slice(0, i + 1) + '|' + tail.slice(i + 1) + ' 后';
      expect(now.caret, `right step ${i}`).toBe(expectedBefore);
    }

    // Leftward from right side at both 0ms and 30ms key intervals
    for (const gap of [0, 30]) {
      const expected = ['前 [文字](https://a.com)| 后', '前 [文字](https://a.com|) 后'];
      for (let count = 1; count <= expected.length; count++) {
        await caret(' 后', 1);
        await settle();
        for (let i = 0; i < count; i++) {
          await page.keyboard.down('ArrowLeft');
          await page.keyboard.up('ArrowLeft');
          if (gap) await page.waitForTimeout(gap);
        }
        await page.waitForTimeout(150);
        await settle();
        expect((await look()).caret, `gap=${gap} count=${count}`).toBe(expected[count - 1]);
      }
    }
  }, 30000);

  it('updates href live while editing URL and restores expanded URL on Ctrl+Z', async () => {
    await open('前 [文字](https://a.com) 后\n');
    await caret('a.com', 5);
    await settle();
    await page.keyboard.insertText('/sub');
    await settle();
    expect(await markdown()).toBe('前 [文字](https://a.com/sub) 后\n');
    expect(await page.locator('#rich-root p a').getAttribute('href')).toBe('https://a.com/sub');

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => (window as any).fileApp.surface.getMarkdown() === '前 [文字](https://a.com) 后\n');
    await settle();
    expect(await page.locator('#rich-root p a').getAttribute('href')).toBe('https://a.com');
    expect(await page.locator('#rich-root p .md-link-url').textContent()).toBe('https://a.com');
  }, 30000);

  it('turns back into plain text when deleting ) and restores link on Ctrl+Z', async () => {
    await open('前 [文字](地址) 后\n');
    await caret(' 后', 0);
    await settle();
    await page.keyboard.press('Backspace');
    await settle();
    expect(await markdown()).toBe('前 [文字](地址 后\n');
    expect(await page.locator('#rich-root p a').count()).toBe(0);

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => (window as any).fileApp.surface.getMarkdown() === '前 [文字](地址) 后\n');
    await settle();
    expect(await page.locator('#rich-root p a').getAttribute('href')).toBe('地址');
  }, 30000);

  it.each([
    ['inside link text', '文字', 1, '前 [文中文字](https://a.com) 后', '文中文字'],
    ['right after opening [', '文字', 0, '前 [中文文字](https://a.com) 后', '中文文字'],
    ['inside URL', 'a.com', 2, '前 [文字](https://a.中文com) 后', '文字'],
  ] as const)('composes via IME %s without extra nodes or broken undo', async (_name, anchor, offset, expected, expectedText) => {
    const sample = '前 [文字](https://a.com) 后\n';
    await open(sample);
    await caret(anchor, offset);
    await settle();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await settle();
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
    await settle();
    const during = await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      return { composing: view.composing, text: view.state.selection.$head.parent.textContent };
    });
    expect(during.composing).toBe(true);
    expect(during.text).toBe(expected.replace('中文', 'zhongwen'));

    await cdp.send('Input.insertText', { text: '中文' });
    await page.waitForFunction(expected => (window as any).fileApp.surface.getMarkdown().startsWith(expected), expected);
    await page.waitForFunction(() => !(window as any).fileApp.surface.richView().composing);
    await settle();
    expect(await page.locator('#rich-root p a').textContent()).toBe(expectedText);

    await page.keyboard.press('Control+z');
    await page.waitForFunction(sample => (window as any).fileApp.surface.getMarkdown() === sample, sample);
  }, 30000);

  it('splits inline links cleanly on Enter while leaving autolinks unsplit-wrapped', async () => {
    await open('[前后](u "t")\n');
    await caret('前后', 1);
    await page.keyboard.press('Enter');
    await settle();
    expect(await markdown()).toBe('[前](u "t")\n\n[后](u "t")\n');

    await open('<https://example.com>\n');
    await caret('example.com', 4);
    await page.keyboard.press('Enter');
    await settle();
    expect(await markdown()).toBe('<https://exam\n\nple.com>\n');
  }, 30000);

  it('omits href attribute for javascript:/vbscript:/data: links', async () => {
    await open('[js](javascript:alert(1)) [vbs](vbscript:x) [d](data:text/html,hi)\n');
    const attrs = await page.evaluate(() => [...document.querySelectorAll('#rich-root a')].map(a => ({
      text: a.textContent,
      hasHref: a.hasAttribute('href'),
      dataHref: a.getAttribute('data-href'),
    })));
    expect(attrs).toEqual([
      { text: 'js', hasHref: false, dataHref: 'javascript:alert(1)' },
      { text: 'vbs', hasHref: false, dataHref: 'vbscript:x' },
      { text: 'd', hasHref: false, dataHref: 'data:text/html,hi' },
    ]);
  }, 30000);

  it('handles Ctrl+K / Format->Link across all selection states and skips during IME', async () => {
    // Selection inside normal text -> [selected]() with caret inside ()
    await open('选 我 吧\n');
    await caret('我', 0, 1);
    await page.keyboard.press('Control+k');
    await settle();
    expect(await markdown()).toBe('选 [我]() 吧\n');
    expect((await look()).caret).toBe('选 [我](|) 吧');

    // Empty selection -> []() with caret inside []
    await open('前后\n');
    await caret('后', 0);
    await page.keyboard.press('Control+k');
    await settle();
    expect(await markdown()).toBe('前[]()后\n');
    expect((await look()).caret).toBe('前[|]()后');

    // Empty-text link with Ctrl+K: double Ctrl+K moves from [|]() into [](|); Ctrl+K inside [](u) selects 'u' and renders no decorations
    await open('x\n');
    await caret('x', 1);
    await page.keyboard.press('Control+k');
    await settle();
    expect(await markdown()).toBe('x[]()\n');
    expect((await look()).caret).toBe('x[|]()');
    await page.keyboard.press('Control+k');
    await settle();
    expect(await markdown()).toBe('x[]()\n');
    expect((await look()).caret).toBe('x[](|)');
    expect(await page.locator('#rich-root a').count()).toBe(0);
    expect(await page.locator('#rich-root .md-marker').count()).toBe(0);

    await open('[](u)\n\n尾\n');
    await caret('[](u)', 1);
    await page.keyboard.press('Control+k');
    await settle();
    expect(await markdown()).toBe('[](u)\n\n尾\n');
    const emptyLinkUrlSel = await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const s = view.state.selection;
      return view.state.doc.textBetween(s.from, s.to);
    });
    expect(emptyLinkUrlSel).toBe('u');
    expect(await page.locator('#rich-root a').count()).toBe(0);
    expect(await page.locator('#rich-root .md-marker').count()).toBe(0);

    // Selection inside existing inline link -> selects URL; empty URL puts caret inside ()
    await open('[文字](https://a.com "t") 与 [空]()\n');
    await caret('文字', 1);
    await page.keyboard.press('Control+k');
    await settle();
    const urlSel = await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const s = view.state.selection;
      return view.state.doc.textBetween(s.from, s.to);
    });
    expect(urlSel).toBe('https://a.com');
    await caret('空', 1);
    await page.keyboard.press('Control+k');
    await settle();
    expect((await look()).caret).toBe('[文字](https://a.com "t") 与 [空](|)');

    // Selection inside code / autolink / multi-block / enclosing a link -> no-op
    await open('`代码` 与 <https://a.com> 和 https://b.com\n\n下一段\n\n前 [旧](https://old.example) 后\n\n包 <https://a.com> 尾\n\n包 https://b.com 和 www.c.com 尾\n');
    for (const [text, offset, len] of [['代码', 1, 1], ['a.com', 2, 0], ['b.com', 2, 0]] as const) {
      await caret(text, offset, len);
      await page.keyboard.press('Control+k');
      await settle();
    }
    for (const line of ['前 ', '包 https://a.com', '包 https://b.com']) {
      await page.evaluate(prefix => {
        const view = (window as any).fileApp.surface.richView();
        const SelBase = Object.getPrototypeOf(view.state.selection.constructor);
        const TextSel = SelBase.near(view.state.doc.resolve(1)).constructor;
        let found: { from: number; to: number } | null = null;
        view.state.doc.descendants((node: any, pos: number) => {
          if (!found && node.isTextblock && node.textContent.startsWith(prefix)) {
            found = { from: pos + 1, to: pos + 1 + node.content.size };
          }
        });
        view.dispatch(view.state.tr.setSelection(TextSel.create(view.state.doc, found!.from, found!.to)));
        view.focus();
      }, line === '包 https://a.com' ? '包 <https://a.com>' : line);
      await page.keyboard.press('Control+k');
      await settle();
    }
    await page.evaluate(() => {
      const view = (window as any).fileApp.surface.richView();
      const SelBase = Object.getPrototypeOf(view.state.selection.constructor);
      const TextSel = SelBase.near(view.state.doc.resolve(1)).constructor;
      view.dispatch(view.state.tr.setSelection(TextSel.create(view.state.doc, 2, view.state.doc.content.size - 2)));
      view.focus();
    });
    await page.keyboard.press('Control+k');
    await settle();
    expect(await markdown()).toBe('`代码` 与 <https://a.com> 和 https://b.com\n\n下一段\n\n前 [旧](https://old.example) 后\n\n包 <https://a.com> 尾\n\n包 https://b.com 和 www.c.com 尾\n');

    // IME composing ignores Ctrl+K
    await open('甲乙丙\n');
    await caret('乙', 0, 1);
    const prevented = await page.evaluate(() => {
      document.activeElement!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    expect(await markdown()).toBe('甲乙丙\n');
  }, 30000);

  it('inserts []() after blurred croquill_raw_block when format("link") runs', async () => {
    await open('前段\n\n<div>\n原文块\n</div>\n\n后段\n');
    await focusApp(page, 'raw');
    await page.evaluate(() => { (window as any).fileApp.surface.format('link'); });
    await settle();
    const result = await markdown();
    const markerEnd = result.indexOf('</div>') + '</div>'.length;
    const linkPos = result.indexOf('[]()');
    const tailPos = result.indexOf('后段');
    expect(linkPos).toBeGreaterThan(markerEnd);
    expect(tailPos).toBeGreaterThan(linkPos);
  }, 30000);

  it('dissolves pasted HTML links to Markdown source, persists, and reloads cleanly', async () => {
    await open('起点，\n');
    await caret('起点，', 3);
    const pasteHtml = (html: string) => page.evaluate(html => {
      const target = document.querySelector('#rich-root .ProseMirror')!;
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', 'paste');
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, html);

    await pasteHtml('<p><a href="https://a.com" title="标">文<b>粗</b></a></p>');
    await settle();
    expect(await markdown()).toBe('起点，[文**粗**](https://a.com "标")\n');
    const marksLeft = await page.evaluate(() => {
      let n = 0;
      (window as any).fileApp.surface.richView().state.doc.descendants((node: any) => {
        if (node.marks?.some((m: any) => m.type.name === 'link')) n++;
      });
      return n;
    });
    expect(marksLeft).toBe(0);

    await open('甲，\n'); await caret('甲，', 2);
    await pasteHtml('<p><a href="https://a.com/a b">空格</a></p>');
    await settle();
    expect(await markdown()).toBe('甲，[空格](<https://a.com/a b>)\n');

    await open('乙，\n'); await caret('乙，', 2);
    await pasteHtml('<p><a href="https://same.com">https://same.com</a></p>');
    await settle();
    expect(await markdown()).toBe('乙，<https://same.com>\n');

    await open('丙，\n'); await caret('丙，', 2);
    await pasteHtml('<p><a href="https://u.com">x[y]z[w</a></p>');
    await settle();
    expect(await markdown()).toBe('丙，[x[y]z\\[w](https://u.com)\n');

    // Save and reopen
    await page.evaluate(async () => { const h = (window as any).fileApp; h.session.edit(h.surface.getMarkdown()); await h.session.save(); });
    const saved = await page.evaluate(() => (window as any).fileApp.writes.at(-1).text);
    expect(saved).toBe('丙，[x[y]z\\[w](https://u.com)\n');
    await open(saved);
    expect(await page.evaluate(() => (document.querySelector('#rich-root p') as HTMLElement).innerText)).toBe('丙，x[y]z[w');
    expect(await page.evaluate(() => [...document.querySelectorAll('#rich-root a')].map(a => a.getAttribute('href')))).toEqual(['https://u.com', 'https://u.com', 'https://u.com']);

    // Entities, quotes, and \* / \( inside pasted href & title must survive Markdown roundtrip verbatim
    for (const tc of [
      { html: '<p><a href="https://example.com/?q=&amp;copy;">文字</a></p>', expectedHref: 'https://example.com/?q=&copy;', expectedTitle: null },
      { html: '<p><a href="u" title="t&amp;amp; &quot;q&quot;">a</a></p>', expectedHref: 'u', expectedTitle: 't&amp; "q"' },
      { html: '<p><a href="https://example.com/a\\*b\\(c">特符</a></p>', expectedHref: 'https://example.com/a\\*b\\(c', expectedTitle: null },
      { html: '<p><a href="https://example.com/a\\*b\\(c\\)">平衡</a></p>', expectedHref: 'https://example.com/a\\*b\\(c\\)', expectedTitle: null },
    ]) {
      await open('试：\n'); await caret('试：', 2);
      await pasteHtml(tc.html);
      await settle();
      const live = await page.evaluate(() => {
        const a = document.querySelector('#rich-root a');
        return a ? { href: a.getAttribute('href'), title: a.getAttribute('title') } : null;
      });
      expect(live).toEqual({ href: tc.expectedHref, title: tc.expectedTitle });
      await page.evaluate(async () => { const h = (window as any).fileApp; h.session.edit(h.surface.getMarkdown()); await h.session.save(); });
      const savedCase = await page.evaluate(() => (window as any).fileApp.writes.at(-1).text);
      await open(savedCase);
      const reloaded = await page.evaluate(() => {
        const a = document.querySelector('#rich-root a');
        return a ? { href: a.getAttribute('href'), title: a.getAttribute('title') } : null;
      });
      expect(reloaded).toEqual({ href: tc.expectedHref, title: tc.expectedTitle });
    }

    // Backslashes in pasted link text (trailing \, \], \[, double \\) keep link valid and literal visible text
    for (const tc of [
      { html: '<p><a href="https://e.com">目录\\</a></p>', expectedText: '目录\\' },
      { html: '<p><a href="https://e.com">a\\]b</a></p>', expectedText: 'a\\]b' },
      { html: '<p><a href="https://e.com">a\\[b</a></p>', expectedText: 'a\\[b' },
      { html: '<p><a href="https://e.com">a\\\\</a></p>', expectedText: 'a\\\\' },
    ]) {
      await open('试：\n\n另\n'); await caret('试：', 2);
      await pasteHtml(tc.html);
      await caret('另');
      await settle();
      const checkLink = () => page.evaluate(() => {
        const p = document.querySelector('#rich-root p') as HTMLElement;
        const hrefs = [...new Set([...p.querySelectorAll('a')].map(a => a.getAttribute('href')))];
        const bareText = [...p.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
        const view = (window as any).fileApp.surface.richView();
        const block = view.state.doc.firstChild!;
        const marks = (() => { let n = 0; block.descendants((c: any) => { if (c.marks?.some((m: any) => m.type.name === 'link')) n++; }); return n; })();
        return { marks, hrefs, bareText, text: p.innerText };
      });
      expect(await checkLink()).toEqual({ marks: 0, hrefs: ['https://e.com'], bareText: '试：', text: `试：${tc.expectedText}` });
      await page.evaluate(async () => { const h = (window as any).fileApp; h.session.edit(h.surface.getMarkdown()); await h.session.save(); });
      const savedCase = await page.evaluate(() => (window as any).fileApp.writes.at(-1).text);
      await open(savedCase);
      await caret('另');
      await settle();
      expect(await checkLink()).toEqual({ marks: 0, hrefs: ['https://e.com'], bareText: '试：', text: `试：${tc.expectedText}` });
    }
  }, 30000);

  it('shows hint once on normal click, opens on Ctrl+Click anywhere on link/URL without moving caret, and blocks navigation', async () => {
    const sample = '普通字 与 [链文](https://example.com) 和 [相对](other.md)\n\n尾\n';
    await open(sample);
    await caret('尾');
    await settle();

    const ctrlClick = async (x: number, y: number) => {
      await page.keyboard.down('Control');
      await page.mouse.click(x, y);
      await page.keyboard.up('Control');
    };

    // 1. Normal left click -> expands, shows hint once, does not invoke open_external_link or navigate
    const initialUrl = page.url();
    const linkBox = await page.locator('#rich-root a').first().boundingBox();
    await page.mouse.click(linkBox!.x + linkBox!.width / 2, linkBox!.y + linkBox!.height / 2);
    await settle();
    expect(await page.locator('#toast').textContent()).toBe('按 Ctrl + 点击以打开此链接');
    expect(await page.locator('#toast').isHidden()).toBe(false);
    expect(await page.evaluate(() => (window as any).fileApp.calls.filter((c: any) => c.cmd === 'open_external_link').length)).toBe(0);
    expect(page.url()).toBe(initialUrl);

    // Clear toast state visually to verify second normal click does NOT show hint again
    await page.evaluate(() => { const t = document.getElementById('toast')!; t.hidden = true; t.textContent = ''; });
    const secondBox = await page.locator('#rich-root a').nth(1).boundingBox();
    await page.mouse.click(secondBox!.x + secondBox!.width / 2, secondBox!.y + secondBox!.height / 2);
    await settle();
    expect(await page.locator('#toast').textContent()).toBe('');
    expect(await page.locator('#toast').isHidden()).toBe(true);

    // 2. Move caret away to 尾, then Ctrl+Click collapsed link text -> no expand, caret stays in 尾, calls open_external_link
    await caret('尾', 1);
    await settle();
    const caretBeforeCollapsed = await look();
    const collapsedBox = await page.locator('#rich-root a').first().boundingBox();
    await ctrlClick(collapsedBox!.x + collapsedBox!.width / 2, collapsedBox!.y + collapsedBox!.height / 2);
    await settle();
    expect(await look()).toEqual(caretBeforeCollapsed);
    expect(await page.locator('#rich-root p .md-marker:not(.md-hidden)').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fileApp.calls.filter((c: any) => c.cmd === 'open_external_link').map((c: any) => c.args))).toEqual([
      { url: 'https://example.com' },
    ]);

    // 3. Expand link with caret in 链文, Ctrl+Click expanded .md-link-url -> caret stays in 链文, calls open_external_link
    await caret('链文', 1);
    await settle();
    const caretBeforeUrl = await look();
    const urlBox = await page.locator('#rich-root .md-link-url').boundingBox();
    await ctrlClick(urlBox!.x + urlBox!.width / 2, urlBox!.y + urlBox!.height / 2);
    await settle();
    expect(await look()).toEqual(caretBeforeUrl);
    expect(await page.evaluate(() => (window as any).fileApp.calls.filter((c: any) => c.cmd === 'open_external_link').length)).toBe(2);

    // 4. Ctrl+Click missing relative file -> toast, does NOT call open_external_link
    const relBox = await page.locator('#rich-root a').nth(1).boundingBox();
    await ctrlClick(relBox!.x + relBox!.width / 2, relBox!.y + relBox!.height / 2);
    await settle();
    expect(await page.locator('#toast').textContent()).toBe('找不到文件：other.md');
    expect(await page.evaluate(() => (window as any).fileApp.calls.filter((c: any) => c.cmd === 'open_external_link').length)).toBe(2);

    // 5. Ctrl+Click plain text -> does NOT call open_external_link
    const plainPos = await page.evaluate(() => {
      const p = document.querySelector('#rich-root p')!;
      const range = document.createRange();
      range.setStart(p.firstChild!, 0); range.setEnd(p.firstChild!, 2);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await ctrlClick(plainPos.x, plainPos.y);
    await settle();
    expect(await page.evaluate(() => (window as any).fileApp.calls.filter((c: any) => c.cmd === 'open_external_link').length)).toBe(2);

    // 6. Middle click (auxclick) on <a> does not navigate
    await caret('尾', 1);
    await settle();
    const linkAgain = await page.locator('#rich-root a').first().boundingBox();
    await page.mouse.click(linkAgain!.x + linkAgain!.width / 2, linkAgain!.y + linkAgain!.height / 2, { button: 'middle' });
    await settle();
    expect(page.url()).toBe(initialUrl);
  }, 30000);

  it('shows only visible link text in [TOC], sidebar outline, and footnote tooltip', async () => {
    await open('[TOC]\n\n## [链接标题](https://a.com "t") 与 <https://b.com> 和 www.c.com\n\n注[^1]\n\n[^1]: 参考 [脚注链接](https://f.com)\n\n尾\n');
    await caret('尾');
    await settle();
    expect(await page.locator('[data-croquill-toc] button').allTextContents()).toEqual(['链接标题 与 https://b.com 和 www.c.com']);
    await page.evaluate(() => { const h = (window as any).fileApp; h.updateStats(); h.setSidebarTab('outline'); });
    expect(await page.locator('#outline button').allTextContents()).toEqual(['链接标题 与 https://b.com 和 www.c.com']);
    await page.locator('[data-footnote-reference]').focus();
    await settle();
    expect(await page.locator('[data-footnote-tooltip]').textContent()).toBe('参考 脚注链接');
  }, 30000);

  it('finds hidden URL strings with marker reveal, replaces cleanly, and undoes in one step', async () => {
    const sample = '前 [文字](https://old.example.com/path) 后\n\n普通段落\n';
    await open(sample);
    await caret('普通段落');
    await settle();
    expect(await page.locator('#rich-root').evaluate(el => el.classList.contains('md-reveal-markers'))).toBe(false);

    await page.keyboard.press('Control+h');
    await page.getByRole('textbox', { name: '查找内容', exact: true }).fill('old.example.com');
    await settle();
    expect(await page.locator('[data-search-count]').textContent()).toBe('1 / 1');
    expect(await page.locator('#rich-root').evaluate(el => el.classList.contains('md-reveal-markers'))).toBe(true);

    await page.getByRole('textbox', { name: '替换为', exact: true }).fill('new.org');
    await page.locator('[data-search-command="replace"]').click();
    await settle();
    expect(await markdown()).toBe('前 [文字](https://new.org/path) 后\n\n普通段落\n');
    expect(await page.locator('#rich-root p a').getAttribute('href')).toBe('https://new.org/path');

    await page.keyboard.press('Control+z');
    await page.waitForFunction(sample => (window as any).fileApp.surface.getMarkdown() === sample, sample);
    expect(await page.locator('#rich-root p a').getAttribute('href')).toBe('https://old.example.com/path');
  }, 30000);

  it('roundtrips links unchanged across rich -> source -> rich mode switches', async () => {
    const sample = '前 [文 **字**](https://a.com "t") 与 <https://b.com> 和 www.c.com\n';
    await open(sample);
    await page.evaluate(async () => {
      const s = (window as any).fileApp.surface;
      await s.setMode('source');
      await s.setMode('rich');
    });
    expect(await markdown()).toBe(sample);
    expect(await page.evaluate(() => (document.querySelector('#rich-root p') as HTMLElement).innerText)).toBe('前 文 字 与 https://b.com 和 www.c.com');
    expect(await page.evaluate(() => [...new Set([...document.querySelectorAll('#rich-root p a')].map(el => el.getAttribute('href')))])).toEqual(['https://a.com', 'https://b.com', 'http://www.c.com']);
    expect(await page.locator('#rich-root p a strong').evaluate(el => (el as HTMLElement).innerText)).toBe('字');
  }, 30000);

  it('keeps CJK-adjacent bare www autolinks raw and decorated after editing elsewhere', async () => {
    const sample = '裸网址：https://example.com/path 、www.example.com 与 me@example.org 。\n\n第二段\n';
    await open(sample);
    await caret('第二段', 3);
    await page.keyboard.type('！');
    await settle();
    expect(await markdown()).toBe('裸网址：https://example.com/path 、www.example.com 与 me@example.org 。\n\n第二段！\n');
    expect(await page.locator('#rich-root p a').evaluateAll(els => els.map(el => [el.textContent, el.getAttribute('href')]))).toEqual([
      ['https://example.com/path', 'https://example.com/path'],
      ['www.example.com', 'http://www.example.com'],
      ['me@example.org', 'mailto:me@example.org'],
    ]);
  }, 30000);

  it('preserves positionless GFM www splits byte-for-byte across all containers and positions', async () => {
    const lines = [
      '、www.x.com',
      '',
      'a_b、www.x.com',
      '',
      '见、www.x.com 与 &amp;',
      '',
      'a\\_b、www.x.com 尾\\*巴 &copy;',
      '',
      '首a_b、www.x.com *斜*',
      '',
      '*斜*、www.x.com 尾 &amp;',
      '',
      '# a_b、www.h.com 与 &amp;',
      '',
      '## a_b、www.h.com *斜*',
      '',
      '## *斜*、www.h.com &amp;',
      '',
      '| 栏                   | 栏2                  |',
      '| ------------------- | ------------------- |',
      '| a_b、www.t.com &amp; | *e*、www.t.com &amp; |',
      '',
      '- a_b、www.l.com &amp;',
      '',
      '- *斜*、www.l.com &amp;',
      '',
      '> a_b、www.q.com &amp;',
      '',
      '> a_b、www.q.com *斜*',
      '',
      '*斜、www.e.com &amp;* 与 **粗、www.e.com &amp;** 及 ~~删、www.e.com &amp;~~',
      '',
      '行一 &amp;\n行二、www.s.com a_b',
      '',
      '普通段',
      '',
    ];
    const source = lines.join('\n');
    await open(source);
    // Verify *斜、www.e.com &amp;* etc. also keep their inline formatting & entity decorations visually!
    expect(await page.evaluate(() => {
      const p = [...document.querySelectorAll('#rich-root p')].find(el => el.textContent?.includes('www.e.com'))!;
      return {
        text: (p as HTMLElement).innerText,
        linkFormats: [
          p.querySelector('em a')?.textContent,
          p.querySelector('strong a')?.textContent,
          p.querySelector('del a')?.textContent,
        ],
        hrefs: [...p.querySelectorAll('a')].map(a => a.getAttribute('href')),
      };
    })).toEqual({
      text: '斜、www.e.com & 与 粗、www.e.com & 及 删、www.e.com &',
      linkFormats: ['www.e.com', 'www.e.com', 'www.e.com'],
      hrefs: ['http://www.e.com', 'http://www.e.com', 'http://www.e.com'],
    });
    await caret('普通段', 3);
    await page.keyboard.insertText('改');
    await settle();
    expect(await markdown()).toBe(source.replace('普通段', '普通段改'));

    // Closing ATX # and Setext headings also preserve escapes/entities around bare www. without leaking markers
    await open('## a_b、www.h.com *斜* ##\n\n## *斜*、www.h.com &amp; ##\n\na_b、www.h2.com &amp;\n===\n\n尾\n');
    await caret('尾', 1);
    await page.keyboard.insertText('改');
    await settle();
    expect(await markdown()).toBe('## a_b、www.h.com *斜* ##\n\n## *斜*、www.h.com &amp; ##\n\na_b、www.h2.com &amp;\n===\n\n尾改\n');
  }, 30000);
});
