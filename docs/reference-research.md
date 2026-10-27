# 历史参考仓库核查与 Tauri 官方文档

核查日期：2026-10-27。只读查看参考仓库，未克隆、修改或替换现有 Typora / Typora Next。

## 当前设计与验收依据

根据用户后续明确指令，**唯一产品体验参照为官方 [Typora](https://typora.io/)**，包括外观、排版与所见即所得交互。Typora Next 的界面、预览器交互及其声称的 Typora 风格均不作为设计验收依据。

下文的 Typora Next 许可证检查仅保留为历史背景。官方文档证据、实现差距和本机观察项统一见 [typora-acceptance.md](typora-acceptance.md)。实际 Typora 行为以本机官方客户端对照观察为准；官网文字不能证明本项目已经还原该行为。

## 参考仓库的许可证

参考分支：[Lord-Eve/typora-next 的 typora-ui](https://github.com/Lord-Eve/typora-next/tree/typora-ui)，核查时分支提交 `bec6d9dc912509073e9665ef9058fceef6412243`。

- [README.md](https://github.com/Lord-Eve/typora-next/blob/bec6d9dc912509073e9665ef9058fceef6412243/README.md) 宣称 MIT。
- [package.json](https://github.com/Lord-Eve/typora-next/blob/bec6d9dc912509073e9665ef9058fceef6412243/package.json) 的 `license` 却是 ISC。
- [src-tauri/Cargo.toml](https://github.com/Lord-Eve/typora-next/blob/bec6d9dc912509073e9665ef9058fceef6412243/src-tauri/Cargo.toml) 的 `license` 为空。
- 该提交的完整 Git 树有 617 条路径，没有文件名包含 LICENSE / COPYING / NOTICE 的文件，GitHub 仓库 API 的 `license` 为 `null`。

历史核查结论：许可证声明存在矛盾，缺少完整许可文本与版权声明，不把它当作许可信息完整的代码包直接整段搬运。若以后确需复制具体源码，应先补齐对应作者的许可与版权信息。当前开发改为直接参照官方 Typora，原创实现样式与交互。

## 历史样式查看记录（不作为验收依据）

曾查看 [dist/styles/typora-ui.css](https://github.com/Lord-Eve/typora-next/blob/bec6d9dc912509073e9665ef9058fceef6412243/dist/styles/typora-ui.css)。该文件是一个 scoped CSS 外观覆盖层。参考项目的 README 将其定位为“重预览、轻编辑”的 Markdown 预览器。其样式数值、源码显示和渲染功能不能证明官方 Typora 的排版、当前块编辑、语法显隐、选区与 IME 体验。

## Tauri 2 官方 API 要点

### 原生打开与保存对话框

来源：[Dialog 插件指南](https://v2.tauri.app/plugin/dialog/)、[JavaScript Dialog API](https://v2.tauri.app/reference/javascript/dialog/)。

- Rust 侧注册 `tauri_plugin_dialog::init()`，前端使用 `@tauri-apps/plugin-dialog`。
- `open({ multiple: false, directory: false, filters: [...] })` 返回 `string | null`；用户取消是 `null`。
- `save({ defaultPath, filters })` 返回 `string | null`。对话框只选择路径，不写入文档。
- 默认权限包含 `allow-message`、`allow-save`、`allow-open`。可按实际使用能力精确配置。
- 文件路径应以字符串直接传入 Rust 命令，不拼接 shell 命令；可避免中文与空格路径转义问题。
- `open()` 选择的路径会加入文件系统与 asset scope，但该授权默认不跨重启持久化。选中文档本身也不等于整个文档目录中的所有图片都已获得授权。
- 较新的 Dialog API 支持带自定义“是 / 否 / 取消”按钮的 `message()`，文档标注从 2.4.0 起提供；锁定版本时需对照真实包类型。也可以使用应用内三按钮模态框，保留清楚的取消行为。

### 关闭窗口与未保存提示

来源：[Window JavaScript API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)。

- `getCurrentWindow().onCloseRequested(handler)` 拦截关闭请求，返回用于卸载监听器的 `UnlistenFn`。
- 在处理函数返回前调用 `event.preventDefault()` 可以保留窗口。可先阻止关闭，再等待异步保存 / 用户选择，避免保存过程中窗口已退出。
- `close()` 会再次触发关闭请求；通过显式允许关闭状态避免递归提示。
- `destroy()` 强制关闭、不再发起关闭请求，必须仅在保存成功或用户明确选择不保存后调用。
- 自定义关闭涉及 `core:window:allow-close` / 对应 destroy 权限，默认窗口权限不包含所有变更能力；使用哪个命令就配置哪个能力。

### 本地图片与 asset protocol

来源：[Asset protocol scope](https://v2.tauri.app/security/asset-protocol/)、[CSP](https://v2.tauri.app/security/csp/)。

- `convertFileSrc(absolutePath)` 生成 WebView 可加载的本地资源 URL；绝对路径需先根据当前 Markdown 文件目录解析。
- `tauri.conf.json` 中启用 `app.security.assetProtocol.enable`，并为实际路径设置有效 scope。仅生成 URL 不代表该路径能加载。
- 建议在 Rust 读取文档后按需授权当前文档目录，避免静态放开整个磁盘；对位于父目录的相对图片应明确决定与验证。
- Windows CSP 的本地图片源需包含 `asset:` 与 `http://asset.localhost`，视 useHttpsScheme 配置可能需 HTTPS host；`blob:` / `data:` 视图片实现加入。
- scope 的 `deny` 优先于 `allow`。路径匹配是基于解析后的绝对路径。Unix 隐藏目录还受 `requireLiteralLeadingDot` 控制。
- 如果启动后重新打开文档时重新授权其目录，可以不引入 persisted-scope 插件；若要跨启动记住 scope，官方提供带 `protocol-asset` 特性的 persisted-scope。

## 研究边界

本文件记录官方契约与参考仓库的静态核查。锁定依赖版本、实际编译、Windows 文件替换可靠性和实际 UI 验收，以本项目的构建与测试结果为准。
