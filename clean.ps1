# 清理 Rust 编译缓存（src-tauri\target），只删可以重新生成的文件。
#   默认：只删 target\debug（测试和开发预览的缓存），已构建的 croquill.exe 不受影响。
#   -All：清空整个 target，但保留 croquill.exe；下次运行 build.ps1 会整份重新编译，耗时较长。
# 不会触碰源码、文档、.tools、node_modules。
param(
    [switch]$All,
    [switch]$NoPause
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$target = Join-Path $PSScriptRoot 'src-tauri\target'
$debug = Join-Path $target 'debug'
$release = Join-Path $target 'release'
$exe = Join-Path $release 'croquill.exe'

function Get-SizeMB([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    return [math]::Round(($sum / 1MB), 1)
}

function Finish([int]$code) {
    if (-not $NoPause) { Read-Host '按回车键关闭' | Out-Null }
    exit $code
}

try {
    if (-not (Test-Path -LiteralPath $target)) {
        Write-Host '没有编译缓存，无需清理。'
        Finish 0
    }
    $before = Get-SizeMB $target
    Write-Host ("清理前 src-tauri\target：{0:N1} MB" -f $before)

    if ($All) {
        if (Get-Process -Name 'croquill' -ErrorAction SilentlyContinue) {
            Write-Host 'Croquill 正在运行，请先关闭程序再清理。'
            Finish 1
        }
        $backup = $null
        if (Test-Path -LiteralPath $exe) {
            $backup = Join-Path ([System.IO.Path]::GetTempPath()) ('croquill-keep-' + [guid]::NewGuid().ToString('N') + '.exe')
            Copy-Item -LiteralPath $exe -Destination $backup -Force
            if ((Get-Item -LiteralPath $backup).Length -ne (Get-Item -LiteralPath $exe).Length) {
                throw '备份 croquill.exe 失败，已停止清理。'
            }
        }
        Remove-Item -LiteralPath $target -Recurse -Force
        if ($backup) {
            New-Item -ItemType Directory -Force -Path $release | Out-Null
            Move-Item -LiteralPath $backup -Destination $exe -Force
            Write-Host '已保留 croquill.exe，start.ps1 仍可直接启动。'
        }
        Write-Host '下次运行 build.ps1 会整份重新编译，耗时较长。'
    } else {
        if (Test-Path -LiteralPath $debug) {
            Remove-Item -LiteralPath $debug -Recurse -Force
            Write-Host '已删除 target\debug。下次跑测试会重新编译这部分。'
        } else {
            Write-Host 'target\debug 不存在，无需清理。'
        }
    }

    $after = Get-SizeMB $target
    Write-Host ("清理后 src-tauri\target：{0:N1} MB，腾出约 {1:N1} MB。" -f $after, ($before - $after))
    Finish 0
} catch {
    Write-Host ('清理失败：' + $_.Exception.Message)
    Finish 1
}
