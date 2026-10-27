$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.tools\cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $PSScriptRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $PSScriptRoot '.tools\rustup'
    $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}
npm run tauri -- build --no-bundle
exit $LASTEXITCODE
