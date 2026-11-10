import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';
import { preservedMarkdownBlocks } from '../src/fidelity';
import { readFileSync } from 'node:fs';

const parser = unified().use(remarkParse).use(remarkGfm);
const definition = '[^Ab]:  第一段 __原写法__。\n\n    第二段带 ==高亮==。\n\n    - 子项甲\n    - 子项乙';

describe('TOC and complete footnote protection boundaries', () => {
  it.each(['[TOC]', '[toc]', '正文[^x]尚无定义', '正文[^Ab]\n\n' + definition, '- 引用[^a]\n\n[^a]: 注释'])('releases supported syntax: %s', original => {
    expect(preservedMarkdownBlocks(original)).toEqual([]);
  });
  it.each([
    '正文[^a]与[[双链]]\n\n[^a]: 说明',
    '[^a]: 第一段\n\n    第二段有[[双链]]。',
    '- [TOC]\n- [[双链]]',
    '<div>\n[TOC]\n</div>',
    '段内 [TOC] 继续保护',
  ])('keeps other unsupported syntax opaque: %s', original => {
    expect(preservedMarkdownBlocks(original).length).toBeGreaterThan(0);
  });
});

describe('live TOC and editable complete footnotes', () => {
  let server: ViteDevServer, browser: Browser, page: Page, baseURL: string;
  beforeAll(async () => {
    server = await createTestServer(); await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Test server unavailable');
    baseURL = 'http://127.0.0.1:' + address.port;
    browser = await launchTestBrowser();
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(baseURL + '/tests/harness.html');
    await page.addStyleTag({ url: baseURL + '/src/style.css' });
    await page.addScriptTag({ type: 'module', content: `
      import { MarkdownSurface } from '/src/editor.ts';
      const richRoot=document.createElement('div'),sourceRoot=document.createElement('div');document.body.append(richRoot,sourceRoot);
      const h=window.notesHarness={richRoot,sourceRoot,dirty:0,changes:[],serializations:0};
      h.surface=new MarkdownSurface({richRoot,sourceRoot,onChange:text=>h.changes.push(text),onDirty:()=>h.dirty++,resolveImage:async src=>src});
      const serialize=h.surface.serializeRich.bind(h.surface);h.surface.serializeRich=()=>{h.serializations++;return serialize();};
      h.selectText=(text,offset=0,length=0)=>{const view=h.surface.richView();let position;
        view.state.doc.descendants((node,pos)=>{if(node.isText&&node.text.includes(text)&&position===undefined)position=pos+node.text.indexOf(text)+offset;});
        if(position===undefined)throw Error('Text missing: '+text);
        const selection=view.state.selection.constructor.near(view.state.doc.resolve(position));
        view.dispatch(view.state.tr.setSelection(selection.constructor.create(view.state.doc,position,position+length)));view.focus();};
      h.insert=text=>{const view=h.surface.richView();view.dispatch(view.state.tr.insertText(text));};
    ` });
    await page.waitForFunction(() => 'notesHarness' in window);
  });
  afterEach(async () => {
    await page?.evaluate(async () => { await (window as any).notesHarness?.surface.destroy(); });
    await page?.close();
  });

  it('opens the acceptance sample with live TOC and complete definitions, preserving all original bytes',async()=>{
    const original=readFileSync(new URL('../examples/toc-footnotes.md',import.meta.url),'utf8');
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);return {mode:h.surface.mode,reason:h.surface.getSafetyReason(),saved:h.surface.getMarkdown(),toc:h.richRoot.querySelectorAll('[data-croquill-toc]').length,definitions:h.richRoot.querySelectorAll('[data-footnote-definition]').length,orphans:h.richRoot.querySelectorAll('[data-footnote-orphan]').length};},original);
    expect(result).toMatchObject({mode:'rich',reason:null,saved:original,toc:1,definitions:2});expect(result.orphans).toBeGreaterThan(0);
  });

  it('renders a noneditable TOC containing all heading levels, nested headings and duplicate titles', async () => {
    const original='[TOC]\n\n# 第一章 **粗体**\n\n### 同名\n\n> ## 引用标题\n\n- 项目\n\n  #### 列表标题\n\n###### 同名\n\n```md\n# 不是真标题\n```\n';
    const result=await page.evaluate(async original=>{
      const h=(window as any).notesHarness;await h.surface.init(original);
      const toc=h.richRoot.querySelector('[data-croquill-toc]');
      return {mode:h.surface.mode,raw:h.richRoot.querySelectorAll('[data-croquill-raw]').length,editable:toc?.isContentEditable,
        entries:[...(toc?.querySelectorAll('button')||[])].map(node=>({text:node.textContent,level:node.getAttribute('data-level')})),saved:h.surface.getMarkdown()};
    },original);
    expect(result).toMatchObject({mode:'rich',raw:0,editable:false,saved:original});
    expect(result.entries).toEqual([{text:'第一章 粗体',level:'1'},{text:'同名',level:'3'},{text:'引用标题',level:'2'},{text:'列表标题',level:'4'},{text:'同名',level:'6'}]);
  });

  it('updates TOC text and levels directly from editor state without forcing serialization', async () => {
    const result=await page.evaluate(async()=>{
      const h=(window as any).notesHarness;await h.surface.init('[TOC]\n\n# 标题\n\n正文\n');
      h.selectText('标题');h.serializations=0;h.insert('新');
      const typed={entry:h.richRoot.querySelector('[data-croquill-toc] button')?.textContent,serializations:h.serializations};
      h.surface.format('heading3');
      const level=h.richRoot.querySelector('[data-croquill-toc] button')?.getAttribute('data-level');
      h.surface.format('paragraph');const removed=h.richRoot.querySelectorAll('[data-croquill-toc] button').length;
      h.selectText('正文');h.surface.format('heading2');
      return {typed,level,removed,added:h.richRoot.querySelector('[data-croquill-toc] button')?.textContent};
    });
    expect(result).toEqual({typed:{entry:'新标题',serializations:0},level:'3',removed:0,added:'正文'});
  });

  it('navigates to the selected duplicate heading without marking the document dirty', async () => {
    const original='[TOC]\n\n# 同名\n\n正文\n\n## 同名\n';
    await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);h.dirty=0;h.changes=[];},original);
    await page.locator('[data-croquill-toc] button').nth(1).click();
    const result=await page.evaluate(()=>{const h=(window as any).notesHarness;const view=h.surface.richView();return {text:view.state.selection.$from.parent.textContent,level:view.state.selection.$from.parent.attrs.level,dirty:h.dirty,changes:h.changes,saved:h.surface.getMarkdown()};});
    expect(result).toEqual({text:'同名',level:2,dirty:0,changes:[],saved:original});
  });

  it('creates a TOC with Enter and leaves composing Enter alone', async () => {
    await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.init('[TOC]\n\n# 章节\n');});
    // Existing nodes are protected from editing their generated entries.
    expect(await page.locator('[data-croquill-toc] button').count()).toBe(1);
    await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.load('目录位置\n\n# 章节\n');h.selectText('目录位置',0,4);});
    await page.keyboard.insertText('[TOC]');
    const before=await page.evaluate(()=>{const h=(window as any).notesHarness,view=h.surface.richView();const e=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});view.dom.dispatchEvent(e);return h.richRoot.querySelectorAll('[data-croquill-toc]').length;});
    expect(before).toBe(0);
    await page.keyboard.press('Enter');
    expect(await page.locator('[data-croquill-toc]').count()).toBe(1);
    expect(await page.evaluate(()=>(window as any).notesHarness.surface.getMarkdown())).toContain('[TOC]');
  });

  it.each(['LF','CRLF'])('preserves untouched %s bytes, including marker case and multiparagraph definitions, over modes and reopen', async newline=>{
    let original='\uFEFF[tOc]\n\n# 标题\n\n正文[^Ab]与[^孤立]\n\n'+definition;
    if(newline==='CRLF')original=original.replace(/\n/g,'\r\n');
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);const saved=h.surface.getMarkdown();for(let i=0;i<3;i++){await h.surface.setMode('source');await h.surface.setMode('rich');}const switched=h.surface.getMarkdown();await h.surface.load(switched);return {mode:h.surface.mode,raw:h.richRoot.querySelectorAll('[data-croquill-raw]').length,saved,switched,reopened:h.surface.getMarkdown()};},original);
    expect(result).toEqual({mode:'rich',raw:0,saved:original,switched:original,reopened:original});
  });

  it.each(['LF','CRLF'])('keeps TOC, references, orphan and complete definition literal while editing elsewhere (%s)',async newline=>{
    let original='改这里\n\n[TOC]\n\n# 标题\n\n原文[^Ab]与[^x]。\n\n'+definition+'\n';
    if(newline==='CRLF')original=original.replace(/\n/g,'\r\n');
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);h.selectText('改这里');h.insert('新');const saved=h.surface.getMarkdown();await h.surface.setMode('source');await h.surface.setMode('rich');return {saved,switched:h.surface.getMarkdown()};},original);
    const eol=newline==='CRLF'?'\r\n':'\n';
    expect(result.saved).toContain('[TOC]'+eol+eol);
    expect(result.saved).toContain('原文[^Ab]与[^x]。'+eol+eol);
    expect(result.saved).toContain((newline==='CRLF'?definition.replace(/\n/g,'\r\n'):definition)+eol);
    expect(result.saved).toMatch(/^新改这里/);expect(result.switched).toBe(result.saved);
  });

  it('shows an editable multi-paragraph definition as one block, not ordinary body paragraphs',async()=>{
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);const def=h.richRoot.querySelector('[data-footnote-definition]');return {mode:h.surface.mode,blocks:h.richRoot.querySelectorAll('[data-footnote-definition]').length,paragraphs:[...(def?.querySelectorAll('dd > p')||[])].map(node=>node.textContent),editable:(def?.querySelector('dd') as HTMLElement)?.isContentEditable,loose:[...h.richRoot.querySelectorAll('.ProseMirror > p')].map(node=>node.textContent)};},'正文[^Ab]\n\n'+definition+'\n');
    expect(result).toMatchObject({mode:'rich',blocks:1,paragraphs:['第一段 原写法。','第二段带 高亮。'],editable:true});
    expect(result.loose.join('')).not.toContain('第二段');
  });

  it.each(['LF','CRLF'])('edits the second paragraph while retaining definition ownership and indentation (%s)',async newline=>{
    let original='正文[^1]\n\n[^1]: 第一段。\n\n    第二段。\n\n文末普通正文\n';if(newline==='CRLF')original=original.replace(/\n/g,'\r\n');
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);h.selectText('第二段',1);h.insert('新');const saved=h.surface.getMarkdown();await h.surface.load(saved);return {saved,paragraphs:[...h.richRoot.querySelectorAll('[data-footnote-definition] dd > p')].map(node=>node.textContent),body:[...h.richRoot.querySelectorAll('.ProseMirror > p')].map(node=>node.textContent)};},original);
    const tree=parser.parse(result.saved);const def=tree.children.find(node=>node.type==='footnoteDefinition');
    expect(def?.type==='footnoteDefinition'&&def.children.filter(node=>node.type==='paragraph').length).toBe(2);
    expect(result.paragraphs).toEqual(['第一段。','第新二段。']);expect(result.body.join('')).toContain('文末普通正文');
    expect(result.saved).toMatch(/(?:\r?\n){2} {4}第新二段。/);
  });

  it('hovers the current full footnote text and clicks through to its editable definition',async()=>{
    await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.init('正文[^n]\n\n[^n]: 第一段\n\n    第二段\n');h.selectText('第二段');h.insert('新');});
    await page.locator('sup[data-footnote-reference]').hover();
    await page.locator('[data-footnote-tooltip]').waitFor({state:'visible'});
    expect(await page.locator('[data-footnote-tooltip]').textContent()).toContain('第一段');
    expect(await page.locator('[data-footnote-tooltip]').textContent()).toContain('新第二段');
    await page.locator('sup[data-footnote-reference]').click();
    const result=await page.evaluate(()=>{const view=(window as any).notesHarness.surface.richView();return Array.from({length:view.state.selection.$from.depth},(_,i)=>view.state.selection.$from.node(i+1).type.name);});
    expect(result).toContain('footnote_definition');
  });

  // Found in the 0.4.0 desktop pass: the table block swallowed the click inside a cell.
  it.each(['table cell','table header'])('clicks through from a reference inside a %s',async where=>{
    const source=where==='table cell'?'| 项目 | 内容 |\n| --- | --- |\n| 脚注 | 第一处[^n]说明 |\n\n[^n]: 定义内容\n':'| 项目[^n] | 内容 |\n| --- | --- |\n| 甲 | 乙 |\n\n[^n]: 定义内容\n';
    await page.evaluate(async source=>{const h=(window as any).notesHarness;await h.surface.init(source);h.dirty=0;},source);
    await page.locator('sup[data-footnote-reference]').click();
    // The table block re-selects the cell on a later frame; let that frame pass first.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,40)))));
    const result=await page.evaluate(()=>{const h=(window as any).notesHarness,view=h.surface.richView();return {path:Array.from({length:view.state.selection.$from.depth},(_,i)=>view.state.selection.$from.node(i+1).type.name),saved:h.surface.getMarkdown()};});
    expect(result.path).toContain('footnote_definition');expect(result.saved).toBe(source);
  });

  it('keeps isolated references literal and unescaped after editing their surrounding paragraph',async()=>{
    const result=await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.init('前[^x]与[^中文 标签]后\n');h.selectText('后');h.insert('新');const saved=h.surface.getMarkdown();await h.surface.load(saved);return {saved,text:h.richRoot.querySelector('.ProseMirror > p')?.textContent,orphans:h.richRoot.querySelectorAll('[data-footnote-orphan]').length};});
    expect(result).toEqual({saved:'前[^x]与[^中文 标签]新后\n',text:'前[^x]与[^中文 标签]新后',orphans:2});
  });

  it('keeps isolated references on every line of a CRLF paragraph unescaped after editing',async()=>{
    const result=await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.init('前[^x]。\r\n续行[^y]后\r\n');const count=h.richRoot.querySelectorAll('[data-footnote-orphan]').length;h.selectText('续行');h.insert('新');return {count,saved:h.surface.getMarkdown()};});
    expect(result.count).toBe(2);expect(result.saved).toContain('前[^x]。');expect(result.saved).toContain('新续行[^y]后');expect(result.saved).not.toContain('\\[');
  });

  it('turns newly typed footnote markers into live references and leaves inline code literal',async()=>{
    await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.init('正文\n\n[^n]: 注释内容\n');h.selectText('正文',2);});
    await page.keyboard.type('[^n]');
    const result=await page.evaluate(()=>{const h=(window as any).notesHarness;return {reference:h.richRoot.querySelector('sup[data-footnote-reference]:not([data-footnote-orphan])')?.textContent,saved:h.surface.getMarkdown()};});
    expect(result.reference).toBe('n');expect(result.saved).toContain('正文[^n]');
    await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.load('`代码`\n');h.selectText('代码',1);});
    await page.keyboard.type('[^x]');
    expect(await page.locator('sup[data-footnote-reference]').count()).toBe(0);
    expect(await page.locator('code').textContent()).toContain('[^x]');
  });

  it.each(['LF','CRLF'])('preserves footnote and orphan table cells when another cell changes (%s)',async newline=>{
    let original='|   引用  | 原文 |\n| :------ | ---: |\n| 前[^n]与[^x]后 | 修改 |\n\n[^n]: 注释\n\n    第二段\n';if(newline==='CRLF')original=original.replace(/\n/g,'\r\n');
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);h.selectText('修改');h.insert('新');return h.surface.getMarkdown();},original);
    expect(result).toBe(original.replace('修改','新修改'));
  });

  it('keeps Enter-created paragraphs inside a footnote definition over save and reopen',async()=>{
    await page.evaluate(async()=>{const h=(window as any).notesHarness;await h.surface.init('正文[^n]\n\n[^n]: 第一段\n\n    第二段\n');h.selectText('第二段',3);});
    await page.keyboard.press('Enter');await page.keyboard.insertText('第三段');
    const result=await page.evaluate(async()=>{const h=(window as any).notesHarness;const saved=h.surface.getMarkdown();await h.surface.load(saved);return {saved,paragraphs:[...h.richRoot.querySelectorAll('[data-footnote-definition] dd > p')].map(node=>node.textContent)};});
    expect(result.paragraphs).toEqual(['第一段','第二段','第三段']);
    const tree=parser.parse(result.saved),def=tree.children.find(node=>node.type==='footnoteDefinition');
    expect(def?.type==='footnoteDefinition'&&def.children.length).toBe(3);
  });

  it('keeps standalone HTML breaks inside the footnote definition',async()=>{
    const original='修改正文[^n]\n\n[^n]: 首段\n\n    <br/>\n\n    第二段\n';
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);const mode=h.surface.mode,breaks=h.richRoot.querySelectorAll('[data-footnote-definition] br').length;h.selectText('修改正文');h.insert('新');const saved=h.surface.getMarkdown();await h.surface.load(saved);return {mode,saved,breaks,after:h.richRoot.querySelectorAll('[data-footnote-definition] br').length};},original);
    expect(result.mode).toBe('rich');expect(result.breaks).toBeGreaterThan(0);expect(result.after).toBeGreaterThan(0);expect(result.saved).toContain(original.slice(original.indexOf('[^n]:')));
  });

  it.each(['event flag','active composition'])('leaves reference-adjacent Backspace to the IME (%s)',async kind=>{
    const result=await page.evaluate(async kind=>{const h=(window as any).notesHarness;await h.surface.init('前[^n]后\n\n[^n]: 说明\n');h.selectText('后');const view=h.surface.richView(),before=view.state.doc,position=view.state.selection.from;
      if(kind==='active composition')view.dom.dispatchEvent(new CompositionEvent('compositionstart',{data:'组',bubbles:true}));
      const event=new KeyboardEvent('keydown',{key:'Backspace',isComposing:kind==='event flag',bubbles:true,cancelable:true});view.dom.dispatchEvent(event);
      const unchanged=view.state.doc.eq(before)&&view.state.selection.from===position,prevented=event.defaultPrevented;h.insert('组词');
      if(kind==='active composition')view.dom.dispatchEvent(new CompositionEvent('compositionend',{data:'组词',bubbles:true}));
      return {unchanged,prevented,saved:h.surface.getMarkdown()};},kind);
    expect(result).toMatchObject({unchanged:true,prevented:false});expect(result.saved).toContain('前[^n]组词后');
  });

  it('keeps mixed formatting and literal equals around footnotes inside a highlight',async()=>{
    const original='前==**粗体**与[^n]、[^x]==后\n\n[^n]: 注释\n';
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);h.selectText('后');h.insert('新');const saved=h.surface.getMarkdown();await h.surface.load(saved);return {saved,mark:h.richRoot.querySelector('mark')?.textContent,reference:h.richRoot.querySelector('mark [data-footnote-reference], [data-footnote-reference] mark')?.textContent};},original);
    expect(result.saved).toBe(original.replace('==后','==新后'));expect(result.reference).toBe('n');expect(result.mark).toContain('粗体');
  });

  it('turns a removed definition into a literal orphan and restores it with undo',async()=>{
    const result=await page.evaluate(async()=>{const h=(window as any).notesHarness;const original='前[^A]后\n\n[^a]: 说明\n';await h.surface.init(original);const view=h.surface.richView();let range;view.state.doc.descendants((node,pos)=>{if(node.type.name==='footnote_definition')range={from:pos,to:pos+node.nodeSize};});if(!range)throw Error('Definition missing');view.dispatch(view.state.tr.delete(range.from,range.to));const saved=h.surface.getMarkdown(),orphan=h.richRoot.querySelector('[data-footnote-orphan]')?.textContent;h.surface.format('undo');return {saved,orphan,undone:h.surface.getMarkdown(),original};});
    expect(result.saved).toContain('前[^A]后');expect(result.saved).not.toContain('\\[');expect(result.orphan).toBe('[^A]');expect(result.undone).toBe(result.original);
  });

  it('does not treat escaped or code markers as a TOC or footnote reference',async()=>{
    const original='\\[TOC]\n\n`[^x]` 与 \\[^y] 和 ` [TOC] `\n\n```md\n[TOC]\n[^n]: 代码\n```\n';
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);return {toc:h.richRoot.querySelectorAll('[data-croquill-toc]').length,refs:h.richRoot.querySelectorAll('[data-footnote-reference]').length,saved:h.surface.getMarkdown()};},original);
    expect(result).toEqual({toc:0,refs:0,saved:original});
  });

  it('keeps a whole definition protected when its second paragraph contains other unsupported syntax',async()=>{
    const original='正文[^n]\n\n[^n]: 第一段\n\n    第二段 [[双链]]\n\n结尾\n';
    const result=await page.evaluate(async original=>{const h=(window as any).notesHarness;await h.surface.init(original);return {raw:[...h.richRoot.querySelectorAll('[data-croquill-raw]')].map(node=>node.textContent),loose:[...h.richRoot.querySelectorAll('.ProseMirror > p')].map(node=>node.textContent),saved:h.surface.getMarkdown()};},original);
    expect(result.raw).toHaveLength(1);expect(result.raw[0]).toContain('    第二段 [[双链]]');expect(result.loose.join('')).not.toContain('第二段');expect(result.saved).toBe(original);
  });
});
