# Croquill NSIS installer and file-association acceptance on a real Windows runner.
#
# Evidence model:
#   - registry keys and values (before install, after install, after uninstall)
#   - files on disk and their SHA256 hashes
#   - process executable paths (QueryFullProcessImageNameW)
#   - visible window titles ("<filename> - Croquill", dirty prefix = U+25CF + space)
#
# NOTE: this file is intentionally ASCII-only. Non-ASCII characters needed
# for paths, content, and title matching are built from code points.

param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$ExpectedVersion = ""
)

$ErrorActionPreference = 'Continue'

$Dash = [string][char]0x2014
$Dot  = [string][char]0x25CF
$TitleSuffix = " $Dash Croquill"

# Non-ASCII sample strings constructed from Unicode code points:
# "ZhongWen MuLu" -> U+4E2D U+6587 ' ' U+76EE U+5F55
$CnDirName = ([string][char]0x4E2D) + ([string][char]0x6587) + ' ' + ([string][char]0x76EE) + ([string][char]0x5F55)
# "BiJi Yi.md" -> U+7B14 U+8BB0 ' ' U+4E00 '.md'
$CnMdFileName = ([string][char]0x7B14) + ([string][char]0x8BB0) + ' ' + ([string][char]0x4E00) + '.md'
# "CeShiZhengWen" -> U+6D4B U+8BD5 U+6B63 U+6587
$CnBodyText = ([string][char]0x6D4B) + ([string][char]0x8BD5) + ([string][char]0x6B63) + ([string][char]0x6587)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32Acc {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);
}
"@

$script:Results = New-Object System.Collections.ArrayList
$script:RegDump = [ordered]@{}
$script:TestFilesReport = New-Object System.Collections.ArrayList
$script:InstalledDir = ""
$script:InstalledExe = ""
$script:StartMenuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Croquill.lnk'
$script:DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Croquill.lnk'
$script:TestWorkDir = Join-Path $env:TEMP 'croquill-installer-acceptance'

$RegPathMd          = 'Software\Classes\.md'
$RegPathMarkdown    = 'Software\Classes\.markdown'
$RegPathProgId      = 'Software\Classes\Croquill.Markdown'
$RegPathUninstall   = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Croquill'
$RegPathFileExtsMd  = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md'
$RegPathFileExtsMdn = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown'
$RegPathUserChoice  = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice'
$RegPathMdnChoice   = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoice'
$RegPathManuProduct = 'Software\Lord-Eve\Croquill'

$PriorProgId = 'CroquillTest.Prior'
$PreMdSnapshot = $null
$PreMarkdownSnapshot = $null
$PreRegistrySaved = $false

function Add-Result([string]$Id, [string]$Status, [string]$Detail) {
    [void]$script:Results.Add([ordered]@{ id = $Id; status = $Status; detail = $Detail })
    Write-Host "[$Status] $Id - $Detail"
}

function Save-Screenshot([string]$Name) {
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $path = Join-Path $OutDir "screenshots\$Name.png"
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $gfx.Dispose()
        $bmp.Dispose()
    } catch {
        Write-Host "Screenshot $Name failed (non-fatal): $($_.Exception.Message)"
    }
}

function Wait-Condition([scriptblock]$Condition, [int]$TimeoutSec, [int]$IntervalMs = 250) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $value = & $Condition
        if ($value) { return $value }
        if ((Get-Date) -ge $deadline) { return $null }
        Start-Sleep -Milliseconds $IntervalMs
    }
}

function Normalize-PathString([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
    $trimmed = $Path.Trim().Trim('"').TrimEnd('\')
    if ([string]::IsNullOrEmpty($trimmed)) { return "" }
    try {
        return [System.IO.Path]::GetFullPath($trimmed)
    } catch {
        return $trimmed
    }
}

function Get-RegKeySnapshot([Microsoft.Win32.RegistryKey]$Root, [string]$SubKeyPath) {
    $key = $Root.OpenSubKey($SubKeyPath, $false)
    if ($null -eq $key) {
        return [ordered]@{
            exists = $false
            defaultValueExists = $false
            defaultValue = $null
            values = [ordered]@{}
            subkeys = [ordered]@{}
        }
    }
    try {
        $values = [ordered]@{}
        $defaultExists = $false
        $defaultVal = $null
        foreach ($vn in @($key.GetValueNames())) {
            $val = $key.GetValue($vn, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = $key.GetValueKind($vn).ToString()
            if ($vn -eq '') {
                $defaultExists = $true
                $defaultVal = if ($null -eq $val) { $null } else { [string]$val }
                $values['(Default)'] = [ordered]@{ kind = $kind; data = $val }
            } else {
                $values[$vn] = [ordered]@{ kind = $kind; data = $val }
            }
        }
        $subkeys = [ordered]@{}
        foreach ($sk in @($key.GetSubKeyNames())) {
            $subkeys[$sk] = Get-RegKeySnapshot -Root $Root -SubKeyPath ($SubKeyPath + '\' + $sk)
        }
        return [ordered]@{
            exists = $true
            defaultValueExists = $defaultExists
            defaultValue = $defaultVal
            values = $values
            subkeys = $subkeys
        }
    } finally {
        $key.Close()
    }
}

function Set-HkcuDefaultValue([string]$SubKeyPath, [string]$Value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKeyPath, $true)
    if ($null -eq $key) { throw "Failed to open/create HKCU\$SubKeyPath" }
    try {
        $key.SetValue('', $Value, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $key.Close()
    }
}

function Restore-HkcuExtSnapshot([string]$SubKeyPath, $Snapshot) {
    if ($null -eq $Snapshot) { return }
    if (-not $Snapshot.exists) {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SubKeyPath, $false)
        return
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKeyPath, $true)
    if ($null -eq $key) { return }
    try {
        foreach ($sk in @($key.GetSubKeyNames())) {
            if (-not $Snapshot.subkeys.Contains($sk)) {
                $key.DeleteSubKeyTree($sk, $false)
            }
        }
        foreach ($vn in @($key.GetValueNames())) {
            $lookupName = if ($vn -eq '') { '(Default)' } else { $vn }
            if (-not $Snapshot.values.Contains($lookupName)) {
                $key.DeleteValue($vn, $false)
            }
        }
        if ($Snapshot.defaultValueExists) {
            $key.SetValue('', [string]$Snapshot.defaultValue, [Microsoft.Win32.RegistryValueKind]::String)
        } else {
            $key.DeleteValue('', $false)
        }
    } finally {
        $key.Close()
    }
}

function Get-ProcessExePath([int]$ProcessId) {
    $h = [Win32Acc]::OpenProcess(0x1000, $false, [uint32]$ProcessId)
    if ($h -eq [IntPtr]::Zero) { return "" }
    try {
        $sb = New-Object System.Text.StringBuilder 1024
        [uint32]$sz = [uint32]$sb.Capacity
        if ([Win32Acc]::QueryFullProcessImageNameW($h, 0, $sb, [ref]$sz)) {
            return $sb.ToString(0, [int]$sz)
        }
        return ""
    } finally {
        [void][Win32Acc]::CloseHandle($h)
    }
}

function Get-VisibleWindows {
    $list = New-Object System.Collections.ArrayList
    $cb = [Win32Acc+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        if (-not [Win32Acc]::IsWindowVisible($hWnd)) { return $true }
        $len = [Win32Acc]::GetWindowTextLengthW($hWnd)
        if ($len -le 0) { return $true }
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [void][Win32Acc]::GetWindowTextW($hWnd, $sb, $sb.Capacity)
        $title = $sb.ToString()
        if ([string]::IsNullOrWhiteSpace($title)) { return $true }
        [uint32]$winPid = 0
        [void][Win32Acc]::GetWindowThreadProcessId($hWnd, [ref]$winPid)
        [void]$list.Add([PSCustomObject]@{
            Hwnd = $hWnd
            Pid = [int]$winPid
            Title = $title
        })
        return $true
    }
    [void][Win32Acc]::EnumWindows($cb, [IntPtr]::Zero)
    [GC]::KeepAlive($cb)
    return @($list)
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-InstalledCroquillProcesses {
    if ([string]::IsNullOrEmpty($script:InstalledExe)) { return @() }
    $target = Normalize-PathString $script:InstalledExe
    $matches = New-Object System.Collections.ArrayList
    foreach ($p in @(Get-Process -Name 'croquill' -ErrorAction SilentlyContinue)) {
        $exe = Normalize-PathString (Get-ProcessExePath $p.Id)
        if ($exe -and $exe.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {
            [void]$matches.Add($p)
        }
    }
    return @($matches)
}

function Close-CroquillProcesses {
    $procs = @(Get-InstalledCroquillProcesses)
    foreach ($p in $procs) {
        try {
            if (-not $p.HasExited) {
                $wins = @(Get-VisibleWindows | Where-Object { $_.Pid -eq $p.Id })
                foreach ($w in $wins) {
                    [void][Win32Acc]::PostMessageW($w.Hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
                }
                [void]$p.CloseMainWindow()
            }
        } catch {}
    }
    $allGone = Wait-Condition {
        $alive = @(Get-InstalledCroquillProcesses | Where-Object { -not $_.HasExited })
        return ($alive.Count -eq 0)
    } 15 250
    if (-not $allGone) {
        foreach ($p in @(Get-InstalledCroquillProcesses)) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
        [void](Wait-Condition { (@(Get-InstalledCroquillProcesses).Count -eq 0) } 5 200)
    }
}

function Wait-ForCroquillWindow([string]$ExpectedFileName, [int[]]$ExcludedPids, [int]$TimeoutSec = 45) {
    $targetExe = Normalize-PathString $script:InstalledExe
    $expectedTitle = $ExpectedFileName + $TitleSuffix
    $lastObserved = ""
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $wins = @(Get-VisibleWindows)
        foreach ($w in $wins) {
            if ($ExcludedPids -contains $w.Pid) { continue }
            $exe = Normalize-PathString (Get-ProcessExePath $w.Pid)
            if (-not $exe -or -not $exe.Equals($targetExe, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            $lastObserved = "pid=$($w.Pid) title='$($w.Title)' exe='$exe'"
            $startsOk = $w.Title.StartsWith($ExpectedFileName, [System.StringComparison]::Ordinal)
            $cleanOk = -not $w.Title.StartsWith($Dot, [System.StringComparison]::Ordinal)
            $exactOk = $w.Title.Equals($expectedTitle, [System.StringComparison]::Ordinal)
            if ($startsOk -and $cleanOk -and $exactOk) {
                return [PSCustomObject]@{
                    Matched = $true
                    Hwnd = $w.Hwnd
                    Pid = $w.Pid
                    Title = $w.Title
                    Exe = $exe
                    LastObserved = $lastObserved
                }
            }
        }
        if ((Get-Date) -ge $deadline) {
            return [PSCustomObject]@{
                Matched = $false
                Hwnd = [IntPtr]::Zero
                Pid = 0
                Title = ""
                Exe = ""
                LastObserved = $lastObserved
            }
        }
        Start-Sleep -Milliseconds 250
    }
}

function Parse-CommandTemplate([string]$RegCommand, [string]$FilePath) {
    $expanded = $RegCommand.Replace('%1', $FilePath)
    if ($expanded.StartsWith('"')) {
        $endQuote = $expanded.IndexOf('"', 1)
        if ($endQuote -lt 0) { throw "Malformed quoted command: $RegCommand" }
        $exe = $expanded.Substring(1, $endQuote - 1)
        $args = $expanded.Substring($endQuote + 1).TrimStart()
        return [PSCustomObject]@{ Exe = $exe; Arguments = $args }
    }
    $firstSpace = $expanded.IndexOf(' ')
    if ($firstSpace -lt 0) {
        return [PSCustomObject]@{ Exe = $expanded; Arguments = '' }
    }
    return [PSCustomObject]@{
        Exe = $expanded.Substring(0, $firstSpace)
        Arguments = $expanded.Substring($firstSpace + 1).TrimStart()
    }
}

function Invoke-UninstallIfPresent([string]$UninstallCmdString) {
    $exePath = Normalize-PathString $UninstallCmdString
    if ([string]::IsNullOrEmpty($exePath) -or -not (Test-Path -LiteralPath $exePath)) {
        return $null
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exePath
    $psi.Arguments = '/S'
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    [void](Wait-Condition { $proc.HasExited } 60 250)
    $exitCode = if ($proc.HasExited) { $proc.ExitCode } else { -1 }
    if (-not $proc.HasExited) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    [void](Wait-Condition {
        $auRunning = @(Get-CimInstance Win32_Process -Filter "Name = 'Au_.exe'" -ErrorAction SilentlyContinue)
        $dirGone = -not (Test-Path -LiteralPath $script:InstalledDir)
        $uninstKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RegPathUninstall, $false)
        $keyGone = ($null -eq $uninstKey)
        if ($null -ne $uninstKey) { $uninstKey.Close() }
        return ($auRunning.Count -eq 0 -and $dirGone -and $keyGone)
    } 45 250)
    return $exitCode
}

# ---------------------------------------------------------------- setup
if (-not (Test-Path -LiteralPath $InstallerPath)) { throw "Installer not found: $InstallerPath" }
if ([string]::IsNullOrEmpty($ExpectedVersion)) {
    $confPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri\tauri.conf.json'
    $ExpectedVersion = (Get-Content -LiteralPath $confPath -Raw | ConvertFrom-Json).version
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'screenshots') | Out-Null

$installerFile = Get-Item -LiteralPath $InstallerPath

try {
    # ---------------------------------------- 1. Record pre-install registry
    $PreMdSnapshot = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMd
    $PreMarkdownSnapshot = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMarkdown
    $preUserChoice = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathUserChoice
    $preMdnChoice = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMdnChoice
    $preHklmMd = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::LocalMachine) -SubKeyPath $RegPathMd
    $PreRegistrySaved = $true

    $script:RegDump['preInstall'] = [ordered]@{
        hkcuMd = $PreMdSnapshot
        hkcuMarkdown = $PreMarkdownSnapshot
        hkcuMdUserChoice = $preUserChoice
        hkcuMarkdownUserChoice = $preMdnChoice
        hklmMd = $preHklmMd
    }
    $userChoiceExists = [bool]$preUserChoice.exists
    Add-Result 'pre-registry-record' 'PASS' (
        "Pre-install state: HKCU\.md exists=$($PreMdSnapshot.exists) default=$($PreMdSnapshot.defaultValue); " +
        "HKCU\.markdown exists=$($PreMarkdownSnapshot.exists) default=$($PreMarkdownSnapshot.defaultValue); " +
        "FileExts\.md\UserChoice exists=$userChoiceExists"
    )
    Save-Screenshot '01-pre-install'

    # ---------------------------------------- 2. Simulate prior default handler
    Set-HkcuDefaultValue -SubKeyPath $RegPathMd -Value $PriorProgId
    $afterWrite = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMd
    if ($afterWrite.defaultValue -eq $PriorProgId) {
        Add-Result 'pre-registry-prior-progid' 'PASS' "Set HKCU\$RegPathMd default to '$PriorProgId'; left .markdown untouched."
    } else {
        Add-Result 'pre-registry-prior-progid' 'FAIL' "Failed to set HKCU\$RegPathMd default to '$PriorProgId'."
        throw 'Pre-install registry setup failed.'
    }

    # ---------------------------------------- 3. Silent install (/S, non-elevated)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $installerFile.FullName
    $psi.Arguments = '/S'
    $psi.UseShellExecute = $false
    $installProc = [System.Diagnostics.Process]::Start($psi)
    $exited = Wait-Condition { $installProc.HasExited } 180 250
    if (-not $exited) {
        try { Stop-Process -Id $installProc.Id -Force -ErrorAction SilentlyContinue } catch {}
        Add-Result 'silent-install' 'FAIL' 'Installer timed out after 180s.'
        Save-Screenshot '02-after-install'
        throw 'Installer timed out.'
    }
    $installExit = $installProc.ExitCode
    Save-Screenshot '02-after-install'
    if ($installExit -eq 0) {
        Add-Result 'silent-install' 'PASS' 'Silent install (/S) completed with exit code 0 without elevation prompt.'
    } else {
        Add-Result 'silent-install' 'FAIL' "Silent install (/S) exited with code $installExit."
        throw "Installer failed with code $installExit."
    }

    # ---------------------------------------- 4 & 5. Install dir & Add/Remove Programs
    $postUninstSnap = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathUninstall
    $postProgIdSnap = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathProgId
    $postMdSnap = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMd
    $postMdnSnap = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMarkdown
    $postFileExtsMd = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathFileExtsMd
    $postFileExtsMdn = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathFileExtsMdn
    $postManuSnap = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathManuProduct

    $script:RegDump['postInstall'] = [ordered]@{
        uninstall = $postUninstSnap
        progId = $postProgIdSnap
        hkcuMd = $postMdSnap
        hkcuMarkdown = $postMdnSnap
        fileExtsMd = $postFileExtsMd
        fileExtsMarkdown = $postFileExtsMdn
        manuProduct = $postManuSnap
    }

    $installLocRaw = if ($postUninstSnap.exists -and $postUninstSnap.values.Contains('InstallLocation')) {
        [string]$postUninstSnap.values['InstallLocation'].data
    } else {
        ""
    }
    $script:InstalledDir = Normalize-PathString $installLocRaw
    if ([string]::IsNullOrEmpty($script:InstalledDir)) {
        $script:InstalledDir = Normalize-PathString (Join-Path $env:LOCALAPPDATA 'Croquill')
    }
    $script:InstalledExe = Join-Path $script:InstalledDir 'croquill.exe'
    $installedUninst = Join-Path $script:InstalledDir 'uninstall.exe'

    $userProfileNorm = Normalize-PathString $env:USERPROFILE
    $inUserDir = $script:InstalledDir.StartsWith($userProfileNorm + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
                 $script:InstalledDir.Equals($userProfileNorm, [System.StringComparison]::OrdinalIgnoreCase)
    $exeExists = Test-Path -LiteralPath $script:InstalledExe
    $uninstExists = Test-Path -LiteralPath $installedUninst
    if ($inUserDir -and $exeExists -and $uninstExists) {
        Add-Result 'install-dir-files' 'PASS' "Installed in user dir '$($script:InstalledDir)' with croquill.exe and uninstall.exe."
    } else {
        Add-Result 'install-dir-files' 'FAIL' "inUserDir=$inUserDir exeExists=$exeExists uninstExists=$uninstExists dir='$($script:InstalledDir)'"
    }

    $dispName = if ($postUninstSnap.values.Contains('DisplayName')) { [string]$postUninstSnap.values['DisplayName'].data } else { "" }
    $dispVer  = if ($postUninstSnap.values.Contains('DisplayVersion')) { [string]$postUninstSnap.values['DisplayVersion'].data } else { "" }
    if ($postUninstSnap.exists -and $dispName -eq 'Croquill' -and $dispVer -eq $ExpectedVersion) {
        Add-Result 'uninstall-registry-entry' 'PASS' "HKCU\$RegPathUninstall exists: DisplayName='$dispName', DisplayVersion='$dispVer'."
    } else {
        Add-Result 'uninstall-registry-entry' 'FAIL' "exists=$($postUninstSnap.exists) DisplayName='$dispName' DisplayVersion='$dispVer' (expected '$ExpectedVersion')."
    }

    # ---------------------------------------- 6. Start menu shortcut
    $lnkExists = Test-Path -LiteralPath $script:StartMenuShortcut
    $lnkTarget = ""
    if ($lnkExists) {
        $shell = New-Object -ComObject WScript.Shell
        $lnkTarget = Normalize-PathString ($shell.CreateShortcut($script:StartMenuShortcut).TargetPath)
    }
    $expectedExeNorm = Normalize-PathString $script:InstalledExe
    if ($lnkExists -and $lnkTarget.Equals($expectedExeNorm, [System.StringComparison]::OrdinalIgnoreCase)) {
        Add-Result 'start-menu-shortcut' 'PASS' "Start menu shortcut '$($script:StartMenuShortcut)' targets '$lnkTarget'."
    } else {
        Add-Result 'start-menu-shortcut' 'FAIL' "exists=$lnkExists shortcut='$($script:StartMenuShortcut)' target='$lnkTarget' expected='$expectedExeNorm'."
    }

    # ---------------------------------------- 7. ProgID & shell open command
    $cmdSubKeyExists = $postProgIdSnap.exists -and
        $postProgIdSnap.subkeys.Contains('shell') -and
        $postProgIdSnap.subkeys['shell'].subkeys.Contains('open') -and
        $postProgIdSnap.subkeys['shell'].subkeys['open'].subkeys.Contains('command')
    $regOpenCmd = ""
    if ($cmdSubKeyExists) {
        $regOpenCmd = [string]$postProgIdSnap.subkeys['shell'].subkeys['open'].subkeys['command'].defaultValue
    }
    $cmdPointsToExe = $regOpenCmd.IndexOf($expectedExeNorm, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $cmdHasArg = $regOpenCmd.Contains('%1')
    if ($postProgIdSnap.exists -and $cmdSubKeyExists -and $cmdPointsToExe -and $cmdHasArg) {
        Add-Result 'progid-registration' 'PASS' "HKCU\$RegPathProgId command: $regOpenCmd"
    } else {
        Add-Result 'progid-registration' 'FAIL' "exists=$($postProgIdSnap.exists) cmdSubKey=$cmdSubKeyExists cmd='$regOpenCmd'"
    }

    # ---------------------------------------- 8. .md and .markdown associations
    $mdRegistered = ($postMdSnap.defaultValue -eq 'Croquill.Markdown') -or
        ($postMdSnap.subkeys.Contains('OpenWithProgids') -and $postMdSnap.subkeys['OpenWithProgids'].values.Contains('Croquill.Markdown'))
    $mdnRegistered = ($postMdnSnap.defaultValue -eq 'Croquill.Markdown') -or
        ($postMdnSnap.subkeys.Contains('OpenWithProgids') -and $postMdnSnap.subkeys['OpenWithProgids'].values.Contains('Croquill.Markdown'))
    if ($mdRegistered -and $mdnRegistered) {
        Add-Result 'extensions-registered' 'PASS' ".md default='$($postMdSnap.defaultValue)', .markdown default='$($postMdnSnap.defaultValue)'."
    } else {
        Add-Result 'extensions-registered' 'FAIL' "mdRegistered=$mdRegistered mdDefault='$($postMdSnap.defaultValue)' mdnRegistered=$mdnRegistered mdnDefault='$($postMdnSnap.defaultValue)'."
    }

    # ---------------------------------------- 9. Record .md default change (UNJUDGED)
    $afterMdDefault = [string]$postMdSnap.defaultValue
    $changedToCroquill = ($afterMdDefault -eq 'Croquill.Markdown')
    Add-Result 'observe-md-default' 'INFO' (
        "Recorded only (not judged): HKCU\$RegPathMd default changed from '$PriorProgId' to '$afterMdDefault' (changedToCroquill=$changedToCroquill)."
    )

    # ---------------------------------------- 10. Prepare 3 test files
    if (Test-Path -LiteralPath $script:TestWorkDir) {
        Remove-Item -LiteralPath $script:TestWorkDir -Recurse -Force
    }
    $cnSubDir = Join-Path $script:TestWorkDir $CnDirName
    New-Item -ItemType Directory -Force -Path $cnSubDir | Out-Null

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $utf8Bom   = New-Object System.Text.UTF8Encoding($true)

    $file1Path = Join-Path $cnSubDir $CnMdFileName
    $file2Path = Join-Path $script:TestWorkDir "note&100%'test'(1).md"
    $file3Path = Join-Path $script:TestWorkDir "sample-note.markdown"

    $contentCrlf = "# $CnBodyText 1`r`n`r`n$CnBodyText CRLF.`r`n"
    $contentLf   = "# $CnBodyText 2`n`n$CnBodyText LF.`n"
    $contentBom  = "# $CnBodyText 3`n`n$CnBodyText UTF-8 BOM.`n"

    [System.IO.File]::WriteAllText($file1Path, $contentCrlf, $utf8NoBom)
    [System.IO.File]::WriteAllText($file2Path, $contentLf, $utf8NoBom)
    [System.IO.File]::WriteAllText($file3Path, $contentBom, $utf8Bom)

    $testFiles = @(
        [ordered]@{ id = 'cn-space-crlf'; name = $CnMdFileName; path = $file1Path; sha256 = (Get-Sha256 $file1Path); bytes = (Get-Item -LiteralPath $file1Path).Length },
        [ordered]@{ id = 'special-chars-lf'; name = "note&100%'test'(1).md"; path = $file2Path; sha256 = (Get-Sha256 $file2Path); bytes = (Get-Item -LiteralPath $file2Path).Length },
        [ordered]@{ id = 'markdown-ext-bom'; name = 'sample-note.markdown'; path = $file3Path; sha256 = (Get-Sha256 $file3Path); bytes = (Get-Item -LiteralPath $file3Path).Length }
    )
    foreach ($tf in $testFiles) { [void]$script:TestFilesReport.Add($tf) }
    Add-Result 'prepare-test-docs' 'PASS' "Created 3 test files (CRLF, LF, UTF-8 BOM) with SHA256 recorded."

    # ---------------------------------------- 11. Open each via registered command
    if ([string]::IsNullOrEmpty($regOpenCmd)) {
        Add-Result 'open-cmd-cn-space-crlf' 'SKIP' 'Blocked by missing open command.'
        Add-Result 'open-cmd-special-chars-lf' 'SKIP' 'Blocked by missing open command.'
        Add-Result 'open-cmd-markdown-ext-bom' 'SKIP' 'Blocked by missing open command.'
    } else {
        $idx = 0
        foreach ($tf in $testFiles) {
            $idx++
            Close-CroquillProcesses
            $beforePids = @(Get-InstalledCroquillProcesses | ForEach-Object { $_.Id })
            $parsed = Parse-CommandTemplate -RegCommand $regOpenCmd -FilePath $tf.path
            $cmdPsi = New-Object System.Diagnostics.ProcessStartInfo
            $cmdPsi.FileName = $parsed.Exe
            $cmdPsi.Arguments = $parsed.Arguments
            $cmdPsi.UseShellExecute = $false
            [void][System.Diagnostics.Process]::Start($cmdPsi)

            $win = Wait-ForCroquillWindow -ExpectedFileName $tf.name -ExcludedPids $beforePids -TimeoutSec 45
            if ($win.Matched) {
                [void][Win32Acc]::SetForegroundWindow($win.Hwnd)
                Add-Result "open-cmd-$($tf.id)" 'PASS' "Opened '$($tf.name)' via registered command; title='$($win.Title)', exe='$($win.Exe)'."
            } else {
                Add-Result "open-cmd-$($tf.id)" 'FAIL' "Window did not match '$($tf.name)$TitleSuffix'; last=$($win.LastObserved)"
            }
            Save-Screenshot ("0" + ($idx + 2) + "-open-cmd-" + $tf.id)
            Close-CroquillProcesses
        }
    }

    # ---------------------------------------- 12. Open via Windows shell action
    $shouldJudgeShellOpen = ($changedToCroquill -and (-not $userChoiceExists))
    Close-CroquillProcesses
    $beforeAllPids = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $beforeCroquillPids = @(Get-InstalledCroquillProcesses | ForEach-Object { $_.Id })

    $shellLaunchError = ""
    $shellDirectProc = $null
    try {
        $shellDirectProc = Start-Process -FilePath $file1Path -PassThru -ErrorAction Stop
    } catch {
        $shellLaunchError = $_.Exception.Message
    }

    if ($shouldJudgeShellOpen) {
        if (-not [string]::IsNullOrEmpty($shellLaunchError)) {
            Add-Result 'open-via-shell' 'FAIL' "Start-Process threw: $shellLaunchError"
        } else {
            $win = Wait-ForCroquillWindow -ExpectedFileName $CnMdFileName -ExcludedPids $beforeCroquillPids -TimeoutSec 45
            if ($win.Matched) {
                [void][Win32Acc]::SetForegroundWindow($win.Hwnd)
                Add-Result 'open-via-shell' 'PASS' "Start-Process opened '$CnMdFileName' in installed Croquill; title='$($win.Title)', exe='$($win.Exe)'."
            } else {
                Add-Result 'open-via-shell' 'FAIL' "Start-Process did not open matching Croquill window; last=$($win.LastObserved)"
            }
        }
        Save-Screenshot '06-open-shell'
        Close-CroquillProcesses
    } else {
        $reason = if ($userChoiceExists) { "FileExts\.md\UserChoice already existed" } else { "HKCU\.md default was '$afterMdDefault' instead of 'Croquill.Markdown'" }
        $launchedDesc = ""
        if (-not [string]::IsNullOrEmpty($shellLaunchError)) {
            $launchedDesc = "Start-Process error: $shellLaunchError"
        } else {
            $spawned = Wait-Condition {
                $newProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $beforeAllPids -notcontains $_.Id })
                if ($newProcs.Count -gt 0) { return $newProcs }
                return $null
            } 10 250
            if ($null -ne $shellDirectProc) {
                $procExe = Get-ProcessExePath $shellDirectProc.Id
                $launchedDesc = "pid=$($shellDirectProc.Id) name=$($shellDirectProc.ProcessName) exe=$procExe"
                if ($shellDirectProc.ProcessName -ine 'explorer') {
                    try { if (-not $shellDirectProc.HasExited) { Stop-Process -Id $shellDirectProc.Id -Force -ErrorAction SilentlyContinue } } catch {}
                }
            } elseif ($null -ne $spawned) {
                $first = $spawned[0]
                $launchedDesc = "pid=$($first.Id) name=$($first.ProcessName) exe=$(Get-ProcessExePath $first.Id) (observed only, not killed)"
            } else {
                $launchedDesc = "no new process observed within 10s"
            }
        }
        Save-Screenshot '06-open-shell'
        Close-CroquillProcesses
        Add-Result 'open-via-shell' 'INFO' "Unjudged ($reason); observed: $launchedDesc"
    }

    # ---------------------------------------- 13. Open second file while first stays open
    Close-CroquillProcesses
    $exclude1 = @(Get-InstalledCroquillProcesses | ForEach-Object { $_.Id })
    if ($shouldJudgeShellOpen) {
        [void](Start-Process -FilePath $file1Path)
    } else {
        $p1 = Parse-CommandTemplate -RegCommand $regOpenCmd -FilePath $file1Path
        $psi1 = New-Object System.Diagnostics.ProcessStartInfo
        $psi1.FileName = $p1.Exe; $psi1.Arguments = $p1.Arguments; $psi1.UseShellExecute = $false
        [void][System.Diagnostics.Process]::Start($psi1)
    }
    $win1 = Wait-ForCroquillWindow -ExpectedFileName $CnMdFileName -ExcludedPids $exclude1 -TimeoutSec 45
    if (-not $win1.Matched) {
        Add-Result 'open-two-windows' 'FAIL' "First window did not appear; last=$($win1.LastObserved)"
        Save-Screenshot '07-two-windows'
    } else {
        $exclude2 = @($exclude1 + @($win1.Pid))
        if ($shouldJudgeShellOpen) {
            [void](Start-Process -FilePath $file2Path)
        } else {
            $p2 = Parse-CommandTemplate -RegCommand $regOpenCmd -FilePath $file2Path
            $psi2 = New-Object System.Diagnostics.ProcessStartInfo
            $psi2.FileName = $p2.Exe; $psi2.Arguments = $p2.Arguments; $psi2.UseShellExecute = $false
            [void][System.Diagnostics.Process]::Start($psi2)
        }
        $win2 = Wait-ForCroquillWindow -ExpectedFileName "note&100%'test'(1).md" -ExcludedPids $exclude2 -TimeoutSec 45
        $win1Still = @(Get-VisibleWindows | Where-Object { $_.Hwnd -eq $win1.Hwnd -and $_.Title -eq $win1.Title })
        Save-Screenshot '07-two-windows'
        if ($win2.Matched -and $win1Still.Count -eq 1 -and $win2.Hwnd -ne $win1.Hwnd) {
            Add-Result 'open-two-windows' 'PASS' "Both windows open simultaneously: win1='$($win1.Title)' (pid=$($win1.Pid)), win2='$($win2.Title)' (pid=$($win2.Pid))."
        } else {
            Add-Result 'open-two-windows' 'FAIL' "win2Matched=$($win2.Matched) win1StillOpen=$($win1Still.Count -eq 1) last2=$($win2.LastObserved)"
        }
    }
    Close-CroquillProcesses

    # ---------------------------------------- 14. Verify SHA256 after closing all windows
    $hashMismatches = New-Object System.Collections.ArrayList
    foreach ($tf in $testFiles) {
        $afterOpenHash = Get-Sha256 $tf.path
        $tf['sha256AfterOpen'] = $afterOpenHash
        if ($afterOpenHash -ne $tf.sha256) {
            [void]$hashMismatches.Add("$($tf.name): expected $($tf.sha256), got $afterOpenHash")
        }
    }
    if ($hashMismatches.Count -eq 0) {
        Add-Result 'verify-hashes-after-open' 'PASS' 'All 3 test files kept exact SHA256 after opening and closing.'
    } else {
        Add-Result 'verify-hashes-after-open' 'FAIL' ($hashMismatches -join '; ')
    }

    # ---------------------------------------- 15. Silent uninstall (/S)
    $uninstCmd = if ($postUninstSnap.values.Contains('UninstallString')) { [string]$postUninstSnap.values['UninstallString'].data } else { $installedUninst }
    $uninstExit = Invoke-UninstallIfPresent -UninstallCmdString $uninstCmd
    Save-Screenshot '08-after-uninstall'
    if ($null -ne $uninstExit -and $uninstExit -eq 0) {
        Add-Result 'silent-uninstall' 'PASS' 'Silent uninstaller (/S) exited with code 0 and completed cleanup.'
    } else {
        Add-Result 'silent-uninstall' 'FAIL' "Silent uninstaller failed or missing (exit=$uninstExit, cmd='$uninstCmd')."
    }

    # ---------------------------------------- 16. Verify install artifacts removed
    $afterUninstSnap = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathUninstall
    $afterProgIdSnap = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathProgId
    $afterMdSnap     = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMd
    $afterMdnSnap    = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMarkdown
    $afterManuSnap   = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathManuProduct

    $script:RegDump['postUninstall'] = [ordered]@{
        uninstall = $afterUninstSnap
        progId = $afterProgIdSnap
        hkcuMd = $afterMdSnap
        hkcuMarkdown = $afterMdnSnap
        manuProduct = $afterManuSnap
    }

    $dirGone = -not (Test-Path -LiteralPath $script:InstalledDir)
    $uninstKeyGone = -not $afterUninstSnap.exists
    $shortcutGone = -not (Test-Path -LiteralPath $script:StartMenuShortcut)
    $progIdGone = -not $afterProgIdSnap.exists
    $desktopGone = -not (Test-Path -LiteralPath $script:DesktopShortcut)
    if ($dirGone -and $uninstKeyGone -and $shortcutGone -and $progIdGone) {
        Add-Result 'verify-uninstall-cleanup' 'PASS' "Install dir, Uninstall key, Start Menu shortcut, and Croquill.Markdown ProgID are all removed (desktopShortcutGone=$desktopGone)."
    } else {
        Add-Result 'verify-uninstall-cleanup' 'FAIL' "dirGone=$dirGone uninstKeyGone=$uninstKeyGone shortcutGone=$shortcutGone progIdGone=$progIdGone desktopGone=$desktopGone"
    }

    # ---------------------------------------- 17. Verify .md and .markdown restored
    $mdRestored = ($afterMdSnap.exists -and $afterMdSnap.defaultValue -eq $PriorProgId)
    $mdnDefaultStr = if ($null -eq $afterMdnSnap.defaultValue) { "" } else { [string]$afterMdnSnap.defaultValue }
    $mdnPointsToCroquill = $false
    foreach ($vn in $afterMdnSnap.values.Keys) {
        if ([string]$afterMdnSnap.values[$vn].data -eq 'Croquill.Markdown') {
            $mdnPointsToCroquill = $true
        }
    }
    $mdnRestored = (-not $mdnPointsToCroquill) -and ([string]::IsNullOrEmpty($mdnDefaultStr))
    if ($mdRestored -and $mdnRestored) {
        Add-Result 'verify-ext-restored' 'PASS' (
            "HKCU\.md default restored to '$($afterMdSnap.defaultValue)'; " +
            "HKCU\.markdown exists=$($afterMdnSnap.exists) default='$mdnDefaultStr' pointsToCroquill=$mdnPointsToCroquill."
        )
    } else {
        Add-Result 'verify-ext-restored' 'FAIL' (
            "mdRestored=$mdRestored (default='$($afterMdSnap.defaultValue)') " +
            "mdnRestored=$mdnRestored (exists=$($afterMdnSnap.exists) default='$mdnDefaultStr' pointsToCroquill=$mdnPointsToCroquill)"
        )
    }

    # ---------------------------------------- 18. Verify test docs intact after uninstall
    $afterUninstMismatches = New-Object System.Collections.ArrayList
    foreach ($tf in $testFiles) {
        if (-not (Test-Path -LiteralPath $tf.path)) {
            [void]$afterUninstMismatches.Add("missing: $($tf.path)")
            continue
        }
        $h = Get-Sha256 $tf.path
        $tf['sha256AfterUninstall'] = $h
        if ($h -ne $tf.sha256) {
            [void]$afterUninstMismatches.Add("$($tf.name): expected $($tf.sha256), got $h")
        }
    }
    if ($afterUninstMismatches.Count -eq 0) {
        Add-Result 'verify-hashes-after-uninstall' 'PASS' 'All 3 test files remain on disk with unchanged SHA256 after uninstall.'
    } else {
        Add-Result 'verify-hashes-after-uninstall' 'FAIL' ($afterUninstMismatches -join '; ')
    }
}
catch {
    Add-Result 'harness' 'FAIL' "Harness stopped early: $($_.Exception.Message)"
}
finally {
    if ([string]::IsNullOrEmpty($script:InstalledDir)) {
        $fallbackUninst = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathUninstall
        if ($fallbackUninst.exists -and $fallbackUninst.values.Contains('InstallLocation')) {
            $script:InstalledDir = Normalize-PathString ([string]$fallbackUninst.values['InstallLocation'].data)
        } else {
            $script:InstalledDir = Normalize-PathString (Join-Path $env:LOCALAPPDATA 'Croquill')
        }
        $script:InstalledExe = Join-Path $script:InstalledDir 'croquill.exe'
    }
    Close-CroquillProcesses
    if (-not [string]::IsNullOrEmpty($script:InstalledDir) -and (Test-Path -LiteralPath (Join-Path $script:InstalledDir 'uninstall.exe'))) {
        try { [void](Invoke-UninstallIfPresent -UninstallCmdString (Join-Path $script:InstalledDir 'uninstall.exe')) } catch {}
    }
    if ($PreRegistrySaved) {
        Restore-HkcuExtSnapshot -SubKeyPath $RegPathMd -Snapshot $PreMdSnapshot
        Restore-HkcuExtSnapshot -SubKeyPath $RegPathMarkdown -Snapshot $PreMarkdownSnapshot
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($RegPathProgId, $false)

        $finalMd = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMd
        $finalMdn = Get-RegKeySnapshot -Root ([Microsoft.Win32.Registry]::CurrentUser) -SubKeyPath $RegPathMarkdown
        $mdOk = ($finalMd.exists -eq $PreMdSnapshot.exists) -and ($finalMd.defaultValue -eq $PreMdSnapshot.defaultValue)
        $mdnOk = ($finalMdn.exists -eq $PreMarkdownSnapshot.exists) -and ($finalMdn.defaultValue -eq $PreMarkdownSnapshot.defaultValue)
        if ($mdOk -and $mdnOk) {
            Add-Result 'cleanup-registry-restored' 'PASS' 'Cleared test ProgID and restored HKCU\.md and HKCU\.markdown to pre-install state.'
        } else {
            Add-Result 'cleanup-registry-restored' 'FAIL' "Registry restore mismatch: mdOk=$mdOk mdnOk=$mdnOk"
        }
    }
    if (Test-Path -LiteralPath $script:TestWorkDir) {
        Remove-Item -LiteralPath $script:TestWorkDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $resultsArr = @($script:Results)
    $payload = [ordered]@{
        installerPath = $installerFile.FullName
        installerSizeBytes = $installerFile.Length
        expectedVersion = $ExpectedVersion
        installDir = $script:InstalledDir
        checks = $resultsArr
        testFiles = @($script:TestFilesReport)
        registry = $script:RegDump
    }
    $payload | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $OutDir 'results.json') -Encoding UTF8

    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('# Croquill Windows installer acceptance')
    [void]$lines.Add('')
    [void]$lines.Add("- Installer: $($installerFile.FullName)")
    [void]$lines.Add("- Installer Size: $($installerFile.Length) bytes")
    [void]$lines.Add("- Expected Version: $ExpectedVersion")
    [void]$lines.Add("- Install Dir: $($script:InstalledDir)")
    [void]$lines.Add('')
    [void]$lines.Add('## Checks')
    [void]$lines.Add('')
    foreach ($r in $resultsArr) {
        [void]$lines.Add("- [$($r.status)] $($r.id) - $($r.detail)")
    }
    [void]$lines.Add('')
    [void]$lines.Add('## Post-install registry dump')
    [void]$lines.Add('')
    [void]$lines.Add('```json')
    [void]$lines.Add(($script:RegDump['postInstall'] | ConvertTo-Json -Depth 20))
    [void]$lines.Add('```')
    ($lines -join "`r`n") | Set-Content -LiteralPath (Join-Path $OutDir 'report.md') -Encoding UTF8

    $failed = @($resultsArr | Where-Object { $_.status -eq 'FAIL' }).Count
    Write-Host "Installer acceptance finished: $($resultsArr.Count) checks, $failed failed."
    if ($failed -gt 0) { exit 1 }
    exit 0
}
