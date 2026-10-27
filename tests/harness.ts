import { MarkdownSurface } from '../src/editor';
import { EditorView } from '@codemirror/view';

const results = document.querySelector<HTMLPreElement>('#results')!;
const richRoot = document.querySelector<HTMLDivElement>('#rich')!;
const sourceRoot = document.querySelector<HTMLDivElement>('#source')!;
const lines: string[] = [];
const only = new URL(location.href).searchParams.get('only');
let edits: string[] = [];
let images: string[] = [];
const surface = new MarkdownSurface({ richRoot, sourceRoot, onChange: (value) => edits.push(value), resolveImage: async (src) => {
  images.push(src);
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqQAAAAASUVORK5CYII=';
} });
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function waitForBlockMath(): Promise<void> {
  const block = richRoot.querySelector('.milkdown-code-block');
  block?.scrollIntoView({ block: 'center' });
  if (richRoot.querySelector('.katex-display')) return;
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (richRoot.querySelector('.katex-display')) { clearTimeout(timer); observer.disconnect(); resolve(); }
    });
    const timer = window.setTimeout(() => { observer.disconnect(); reject(new Error('块公式未在可见区域挂载')); }, 3000);
    observer.observe(richRoot, { childList: true, subtree: true });
  });
}
const step = async (name: string, work: () => Promise<void>) => {
  if (only === 'recheck' && !/CommonMark|公式|长中文|大纲/.test(name)) return;
  if (only === 'roundtrip' && !name.startsWith('CommonMark')) return;
  if (only === 'math' && !name.startsWith('行内及块公式')) return;
  try { await work(); lines.push(`通过：${name}`); }
  catch (error) {
    lines.push(`失败：${name}：${error}`);
  }
  results.textContent = lines.join('\n');
};

document.querySelector<HTMLButtonElement>('#run')!.onclick = async () => {
  document.querySelector<HTMLButtonElement>('#run')!.disabled = true;
  lines.length = 0;
  try {
    await step('CommonMark / GFM 未编辑模式切换保留原文', async () => {
      const original = '# 中文 标题\r\n\r\n__加粗__与*斜体*、~~删除~~、[链接](https://example.com)。\r\n\r\n- 父项\r\n  - 子项\r\n\r\n- [x] 已完成\r\n- [ ] 待办\r\n\r\n| 一 | 二 |\r\n| --- | --- |\r\n| 甲 | 乙 |\r\n\r\n```ts\r\nconst 中文 = 1;\r\n```\r\n\r\n![本地图片](./图片.png "中文说明")\r\n';
      edits = []; images = [];
      await surface.load(original);
      assert(surface.mode === 'rich', `${surface.getSafetyReason() || '不是富编辑模式'}\n序列化：${JSON.stringify((surface as unknown as {crepe: {getMarkdown(): string}}).crepe.getMarkdown())}`);
      for (let index = 0; index < 20; index++) { await surface.setMode('source'); await surface.setMode('rich'); }
      assert(surface.getMarkdown() === original, '切换修改了原始文本');
      assert(edits.length === 0, '切换触发了修改事件');
      assert(richRoot.querySelectorAll('.milkdown-table-block table.children').length === 1, '表格未排版');
      assert(richRoot.querySelectorAll('ul ul').length === 1, '嵌套列表未排版');
      assert(images.includes('./图片.png'), '未通过图片代理解析原始相对路径');
      surface.format('heading2');
      assert(surface.getMarkdown().includes('![本地图片](./图片.png "中文说明")'), '编辑后图片alt/title丢失');
      surface.format('undo'); assert(surface.getMarkdown() === original, '编辑撤销后原文有变化');
    });
    await step('富编辑格式和撤销恢复原始 Markdown', async () => {
      const original = '# 标题\r\n\r\n原始__格式__。\r\n';
      await surface.load(original);
      surface.format('heading2');
      assert(surface.getMarkdown().startsWith('## 标题'), '标题命令未生效');
      surface.format('undo');
      assert(surface.getMarkdown() === original, '撤销后未恢复原始文本');
      surface.format('redo');
      assert(surface.getMarkdown().startsWith('## 标题'), '重做未生效');
    });
    await step('源码程序化中文输入、撤销、往返保留修改', async () => {
      const original = '# 源码\r\n\r\n原文。\r\n';
      await surface.load(original);
      await surface.setMode('source');
      const cm = EditorView.findFromDOM(sourceRoot.querySelector('.cm-editor')!)!;
      const end = cm.state.doc.length;
      cm.dispatch({ changes: { from: end, insert: '\n连续中文，标点与内容。' }, userEvent: 'input' });
      const edited = surface.getMarkdown();
      assert(edited.includes('连续中文，标点与内容。'), '源码内容未同步');
      surface.format('undo');
      assert(surface.getMarkdown() === original, '源码撤销未还原CRLF原文');
      surface.format('redo');
      assert(surface.getMarkdown() === edited, '源码重做未还原修改');
      await surface.setMode('rich'); await surface.setMode('source');
      assert(surface.getMarkdown() === edited, '源码往返丢失修改');
    });
    await step('frontmatter / HTML / 未知扩展源码保护', async () => {
      for (const original of ['---\ntitle: 中文\n---\n\n正文', '<details><summary>摘要</summary>正文</details>', '正文[^a]\n\n[^a]: 注释', '[[双向链接]]', '::: warning\n注意\n:::']) {
        edits = [];
        await surface.load(original); await surface.setMode('rich');
        assert(surface.mode === 'source', '保护文档进入了富编辑');
        assert(surface.getMarkdown() === original, '保护文档被转换');
        assert(edits.length === 0, '保护切换触发修改');
      }
    });
    await step('表格、任务列表、链接、图片插入命令', async () => {
      await surface.load(''); surface.format('table');
      assert(surface.getMarkdown().includes('|'), '表格插入失败');
      await surface.setMode('source'); await surface.setMode('rich');
      assert(surface.mode === 'rich', '插入表格不能往返');
      await surface.load('待办'); surface.format('task');
      assert(surface.getMarkdown().includes('[ ] 待办'), '任务列表插入失败');
      await surface.load(''); surface.format('link');
      assert(surface.getMarkdown().includes('[链接文字](https://example.com)'), '链接插入失败');
      await surface.load(''); surface.format('image');
      assert(!!richRoot.querySelector('.milkdown-image-block'), '图片插入面板未出现');
    });
    await step('长中文文档解析与单字编辑', async () => {
      const original = '# 长文\n\n' + Array.from({length: 1400}, (_, index) => `第${index + 1}段。这是一段用于编辑器性能验证的中文内容，包含标点、叙述和完整句子。`).join('\n\n');
      const start = performance.now();
      await surface.load(original);
      assert(surface.mode === 'rich', surface.getSafetyReason() || '长文未进入富编辑');
      surface.format('heading2');
      assert(surface.getMarkdown().includes('第1400段'), '长文尾部丢失');
      lines.push(`记录：长文 ${original.length} 字符，加载及标题变更 ${Math.round(performance.now() - start)}ms`);
    });
    await step('行内及块公式排版、源码往返、大纲排除元数据', async () => {
      const original = '# 数学\n\n行内 $x^2 + y^2 = 1$。\n\n$$\n\\frac{1}{2} + \\sqrt{x}\n$$\n';
      await surface.load(original);
      assert(surface.mode === 'rich', surface.getSafetyReason() || '公式不能富编辑');
      await waitForBlockMath();
      assert(richRoot.querySelectorAll('.katex').length >= 1, '行内公式未渲染');
      assert(richRoot.querySelectorAll('.katex-display').length === 1, '块公式未渲染');
      await surface.setMode('source'); await surface.setMode('rich');
      assert(surface.getMarkdown() === original, '公式切换改变原文');
      surface.format('heading2');
      const edited = surface.getMarkdown();
      assert(edited.includes('\\frac{1}{2}') && edited.includes('$x^2 + y^2 = 1$'), '公式编辑后丢失');
      await surface.load('---\ntitle: 元数据\n---\n\n# 正文');
      assert(JSON.stringify(surface.getOutline()) === JSON.stringify([{level: 1, text: '正文', line: 5}]), 'frontmatter出现伪标题');
    });
  } finally {
    if (!lines.some((line) => line.startsWith('失败'))) { richRoot.hidden = true; sourceRoot.hidden = true; }
    results.textContent = lines.join('\n');
    document.querySelector<HTMLButtonElement>('#run')!.disabled = false;
  }
};
