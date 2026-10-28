# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 变更

- 项目更名为 Croquill（原名 TyporaX），正式全称为 Croquill — Markdown Editor；程序、窗口、帮助和构建产物同步使用新名称
- 应用标识和本地设置键同步更名，主题、字号等设置会恢复默认；本地 Markdown 文件不受影响
- GitHub 仓库地址更新为 `Lord-Eve/croquill-markdown-editor`

## [0.1.0] - 2026-10-27

第一个基线版本：能运行，基础功能可用。

### 新增

- Tauri 2 桌面程序，Windows 原生打开 / 保存对话框
- 新建、打开、保存、另存为；关闭窗口或打开新文件时，如有未保存修改，提示“保存 / 不保存 / 取消”
- 安全写入：临时文件 + 原子替换；保留 UTF-8 BOM 与 LF / CRLF 换行；检测外部修改冲突；拒绝非 UTF-8 文件
- 所见即所得编辑（Milkdown Crepe）：标题、加粗、斜体、删除线、行内代码、链接、列表、任务列表、引用、表格、代码块、KaTeX 公式、图片
- 源码模式（CodeMirror 6），Ctrl+/ 切换，模式之间内容同步
- 相对路径图片按当前文档所在目录解析并显示
- 源码保护：frontmatter、原始 HTML、脚注、双链等暂不支持的语法自动进入源码模式，不改写原文
- 左侧大纲、底部状态栏（字数 / 编码 / 换行）、GitHub 浅色与 Night 深色主题、字号调节
- Typora 风格的中文菜单栏与快捷键（Ctrl+N / O / S / Shift+S / B / I / K / 1~6）

### 验收

- 自动测试：TypeScript 类型检查通过，Vitest 31 项通过
- 桌面实测（2026-10-27，Windows 11）：输入、保存为中文加空格的文件名、未保存关闭提示（取消 / 保存）、重新打开、源码模式往返编辑、打开含表格 / 代码块 / 图片的示例文档，全部正常

[未发布]: https://github.com/Lord-Eve/croquill-markdown-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Lord-Eve/croquill-markdown-editor/releases/tag/v0.1.0
