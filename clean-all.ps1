# 彻底清理：清空 src-tauri\target，保留 croquill.exe。详见 clean.ps1。
& (Join-Path $PSScriptRoot 'clean.ps1') -All @args
exit $LASTEXITCODE
