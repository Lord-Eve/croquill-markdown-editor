import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
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
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  }, 60000);

  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(baseURL + '/tests/harness.html');
    await page.addScriptTag({ type: 'module', content: 'import { MarkdownSurface } from "/src/editor.ts"; import { ImageImporter } from "/src/images.ts"; window.croqTestSurface = MarkdownSurface; window.croqTestImporter = ImageImporter;' });
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

});
