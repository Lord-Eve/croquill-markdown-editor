# Windows 自动验收（GitHub Actions）

`.github/workflows/windows-acceptance.yml` 在 GitHub 的真 Windows runner 上自动跑：

1. **必过**：`npx tsc --noEmit`、`npm test`、`cargo test`、Tauri 正式构建（`--no-bundle`，与 `build.ps1` 一致）
2. **必过**：构建出的 `croquill.exe` 能启动并出现主窗口
3. **脚本验收**（`gui-acceptance.ps1`）：用键盘操作真实程序，证据只认两样东西——窗口标题和磁盘文件的逐字节哈希，和以往人工验收的标准一致：
   - 通过命令行参数打开 `examples/file-workflow.md` 的副本；原生 Ctrl+O 留在桌面手动验收范围
   - 不编辑直接 Ctrl+S，保存后 SHA256 与原文完全一致
   - 切源码模式在文末粘贴标记行，Ctrl+S 后标记落盘且原文前缀逐字节不变、未保存圆点消失
   - Ctrl+Z 撤销后 Ctrl+S，文件恢复为原始 SHA256
   - Ctrl+Shift+S 另存为到同级另一目录：图片路径改写为 `../src/file-workflow.assets/...`、附件没有被复制、原文件未动
   - 关程序再启动：恢复上次文档；新建空白后再重启：保持空白
4. 每次运行把 `results.json`、结论 `report.md`、截图和 exe 作为 artifact 保存 30 天

**脚本代替不了的，仍需真人桌面验收**（不要因为这里全绿就当它们通过）：

- 从资源管理器拖入 `.md` 打开
- 真实中文输入法组词过程
- 和官方 Typora 并排对照显示效果
- 缺图时另存为的失败保护（需先确认目标路径再下结论）

脚本文件刻意只用 ASCII：标题里的 `—` 和未保存标记 `●` 用码点拼出，避免编码不同导致解析出错。

保存后焦点与跨保存点撤销 / 重做的专项回归及历史清空边界见 [保存焦点验收记录](../docs/save-focus-acceptance.md)。

## 安装与文件关联验收（`installer-acceptance.ps1`）

`acceptance/installer-acceptance.ps1` 在真 Windows runner 上验证 `Croquill_<版本>_x64-setup.exe` 的安装、`.md` / `.markdown` 文件关联与卸载恢复：

**覆盖范围：**

- 安装前记录 `HKCU\Software\Classes\.md`、`.markdown` 与 `FileExts\.md\UserChoice` 状态，并预先向 `HKCU\Software\Classes\.md` 写入模拟的已有 ProgID（`.markdown` 不预先写）
- 非管理员身份静默安装（`/S`），核对退出码 0、当前用户安装目录、应用与功能登记（名称与版本号）、开始菜单快捷方式及 `HKCU\Software\Classes\Croquill.Markdown` 与 `.md` / `.markdown` 键值（全量导出到 `results.json`），并单独记录 `HKCU\Software\Classes\.md` 默认值是否变化（只记录不判定）
- 准备三类含中文正文的文件（`中文 目录\笔记 一.md` 含 CRLF、`note&100%'test'(1).md` 含 LF、`sample-note.markdown` 含 UTF-8 BOM）并记录 SHA256；分别通过注册表登记的打开命令与系统“打开”动作（在 `.md` 默认值为 `Croquill.Markdown` 且无 `UserChoice` 时判定必过，否则记录实际启动程序并标注未判定）打开，验证窗口来自安装目录 `croquill.exe`、标题匹配且无未保存标记，同时测试不关第一个窗口再开第二个文件，关闭后核对 SHA256 不变
- 静默卸载（`/S`）后核对安装目录、应用与功能登记、开始菜单快捷方式和 `Croquill.Markdown` 已清除；收紧第 17 条判据：`.md` 默认值必须恢复到安装前写入的 `CroquillTest.Prior`、`.markdown` 必须回到“键不存在”或“键存在但无默认值”（出现空字符串 `""` 默认值即判失败），且两个扩展名下都没有 `Croquill.Markdown_backup` 等任何 Croquill 关联记录残留；测试文件 SHA256 不变
- 追加多场景安装卸载回归并按场景保存安装后/卸载后注册表快照：
  - **场景 B（连装两次再卸载）**：模拟已有 `.md` 关联时连续静默安装两次（覆盖重装/未卸载升级）后再静默卸载，核对安装目录/登记/快捷方式/`Croquill.Markdown` 清除，且 `.md` 与 `.markdown` 同样严格恢复、无 `Croquill.Markdown_backup` 等残留
  - **场景 C（安装后用户改用其他默认程序再卸载）**：安装后将 `HKCU\Software\Classes\.md` 改写为 `CroquillTest.Later` 再静默卸载，核对卸载不会把 `.md` 改回旧备份（仍为 `CroquillTest.Later`）、`.markdown` 干净移除、安装产物与关联残留值均已清除
  - **场景 D（原有显式空字符串 `""` 区分）**：模拟 `.markdown` 安装前已有显式空字符串 `(Default) = ""` 再安装卸载，核对卸载后仍保留 `defaultValueExists=True` 且为空字符串、无关联备份残留
- 脚本结束时将 `.md` / `.markdown` 彻底还原到运行前的最初状态；卸载后（未勾选删除应用数据时）保留 `HKCU\Software\Lord-Eve\Croquill`（记录安装目录）属于 Tauri 默认行为

**未覆盖范围（仍需真人桌面验收）：**

- 真实资源管理器里鼠标双击打开 `.md` / `.markdown`
- 资源管理器右键“打开方式”菜单及“选择其他应用”系统界面
- 从网络下载未签名安装包或 `croquill.exe` 触发的 Windows SmartScreen 安全提示交互
- 交互式图形安装与卸载界面的简体中文文本及“删除应用数据”勾选框默认不勾选行为
