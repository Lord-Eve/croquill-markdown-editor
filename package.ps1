$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.tools\cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $PSScriptRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $PSScriptRoot '.tools\rustup'
    $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}
npm run tauri -- build --bundles nsis
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
$nsisDir = Join-Path $PSScriptRoot 'src-tauri\target\release\bundle\nsis'
$setups = @(Get-ChildItem -LiteralPath $nsisDir -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
if ($setups.Count -eq 0) {
    Write-Error "NSIS installer (*-setup.exe) was not found in $nsisDir"
    exit 1
}
if ($setups.Count -gt 1) {
    Write-Warning "Multiple *-setup.exe files found in $nsisDir; showing the newest one."
}
$installer = $setups[0]
Write-Host "FullName: $($installer.FullName)"
Write-Host "Length: $($installer.Length)"
Write-Host "LastWriteTime: $($installer.LastWriteTime)"
exit 0
