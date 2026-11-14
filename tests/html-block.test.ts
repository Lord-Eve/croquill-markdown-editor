import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, openFileApp } from './app-files-fixture';

describe('block HTML rendering and inline editing in the rich editor', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;

  beforeAll(async () => {
    server = await createTestServer();
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
    const warm = await browser.newPage();
    await warm.goto(baseURL + '/tests/harness.html');
    await warm.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: () => {}, onDirty: () => {}, resolveImage: async src => src });
      surface.init('<div align="center">预热</div>\\n').then(() => surface.destroy()).then(() => { window.warmed = 'ok'; }, error => { window.warmed = String(error); });
    ` });
    await warm.waitForFunction(() => 'warmed' in window, undefined, { timeout: 50000 });
    expect(await warm.evaluate(() => (window as any).warmed)).toBe('ok');
    await warm.close();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.goto(baseURL + '/tests/harness.html');
    await page.addStyleTag({ url: baseURL + '/src/style.css' });
    await page.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      import { DocumentSession } from '/src/session.ts';
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const h = window.htmlHarness = {
        richRoot,
        sourceRoot,
        saved: '',
        changes: [],
        dirty: 0,
        resolveCalls: [],
        resolver: async src => src,
      };
      let nextText = '';
      h.session = new DocumentSession({
        openPath: async () => 'D:/notes/html-block.md',
        savePath: async current => current || 'D:/notes/html-block.md',
        read: async path => ({
          path,
          text: nextText,
          bom: nextText.startsWith('\\uFEFF'),
          newline: nextText.includes('\\r\\n') ? 'crlf' : 'lf',
          revision: 'rev-1',
        }),
        write: async (_path, text) => { h.saved = text; return { revision: 'test' }; },
        confirmSave: async () => 'discard',
      });
      h.surface = new MarkdownSurface({
        richRoot,
        sourceRoot,
        onChange: text => { h.changes.push(text); h.session.edit(text); },
        onDirty: () => { h.dirty++; h.session.markPending(); },
        resolveImage: async src => {
          h.resolveCalls.push(src);
          return h.resolver(src);
        },
      });
      h.loadDoc = async text => {
        nextText = text;
        h.saved = '';
        h.changes = [];
        h.dirty = 0;
        h.resolveCalls = [];
        await h.session.open('D:/notes/html-block.md');
        await h.surface.init(text);
      };
      h.save = async () => {
        h.session.edit(h.surface.getMarkdown());
        await h.session.save();
        return h.saved;
      };
    ` });
    await page.waitForFunction(() => 'htmlHarness' in window);
  });

  afterEach(async () => {
    await page?.evaluate(async () => {
      await (window as any).htmlHarness?.surface.destroy();
      await (window as any).fileApp?.surface.destroy();
    });
    await page?.close();
  });

  const open = async (source: string) => {
    await page.evaluate(async text => {
      await (window as any).htmlHarness.loadDoc(text);
    }, source);
  };

  it('1. renders centered HTML blocks instead of literal angle brackets', async () => {
    await open('<div align="center">文字</div>\n');
    const info = await page.evaluate(() => {
      const block = document.querySelector('#rich-root, .ProseMirror')?.closest('body')?.querySelector('[data-croquill-raw][data-croquill-html]');
      const preview = block?.querySelector('.croquill-html-preview');
      const div = preview?.querySelector('div[align="center"]') as HTMLElement | null;
      return {
        exists: !!block && !!preview && !!div,
        text: preview?.textContent ?? '',
        alignAttr: div?.getAttribute('align') ?? '',
        textAlign: div ? getComputedStyle(div).textAlign : '',
        preCount: document.querySelectorAll('pre[data-croquill-raw]').length,
      };
    });
    expect(info.exists).toBe(true);
    expect(info.text).toBe('文字');
    expect(info.text).not.toContain('<');
    expect(info.alignAttr).toBe('center');
    expect(info.textAlign).toContain('center');
    expect(info.preCount).toBe(0);
  });

  it('2. toggles <details> when clicking <summary> without entering edit mode or losing state on Escape', async () => {
    await open('<details><summary>标题</summary>内容</details>\n');
    const summary = page.locator('.croquill-html-preview summary');
    await summary.click();
    const afterFirst = await page.evaluate(() => {
      const details = document.querySelector('.croquill-html-preview details') as HTMLDetailsElement;
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return { open: details.open, hidden: textarea.hidden, dirty: (window as any).htmlHarness.dirty };
    });
    expect(afterFirst).toEqual({ open: true, hidden: true, dirty: 0 });

    await summary.click();
    const afterSecond = await page.evaluate(() => {
      const details = document.querySelector('.croquill-html-preview details') as HTMLDetailsElement;
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return { open: details.open, hidden: textarea.hidden, dirty: (window as any).htmlHarness.dirty };
    });
    expect(afterSecond).toEqual({ open: false, hidden: true, dirty: 0 });

    // Also verify in the real app chrome (main.ts) that document <details> survives Escape and menubar interaction.
    await page.evaluate(async () => { await (window as any).htmlHarness?.surface.destroy(); });
    await openFileApp(page, baseURL, { files: { [currentFile]: '<details><summary>折叠头</summary>正文内容</details>\n' } });
    await page.locator('.croquill-html-preview summary').click();
    await page.keyboard.press('Escape');
    await page.locator('.menubar summary').first().click();
    expect(await page.evaluate(() => (document.querySelector('.croquill-html-preview details') as HTMLDetailsElement).open)).toBe(true);
  }, 30000);

  it('3. keeps mixed-category protected blocks as literal <pre data-croquill-raw>', async () => {
    await open('<div>\n\n[[双链]]\n\n</div>\n');
    const info = await page.evaluate(() => {
      const rawPre = document.querySelector('pre[data-croquill-raw]');
      return {
        preCount: document.querySelectorAll('pre[data-croquill-raw]').length,
        htmlBlockCount: document.querySelectorAll('[data-croquill-html]').length,
        text: rawPre?.textContent ?? '',
      };
    });
    expect(info.preCount).toBe(1);
    expect(info.htmlBlockCount).toBe(0);
    expect(info.text).toContain('[[双链]]');
  });

  it('4. resolves relative <img> paths without app-origin fetches and tolerates resolveImage rejection', async () => {
    const requestedUrls: string[] = [];
    const pageErrors: string[] = [];
    page.on('request', req => requestedUrls.push(req.url()));
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.evaluate(() => {
      (window as any).htmlHarness.resolver = async (src: string) =>
        src === 'a.png'
          ? 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
          : Promise.reject(new Error('missing file'));
    });

    const dataUri = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    await open(
      `<div>\n<img src="a.png" alt="局部图">\n<img src="https://example.com/remote.png" alt="远程图">\n<img src="${dataUri}" alt="内联图">\n<img src="missing.png" alt="缺图文字">\n</div>\n`,
    );

    await page.waitForFunction(() => {
      const localImg = document.querySelector('.croquill-html-preview img[alt="局部图"]');
      return localImg?.getAttribute('src')?.startsWith('data:image/gif');
    });
    // Allow microtasks from rejected resolveImage to settle.
    await page.evaluate(() => new Promise(r => setTimeout(r, 20)));

    const state = await page.evaluate(() => {
      const preview = document.querySelector('.croquill-html-preview')!;
      const local = preview.querySelector('img[alt="局部图"]');
      const remote = preview.querySelector('img[alt="远程图"]');
      const inline = preview.querySelector('img[alt="内联图"]');
      const missing = preview.querySelector('img[alt="缺图文字"]');
      return {
        resolveCalls: (window as any).htmlHarness.resolveCalls,
        localSrc: local?.getAttribute('src') ?? null,
        remoteSrc: remote?.getAttribute('src') ?? null,
        inlineSrc: inline?.getAttribute('src') ?? null,
        missingHasSrc: missing?.hasAttribute('src') ?? true,
        missingAlt: missing?.getAttribute('alt') ?? null,
      };
    });

    expect(state.resolveCalls).toEqual(['a.png', 'missing.png']);
    expect(state.localSrc).toBe(dataUri);
    expect(state.remoteSrc).toBe('https://example.com/remote.png');
    expect(state.inlineSrc).toBe(dataUri);
    expect(state.missingHasSrc).toBe(false);
    expect(state.missingAlt).toBe('缺图文字');
    expect(requestedUrls.some(url => url.includes('a.png') || url.includes('missing.png'))).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  it('5. strips inline onclick handlers without executing script on click', async () => {
    await open('<div onclick="window.__x=1">安全点击</div>\n');
    const previewDiv = page.locator('.croquill-html-preview div');
    expect(await previewDiv.getAttribute('onclick')).toBeNull();
    await previewDiv.click();
    expect(await page.evaluate(() => (window as any).__x)).toBeUndefined();
  });

  it('6. strips <script> and onerror attributes without execution or relative fetch', async () => {
    const requestedUrls: string[] = [];
    page.on('request', req => requestedUrls.push(req.url()));
    await page.evaluate(() => {
      (window as any).htmlHarness.resolver = async () => Promise.reject(new Error('not found'));
    });
    await open('<script>window.__x=1</script>\n<img src=x onerror="window.__x=1" alt="安全图">\n');
    await page.evaluate(() => new Promise(r => setTimeout(r, 20)));
    const check = await page.evaluate(() => {
      const previews = (window as any).htmlHarness.richRoot as HTMLElement;
      const img = previews.querySelector('.croquill-html-preview img');
      return {
        x: (window as any).__x,
        scriptCount: previews.querySelectorAll('.croquill-html-preview script').length,
        onerrorCount: previews.querySelectorAll('.croquill-html-preview [onerror]').length,
        imgHasSrc: img?.hasAttribute('src') ?? false,
        imgAlt: img?.getAttribute('alt') ?? null,
      };
    });
    expect(check.x).toBeUndefined();
    expect(check.scriptCount).toBe(0);
    expect(check.onerrorCount).toBe(0);
    expect(check.imgHasSrc).toBe(false);
    expect(check.imgAlt).toBe('安全图');
    expect(requestedUrls.some(url => /\/x(?:$|\?)/.test(url))).toBe(false);
  });

  it('7. neutralizes javascript: links and prevents link navigation', async () => {
    await open('<div><a href="javascript:window.__x=1">恶意链接</a> | <a href="https://example.com/doc">普通链接</a></div>\n');
    const beforeUrl = page.url();
    const evilLink = page.locator('.croquill-html-preview a').nth(0);
    const evilHref = await evilLink.getAttribute('href');
    expect(evilHref === null || !/^javascript:/i.test(evilHref)).toBe(true);
    await evilLink.click();
    expect(await page.evaluate(() => (window as any).__x)).toBeUndefined();
    await page.keyboard.press('Escape');
    await page.locator('.croquill-html-preview a').nth(1).click();
    expect(page.url()).toBe(beforeUrl);
  });

  it('8. strips iframe, style, form, input, and svg tags from the preview', async () => {
    await open(
      '<div>\n<iframe src="https://example.com"></iframe>\n<style>body{color:red}</style>\n<form action="/steal"><input value="abc"></form>\n<svg><circle r="10"/></svg>\n<p>保留文字</p>\n</div>\n',
    );
    const info = await page.evaluate(() => {
      const preview = document.querySelector('.croquill-html-preview')!;
      return {
        forbidden: preview.querySelectorAll('iframe, style, form, input, button, textarea, select, option, object, embed, video, audio, svg, math').length,
        text: preview.textContent?.trim() ?? '',
      };
    });
    expect(info.forbidden).toBe(0);
    expect(info.text).toBe('保留文字');
  });

  it('9. contains position:fixed overlays inside .croquill-html-preview', async () => {
    await open('上方普通段落\n\n<div style="position:fixed;inset:0;background:red;z-index:9999">固定遮罩</div>\n');
    const check = await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.ProseMirror p')).find(node => node.textContent?.includes('上方普通段落'))!;
      const preview = document.querySelector('.croquill-html-preview') as HTMLElement;
      const fixedDiv = preview.querySelector('div') as HTMLElement;
      const pRect = p.getBoundingClientRect();
      const hitOutside = document.elementFromPoint(pRect.left + 12, pRect.top + pRect.height / 2);
      const previewStyle = getComputedStyle(preview);
      return {
        contain: previewStyle.contain,
        overflow: previewStyle.overflow,
        position: previewStyle.position,
        hitIsFixedDiv: hitOutside === fixedDiv || !!hitOutside?.closest('[data-croquill-html]'),
        hitInParagraph: !!hitOutside?.closest('p') && hitOutside.closest('p')!.textContent === '上方普通段落',
      };
    });
    expect(check.contain).toContain('paint');
    expect(check.overflow).toBe('hidden');
    expect(check.position).toBe('relative');
    expect(check.hitIsFixedDiv).toBe(false);
    expect(check.hitInParagraph).toBe(true);
  });

  it('10. prevents DOM clobbering of document.body and document.cookie', async () => {
    const before = await page.evaluate(() => ({
      isBody: document.body === document.getElementsByTagName('body')[0],
      cookieType: typeof document.cookie,
    }));
    await open('<div id="body" name="cookie">干扰块</div>\n');
    const after = await page.evaluate(() => ({
      isBody: document.body === document.getElementsByTagName('body')[0] && document.body.tagName === 'BODY',
      cookieType: typeof document.cookie,
      rawId: document.querySelector('.croquill-html-preview div')?.getAttribute('id') ?? '',
    }));
    expect(before.isBody).toBe(true);
    expect(after.isBody).toBe(true);
    expect(after.cookieType).toBe('string');
    expect(after.rawId).not.toBe('body');
  });

  it('11. clicks into source editing with trailing whitespace stripped, and also enters on NodeSelection Enter', async () => {
    await open('上段\n\n<div align="center">内容</div>  \n\n\n下段\n');
    await page.locator('.croquill-html-preview').click();
    const clickState = await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return {
        hidden: textarea.hidden,
        focused: document.activeElement === textarea,
        value: textarea.value,
      };
    });
    expect(clickState).toEqual({
      hidden: false,
      focused: true,
      value: '<div align="center">内容</div>',
    });

    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (document.querySelector('.croquill-html-source') as HTMLTextAreaElement).hidden)).toBe(true);
    // ArrowUp to previous paragraph, then ArrowDown to NodeSelection and press Enter.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const enterState = await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      const style = getComputedStyle(textarea);
      return {
        hidden: textarea.hidden,
        focused: document.activeElement === textarea,
        fontFamily: style.fontFamily,
        overflowY: style.overflowY,
        initialHeight: textarea.offsetHeight,
      };
    });
    expect(enterState.hidden).toBe(false);
    expect(enterState.focused).toBe(true);
    expect(enterState.fontFamily.toLowerCase()).toMatch(/cascadia|consolas|monospace/);
    expect(enterState.overflowY).toBe('hidden');
    await page.keyboard.type('\nline2\nline3');
    const grown = await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return {
        offsetHeight: textarea.offsetHeight,
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
      };
    });
    expect(grown.offsetHeight).toBeGreaterThan(enterState.initialHeight);
    expect(grown.scrollHeight).toBeLessThanOrEqual(grown.clientHeight);
  });

  it('12. immediately writes edits to document while keeping trailing blanks, LF/CRLF, and BOM intact', async () => {
    const lfDoc = '上段\n\n<div align="center">旧字</div>\n\n\n下段\n';
    await open(lfDoc);
    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      const idx = textarea.value.indexOf('旧字');
      textarea.setSelectionRange(idx, idx + 2);
    });
    await page.keyboard.type('新值');

    // Immediately verify before leaving edit mode.
    const liveLf = await page.evaluate(() => ({
      md: (window as any).htmlHarness.surface.getMarkdown(),
      preview: document.querySelector('.croquill-html-preview')?.textContent ?? '',
    }));
    expect(liveLf.md).toBe('上段\n\n<div align="center">新值</div>\n\n\n下段\n');
    expect(liveLf.preview).toBe('新值');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).htmlHarness.save())).toBe('上段\n\n<div align="center">新值</div>\n\n\n下段\n');

    const crlfDoc = '上段\r\n\r\n<div>\r\n旧行\r\n</div>\r\n\r\n\r\n下段\r\n';
    await open(crlfDoc);
    await page.locator('.croquill-html-preview').click();
    const beforeEdit = await page.evaluate(() => (document.querySelector('.croquill-html-source') as HTMLTextAreaElement).value);
    expect(beforeEdit).toBe('<div>\n旧行\n</div>');
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      const idx = textarea.value.indexOf('旧行');
      textarea.setSelectionRange(idx, idx + 2);
    });
    await page.keyboard.type('新行');
    expect(await page.evaluate(() => (window as any).htmlHarness.surface.getMarkdown())).toBe(
      '上段\n\n<div>\r\n新行\r\n</div>\r\n\r\n\r\n下段\n',
    );
    await page.keyboard.press('Escape');
    const crlfSaved = await page.evaluate(async () => {
      const text = await (window as any).htmlHarness.save();
      return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
    });
    expect(crlfSaved).toBe(crlfDoc.replace('旧行', '新行'));
  });

  it('13. keeps untouched LF, CRLF, and BOM documents byte-identical after enter/leave', async () => {
    for (const original of [
      '前\n\n<div align="center">原文</div>\n\n后\n',
      '前\r\n\r\n<div>\r\n多行\r\n</div>\r\n\r\n后\r\n',
      '\uFEFF# 标题\r\n\r\n<div align="center">带BOM</div>\r\n\r\n正文\r\n',
    ]) {
      await open(original);
      await page.locator('.croquill-html-preview').click();
      await page.keyboard.press('Escape');
      const escResult = await page.evaluate(async () => ({
        dirty: (window as any).htmlHarness.dirty,
        changes: (window as any).htmlHarness.changes.length,
        hasFocus: (window as any).htmlHarness.surface.richView().hasFocus(),
        selectionType: (window as any).htmlHarness.surface.richView().state.selection.node?.type.name ?? null,
        saved: await (window as any).htmlHarness.save(),
      }));
      expect(escResult).toEqual({
        dirty: 0,
        changes: 0,
        hasFocus: true,
        selectionType: 'croquill_raw_block',
        saved: original,
      });

      // Also verify blur without edit keeps document untouched.
      await page.locator('.croquill-html-preview').click();
      await page.evaluate(() => (document.querySelector('.croquill-html-source') as HTMLTextAreaElement).blur());
      const blurResult = await page.evaluate(async () => ({
        hidden: (document.querySelector('.croquill-html-source') as HTMLTextAreaElement).hidden,
        dirty: (window as any).htmlHarness.dirty,
        saved: await (window as any).htmlHarness.save(),
      }));
      expect(blurResult).toEqual({ hidden: true, dirty: 0, saved: original });
    }
  });

  it('14. routes Ctrl+Z and Ctrl+Y inside the source box to editor history and restores caret', async () => {
    await open('<div>旧字</div>\n');
    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      const idx = textarea.value.indexOf('旧字') + 2;
      textarea.setSelectionRange(idx, idx);
    });
    await page.keyboard.type('X');
    expect(await page.evaluate(() => (window as any).htmlHarness.surface.getMarkdown())).toBe('<div>旧字X</div>\n');

    await page.keyboard.press('Control+z');
    const afterUndo = await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return {
        md: (window as any).htmlHarness.surface.getMarkdown(),
        val: textarea.value,
        preview: document.querySelector('.croquill-html-preview')?.textContent ?? '',
        focused: document.activeElement === textarea,
        caret: textarea.selectionStart,
      };
    });
    expect(afterUndo).toEqual({
      md: '<div>旧字</div>\n',
      val: '<div>旧字</div>',
      preview: '旧字',
      focused: true,
      caret: 7,
    });

    await page.keyboard.press('Control+y');
    const afterRedo = await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return {
        md: (window as any).htmlHarness.surface.getMarkdown(),
        val: textarea.value,
        preview: document.querySelector('.croquill-html-preview')?.textContent ?? '',
      };
    });
    expect(afterRedo).toEqual({
      md: '<div>旧字X</div>\n',
      val: '<div>旧字X</div>',
      preview: '旧字X',
    });

    // Also test Ctrl+Shift+Z redo.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    expect(await page.evaluate(() => (window as any).htmlHarness.surface.getMarkdown())).toBe('<div>旧字X</div>\n');
  });

  it('15. suppresses document updates during CDP IME composition and commits once on end', async () => {
    await open('<div>前文</div>\n');
    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      const idx = textarea.value.indexOf('</div>');
      textarea.setSelectionRange(idx, idx);
    });
    const beforeDirty = await page.evaluate(() => (window as any).htmlHarness.dirty);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
    const during = await page.evaluate(() => ({
      isComposing: (window as any).htmlHarness.surface.isComposing(),
      hasFocused: (window as any).htmlHarness.surface.hasFocusedComposition(),
      md: (window as any).htmlHarness.surface.getMarkdown(),
      dirty: (window as any).htmlHarness.dirty,
    }));
    expect(during).toEqual({
      isComposing: true,
      hasFocused: true,
      md: '<div>前文</div>\n',
      dirty: beforeDirty,
    });

    await cdp.send('Input.insertText', { text: '中文' });
    await page.waitForFunction(() => !(window as any).htmlHarness.surface.isComposing());
    const after = await page.evaluate(() => ({
      md: (window as any).htmlHarness.surface.getMarkdown(),
      preview: document.querySelector('.croquill-html-preview')?.textContent ?? '',
      dirty: (window as any).htmlHarness.dirty,
    }));
    expect(after.md).toBe('<div>前文中文</div>\n');
    expect(after.preview).toBe('前文中文');
    expect(after.dirty).toBe(beforeDirty + 1);
  });

  it('16. isolates formatting shortcuts in source box while keeping search/replace working', async () => {
    await open('<div align="center">查找目标</div>\n');
    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      textarea.select();
    });
    for (const shortcut of [
      'Control+b',
      'Control+i',
      'Control+k',
      'Control+1',
      'Control+0',
      'Control+Equal',
      'Control+Minus',
      'Control+Shift+x',
    ]) {
      await page.keyboard.press(shortcut);
    }
    expect(await page.evaluate(() => (window as any).htmlHarness.surface.getMarkdown())).toBe(
      '<div align="center">查找目标</div>\n',
    );
    expect(await page.evaluate(() => (window as any).htmlHarness.dirty)).toBe(0);

    // Ctrl+H opens Find & Replace, and replacing text updates the live preview and source textarea.
    await page.keyboard.press('Control+h');
    const panel = page.locator('[data-search-panel]:not([hidden])');
    expect(await panel.count()).toBe(1);
    await panel.locator('input[aria-label="查找内容"]').fill('查找目标');
    await panel.locator('input[aria-label="替换为"]').fill('替换结果');
    await panel.locator('button[data-search-command="all"]').click();
    expect(await panel.locator('[data-search-error]').textContent()).toBe('');
    await page.waitForFunction(() => document.querySelector('.croquill-html-preview')?.textContent === '替换结果', undefined, { timeout: 2000 });
    expect(await page.evaluate(() => (window as any).htmlHarness.surface.getMarkdown())).toBe(
      '<div align="center">替换结果</div>\n',
    );
  });

  it('17. converts empty HTML blocks to an empty paragraph on exit, and keeps plain text edits as raw block', async () => {
    await open('<div align="center">待清空</div>\n');
    await page.locator('.croquill-html-preview').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    const afterEscEmpty = await page.evaluate(() => {
      const doc = (window as any).htmlHarness.surface.richView().state.doc;
      return {
        rawCount: document.querySelectorAll('[data-croquill-raw]').length,
        firstType: doc.firstChild?.type.name ?? null,
        firstText: doc.firstChild?.textContent ?? null,
        hiddenCheck: document.querySelector('.croquill-html-source'),
      };
    });
    expect(afterEscEmpty).toEqual({
      rawCount: 0,
      firstType: 'paragraph',
      firstText: '',
      hiddenCheck: null,
    });

    // Whitespace-only + blur also converts to empty paragraph.
    await open('<div>第二块</div>\n');
    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      textarea.value = '   \n  ';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.blur();
    });
    expect(await page.evaluate(() => ({
      rawCount: document.querySelectorAll('[data-croquill-raw]').length,
      firstType: (window as any).htmlHarness.surface.richView().state.doc.firstChild?.type.name,
    }))).toEqual({ rawCount: 0, firstType: 'paragraph' });

    // Non-HTML edited text stays as croquill_raw_block without reparsing the document.
    await open('<div>将被改成普通字</div>\n\n**保留邻段**\n');
    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      textarea.select();
    });
    await page.keyboard.type('# 不当标题解析');
    await page.keyboard.press('Escape');
    const nonHtml = await page.evaluate(() => {
      const view = (window as any).htmlHarness.surface.richView();
      return {
        firstType: view.state.doc.firstChild?.type.name ?? null,
        md: (window as any).htmlHarness.surface.getMarkdown(),
      };
    });
    expect(nonHtml.firstType).toBe('croquill_raw_block');
    expect(nonHtml.md).toBe('# 不当标题解析\n\n**保留邻段**\n');
  });

  it('18. exits to adjacent blocks on ArrowUp at start of first line and ArrowDown at end of last line', async () => {
    await open('上一段\n\n<div>\n第一行\n第二行\n</div>\n\n下一段\n');
    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      textarea.setSelectionRange(0, 0);
    });
    await page.keyboard.press('ArrowUp');
    const afterUp = await page.evaluate(() => {
      const view = (window as any).htmlHarness.surface.richView();
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return {
        hidden: textarea.hidden,
        hasFocus: view.hasFocus(),
        parentText: view.state.selection.$head.parent.textContent,
      };
    });
    expect(afterUp).toEqual({ hidden: true, hasFocus: true, parentText: '上一段' });

    await page.locator('.croquill-html-preview').click();
    await page.evaluate(() => {
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    await page.keyboard.press('ArrowDown');
    const afterDown = await page.evaluate(() => {
      const view = (window as any).htmlHarness.surface.richView();
      const textarea = document.querySelector('.croquill-html-source') as HTMLTextAreaElement;
      return {
        hidden: textarea.hidden,
        hasFocus: view.hasFocus(),
        parentText: view.state.selection.$head.parent.textContent,
      };
    });
    expect(afterDown).toEqual({ hidden: true, hasFocus: true, parentText: '下一段' });
  });

  it('19. round-trips between rich and source modes while keeping HTML rendering intact', async () => {
    const original = '<div align="center">模式往返</div>\n\n普通段\n';
    await open(original);
    const result = await page.evaluate(async () => {
      const h = (window as any).htmlHarness;
      await h.surface.setMode('source');
      const sourceText = h.surface.getMarkdown();
      await h.surface.setMode('rich');
      return {
        sourceText,
        mode: h.surface.mode,
        richText: h.surface.getMarkdown(),
        renderedText: h.richRoot.querySelector('.croquill-html-preview div[align="center"]')?.textContent ?? null,
        preCount: h.richRoot.querySelectorAll('pre[data-croquill-raw]').length,
      };
    });
    expect(result).toEqual({
      sourceText: original,
      mode: 'rich',
      richText: original,
      renderedText: '模式往返',
      preCount: 0,
    });
  });

  it('20. copies and pastes HTML blocks in the editor as renderable HTML blocks with valid markdown', async () => {
    await open('<div align="center">可复制块</div>\n\n结尾段落\n');
    await page.locator('.croquill-html-preview').click();
    await page.keyboard.press('Escape');

    const result = await page.evaluate(async () => {
      const h = (window as any).htmlHarness;
      const view = h.surface.richView();
      const data = new DataTransfer();
      view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));

      // Move caret to end of the trailing paragraph.
      let endPos = view.state.doc.content.size;
      view.state.doc.descendants((node: any, pos: number) => {
        if (node.isText && node.text.includes('结尾段落')) endPos = pos + node.text.length;
      });
      const TextSel = view.state.selection.$anchor.constructor ? (view.state.doc.resolve(endPos) && null) : null;
      void TextSel;
      const $pos = view.state.doc.resolve(endPos);
      // Use ProseMirror's Selection.near via current selection or findFrom.
      const nearSel = view.state.selection.constructor.findFrom($pos, -1) || view.state.selection.constructor.findFrom($pos, 1);
      if (nearSel) view.dispatch(view.state.tr.setSelection(nearSel));

      view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const saved = await h.save();
      await h.surface.load(saved);
      return {
        htmlBlocks: h.richRoot.querySelectorAll('[data-croquill-html] .croquill-html-preview').length,
        preCount: h.richRoot.querySelectorAll('pre[data-croquill-raw]').length,
        saved,
      };
    });

    expect(result.htmlBlocks).toBe(2);
    expect(result.preCount).toBe(0);
    expect(result.saved.match(/<div align="center">可复制块<\/div>/g)?.length).toBe(2);
  });

  it('21. keeps global Ctrl+S / Ctrl+/ working inside source box and round-trips examples/html-block.md', async () => {
    const sample = readFileSync(new URL('../examples/html-block.md', import.meta.url), 'utf8');
    await page.evaluate(async () => { await (window as any).htmlHarness?.surface.destroy(); });
    await openFileApp(page, baseURL, { files: { [currentFile]: sample } });

    const initial = await page.evaluate(() => ({
      mode: (window as any).fileApp.surface.mode,
      dirty: (window as any).fileApp.session.dirty,
      htmlBlocks: document.querySelectorAll('#rich-root [data-croquill-html] .croquill-html-preview').length,
      mixedPres: document.querySelectorAll('#rich-root pre[data-croquill-raw]').length,
      saved: (window as any).fileApp.surface.getMarkdown(),
    }));
    expect(initial.mode).toBe('rich');
    expect(initial.dirty).toBe(false);
    expect(initial.htmlBlocks).toBe(3);
    expect(initial.mixedPres).toBe(1);
    expect(initial.saved).toBe(sample);

    await page.locator('.croquill-html-preview').first().click();
    await page.keyboard.type('新');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => (window as any).fileApp.writes.length === 1);
    expect(await page.evaluate(() => (window as any).fileApp.writes[0].text)).toContain('新');

    await page.keyboard.press('Control+/');
    await page.waitForFunction(() => (window as any).fileApp.surface.mode === 'source');
    expect(await page.evaluate(() => (window as any).fileApp.surface.mode)).toBe('source');
  }, 30000);
});
