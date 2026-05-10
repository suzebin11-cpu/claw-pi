; Claw-Pi custom NSIS installer script.
;
; Four things, all defensive, all required to keep "Claw-Pi cannot be
; closed" from popping during upgrade:
;
;   1. preInit hook FIRST acquires a single-instance mutex BEFORE doing
;      anything else. The default ALLOW_ONLY_ONE_INSTALLER_INSTANCE
;      macro only fires AFTER preInit (see app-builder-lib's
;      installer.nsi line 73), so concurrent setup.exe launches would
;      otherwise all run cleanup.ps1 in parallel and race each other
;      deleting the same files. Field repro on suzeb's box (cleanup
;      log 2026-04-19 22:23-22:25): user double-clicked setup.exe
;      three times, three concurrent cleanup.ps1 instances raced each
;      other deleting the install dir, all three Phase C iterations
;      timed out with "Could not find a part of the path", reg key
;      stayed, NSIS fell back to old silent uninstaller, dialog popped.
;      Using a different mutex name from APP_GUID so the default
;      mutex check later still works.
;
;   2. preInit hook then extracts installer-cleanup.ps1 to $PLUGINSDIR
;      and runs it with -BypassUninstall. The script kills lingering
;      processes (Phase A), waits for any locked file to release
;      (Phase B), AND atomically renames any old install dir away +
;      clears its registry uninstall entry (Phase C).
;
;   3. customCheckAppRunning macro: no-ops electron-builder's default
;      CHECK_APP_RUNNING macro because its WMI-based loop has known
;      false-positive sources (snapshot lag, sibling-dir prefix match)
;      and we already did a more thorough cleanup in preInit.
;
;   4. customUnInit hook (uninstaller side): runs the same cleanup
;      script WITHOUT -BypassUninstall - the uninstaller has no
;      business deleting itself by tearing down its own install dir.
;
; No third-party NSIS plugins. All real logic lives in
; installer-cleanup.ps1 (extracted at runtime to $PLUGINSDIR).
;
; Everything this file emits is pure ASCII. makensis 3 under
; electron-builder's stdin pipeline rejects non-ASCII ("Bad text
; encoding") and rejects LogicLib ${If} syntax unless LogicLib.nsh
; is explicitly included.
;
; electron-builder invokes makensis TWICE per build:
;   pass 1: BUILD_UNINSTALLER defined, SilentInstall silent, goal is
;           to produce a standalone uninstaller.exe by running the
;           generated stub once.
;   pass 2: BUILD_UNINSTALLER NOT defined, the real installer that
;           ships to users.
; makensis runs with -WX (warnings-as-errors) in both passes. That
; means any Function or macro whose call-site lives only in the other
; pass MUST be hidden behind !ifdef / !ifndef or we get:
;   warning 6010: install function X not referenced           (installer pass)
;   warning 6020: Uninstaller script code found but WriteUninstaller never used (installer pass)
; and the build aborts.
;
; Strategy:
;   - installer-side function + preInit: only compile when NOT
;     BUILD_UNINSTALLER (preInit fires in the real installer).
;   - un.* function + customUnInit: only compile when BUILD_UNINSTALLER
;     (the uninstaller is written only during pass 1).
;
; Side note on the BUILD_UNINSTALLER self-extraction pass: the stub
; installer actually runs once on the build machine. We deliberately
; do NOT execute preInit during that pass (see !ifndef above), which
; also means no taskkill runs at build time.

!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  ; preInit pass: kill processes AND bypass NSIS uninstallOldVersion.
  ; The -BypassUninstall switch turns on Phase C in installer-cleanup.ps1
  ; which atomically renames the old install dir aside (single MoveFile
  ; call - no enumerate/delete race window) and clears its registry
  ; uninstall entry. NSIS's later uninstallOldVersion macro will then
  ; read an empty UninstallString and Return immediately, skipping the
  ; broken old silent uninstaller entirely.
  ;
  ; Two field root causes proven from suzeb's claw-pi-cleanup.log:
  ;   2026-04-19 21:44 (0.2.3 install): Phase B reported all files
  ;     freed, but 3 seconds later the OLD silent uninstaller's
  ;     atomicRMDir hit a mini-filter re-grab on file rename and
  ;     aborted with no retry. NSIS retried 5 times then popped
  ;     "Claw-Pi cannot be closed". Fixed in 0.2.5 by Phase C bypass.
  ;   2026-04-19 22:23-22:25 (0.2.5 install): Phase C bypass DID fire,
  ;     but user double-clicked setup.exe three times. Three concurrent
  ;     cleanup.ps1 instances raced each other doing Remove-Item
  ;     -Recurse on the same dir; PowerShell's enumerate-then-delete
  ;     model produced "Could not find a part of the path" errors as
  ;     each cleanup tried to delete files the others had already
  ;     deleted. All three Phase C deadlines timed out, reg key
  ;     stayed, NSIS fell back to old silent uninstaller, dialog
  ;     popped. Fixed in 0.2.6 by (a) preInit-level mutex (below) +
  ;     (b) Phase C atomic rename instead of recursive delete.
  Function ClawPiKillLingeringProcesses
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=claw-pi-cleanup.ps1" "${BUILD_RESOURCES_DIR}\installer-cleanup.ps1"

    ; -InstallDir forwards the NSIS $INSTDIR so the ps1 can target the
    ; exact directory NSIS is about to write to. -BypassUninstall arms
    ; Phase C (registry-driven atomic rename of any old install).
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\claw-pi-cleanup.ps1" -InstallDir "$INSTDIR" -BypassUninstall'
    Pop $0
  FunctionEnd

  Function ClawPiEnsureAsciiInstallDir
    ; Field repro: Electron-as-Node controller crashes before /health when
    ; installed under a non-ASCII path such as D:\ChineseName\Claw-Pi.
    ; Block these paths before files are written; startup has a second guard
    ; for userData/AppData paths that NSIS cannot fully control.
    System::Call 'kernel32::SetEnvironmentVariable(t "CLAWPI_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$p=$$env:CLAWPI_INSTALL_DIR; if ($$p -cmatch '[^\x00-\x7F]') { exit 2 }; exit 0"`
    Pop $0

    StrCmp $0 2 _claw_ascii_install_dir_blocked
    StrCmp $0 0 _claw_ascii_install_dir_ok

    MessageBox MB_ICONSTOP|MB_OK "Claw-Pi could not verify the install path. Please install to a short English path, for example C:\ClawPi or D:\ClawPi."
    Abort

    _claw_ascii_install_dir_blocked:
      MessageBox MB_ICONSTOP|MB_OK "Claw-Pi cannot be installed to a path containing non-ASCII characters. Please choose a short English path, for example C:\ClawPi or D:\ClawPi."
      Abort

    _claw_ascii_install_dir_ok:
  FunctionEnd

  !macro preInit
    ; ----------------------------------------------------------------
    ; Single-instance gate, runs BEFORE cleanup.ps1.
    ;
    ; Why this is here and not just relying on the default
    ; ALLOW_ONLY_ONE_INSTALLER_INSTANCE: that macro fires from
    ; .onInit AFTER preInit (see app-builder-lib's installer.nsi:73),
    ; which means a user who double-clicks setup.exe will spawn
    ; multiple processes that all complete preInit (and thus all
    ; spawn their own cleanup.ps1) before any of them hit the default
    ; mutex check. Three concurrent cleanups racing each other to
    ; Remove-Item -Recurse the same install dir is the exact failure
    ; mode field-reproduced on suzeb's box on 2026-04-19 22:23-22:25.
    ;
    ; We use a mutex name distinct from ${APP_GUID} so that the
    ; default ALLOW_ONLY_ONE_INSTALLER_INSTANCE macro (which uses
    ; ${APP_GUID}) still does its own check correctly later.
    ; The mutex stays held for the lifetime of this NSIS process,
    ; which is what we want.
    System::Call 'kernel32::CreateMutex(p 0, i 1, t "${APP_GUID}-preinit-cleanup")?e'
    Pop $0
    IntCmpU $0 183 _claw_preinit_dup _claw_preinit_proceed _claw_preinit_proceed
    _claw_preinit_dup:
      ; Same focus-and-restore UX the default ALLOW_ONLY_ONE_INSTALLER_INSTANCE
      ; uses: bring the existing installer window to front so the
      ; impatient user understands their first click DID work.
      BringToFront
      StrLen $0 "$(^SetupCaption)"
      IntOp $0 $0 + 1
      StrCpy $1 ""
      _claw_preinit_findloop:
        FindWindow $1 "#32770" "" "" $1
        StrCmp 0 $1 _claw_preinit_notfound
        System::Call 'user32::GetWindowText(p r1, t .r2, i r0)'
        StrCmp $2 "$(^SetupCaption)" 0 _claw_preinit_findloop
        SendMessage $1 0x112 0xF120 0 /TIMEOUT=2000
        System::Call "user32::SetForegroundWindow(p r1)"
      _claw_preinit_notfound:
      Abort
    _claw_preinit_proceed:
    Call ClawPiKillLingeringProcesses
    ; After Phase C the old install dir is renamed aside (or already
    ; gone) and its registry entry cleared; uninstallOldVersion in
    ; installSection.nsh will be a no-op. The Sleep below stays as a
    ; belt-and-suspenders pause for any transient handles a mini-filter
    ; may have grabbed; cheap insurance.
    Sleep 3000
  !macroend

  ; Replace electron-builder's default CHECK_APP_RUNNING macro entirely.
  ; The default (templates/nsis/include/allowOnlyOneInstallerInstance.nsh)
  ; uses Get-CimInstance Win32_Process | ? Path.StartsWith($INSTDIR), then
  ; if any match it KILLs and re-FINDs in a tight loop, and on the SECOND
  ; iteration still finding any match it pops appCannotBeClosed and quits.
  ; Two known false-positive sources make that loop unreliable for us:
  ;   1. Get-CimInstance returns a snapshot that lags the kernel by 1-2s,
  ;      so a PID we just killed in preInit can still appear "running".
  ;   2. StartsWith without a trailing path separator matches sibling
  ;      directories like "Claw-Pi-Backup" or any prefix collision.
  ; Our preInit cleanup already (a) kills every known Claw-Pi process,
  ; (b) waits for the kernel to retire each PID, and (c) sleeps 3s for
  ; transient lockers to drain. By the time we get here we've done more
  ; work than the default macro could - so we deliberately no-op it.
  !macro customCheckAppRunning
    DetailPrint "Skipping default CHECK_APP_RUNNING - preInit cleanup handled it."
  !macroend

  !macro customInstall
    Call ClawPiEnsureAsciiInstallDir
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  Function un.ClawPiKillLingeringProcesses
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=claw-pi-cleanup.ps1" "${BUILD_RESOURCES_DIR}\installer-cleanup.ps1"

    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\claw-pi-cleanup.ps1" -InstallDir "$INSTDIR"'
    Pop $0
  FunctionEnd

  !macro customUnInit
    Call un.ClawPiKillLingeringProcesses
  !macroend
!endif
