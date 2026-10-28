import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Browser, type Page } from '@playwright/test';
import { launchTestBrowser } from './browser';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { fidelitySamples, metadataSamples } from './fixtures/fidelity-samples';

const privateFolder = fileURLToPath(new URL('../examples/private/', import.meta.url));
const privatePaths = existsSync(privateFolder) ? readdirSync(privateFolder).filter(name => name.endsWith('.md')).map(name => join(privateFolder, name)) : [];

describe('syntax preservation through the production editor', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.tools/**', '**/src-tauri/**', '**/examples/private/**'] } } });
    await server.listen(); const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(baseURL + '/tests/harness.html');
    await page.addScriptTag({ type: 'module', content: 'import { MarkdownSurface } from "/src/editor.ts"; import { DocumentSession } from "/src/session.ts"; import { hasEquivalentMarkdownStructure, preservedMarkdownBlocks } from "/src/fidelity.ts"; window.SyntaxSurface=MarkdownSurface; window.SyntaxSession=DocumentSession; window.syntaxEquivalent=hasEquivalentMarkdownStructure; window.syntaxBlocks=preservedMarkdownBlocks;' });
    await page.waitForFunction(() => 'SyntaxSurface' in window);
  });
  afterEach(async () => { await page?.close(); });

  it.each(fidelitySamples)('$name: open, edit elsewhere, save literal source, switch and undo', async ({ syntax }) => {
    const result = await page.evaluate(async syntax => {
      const richRoot=document.createElement('div'), sourceRoot=document.createElement('div'); document.body.append(richRoot,sourceRoot);
      const original='无关编辑段落\r\n\r\n'+syntax+'\r\n'; let saved='';
      const session=new (window as any).SyntaxSession({ write: async (_p:string,text:string) => { saved=text; return { revision:'test' }; }, savePath: async ()=>'D:/notes/test.md' });
      session.path='D:/notes/test.md'; session.text=original; session.savedText=original;
      const surface=new (window as any).SyntaxSurface({richRoot,sourceRoot,onChange:(text:string)=>session.edit(text),resolveImage:async(s:string)=>s});
      try {
        await surface.init(original);
        const rich=surface.mode==='rich', reason=surface.getSafetyReason();
        session.edit(surface.getMarkdown()); await session.save(); const untouched=saved===original;
        surface.format('heading2'); session.edit(surface.getMarkdown()); await session.save();
        const edited=saved, expected='## 无关编辑段落\r\n\r\n'+syntax+'\r\n';
        const sameSnippet=edited.includes(syntax), once=edited.split(syntax).length===2;
        const equivalent=(window as any).syntaxEquivalent(expected,edited);
        await surface.setMode('source'); await surface.setMode('rich');
        const switched=surface.getMarkdown()===edited && surface.mode==='rich';
        surface.format('undo');
        return { rich, reason, untouched, sameSnippet, once, equivalent, switched, undone:surface.getMarkdown()===original, output:edited };
      } finally { await surface.destroy(); }
    }, syntax);
    expect(result.rich, result.reason || result.output).toBe(true);
    expect(result.untouched).toBe(true);
    expect(result.sameSnippet, result.output).toBe(true);
    expect(result.once).toBe(true);
    expect(result.equivalent, result.output).toBe(true);
    expect(result.switched).toBe(true);
    expect(result.undone).toBe(true);
  }, 30000);

  it.each(metadataSamples)('keeps a metadata prefix outside the rich kernel byte-for-byte (%#)', async prefix => {
    const result=await page.evaluate(async prefix=>{
      const richRoot=document.createElement('div'),sourceRoot=document.createElement('div');document.body.append(richRoot,sourceRoot);
      const original=prefix+'无关编辑段落\r\n\r\n正文'; let saved='';
      const session=new (window as any).SyntaxSession({write:async(_p:string,t:string)=>{saved=t;return {revision:'test'};}});session.path='D:/notes/test.md';session.edit(original);
      const surface=new (window as any).SyntaxSurface({richRoot,sourceRoot,onChange:(t:string)=>session.edit(t),resolveImage:async(s:string)=>s});
      try {
        await surface.init(original);const rich=surface.mode==='rich',untouched=surface.getMarkdown()===original,notice=surface.getRichNotice();
        const hidden=!richRoot.textContent?.includes('title:');
        surface.format('heading2');session.edit(surface.getMarkdown());await session.save();
        const kept=saved.startsWith(prefix),equivalent=(window as any).syntaxEquivalent(prefix+'## 无关编辑段落\r\n\r\n正文',saved);
        await surface.setMode('source');await surface.setMode('rich');const same=surface.getMarkdown()===saved;
        surface.format('undo');return {rich,untouched,notice,hidden,kept,equivalent,same,undone:surface.getMarkdown()===original};
      }finally{await surface.destroy();}
    },prefix);
    expect(result).toMatchObject({rich:true,untouched:true,hidden:true,kept:true,equivalent:true,same:true,undone:true});
    expect(result.notice).toContain('本文含元数据');
  },30000);

  it('does not lock comparisons or code that contains extension-like text',async()=>{
    const result=await page.evaluate(async()=>{
      const r=document.createElement('div'),s=document.createElement('div');document.body.append(r,s);
      const surface=new (window as any).SyntaxSurface({richRoot:r,sourceRoot:s,onChange:()=>{},resolveImage:async(v:string)=>v});
      try {
        const rows=[];
        for(const original of ['价格 a<b 和 x > y','`<br> ==highlight== [[link]]`','```html\n<div>代码</div>\n```','普通段落\n\n    <kbd>缩进代码</kbd>']){
          await surface.load(original);rows.push(surface.mode==='rich'&&surface.getSafetyReason()===null&&(window as any).syntaxBlocks(original).length===0);
        }
        return rows;
      }finally{await surface.destroy();}
    });
    expect(result).toEqual([true,true,true,true]);
  },30000);

  // Local fixtures run automatically when present. Never print their names/body.
  it.skipIf(privatePaths.length===0)('opens optional private samples, preserves untouched bytes and records load duration',async()=>{
    for(let index=0;index<privatePaths.length;index++){
      const bytes=readFileSync(privatePaths[index]); const original=bytes.toString('utf8');
      expect(Buffer.from(original,'utf8').equals(bytes)).toBe(true);
      const ast=unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(original);
      const candidates=ast.children.flatMap(node=>node.type==='paragraph' && node.children.every(child=>child.type==='text') ? [{from:node.position!.start.offset!,text:node.children.map(child=>(child as {value:string}).value).join('')}] : []);
      const result=await page.evaluate(async ({original,candidates})=>{
        const r=document.createElement('div'),s=document.createElement('div');document.body.append(r,s);
        const surface=new (window as any).SyntaxSurface({richRoot:r,sourceRoot:s,onChange:()=>{},resolveImage:async()=>''});
        try{
          const begin=performance.now();await surface.init(original);const ms=performance.now()-begin;
          if(surface.mode!=='rich')return {loaded:false,ms,reason:surface.getSafetyReason()};
          let saved='';const session=new (window as any).SyntaxSession({write:async(_p:string,t:string)=>{saved=t;return {revision:'test'};}});session.path='D:/private/sample.md';session.edit(surface.getMarkdown());await session.save();
          const untouched=saved===original;
          const view=surface.richView();
          let target: {pm:number,from:number}|undefined;
          for(const candidate of candidates){
            const matches: number[]=[];
            view.state.doc.forEach((node:any,pos:number)=>{if(node.type.name==='paragraph' && node.textContent===candidate.text) matches.push(pos);});
            if(matches.length===1){target={pm:matches[0]+1,from:candidate.from};break;}
          }
          if(!target)return {loaded:true,untouched,equivalent:false,preserved:false,ms};
          view.dispatch(view.state.tr.insertText('验收编辑：',target.pm));
          session.edit(surface.getMarkdown());await session.save();
          const expected=original.slice(0,target.from)+'验收编辑：'+original.slice(target.from);
          const equivalent=(window as any).syntaxEquivalent(expected,saved);
          const blocks=(window as any).syntaxBlocks(original);
          const preserved=blocks.every((b:any)=>saved.includes(b.raw));
          return {loaded:true,untouched,equivalent,preserved,ms};
        }catch{return {loaded:false};}finally{await surface.destroy().catch(()=>{});}
      },{original,candidates});
      console.log(`Private local sample ${index+1}: load ${result.ms?.toFixed(1) ?? 'unavailable'} ms`);
      expect(result.loaded).toBe(true);expect(result.untouched).toBe(true);expect(result.equivalent).toBe(true);expect(result.preserved).toBe(true);
    }
  },60000);
});
