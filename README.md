# Croquill

Croquill — Markdown Editor

Croquill（读作 kro-KWILL）由 croquis（速写）和 crow quill（绘图用的细笔尖）合成。

一款本地 Markdown 写作编辑器，目标是新建、打开、修改都流畅，外观、正文排版和所见即所得交互都向 [官方 Typora](https://typora.io/) 看齐。

> 本项目是独立实现的个人项目，与 Typora 官方没有关联。

## 当前状态：0.1.0（基础可用）

**已经能用**

- 新建、打开、保存、另存为，用的是 Windows 原生文件对话框；关闭窗口时如有未保存修改会提示
- 安全保存：先写临时文件再替换原文件，写入失败不会损坏原文；保留原文件的 UTF-8 / BOM 和换行格式（LF / CRLF）；文件在外部被改过时，保存会提示冲突
- 所见即所得编辑：标题、加粗、斜体、删除线、行内代码、链接、有序 / 无序 / 任务列表、引用、表格、代码块、KaTeX 公式、相对路径图片
- 源码模式：Ctrl+/ 切换，两种模式之间内容同步
- 左侧大纲、底部字数和编码状态、GitHub 浅色和 Night 深色两套主题、可调字号
- 中文菜单：文件 / 编辑 / 段落 / 格式 / 视图 / 主题 / 帮助

**还没做或和 Typora 有差距**：见 [路线图](docs/roadmap.md)。

## 运行

需要 Windows 10/11。

| 你想做什么 | 怎么做 |
| --- | --- |
| 启动已构建的程序 | 右键 `start.ps1` →“使用 PowerShell 运行” |
| 改完代码后重新构建 | 右键 `build.ps1` →“使用 PowerShell 运行”，结束后得到 `src-tauri\target\release\croquill.exe` |
| 开发时实时预览 | 运行 `dev.ps1` |

如果提示“禁止运行脚本”，在本文件夹地址栏输入 `powershell` 回车，然后执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

### 第一次在新电脑上构建

仓库不包含依赖和工具链，需要先准备：

1. [Node.js](https://nodejs.org/) 20 或更新版本，然后在本文件夹运行 `npm ci`
2. [Rust](https://rustup.rs/)（stable，MSVC 工具链）。也可以把便携版放在 `.tools\cargo` 和 `.tools\rustup`，构建脚本会优先使用它
3. Visual Studio C++ 生成工具、WebView2 运行时（Windows 11 自带）

## 技术架构

| 部分 | 用了什么 |
| --- | --- |
| 桌面外壳与文件读写 | [Tauri 2](https://v2.tauri.app/)（Rust），代码在 `src-tauri/` |
| 所见即所得编辑 | [Milkdown Crepe](https://milkdown.dev/)（基于 ProseMirror） |
| 源码模式 | [CodeMirror 6](https://codemirror.net/) |
| 界面 | TypeScript + Vite，代码在 `src/` |

## 文档

- [路线图与已知问题](docs/roadmap.md)
- [更新记录](CHANGELOG.md)
- [官方 Typora 对照与验收记录](docs/typora-acceptance.md)
- [编辑内核技术验证](docs/editor-core-verification.md)
- [参考仓库与 Tauri 文档核查](docs/reference-research.md)
- [给 AI 编程助手的工作手册](AGENTS.md)

## 许可

[MIT](LICENSE)
