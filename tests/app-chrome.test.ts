import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';

describe('real application menus and TOC layout',()=>{
  let server:ViteDevServer,browser:Browser,page:Page,baseURL:string;
  beforeAll(async()=>{server=await createTestServer();await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw Error('Server unavailable');baseURL='http://127.0.0.1:'+address.port;browser=await launchTestBrowser();},60000);
  afterAll(async()=>{await browser?.close();await server?.close();});
  beforeEach(async()=>{
    page=await browser.newPage({viewport:{width:1200,height:850}});
    await page.route('**/src/main.ts',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+`
      const h=window.chromeHarness={surface,session,calls:[],writes:[],real:false};
      const originalAction=action,originalFormat=surface.format.bind(surface);
      action=async name=>{h.calls.push('action:'+name);if(!h.real)return;if(name==='save'){await run(async()=>{await session.save();});return;}return originalAction(name);};
      surface.format=name=>{h.calls.push('format:'+name);if(h.real)originalFormat(name);};
      session.port.write=async(path,text)=>{h.writes.push(text);return {revision:'test'};};
      session.path='D:/验收/菜单.md';
    `});});
    await page.goto(baseURL);await page.waitForFunction(()=>!!(window as any).chromeHarness);
  });
  afterEach(async()=>{await page?.evaluate(async()=>{await (window as any).chromeHarness?.surface.destroy();});await page?.close();});

  it.each(['f','e','p','o','v','t','h'])('routes physical pointer clicks on every item in menu %s exactly once',async key=>{
    const summary=page.locator(`summary[data-menu-key="${key}"]`);
    const commands=await summary.locator('..').locator('.menu button').evaluateAll(nodes=>nodes.map(node=>({action:(node as HTMLElement).dataset.action,format:(node as HTMLElement).dataset.format})));
    for(let index=0;index<commands.length;index++){
      await summary.click();
      const button=summary.locator('..').locator('.menu button').nth(index),box=await button.boundingBox();if(!box)throw Error('Menu item not visible');
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
      const expected=commands[index].action?'action:'+commands[index].action:'format:'+commands[index].format;
      expect(await page.evaluate(()=>(window as any).chromeHarness.calls.splice(0)),`${key}:${index}`).toEqual([expected]);
      await page.evaluate(()=>document.querySelectorAll('.menubar details[open]').forEach(node=>node.removeAttribute('open')));
    }
  });

  it('saves the pending edit once through the real File -> Save click',async()=>{
    await page.evaluate(async()=>{const h=(window as any).chromeHarness;h.real=true;h.session.edit('正文\r\n');h.session.savedText='正文\r\n';await h.surface.load('正文\r\n');const view=h.surface.richView();view.dispatch(view.state.tr.insertText('新',1));});
    await page.locator('summary[data-menu-key="f"]').click();
    await page.locator('.menubar [data-action="save"] span').click();
    await page.waitForFunction(()=>(window as any).chromeHarness.writes.length>0);
    const result=await page.evaluate(()=>{const h=(window as any).chromeHarness;return {calls:h.calls,writes:h.writes,dirty:h.session.dirty,open:document.querySelectorAll('.menubar details[open]').length};});
    expect(result.calls).toEqual(['action:save']);expect(result.writes).toHaveLength(1);expect(result.writes[0]).toContain('新正文');expect(result).toMatchObject({dirty:false,open:0});
  });

  it('routes application find shortcuts and keyboard menu activation once',async()=>{
    await page.evaluate(async()=>{const h=(window as any).chromeHarness;h.real=true;await h.surface.load('查找正文\n');h.surface.focus();});
    await page.keyboard.press('Control+f');expect(await page.locator('[data-search-panel]').isVisible()).toBe(true);
    await page.getByRole('textbox',{name:'查找内容',exact:true}).fill('查找');expect(await page.locator('[data-search-count]').textContent()).toBe('1 / 1');
    await page.keyboard.press('Control+h');expect(await page.getByRole('textbox',{name:'替换为',exact:true}).isVisible()).toBe(true);
    await page.keyboard.press('Control+h');expect(await page.locator('[data-search-panel]').isVisible()).toBe(false);
    await page.keyboard.press('Alt+e');await page.locator('.menubar [data-action="find"]').focus();await page.keyboard.press('Enter');
    expect(await page.locator('[data-search-panel]').isVisible()).toBe(true);
    expect(await page.evaluate(()=>(window as any).chromeHarness.calls)).toEqual(['action:find','action:replace','action:replace','action:find']);
    expect(await page.locator('.menubar details[open]').count()).toBe(0);
  });

  it('executes the pressed command even if the dropdown closes before pointer release, without click-through',async()=>{
    await page.evaluate(()=>{
      const h=(window as any).chromeHarness;h.through=0;
      const under=document.createElement('button');under.textContent='下层按钮';under.style.cssText='position:fixed;left:0;top:29px;width:500px;height:600px;z-index:10';under.onpointerup=()=>h.through++;under.onclick=()=>h.through++;document.body.append(under);
      document.addEventListener('pointerdown',event=>{if((event.target as Element).closest('.menubar .menu button'))queueMicrotask(()=>document.querySelectorAll('.menubar details[open]').forEach(node=>node.removeAttribute('open')));},{capture:true});
    });
    await page.locator('summary[data-menu-key="f"]').click();
    const box=await page.locator('.menubar [data-action="save"]').boundingBox();if(!box)throw Error('Save item missing');
    await page.mouse.move(box.x+20,box.y+box.height/2);await page.mouse.down();await page.mouse.up();
    expect(await page.evaluate(()=>{const h=(window as any).chromeHarness;return {calls:h.calls,through:h.through};})).toEqual({calls:['action:save'],through:0});
  });

  it('aligns list markers with the first line of each heading in both themes', async () => {
    const original = [
      '- 普通项', '- # ' + '换行标题'.repeat(14), '- 下一项',
      '', '1. ## 二级', '', '* ### 三级', '',
      '- 父项', '  - #### 四级', '    同项正文', '',
      '+ ##### 五级', '', '3) ###### 六级',
    ].join('\n');
    await page.evaluate(async source => (window as any).chromeHarness.surface.load(source), original);
    for (const theme of ['light', 'dark']) {
      const rows = await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        const root = document.querySelector('.ProseMirror')!;
        const gap = (block: Element, marker: Element) => block.getBoundingClientRect().left - marker.getBoundingClientRect().right;
        const ordinary = root.querySelector('li p')!;
        const ordinaryItem = ordinary.closest('li')!;
        const ordinaryGap = gap(ordinary, ordinaryItem.querySelector(':scope > .label-wrapper > .label')!);
        const ordinaryExtraHeight = ordinaryItem.getBoundingClientRect().height - parseFloat(getComputedStyle(ordinary).lineHeight);
        return [...root.querySelectorAll('li :is(h1,h2,h3,h4,h5,h6)')].map(heading => {
          const item = heading.closest('li')!;
          const marker = item.querySelector(':scope > .label-wrapper > .label')!;
          const markerBox = marker.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(heading);
          const lines = range.getClientRects();
          return {
            level: heading.tagName, lines: lines.length,
            center: markerBox.top + markerBox.height / 2, top: lines[0].top, bottom: lines[0].bottom,
            gapDifference: gap(heading, marker) - ordinaryGap,
            extraHeight: item.getBoundingClientRect().height - lines.length * parseFloat(getComputedStyle(heading).lineHeight),
            ordinaryExtraHeight,
          };
        });
      }, theme);
      expect(rows.map(row => row.level)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
      expect(rows[0].lines).toBeGreaterThan(1);
      expect(rows[0].extraHeight).toBeLessThanOrEqual(rows[0].ordinaryExtraHeight + 1);
      for (const row of rows) {
        expect(row.center, theme + ' ' + row.level).toBeGreaterThanOrEqual(row.top);
        expect(row.center, theme + ' ' + row.level).toBeLessThanOrEqual(row.bottom);
        expect(Math.abs(row.center - (row.top + row.bottom) / 2)).toBeLessThan((row.bottom - row.top) * .15);
        expect(Math.abs(row.gapDifference)).toBeLessThan(1);
      }
    }
  });

  it('keeps TOC entries full-width horizontal rows with level indentation in both themes',async()=>{
    const original='[TOC]\n\n'+Array.from({length:9},(_,i)=>'#'.repeat(i%6+1)+' 正常横排章节标题'+i).join('\n\n')+'\n';
    await page.evaluate(async original=>{await (window as any).chromeHarness.surface.load(original);},original);
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      const result=await page.locator('[data-croquill-toc]').evaluate(node=>({width:node.getBoundingClientRect().width,rows:[...node.querySelectorAll('button')].map(button=>{const text=button.firstChild!,first=document.createRange(),last=document.createRange();first.setStart(text,0);first.setEnd(text,1);last.setStart(text,text.textContent!.length-1);last.setEnd(text,text.textContent!.length);return {width:button.getBoundingClientRect().width,first:first.getBoundingClientRect().top,last:last.getBoundingClientRect().top,padding:parseFloat(getComputedStyle(button).paddingLeft)};})}));
      for(const row of result.rows){expect(row.width).toBeGreaterThan(result.width*.95);expect(Math.abs(row.last-row.first)).toBeLessThan(2);}
      expect(result.rows[1].padding-result.rows[0].padding).toBeGreaterThan(10);
    }
    expect(await page.evaluate(()=>(window as any).chromeHarness.surface.getMarkdown())).toBe(original);
  });
});
