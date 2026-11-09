import type { Page } from '@playwright/test';

export const currentFile = 'D:/验收/当前.md';
export const currentText = '# 标题\n\n原文<span>片段</span>尾。\n\n<div>\n原文块\n</div>\n';

/** Run the production app, mocking only the native filesystem/dialog boundary. */
export async function openFileApp(page: Page, baseURL: string, config: Record<string, unknown> = {}) {
  await page.route('**/src/main.ts', async route => {
    const response = await route.fetch();
    const setup = `
      import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
      window.isTauri=true;mockWindows('main');
      const h=window.fileApp={calls:[],writes:[],files:{[${JSON.stringify(currentFile)}]:${JSON.stringify(currentText)}},initial:${JSON.stringify(currentFile)},openSelected:null,saveSelected:null,...${JSON.stringify(config)}};
      const dropBridge=new EventTarget();h.drops=[];
      dropBridge.postMessageWithAdditionalObjects=(message,files)=>{
        h.drops.push(files.map(file=>file.name));
        queueMicrotask(()=>dropBridge.dispatchEvent(new MessageEvent('message',{data:message+':'+(h.dropError?'error\\n'+h.dropError:'ok\\n'+h.dropPath)})));
      };
      (window.chrome||={}).webview=dropBridge;
      mockIPC(async(cmd,args)=>{
        h.calls.push({cmd,args});
        if(cmd==='initial_path')return h.initial;
        if(cmd==='plugin:dialog|open')return h.openSelected;
        if(cmd==='plugin:dialog|save')return h.saveSelected;
        if(cmd==='document_exists')return Object.hasOwn(h.files,args.path);
        if(cmd==='read_document'){
          if(h.readError)throw h.readError;
          if(!Object.hasOwn(h.files,args.path))throw '文件不存在';
          const text=h.files[args.path];return {path:args.path,text,bom:false,newline:text.includes('\\r\\n')?'crlf':'lf',revision:'test-revision'};
        }
        if(cmd==='write_document'){
          if(h.writeError)throw h.writeError;
          h.writes.push(args);if(h.holdWrite)await new Promise(resolve=>h.releaseWrite=resolve);
          h.files[args.path]=args.text;return {revision:'saved-revision'};
        }
        if(cmd==='read_local_image')return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqQAAAAASUVORK5CYII=';
        if(cmd==='rebase_image_paths'){if(h.imageError)throw h.imageError;return args.sources.map(src=>'../验收/'+src.split(/[?#]/)[0].replace(/ /g,'%20'));}
        if(cmd==='import_image')return '当前.assets/图片.png';
        if(cmd==='list_document_folder')return {root:args.root,path:args.path||args.root,entries:[{name:'当前.md',path:${JSON.stringify(currentFile)},isDirectory:false}]};
        return null;
      },{shouldMockEvents:true});
    `;
    await route.fulfill({ response, body: setup + await response.text() + `
      Object.assign(h,{surface,session,fileSidebar,setSidebarTab,action,run,updateStats});
      h.captureCommands=()=>{action=async name=>{(h.commands||=[]).push(name);};};
      h.ready=true;
    ` });
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => !!(window as any).fileApp?.ready || !!document.querySelector('.app-dialog'));
}

export async function focusApp(page: Page, location: string) {
  await page.evaluate(async location => {
    const h = (window as any).fileApp;
    if (location === 'source') { await h.surface.setMode('source'); h.surface.focus(); return; }
    await h.surface.setMode('rich');
    if (location === 'find' || location === 'replace') {
      h.surface.openSearch(location === 'replace');
      if (location === 'replace') (document.querySelector('[aria-label="替换为"]') as HTMLElement).focus();
    } else if (location === 'tree') {
      h.fileSidebar.options.pickFolder = async () => 'D:/验收'; await h.fileSidebar.chooseFolder(); h.setSidebarTab('files');
      (document.querySelector('#files-pane .file-row') as HTMLElement).focus();
    } else if (location === 'outline') {
      h.updateStats(); h.setSidebarTab('outline'); (document.querySelector('#outline button') as HTMLElement).focus();
    } else if (location === 'menu') {
      (document.querySelector('.menubar details') as HTMLDetailsElement).open = true;
      (document.querySelector('.menubar [data-action="save"]') as HTMLElement).focus();
    } else {
      const view = h.surface.richView();
      if (location === 'inline' || location === 'raw') {
        let position: number | undefined;
        view.state.doc.descendants((node: any, pos: number) => { if (position === undefined && node.type.name === (location === 'inline' ? 'croquill_inline_raw' : 'croquill_raw')) position = pos; });
        if (position === undefined && location === 'raw') view.state.doc.descendants((node: any, pos: number) => { if (node.type.name.includes('raw') && !node.isInline) position = pos; });
        if (position === undefined) throw Error('Missing raw node');
        view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(position))));
      }
      view.focus();
    }
  }, location);
}
