import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { launchTestBrowser } from './browser';
import { preservedMarkdownBlocks } from '../src/fidelity';

const samples = ['1.', '7)  ', '- ', '*', '1.\n2. 内容\n3.  ', '> 1.\n> 2. 内容', '- 父项\n\n  1.\n  2. 内容'];
describe('editable empty list items', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.tools/**', '**/src-tauri/**'] } } });
    await server.listen(); const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(baseURL + '/tests/harness.html', { timeout: 60000 });
    await page.addScriptTag({ type: 'module', content: `import { MarkdownSurface } from '/src/editor.ts'; window.EmptySurface = MarkdownSurface;` });
    await page.waitForFunction(() => 'EmptySurface' in window);
  }, 60000);
  afterEach(async () => { await page?.close(); });

  it.each(samples.flatMap(syntax => ['LF', 'CRLF'].map(newline => ({ syntax, newline }))))('keeps empty markers editable and literal: $syntax ($newline)', async ({ syntax, newline }) => {
    expect(preservedMarkdownBlocks(syntax)).toEqual([]);
    const result = await page.evaluate(async ({ syntax, newline }) => {
      const r = document.createElement('div'), s = document.createElement('div'); document.body.append(r,s);
      const surface = new (window as any).EmptySurface({ richRoot:r, sourceRoot:s, onChange:()=>{}, resolveImage:async()=>'' });
      const original = ('无关段落\n\n' + syntax + '\n').replace(/\n/g, newline === 'CRLF' ? '\r\n' : '\n');
      try {
        await surface.init(original);
        const mode = surface.mode, reason = surface.getSafetyReason();
        const untouched = surface.getMarkdown() === original;
        const rawBlocks = r.querySelectorAll('[data-croquill-raw]').length;
        let emptyItems=0; surface.richView().state.doc.descendants((n:any)=>{if(n.type.name==='list_item' && n.childCount===1 && !n.firstChild.content.size) emptyItems++;});
        surface.format('heading2'); const edited = surface.getMarkdown();
        await surface.setMode('source'); await surface.setMode('rich');
        const switched = surface.getMarkdown() === edited && surface.mode === 'rich';
        surface.format('undo');
        return { mode, reason, untouched, rawBlocks, emptyItems, kept:edited.includes(syntax.replace(/\n/g,newline === 'CRLF' ? '\r\n' : '\n')), switched, undone:surface.getMarkdown()===original, edited };
      } finally { await surface.destroy(); }
    }, { syntax, newline });
    expect(result.mode, JSON.stringify(result)).toBe('rich');
    expect(result).toMatchObject({ untouched:true, rawBlocks:0, kept:true, switched:true, undone:true });
    expect(result.emptyItems).toBeGreaterThan(0);
  }, 30000);

  it('types in an empty item and restores its original marker after deleting that content', async () => {
    await page.evaluate(async () => {
      const r=document.createElement('div'),s=document.createElement('div');document.body.append(r,s);
      const surface=(window as any).emptyEdit=new (window as any).EmptySurface({richRoot:r,sourceRoot:s,onChange:()=>{},resolveImage:async()=>''});
      await surface.init('1.\n2. 内容\n3.  \n');
      const view=surface.richView();let pos:number|undefined;
      view.state.doc.descendants((node:any, offset:number)=>{if(pos===undefined && node.type.name==='paragraph' && !node.content.size) pos=offset+1;});
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos))));view.focus();
    });
    await page.keyboard.insertText('新内容');
    const edited = await page.evaluate(()=>(window as any).emptyEdit.getMarkdown());
    expect(edited).toContain('1. 新内容');
    expect(edited).toContain('3.  ');
    for(let i=0;i<3;i++) await page.keyboard.press('Backspace');
    const restored = await page.evaluate(async()=>{const s=(window as any).emptyEdit;const result=s.getMarkdown();await s.destroy();return result;});
    expect(restored).toBe('1.\n2. 内容\n3.  \n');
  });
});
