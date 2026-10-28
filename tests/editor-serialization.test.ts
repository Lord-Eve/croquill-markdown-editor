import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Browser, type Page } from '@playwright/test';
import { launchTestBrowser } from './browser';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

// Exercise the production MarkdownSurface in a real DOM with existing dev tools.
// These tests do not represent native desktop or IME acceptance.
describe('rich editor Markdown serialization', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let baseURL: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.tools/**', '**/src-tauri/**'] } },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);

  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(baseURL + '/tests/harness.html');
    await page.addScriptTag({ type: 'module', content: 'import { MarkdownSurface } from "/src/editor.ts"; import { ImageImporter } from "/src/images.ts"; window.croqTestSurface = MarkdownSurface; window.croqTestImporter = ImageImporter; import { protectFileDrops } from "/src/file-drop.ts"; window.croqTestProtectDrops = protectFileDrops;' });
    await page.waitForFunction(() => 'croqTestSurface' in window);
  });
  afterEach(async () => { await page?.close(); });

  it('uses hyphens for nested and task lists after a real rich editor edit', async () => {
    const output = await page.evaluate(async () => {
      const MarkdownSurface = (window as any).croqTestSurface;
      const richRoot = document.createElement('div');
      const sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (src: string) => src });
      try {
        await surface.init('# 标题\n\n* 父项\n  * 子项\n\n* [x] 已完成\n* [ ] 待办\n');
        if (surface.mode !== 'rich') throw new Error(surface.getSafetyReason() || 'Rich editor unavailable');
        surface.format('heading2');
        return surface.getMarkdown();
      } finally { await surface.destroy(); }
    });
    expect(output).toMatch(/^## 标题/m);
    expect(output).toMatch(/^- 父项$/m);
    expect(output).toMatch(/^  - 子项$/m);
    expect(output).toMatch(/^- \[x\] 已完成$/m);
    expect(output).toMatch(/^- \[ \] 待办$/m);
    expect(output).not.toMatch(/^\s*[*+] /m);
  }, 30000);

  it('preserves untouched original syntax and CRLF across modes and undo', async () => {
    const original = '# 原文\r\n\r\n__加粗__与星号列表。\r\n\r\n* 父项\r\n  * 子项\r\n';
    const result = await page.evaluate(async (text) => {
      const MarkdownSurface = (window as any).croqTestSurface;
      const richRoot = document.createElement('div');
      const sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const changes: string[] = [];
      const surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: (value: string) => changes.push(value), resolveImage: async (src: string) => src });
      try {
        await surface.init(text);
        if (surface.mode !== 'rich') throw new Error(surface.getSafetyReason() || 'Rich editor unavailable');
        await surface.setMode('source');
        await surface.setMode('rich');
        const untouched = surface.getMarkdown();
        const changeCount = changes.length;
        surface.format('heading2');
        surface.format('undo');
        return { untouched, changeCount, undone: surface.getMarkdown() };
      } finally { await surface.destroy(); }
    }, original);
    expect(result.untouched).toBe(original);
    expect(result.changeCount).toBe(0);
    expect(result.undone).toBe(original);
  }, 30000);

  it.each(['rich', 'source'] as const)('pastes image files as relative Markdown in %s mode, with working undo', async (mode) => {
    const result = await page.evaluate(async (mode) => {
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      const calls: any[] = [];
      const importer = new (window as any).croqTestImporter({ documentPath: () => 'D:\\笔记\\日记.md', saveDocument: async () => true, warn: () => {}, persist: async (args: any) => { calls.push(args); return '日记.assets/中文%20照片.png'; } });
      let completion = Promise.resolve();
      const surface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqQAAAAASUVORK5CYII=', onImageFiles: (files: File[], clipboard: boolean) => {
        completion = (async () => { for (const file of files) { const src = await importer.import({ file, clipboard }); if (src) surface.insertImage(src); } })();
      } });
      try {
        await surface.init('');
        if (mode === 'source') await surface.setMode('source');
        const data = new DataTransfer(); data.items.add(new File([new Uint8Array([1, 2, 3])], 'clipboard.png', { type: 'image/png' }));
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        (mode === 'rich' ? richRoot.querySelector('.ProseMirror')! : sourceRoot.querySelector('.cm-content')!).dispatchEvent(event);
        await completion;
        const output = surface.getMarkdown();
        surface.format('undo');
        return { output, undone: surface.getMarkdown(), calls, prevented: event.defaultPrevented };
      } finally { await surface.destroy(); }
    }, mode);
    expect(result.prevented).toBe(true);
    expect(result.output).toContain('![](日记.assets/中文%20照片.png)');
    expect(result.output).not.toMatch(/data:|base64/);
    expect(result.undone).toBe('');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].dataBase64).toBe('AQID');
  }, 30000);

  it('cancelled untitled image paste leaves no image, text change or upload placeholder', async () => {
    const result = await page.evaluate(async () => {
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      let writes = 0; const warnings: string[] = [];
      const importer = new (window as any).croqTestImporter({ documentPath: () => null, saveDocument: async () => false, warn: (s: string) => warnings.push(s), persist: async () => { writes++; return ''; } });
      let completion = Promise.resolve();
      const surface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (s: string) => s, onImageFiles: (files: File[]) => { completion = (async () => { const src = await importer.import({ file: files[0], clipboard: true }); if (src) surface.insertImage(src); })(); } });
      try {
        await surface.init('原文');
        const data = new DataTransfer(); data.items.add(new File(['png'], 'clipboard.png', { type: 'image/png' }));
        richRoot.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        await completion;
        return { text: surface.getMarkdown(), writes, warnings, images: richRoot.querySelectorAll('.milkdown-image-block').length, placeholder: richRoot.textContent?.includes('Upload in progress') };
      } finally { await surface.destroy(); }
    });
    expect(result).toEqual({ text: '原文', writes: 0, warnings: ['请先保存文档，再插入图片'], images: 0, placeholder: false });
  }, 30000);

  it('keeps existing network and embedded image URLs without uploading them', async () => {
    const result = await page.evaluate(async () => {
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      let uploads = 0;
      const surface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (s: string) => s, uploadImage: async () => { uploads++; return ''; } });
      try {
        await surface.init('# 标题\n\n![远程](https://example.com/photo.png)\n\n![原有](data:image/png;base64,AQID)\n');
        surface.format('heading2');
        return { text: surface.getMarkdown(), uploads };
      } finally { await surface.destroy(); }
    });
    expect(result.uploads).toBe(0);
    expect(result.text).toContain('https://example.com/photo.png');
    expect(result.text).toContain('data:image/png;base64,AQID');
  }, 30000);

  it('pastes an HTTP image URL from HTML even when the clipboard also offers image bytes', async () => {
    const result = await page.evaluate(async () => {
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      let uploads = 0;
      const surface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (s: string) => s, onImageFiles: () => { uploads++; }, uploadImage: async () => { uploads++; return ''; } });
      try {
        await surface.init('');
        const data = new DataTransfer();
        data.setData('text/html', '<img src="https://example.com/copied-photo.png" alt="网页图片">');
        data.items.add(new File(['png'], 'clipboard.png', { type: 'image/png' }));
        richRoot.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        return { text: surface.getMarkdown(), uploads, placeholder: richRoot.textContent?.includes('Upload in progress') };
      } finally { await surface.destroy(); }
    });
    expect(result.uploads).toBe(0);
    expect(result.text).toContain('https://example.com/copied-photo.png');
    expect(result.text).not.toMatch(/data:|base64/);
    expect(result.placeholder).toBe(false);
  }, 30000);


  it.each(['rich', 'source'] as const)('drops external image bytes near the pointer in %s mode', async (mode) => {
    const result = await page.evaluate(async mode => {
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      (window as any).croqTestProtectDrops(window, [richRoot, sourceRoot]);
      const calls: any[] = []; let completion = Promise.resolve();
      const importer = new (window as any).croqTestImporter({ documentPath: () => 'D:\\笔记\\日记.md', saveDocument: async () => true, warn: () => {}, persist: async (args: any) => { calls.push(args); return '日记.assets/中文%20图片.png'; } });
      const surface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (src: string) => src, onImageFiles: (files: File[], clipboard: boolean) => {
        completion = (async () => { const src = await importer.import({ file: files[0], clipboard }); surface.insertImage(src); })();
      } });
      try {
        await surface.init('前段\n\n后段');
        if (mode === 'source') await surface.setMode('source');
        const root = mode === 'rich' ? richRoot : sourceRoot;
        const lines = root.querySelectorAll(mode === 'rich' ? '.ProseMirror > p' : '.cm-line');
        const last = lines[lines.length - 1].getBoundingClientRect();
        surface.placeImageCursor(last.left + 10, last.top + 5);
        const first = lines[0].getBoundingClientRect();
        const transfer = new DataTransfer(); transfer.items.add(new File(['png'], '中文 图片.png', { type: 'image/png' }));
        const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: first.left + 15, clientY: first.top + 5 });
        lines[0].dispatchEvent(event); await completion;
        return { text: surface.getMarkdown(), calls, prevented: event.defaultPrevented };
      } finally { await surface.destroy(); }
    }, mode);
    expect(result.prevented).toBe(true);
    expect(result.text).toContain('![](日记.assets/中文%20图片.png)');
    expect(result.text.indexOf('![](')).toBeLessThan(result.text.indexOf('后段'));
    expect(result.text).not.toMatch(/data:|base64/);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].fileName).toBe('中文 图片.png');
    expect(result.calls[0].dataBase64).toBe('cG5n');
  }, 30000);

  it('blocks external files across the page and ignores non-image files inside editors', async () => {
    const result = await page.evaluate(async () => {
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      (window as any).croqTestProtectDrops(window, [richRoot, sourceRoot]);
      let uploads = 0;
      const surface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (s: string) => s, onImageFiles: () => { uploads++; } });
      try {
        await surface.init('保留原文');
        const outcomes = [];
        for (const tag of ['header', 'aside', 'footer']) {
          const outside = document.createElement(tag); document.body.append(outside);
          let reached = false; outside.addEventListener('drop', () => { reached = true; });
          for (const name of ['中文 图片.png', 'note.txt', 'note.md']) {
            const data = new DataTransfer(); data.items.add(new File(['test'], name));
            const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
            const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
            outside.dispatchEvent(over); outside.dispatchEvent(drop);
            outcomes.push(over.defaultPrevented && drop.defaultPrevented && !reached);
          }
        }
        for (const mode of ['rich', 'source']) {
          await surface.setMode(mode);
          const root = mode === 'rich' ? richRoot.querySelector('.ProseMirror')! : sourceRoot.querySelector('.cm-content')!;
          const data = new DataTransfer(); data.items.add(new File(['do not insert'], 'note.txt', { type: 'text/plain' }));
          const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }); root.dispatchEvent(drop);
          outcomes.push(drop.defaultPrevented);
        }
        return { outcomes, uploads, text: surface.getMarkdown() };
      } finally { await surface.destroy(); }
    });
    expect(result.outcomes).toHaveLength(11);
    expect(result.outcomes.every(Boolean)).toBe(true);
    expect(result.uploads).toBe(0);
    expect(result.text).toBe('保留原文');
  }, 30000);

  it('leaves internal text and image HTML drags to the editor', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('div'); document.body.append(root);
      (window as any).croqTestProtectDrops(window, [root]);
      return ['text/plain', 'text/html'].map(type => {
        const data = new DataTransfer(); data.setData(type, type === 'text/plain' ? '文字' : '<img src="日记.assets/photo.png">');
        let reached = false; root.addEventListener('drop', () => { reached = true; }, { once: true });
        const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }); root.dispatchEvent(drop);
        return !drop.defaultPrevented && reached;
      });
    });
    expect(result).toEqual([true, true]);
  });

  it.each(['rich', 'source'] as const)('moves selected text within and between paragraphs in %s mode with undo', async mode => {
    await page.evaluate(async mode => {
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
      document.body.append(richRoot, sourceRoot);
      (window as any).croqTestProtectDrops(window, [richRoot, sourceRoot]);
      (window as any).dragSurface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (s: string) => s });
      await (window as any).dragSurface.init('alpha beta gamma.\n\nsecond paragraph.');
      if (mode === 'source') await (window as any).dragSurface.setMode('source');
    }, mode);
    try {
      for (const crossParagraph of [false, true]) {
        const points = await page.evaluate(({ mode, crossParagraph }) => {
          const lines = document.querySelectorAll(mode === 'rich' ? '.ProseMirror > p' : '.cm-line');
          const first = document.createRange(); first.selectNodeContents(lines[0]);
          const target = document.createRange(); target.selectNodeContents(crossParagraph ? lines[lines.length - 1] : lines[0]);
          const a = first.getBoundingClientRect(), b = target.getBoundingClientRect();
          return { x: a.left + 15, y: a.top + a.height / 2, toX: b.right - 1, toY: b.top + b.height / 2 };
        }, { mode, crossParagraph });
        await page.mouse.click(points.x, points.y);
        await page.keyboard.press('Home');
        await page.keyboard.down('Shift');
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.waitForTimeout(100); // Let DOM selectionchange reach ProseMirror before dragstart.
        await page.mouse.move(points.x, points.y); await page.mouse.down();
        await page.waitForTimeout(180);
        await page.mouse.move(points.toX, points.toY, { steps: 15 }); await page.mouse.up();
        const text = await page.evaluate(() => (window as any).dragSurface.getMarkdown());
        expect(text.match(/alpha/g)).toHaveLength(1);
        expect(text.indexOf('alpha'), JSON.stringify({ mode, crossParagraph, text, points })).toBeGreaterThan(text.indexOf(crossParagraph ? 'second' : 'gamma'));
        await page.keyboard.press('Control+z');
        expect(await page.evaluate(() => (window as any).dragSurface.getMarkdown())).toBe('alpha beta gamma.\n\nsecond paragraph.');
      }
    } finally { await page.evaluate(() => (window as any).dragSurface.destroy()); }
  }, 30000);


  it('moves an existing image block without importing it as a new file', async () => {
    await page.evaluate(async () => {
      document.body.replaceChildren();
      const richRoot = document.createElement('div'), sourceRoot = document.createElement('div'); document.body.append(richRoot, sourceRoot);
      (window as any).croqTestProtectDrops(window, [richRoot, sourceRoot]);
      (window as any).blockUploads = 0;
      (window as any).blockSurface = new (window as any).croqTestSurface({ richRoot, sourceRoot, onChange: () => {}, onImageFiles: () => { (window as any).blockUploads++; }, resolveImage: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqQAAAAASUVORK5CYII=' });
      await (window as any).blockSurface.init('![原图](日记.assets/photo.png)\n\n目标段落');
    });
    try {
      const image = page.locator('.milkdown-image-block img').first();
      await image.waitFor();
      await image.dragTo(page.locator('.ProseMirror > p').last());
      const result = await page.evaluate(() => ({ text: (window as any).blockSurface.getMarkdown(), uploads: (window as any).blockUploads }));
      expect(result.uploads).toBe(0);
      expect(result.text.match(/日记.assets\/photo.png/g)).toHaveLength(1);
      expect(result.text.indexOf('日记.assets/photo.png')).toBeGreaterThan(result.text.indexOf('目标段落'));
      await page.keyboard.press('Control+z');
      expect(await page.evaluate(() => (window as any).blockSurface.getMarkdown())).toBe('![原图](日记.assets/photo.png)\n\n目标段落');
    } finally { await page.evaluate(() => (window as any).blockSurface.destroy()); }
  }, 30000);

});
