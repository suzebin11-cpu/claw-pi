# Claw-Pi installer cleanup script
#
# Invoked by installer.nsh during NSIS preInit / customUnInit. Runs in
# three phases:
#
#   Phase A (kill): terminate any lingering Claw-Pi / openclaw / sidecar
#     processes so NSIS doesn't immediately bounce off the "file in use"
#     prompt because of OUR processes.
#
#   Phase B (wait): poll the install dir's files for renameable access
#     (matching NSIS's own CreateFile(DELETE, share=0) pattern). When
#     anything is locked, ask Restart Manager who owns it and (when
#     safe) kill that process.
#
#   Phase C (atomic-rename): only when -BypassUninstall is set. Find
#     each installed Claw-Pi entry in the uninstall registry, atomically
#     rename its install dir aside (single MoveFile call - race-safe
#     against any other concurrent cleanup), then delete the registry
#     entry so NSIS's later uninstallOldVersion macro Returns immediately.
#
# Safe to run when nothing is running (every step swallows its own
# errors). Absolutely must not bubble non-zero back to NSIS - NSIS treats
# that as a hard failure.
#
# Optional parameter -InstallDir is the NSIS $INSTDIR forwarded by
# installer.nsh. When omitted we fall back to registry-discovered paths
# plus the default per-user location, so the script also works when run
# manually for diagnostics.
#
# Every invocation appends a timestamped block to
# %TEMP%\claw-pi-cleanup.log so post-mortem diagnostics can see what we
# actually did. Without this the NSIS layer eats all our output.
#
# Concurrency: a global mutex 'Global\ClawPiInstallerCleanup-v1' gates
# Phase A/B/C. The NSIS preInit ALREADY does its own mutex check before
# spawning us, so this is defense-in-depth - if some weird path bypasses
# the NSIS mutex (different Windows session, manual diagnostic invocation,
# etc.) we still don't race. Holding the mutex never deadlocks because
# WaitOne(0) returns immediately if it's held.

param(
    [string]$InstallDir = '',

    # When set (only by installer.nsh preInit), takes over what NSIS's
    # built-in uninstallOldVersion macro would have done: rename the OLD
    # install directory aside (atomic, race-safe) and clear its registry
    # uninstall entry. NSIS's built-in path is unsafe here because its
    # atomicRMDir has zero retry semantics - any single Rename failure
    # aborts the whole silent uninstall, and after 5 retries NSIS pops
    # the dreaded "Claw-Pi cannot be closed" dialog. Field-confirmed
    # root cause via claw-pi-cleanup.log on suzeb's box (2026-04-19).
    [switch]$BypassUninstall
)

$ErrorActionPreference = 'SilentlyContinue'

$script:LogPath = Join-Path $env:TEMP 'claw-pi-cleanup.log'
$script:Started = Get-Date

function Write-CleanupLog {
    param([string]$Line)
    $ts = (Get-Date).ToString('HH:mm:ss.fff')
    try { Add-Content -LiteralPath $script:LogPath -Value ('[' + $ts + '] ' + $Line) -Encoding UTF8 } catch {}
}

function Exit-CleanupQuietly {
    param([string]$Reason)
    try {
        $duration = ((Get-Date) - $script:Started).TotalMilliseconds
        Write-CleanupLog ('==== END   exit=0  duration=' + [int]$duration + 'ms  reason=' + $Reason + ' ====')
        Write-CleanupLog ''
    } catch {}
    exit 0
}

try {
    $caller = $MyInvocation.PSCommandPath
    if (-not $caller) { $caller = '<inline>' }
    $shownDir = $InstallDir
    if (-not $shownDir) { $shownDir = '<not provided>' }
    Write-CleanupLog ('==== START ' + $script:Started.ToString('yyyy-MM-dd HH:mm:ss') + ' ====')
    Write-CleanupLog ('PID         : ' + $PID)
    Write-CleanupLog ('Script      : ' + $caller)
    Write-CleanupLog ('InstallDir  : ' + $shownDir)
    Write-CleanupLog ('User        : ' + $env:USERNAME)
    Write-CleanupLog ('PowerShell  : ' + $PSVersionTable.PSVersion)
    Write-CleanupLog ('BypassUninst: ' + [bool]$BypassUninstall)
} catch {}

# ---------------------------------------------------------------------------
# Defense-in-depth single-instance gate.
#
# The NSIS preInit (installer.nsh) already gates on a Win32 mutex named
# '${APP_GUID}-preinit-cleanup' BEFORE spawning us, but that only covers
# launches that go through our preInit. If somebody runs this script
# manually (diagnostics) or from a different session where the NSIS
# mutex doesn't apply, we still need to avoid concurrent Phase C runs.
#
# We use Global\ namespace so the mutex is visible across all sessions
# on the same machine. Per-user is sufficient for our single-user
# install but Global\ is safe because the mutex name embeds the product
# and is short-lived.
#
# If we can't acquire, exit success immediately - the OTHER cleanup is
# doing the work, and our caller (NSIS) will then proceed and either
# (a) hit its own ALLOW_ONLY_ONE_INSTALLER_INSTANCE mutex and abort or
# (b) be the duplicate launch we want to short-circuit.
# ---------------------------------------------------------------------------

$script:CleanupMutex = $null
$script:CleanupMutexHeld = $false
try {
    $createdNew = $false
    $script:CleanupMutex = New-Object System.Threading.Mutex($true, 'Global\ClawPiInstallerCleanup-v1', [ref]$createdNew)
    if ($createdNew) {
        $script:CleanupMutexHeld = $true
    } else {
        # Mutex existed; try to acquire with no wait.
        try {
            if ($script:CleanupMutex.WaitOne(0)) {
                $script:CleanupMutexHeld = $true
            }
        } catch [System.Threading.AbandonedMutexException] {
            # Previous owner died without releasing. We're now the owner.
            $script:CleanupMutexHeld = $true
        }
    }
} catch {
    Write-CleanupLog ('Mutex acquire failed (proceeding without gate): ' + $_.Exception.Message)
    $script:CleanupMutexHeld = $true
}

if (-not $script:CleanupMutexHeld) {
    Write-CleanupLog 'Another cleanup already holds Global\ClawPiInstallerCleanup-v1 - skipping Phase A/B/C this run.'
    Exit-CleanupQuietly -Reason 'mutex-contention'
}

# ---------------------------------------------------------------------------
# Phase A: kill our own lingering processes
# ---------------------------------------------------------------------------

$killedPids = New-Object System.Collections.Generic.HashSet[int]

try {
    Get-Process -Name 'Claw-Pi' -ErrorAction SilentlyContinue | ForEach-Object {
        [void]$killedPids.Add($_.Id)
        Write-CleanupLog ('Phase A kill Claw-Pi PID=' + $_.Id)
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
} catch {}

# Old uninstaller leftovers. Field repro: user double-clicks setup, NSIS
# triggers uninstallOldVersion which spawns "Uninstall Claw-Pi.exe /S",
# the silent uninstaller hangs (its own customUnInit on 0.2.x lacks the
# polling we shipped in 0.2.4), user clicks Cancel on appCannotBeClosed,
# but the orphan "Uninstall Claw-Pi.exe" stays alive holding a handle on
# its own image inside %TEMP%\<plugins>\old-uninstaller.exe and on parts
# of $INSTDIR. Next setup run sees those handles and trips again. We
# reap that orphan unconditionally - we own the binary name.
try {
    Get-Process -Name 'Uninstall Claw-Pi' -ErrorAction SilentlyContinue | ForEach-Object {
        [void]$killedPids.Add($_.Id)
        Write-CleanupLog ('Phase A kill orphan uninstaller PID=' + $_.Id)
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
} catch {}
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $n = $_.Name
            if (-not $n) { return $false }
            # case-insensitive contains; covers "Uninstall Claw-Pi.exe",
            # "old-uninstaller.exe" (the temp copy NSIS makes in PLUGINSDIR),
            # and any future variant.
            ($n -ieq 'Uninstall Claw-Pi.exe') -or
            ($n -ieq 'old-uninstaller.exe')
        } | ForEach-Object {
            $upid = [int]$_.ProcessId
            if ($killedPids.Add($upid)) {
                Write-CleanupLog ('Phase A kill uninstaller-by-name ' + $_.Name + ' PID=' + $upid)
                Stop-Process -Id $upid -Force -ErrorAction SilentlyContinue
            }
        }
} catch {}

try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = $_.CommandLine
            if (-not $cmd) { return $false }
            $cmd -match 'claw-pi' -or
            $cmd -match 'openclaw' -or
            $cmd -match 'nexu-controller' -or
            $cmd -match 'claw-pi-desktop'
        } | ForEach-Object {
            [void]$killedPids.Add([int]$_.ProcessId)
            Write-CleanupLog ('Phase A kill node PID=' + $_.ProcessId)
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
} catch {}

try {
    Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            [void]$killedPids.Add([int]$_)
            Write-CleanupLog ('Phase A kill port-18789 owner PID=' + $_)
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
} catch {}

# Wait for each terminated PID to actually leave the process table.
# TerminateProcess returns immediately, but the kernel may keep the
# EPROCESS slot around for a moment while pending I/O drains. NSIS
# checks via Toolhelp snapshot which sees those slots, so we explicitly
# wait them out.
foreach ($p in $killedPids) {
    try {
        Wait-Process -Id $p -Timeout 5 -ErrorAction SilentlyContinue
        Write-CleanupLog ('Phase A wait-process PID=' + $p + ' returned')
    } catch {}
}

if ($killedPids.Count -eq 0) {
    Write-CleanupLog 'Phase A: no targets to kill'
}

# ---------------------------------------------------------------------------
# Phase B: scan WHOLE install dir, identify lockers, kill if safe
#
# This goes well beyond the previous "2 key EXEs" check. Diagnostics from
# the field showed Claw-Pi.exe / Uninstall Claw-Pi.exe / app.asar were
# never the actual culprit - some other file deeper in the install tree
# (DLL, .pak, .node, etc.) is what trips NSIS atomicRMDir. We mimic the
# exact CreateFile(DELETE, share=0) call that NSIS Rename uses, scan
# every file, and if anything fails we ask Restart Manager who is holding
# it and (when safe) kill that process.
# ---------------------------------------------------------------------------

function Get-ClawPiInstallDirs {
    param([string]$Hint)

    $set = New-Object System.Collections.Generic.HashSet[string]

    if ($Hint) {
        $trimmed = $Hint.TrimEnd('\','/')
        if ($trimmed) { [void]$set.Add($trimmed) }
    }

    $regPaths = @(
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($path in $regPaths) {
        try {
            Get-ItemProperty $path -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match 'Claw-Pi' } | ForEach-Object {
                    if ($_.InstallLocation) {
                        $loc = $_.InstallLocation.TrimEnd('\','/')
                        if ($loc) { [void]$set.Add($loc) }
                    }
                    # electron-builder per-user installs leave InstallLocation
                    # empty but write UninstallString = "<dir>\Uninstall Foo.exe"
                    # /currentuser. Parse it out.
                    if (-not $_.InstallLocation -and $_.UninstallString) {
                        $us = $_.UninstallString
                        $m = [regex]::Match($us, '^"?([^"]+)"?\s')
                        if (-not $m.Success) { $m = [regex]::Match($us, '^([^ ]+)') }
                        if ($m.Success) {
                            try {
                                $exe = $m.Groups[1].Value.Trim('"').Trim()
                                if ($exe) {
                                    $parent = Split-Path -Parent $exe
                                    if ($parent) { [void]$set.Add($parent.TrimEnd('\','/')) }
                                }
                            } catch {}
                        }
                    }
                }
        } catch {}
    }

    $default = Join-Path $env:LOCALAPPDATA 'Programs\Claw-Pi'
    if (Test-Path -LiteralPath $default) { [void]$set.Add($default) }

    return @($set)
}

if (-not ('ClawPiNative' -as [type])) {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClawPiNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }
    public const int CCH_RM_MAX_APP_NAME = 255;
    public const int CCH_RM_MAX_SVC_NAME = 63;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
    [DllImport("rstrtmgr.dll")]
    public static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
    [DllImport("rstrtmgr.dll")]
    public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public const uint DELETE_ACCESS = 0x00010000u;
    public const uint OPEN_EXISTING = 3u;
    public const uint FILE_ATTRIBUTE_NORMAL = 0x80u;
    public static IntPtr InvalidHandle { get { return new IntPtr(-1); } }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@
    } catch {
        Write-CleanupLog ('Add-Type ClawPiNative failed: ' + $_.Exception.Message)
    }
}

function Test-FileRenameable {
    # Returns $true if the file can be acquired with the exact permissions
    # NSIS Rename needs (DELETE access, FILE_SHARE_NONE). Falls back to a
    # FileShare.None probe when the P/Invoke isn't available.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    if (-not ('ClawPiNative' -as [type])) {
        try {
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            $fs.Close(); $fs.Dispose()
            return $true
        } catch { return $false }
    }
    $h = [ClawPiNative]::CreateFileW(
        $Path,
        [ClawPiNative]::DELETE_ACCESS,
        0,
        [IntPtr]::Zero,
        [ClawPiNative]::OPEN_EXISTING,
        [ClawPiNative]::FILE_ATTRIBUTE_NORMAL,
        [IntPtr]::Zero
    )
    if ($h -eq [ClawPiNative]::InvalidHandle) { return $false }
    [void][ClawPiNative]::CloseHandle($h)
    return $true
}

function Get-FileLockers {
    param([string[]]$Paths)
    if (-not $Paths -or $Paths.Length -eq 0) { return @() }
    if (-not ('ClawPiNative' -as [type])) { return @() }
    $existing = @($Paths | Where-Object { Test-Path -LiteralPath $_ })
    if ($existing.Length -eq 0) { return @() }
    $sessionKey = [Guid]::NewGuid().ToString('N')
    $session = [uint32]0
    $rc = [ClawPiNative]::RmStartSession([ref]$session, 0, $sessionKey)
    if ($rc -ne 0) { return @() }
    try {
        # RmRegisterResources caps at ~64 files per call. Chunk to be safe.
        $chunkSize = 60
        for ($offset = 0; $offset -lt $existing.Length; $offset += $chunkSize) {
            $end = [Math]::Min($offset + $chunkSize, $existing.Length)
            $chunk = [string[]]($existing[$offset..($end - 1)])
            $rc = [ClawPiNative]::RmRegisterResources($session, [uint32]$chunk.Length, $chunk, 0, $null, 0, $null)
            if ($rc -ne 0) { return @() }
        }
        [uint32]$needed = 0
        [uint32]$count = 0
        [uint32]$reasons = 0
        $rc = [ClawPiNative]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reasons)
        if ($needed -eq 0) { return @() }
        $count = $needed
        $procs = New-Object 'ClawPiNative+RM_PROCESS_INFO[]' ([int]$count)
        $rc = [ClawPiNative]::RmGetList($session, [ref]$needed, [ref]$count, $procs, [ref]$reasons)
        if ($rc -ne 0) { return @() }
        $results = @()
        for ($i = 0; $i -lt $count; $i++) {
            $info = $procs[$i]
            $results += [pscustomobject]@{
                LockerPID = $info.Process.dwProcessId
                AppName   = $info.strAppName
                AppType   = $info.ApplicationType
            }
        }
        return $results
    } finally {
        [void][ClawPiNative]::RmEndSession($session)
    }
}

function Test-SafeToKill {
    # Whitelist of process names we are happy to nuke, plus any process
    # whose image lives under one of the install dirs we're trying to
    # clean. Refuses System (PID <=4), explorer.exe, csrss, etc.
    param([int]$LockerPid, [string[]]$InstallDirs)
    if ($LockerPid -le 4) { return $false }
    if ($LockerPid -eq $PID) { return $false }
    $proc = Get-Process -Id $LockerPid -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    $name = ''
    try { $name = $proc.ProcessName.ToLowerInvariant() } catch {}
    $whitelist = @('claw-pi', 'electron', 'openclaw', 'nexu-controller',
                   'chrome_crashpad_handler', 'crashpad_handler')
    foreach ($w in $whitelist) {
        if ($name.StartsWith($w)) { return $true }
    }
    # node.exe is only safe to kill when its image lives under our install
    # dir (we don't want to nuke the user's other Node projects).
    try {
        if ($proc.Path) {
            foreach ($d in $InstallDirs) {
                if ($proc.Path.StartsWith($d, [System.StringComparison]::CurrentCultureIgnoreCase)) {
                    return $true
                }
            }
        }
    } catch {}
    return $false
}

function Find-LockedInstallFiles {
    param([string[]]$Dirs)
    $locked = New-Object System.Collections.Generic.List[string]
    foreach ($d in $Dirs) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        try {
            Get-ChildItem -LiteralPath $d -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
                if (-not (Test-FileRenameable -Path $_.FullName)) {
                    [void]$locked.Add($_.FullName)
                }
            }
        } catch {}
    }
    return @($locked)
}

try {
    $dirs = Get-ClawPiInstallDirs -Hint $InstallDir
    Write-CleanupLog ('Phase B dirs  : ' + ($dirs -join ' | '))
    if (-not $dirs -or $dirs.Length -eq 0) {
        Write-CleanupLog 'Phase B skip  : no install dir found (fresh install?)'
    } else {
        $phaseStart = Get-Date
        $deadline = $phaseStart.AddSeconds(8)
        $iteration = 0
        $finalLocked = @()
        $totalFiles = 0
        foreach ($d in $dirs) {
            if (Test-Path -LiteralPath $d) {
                try {
                    $totalFiles += @(Get-ChildItem -LiteralPath $d -Recurse -File -Force -ErrorAction SilentlyContinue).Count
                } catch {}
            }
        }
        Write-CleanupLog ('Phase B files : ' + $totalFiles + ' file(s) under install dir(s)')
        while ((Get-Date) -lt $deadline) {
            $iteration++
            $iterStart = Get-Date
            $locked = Find-LockedInstallFiles -Dirs $dirs
            $iterMs = [int]((Get-Date) - $iterStart).TotalMilliseconds
            if ($locked.Length -eq 0) {
                $totalMs = [int]((Get-Date) - $phaseStart).TotalMilliseconds
                Write-CleanupLog ('Phase B OK    iter=' + $iteration + ' all ' + $totalFiles + ' file(s) renameable (scan=' + $iterMs + 'ms, total=' + $totalMs + 'ms)')
                $finalLocked = @()
                break
            }
            Write-CleanupLog ('Phase B iter=' + $iteration + ' locked=' + $locked.Length + ' (scan=' + $iterMs + 'ms, first=' + $locked[0] + ')')
            if ($iteration -eq 1) {
                $lockers = Get-FileLockers -Paths $locked
                if (@($lockers).Count -eq 0) {
                    Write-CleanupLog '  Phase B Restart Manager reported no locker (kernel mini-filter?)'
                } else {
                    foreach ($l in $lockers) {
                        if (Test-SafeToKill -LockerPid $l.LockerPID -InstallDirs $dirs) {
                            Write-CleanupLog ('  Phase B kill PID=' + $l.LockerPID + ' app="' + $l.AppName + '"')
                            try {
                                Stop-Process -Id $l.LockerPID -Force -ErrorAction SilentlyContinue
                                Wait-Process -Id $l.LockerPID -Timeout 3 -ErrorAction SilentlyContinue
                            } catch {}
                        } else {
                            Write-CleanupLog ('  Phase B SKIP PID=' + $l.LockerPID + ' app="' + $l.AppName + '" (not on whitelist / not in install dir)')
                        }
                    }
                }
            }
            Start-Sleep -Milliseconds 500
            $finalLocked = $locked
        }
        if ($finalLocked.Length -gt 0) {
            $totalMs = [int]((Get-Date) - $phaseStart).TotalMilliseconds
            Write-CleanupLog ('Phase B TIMEOUT after ' + $totalMs + 'ms, ' + $finalLocked.Length + ' file(s) still locked. NSIS WILL FAIL.')
            $finalLocked | Select-Object -First 20 | ForEach-Object {
                Write-CleanupLog ('  Phase B locked: ' + $_)
            }
        }
    }
} catch {
    Write-CleanupLog ('Phase B error : ' + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# Phase C: bypass NSIS uninstallOldVersion (only when -BypassUninstall set)
#
# History of failures that shaped this design:
#
#   2026-04-19 21:44 (0.2.3 -> 0.2.4 install on suzeb's box):
#     Our preInit cleanup found 57 files locked by a kernel mini-filter
#     (Restart Manager reported "no locker" - signature pattern of
#     Defender realtime scan / OneDrive sync / EDR drivers). iter=2
#     saw all files freed and we reported OK. 3 seconds later NSIS
#     launched the OLD silent uninstaller, which ran atomicRMDir -
#     mini-filter had re-grabbed, atomicRMDir has zero retry, NSIS
#     retried 5 times then popped "Claw-Pi cannot be closed".
#     -> Fixed in 0.2.5 by adding Phase C bypass that deleted the
#        old install dir + reg key with a 30-second retry loop.
#
#   2026-04-19 22:23-22:25 (0.2.3 -> 0.2.5 install on suzeb's box):
#     Phase C bypass DID fire, but user double-clicked setup.exe
#     three times. Three concurrent cleanup.ps1 instances all entered
#     Phase C. Each tried Remove-Item -Recurse on the same install dir.
#     PowerShell's Remove-Item enumerates files THEN deletes them; with
#     three processes interleaving, each saw "Could not find a part of
#     the path" errors as the others deleted files between its
#     enumeration and its delete. All three timed out, none cleared
#     the reg key, NSIS fell back to old silent uninstaller, dialog
#     popped.
#     -> Fixed in 0.2.6 by:
#        (a) preInit-level mutex in installer.nsh (prevents the second
#            and third setup.exe from spawning concurrent cleanups), and
#        (b) Phase C atomic-rename instead of Remove-Item -Recurse:
#            single MoveFile call has no enumerate/delete window, and
#            even if mutex somehow fails the rename either succeeds
#            atomically or fails atomically, never produces a
#            half-deleted dir like Remove-Item does.
#
# Why atomic rename works here:
#   - MoveFile within the same volume just updates the parent directory's
#     MFT entry, no per-file I/O. Files inside being locked by Defender
#     does not block it.
#   - Whatever NSIS does next sees an empty $INSTDIR ready to receive
#     the new install. The renamed staging dir gets cleaned up
#     opportunistically (best effort - if delete fails it's just disk
#     waste, not a correctness problem).
#   - Concurrent cleanups racing: only one wins the rename. The losers
#     see "source not found" and treat it as success (because the dir
#     IS effectively gone from their POV).
#
# CRITICAL ARCHITECTURAL CONSTRAINT: every future Claw-Pi version
# MUST keep Phase C in its installer-cleanup.ps1 AND keep
# preInit invoking with -BypassUninstall AND keep the preInit-level
# mutex in installer.nsh. Removing any of the three would re-expose
# users to one of the failure modes documented above whenever they
# upgrade FROM that future version. See .cursor/rules/windows-packaging.mdc.
# ---------------------------------------------------------------------------

function Get-ClawPiUninstallEntries {
    # Returns @(@{ RegPath; InstallDir; DisplayName; DisplayVersion; UninstallString }, ...)
    $entries = New-Object System.Collections.Generic.List[psobject]
    $regPaths = @(
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($p in $regPaths) {
        try {
            Get-ItemProperty $p -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match 'Claw-Pi' } | ForEach-Object {
                    $dir = $null
                    if ($_.InstallLocation) {
                        $dir = $_.InstallLocation.TrimEnd('\','/')
                    } elseif ($_.UninstallString) {
                        # electron-builder per-user installs leave InstallLocation
                        # empty but UninstallString = "<dir>\Uninstall <Foo>.exe" /currentuser
                        $m = [regex]::Match($_.UninstallString, '^"?([^"]+)"?\s')
                        if (-not $m.Success) { $m = [regex]::Match($_.UninstallString, '^([^ ]+)') }
                        if ($m.Success) {
                            try {
                                $exe = $m.Groups[1].Value.Trim('"').Trim()
                                if ($exe) {
                                    $parent = Split-Path -Parent $exe
                                    if ($parent) { $dir = $parent.TrimEnd('\','/') }
                                }
                            } catch {}
                        }
                    }
                    $entries.Add([pscustomobject]@{
                        RegPath         = $_.PSPath
                        InstallDir      = $dir
                        DisplayName     = $_.DisplayName
                        DisplayVersion  = $_.DisplayVersion
                        UninstallString = $_.UninstallString
                    })
                }
        } catch {}
    }
    return @($entries)
}

function Test-SafeToRemoveDir {
    # Refuse to RmDir anything that looks like a system path even if some
    # registry entry says so. Defense in depth - we never want a buggy
    # registry entry to wipe C:\ or C:\Program Files.
    param([string]$Dir)
    if (-not $Dir) { return $false }
    if (-not (Test-Path -LiteralPath $Dir)) { return $false }
    $normalized = $Dir.TrimEnd('\','/').ToLowerInvariant()
    if ($normalized -match '^[a-z]:$') { return $false }
    if ($normalized -match '^[a-z]:\\?$') { return $false }
    if ($normalized -match '^[a-z]:\\(windows|program files|program files \(x86\)|users|programdata)$') { return $false }
    # Belt-and-suspenders: confirm a Claw-Pi-ish marker file is present.
    # If neither the main exe nor the uninstaller is here, we have no
    # business deleting this directory.
    $marker1 = Join-Path $Dir 'Claw-Pi.exe'
    $marker2 = Join-Path $Dir 'Uninstall Claw-Pi.exe'
    if (-not (Test-Path -LiteralPath $marker1) -and -not (Test-Path -LiteralPath $marker2)) {
        return $false
    }
    return $true
}

function Remove-StaleStagingDirs {
    # Best-effort cleanup of leftover staging dirs from previous runs
    # (e.g. last install crashed before deleting them). They sit
    # alongside the real install dir as ".claw-pi-removing-<hex>".
    # Failure to delete is non-fatal and we just leave them for next time.
    param([string]$ParentDir)
    if (-not $ParentDir -or -not (Test-Path -LiteralPath $ParentDir)) { return }
    try {
        Get-ChildItem -LiteralPath $ParentDir -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '.claw-pi-removing-*' } | ForEach-Object {
                try {
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                    Write-CleanupLog ('  Phase C cleaned stale staging dir: ' + $_.FullName)
                } catch {
                    Write-CleanupLog ('  Phase C kept stale staging dir (will retry next install): ' + $_.FullName)
                }
            }
    } catch {}
}

function Move-OldClawPiInstallDirAside {
    # Atomically rename $Dir to a sibling staging dir. This is the key
    # primitive: a single MoveFile within the same volume is atomic from
    # NSIS's point of view, so once it succeeds NSIS sees an empty
    # $INSTDIR ready for the new install. Files INSIDE the dir being
    # locked does NOT block the rename - Windows only checks share modes
    # on files we touch, and rename only touches the parent dir's MFT
    # entry.
    #
    # The only realistic failure modes are:
    #   - The directory itself has an open handle (someone's CWD is set
    #     to it, or a FileSystemWatcher is enumerating it). Rare.
    #   - The directory has been deleted/renamed by another concurrent
    #     cleanup between our Test-Path and our Move. We treat that as
    #     success.
    #
    # Returns $true on success (dir is effectively gone), $false on
    # timeout. We retry every 500ms up to $DeadlineSeconds because the
    # first failure case (open handle) often clears within a second or
    # two when the offending process moves on.
    param(
        [string]$Dir,
        [int]$DeadlineSeconds = 10
    )
    if (-not (Test-Path -LiteralPath $Dir)) { return $true }

    $parent = Split-Path -Parent $Dir
    if (-not $parent) {
        Write-CleanupLog ('  Phase C cannot resolve parent of ' + $Dir)
        return $false
    }

    $deadline = (Get-Date).AddSeconds($DeadlineSeconds)
    $iter = 0
    $lastError = ''
    while ((Get-Date) -lt $deadline) {
        $iter++
        $rngSuffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $stagingDir = Join-Path $parent ('.claw-pi-removing-' + $rngSuffix)
        try {
            [System.IO.Directory]::Move($Dir, $stagingDir)
            Write-CleanupLog ('  Phase C atomic-renamed iter=' + $iter + ' from=' + $Dir + ' to=' + $stagingDir)

            # Best-effort delete of the staging dir. If this fails it's
            # non-fatal: NSIS now sees $INSTDIR as empty and will install
            # to a clean dir. Leftovers get swept by Remove-StaleStagingDirs
            # on the next install.
            try {
                Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction Stop
                Write-CleanupLog ('  Phase C deleted staging dir OK')
            } catch {
                Write-CleanupLog ('  Phase C staging-delete deferred (non-fatal, will sweep next install): ' + $_.Exception.Message)
            }
            return $true
        } catch {
            $lastError = $_.Exception.Message
            # If the source vanished between our Test-Path above and the
            # Move attempt, that's actually success - some other concurrent
            # cleanup did the rename for us.
            if (-not (Test-Path -LiteralPath $Dir)) {
                Write-CleanupLog ('  Phase C dir already gone (raced by another cleanup) iter=' + $iter)
                return $true
            }
        }
        Start-Sleep -Milliseconds 500
    }
    Write-CleanupLog ('  Phase C atomic-rename TIMEOUT after ' + $iter + ' iter dir=' + $Dir + ' lastError=' + $lastError)
    return $false
}

if ($BypassUninstall) {
    try {
        Write-CleanupLog '---- Phase C: bypass NSIS uninstallOldVersion ----'
        $entries = Get-ClawPiUninstallEntries
        if (@($entries).Count -eq 0) {
            Write-CleanupLog 'Phase C: no Claw-Pi entries in registry, nothing to bypass (fresh install)'
        }
        foreach ($e in $entries) {
            Write-CleanupLog ('Phase C entry  : ' + $e.DisplayName + ' v' + $e.DisplayVersion + ' dir=' + $e.InstallDir)
            Write-CleanupLog ('  Phase C reg   : ' + $e.RegPath)

            # Sweep any leftover staging dirs in the parent BEFORE we try
            # to rename. If a previous install crashed mid-way and left
            # ".claw-pi-removing-*" siblings, this clears them so we
            # don't accumulate disk debris.
            if ($e.InstallDir) {
                $parent = Split-Path -Parent $e.InstallDir
                if ($parent) { Remove-StaleStagingDirs -ParentDir $parent }
            }

            $rmOk = $true
            if ($e.InstallDir) {
                if (Test-SafeToRemoveDir -Dir $e.InstallDir) {
                    $rmOk = Move-OldClawPiInstallDirAside -Dir $e.InstallDir -DeadlineSeconds 10
                } else {
                    Write-CleanupLog ('  Phase C SKIP rename (not safe / no marker file): ' + $e.InstallDir)
                    # If the directory is already gone (or never existed), that's
                    # fine - we still want to clear the stale registry entry below.
                    if (-not (Test-Path -LiteralPath $e.InstallDir)) { $rmOk = $true } else { $rmOk = $false }
                }
            } else {
                Write-CleanupLog '  Phase C no install dir resolved, will only clear registry'
            }
            if ($rmOk) {
                try {
                    Remove-Item -LiteralPath $e.RegPath -Recurse -Force -ErrorAction Stop
                    Write-CleanupLog ('  Phase C deleted reg key OK')
                } catch {
                    Write-CleanupLog ('  Phase C DELETE REG FAIL: ' + $_.Exception.Message)
                }
            } else {
                Write-CleanupLog '  Phase C kept reg key (rename failed - NSIS uninstallOldVersion will fall back to old silent uninstaller)'
            }
        }
    } catch {
        Write-CleanupLog ('Phase C error : ' + $_.Exception.Message)
    }
}

# Tiny nap so any Defender / 360 mini-filter that started scanning a
# just-killed process can finish and release its handles.
Start-Sleep -Milliseconds 500

try {
    if ($script:CleanupMutexHeld -and $script:CleanupMutex) {
        try { $script:CleanupMutex.ReleaseMutex() } catch {}
        try { $script:CleanupMutex.Dispose() } catch {}
    }
} catch {}

try {
    $duration = ((Get-Date) - $script:Started).TotalMilliseconds
    Write-CleanupLog ('==== END   exit=0  duration=' + [int]$duration + 'ms ====')
    Write-CleanupLog ''
} catch {}

exit 0
