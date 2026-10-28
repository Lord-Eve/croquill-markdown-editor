# 官方 Typora 体验对照与验收记录

日期：2026-10-27。唯一产品体验参照：[官方 Typora](https://typora.io/)，以及 `support.typora.io` 官方支持文档。Typora Next 不参与外观、排版或交互验收。

本文中的“已实现”仅表示当前源码有对应实现；实测结果需单独填写。编辑器框架自带功能、单元测试通过、浏览器模拟事件均不等于官方 Typora 行为一致或真实中文输入法验收通过。

## 官方证据与当前实现

| 验收项 | 官方依据 | 本应用当前实现与明确差距 | 本机对照观察 / 验收操作 |
| --- | --- | --- | --- |
| 单栏直接读写 | [官网 Readable & Writable](https://typora.io/) 展示在同一正文表面输入并实时渲染，不要求左右分栏预览 | `src/editor.ts` 使用 Crepe 同一正文表面直接编辑；完整源码由另一编辑表面承载 | 同一窗口分别输入、点击已排版文字、框选修改；观察是否需要额外进入编辑态 |
| 行内语法显隐 | [Quick Start / Live Preview](https://support.typora.io/Quick-Start/) 说明行内格式完成后立即显示排版，标记按编辑上下文智能显隐 | 行内格式已用结构化 mark 编辑；当前没有实现与官方相同的 `**`、`*`、删除线等源码标记按光标位置展开机制 | 输入 `**中文**` 后移动光标到内部、边界、块外；逐项记录标记显示时机，以及左右键跨越边界的步骤 |
| 块语法与当前块 | [Quick Start](https://support.typora.io/Quick-Start/) 说明块样式输入时或 Enter 到下一段时形成，渲染后隐藏块标记 | 当前激活块有 class 装饰，标题左侧显示不可编辑的 `#` 提示；它不是可直接编辑的原始 Markdown 源码 | 输入标题、引用、任务项后 Enter；返回该块、Home/End、Backspace；对照官方能否直接更改标记与块类型 |
| 普通编辑与焦点模式 | [Focus / Typewriter](https://support.typora.io/Focus-and-Typewriter-Mode/) 将淡化非当前块的 Focus Mode 定义为可选视图功能；[快捷键](https://support.typora.io/Shortcut-Keys/) 为 F8 | 当前块提示已实现；尚无 F8 焦点模式与非当前内容淡化 | 普通模式先验收光标与显隐；单独开启官方 F8，记录淡化范围，不能将“当前块编辑”等同于焦点模式 |
| 打字机模式 | [Focus / Typewriter](https://support.typora.io/Focus-and-Typewriter-Mode/) 说明打字时将光标保持在窗口中部；[快捷键](https://support.typora.io/Shortcut-Keys/) 为 F9 | 当前没有实现打字机模式 | 单独打开 F9 观察键入与鼠标跳转滚动；属于后续差距，不纳入首版已完成声明 |
| 源码切换 | [快捷键](https://support.typora.io/Shortcut-Keys/) 的 Windows 源码切换为 Ctrl+/；[Typora 1.13](https://support.typora.io/What's-New-1.13/) 说明切换保留滚动位置 | `setMode()` 同步正文且保留未编辑原文；本应用已采用 Ctrl+/，兼容 Ctrl+Shift+M；跨模式精确光标映射、滚动位置与统一撤销链尚未实现 | 连续切换时原文、dirty、光标、选区、滚动分别记录；中间两种模式各编辑，再测试切回与撤销。内容同步的技术验证不代替官方客户端对照 |
| 有序 / 无序与嵌套列表 | [官网 Lists](https://typora.io/) 明确 Tab / Shift+Tab 改层级；[Markdown Reference](https://support.typora.io/Markdown-Reference/) 描述输入列表标记形成列表 | Crepe 列表输入规则与 `sinkListItem/liftListItem` 命令已接入；源码侧 Tab 当前是普通缩进 | 两级与三级列表分别 Tab / Shift+Tab，空项 Enter 退出，Backspace 合并；观察编号与光标是否自然 |
| 任务列表 | [Task List](https://support.typora.io/Task-List/) 说明 `- [ ]` / `- [x]` 渲染任务项，并可点击复选框改变状态 | GFM 任务项模型与菜单命令已接入 | 点击切换后保存、重开，再撤销；检查普通列表与任务列表互转及嵌套 |
| 表格编辑 | [Table Editing](https://support.typora.io/Table-Editing/) 提供源码输入、菜单插入、Ctrl+Enter 新行、Tab 到末格加行及行列操作 | 当前接入 Crepe/GFM 表格与 3×3 插入命令；未实现全部 Typora 菜单与表格行为等价承诺 | Tab/Shift+Tab、末格 Tab、Ctrl+Enter、中文选区、行列增删分别对照；表格不应因编辑丢失内容 |
| 链接原位修改 | [Markdown Reference / Links](https://support.typora.io/Markdown-Reference/) 说明点击链接后展开编辑 | 当前使用 Crepe LinkTooltip，Ctrl+K 创建链接；所有普通链接点击被阻止导航；与官方展开方式仍有差距 | 点击链接后修改标签、目标 URL，左右键离开链接；检查界面变化、选区与撤销 |
| 图片相对路径 | [Images / Relative Path](https://support.typora.io/Images/) 以当前 `.md` 的目录为默认解析基准，包含 `../` 路径 | 当前通过 Rust `read_local_image(documentPath, src)` 解析并显示；保留 Markdown 中的路径文字 | 同目录、子目录、父目录、中文空格文件名各一张；保存重开，再另存到其他目录，记录路径含义是否变化 |
| 图片编辑与插入 | [Markdown Reference / Images](https://support.typora.io/Markdown-Reference/) 说明点击图片编辑 Markdown；[Images](https://support.typora.io/Images/) 描述本地选择、拖放、剪贴板等方式 | 当前 Crepe 图片表面可编辑地址；已修正图片 alt/title 的 Markdown 映射，避免框架 resize 元数据覆盖替代文本。上传仍读取成 data URL，尚无官方式图片文件拷贝目录策略 | 点击现有图片修改路径与 alt；分别验证文件选择和粘贴。拖放、截图粘贴、文件自动拷贝如未测，明确标记 |
| 撤销 / 重做 | 官方 [Typora 1.6](https://support.typora.io/What's-New-1.6/) 明确自动应用代码语言可撤销；[稳定版记录](https://typora.io/releases/stable.html) 持续记录输入撤销粒度修复。公开快捷键页未给出撤销分组细则 | 富文本采用 ProseMirror history，源码采用 CodeMirror history；该模式文档未变时保留历史，另一模式编辑后重建目标模式历史，未实现共享撤销链 | 技术验证已通过格式变更及程序化中文的撤销重做；真实中文输入分组与官方客户端对照仍待观察 |
| 大纲 | [Outline](https://support.typora.io/Outline/) 按标题层级展示、点击定位，并在阅读或编辑时标记当前章节 | 当前从 Markdown AST 生成大纲，点击滚动与点选高亮；尚未跟随正文滚动自动更新活跃章节，也未实现各级分支折叠 | 大纲开关、中文标题定位、层级缩进；滚动正文观察活跃项；长文中点击目标应可靠 |
| 外观与排版 | [官网](https://typora.io/) 展示简洁写作表面；[About Themes](https://support.typora.io/About-Themes/) 说明主题由 CSS 控制；本机官方主题 CSS 参数见下表 | 当前实现浅色 / 深色、居中单栏、字号调整；首版按用户初始范围固定正文最大宽度 860px。与官方 GitHub 大屏扩宽、Night 914px 的宽度规则存在已知差异 | 同一窗口尺寸、同一 Markdown、官方 GitHub/Night 主题分别截图；对照正文实际宽度、边距、行距、标题、引用、代码、表格与底栏密度 |

## 本机官方客户端观察记录

以下来自主任务在本机的现场观察和随附 CSS 只读核查。窗口受用户同时操作影响，尚未取得官方客户端的语法显隐、光标移动与中文输入法操作证据；这些项目继续保持“待对照”，不由官网描述或本应用技术测试替代。

| 对照对象 | 记录 |
| --- | --- |
| 官方 Typora 客户端 | 用户指定路径 [Typora.exe](E:/软件工具/Typora/Typora.exe)，文件 ProductVersion 为 `1.14.15`，已实际启动观察 |
| 官方主题与窗口尺寸 | 初次观察中 GitHub 已勾选；0.1.1 对照统一外框为 `1200 × 850`，详见末节 |
| 官方顶部界面 | 中文七菜单：文件 / 编辑 / 段落 / 格式 / 视图 / 主题 / 帮助 |
| 官方侧栏与底栏 | 左侧“文件 / 大纲”标签；底部左侧有侧栏、源码图标与文档标签；字数位于右下 |
| 标题 / 加粗 / 链接语法显隐 | 待直接对照；目前只有官方文档规则，不能填客户端验证通过 |
| 列表 Enter / Tab / Backspace | 待直接对照 |
| Ctrl+/ 切换时光标、选区、滚动 | 待直接对照；本应用的 Ctrl+/ 已接入 |
| 中文 IME 候选、连续输入、撤销 | 待直接对照；技术测试注入中文不算真实 IME 验收 |
| 浅色与深色排版截图 | 0.1.1 已补齐同一示例、同尺寸下表格 / 代码块 / 列表的 GitHub 与 Night 对照；整体排版仍有其他差距 |

### 官方随附主题 CSS 的只读核查

这些参数来自该本机 Typora 安装的主题文件，属于样式源码证据；实际屏幕像素仍受窗口尺寸、缩放与字体影响。

| 官方主题 / 项目 | 核查到的规则 |
| --- | --- |
| GitHub 基础文字 | `html` 字号 16px，`body` 行距 1.6 |
| GitHub 正文区域 | `#write` 最大宽度 860px、padding 30px；窗口宽度至少 1400px 时最大宽度 1024px，至少 1800px 时 1200px |
| GitHub 标题字号 / 行距 | H1：2.25em / 1.2；H2：1.75em / 1.225；H3：1.5em / 1.43；H4：1.25em |
| GitHub 标题间距 | 通用标题上下 margin 为 1rem，H1 / H2 带细底线 |
| GitHub 块间距 | 段落、引用、列表、表格 margin 为 .8em |
| Night 配色 | 正文背景 `#363B40`、侧栏 `#2E3033`、正文 `#b8bfc6` |
| Night 行距 / 宽度 | `body` 行距 1.625rem，`#write` 最大宽度 914px |

首版选择：保持用户初始要求的 800—860px 范围，正文最大宽度固定为 860px。该选择保留为本项目明确取舍；不宣称与官方 GitHub 的大屏响应或 Night 宽度完全一致。

## 本应用技术验证状态

详细断言和环境见 [编辑内核技术验证](editor-core-verification.md)。以下已通过结果来自浏览器中的独立 `tests/harness.html` 测试页；它们只证明本应用的内容、DOM 和编辑状态，不证明与官方客户端的语法显隐、IME 或自然光标行为一致。

| 技术验证 | 已记录结果与范围 |
| --- | --- |
| 20 轮源码 / 富编辑往返 | CommonMark / GFM 混合文档原文不变、0 次修改事件；包含 CRLF、列表、任务、表格、代码和图片 |
| 图片 alt/title | 修改正文标题后保留图片原始相对路径、alt 与 title；撤销恢复原文 |
| 撤销重做 | 富编辑格式修改与源码程序化中文、标点、撤销、重做、往返同步通过 |
| 公式 | 行内 KaTeX 和块级 `.katex-display` 真实 DOM 渲染通过，源码往返与标题编辑后仍保留公式语法；块公式先滚入视口再等待挂载 |
| 长中文文档 | 56,297 字符、1,400 段的加载及标题变更约 445ms，末段内容仍在；尚不代表持续输入延迟或真实桌面滚动帧率 |
| 保真边界 | frontmatter、HTML、脚注、双链、指令块进入源码保护；代码中对应检测与 AST 结构比较有定向测试 |

## 验收记录的写法

- **源码实现**：说明代码已接入哪个动作，不能写成桌面验收通过。
- **自动化结果**：记录断言与运行环境，尤其区分注入中文字符串、模拟 composition 事件和真实 IME 选词。
- **实际桌面结果**：记录真实 Windows 窗口、原生打开保存与文件内容核对。
- **与官方一致性**：只有同一操作已在两边直接观察，才填写一致；不一致时明确光标、标记显隐、菜单、滚动或排版的具体差距。

内容保真、写入失败不丢稿、UTF-8/BOM/换行与手动保存属于本项目独立的文件可靠性验收项，仍按用户要求验证；不需要以 Typora 内部文件实现来替代这些断言。

## 桌面实测记录（2026-10-27）

环境：Windows 11，`build.ps1` 重新构建后的桌面程序（北京时间 22:30 生成），由 Claude 远程操作屏幕完成。

| 操作 | 结果 |
| --- | --- |
| 启动程序 | 正常，七个中文菜单、大纲、状态栏显示 |
| 输入标题、加粗、斜体、列表；列表末尾回车新建项 | 正常排版，大纲同步 |
| Ctrl+S 原生保存对话框，保存为 `examples\保存 测试.md`（中文加空格） | 成功；磁盘文件为 UTF-8、LF，内容正确 |
| 修改后直接关闭窗口 | 弹出“保存更改？”；“取消”保留窗口，“保存”写盘后关闭 |
| 重新启动，Ctrl+O 打开该文件 | 内容完整 |
| Ctrl+/ 切到源码模式新增一行标题，再切回 | 内容同步，大纲出现新标题 |
| 打开 `examples\写作示例.md` | 任务列表、引用、表格、代码块、相对路径图片正常显示 |

观察到的问题：编辑后保存时 `-` 列表被写成 `*`；表格行高明显高于官方 GitHub 主题；代码块高亮偏淡；列表圆点偏小偏浅。已记入 [路线图](roadmap.md)。

中文由远程工具注入，不等于手动拼音选词；手动 IME 选词此前已由 Codex 实测通过。

## 0.1.1：列表输出与外观细节（2026-10-27）

范围仅为无序列表输出，以及表格、代码块、普通列表符号；文件读写、保存流程、源码保护和依赖版本不变。本节沿用前面的保存 / 重新打开验收，不重复执行。

### 本机官方主题与实现核对

只读核对 `E:\软件工具\Typora\resources\style\themes\github.css`、`night.css` 及其代码高亮规则，以官方主题为数值来源，样式仍独立实现。

| 项目 | GitHub 浅色 | Night 深色 |
| --- | --- | --- |
| 表格 | 单元格 padding `6px 13px`，正文 `16px / 1.6`，边框 `#dfe2e5`；清除单元格段落额外 margin / padding | padding `5px 10px`，行距 `1.625`，边框 `#474d54`；不套用浅色斑马底 |
| 代码块 | 底色 `#f8f8f8`、边框 `#e7eaed`、圆角 `3px`，字号 `.9em` | 底色 `#333`、无边框，字号 `.875em` |
| 语法高亮 | 按官方 CodeMirror 5 浅色主题的语义颜色映射 CodeMirror 6 token | 按官方 Night 语义颜色映射；已观测 keyword `#c88fd0`、string `#d26b6b` |
| 普通列表符号 | 原生 marker 继承 16px 正文及 `#333`；一级实心圆、二级空心圆、三级方块 | 相同大小和层级规则，颜色继承正文 `#b8bfc6` |

任务列表复选框不在普通列表符号调整范围内。高亮语义分类由不同版本的编辑内核产生，不承诺所有语言的每个 token 都与官方完全一致。

### 自动化验证

- `npx tsc --noEmit` 通过；`npm test` 33 / 33 通过。
- 新增真实 Edge 富编辑测试：含普通、嵌套和任务列表的文档经过编辑后，Markdown 中无序列表统一输出 `-`；配置使用 `remarkStringifyOptionsCtx` 的 `bullet: '-'`，不做字符串替换。
- 未编辑 CRLF 文档中的 `*` 列表仍保持原文；编辑并撤销后恢复原文，原有未编辑保真测试继续通过。
- 已重新运行 `build.ps1` 生成最终 `croquill.exe`，exe 修改时间晚于最后的源码修改；实际启动这份程序，浅色与 Night 代码块的活动行均为透明、行号为 `#999`，最终截图已检查。

### 同尺寸桌面对照

环境为 Windows 11，官方 Typora `1.14.15` 与 Croquill，均打开 `examples\写作示例.md`，外框统一为 `1200 × 850`，系统 DPR 为 `1.25`。官方 GitHub 主题已在菜单中实际选中。

| 对照处 | 已观察结论 |
| --- | --- |
| 表格 | 两边单行约 `48` 物理像素高；Croquill 测得约 `38.4` CSS 像素，原来的多余段落间距已消除，行密度接近官方 |
| 代码块 | `const`、变量 `words` 与字符串的主要配色已对照官方；框体底色和边框已按官方规则调整。CodeMirror 5 / 6 的字体、工具行和行号呈现仍有差异 |
| 普通列表 | marker 大小与颜色已直接观察，随正文颜色显示；二级采用空心圆，任务复选框不受影响 |
| Night 补充 | 官方实际切换 Night 并查看代码、表格；Croquill 测得表格单元格 padding `5px 10px`、行高约 `36.8` CSS 像素、代码底色 `#333`，keyword / string 颜色如上表 |

对照过程中还发现较窄窗口底部出现横向滚动条，已单独记入路线图。本轮没有扩大修改正文宽度、字体、代码工具栏或文件操作。

本轮截图保存在本机 Codex 输出目录 `C:\Users\CampusXe\.codex\visualizations\2026\10\27\01a17d8c-ff87-7b92-a656-49ffcded1e08`：

- GitHub 表格 / 代码：`v011-typora-light-code.png`、`v011-croquill-light-final.png`。
- Night 表格 / 代码：`v011-typora-night-code.png`、`v011-croquill-night-final.png`。
- 列表符号：`v011-typora-light-top.png`、`v011-croquill-light-top.png`、`v011-croquill-night-top.png`。
