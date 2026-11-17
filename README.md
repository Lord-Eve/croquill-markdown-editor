# Croquill

Croquill — Markdown Editor

Croquill（读作 kro-KWILL）由 croquis（速写）和 crow quill（绘图用的细笔尖）合成。

一款本地 Markdown 写作编辑器，目标是新建、打开、修改都流畅，外观、正文排版和所见即所得交互都向 [官方 Typora](https://typora.io/) 看齐。

> 本项目是独立实现的个人项目，与 Typora 官方没有关联。

## 当前状态：0.7.0（基础可用）

**已经能用**

- 新建、打开、保存、另存为，用的是 Windows 原生文件对话框；关闭窗口时如有未保存修改会提示
- 安全保存：先写临时文件再替换原文件，写入失败不会损坏原文；保留原文件的 UTF-8 / BOM 和换行格式（LF / CRLF）；文件在外部被改过时，保存会提示冲突
- 所见即所得编辑：标题、加粗、斜体、删除线、行内代码、链接、有序 / 无序 / 任务列表、引用、表格、代码块、KaTeX 公式、相对路径图片
- 图片导入：粘贴截图、拖入本地图片或通过“段落 → 图片”选文件，图片保存到文档同目录的 `文档名.assets` 文件夹，Markdown 使用相对路径；文档尚未保存时先提示保存
- 正文选中的文字可以同段、跨段拖动，源码模式也支持拖动文字
- `==高亮==`、五类提示块（Note / Tip / Important / Warning / Caution）、`[TOC]` 实时目录、脚注（悬停预览、点击跳到定义）直接排版显示；HTML 注释淡化显示原文
- 块级 HTML（`<div align="center">`、`<details>`、本地图片等）经安全过滤后直接排版显示，单击展开原位源码框修改；双链等暂不支持的语法按所属块保留原文，其他段落继续所见即所得编辑
- 行内标记随光标显隐：光标进入加粗、斜体、删除线、行内代码、高亮时显示两侧的标记字符，可以直接走进去修改；`__加粗__`、`\*` 等原写法保存后逐字符不变
- 未发布的开发版可直接显示白名单内的行内 HTML。光标碰到元素时显示标签，颜色、按键框等样式保留，元素内的文字可直接修改。
- 链接原位编辑：单击链接在原地展开 `[文字](地址 "标题")`，可以直接修改；Ctrl+单击用系统默认浏览器或邮件程序打开；Ctrl+K 插入链接或选中已有链接的地址
- 查找替换：Ctrl+F / Ctrl+H，两种模式共用，支持区分大小写和全字匹配，替换可一步撤销
- 标题快捷键：Ctrl+1～6 设级别，Ctrl+0 变回正文，Ctrl+= / Ctrl+- 升降一级；标题行首按退格变回正文
- 文件菜单记住最近 10 个文档，启动时恢复上次打开的文档；把 `.md` 文件拖进窗口可直接打开
- 另存为到其他目录时自动改写图片路径，原图留在原处
- 文首 YAML 元数据单独原样保留，可在源码模式修改；TOML、未闭合 YAML 和无法可靠转换的文档继续源码保护
- 源码模式：Ctrl+/ 切换，两种模式之间内容同步，光标停在同一个字后面，所在行在屏幕上基本不动
- 安装版：中文安装程序，不需要管理员权限，登记 `.md` / `.markdown` 文件关联，卸载时恢复原来的默认打开方式
- 左侧大纲跟随正文滚动高亮当前章节，可以按层级折叠；底部字数和编码状态、GitHub 浅色和 Night 深色两套主题、可调字号
- 中文菜单：文件 / 编辑 / 段落 / 格式 / 视图 / 主题 / 帮助

**还没做或和 Typora 有差距**：见 [路线图](docs/roadmap.md)。

## 安装

Croquill 提供**安装版**和**便携版**两种方式，均支持 Windows 10/11，且共用同一份本地设置与最近打开记录：

- **安装版（推荐日常使用）**：下载运行 `Croquill_<版本>_x64-setup.exe`。安装界面为简体中文，默认安装到当前用户目录（`%LOCALAPPDATA%\Croquill`），**不需要管理员权限**，会自动创建开始菜单快捷方式并在注册表中登记 `.md` 与 `.markdown` 文件关联（ProgID 为 `Croquill.Markdown`）。
- **便携版**：直接下载并运行单文件 `croquill.exe`（或按下方“运行”步骤自行构建），无需安装，适合随用随走；不会主动向系统登记文件关联。

### 设为默认打开方式

- **未曾手动固定过其他程序时**：如果系统此前没有为 `.md` 或 `.markdown` 固定过其他默认打开方式，安装后直接打开或双击 `.md` / `.markdown` 文件就会由 Croquill 启动。
- **之前已选过其他默认软件时**：Windows 会优先保留用户已选定的默认应用。如需切换为 Croquill，请右键任意 `.md`（或 `.markdown`）文件 → **打开方式** → **选择其他应用** → 找到 **Croquill** 并选择**始终**；也可以在 Windows **设置 → 应用 → 默认应用** 中按 `.md` / `.markdown` 扩展名指定 Croquill。

### 未签名时的安全提示

目前提供的安装包和便携版 `croquill.exe` 尚未进行代码签名。从网络下载后首次运行若出现“Windows 已保护你的电脑”（SmartScreen）拦截提示，请确认文件来源为本项目的官方 GitHub Releases，然后点击**更多信息** → **仍要运行**即可继续。

### 卸载

- 在 Windows **设置 → 应用 → 已安装的应用**（或控制面板“程序和功能”）中找到 **Croquill** 选择卸载，或直接运行安装目录中的 `uninstall.exe`。
- 卸载确认页中的**删除应用程序数据**选项默认不勾选，保留最近打开列表、主题与字号等设置；静默卸载同样不删除应用数据。
- 用户的 Markdown 文档不会被改动。文件关联方面：卸载时若 `.md` / `.markdown` 仍指向 Croquill，会恢复安装前的默认关联（原本没有默认值的会删除默认项并清理因此变空的扩展名键）；若用户安装后已自行改为其他默认程序，卸载时不会改回原备份，同时清除 Croquill 留下的关联备份值。

## 运行

需要 Windows 10/11。

| 你想做什么 | 怎么做 |
| --- | --- |
| 启动已构建的程序 | 右键 `start.ps1` →“使用 PowerShell 运行” |
| 改完代码后重新构建 | 右键 `build.ps1` →“使用 PowerShell 运行”，结束后得到 `src-tauri\target\release\croquill.exe` |
| 打出 Windows 安装包 | 右键 `package.ps1` →“使用 PowerShell 运行”，结束后在 `src-tauri\target\release\bundle\nsis\` 得到 `Croquill_<版本>_x64-setup.exe` |
| 开发时实时预览 | 运行 `dev.ps1` |
| 文件夹占用太大时清理 | 右键 `clean.ps1` →“使用 PowerShell 运行”，只删测试和预览的编译缓存，程序照常能用 |
| 彻底清理编译缓存 | 右键 `clean-all.ps1` →“使用 PowerShell 运行”，只保留 `croquill.exe`；下次构建会整份重新编译，耗时较长 |

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
- [发布流程](docs/release.md)
- [官方 Typora 对照与验收记录](docs/typora-acceptance.md)
- [编辑内核技术验证](docs/editor-core-verification.md)
- [参考仓库与 Tauri 文档核查](docs/reference-research.md)
- [给 AI 编程助手的工作手册](AGENTS.md)

## 许可

[MIT](LICENSE)
