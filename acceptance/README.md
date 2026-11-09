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
