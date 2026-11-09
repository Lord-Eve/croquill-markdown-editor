import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { currentFile, currentText, focusApp, openFileApp } from './app-files-fixture';
import { recentDocumentsKey } from '../src/recent-documents';

describe('file lifecycle through the real app', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => { server = await createTestServer(); await server.listen(); const a = server.httpServer!.address(); if (!a || typeof a === 'string') throw Error('No server'); baseURL = 'http://127.0.0.1:' + a.port; browser = await launchTestBrowser(); }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => { page = await browser.newPage({viewport:{width:1200,height:850}}); });
  afterEach(async () => { await page?.evaluate(() => (window as any).fileApp?.surface?.destroy()); await page?.close(); });
  const idle = async () => page.waitForFunction(() => !document.querySelector<HTMLElement>('#editor-scroll')!.inert);
  const state = async () => page.evaluate(() => { const h=(window as any).fileApp; return {path:h.session.path,text:h.surface.getMarkdown(),dirty:h.session.dirty,writes:h.writes}; });
  const drop = async (selector: string, names = ['下一篇.md']) => page.evaluate(({selector,names}) => {
    const transfer=new DataTransfer(); for(const name of names)transfer.items.add(new File(['file bytes stay native'],name,{type:name.endsWith('.png')?'image/png':'text/plain'}));
    const target=document.querySelector(selector)!; const rect=target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.x+30,clientY:rect.y+40}));
  },{selector,names});

  it('opens the manual workflow sample in rich mode and retains its original source',async()=>{
    const source=readFileSync(new URL('../examples/file-workflow.md',import.meta.url),'utf8');await openFileApp(page,baseURL,{files:{[currentFile]:source}});
    const mode=await page.evaluate(()=>{const h=(window as any).fileApp;return {mode:h.surface.mode,reason:h.surface.getSafetyReason()};});
    expect(mode).toEqual({mode:'rich',reason:null});expect((await state()).text).toBe(source);
  });

  it.each(['save','discard','cancel'])('opens a dropped Markdown file through the existing %s decision without losing pending input',async choice=>{
    const next='D:/验收/下一篇.md';await openFileApp(page,baseURL,{files:{[currentFile]:currentText,[next]:'下一篇\r\n'},dropPath:next});
    await page.evaluate(()=>{const h=(window as any).fileApp,v=h.surface.richView();v.dispatch(v.state.tr.insertText('新',1));});
    await drop('#rich-root');await page.locator('.app-dialog').waitFor();
    await page.getByRole('button',{name:choice==='save'?'保存':choice==='discard'?'不保存':'取消',exact:true}).click();await idle();
    const result=await state();
    if(choice==='cancel'){expect(result.path).toBe(currentFile);expect(result.text).toBe(currentText.replace('# 标题','# 新标题'));expect(result.dirty).toBe(true);expect(result.writes).toEqual([]);}
    else{expect(result.path).toBe(next);expect(result.text).toBe('下一篇\r\n');expect(result.dirty).toBe(false);expect(result.writes.map((item:any)=>item.text)).toEqual(choice==='save'?[currentText.replace('# 标题','# 新标题')]:[]);}
  });

  it.each(['.menubar','#files-pane','#source-root'])('opens a single document dropped on %s with its real path, not as pasted text',async selector=>{
    const next='D:/验收/下一篇.md';await openFileApp(page,baseURL,{files:{[currentFile]:currentText,[next]:'下一篇\n'},dropPath:next});
    if(selector==='#source-root')await focusApp(page,'source');await drop(selector);await page.waitForFunction(next=>(window as any).fileApp.session.path===next,next);
    const result=await state();expect(result).toMatchObject({path:next,text:'下一篇\n',dirty:false,writes:[]});
    expect(await page.evaluate(()=>(window as any).fileApp.drops)).toEqual([['下一篇.md']]);
  });

  it('retains the old document on dropped-file path/read failures and rejects ambiguous multi-file drops',async()=>{
    await openFileApp(page,baseURL,{dropError:'取得真实路径失败'});await drop('#rich-root');await page.locator('.app-dialog').waitFor();
    expect(await page.locator('.app-dialog').textContent()).toContain('取得真实路径失败');await page.getByRole('button',{name:'返回文档'}).click();await idle();expect((await state()).text).toBe(currentText);
    await drop('.menubar',['a.md','b.md']);expect(await page.locator('#toast').textContent()).toContain('一次只拖入一个');expect((await state()).path).toBe(currentFile);
    await page.evaluate(()=>{const h=(window as any).fileApp;h.dropError=null;h.dropPath='D:/验收/丢失.md';});await drop('#rich-root');await page.locator('.app-dialog').waitFor();expect(await page.locator('.app-dialog').textContent()).toContain('文件已不存在');expect((await state()).text).toBe(currentText);
  });

  it.each(['rich','source'])('continues to import images at editor drops in %s mode',async mode=>{
    await openFileApp(page,baseURL);await focusApp(page,mode);await drop(mode==='rich'?'#rich-root':'#source-root',['拖入.png']);
    await page.waitForFunction(()=>(window as any).fileApp.calls.some((call:any)=>call.cmd==='import_image'));await idle();
    expect((await state()).text).toContain('当前.assets/图片.png');expect(await page.evaluate(()=>(window as any).fileApp.drops)).toEqual([]);
  });

  it('remembers the newest ten files, opens a recent menu item and restores it on startup',async()=>{
    const files=Object.fromEntries(Array.from({length:12},(_,index)=>[`D:/历史/${index}.md`,`# 第${index}篇\n`]));
    await openFileApp(page,baseURL,{initial:null,files});
    await page.evaluate(async paths=>{const h=(window as any).fileApp;for(const path of paths){h.openSelected=path;await h.action('open');}},Object.keys(files));
    await page.locator('summary[data-menu-key="f"]').click();expect(await page.locator('#recent-files button').count()).toBe(10);
    expect(await page.locator('#recent-files button').first().getAttribute('data-path')).toBe('D:/历史/11.md');
    const chosen=page.locator('#recent-files button[data-path="D:/历史/5.md"]');await chosen.click();await idle();expect((await state()).path).toBe('D:/历史/5.md');
    await page.reload();await page.waitForFunction(()=>(window as any).fileApp?.ready);expect((await state()).path).toBe('D:/历史/5.md');
    expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).files.length,recentDocumentsKey)).toBe(10);
  });

  it('removes a missing recent file, including the current file, and retains the current text',async()=>{
    await openFileApp(page,baseURL);await page.evaluate(()=>{const h=(window as any).fileApp;delete h.files[h.session.path];});
    await page.locator('summary[data-menu-key="f"]').click();await page.locator('#recent-files button').click();await page.locator('.app-dialog').waitFor();
    expect(await page.locator('.app-dialog').textContent()).toContain('已从最近文件中移除');await page.getByRole('button',{name:'返回文档'}).click();await idle();
    expect((await state()).text).toBe(currentText);expect((await state()).dirty).toBe(true);expect(await page.locator('#recent-files button').count()).toBe(0);
    expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).last,recentDocumentsKey)).toBeNull();
  });

  it('reports a missing startup target, clears it, and honors a command-line target over restoration',async()=>{
    await openFileApp(page,baseURL,{initial:null,files:{}});
    await page.evaluate(key=>localStorage.setItem(key,JSON.stringify({files:['D:/missing.md'],last:'D:/missing.md'})),recentDocumentsKey);
    await page.reload({waitUntil:'commit'});await page.locator('.app-dialog').waitFor();expect(await page.locator('.app-dialog').textContent()).toContain('文件已不存在');await page.getByRole('button',{name:'返回文档'}).click();await page.waitForFunction(()=>(window as any).fileApp?.ready);expect((await state()).path).toBeNull();
    await page.unroute('**/src/main.ts');await openFileApp(page,baseURL,{initial:currentFile});
    expect((await state()).path).toBe(currentFile);
  });

  it.each(['\n','\r\n'])('Save As changes only relative image paths, refreshes preview and preserves every other byte (%j)',async eol=>{
    const original=['# 原文','', '__加粗__ ![图](<图 片.png> "原始标题") 与 [普通链接](keep.png)。','', '![第二张](image.png?raw=1&amp;x=2#view \'标题\')','', '行内 <img src="inline.png?raw=1&amp;x=2" alt="原文">','', '<div>','<img data-src="fake.png" src=block.png alt="不改">','<img src="entity.png&#35view">','<!-- <img src="comment.png"> -->','<script>const text=\'<img src="fake.png">\'</script>','</div>',''].join(eol);
    await openFileApp(page,baseURL,{files:{[currentFile]:original},saveSelected:'D:/新目录/副本.md'});expect(await page.evaluate(()=>(window as any).fileApp.surface.mode)).toBe('rich');await focusApp(page,'find');await page.keyboard.press('Control+Shift+s');
    await page.waitForFunction(()=>(window as any).fileApp.writes.length===1);await idle();const result=await state();
    const expected=original.replace('<图 片.png>','<../验收/图%20片.png>').replace('image.png?raw','../验收/image.png?raw').replace('src="inline.png','src="../验收/inline.png').replace('src=block.png','src=../验收/block.png').replace('src="entity.png','src="../验收/entity.png');
    expect(result.path).toBe('D:/新目录/副本.md');expect(result.text).toBe(expected);expect(result.writes[0].text).toBe(expected);expect(result.dirty).toBe(false);
    expect(await page.evaluate(path=>(window as any).fileApp.files[path],currentFile)).toBe(original);
    expect(await page.evaluate(()=>(window as any).fileApp.calls.filter((call:any)=>call.cmd==='read_local_image').some((call:any)=>call.args.documentPath==='D:/新目录/副本.md'))).toBe(true);
    expect(await page.locator('#save-status').textContent()).toContain('已保存');
    expect(await page.evaluate(()=>(window as any).fileApp.surface.mode)).toBe('rich');
  });

  it.each(['\n','\r\n'])('also rebases reference image definitions in source mode without expanding their syntax (%j)',async eol=>{
    const original=['# 引用式','', '![原文][pic]','', '[pic]: ./图片.png?raw=1#view "标题"',''].join(eol);
    await openFileApp(page,baseURL,{files:{[currentFile]:original},saveSelected:'D:/新目录/副本.md'});await focusApp(page,'source');await page.keyboard.press('Control+Shift+s');
    await page.waitForFunction(()=>(window as any).fileApp.writes.length===1);await idle();
    expect((await state()).text).toBe(original.replace('./图片.png','../验收/./图片.png'));expect((await state()).writes[0].text).toBe(original.replace('./图片.png','../验收/./图片.png'));
  });

  it('keeps original text/path/history on missing-image failure, and opening/new-file shortcuts use existing dialogs',async()=>{
    const original='![图](image.png)\n';await openFileApp(page,baseURL,{files:{[currentFile]:original},saveSelected:'E:/新.md',imageError:'图片不存在，尚未另存为'});
    await page.keyboard.press('Control+Shift+s');await page.locator('.app-dialog').waitFor();expect(await page.locator('.app-dialog').textContent()).toContain('图片不存在');await page.getByRole('button',{name:'返回文档'}).click();await idle();expect(await state()).toMatchObject({path:currentFile,text:original,writes:[]});
    await page.evaluate(()=>{const h=(window as any).fileApp;h.files['D:/新文档.md']='新文档\n';h.openSelected='D:/新文档.md';});await focusApp(page,'tree');await page.keyboard.press('Control+o');await page.waitForFunction(()=>(window as any).fileApp.session.path==='D:/新文档.md');
    await focusApp(page,'find');await page.keyboard.press('Control+n');await idle();expect((await state()).path).toBeNull();expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).last,recentDocumentsKey)).toBeNull();
  });
});
