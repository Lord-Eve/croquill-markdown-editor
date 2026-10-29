import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { createIcons, PanelLeft, Code2, ListTree } from 'lucide';
import { MarkdownSurface } from './editor';
import { ImageImporter, type ImageSource } from './images';
import { DocumentSession, type DocumentFile } from './session';
import { protectFileDrops } from './file-drop';
import { markdownOutline } from './fidelity';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="menubar">
  <nav aria-label="菜单">
    <details><summary>文件</summary><div class="menu">
      <button data-action="new">新建<span>Ctrl+N</span></button><button data-action="open">打开…<span>Ctrl+O</span></button><hr>
      <button data-action="save">保存<span>Ctrl+S</span></button><button data-action="saveAs">另存为…<span>Ctrl+Shift+S</span></button>
    </div></details>
    <details><summary>编辑</summary><div class="menu"><button data-format="undo">撤销<span>Ctrl+Z</span></button><button data-format="redo">重做<span>Ctrl+Y</span></button></div></details>
    <details><summary>段落</summary><div class="menu"><button data-format="heading1">一级标题<span>Ctrl+1</span></button><button data-format="heading2">二级标题<span>Ctrl+2</span></button><button data-format="heading3">三级标题<span>Ctrl+3</span></button><hr><button data-format="bullet">无序列表</button><button data-format="ordered">有序列表</button><button data-format="task">任务列表</button><button data-format="quote">引用</button><button data-format="codeblock">代码块</button><button data-format="table">插入表格</button><button data-action="image">图片</button></div></details>
    <details><summary>格式</summary><div class="menu"><button data-format="bold">加粗<span>Ctrl+B</span></button><button data-format="italic">斜体<span>Ctrl+I</span></button><button data-format="strike">删除线</button><button data-format="link">链接<span>Ctrl+K</span></button><button data-format="code">行内代码</button></div></details>
    <details><summary>视图</summary><div class="menu"><button data-action="mode">切换源码模式<span>Ctrl+/</span></button><button data-action="outline">大纲侧栏<span>Ctrl+Shift+L</span></button><hr><button data-action="smaller">缩小字号</button><button data-action="larger">放大字号</button></div></details>
    <details><summary>主题</summary><div class="menu"><button data-action="light">GitHub · 浅色</button><button data-action="dark">Night · 深色</button></div></details>
    <details><summary>帮助</summary><div class="menu"><button data-action="help">使用说明</button></div></details>
  </nav>
  <div class="document-label" title=""><span id="dirty-dot" hidden></span><span id="filename">未命名</span></div>
</header>
<div class="workspace">
  <aside id="sidebar" aria-label="文档大纲"><div class="sidebar-title"><i data-lucide="list-tree"></i><span>大纲</span><span id="heading-count"></span></div><div id="outline"></div><div class="sidebar-foot">本地文档 · 手动保存</div></aside>
  <main id="main"><div id="notice" role="status" hidden></div><div id="editor-scroll"><div id="rich-root"></div><div id="source-root" hidden></div></div></main>
</div>
<footer class="statusbar"><div class="status-left"><button class="icon-button" data-action="outline" title="切换大纲 Ctrl+Shift+L" aria-label="切换大纲"><i data-lucide="panel-left"></i></button><button data-action="mode" id="mode-button" title="切换源码模式 Ctrl+/"><i data-lucide="code-2"></i><span>所见即所得</span></button><span id="save-status">准备就绪</span></div><div class="status-right"><span id="encoding">UTF-8</span><span id="newline">LF</span><span class="status-separator">·</span><span id="word-count">0 字</span></div></footer>
<div id="modal-root"></div><div id="toast" role="status" hidden></div>`;
createIcons({ icons: {PanelLeft, Code2, ListTree} });
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

// Capture external file drops before WebView can navigate, while leaving editor drags alone.
protectFileDrops(window, [$('rich-root'), $('source-root')]);
$('editor-scroll').addEventListener('scroll', () => surface.deferPendingSerialization(), { passive: true });

function updateTitle() {
  $('filename').textContent=session.name; $('dirty-dot').hidden=!session.dirty;
  document.querySelector('.document-label')!.setAttribute('title',session.path||'尚未保存到本地');
  const title=`${session.dirty?'● ':''}${session.name} — Croquill`;
  document.title=title;
  if(desktop) void getCurrentWindow().setTitle(title).catch(()=>{});
  $('save-status').textContent = session.dirty?'未保存':session.path?'已保存到本地':'准备就绪';
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
  if(!headings.length){const p=document.createElement('p');p.className='outline-empty';p.textContent='写下标题，\n在这里看见文章的脉络。';frag.append(p);}
  $('outline').replaceChildren(frag);
  updateMode();
}
function updateMode() {
  const source=surface.mode==='source';
  $('mode-button').innerHTML=`<span class="mode-symbol">${source?'〈/〉':'¶'}</span><span>${source?'源码模式':'所见即所得'}</span><span class="mode-arrow">⌄</span>`;
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
  if(name==='outline'){document.body.classList.toggle('sidebar-hidden');localStorage.setItem('croquill-sidebar',String(!document.body.classList.contains('sidebar-hidden')));return;}
  if(name==='smaller'||name==='larger'){fontSize=Math.min(24,Math.max(12,fontSize+(name==='larger'?1:-1)));document.documentElement.style.setProperty('--editor-font-size',`${fontSize}px`);localStorage.setItem('croquill-font',String(fontSize));toast(`正文字号 ${fontSize}px`);return;}
  await run(async()=>{
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
    if(name==='help')await modal('在 Croquill 中写作','直接输入 Markdown：标题、列表、引用和加粗会自然排版。点击正文继续修改。\n\nCtrl+N 新建　Ctrl+O 打开　Ctrl+S 保存\nCtrl+Shift+S 另存为　Ctrl+/ 切换源码\nCtrl+B 加粗　Ctrl+I 斜体　Ctrl+K 链接\nTab / Shift+Tab 调整列表层级\n\n文件保存在本地，采用手动保存。源码保护提示表示当前语法需在源码模式编辑；编辑后的 Markdown 可能被规范化。', [{label:'开始写作',value:'ok',primary:true}]);
  });
}
app.addEventListener('click',event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-action],[data-format]');if(!target)return;if(target.dataset.action)void action(target.dataset.action);else{document.querySelectorAll('details[open]').forEach(e=>e.removeAttribute('open'));surface.format(target.dataset.format!);surface.focus();}});
document.addEventListener('pointerdown',event=>{if(!(event.target as HTMLElement).closest('details'))document.querySelectorAll('details[open]').forEach(e=>e.removeAttribute('open'));});
document.querySelectorAll('details').forEach(detail=>detail.addEventListener('toggle',()=>{if(detail.open)document.querySelectorAll('details[open]').forEach(other=>{if(other!==detail)other.removeAttribute('open');});}));
document.addEventListener('keydown',event=>{
  if(event.isComposing||surface.isComposing()||event.altKey||!event.ctrlKey)return;
  const key=event.key.toLowerCase();
  const name=(event.code==='Slash' && !event.shiftKey)?'mode':key==='n'?'new':key==='o'?'open':key==='s'?(event.shiftKey?'saveAs':'save'):event.shiftKey&&key==='m'?'mode':event.shiftKey&&key==='l'?'outline':null;
  if(name){event.preventDefault();void action(name);}
}, {capture:true});
// Keep links inside the document from navigating away from the editor.
$('rich-root').addEventListener('click',event=>{if((event.target as HTMLElement).closest('a'))event.preventDefault();});
if(localStorage.getItem('croquill-sidebar')==='false')document.body.classList.add('sidebar-hidden');
await surface.init('');
updateTitle();updateStats();
if(desktop){
  await getCurrentWindow().onCloseRequested(event=>{event.preventDefault();void run(async()=>{if(await session.mayLeave())await getCurrentWindow().destroy();});});
  const initial=await invoke<string|null>('initial_path').catch(()=>null);
  if(initial)await run(async()=>{if(await session.open(initial))await surface.load(session.text);});
}
surface.focus();
