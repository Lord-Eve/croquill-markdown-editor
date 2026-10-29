import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';

describe('rich editor deferred synchronization', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer();
    await server.listen(); const address = server.httpServer!.address();
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
      import { DocumentSession } from '/src/session.ts';
      const richRoot=document.createElement('div'), sourceRoot=document.createElement('div');
      document.body.append(richRoot,sourceRoot);
      const h=window.debounceHarness={richRoot,sourceRoot,changes:[],writes:[],dirtySignals:0,serializations:0,confirmations:0};
      h.session=new DocumentSession({
        write:async(_path,text)=>{h.writes.push(text);return {revision:'test'};},
        savePath:async()=> 'D:/notes/debounce.md',
        confirmSave:async()=>{h.confirmations++;return 'save';},
      });
      h.session.path='D:/notes/debounce.md';h.session.text='原文\\n';h.session.savedText='原文\\n';
      h.surface=new MarkdownSurface({richRoot,sourceRoot,resolveImage:async()=>'',
        onDirty:()=>{h.dirtySignals++;h.session.markPending();},
        onChange:text=>{h.changes.push(text);h.session.edit(text);},
      });
      await h.surface.init('原文\\n');
      const originalSerialize=h.surface.serializeRich.bind(h.surface);
      h.surface.serializeRich=()=>{h.serializations++;return originalSerialize();};
      h.insert=text=>{
        const view=h.surface.richView();
        let end;
        view.state.doc.forEach((node,pos)=>{if(end===undefined&&node.type.name==='paragraph')end=pos+node.nodeSize-1;});
        view.dispatch(view.state.tr.insertText(text,end));
      };
      h.snapshot=()=>({changes:[...h.changes],writes:[...h.writes],dirtySignals:h.dirtySignals,serializations:h.serializations,dirty:h.session.dirty,text:h.session.text});
    ` });
    await page.waitForFunction(() => 'debounceHarness' in window);
  });
  afterEach(async () => {
    await page?.evaluate(async()=>{await (window as any).debounceHarness?.surface.destroy();});
    await page?.close();
  });

  it('marks a burst dirty immediately and serializes once after about 300ms idle', async () => {
    const early=await page.evaluate(async()=>{
      const h=(window as any).debounceHarness;
      h.insert('a');h.insert('b');h.insert('c');
      const immediate=h.snapshot();
      await new Promise(resolve=>setTimeout(resolve,180));
      return {immediate,beforeIdle:h.snapshot()};
    });
    expect(early.immediate).toMatchObject({dirty:true,serializations:0,changes:[],text:'原文\n'});
    expect(early.immediate.dirtySignals).toBeGreaterThan(0);
    expect(early.beforeIdle).toMatchObject({serializations:0,changes:[]});
    await page.waitForFunction(()=>(window as any).debounceHarness.changes.length===1);
    const idle=await page.evaluate(()=>(window as any).debounceHarness.snapshot());
    expect(idle).toMatchObject({serializations:1,changes:['原文abc\n'],text:'原文abc\n',dirty:true});
  });

  it('flushes getMarkdown synchronously and cancels the later duplicate notification', async()=>{
    const immediate=await page.evaluate(()=>{
      const h=(window as any).debounceHarness;h.insert('最后一字');
      const markdown=h.surface.getMarkdown();return {markdown,...h.snapshot()};
    });
    expect(immediate).toMatchObject({markdown:'原文最后一字\n',text:'原文最后一字\n',serializations:1,changes:['原文最后一字\n']});
    await page.waitForTimeout(380);
    expect(await page.evaluate(()=>(window as any).debounceHarness.snapshot())).toMatchObject({serializations:1,changes:['原文最后一字\n']});
  });

  it.each(['save','close'] as const)('keeps the last input when %s happens before the idle timer',async action=>{
    const result=await page.evaluate(async action=>{
      const h=(window as any).debounceHarness;h.insert('末字');
      // The same synchronous boundary used by main.run for save and close.
      h.session.edit(h.surface.getMarkdown());
      const accepted=action==='save'?await h.session.save():await h.session.mayLeave();
      return {accepted,confirmations:h.confirmations,...h.snapshot()};
    },action);
    expect(result).toMatchObject({accepted:true,writes:['原文末字\n'],text:'原文末字\n',serializations:1,dirty:false});
    expect(result.confirmations).toBe(action==='close'?1:0);
  });

  it('switches to source immediately with all pending input',async()=>{
    const result=await page.evaluate(async()=>{
      const h=(window as any).debounceHarness;h.insert('源码前末字');
      await h.surface.setMode('source');
      return {mode:h.surface.mode,markdown:h.surface.getMarkdown(),source:h.sourceRoot.textContent,...h.snapshot()};
    });
    expect(result.mode).toBe('source');
    expect(result.markdown).toBe('原文源码前末字\n');
    expect(result.source).toContain('原文源码前末字');
    expect(result.text).toBe(result.markdown);
  });

  it('does not publish the previous document after loading another document',async()=>{
    const result=await page.evaluate(async()=>{
      const h=(window as any).debounceHarness;h.insert('旧文档待同步');
      h.session.edit('新文档\n');h.session.savedText='新文档\n';
      await h.surface.load('新文档\n');
      h.changes=[];h.serializations=0;
      await new Promise(resolve=>setTimeout(resolve,380));
      return {...h.snapshot(),markdown:h.surface.getMarkdown()};
    });
    expect(result).toMatchObject({changes:[],serializations:0,text:'新文档\n',markdown:'新文档\n',dirty:false});
  });

  it('cancels pending serialization when destroyed',async()=>{
    const result=await page.evaluate(async()=>{
      const h=(window as any).debounceHarness;h.insert('待销毁');
      await h.surface.destroy();
      await new Promise(resolve=>setTimeout(resolve,380));
      return h.snapshot();
    });
    expect(result).toMatchObject({changes:[],serializations:0});
  });

  it('undoing a pending input restores the original bytes and clears dirty state',async()=>{
    const result=await page.evaluate(()=>{
      const h=(window as any).debounceHarness;h.insert('临时输入');
      const marked=h.session.dirty;h.surface.format('undo');
      return {marked,markdown:h.surface.getMarkdown(),...h.snapshot()};
    });
    expect(result).toMatchObject({marked:true,markdown:'原文\n',text:'原文\n',dirty:false,serializations:0});
  });

  it('defers an existing pending serialization while scrolling without marking a clean document dirty',async()=>{
    const deferred=await page.evaluate(async()=>{
      const h=(window as any).debounceHarness;
      h.surface.deferPendingSerialization();
      const clean=h.snapshot();
      h.insert('滚动前输入');
      await new Promise(resolve=>setTimeout(resolve,180));
      h.surface.deferPendingSerialization();
      await new Promise(resolve=>setTimeout(resolve,180));
      return {clean,scrolling:h.snapshot()};
    });
    expect(deferred.clean).toMatchObject({dirty:false,serializations:0,changes:[]});
    expect(deferred.scrolling).toMatchObject({dirty:true,serializations:0,changes:[]});
    await page.waitForFunction(()=>(window as any).debounceHarness.changes.length===1);
    expect(await page.evaluate(()=>(window as any).debounceHarness.snapshot())).toMatchObject({text:'原文滚动前输入\n',serializations:1});
  });

  it('does not let a previous statistics timer serialize a resumed input burst', async () => {
    await page.route('**/src/main.ts', async route => {
      const response=await route.fetch();
      await route.fulfill({response,body:(await response.text())+'\nwindow.appSyncTest={surface,session};'});
    });
    await page.goto(baseURL);
    await page.waitForFunction(()=>!!(window as any).appSyncTest);
    await page.evaluate(async()=>{
      const a=(window as any).appSyncTest,s=a.surface;
      await s.load('原文\n');a.session.edit('原文\n');a.session.savedText='原文\n';
      a.serializations=0;const serialize=s.serializeRich.bind(s);s.serializeRich=()=>{a.serializations++;return serialize();};
      a.insert=(text:string)=>{const v=s.richView();v.dispatch(v.state.tr.insertText(text,v.state.doc.firstChild.nodeSize-1));};
      a.insert('a');
    });
    await page.waitForFunction(()=>(window as any).appSyncTest.session.text==='原文a\n');
    await page.evaluate(()=>(window as any).appSyncTest.insert('b'));
    await page.waitForTimeout(220);
    expect(await page.evaluate(()=>{const a=(window as any).appSyncTest;return {count:a.serializations,text:a.session.text,dirty:a.session.dirty};})).toEqual({count:1,text:'原文a\n',dirty:true});
    await page.waitForFunction(()=>(window as any).appSyncTest.session.text==='原文ab\n');
    expect(await page.evaluate(()=>(window as any).appSyncTest.serializations)).toBe(2);
    await page.evaluate(()=>(window as any).appSyncTest.surface.destroy());
  });

  it('waits for active composition to finish before idle serialization',async()=>{
    const during=await page.evaluate(async()=>{
      const h=(window as any).debounceHarness,view=h.surface.richView();
      view.dom.dispatchEvent(new CompositionEvent('compositionstart',{data:'字',bubbles:true}));
      h.insert('组词');
      await new Promise(resolve=>setTimeout(resolve,380));
      return {composing:view.composing,...h.snapshot()};
    });
    expect(during).toMatchObject({composing:true,dirty:true,serializations:0,changes:[]});
    await page.evaluate(()=>{
      const view=(window as any).debounceHarness.surface.richView();
      view.dom.dispatchEvent(new CompositionEvent('compositionend',{data:'组词',bubbles:true}));
    });
    await page.waitForFunction(()=>(window as any).debounceHarness.changes.length===1);
    expect(await page.evaluate(()=>(window as any).debounceHarness.snapshot())).toMatchObject({text:'原文组词\n',serializations:1});
  });
});
