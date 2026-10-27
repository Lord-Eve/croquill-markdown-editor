# AGENTS.md：给 AI 编程助手的工作手册

本项目由 AI 编程助手（Codex、Claude 等）轮流开发。项目所有者不写代码，负责试用和反馈。每次开始工作前先读完本文件。

## 产品目标

- 一款本地 Markdown 编辑器：新建、打开、修改都要流畅。
- **唯一的体验参照是官方 Typora**（https://typora.io/ 和 https://support.typora.io/），包括外观、正文排版和所见即所得交互。Typora Next 等第三方项目不作为设计或验收依据。
- 拿不准 Typora 的某个行为时，以本机官方客户端为准：`E:\软件工具\Typora\Typora.exe`（1.14.15）。主题 CSS 也在该安装目录里。
- 样式和交互都是原创实现，不复制 Typora 或其他项目的源码。

## 底线（任何改动都不能违反）

1. **不丢用户的文字。** 写文件只能走 `src-tauri/src/documents.rs` 里的安全写入：临时文件、原子替换、版本冲突检测。不要另写一条写盘路径。
2. **不改坏原文。** 打开后没有编辑过的文档，保存出来要和原文逐字节一致，包括 BOM 和换行符。暂时不能可靠编辑的语法进入“源码保护”，不能悄悄改写。
3. **中文输入法优先。** 处理键盘事件时检查 `isComposing`，输入法正在组词时不能打断，也不能触发快捷键。
4. **不提交**：`node_modules/`、`.tools/`、`dist/`、`src-tauri/target/`（已在 `.gitignore` 中）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/main.ts` | 界面骨架、菜单、快捷键、状态栏、大纲、对话框 |
| `src/editor.ts` | 编辑核心：Crepe 所见即所得 + CodeMirror 源码模式，两者之间的同步 |
| `src/session.ts` | 文档会话：路径、是否已修改、保存 / 打开 / 关闭流程 |
| `src/fidelity.ts` | 保真检查：哪些语法要进入源码保护、结构是否等价、大纲提取 |
| `src/style.css` | 全部样式，主题变量在 `:root` 中 |
| `src-tauri/src/documents.rs` | 读写文件、编码与换行检测、本地图片读取（含 Rust 单元测试） |
| `src-tauri/src/lib.rs` | Tauri 命令注册 |
| `tests/` | Vitest 单元测试；`harness.html` / `harness.ts` 是浏览器中运行的编辑内核测试页 |
| `examples/` | 手动验收用的示例文档 |
| `docs/` | 路线图、Typora 对照验收、技术验证记录 |

## 改完之后必须做

1. `npx tsc --noEmit` 和 `npm test` 全部通过。改了 Rust 就再跑 `cargo test`（在 `src-tauri/` 下）。
2. **改了前端或 Rust 代码，必须重新运行 `build.ps1`**。`typorax.exe` 不会自动更新，不重建就会测到旧版本。可以对比 exe 和源码的修改时间来确认。
3. 在 `CHANGELOG.md` 的“未发布”部分记一笔：改了什么、对用户有什么影响。
4. 完成或新发现的事项同步到 `docs/roadmap.md`。
5. 如果做了和官方 Typora 的对照，结果写进 `docs/typora-acceptance.md`。

## 环境须知

- 开发机是 Windows 11。构建脚本优先使用项目内的便携工具链 `.tools\cargo`、`.tools\rustup`，找不到才用系统 PATH 里的。
- 依赖版本在 `package.json` 和 `Cargo.toml` 中写死了精确版本。升级依赖算单独一项工作，不要顺手升级。
- 本仓库用 `.gitattributes` 关闭了换行符自动转换。不要改这一点，示例和测试依赖文件的原始字节。

## 和项目所有者沟通

- 用中文和大白话。说清楚“现在能做什么、还不能做什么、需要他做什么”，不要堆术语。
- 需要他动手时，给出具体步骤，例如“右键 `build.ps1` → 使用 PowerShell 运行”。
- 结论直接给，不要层层加免责声明。实测过的说实测结果，没测过的就说“没测”。
