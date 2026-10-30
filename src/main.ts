import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { createIcons, PanelLeft, Code2 } from 'lucide';
import { MarkdownSurface } from './editor';
import { ImageImporter, type ImageSource } from './images';
import { DocumentSession, type DocumentFile } from './session';
import { protectFileDrops } from './file-drop';
import { FileSidebar, type FolderListing } from './sidebar';
import { markdownOutline } from './fidelity';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="menubar">
  <nav aria-label="菜单">
    <details><summary data-menu-key="f">文件(F)</summary><div class="menu">
      <button data-action="new">新建<span>Ctrl+N</span></button><button data-action="open">打开…<span>Ctrl+O</span></button><button data-action="folder">打开文件夹…<span>Ctrl+Shift+O</span></button><hr>
      <button data-action="save">保存<span>Ctrl+S</span></button><button data-action="saveAs">另存为…<span>Ctrl+Shift+S</span></button>
    </div></details>
    <details><summary data-menu-key="e">编辑(E)</summary><div class="menu"><button data-format="undo">撤销<span>Ctrl+Z</span></button><button data-format="redo">重做<span>Ctrl+Y</span></button></div></details>
    <details><summary data-menu-key="p">段落(P)</summary><div class="menu"><button data-format="heading1">一级标题<span>Ctrl+1</span></button><button data-format="heading2">二级标题<span>Ctrl+2</span></button><button data-format="heading3">三级标题<span>Ctrl+3</span></button><hr><button data-format="bullet">无序列表</button><button data-format="ordered">有序列表</button><button data-format="task">任务列表</button><button data-format="quote">引用</button><button data-format="codeblock">代码块</button><button data-format="table">插入表格</button><button data-action="image">图片</button></div></details>
    <details><summary data-menu-key="o">格式(O)</summary><div class="menu"><button data-format="bold">加粗<span>Ctrl+B</span></button><button data-format="italic">斜体<span>Ctrl+I</span></button><button data-format="strike">删除线</button><button data-format="link">链接<span>Ctrl+K</span></button><button data-format="code">行内代码</button></div></details>
    <details><summary data-menu-key="v">视图(V)</summary><div class="menu"><button data-action="mode">切换源码模式<span>Ctrl+/</span></button><button data-action="sidebar">显示／隐藏侧栏<span>Ctrl+Shift+L</span></button><button data-action="files">文件侧栏</button><button data-action="outline">大纲侧栏</button><hr><button data-action="smaller">缩小字号</button><button data-action="larger">放大字号</button></div></details>
    <details><summary data-menu-key="t">主题(T)</summary><div class="menu"><button data-action="light">GitHub · 浅色</button><button data-action="dark">Night · 深色</button></div></details>
    <details><summary data-menu-key="h">帮助(H)</summary><div class="menu"><button data-action="help">使用说明</button></div></details>
  </nav>
  <div class="document-label" title=""><span id="dirty-dot" hidden></span><span id="filename">未命名</span></div>
</header>
<div class="workspace">
  <aside id="sidebar" aria-label="文件与大纲">
    <div class="sidebar-tabs" role="tablist" aria-label="侧栏内容"><button id="files-tab" role="tab" aria-controls="files-pane" aria-selected="true">文件</button><button id="outline-tab" role="tab" aria-controls="outline-pane" aria-selected="false" tabindex="-1">大纲<span id="heading-count"></span></button></div>
    <div id="files-pane" class="sidebar-pane" role="tabpanel" aria-labelledby="files-tab"></div>
    <div id="outline-pane" class="sidebar-pane" role="tabpanel" aria-labelledby="outline-tab" hidden><div id="outline"></div></div>
    <div id="sidebar-resize" role="separator" aria-label="侧栏宽度" aria-orientation="vertical" aria-valuemin="180" aria-valuemax="400" aria-valuenow="220" tabindex="0"></div>
  </aside>
  <main id="main"><div id="notice" role="status" hidden></div><div id="editor-scroll"><div id="rich-root"></div><div id="source-root" hidden></div></div></main>
</div>
<footer class="statusbar"><div class="status-left"><button class="icon-button" data-action="sidebar" title="显示／隐藏侧栏 Ctrl+Shift+L" aria-label="显示／隐藏侧栏" aria-expanded="true"><i data-lucide="panel-left"></i></button><button data-action="mode" id="mode-button" title="切换源码模式 Ctrl+/"><i data-lucide="code-2"></i><span>所见即所得</span></button><span id="save-status">准备就绪</span></div><div class="status-right"><span id="encoding">UTF-8</span><span id="newline">LF</span><span class="status-separator">·</span><span id="word-count">0 字</span></div></footer>
<div id="modal-root"></div><div id="toast" role="status" hidden></div>`;
createIcons({ icons: {PanelLeft, Code2} });
const $ = <T extends HTMLElement = HTMLElement>(id:string) => document.getElementById(id) as T;
const desktop = isTauri();
let busy = false;
let toastTimer = 0;
let statsTimer = 0;
let fontSize = Math.min(24, Math.max(12, Number(localStorage.getItem('croquill-font')) || 16));
document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
document.documentElement.dataset.theme = localStorage.getItem('croquill-theme') || 'light';
const imageCache = new Map<string, Promise<string>>();

function toast(message: string) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => $('toast').hidden = true, 3200);
}
function modal(title:string, body:string, choices:{label:string,value:string,primary?:boolean}[]): Promise<string> {
  const root = $('modal-root');
  const previousFocus = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog'); dialog.className = 'app-dialog';
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = body;
  const controls = document.createElement('div'); controls.className = 'dialog-buttons';
  dialog.append(h,p,controls); root.replaceChildren(dialog);
  return new Promise(resolve => {
    const finish = (value:string) => { dialog.close(); root.replaceChildren(); previousFocus?.focus(); resolve(value); };
    for (const choice of choices) { const b=document.createElement('button'); b.textContent=choice.label; b.className=choice.primary?'primary':''; b.onclick=()=>finish(choice.value); controls.append(b); }
    dialog.addEventListener('cancel', event => {event.preventDefault();finish('cancel');});
    dialog.showModal(); (controls.querySelector('.primary') as HTMLElement || controls.lastElementChild as HTMLElement)?.focus();
  });
}
const session = new DocumentSession({
  openPath: () => desktop ? open({title:'打开 Markdown 文件',multiple:false,directory:false,filters:[{name:'Markdown 文档',extensions:['md','markdown','mdown','mkd','txt']},{name:'所有文件',extensions:['*']}]}) as Promise<string|null> : Promise.resolve(null),
  savePath: current => desktop ? save({title:'保存 Markdown 文件',defaultPath:current||'未命名.md',filters:[{name:'Markdown 文档',extensions:['md','markdown']}]}) : Promise.resolve(null),
  read: path => invoke<DocumentFile>('read_document',{path}),
  write: (path,text,bom,newline,expectedRevision) => invoke('write_document',{path,text,bom,newline,expectedRevision:expectedRevision ?? null}),
  confirmSave: name => modal('保存更改？',`“${name}”有尚未保存的修改。`,[{label:'不保存',value:'discard'},{label:'取消',value:'cancel'},{label:'保存',value:'save',primary:true}]) as Promise<'save'|'discard'|'cancel'>,
});
const imageImporter = new ImageImporter({
  documentPath: () => session.path,
  saveDocument: () => session.save(),
  warn: toast,
  persist: args => invoke<string>('import_image', args),
});
const surface = new MarkdownSurface({
  richRoot:$('rich-root'), sourceRoot:$('source-root'),
  onChange: text => { session.edit(text); updateTitle(); scheduleStats(); },
  onDirty: () => { clearTimeout(statsTimer); const wasDirty=session.dirty; session.markPending(); if(!wasDirty)updateTitle(); },
  onWarning: toast,
  onImageFiles: (files, clipboard) => { void insertImages(files.map(file => ({ file, clipboard }))); },
  uploadImage: async file => {
    let src: string | null = null;
    await run(async () => { src = await imageImporter.import({ file }); });
    return src;
  },
  resolveImage: src => {
    if (/^(https?:|data:)/i.test(src)) return Promise.resolve(src);
    if (!desktop || !session.path) return Promise.reject(new Error('请先保存文档，再使用相对路径图片。'));
    const key = `${session.path}\n${src}`;
    if (!imageCache.has(key)) imageCache.set(key, invoke<string>('read_local_image',{documentPath:session.path,src}));
    return imageCache.get(key)!;
  },
});

// Browsing a folder never reads Markdown bodies until a file is opened.
const fileSidebar = new FileSidebar({
  root: $('files-pane'),
  pickFolder: async () => {
    if (!desktop) { toast('请在桌面程序中打开本地文件夹'); return null; }
    const path = await open({title:'打开文件夹', directory:true, multiple:false});
    return typeof path === 'string' ? path : null;
  },
  listFolder: (root, path) => invoke<FolderListing>('list_document_folder', {root, path:path ?? null}),
  openFile: async path => {
    await run(async () => {
      if (path === session.path) return;
      if (await session.open(path)) { imageCache.clear(); await surface.load(session.text); surface.focus(); }
    });
  },
  onError: toast,
});
function setSidebarVisible(visible:boolean) {
  document.body.classList.toggle('sidebar-hidden', !visible);
  localStorage.setItem('croquill-sidebar', String(visible));
  document.querySelector('[data-action="sidebar"].icon-button')?.setAttribute('aria-expanded', String(visible));
}
function setSidebarTab(tab:'files'|'outline', reveal = true) {
  for (const name of ['files','outline']) {
    const selected = name === tab;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
    $(`${name}-pane`).hidden = !selected;
  }
  localStorage.setItem('croquill-sidebar-tab', tab);
  if (reveal) setSidebarVisible(true);
}
for (const tab of ['files','outline'] as const) {
  $(`${tab}-tab`).onclick = () => setSidebarTab(tab);
  $(`${tab}-tab`).onkeydown = event => {
    if (event.isComposing || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'files' : event.key === 'End' ? 'outline' : tab === 'files' ? 'outline' : 'files';
    setSidebarTab(next); $(`${next}-tab`).focus();
  };
}
const resizeHandle = $('sidebar-resize');
let sidebarWidth = Number(localStorage.getItem('croquill-sidebar-width')) || 220;
function resizeSidebar(width:number, remember = false) {
  const max = Math.min(400, Math.floor(window.innerWidth / 2));
  sidebarWidth = Math.min(max, Math.max(180, width));
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  resizeHandle.setAttribute('aria-valuenow', String(sidebarWidth));
  resizeHandle.setAttribute('aria-valuemax', String(max));
  if (remember) localStorage.setItem('croquill-sidebar-width', String(sidebarWidth));
}
resizeSidebar(sidebarWidth);
resizeHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault(); resizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add('sidebar-resizing');
});
resizeHandle.addEventListener('pointermove', event => {
  if (resizeHandle.hasPointerCapture(event.pointerId)) resizeSidebar(event.clientX - $('sidebar').getBoundingClientRect().left);
});
const finishResize = () => { document.body.classList.remove('sidebar-resizing'); resizeSidebar(sidebarWidth, true); };
resizeHandle.addEventListener('pointerup', finishResize);
resizeHandle.addEventListener('lostpointercapture', finishResize);
resizeHandle.addEventListener('keydown', event => {
  if (event.isComposing || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault(); resizeSidebar(event.key === 'Home' ? 180 : event.key === 'End' ? 400 : sidebarWidth + (event.key === 'ArrowLeft' ? -10 : 10), true);
});
window.addEventListener('resize', () => resizeSidebar(sidebarWidth));

// Capture external file drops before WebView can navigate, while leaving editor drags alone.
protectFileDrops(window, [$('rich-root'), $('source-root')]);
$('editor-scroll').addEventListener('scroll', () => surface.deferPendingSerialization(), { passive: true });

function updateTitle() {
  $('filename').textContent=session.name; $('dirty-dot').hidden=!session.dirty;
  document.querySelector('.document-label')!.setAttribute('title',session.path||'尚未保存到本地');
  const title=`${session.dirty?'● ':''}${session.name} — Croquill`;
  document.title=title;
  if(desktop) void getCurrentWindow().setTitle(title).catch(()=>{});
  $('save-status').textContent = session.dirty?'未保存':'';
  $('save-status').title = session.path || '本地文档 · 手动保存';
  fileSidebar.setActiveFile(session.path);
  $('encoding').textContent=session.bom?'UTF-8 BOM':'UTF-8';
  $('newline').textContent=session.newline==='mixed'?'混合换行':session.newline.toUpperCase();
}
function scheduleStats() { clearTimeout(statsTimer); statsTimer=window.setTimeout(updateStats,180); }
function updateStats() {
  const text=session.text;
  const chinese=(text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length;
  const words=(text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,' ').match(/[\p{L}\p{N}]+/gu)||[]).length;
  $('word-count').textContent=`${(chinese+words).toLocaleString('zh-CN')} 字`;
  const headings=markdownOutline(text);
  $('heading-count').textContent=String(headings.length||'');
  const frag=document.createDocumentFragment();
  headings.forEach((heading,index)=>{const b=document.createElement('button');b.textContent=heading.text;b.title=heading.text;b.style.setProperty('--level',String(heading.level));b.onclick=()=>{surface.scrollToHeading(index);document.querySelectorAll('#outline .active').forEach(x=>x.classList.remove('active'));b.classList.add('active');};frag.append(b);});
  if(!headings.length){const p=document.createElement('p');p.className='outline-empty';p.textContent='暂无标题';frag.append(p);}
  $('outline').replaceChildren(frag);
  updateMode();
}
function updateMode() {
  const source=surface.mode==='source';
  $('mode-button').innerHTML=`<span class="mode-symbol" aria-hidden="true">〈/〉</span>`;
  $('mode-button').setAttribute('aria-label', source ? '返回所见即所得' : '切换源码模式');
  $('mode-button').setAttribute('aria-pressed', String(source));
  $('mode-button').title = `${source ? '返回所见即所得' : '切换源码模式'} Ctrl+/`;
  const reason=surface.getSafetyReason();
  const richNotice=surface.getRichNotice();
  $('notice').hidden=!reason&&!richNotice;
  $('notice').textContent=reason?`源码保护 · ${reason}`:richNotice||'';
  document.body.classList.toggle('source-mode',source);
}
async function run(operation:()=>Promise<void>) {
  if(busy || surface.isComposing() || $('modal-root').childElementCount) return;
  session.edit(surface.getMarkdown());
  busy=true; $('editor-scroll').inert=true;
  try { await operation(); }
  catch(error){await modal('操作未完成',String(error),[{label:'返回文档',value:'cancel',primary:true}]);}
  finally {busy=false;$('editor-scroll').inert=false;updateTitle();updateStats();}
}
async function insertImages(sources: ImageSource[]) {
  await run(async () => {
    for (const source of sources) {
      const src = await imageImporter.import(source);
      if (!src) break;
      surface.insertImage(src);
    }
  });
  surface.focus();
}
async function action(name:string) {
  document.querySelectorAll('details[open]').forEach(e=>e.removeAttribute('open'));
  if(name==='theme'||name==='light'||name==='dark'){const theme=name==='theme'?(document.documentElement.dataset.theme==='dark'?'light':'dark'):name;document.documentElement.dataset.theme=theme;localStorage.setItem('croquill-theme',theme);return;}
  if(name==='sidebar'){setSidebarVisible(document.body.classList.contains('sidebar-hidden'));return;}
  if(name==='outline'||name==='files'){setSidebarTab(name);return;}
  if(name==='smaller'||name==='larger'){fontSize=Math.min(24,Math.max(12,fontSize+(name==='larger'?1:-1)));document.documentElement.style.setProperty('--editor-font-size',`${fontSize}px`);localStorage.setItem('croquill-font',String(fontSize));toast(`正文字号 ${fontSize}px`);return;}
  await run(async()=>{
    if(name==='folder'){setSidebarTab('files');await fileSidebar.chooseFolder();}
    if(name==='image'){
      if(!desktop){toast('请在桌面程序中插入本地图片');return;}
      const selected = await open({title:'选择图片',multiple:false,directory:false,filters:[{name:'图片',extensions:['png','jpg','jpeg','gif','webp','bmp','svg','avif']}]});
      if(typeof selected==='string'){
        const src=await imageImporter.import({path:selected});
        if(src)surface.insertImage(src);
      }
    }
    if(name==='new'){if(await session.fresh()){imageCache.clear();await surface.load('');surface.focus();}}
    if(name==='open'){if(!desktop){toast('请在桌面程序中打开本地文件');return;}if(await session.open()){imageCache.clear();await surface.load(session.text);surface.focus();}}
    if(name==='save'||name==='saveAs'){if(!desktop){toast('请在桌面程序中保存本地文件');return;}if(await session.save(name==='saveAs'))toast('已保存到本地');}
    if(name==='mode'){await surface.setMode(surface.mode==='rich'?'source':'rich');surface.focus();}
    if(name==='help')await modal('在 Croquill 中写作','直接输入 Markdown：标题、列表、引用和加粗会自然排版。点击正文继续修改。\n\n左侧文件标签可打开文件夹，单击文件切换；分隔边可拖动调宽，底部按钮收起侧栏。\n\nCtrl+Shift+O 打开文件夹\nCtrl+N 新建　Ctrl+O 打开　Ctrl+S 保存\nCtrl+Shift+S 另存为　Ctrl+/ 切换源码\nCtrl+B 加粗　Ctrl+I 斜体　Ctrl+K 链接\nTab / Shift+Tab 调整列表层级\n\n文件保存在本地，采用手动保存。源码保护提示表示当前语法需在源码模式编辑；编辑后的 Markdown 可能被规范化。', [{label:'开始写作',value:'ok',primary:true}]);
  });
}
app.addEventListener('click',event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-action],[data-format]');if(!target)return;if(target.dataset.action)void action(target.dataset.action);else{document.querySelectorAll('details[open]').forEach(e=>e.removeAttribute('open'));surface.format(target.dataset.format!);surface.focus();}});
document.addEventListener('pointerdown',event=>{if(!(event.target as HTMLElement).closest('details'))document.querySelectorAll('details[open]').forEach(e=>e.removeAttribute('open'));});
document.querySelectorAll('details').forEach(detail=>detail.addEventListener('toggle',()=>{if(detail.open)document.querySelectorAll('details[open]').forEach(other=>{if(other!==detail)other.removeAttribute('open');});}));
document.addEventListener('keydown',event=>{
  if(event.isComposing||surface.isComposing())return;
  if(event.altKey && !event.ctrlKey && !$('modal-root').childElementCount){
    const summary=Array.from(document.querySelectorAll<HTMLElement>('summary[data-menu-key]')).find(item => item.dataset.menuKey === event.key.toLowerCase());
    if(summary){event.preventDefault();(summary.parentElement as HTMLDetailsElement).open=true;summary.focus();}
    return;
  }
  if(event.key==='Escape'){document.querySelectorAll('details[open]').forEach(e=>e.removeAttribute('open'));return;}
  if(event.altKey||!event.ctrlKey)return;
  const key=event.key.toLowerCase();
  const name=(event.code==='Slash' && !event.shiftKey)?'mode':key==='n'?'new':key==='o'?(event.shiftKey?'folder':'open'):key==='s'?(event.shiftKey?'saveAs':'save'):event.shiftKey&&key==='m'?'mode':event.shiftKey&&key==='l'?'sidebar':null;
  if(name){event.preventDefault();void action(name);}
}, {capture:true});
// Keep links inside the document from navigating away from the editor.
$('rich-root').addEventListener('click',event=>{if((event.target as HTMLElement).closest('a'))event.preventDefault();});
setSidebarTab(localStorage.getItem('croquill-sidebar-tab') === 'outline' ? 'outline' : 'files', false);
setSidebarVisible(localStorage.getItem('croquill-sidebar') !== 'false');
await surface.init('');
updateTitle();updateStats();
if(desktop){
  await getCurrentWindow().onCloseRequested(event=>{event.preventDefault();void run(async()=>{if(await session.mayLeave())await getCurrentWindow().destroy();});});
  const initial=await invoke<string|null>('initial_path').catch(()=>null);
  if(initial)await run(async()=>{if(await session.open(initial))await surface.load(session.text);});
}
surface.focus();
