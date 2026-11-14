# 施工单 01：块级 HTML 渲染与原位编辑

- 写单日期：2026-11-14
- 基线：`main`（0.5.0，提交 `92b2c5b` 之后）
- 分支名：`html-block`
- 交付方式：推送分支，向 `main` 开 PR。**不要推送 main，不要合并 PR，不要打标签或发版。**

开工前先读完仓库根目录的 `AGENTS.md`，其中的四条底线和“改完之后必须做”对本单全部适用。本单与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准，并在 PR 说明里指出冲突。

## 1. 目标

现状：独占一块的 HTML（如 `<div align="center">…</div>`、`<details>…</details>`、单独一行的 `<img …>`）在所见即所得模式里显示为灰色等宽原文（`<pre data-croquill-raw>`），不能点，只能切到源码模式改。

做完后：

1. 这类块平时显示**渲染后的效果**。
2. 点击后在原位展开**源码框**，可以直接改；离开后收起并按新内容重新渲染。
3. 没改过的块，保存后逐字节不变。

## 2. 范围

**做：** 只含 HTML 的原文块。判断标准是 `src/fidelity.ts` 的 `preservedMarkdownBlocks` 给出的 `categories` 恰好等于 `['HTML']`。

**不做（保持现在的灰色原文显示，行为一个字都不变）：**

- `categories` 里还有别的类别的块（双链、容器、属性、目录、提示块、块引用标识）。
- 行内 HTML 片段（`src/inline-raw.ts`）、HTML 注释、`<br>`。
- 块内夹着的 Markdown 不做排版，由浏览器按普通文字显示。
- `<video>`、`<audio>`、`<iframe>` 等嵌入内容不渲染（被过滤掉后，块里剩什么显示什么）。
- 不改“哪些文档进入源码保护”的任何规则，不改 `preservedMarkdownBlocks` 的分块结果。

## 3. 现有代码（先读懂再动）

| 位置 | 作用 |
| --- | --- |
| `src/fidelity.ts` `preservedMarkdownBlocks` | 找出要原样保留的块；`raw` 含块后面的空白和换行 |
| `src/raw-markdown.ts` | `preserveRawMarkdown` 把这些块换成 `croquillRawBlock`；节点 `croquill_raw_block` 只有 `value` 一个属性，原子节点 |
| `src/editor.ts` 约 556–563 行 | 保存时根据 `value` 结尾的换行数决定块间空行，保证逐字节一致。**不要动这段的逻辑** |
| `src/toc-footnotes.ts` 约 166 行、200 行 | 读取原文块里的标题和脚注；200 行处有本项目注册 nodeView 的现成写法 |
| `src/main.ts` 126 行 `resolveImage` | 把相对路径图片换成可显示的地址；编辑器内通过 `this.options.resolveImage` 调用 |
| `src/main.ts` 约 333 行 | 阻止文档里的链接把窗口导航走 |
| `src-tauri/tauri.conf.json` | CSP：`script-src 'self'`、`frame-src 'none'`。**不要放宽 CSP** |

## 4. 设计

### 4.1 数据

- 给 `croquill_raw_block` 增加属性 `kind`，取值 `''`（默认）或 `'html'`。`preserveRawMarkdown` 在 `categories` 恰为 `['HTML']` 时写 `'html'`。
- `toDOM` / `parseDOM` 带上这个属性（如 `data-croquill-raw-kind`），保证编辑器内复制粘贴后仍是可渲染的块。
- `toMarkdown` 不变：`value` 原样写出。
- 文档里保存的永远是源码字符串。渲染结果只存在于显示层，绝不写回文档。

### 4.2 显示（nodeView，仅 `kind === 'html'`）

- 最外层元素保留 `data-croquill-raw` 属性，另加 `data-croquill-html`；`contenteditable="false"`。
- 里面两个子元素：
  - 预览区 `.croquill-html-preview`：放过滤后的 HTML。
  - 源码框 `textarea.croquill-html-source`：平时隐藏。
- `kind === ''` 的块继续走原来的 `toDOM`，输出与现在完全相同。

### 4.3 安全过滤（本单最重要的一节）

文档可能来自别人。未过滤的 HTML 进入界面，等于让文档拿到编辑器的文件读写权限。

- 新增依赖 `dompurify`，版本写死 **`3.4.17`**（`package.json` 里不带 `^`），同步更新 `package-lock.json`。项目所有者已同意新增这一个依赖。不要新增其他依赖，不要升级任何现有依赖。
- 过滤逻辑单独放一个文件 `src/html-sanitize.ts`，导出一个函数：输入源码字符串，输出 `DocumentFragment`。用 `RETURN_DOM_FRAGMENT`，**不要**先得到字符串再赋给 `innerHTML`。
- 整个项目里，把文档内容变成 DOM 的路径只能有这一条。除它之外不得出现对文档内容的 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`、`DOMParser` 后直接挂载。
- 配置要求：
  - 只启用 HTML（`USE_PROFILES: { html: true }`），不要 SVG 和 MathML。
  - 额外禁止标签：`style`、`script`、`iframe`、`frame`、`object`、`embed`、`form`、`input`、`button`、`textarea`、`select`、`option`、`link`、`meta`、`base`、`video`、`audio`、`source`、`track`。
  - 额外禁止属性：`srcset`、`ping`、`formaction`；`ALLOW_DATA_ATTR: false`；`SANITIZE_NAMED_PROPS: true`。
  - 保留 `style` 属性（居中、颜色、宽度都靠它），但预览区的 CSS 必须有 `contain: paint`、`overflow: hidden`、`position: relative`，使块内的 `position: fixed` / `absolute` 盖不到块外。
- 图片：
  - `http:` / `https:` / `data:` 的 `src` 原样保留（与现有 Markdown 图片一致）。
  - 其余（相对路径、本地路径）先把 `src` 拿掉，再调用 `this.options.resolveImage(原 src)`，成功后填回返回的地址；失败时保留 `alt` 文字，不报错弹窗。不允许出现向应用自身地址请求相对路径的情况。
- 预览区里的链接：点击不导航（沿用 `src/main.ts` 现有的拦截，并在测试里确认）。

### 4.4 编辑

进入编辑：

- 单击预览区进入编辑；例外是单击 `<summary>`，只折叠 / 展开，不进入编辑。
- 用方向键把选区移到该块上（整块被选中）时按 Enter 进入编辑。

编辑中：

- 源码框显示 `value` **去掉结尾空白和换行**后的内容；被去掉的那一截原样记住。提交时 = 源码框内容 + 记住的那一截。这一点决定未修改部分的逐字节保真，必须有测试。
- 源码框等宽字体，高度随内容自动增长，没有内部滚动条。
- 预览区在源码框下方保持可见，随输入实时更新。
- **每次输入都要把内容写进编辑器文档**（一次事务改 `value`），不要等到离开才写。原因：用户改到一半直接按 Ctrl+S，必须保存到他看到的内容，否则违反“不丢文字”。
- 内容与原值相同时不派发事务，文档不能因为“点进去又点出来”变成已修改。
- 中文输入法：`compositionstart` 到 `compositionend` 之间不派发事务、nodeView 的 `update` 不改写源码框的值；`compositionend` 后派发一次。
- 撤销 / 重做：源码框里的 Ctrl+Z、Ctrl+Y、Ctrl+Shift+Z 交给编辑器自己的历史（阻止 `textarea` 原生撤销），nodeView 的 `update` 负责把源码框同步成文档里的值，并尽量保住光标位置。
- 源码框聚焦时，Ctrl+B、Ctrl+I、Ctrl+K、Ctrl+1～6、Ctrl+0、Ctrl+=、Ctrl+- 等格式快捷键不得作用到文档；Ctrl+S、Ctrl+F、Ctrl+/ 等全局快捷键照常工作。
- 查找替换改到了这个块的内容时，预览要跟着更新。

离开编辑：

- 按 Esc，或焦点离开源码框，收起源码框。Esc 之后焦点回到编辑器，选区落在该块上。
- 源码框里光标在第一行行首按 ↑ / 在最后一行行尾按 ↓，离开到上一块 / 下一块。
- 离开时内容为空（只有空白）：把该块替换成一个空段落。
- 离开时内容已经不是 HTML（比如被改成了一句普通文字）：保持为原文块，保存时原样写出。不要在这里重新解析整篇文档。

## 5. 不能碰坏的东西

- `npm test` 现有 35 个文件、626 项必须全部通过。**不得修改现有测试的预期**，唯一例外：某条断言检查的正是“纯 HTML 块显示为原文文字”（例如读取 `[data-croquill-raw]` 的 `textContent`）。这类改动逐条列在 PR 说明里，写明原预期、新预期和原因。`[data-croquill-raw]` 的计数类断言不应该受影响，因为最外层属性保留了。
- 不得用放宽断言、固定延时、重试来让测试通过。
- 含纯 HTML 块的文档：打开后不编辑直接保存，逐字节一致（LF、CRLF、带 BOM 各一份）。
- 不动 `src/inline-source*.ts` 的行为（行内格式是源码文本，见 `AGENTS.md`）。
- 不提交 `examples/private/` 下的任何文件，也不要读取其内容写进测试。
- 不运行 `clean.ps1` / `clean-all.ps1`。

## 6. 必须新增的测试

浏览器测试放 `tests/html-block.test.ts`，写法照 `tests/highlight-alert.test.ts`（含 `beforeAll` 里的预热）。至少覆盖：

渲染：

1. `<div align="center">文字</div>` 渲染为居中的 div，不再显示尖括号。
2. `<details><summary>标题</summary>内容</details>`：单击 summary 展开 / 收起，不进入编辑。
3. 混有其他类别的块（如 `<div>[[双链]]</div>`）仍是 `<pre data-croquill-raw>` 原文。
4. 相对路径 `<img src="a.png">` 走 `resolveImage`；`resolveImage` 拒绝时不抛未捕获异常。

安全（每条都断言“没有执行、没有残留”）：

5. `<div onclick="window.__x=1">`：`onclick` 属性不存在，点击后 `window.__x` 未定义。
6. `<script>window.__x=1</script>`、`<img src=x onerror="window.__x=1">`：`window.__x` 未定义，预览里没有 `script` 元素和 `onerror` 属性。
7. `<a href="javascript:window.__x=1">`：`href` 被去掉或无害，点击后 `window.__x` 未定义。
8. `<iframe>`、`<style>`、`<form>`、`<input>`、`<svg>` 均不出现在预览里。
9. `<div style="position:fixed;inset:0">`：该元素的可见区域不超出块本身（用 `elementFromPoint` 在块外取点，取到的不是它）。
10. `<div id="body" name="cookie">`：`document.body`、`document.cookie` 仍是原来的对象。

编辑：

11. 单击进入编辑，源码框内容 = 原文去掉结尾空白。
12. 改一个字符后 `getMarkdown()` 立刻反映改动，且块后的空行、换行符与原文一致（LF 与 CRLF 各测一次）。
13. 点进去不改、按 Esc 离开：文档未变成已修改，保存逐字节一致。
14. 编辑后 Ctrl+Z 恢复原值，源码框和预览同步；Ctrl+Y 重做。
15. 输入法组词（用 CDP `Input.imeSetComposition`，参照 `tests/app-inline-source.test.ts`）：组词期间文档不变，上屏后文档只多出上屏的字。
16. 源码框聚焦时按 Ctrl+B，文档内容不变。
17. 清空内容后离开，块变成空段落。
18. 首行按 ↑、末行按 ↓ 离开到相邻块。
19. 模式往返：所见即所得 → 源码 → 所见即所得，内容不变，块仍被渲染。
20. 编辑器内复制该块再粘贴，得到的仍是可渲染的 HTML 块，保存内容正确。

## 7. 文档与构建

- `CHANGELOG.md`“未发布”记一笔（新增功能、新增依赖 DOMPurify）。
- `docs/roadmap.md`：“第二批：行内 HTML 原样保留为片段”和“放行语法的 Typora 式渲染（第二批剩余）”两条相应更新；第一版不做的事（块内 Markdown 排版、视频嵌入）写成待办。
- 新增 `examples/html-block.md` 手动验收样本，文末附验收步骤（照 `examples/inline-source.md` 的写法）。
- `AGENTS.md` 目录表里加 `src/html-sanitize.ts` 一行，并加一句“文档内容变成 DOM 只能经过它”。
- `docs/typora-acceptance.md`：记一行“块级 HTML 渲染：依据官方文档 HTML 一节，本机 Typora 试用过期，未做实测对照”。**没有实测就不要写成“已对齐 Typora”。**
- `npx tsc --noEmit`、`npm test` 通过后运行 `build.ps1`，确认 `src-tauri\target\release\croquill.exe` 的修改时间晚于源码。

## 8. PR 说明必须包含

1. 改了哪些文件、各自做了什么。
2. `npx tsc --noEmit` 和 `npm test` 的实际结果（文件数、测试数）。
3. 修改过的现有测试清单（没有就写“无”）。
4. 与本单不一致的地方及原因（没有就写“无”）。
5. 没做或没验证的事。真实窗口和真实输入法的验收由 Claude 在合并前做，这里如实写“未做”即可，不要编造验收结果。

PR 开出后 CI（Windows Acceptance）会自动运行，Codex 会自动审核。之后的修改意见以 PR 评论形式给出，请直接在同一分支上追加提交，不要强制推送。
