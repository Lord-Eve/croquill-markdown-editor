$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$builtExe = Join-Path $PSScriptRoot 'src-tauri\target\release\typorax.exe'
if (Test-Path -LiteralPath $builtExe) {
    Start-Process -FilePath $builtExe -WorkingDirectory $PSScriptRoot -WindowStyle Normal
} else {
    Write-Host '尚未构建程序，请先运行 .\build.ps1。'
}
