import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { launchTestBrowser } from './browser';

describe('saving trailing hard breaks', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
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
      window.TrailingSurface = MarkdownSurface;
    ` });
    await page.waitForFunction(() => 'TrailingSurface' in window);
  });
  afterEach(async () => { await page?.evaluate(() => (window as any).tailSurface?.destroy()); await page?.close(); });

  it.each(['paragraph', 'cell', 'header'].flatMap(context => ['', '<BR/>'].flatMap(originalBreak => [1, 2].map(presses => ({ context, originalBreak, presses })))))(
    'keeps $presses trailing breaks after $originalBreak in a $context across save and modes', async ({ context, originalBreak, presses }) => {
      const original = context === 'cell' ? '| 标题 | 备注 |\n| --- | --- |\n| 内容' + originalBreak + ' | 不动 |\n' :
        context === 'header' ? '| 内容' + originalBreak + ' | 备注 |\n| --- | --- |\n| 正文 | 不动 |\n' : '内容' + originalBreak + '\n';
      await page.evaluate(async original => {
        const richRoot = document.createElement('div'), sourceRoot = document.createElement('div');
        document.body.append(richRoot, sourceRoot);
        const surface = (window as any).tailSurface = new (window as any).TrailingSurface({ richRoot, sourceRoot, onChange: () => {}, resolveImage: async (s: string) => s });
        await surface.init(original);
        if (surface.mode !== 'rich') throw Error(surface.getSafetyReason());
        const view = surface.richView(); let end = 0;
        view.state.doc.descendants((node: any, pos: number) => { if (node.type.name === 'paragraph' && node.textContent.replace(/\n/g, '') === '内容') end = pos + node.nodeSize - 1; });
        if (!end) throw Error('Target paragraph unavailable');
        view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(end)))); view.focus();
      }, original);
      for (let index = 0; index < presses; index++) await page.keyboard.press('Shift+Enter');
      const result = await page.evaluate(async () => {
        const surface = (window as any).tailSurface, saved = surface.getMarkdown();
        await surface.setMode('source'); await surface.setMode('rich');
        const switched = surface.getMarkdown();
        await surface.load(saved);
        let count = 0;
        surface.richView().state.doc.descendants((node: any) => { if (node.type.name === 'hardbreak' && !node.attrs.isInline) count++; });
        return { saved, switched, reopened: surface.getMarkdown(), count, mode: surface.mode };
      });
      expect(result.saved).toBe(original.replace('内容' + originalBreak, '内容' + originalBreak + '<br>'.repeat(presses)));
      expect(result.switched).toBe(result.saved);
      expect(result.reopened).toBe(result.saved);
      expect(result.count).toBe(presses + (originalBreak ? 1 : 0));
      expect(result.mode).toBe('rich');
    }, 30000,
  );
});
