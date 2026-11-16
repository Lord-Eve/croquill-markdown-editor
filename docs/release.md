# Croquill 发布步骤

发布新版本前请先确认工作区干净且位于最新 `main` 分支。整个流程**按顺序执行**，避免版本号不一致或产物遗漏。

## 1. 统一修改版本号

将以下 5 个文件中的版本号改为新版本号 `x.y.z`（例如 `0.7.0`）：

1. `package.json`（`"version": "x.y.z"`）
2. `package-lock.json`（顶层 `"version"` 与 `packages[""].version`）
3. `src-tauri/Cargo.toml`（`[package]` 下的 `version = "x.y.z"`）
4. `src-tauri/Cargo.lock`（`name = "croquill"` 条目下的 `version = "x.y.z"`）
5. `src-tauri/tauri.conf.json`（`"version": "x.y.z"`）

## 2. 更新更新记录与 README

1. 在 `CHANGELOG.md` 中，将 `## [未发布]` 改为 `## [x.y.z] - YYYY-MM-DD`（在上方重新保留空的 `## [未发布]` 小节），并更新底部的比较链接：
   - `[未发布]` 指向 `compare/vx.y.z...HEAD`
   - 新增 `[x.y.z]` 指向 `compare/v<上一版本>...vx.y.z`
2. 更新 `README.md` 的 `## 当前状态：x.y.z（...）` 标题与主要新特性摘要。

## 3. 检查、测试与构建产物

运行全套检查并重新构建便携版和安装版（确保两份产物的修改时间都晚于源码）：

```powershell
npx tsc --noEmit
npm test
Push-Location src-tauri; cargo test; Pop-Location
.\build.ps1
.\package.ps1
```

核对以下两份产物均已生成且版本号为 `x.y.z`：

- 便携版单文件：`src-tauri\target\release\croquill.exe`
- 安装程序：`src-tauri\target\release\bundle\nsis\Croquill_x.y.z_x64-setup.exe`

## 4. 提交与打标签

确认 `git diff` 只包含本次发布改动后提交并打标签：

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md README.md
git commit -m "发布 x.y.z"
git tag vx.y.z
git push origin main
git push origin vx.y.z
```

## 5. 创建 GitHub Release

从 `CHANGELOG.md` 复制本次 `[x.y.z]` 一节作为发布说明（可保存为临时说明文件后 `--notes-file` 传入，或在命令中直接指定），同时上传 `croquill.exe` 和安装包：

```powershell
gh release create vx.y.z `
  "src-tauri\target\release\croquill.exe" `
  "src-tauri\target\release\bundle\nsis\Croquill_x.y.z_x64-setup.exe" `
  --title "Croquill x.y.z" `
  --notes-file <本次版本说明文件>
```

发布完成后在 GitHub Releases 页面核对两个附件的名称、大小与发布说明是否齐全。
