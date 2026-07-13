@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------------
REM  Step 0: print SOMETHING immediately, then pause. If the user double
REM  clicks and nothing else works, they at least see this banner instead
REM  of a black window flashing for 100ms.
REM ---------------------------------------------------------------------
echo.
echo ============================================================
echo   Claw-Pi installer diagnostic
echo   (if this window closes within 1 second, send me a photo)
echo ============================================================
echo.
echo This window will:
echo   1. ask for administrator rights (UAC popup)
echo   2. collect ~20 seconds of diagnostic info
echo   3. write a report to your Desktop
echo.
echo Press any key to start...
pause >nul

REM =====================================================================
REM  Claw-Pi installer diagnostic
REM
REM  WHAT THIS DOES
REM    1. Asks for administrator rights via UAC.
REM    2. Collects environment, old install info, running Claw-Pi /
REM       openclaw / node processes, port 18789 owners, antivirus state
REM       and recent Defender events.
REM    3. Walks EVERY file in the old install dir and tries to acquire
REM       a DELETE handle with FILE_SHARE_NONE - this is exactly what
REM       NSIS atomicRMDir's Rename needs. Any file that fails this is
REM       exactly the file that will make the installer pop the
REM       "Claw-Pi cannot be closed" dialog. For each failing file we
REM       then ask the Windows Restart Manager API "who is holding it?"
REM       and report PID + process name + path.
REM    3b. Mirrors NSIS's own CHECK_APP_RUNNING PowerShell query
REM       (Get-CimInstance | Path.StartsWith($INSTDIR)) so we see what
REM       NSIS sees - not just Claw-Pi.exe, but also any sidecar /
REM       crashpad / helper EXE under the install dir.
REM    4. Dumps the last 200 lines of %TEMP%\claw-pi-cleanup.log,
REM       which is what installer-cleanup.ps1 wrote during its previous
REM       NSIS preInit / customUnInit invocations.
REM    5. Tests whether the same PowerShell call the installer makes
REM       (powershell -NoProfile -ExecutionPolicy Bypass ...) actually
REM       works on this machine.
REM    6. Kills any Claw-Pi / openclaw / nexu-controller processes that
REM       are running (mirrors installer-cleanup.ps1).
REM    7. Writes a report to the Desktop named
REM         claw-pi-diag-YYYYMMDD-HHMMSS.txt
REM
REM  HOW TO USE
REM    Best moment to run this is WHILE the "Claw-Pi cannot be closed"
REM    dialog is still on screen - don't click Retry/Cancel yet, just
REM    double-click this file in another window. That way section 3.5
REM    captures the live locker.
REM
REM    Otherwise: double-click any time, accept UAC, wait ~10 seconds,
REM    a txt file appears on the Desktop. Send that file back.
REM
REM  This file is self-contained: the embedded PowerShell script lives at
REM  the bottom of this same file, prefixed with "::PS::". The CMD layer
REM  uses findstr to extract those lines into a temp .ps1 and runs it.
REM =====================================================================

REM Resolve Desktop WITHOUT spawning powershell - if SAC / org policy
REM blocks powershell.exe execution we still want trace output.
set "DESKTOP=%USERPROFILE%\Desktop"
if not exist "%DESKTOP%\" set "DESKTOP=%PUBLIC%\Desktop"
if not exist "%DESKTOP%\" set "DESKTOP=%USERPROFILE%"
set "TRACE=%DESKTOP%\claw-pi-diag-trace.txt"
set "TRACE_TEMP=%TEMP%\claw-pi-diag-trace.txt"

echo [%DATE% %TIME%] cmd launched > "%TRACE%" 2>nul
echo [%DATE% %TIME%] cmd launched > "%TRACE_TEMP%" 2>nul
echo [%DATE% %TIME%] script   = %~f0 >> "%TRACE%" 2>nul
echo [%DATE% %TIME%] script   = %~f0 >> "%TRACE_TEMP%" 2>nul
echo [%DATE% %TIME%] user     = %USERNAME% >> "%TRACE%" 2>nul
echo [%DATE% %TIME%] user     = %USERNAME% >> "%TRACE_TEMP%" 2>nul
echo [%DATE% %TIME%] desktop  = %DESKTOP% >> "%TRACE%" 2>nul
echo [%DATE% %TIME%] desktop  = %DESKTOP% >> "%TRACE_TEMP%" 2>nul

echo Trace file: %TRACE%
echo (a backup copy also goes to %TRACE_TEMP%)
echo.

net session >nul 2>&1
set "ADMINCHK=%errorlevel%"
echo [%DATE% %TIME%] net-session exit = %ADMINCHK% (0 = admin) >> "%TRACE%"

if "%ADMINCHK%"=="0" goto :run
goto :elevate

:elevate
echo.
echo ===== Claw-Pi installer diagnostic =====
echo.
echo This tool needs administrator rights to inspect processes,
echo file locks, registry and Defender state.
echo.
echo A UAC prompt is about to appear. Click YES.
echo A second window will open, do its work, and close on its own.
echo This window will wait for it to finish.
echo.
echo If you click NO at the UAC prompt, nothing will happen and you
echo can just close this window.
echo.
pause

echo [%DATE% %TIME%] requesting UAC elevation via Start-Process -Verb RunAs -Wait >> "%TRACE%" 2>nul
echo [%DATE% %TIME%] requesting UAC elevation via Start-Process -Verb RunAs -Wait >> "%TRACE_TEMP%" 2>nul
echo Calling powershell to request UAC elevation. If you don't see a UAC
echo popup within 5 seconds, Smart App Control / org policy is probably
echo blocking powershell.exe. In that case, manually open Command Prompt
echo as administrator and run this script from there.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -Verb RunAs -Wait -FilePath '%~f0'; exit 0 } catch { Write-Host ('UAC ERROR: ' + $_.Exception.Message); exit 1 }"
set "ELEVEXIT=%errorlevel%"
echo [%DATE% %TIME%] elevated process returned, exit = %ELEVEXIT% >> "%TRACE%" 2>nul
echo [%DATE% %TIME%] elevated process returned, exit = %ELEVEXIT% >> "%TRACE_TEMP%" 2>nul

echo.
echo --------- ELEVATION RESULT (powershell exit code = %ELEVEXIT%) ---------
if "%ELEVEXIT%"=="0" (
    echo Elevated diagnostic finished. Check your Desktop for:
    echo   - claw-pi-diag-YYYYMMDD-HHMMSS.txt   ^(main report^)
    echo   - claw-pi-diag-trace.txt              ^(this trace file^)
    echo.
    echo Send BOTH files back to support.
) else (
    echo Elevation FAILED. Most likely causes:
    echo   - You clicked "No" at the UAC prompt
    echo   - Smart App Control blocked powershell.exe
    echo   - PowerShell is missing or in ConstrainedLanguage mode
    echo.
    echo Trace files written:
    echo   - %TRACE%
    echo   - %TRACE_TEMP%
    echo Send WHICHEVER one exists back to support.
    echo.
    echo Manual fallback: open Command Prompt AS ADMINISTRATOR and run
    echo this same .cmd from there. That bypasses the UAC popup entirely.
)
echo.
echo Press any key to close.
pause >nul
exit /b

:run
echo.
echo ===== Claw-Pi installer diagnostic - elevated =====
echo.
echo Gathering info, this takes about 10-20 seconds...
echo.
echo [%DATE% %TIME%] :run started, admin context >> "%TRACE%"

set "PS1=%TEMP%\claw-pi-diag.ps1"
set "RAW=%TEMP%\claw-pi-diag.raw.txt"
if exist "%PS1%" del /q "%PS1%" 2>nul
if exist "%RAW%" del /q "%RAW%" 2>nul

echo [%DATE% %TIME%] extracting embedded PS via findstr >> "%TRACE%"
findstr /B /C:"::PS::" "%~f0" > "%RAW%"

for %%I in ("%RAW%") do (
    echo [%DATE% %TIME%] raw size = %%~zI bytes >> "%TRACE%"
    if %%~zI EQU 0 (
        echo ERROR: failed to extract embedded PowerShell script.
        echo This .cmd file may have been corrupted in transit ^(antivirus,
        echo email gateway, etc.^). Please ask for a fresh copy.
        echo [%DATE% %TIME%] ABORT: raw extraction empty >> "%TRACE%"
        pause
        exit /b 1
    )
)

echo [%DATE% %TIME%] stripping ::PS:: prefix >> "%TRACE%"
powershell -NoProfile -Command "(Get-Content -LiteralPath '%RAW%' -Raw) -replace '(?m)^::PS:: ?','' | Set-Content -LiteralPath '%PS1%' -Encoding UTF8"
set "STRIPEXIT=%errorlevel%"
echo [%DATE% %TIME%] strip exit = %STRIPEXIT% >> "%TRACE%"
del /q "%RAW%" 2>nul

if not exist "%PS1%" (
    echo ERROR: failed to write extracted PowerShell script to %PS1%.
    echo [%DATE% %TIME%] ABORT: PS1 missing after strip >> "%TRACE%"
    pause
    exit /b 1
)

echo [%DATE% %TIME%] running PS1 (timeout = none) >> "%TRACE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "PSEXIT=%errorlevel%"
echo [%DATE% %TIME%] PS1 exit = %PSEXIT% >> "%TRACE%"
del /q "%PS1%" 2>nul

echo.
echo Diagnostic exit code: %PSEXIT%
if "%PSEXIT%"=="0" (
    echo Report on Desktop: claw-pi-diag-YYYYMMDD-HHMMSS.txt
) else (
    echo Diagnostic FAILED. Trace file is at:
    echo   %TRACE%
)
echo.
echo Press any key to close.
pause >nul
exit /b

REM =====================================================================
REM  Embedded PowerShell script. Each line below is prefixed with
REM  "::PS::". CMD treats these as comment labels, but findstr extracts
REM  them at runtime into a real .ps1 file. CMD never executes any of
REM  this section because of the exit /b above.
REM =====================================================================
::PS::
::PS::$ErrorActionPreference = 'SilentlyContinue'
::PS::$ProgressPreference    = 'SilentlyContinue'
::PS::
::PS::# Force UTF-8 console so 360, OS strings etc. don't show as mojibake.
::PS::try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
::PS::
::PS::$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
::PS::$desktop   = [Environment]::GetFolderPath('Desktop')
::PS::$report    = Join-Path $desktop ('claw-pi-diag-' + $timestamp + '.txt')
::PS::
::PS::# Startup marker so we can prove PS1 reached this line, even if a
::PS::# later section (Add-Type, P/Invoke, etc.) blows up. Appended to the
::PS::# trace file the .cmd wrapper opened on the Desktop.
::PS::$traceFile = Join-Path $desktop 'claw-pi-diag-trace.txt'
::PS::function Write-StartupTrace { param($msg)
::PS::    try { Add-Content -LiteralPath $traceFile -Value ('[PS1 ' + (Get-Date -Format 'HH:mm:ss.fff') + '] ' + $msg) } catch {}
::PS::}
::PS::Write-StartupTrace ('PS1 reached body, PID=' + $PID + ', PS=' + $PSVersionTable.PSVersion)
::PS::Write-StartupTrace ('Report path will be: ' + $report)
::PS::
::PS::# Wrap the entire diagnostic in try/catch so a single broken section
::PS::# can't make the whole script vanish silently. The catch block writes
::PS::# both to the trace file AND to a partial report on the Desktop.
::PS::trap {
::PS::    Write-StartupTrace ('FATAL: ' + $_.Exception.GetType().FullName + ' - ' + $_.Exception.Message)
::PS::    Write-StartupTrace ('STACK: ' + $_.ScriptStackTrace)
::PS::    try {
::PS::        $partial = Join-Path $desktop ('claw-pi-diag-CRASH-' + $timestamp + '.txt')
::PS::        $crash = "PS1 crashed before completing.`r`n"
::PS::        $crash += "Time : " + (Get-Date) + "`r`n"
::PS::        $crash += "Type : " + $_.Exception.GetType().FullName + "`r`n"
::PS::        $crash += "Msg  : " + $_.Exception.Message + "`r`n"
::PS::        $crash += "Stack:`r`n" + $_.ScriptStackTrace + "`r`n`r`n"
::PS::        if ($buf) { $crash += "===== Partial buffer =====`r`n" + $buf.ToString() }
::PS::        $crash | Out-File -FilePath $partial -Encoding UTF8
::PS::    } catch {}
::PS::    exit 99
::PS::}
::PS::
::PS::$buf = New-Object System.Text.StringBuilder
::PS::# Helper names deliberately avoid 1-letter identifiers because PowerShell
::PS::# resolves aliases (e.g. `H` -> Get-History) BEFORE user-defined functions.
::PS::function Wln { param($line='') Write-Host $line; [void]$buf.AppendLine($line) }
::PS::function Section { param($title)
::PS::    $bar = '=' * [math]::Max(4, 60 - $title.Length)
::PS::    Wln ''
::PS::    Wln ('==== ' + $title + ' ' + $bar)
::PS::}
::PS::function Tbl { param($obj)
::PS::    if ($null -eq $obj) { Wln '  (none)'; return }
::PS::    $lines = ($obj | Format-Table -AutoSize | Out-String -Width 200) -split "(?:\r?\n)"
::PS::    foreach ($l in $lines) { if ($l) { Wln ('  ' + $l) } }
::PS::}
::PS::function Test-FileWritable {
::PS::    param([string]$Path)
::PS::    if (-not (Test-Path -LiteralPath $Path)) { return $true }
::PS::    try {
::PS::        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
::PS::        $fs.Close(); $fs.Dispose()
::PS::        return $true
::PS::    } catch { return $false }
::PS::}
::PS::
::PS::Wln '#####################################################'
::PS::Wln '#  Claw-Pi installer diagnostic report'
::PS::Wln ('#  Generated : ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))
::PS::Wln ('#  Report    : ' + $report)
::PS::Wln '#####################################################'
::PS::
::PS::Section '1) ENVIRONMENT'
::PS::Wln ('Hostname    : ' + $env:COMPUTERNAME)
::PS::Wln ('User        : ' + $env:USERNAME)
::PS::$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
::PS::Wln ('IsAdmin     : ' + $isAdmin)
::PS::$os = Get-CimInstance Win32_OperatingSystem
::PS::if ($os) {
::PS::    Wln ('OS          : ' + $os.Caption + ' build ' + $os.BuildNumber + '  arch ' + $os.OSArchitecture)
::PS::}
::PS::Wln ('PowerShell  : ' + $PSVersionTable.PSVersion + ' (' + $PSVersionTable.PSEdition + ')')
::PS::Wln ('CLR         : ' + $PSVersionTable.CLRVersion)
::PS::Wln ''
::PS::Wln 'ExecutionPolicy:'
::PS::Tbl (Get-ExecutionPolicy -List)
::PS::
::PS::Section '2) OLD CLAW-PI INSTALL'
::PS::$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Claw-Pi'
::PS::Wln ('InstallDir         : ' + $installDir)
::PS::Wln ('InstallDir exists  : ' + (Test-Path $installDir))
::PS::if (Test-Path $installDir) {
::PS::    $exe = Join-Path $installDir 'Claw-Pi.exe'
::PS::    $unx = Join-Path $installDir 'Uninstall Claw-Pi.exe'
::PS::    if (Test-Path $exe) {
::PS::        $vi = (Get-Item $exe).VersionInfo
::PS::        Wln ('Claw-Pi.exe Ver    : ' + $vi.FileVersion + '  (Product: ' + $vi.ProductVersion + ')')
::PS::    } else { Wln 'Claw-Pi.exe        : MISSING' }
::PS::    if (Test-Path $unx) {
::PS::        $vi2 = (Get-Item $unx).VersionInfo
::PS::        Wln ('Uninstaller Ver    : ' + $vi2.FileVersion)
::PS::    } else { Wln 'Uninstall Claw-Pi.exe : MISSING' }
::PS::    $sz = (Get-ChildItem $installDir -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
::PS::    if ($sz) { Wln ('Install dir size   : ' + [math]::Round($sz / 1MB, 2) + ' MB') }
::PS::}
::PS::
::PS::Wln ''
::PS::Wln 'Registry uninstall entries (HKCU + HKLM + WOW6432Node):'
::PS::$paths = @(
::PS::    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
::PS::    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
::PS::    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
::PS::)
::PS::$entries = @()
::PS::$discoveredDirs = New-Object System.Collections.Generic.HashSet[string]
::PS::if (Test-Path -LiteralPath $installDir) { [void]$discoveredDirs.Add($installDir.TrimEnd('\','/')) }
::PS::foreach ($p in $paths) {
::PS::    Get-ItemProperty $p -EA SilentlyContinue | Where-Object { $_.DisplayName -match 'Claw' } | ForEach-Object {
::PS::        $entries += [pscustomobject]@{
::PS::            Hive            = ($_.PSPath -replace '.*::','')
::PS::            DisplayName     = $_.DisplayName
::PS::            DisplayVersion  = $_.DisplayVersion
::PS::            InstallLocation = $_.InstallLocation
::PS::            UninstallString = $_.UninstallString
::PS::        }
::PS::        if ($_.InstallLocation) {
::PS::            $loc = $_.InstallLocation.TrimEnd('\','/')
::PS::            if ($loc) { [void]$discoveredDirs.Add($loc) }
::PS::        }
::PS::        # Fall back to UninstallString = "<path>\Uninstall Foo.exe" /currentuser
::PS::        # because electron-builder writes empty InstallLocation for per-user installs.
::PS::        if (-not $_.InstallLocation -and $_.UninstallString) {
::PS::            $us = $_.UninstallString
::PS::            $m = [regex]::Match($us, '^"?([^"]+)"?\s')
::PS::            if (-not $m.Success) { $m = [regex]::Match($us, '^([^ ]+)') }
::PS::            if ($m.Success) {
::PS::                try {
::PS::                    $exe = $m.Groups[1].Value.Trim('"').Trim()
::PS::                    if ($exe) {
::PS::                        $parent = Split-Path -Parent $exe
::PS::                        if ($parent) { [void]$discoveredDirs.Add($parent.TrimEnd('\','/')) }
::PS::                    }
::PS::                } catch {}
::PS::            }
::PS::        }
::PS::    }
::PS::}
::PS::if ($entries.Count -eq 0) {
::PS::    Wln '  (no Claw-* entries found)'
::PS::} else {
::PS::    foreach ($e in $entries) {
::PS::        Wln ('  - ' + $e.Hive)
::PS::        Wln ('      DisplayName     : ' + $e.DisplayName)
::PS::        Wln ('      DisplayVersion  : ' + $e.DisplayVersion)
::PS::        Wln ('      InstallLocation : ' + $e.InstallLocation)
::PS::        Wln ('      UninstallString : ' + $e.UninstallString)
::PS::    }
::PS::}
::PS::
::PS::Wln ''
::PS::$localUserData = Join-Path $env:LOCALAPPDATA 'claw-pi-desktop'
::PS::$roamingUserData = Join-Path $env:APPDATA 'claw-pi-desktop'
::PS::foreach ($dataRoot in @(
::PS::    @{Label='userData (%LOCALAPPDATA%\claw-pi-desktop)'; Path=$localUserData},
::PS::    @{Label='legacy userData (%APPDATA%\claw-pi-desktop)'; Path=$roamingUserData}
::PS::)) {
::PS::    Wln ($dataRoot.Label + ' exists : ' + (Test-Path $dataRoot.Path))
::PS::    if (Test-Path $dataRoot.Path) {
::PS::        $sz2 = (Get-ChildItem $dataRoot.Path -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
::PS::        if ($sz2) { Wln ('  Size: ' + [math]::Round($sz2 / 1MB, 2) + ' MB') }
::PS::        $runtime = Join-Path $dataRoot.Path 'runtime'
::PS::        if (Test-Path $runtime) {
::PS::            $children = Get-ChildItem $runtime -Directory -EA SilentlyContinue | Select-Object -First 20 -ExpandProperty Name
::PS::            if ($children) { Wln ('  runtime/ subdirs: ' + ($children -join ', ')) }
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::Section '3) PROCESS SNAPSHOT (BEFORE CLEANUP)'
::PS::Wln 'Processes matching Claw|electron|node|openclaw|nexu:'
::PS::$procs = Get-Process | Where-Object {
::PS::    $_.ProcessName -match '^(Claw|electron|node|openclaw|nexu)' -or
::PS::    ($_.Path -and ($_.Path -like '*Claw-Pi*' -or $_.Path -like '*claw-pi-desktop*'))
::PS::}
::PS::if ($procs) {
::PS::    Tbl ($procs | Select-Object Id, ProcessName, @{n='Path';e={$_.Path}})
::PS::} else { Wln '  (none)' }
::PS::
::PS::Wln ''
::PS::Wln 'node.exe command lines (matching claw-pi/openclaw/nexu-controller):'
::PS::$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue | Where-Object {
::PS::    $_.CommandLine -and ($_.CommandLine -match 'claw-pi|openclaw|nexu-controller')
::PS::}
::PS::if ($nodes) {
::PS::    foreach ($n in $nodes) {
::PS::        Wln ('  PID ' + $n.ProcessId)
::PS::        Wln ('    ' + $n.CommandLine)
::PS::    }
::PS::} else { Wln '  (none)' }
::PS::
::PS::Wln ''
::PS::Wln 'TCP port 18789 owners:'
::PS::$conns = Get-NetTCPConnection -LocalPort 18789 -EA SilentlyContinue
::PS::if ($conns) {
::PS::    Tbl ($conns | Select-Object LocalAddress, LocalPort, State, OwningProcess)
::PS::    foreach ($c in $conns) {
::PS::        $proc = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
::PS::        if ($proc) {
::PS::            Wln ('  PID ' + $c.OwningProcess + ' = ' + $proc.ProcessName + '  ' + $proc.Path)
::PS::        }
::PS::    }
::PS::} else { Wln '  (port free)' }
::PS::
::PS::Wln ''
::PS::Wln 'Processes with modules loaded from install dir:'
::PS::if (Test-Path $installDir) {
::PS::    $hits = @()
::PS::    foreach ($p in Get-Process) {
::PS::        try {
::PS::            $modules = $p.Modules | Where-Object { $_.FileName -like ($installDir + '*') }
::PS::            if ($modules) {
::PS::                $hits += [pscustomobject]@{
::PS::                    Id = $p.Id
::PS::                    Name = $p.ProcessName
::PS::                    Path = $p.Path
::PS::                    ModuleCount = $modules.Count
::PS::                }
::PS::            }
::PS::        } catch {}
::PS::    }
::PS::    if ($hits) { Tbl $hits } else { Wln '  (none)' }
::PS::} else { Wln '  (install dir does not exist)' }
::PS::
::PS::Wln ''
::PS::Wln 'Active NSIS installer / uninstaller transient processes:'
::PS::$nsisProcs = Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object {
::PS::    $_.Name -match '^(claw-pi-setup|Au_|Uninstall Claw-Pi|nsi).*\.exe$' -or
::PS::    ($_.CommandLine -and ($_.CommandLine -match 'claw-pi-setup' -or $_.CommandLine -match 'old-uninstaller'))
::PS::}
::PS::if ($nsisProcs) {
::PS::    foreach ($n in $nsisProcs) {
::PS::        Wln ('  PID ' + $n.ProcessId + '  ' + $n.Name)
::PS::        if ($n.CommandLine) { Wln ('    cmd: ' + $n.CommandLine) }
::PS::    }
::PS::} else { Wln '  (none running)' }
::PS::
::PS::Section '3.5) FULL INSTALL DIR LOCK SCAN'
::PS::Wln 'Mimics NSIS atomicRMDir: tries to acquire DELETE access with FILE_SHARE_NONE'
::PS::Wln 'on EVERY file under the old install dir. Anything that fails is exactly'
::PS::Wln 'what makes NSIS pop "Claw-Pi cannot be closed". This goes well beyond the'
::PS::Wln 'previous "3 key files" check which gave false negatives last run.'
::PS::Wln ''
::PS::if (-not ('RestartManagerHelper' -as [type])) {
::PS::    try {
::PS::        Add-Type -TypeDefinition @'
::PS::using System;
::PS::using System.Runtime.InteropServices;
::PS::public static class RestartManagerHelper {
::PS::    [StructLayout(LayoutKind.Sequential)]
::PS::    public struct RM_UNIQUE_PROCESS {
::PS::        public int dwProcessId;
::PS::        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
::PS::    }
::PS::    public const int CCH_RM_MAX_APP_NAME = 255;
::PS::    public const int CCH_RM_MAX_SVC_NAME = 63;
::PS::    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
::PS::    public struct RM_PROCESS_INFO {
::PS::        public RM_UNIQUE_PROCESS Process;
::PS::        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
::PS::        public string strAppName;
::PS::        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
::PS::        public string strServiceShortName;
::PS::        public int ApplicationType;
::PS::        public uint AppStatus;
::PS::        public uint TSSessionId;
::PS::        [MarshalAs(UnmanagedType.Bool)]
::PS::        public bool bRestartable;
::PS::    }
::PS::    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
::PS::    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
::PS::    [DllImport("rstrtmgr.dll")]
::PS::    public static extern int RmEndSession(uint pSessionHandle);
::PS::    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
::PS::    public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
::PS::    [DllImport("rstrtmgr.dll")]
::PS::    public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
::PS::
::PS::    // CreateFile(...) with DELETE access + FILE_SHARE_NONE is the exact
::PS::    // permission combo NSIS atomicRMDir's Rename needs. If we cannot
::PS::    // open the file with these flags, NSIS will fail too.
::PS::    public const uint DELETE_ACCESS = 0x00010000u;
::PS::    public const uint OPEN_EXISTING = 3u;
::PS::    public const uint FILE_ATTRIBUTE_NORMAL = 0x80u;
::PS::    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000u;
::PS::    public static IntPtr InvalidHandle { get { return new IntPtr(-1); } }
::PS::    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
::PS::    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
::PS::    [DllImport("kernel32.dll", SetLastError = true)]
::PS::    [return: MarshalAs(UnmanagedType.Bool)]
::PS::    public static extern bool CloseHandle(IntPtr hObject);
::PS::}
::PS::'@
::PS::    } catch {
::PS::        Wln ('  Add-Type for RestartManagerHelper failed: ' + $_.Exception.Message)
::PS::    }
::PS::}
::PS::function Test-FileRenameable {
::PS::    # Returns @{ Ok=$true } if the file can be acquired with the exact
::PS::    # permissions NSIS Rename needs, @{ Ok=$false; Err=<int>; ErrName=<string> }
::PS::    # otherwise. Falls back to FileShare.None probe if the P/Invoke is
::PS::    # unavailable for some reason.
::PS::    param([string]$Path)
::PS::    if (-not (Test-Path -LiteralPath $Path)) { return @{ Ok = $true; Err = 0; ErrName = 'NOT_EXIST' } }
::PS::    if (-not ('RestartManagerHelper' -as [type])) {
::PS::        try {
::PS::            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
::PS::            $fs.Close(); $fs.Dispose()
::PS::            return @{ Ok = $true; Err = 0; ErrName = 'FALLBACK_OK' }
::PS::        } catch { return @{ Ok = $false; Err = -1; ErrName = 'FALLBACK_FAIL' } }
::PS::    }
::PS::    $h = [RestartManagerHelper]::CreateFileW(
::PS::        $Path,
::PS::        [RestartManagerHelper]::DELETE_ACCESS,
::PS::        0,
::PS::        [IntPtr]::Zero,
::PS::        [RestartManagerHelper]::OPEN_EXISTING,
::PS::        [RestartManagerHelper]::FILE_ATTRIBUTE_NORMAL,
::PS::        [IntPtr]::Zero
::PS::    )
::PS::    if ($h -eq [RestartManagerHelper]::InvalidHandle) {
::PS::        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
::PS::        $name = switch ($err) {
::PS::            2  { 'NOT_FOUND' }
::PS::            5  { 'ACCESS_DENIED' }
::PS::            32 { 'SHARING_VIOLATION' }
::PS::            33 { 'LOCK_VIOLATION' }
::PS::            default { 'WIN32_' + $err }
::PS::        }
::PS::        return @{ Ok = $false; Err = $err; ErrName = $name }
::PS::    }
::PS::    [void][RestartManagerHelper]::CloseHandle($h)
::PS::    return @{ Ok = $true; Err = 0; ErrName = '' }
::PS::}
::PS::function Get-FileLocker {
::PS::    param([string[]]$Paths)
::PS::    $existing = @($Paths | Where-Object { Test-Path -LiteralPath $_ })
::PS::    if ($existing.Count -eq 0) { return @() }
::PS::    if (-not ('RestartManagerHelper' -as [type])) { return @() }
::PS::    $sessionKey = [Guid]::NewGuid().ToString('N')
::PS::    $session = [uint32]0
::PS::    $rc = [RestartManagerHelper]::RmStartSession([ref]$session, 0, $sessionKey)
::PS::    if ($rc -ne 0) { Wln ('  RmStartSession failed: rc=' + $rc); return @() }
::PS::    try {
::PS::        $rc = [RestartManagerHelper]::RmRegisterResources($session, [uint32]$existing.Count, [string[]]$existing, 0, $null, 0, $null)
::PS::        if ($rc -ne 0) { Wln ('  RmRegisterResources failed: rc=' + $rc); return @() }
::PS::        [uint32]$needed = 0
::PS::        [uint32]$count = 0
::PS::        [uint32]$reasons = 0
::PS::        $rc = [RestartManagerHelper]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reasons)
::PS::        if ($needed -eq 0) { return @() }
::PS::        $count = $needed
::PS::        $procs = New-Object 'RestartManagerHelper+RM_PROCESS_INFO[]' ([int]$count)
::PS::        $rc = [RestartManagerHelper]::RmGetList($session, [ref]$needed, [ref]$count, $procs, [ref]$reasons)
::PS::        if ($rc -ne 0) { Wln ('  RmGetList(2) failed: rc=' + $rc); return @() }
::PS::        $results = @()
::PS::        for ($i = 0; $i -lt $count; $i++) {
::PS::            $info = $procs[$i]
::PS::            $proc = Get-Process -Id $info.Process.dwProcessId -EA SilentlyContinue
::PS::            $procName = '?'
::PS::            $procPath = '?'
::PS::            if ($proc) {
::PS::                $procName = $proc.ProcessName
::PS::                if ($proc.Path) { $procPath = $proc.Path }
::PS::            }
::PS::            $results += [pscustomobject]@{
::PS::                LockerPID = $info.Process.dwProcessId
::PS::                AppName   = $info.strAppName
::PS::                AppType   = $info.ApplicationType
::PS::                ProcName  = $procName
::PS::                ProcPath  = $procPath
::PS::            }
::PS::        }
::PS::        return $results
::PS::    } finally {
::PS::        [void][RestartManagerHelper]::RmEndSession($session)
::PS::    }
::PS::}
::PS::
::PS::$allInstallFiles = @()
::PS::foreach ($d in $discoveredDirs) {
::PS::    if (Test-Path -LiteralPath $d) {
::PS::        try {
::PS::            $allInstallFiles += @(Get-ChildItem -LiteralPath $d -Recurse -File -Force -EA SilentlyContinue)
::PS::        } catch {}
::PS::    }
::PS::}
::PS::Wln ('Install dir(s) scanned       : ' + ($discoveredDirs -join ' | '))
::PS::Wln ('Total files found            : ' + $allInstallFiles.Count)
::PS::if ($allInstallFiles.Count -eq 0) {
::PS::    Wln '  (no install dir found - nothing to scan)'
::PS::} else {
::PS::    $lockedFiles = New-Object System.Collections.Generic.List[object]
::PS::    $scanStart = Get-Date
::PS::    foreach ($file in $allInstallFiles) {
::PS::        $r = Test-FileRenameable -Path $file.FullName
::PS::        if (-not $r.Ok -and $r.ErrName -ne 'NOT_EXIST' -and $r.ErrName -ne 'NOT_FOUND') {
::PS::            [void]$lockedFiles.Add([pscustomobject]@{
::PS::                Path = $file.FullName
::PS::                Size = $file.Length
::PS::                Err  = $r.Err
::PS::                ErrName = $r.ErrName
::PS::            })
::PS::        }
::PS::    }
::PS::    $scanDur = ((Get-Date) - $scanStart).TotalMilliseconds
::PS::    Wln ('Scan duration                : ' + [int]$scanDur + ' ms')
::PS::    Wln ('Files NSIS Rename would fail : ' + $lockedFiles.Count)
::PS::    Wln ''
::PS::    if ($lockedFiles.Count -eq 0) {
::PS::        Wln '  *** OK: every file in the install dir can be renamed right now.'
::PS::        Wln '          NSIS atomicRMDir would succeed.'
::PS::        Wln '          (If NSIS still pops "cannot be closed", the cause is in section 3.6)'
::PS::    } else {
::PS::        Wln '  *** PROBLEM: NSIS Rename would fail on these files:'
::PS::        $lockedFiles | Sort-Object ErrName, Path | ForEach-Object {
::PS::            Wln ('    [' + $_.ErrName.PadRight(20) + ']  ' + $_.Path)
::PS::        }
::PS::        Wln ''
::PS::        Wln 'Querying Restart Manager for the actual locker(s)...'
::PS::        $allLockers = Get-FileLocker -Paths @($lockedFiles | ForEach-Object { $_.Path })
::PS::        if (@($allLockers).Count -eq 0) {
::PS::            Wln '  Restart Manager reported no specific locker.'
::PS::            Wln '  Likely a kernel mini-filter (Windows Defender real-time scan,'
::PS::            Wln '  Search Indexer, an EDR/AV agent) is holding the file open in a way'
::PS::            Wln '  Restart Manager cannot enumerate. Workarounds:'
::PS::            Wln '    - temporarily disable real-time protection and retry'
::PS::            Wln '    - exclude the install dir in Defender/AV settings'
::PS::            Wln '    - reboot and retry (clears all caches)'
::PS::        } else {
::PS::            Wln '  These processes hold one or more of the locked files:'
::PS::            $allLockers | Group-Object LockerPID | ForEach-Object {
::PS::                $first = $_.Group[0]
::PS::                Wln ('    PID ' + $first.LockerPID + '  ' + $first.ProcName + '   (RM-app="' + $first.AppName + '", type=' + $first.AppType + ', files=' + $_.Count + ')')
::PS::                if ($first.ProcPath -and $first.ProcPath -ne '?') {
::PS::                    Wln ('      Path: ' + $first.ProcPath)
::PS::                }
::PS::            }
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::Section '3.6) NSIS-EYE PROCESS CHECK'
::PS::Wln 'Mirrors NSIS CHECK_APP_RUNNING. NSIS uses this exact PowerShell pipe:'
::PS::Wln '  Get-CimInstance Win32_Process | ? { $_.Path.StartsWith($INSTDIR) }'
::PS::Wln 'If it returns ANY hit, NSIS thinks Claw-Pi is still running and pops the'
::PS::Wln 'same "cannot be closed" dialog (after 1-2 retry attempts).'
::PS::Wln 'Note: this catches sidecar/crashpad/helper EXEs that section 3 missed.'
::PS::Wln ''
::PS::if ($discoveredDirs.Count -eq 0) {
::PS::    Wln '  (no install dir found - skipping)'
::PS::} else {
::PS::    foreach ($d in $discoveredDirs) {
::PS::        Wln ('Checking $INSTDIR = ' + $d)
::PS::        $hits = Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object {
::PS::            $_.Path -and $_.Path.StartsWith($d, [System.StringComparison]::CurrentCultureIgnoreCase)
::PS::        }
::PS::        if ($hits) {
::PS::            $hitsArr = @($hits)
::PS::            Wln ('  *** NSIS would see ' + $hitsArr.Count + ' process(es) below $INSTDIR:')
::PS::            foreach ($h in $hitsArr) {
::PS::                Wln ('    PID ' + $h.ProcessId + '  ' + $h.Name)
::PS::                Wln ('      Path: ' + $h.Path)
::PS::                if ($h.CommandLine) {
::PS::                    $cmd = $h.CommandLine
::PS::                    if ($cmd.Length -gt 200) { $cmd = $cmd.Substring(0, 200) + '...' }
::PS::                    Wln ('      cmd : ' + $cmd)
::PS::                }
::PS::            }
::PS::            Wln ''
::PS::            Wln '  -> These are what is making NSIS preInit / CHECK_APP_RUNNING fail.'
::PS::        } else {
::PS::            Wln '  (no process Path starts with $INSTDIR - NSIS would skip this branch)'
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::Section '4) ANTIVIRUS / EDR'
::PS::Wln 'SecurityCenter2 AntiVirusProduct:'
::PS::$avs = Get-CimInstance -Namespace root\SecurityCenter2 -ClassName AntiVirusProduct -EA SilentlyContinue
::PS::if ($avs) {
::PS::    Tbl ($avs | Select-Object displayName, productState, pathToSignedReportingExe)
::PS::} else { Wln '  (none reported)' }
::PS::
::PS::Wln ''
::PS::Wln 'Windows Defender status:'
::PS::$ds = Get-MpComputerStatus -EA SilentlyContinue
::PS::if ($ds) {
::PS::    Wln ('  AMRunningMode             : ' + $ds.AMRunningMode)
::PS::    Wln ('  AntivirusEnabled          : ' + $ds.AntivirusEnabled)
::PS::    Wln ('  RealTimeProtectionEnabled : ' + $ds.RealTimeProtectionEnabled)
::PS::    Wln ('  BehaviorMonitorEnabled    : ' + $ds.BehaviorMonitorEnabled)
::PS::    Wln ('  IoavProtectionEnabled     : ' + $ds.IoavProtectionEnabled)
::PS::    Wln ('  OnAccessProtectionEnabled : ' + $ds.OnAccessProtectionEnabled)
::PS::} else {
::PS::    Wln '  Get-MpComputerStatus not available (Defender disabled or replaced by 3rd-party AV)'
::PS::}
::PS::
::PS::Wln ''
::PS::Wln 'Defender events in the last 30 minutes:'
::PS::$cutoff = (Get-Date).AddMinutes(-30)
::PS::$evts = Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -EA SilentlyContinue | Where-Object { $_.TimeCreated -gt $cutoff }
::PS::if ($evts) {
::PS::    foreach ($e in $evts) {
::PS::        $first = ($e.Message -split "`r?`n")[0]
::PS::        Wln ('  ' + $e.TimeCreated.ToString('HH:mm:ss') + '  id=' + $e.Id + '  ' + $e.LevelDisplayName + '  ' + $first)
::PS::    }
::PS::} else { Wln '  (no events in the last 30 minutes)' }
::PS::
::PS::Section '5) POWERSHELL CHANNEL TEST'
::PS::Wln 'Mirror nsExec call: powershell -NoProfile -ExecutionPolicy Bypass -Command Write-Output OK'
::PS::$out = & powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Output 'OK'" 2>&1
::PS::Wln ('  Output  : ' + ($out -join ' | '))
::PS::Wln ('  ExitCode: ' + $LASTEXITCODE)
::PS::if ($LASTEXITCODE -ne 0 -or "$out" -notmatch 'OK') {
::PS::    Wln '  *** PowerShell channel is BROKEN. ***'
::PS::    Wln '      The installer''s preInit cleanup will fail here too.'
::PS::    Wln '      Likely cause: AV/EDR blocks powershell.exe -ExecutionPolicy Bypass,'
::PS::    Wln '      or AppLocker / WDAC policy.'
::PS::}
::PS::
::PS::Section '5.5) INSTALLER CLEANUP LOG (last 200 lines)'
::PS::$cleanupLog = Join-Path $env:TEMP 'claw-pi-cleanup.log'
::PS::Wln ('Path: ' + $cleanupLog)
::PS::if (Test-Path -LiteralPath $cleanupLog) {
::PS::    $sz3 = (Get-Item -LiteralPath $cleanupLog).Length
::PS::    Wln ('Size: ' + $sz3 + ' bytes')
::PS::    Wln '----- last 200 lines -----'
::PS::    try {
::PS::        Get-Content -LiteralPath $cleanupLog -Tail 200 -EA Stop | ForEach-Object { Wln $_ }
::PS::    } catch {
::PS::        Wln ('  (failed to read: ' + $_.Exception.Message + ')')
::PS::    }
::PS::    Wln '----- end of cleanup log -----'
::PS::} else {
::PS::    Wln '(file does not exist)'
::PS::    Wln ''
::PS::    Wln 'Means one of:'
::PS::    Wln '  a) The currently installed Claw-Pi was built BEFORE the polling fix'
::PS::    Wln '     (its uninstaller never writes this log).'
::PS::    Wln '  b) The new installer never reached its preInit hook on this'
::PS::    Wln '     machine - NSIS or AV blocked PowerShell (see section 5).'
::PS::}
::PS::
::PS::Section '6) AUTO CLEANUP (kill Claw-Pi / openclaw / port 18789 owners)'
::PS::$killed = @()
::PS::Get-Process -Name 'Claw-Pi' -EA SilentlyContinue | ForEach-Object {
::PS::    $killed += ('Claw-Pi PID ' + $_.Id)
::PS::    Stop-Process -Id $_.Id -Force -EA SilentlyContinue
::PS::}
::PS::Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue | Where-Object {
::PS::    $_.CommandLine -and ($_.CommandLine -match 'claw-pi|openclaw|nexu-controller')
::PS::} | ForEach-Object {
::PS::    $killed += ('node PID ' + $_.ProcessId)
::PS::    Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue
::PS::}
::PS::Get-NetTCPConnection -LocalPort 18789 -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
::PS::    $killed += ('port-18789 owner PID ' + $_)
::PS::    Stop-Process -Id $_ -Force -EA SilentlyContinue
::PS::}
::PS::Start-Sleep -Milliseconds 1500
::PS::if ($killed.Count -gt 0) {
::PS::    Wln 'Killed:'
::PS::    foreach ($k in $killed) { Wln ('  - ' + $k) }
::PS::} else {
::PS::    Wln '(nothing was running, no targets to kill)'
::PS::}
::PS::
::PS::Section '7) POST-CLEANUP SNAPSHOT'
::PS::$still = Get-Process | Where-Object {
::PS::    $_.ProcessName -match '^(Claw|openclaw|nexu)' -or
::PS::    ($_.Path -and ($_.Path -like '*Claw-Pi*' -or $_.Path -like '*claw-pi-desktop*'))
::PS::}
::PS::if ($still) {
::PS::    Wln 'Processes that survived the cleanup:'
::PS::    Tbl ($still | Select-Object Id, ProcessName, Path)
::PS::    Wln ''
::PS::    Wln '  *** WARNING: something is restarting them.'
::PS::    Wln '      Check Task Scheduler / Startup folder / Run-key entries.'
::PS::} else {
::PS::    Wln 'No Claw-Pi-related processes remain.'
::PS::}
::PS::Wln ''
::PS::$conns2 = Get-NetTCPConnection -LocalPort 18789 -EA SilentlyContinue
::PS::if ($conns2) {
::PS::    Wln 'Port 18789 still occupied:'
::PS::    Tbl ($conns2 | Select-Object LocalPort, State, OwningProcess)
::PS::} else {
::PS::    Wln 'Port 18789 is free.'
::PS::}
::PS::
::PS::Wln ''
::PS::Wln 'Re-scanning install dir for files NSIS Rename would still fail on:'
::PS::$postLocked = New-Object System.Collections.Generic.List[object]
::PS::foreach ($d in $discoveredDirs) {
::PS::    if (-not (Test-Path -LiteralPath $d)) { continue }
::PS::    Get-ChildItem -LiteralPath $d -Recurse -File -Force -EA SilentlyContinue | ForEach-Object {
::PS::        $r = Test-FileRenameable -Path $_.FullName
::PS::        if (-not $r.Ok -and $r.ErrName -ne 'NOT_EXIST' -and $r.ErrName -ne 'NOT_FOUND') {
::PS::            [void]$postLocked.Add([pscustomobject]@{ Path = $_.FullName; ErrName = $r.ErrName })
::PS::        }
::PS::    }
::PS::}
::PS::if ($postLocked.Count -eq 0) {
::PS::    Wln '  *** OK: every file is renameable. NSIS atomicRMDir would now succeed.'
::PS::} else {
::PS::    Wln ('  *** ' + $postLocked.Count + ' file(s) still cannot be renamed:')
::PS::    $postLocked | ForEach-Object { Wln ('    [' + $_.ErrName.PadRight(20) + ']  ' + $_.Path) }
::PS::    $stillLockers = Get-FileLocker -Paths @($postLocked | ForEach-Object { $_.Path })
::PS::    if (@($stillLockers).Count -gt 0) {
::PS::        Wln '  Still held by:'
::PS::        $stillLockers | Group-Object LockerPID | ForEach-Object {
::PS::            $f = $_.Group[0]
::PS::            Wln ('    PID ' + $f.LockerPID + '  ' + $f.ProcName + '  ' + $f.ProcPath)
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::# Also keep the previous "did Rename succeed on the 3 key files" check for
::PS::# easy comparison with prior reports.
::PS::Wln ''
::PS::Wln 'Quick check on the 3 key files (compat with previous reports):'
::PS::$probeFiles2 = New-Object System.Collections.Generic.List[string]
::PS::foreach ($d in $discoveredDirs) {
::PS::    [void]$probeFiles2.Add((Join-Path $d 'Claw-Pi.exe'))
::PS::    [void]$probeFiles2.Add((Join-Path $d 'Uninstall Claw-Pi.exe'))
::PS::}
::PS::foreach ($f in $probeFiles2) {
::PS::    if (-not (Test-Path -LiteralPath $f)) { continue }
::PS::    $r2 = Test-FileRenameable -Path $f
::PS::    if ($r2.Ok) {
::PS::        Wln ('  ' + $f + ' : free')
::PS::    } else {
::PS::        $l2 = Get-FileLocker -Paths @($f)
::PS::        if ($l2.Count -eq 0) {
::PS::            Wln ('  ' + $f + ' : STILL LOCKED (no locker reported - kernel filter)')
::PS::        } else {
::PS::            Wln ('  ' + $f + ' : STILL LOCKED BY')
::PS::            foreach ($x in $l2) {
::PS::                Wln ('      PID ' + $x.LockerPID + '  ' + $x.ProcName)
::PS::            }
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::Section 'DONE'
::PS::Wln ('Report saved to: ' + $report)
::PS::Wln ''
::PS::Wln 'Where to look in this report:'
::PS::Wln '  - Section 3.5 = the smoking gun. If it shows "PROBLEM:" + a file list,'
::PS::Wln '    that file list is exactly what makes NSIS bail.'
::PS::Wln '  - Section 3.6 = NSIS-eye process check. If it shows "*** NSIS would'
::PS::Wln '    see N process(es)", that is what triggers CHECK_APP_RUNNING failure.'
::PS::Wln '  - Section 5.5 = log of what installer-cleanup.ps1 did during the actual'
::PS::Wln '    NSIS preInit invocations (only present if the installed build is new'
::PS::Wln '    enough to write it).'
::PS::Wln '  - Section 7  = state AFTER auto-cleanup, tells us whether killing the'
::PS::Wln '    obvious Claw-Pi processes was enough.'
::PS::Wln ''
::PS::Wln 'Next steps:'
::PS::Wln '  1. Send the report file (claw-pi-diag-*.txt on the Desktop) back to support.'
::PS::Wln '  2. If section 7 shows "every file is renameable", retry the installer.'
::PS::Wln '  3. If section 7 still lists locked files, restart the computer and retry.'
::PS::Wln '  4. If even after a reboot you still get "cannot be closed", temporarily'
::PS::Wln '     disable Windows Defender real-time protection (or 360 / Tencent PC'
::PS::Wln '     Manager / Huorong / etc.) and try once more - that will tell us if'
::PS::Wln '     an AV mini-filter is the cause.'
::PS::
::PS::try {
::PS::    $buf.ToString() | Out-File -FilePath $report -Encoding UTF8
::PS::    Write-StartupTrace ('Wrote report ' + $report + ' (' + (Get-Item $report).Length + ' bytes)')
::PS::    Write-Host ''
::PS::    Write-Host ('REPORT FILE: ' + $report) -ForegroundColor Green
::PS::    Write-Host 'Please send this file back to support.' -ForegroundColor Green
::PS::} catch {
::PS::    Write-StartupTrace ('Failed to write report: ' + $_.Exception.Message)
::PS::    Write-Host ''
::PS::    Write-Host ('Failed to write report: ' + $_.Exception.Message) -ForegroundColor Red
::PS::    exit 1
::PS::}
::PS::Write-StartupTrace 'PS1 finished cleanly, exit 0'
::PS::exit 0
