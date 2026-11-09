# Croquill GUI acceptance on a real Windows runner.
#
# Evidence model (same as the manual acceptance in Drive):
#   - the window title ( "<name> - Croquill", dirty prefix = U+25CF + space )
#   - the exact bytes the app writes to disk (SHA256 before/after)
# No test is reported PASS from a screenshot or a process check alone.
#
# Opening the sample uses the app's own argv channel (the initial_path
# command returns the first non-flag CLI argument and the frontend opens
# it), because driving the native Open dialog with SendKeys proved
# unreliable on a headless runner (run #6: the dialog never confirmed and
# every dependent check failed downstream). The native Ctrl+O dialog flow
# itself stays covered by manual acceptance on a real desktop.
# A check whose prerequisite failed is recorded as SKIP, never as a
# vacuous PASS or a misleading FAIL.
#
# Exit code: 0 when no recorded test FAILs, 1 otherwise.
# Screenshots are best-effort evidence and never decide a result.
#
# NOTE: this file is intentionally ASCII-only. Non-ASCII characters needed
# for title matching are built from code points so the file parses the same
# under any code page.

param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$ExamplesDir,
    [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Continue'
$Dash = [string][char]0x2014          # em dash used in "name - Croquill"
$Dot  = [string][char]0x25CF          # dirty marker prefix in the title
$TitleSuffix = " $Dash Croquill"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$script:Results = New-Object System.Collections.ArrayList
$script:Proc = $null
$script:SampleOpen = $false

function Add-Result([string]$Id, [string]$Status, [string]$Detail) {
    [void]$script:Results.Add([ordered]@{ id = $Id; status = $Status; detail = $Detail })
    Write-Host "[$Status] $Id - $Detail"
}

function Get-Title {
    if ($null -eq $script:Proc) { return "" }
    $script:Proc.Refresh()
    if ($script:Proc.HasExited) { return "" }
    return [string]$script:Proc.MainWindowTitle
}

function Wait-Title([scriptblock]$Predicate, [int]$TimeoutSec, [string]$What) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $t = Get-Title
        if (& $Predicate $t) { return $t }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "Timed out waiting for $What; last title: '$(Get-Title)'"
    return $null
}

function Focus-App {
    if ($null -eq $script:Proc -or $script:Proc.HasExited) { return }
    $script:Proc.Refresh()
    [void][Win32]::SetForegroundWindow($script:Proc.MainWindowHandle)
    Start-Sleep -Milliseconds 400
}

function Send([string]$Keys, [int]$AfterMs = 800) {
    Focus-App
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Start-Sleep -Milliseconds $AfterMs
}

function Click-EditorCenter {
    $script:Proc.Refresh()
    $rect = New-Object Win32+RECT
    if (-not [Win32]::GetWindowRect($script:Proc.MainWindowHandle, [ref]$rect)) { return }
    $x = [int](($rect.Left + $rect.Right) / 2)
    $y = [int](($rect.Top + $rect.Bottom) / 2)
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
    [Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # left down
    [Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # left up
    Start-Sleep -Milliseconds 500
}

function Save-Screenshot([string]$Name) {
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $path = Join-Path $OutDir "screenshots\$Name.png"
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $gfx.Dispose(); $bmp.Dispose()
    } catch {
        Write-Host "Screenshot $Name failed (non-fatal): $($_.Exception.Message)"
    }
}

function Start-App([string]$Argument) {
    if ([string]::IsNullOrEmpty($Argument)) {
        $script:Proc = Start-Process -FilePath $ExePath -PassThru
    } else {
        $script:Proc = Start-Process -FilePath $ExePath -ArgumentList "`"$Argument`"" -PassThru
    }
    Start-Sleep -Seconds 1
}

function Stop-App {
    if ($null -ne $script:Proc -and -not $script:Proc.HasExited) {
        [void]$script:Proc.CloseMainWindow()
        if (-not $script:Proc.WaitForExit(10000)) {
            Stop-Process -Id $script:Proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1
}

function Get-Hash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# Wait until the foreground window is the native file dialog (class #32770).
function Wait-Dialog([int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $h = [Win32]::GetForegroundWindow()
        if ($h -ne [IntPtr]::Zero) {
            $sb = New-Object System.Text.StringBuilder 256
            [void][Win32]::GetClassName($h, $sb, 256)
            if ($sb.ToString() -eq "#32770") { return $true }
        }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

# Drive a native file dialog: wait for it, paste the path, confirm.
function Dialog-EnterPath([string]$Path, [int]$DialogTimeoutSec = 15) {
    if (-not (Wait-Dialog $DialogTimeoutSec)) { return $false }
    Start-Sleep -Milliseconds 400
    Set-Clipboard -Value $Path
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    return $true
}

# ---------------------------------------------------------------- setup
if (-not (Test-Path -LiteralPath $ExePath)) { throw "Exe not found: $ExePath" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "screenshots") | Out-Null

$base   = Join-Path $env:TEMP "croquill-acceptance"
$srcDir = Join-Path $base "src"
$dstDir = Join-Path $base "saveas-out"
if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null

$sampleSrc = Join-Path $ExamplesDir "file-workflow.md"
$assetsSrc = Join-Path $ExamplesDir "file-workflow.assets"
Copy-Item -LiteralPath $sampleSrc -Destination $srcDir
if (Test-Path -LiteralPath $assetsSrc) { Copy-Item -LiteralPath $assetsSrc -Destination $srcDir -Recurse }

$sample = Join-Path $srcDir "file-workflow.md"
$origHash  = Get-Hash $sample
$origBytes = [System.IO.File]::ReadAllBytes($sample)
$marker = "<!-- croquill-acceptance-marker -->"

try {
    # ------------------------------------------------------------ T2 launch
    Start-App
    $t = Wait-Title { param($x) $x.EndsWith($TitleSuffix) } 60 "main window title"
    if ($null -ne $t) { Add-Result "launch" "PASS" "Main window appeared, title '$t'." }
    else { Add-Result "launch" "FAIL" "Main window title never appeared." }
    Save-Screenshot "01-launch"
    if ($null -eq $t) { throw "Cannot continue without a main window." }

    # --------------------------------------- T3 open file via argv channel
    Stop-App
    Start-App $sample
    $t = Wait-Title { param($x) $x -eq "file-workflow.md$TitleSuffix" } 60 "sample opened"
    if ($null -ne $t) {
        $script:SampleOpen = $true
        Add-Result "open-sample" "PASS" "Sample opened via argv (initial_path)."
    } else {
        Add-Result "open-sample" "FAIL" "Title did not become the sample name; last title '$(Get-Title)'."
    }
    Start-Sleep -Seconds 2
    Save-Screenshot "02-opened"

    if (-not $script:SampleOpen) {
        Add-Result "noedit-save-bytes" "SKIP" "Blocked by open-sample failure."
        Add-Result "source-edit-save" "SKIP" "Blocked by open-sample failure."
        Add-Result "undo-save-bytes" "SKIP" "Blocked by open-sample failure."
        Add-Result "saveas-rebase" "SKIP" "Blocked by open-sample failure."
        Add-Result "restart-restore" "SKIP" "Blocked by open-sample failure."
    } else {
        # --------------------------------------- T3b no-edit save, byte exact
        Send "^s" 1500
        $h = Get-Hash $sample
        if ($h -eq $origHash) { Add-Result "noedit-save-bytes" "PASS" "SHA256 unchanged after Ctrl+S with no edits." }
        else { Add-Result "noedit-save-bytes" "FAIL" "Hash changed without edits: $h" }

        # ----------------------------- T4 source-mode edit, save, prefix kept
        Click-EditorCenter
        Send "^/" 1200                          # Ctrl+/ -> source mode
        Click-EditorCenter                      # mode switch remounts the editor; click again so the new editor really has keyboard focus
        Send "^{END}" 500
        Set-Clipboard -Value "`r`n$marker`r`n"
        Send "^v" 600
        $dirty = Wait-Title { param($x) $x.StartsWith($Dot) } 10 "dirty marker after paste"
        Send "^s" 500
        $t = Wait-Title { param($x) -not $x.StartsWith($Dot) } 20 "dirty marker cleared after save"
        $bytes = [System.IO.File]::ReadAllBytes($sample)
        $text  = [System.Text.Encoding]::UTF8.GetString($bytes)
        $prefixOk = $bytes.Length -ge $origBytes.Length
        if ($prefixOk) {
            for ($i = 0; $i -lt $origBytes.Length; $i++) {
                if ($bytes[$i] -ne $origBytes[$i]) { $prefixOk = $false; break }
            }
        }
        if ($null -ne $dirty -and $null -ne $t -and $text.Contains($marker) -and $prefixOk) {
            Add-Result "source-edit-save" "PASS" "Marker saved, original prefix byte-identical, dirty marker cleared."
        } else {
            Add-Result "source-edit-save" "FAIL" "pasteDirtied=$($null -ne $dirty) titleCleared=$($null -ne $t) markerFound=$($text.Contains($marker)) prefixIntact=$prefixOk"
        }
        Save-Screenshot "03-source-edit"

        # --------------------------------------- T5 undo + save restores bytes
        # The T4 paste lands as more than one undo unit (measured: the
        # pasted CRLF + marker text are separate units), so undo in a
        # bounded loop, saving and re-hashing after each step, until the
        # bytes match the original again. Extra undos are no-ops: this
        # document session has no other edits on its undo stack.
        $restored = $false
        $t = $null
        for ($k = 0; $k -lt 4 -and -not $restored; $k++) {
            Send "^z" 600
            Send "^s" 500
            $t = Wait-Title { param($x) -not $x.StartsWith($Dot) } 20 "dirty marker cleared after undo+save"
            if ((Get-Hash $sample) -eq $origHash) { $restored = $true }
        }
        $h = Get-Hash $sample
        if ($restored -and $null -ne $t) { Add-Result "undo-save-bytes" "PASS" "Undo + Ctrl+S restored the exact original SHA256." }
        else { Add-Result "undo-save-bytes" "FAIL" "Hash after undo+save: $h (expected $origHash)" }

        # --------------------------------------------- T6 Save As, path rebase
        $target = Join-Path $dstDir "file-workflow.md"
        Send "^+s" 1000                         # Ctrl+Shift+S, native Save As dialog
        $dlgOk = Dialog-EnterPath $target
        if (-not $dlgOk) {
            Add-Result "saveas-rebase" "FAIL" "Save As dialog never became the foreground window."
        } else {
            $deadline = (Get-Date).AddSeconds(20)
            while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $target)) { Start-Sleep -Milliseconds 500 }
            if (Test-Path -LiteralPath $target) {
                $targetText = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
                $rebased = $targetText -match "\.\./src/file-workflow\.assets/"
                $assetsCopied = Test-Path -LiteralPath (Join-Path $dstDir "file-workflow.assets")
                $origUntouched = (Get-Hash $sample) -eq $origHash
                if ($rebased -and -not $assetsCopied -and $origUntouched) {
                    Add-Result "saveas-rebase" "PASS" "Image paths rebased to ../src/..., no assets copied, original file untouched."
                } else {
                    Add-Result "saveas-rebase" "FAIL" "rebased=$rebased assetsCopied=$assetsCopied originalUntouched=$origUntouched"
                }
            } else {
                Add-Result "saveas-rebase" "FAIL" "Save As target file was not created at $target."
            }
        }
        Save-Screenshot "04-saveas"

        # --------------------------------------------- T7 restart restores doc
        Stop-App
        Start-App
        $t = Wait-Title { param($x) $x -eq "file-workflow.md$TitleSuffix" } 40 "document restored after restart"
        if ($null -ne $t) { Add-Result "restart-restore" "PASS" "Relaunch restored the last document (title match)." }
        else { Add-Result "restart-restore" "FAIL" "Last title after relaunch: '$(Get-Title)'." }
        Save-Screenshot "05-restart"
    }

    # --------------------------------------- T8 new doc, restart stays blank
    Send "^n" 1000                          # Ctrl+N
    $t = Wait-Title { param($x) $x.EndsWith($TitleSuffix) -and $x -notlike "*file-workflow*" } 20 "new blank document"
    Stop-App
    Start-App
    $t = Wait-Title { param($x) $x.EndsWith($TitleSuffix) -and $x -notlike "*file-workflow*" } 40 "blank document after restart"
    if ($null -ne $t) { Add-Result "restart-blank" "PASS" "After New + restart the app stayed on a blank document." }
    else { Add-Result "restart-blank" "FAIL" "Last title after relaunch: '$(Get-Title)'." }
    Save-Screenshot "06-blank"
}
catch {
    Add-Result "harness" "FAIL" "Harness stopped early: $($_.Exception.Message)"
}
finally {
    Stop-App
    $results = @($script:Results)
    $results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir "results.json") -Encoding UTF8
    $lines = @("# Croquill Windows GUI acceptance", "", "- Exe: $ExePath", "- Sample: examples/file-workflow.md", "")
    foreach ($r in $results) { $lines += "- [$($r.status)] $($r.id) - $($r.detail)" }
    $lines -join "`r`n" | Set-Content -LiteralPath (Join-Path $OutDir "report.md") -Encoding UTF8
    $failed = @($results | Where-Object { $_.status -eq "FAIL" }).Count
    Write-Host "Acceptance finished: $($results.Count) checks, $failed failed."
    if ($failed -gt 0) { exit 1 }
    exit 0
}
