import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createTestServer } from './server';
import { launchTestBrowser } from './browser';

describe('compact folder navigation', () => {
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
    page = await browser.newPage();
    await page.route('**/sidebar-test', route => route.fulfill({contentType:'text/html',body:'<!doctype html><div id="files"></div>'}));
    await page.goto(baseURL + '/sidebar-test');
    await page.addScriptTag({type:'module', content: `
      import { FileSidebar } from '/src/sidebar.ts';
      const h=window.sidebarTest={opened:[],errors:[],calls:[],selected:'D:/笔记 文件',listings:{},pending:{}};
      h.listings['D:/笔记 文件']={root:'D:/笔记 文件',path:'D:/笔记 文件',entries:[
        {name:'章节',path:'D:/笔记 文件/章节',isDirectory:true},
        {name:'中文 文件.md',path:'D:/笔记 文件/中文 文件.md',isDirectory:false},
        {name:'<b>文件.md',path:'D:/笔记 文件/<b>文件.md',isDirectory:false},
      ]};
      h.listings['D:/笔记 文件/章节']={root:'D:/笔记 文件',path:'D:/笔记 文件/章节',entries:[
        {name:'子文档.md',path:'D:/笔记 文件/章节/子文档.md',isDirectory:false},
      ]};
      h.create=()=>h.sidebar=new FileSidebar({root:document.querySelector('#files'),
        pickFolder:async()=>h.selected,
        listFolder:async(root,path)=>{
          h.calls.push([root,path]);const key=path||root;
          if(h.pending[key])return new Promise((resolve,reject)=>h.pending[key]={resolve,reject});
          const listing=h.listings[key];if(!listing)throw Error('文件夹不存在');return listing;
        },
        openFile:async path=>{h.opened.push(path);},onError:error=>h.errors.push(error),
      });
    `});
    await page.waitForFunction(() => !!(window as any).sidebarTest);
  });
  afterEach(async () => { await page?.close(); });

  it('loads folders lazily, opens Chinese paths, and renders filenames as text', async () => {
    await page.evaluate(async()=>{const h=(window as any).sidebarTest;h.create();await h.sidebar.chooseFolder();});
    expect(await page.locator('.file-row').allTextContents()).toEqual(['›章节','中文 文件.md','<b>文件.md']);
    expect(await page.locator('.file-tree b').count()).toBe(0);
    expect(await page.evaluate(()=>(window as any).sidebarTest.calls.length)).toBe(1);
    await page.getByRole('button',{name:'章节',exact:true}).click();
    await page.getByRole('button',{name:'子文档.md',exact:true}).waitFor();
    expect(await page.evaluate(()=>(window as any).sidebarTest.calls.length)).toBe(2);
    await page.getByRole('button',{name:'子文档.md',exact:true}).click();
    expect(await page.evaluate(()=>(window as any).sidebarTest.opened)).toEqual(['D:/笔记 文件/章节/子文档.md']);
    await page.getByRole('button',{name:'章节',exact:true}).click();
    await page.getByRole('button',{name:'章节',exact:true}).click();
    expect(await page.evaluate(()=>(window as any).sidebarTest.calls.length)).toBe(2);
  });

  it('highlights only the actual document and handles Windows path separators/case', async () => {
    await page.evaluate(async()=>{const h=(window as any).sidebarTest;h.create();await h.sidebar.chooseFolder();h.sidebar.setActiveFile('d:\\笔记 文件\\中文 文件.md');});
    expect(await page.locator('[aria-current="page"]').textContent()).toBe('中文 文件.md');
    await page.getByRole('button',{name:'<b>文件.md',exact:true}).click();
    // An attempted open can be cancelled by the session; selection waits for setActiveFile.
    expect(await page.locator('[aria-current="page"]').textContent()).toBe('中文 文件.md');
    await page.evaluate(()=>(window as any).sidebarTest.sidebar.setActiveFile(null));
    expect(await page.locator('[aria-current="page"]').count()).toBe(0);
  });

  it('keeps the current folder when the picker is cancelled and refreshes explicitly', async () => {
    await page.evaluate(async()=>{const h=(window as any).sidebarTest;h.create();await h.sidebar.chooseFolder();h.selected=null;await h.sidebar.chooseFolder();});
    expect(await page.locator('.file-root-name').textContent()).toBe('笔记 文件');
    expect(await page.evaluate(()=>(window as any).sidebarTest.calls.length)).toBe(1);
    await page.getByRole('button',{name:'刷新文件夹',exact:true}).click();
    await page.waitForFunction(()=>(window as any).sidebarTest.calls.length===2);
    expect(await page.evaluate(()=>localStorage.getItem('croquill-folder'))).toBe('D:/笔记 文件');
  });

  it('does not let slow remembered-folder restoration replace a newly chosen root', async () => {
    await page.evaluate(async()=>{
      const h=(window as any).sidebarTest;localStorage.setItem('croquill-folder','D:/旧目录');h.pending['D:/旧目录']=true;h.create();
      await h.sidebar.chooseFolder();
      h.pending['D:/旧目录'].resolve({root:'D:/旧目录',path:'D:/旧目录',entries:[]});
    });
    await page.waitForTimeout(30);
    expect(await page.locator('.file-root-name').textContent()).toBe('笔记 文件');
    expect(await page.locator('.file-row').count()).toBe(3);
    expect(await page.evaluate(()=>localStorage.getItem('croquill-folder'))).toBe('D:/笔记 文件');
  });

  it('offers recovery after a remembered folder is missing without opening any document', async () => {
    await page.evaluate(()=>{localStorage.setItem('croquill-folder','D:/已删除');(window as any).sidebarTest.create();});
    await page.locator('.file-error').waitFor();
    expect(await page.locator('.file-error').textContent()).toContain('文件夹不存在');
    expect(await page.evaluate(()=>(window as any).sidebarTest.opened)).toEqual([]);
    await page.getByRole('button',{name:'打开文件夹',exact:true}).click();
    await page.locator('.file-row').first().waitFor();
    expect(await page.locator('.file-error').count()).toBe(0);
  });

  it('ignores child results after refresh and retries unreadable child folders', async () => {
    await page.evaluate(async()=>{const h=(window as any).sidebarTest;h.create();await h.sidebar.chooseFolder();h.pending['D:/笔记 文件/章节']=true;});
    await page.getByRole('button',{name:'章节',exact:true}).click();
    await page.getByRole('button',{name:'刷新文件夹',exact:true}).click();
    await page.waitForFunction(()=>(window as any).sidebarTest.calls.length===3);
    await page.evaluate(()=>{const h=(window as any).sidebarTest;h.pending['D:/笔记 文件/章节'].resolve(h.listings['D:/笔记 文件/章节']);delete h.pending['D:/笔记 文件/章节'];delete h.listings['D:/笔记 文件/章节'];});
    expect(await page.getByRole('button',{name:'子文档.md',exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'章节',exact:true}).click();
    await page.locator('.file-error').waitFor();
    await page.evaluate(()=>{(window as any).sidebarTest.listings['D:/笔记 文件/章节']={root:'D:/笔记 文件',path:'D:/笔记 文件/章节',entries:[]};});
    await page.getByRole('button',{name:'章节',exact:true}).click();
    await page.getByRole('button',{name:'章节',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.file-error'));
    expect(await page.locator('.file-empty').textContent()).toBe('没有 Markdown 文档');
  });
});
