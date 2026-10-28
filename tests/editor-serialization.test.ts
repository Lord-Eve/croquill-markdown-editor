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
    await page.addScriptTag({ type: 'module', content: 'import { MarkdownSurface } from "/src/editor.ts"; window.croqTestSurface = MarkdownSurface;' });
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
});
