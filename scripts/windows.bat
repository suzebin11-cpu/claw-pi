@echo off
setlocal enabledelayedexpansion

title Claw-Pi Setup

echo.
echo ========================================
echo          Claw-Pi Setup
echo ========================================
echo.

:: ── 1. Locate source files ──
set "SOURCE=%~dp0claw-pi-windows"
if exist "%SOURCE%\Claw-Pi.exe" goto :source_ok

echo  [ERROR] Cannot find install files.
echo.
echo  Make sure "claw-pi-windows" folder is in the same
echo  directory as this script.
echo.
echo  If you are running this from inside a ZIP file,
echo  please EXTRACT ALL files first, then run again.
echo.
pause
exit /b 1

:source_ok

:: ── 2. Install directory ──
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\Claw-Pi"
set "EXE_PATH=%INSTALL_DIR%\Claw-Pi.exe"
set "STAGING_DIR=%LOCALAPPDATA%\Programs\Claw-Pi.installing"
set "BACKUP_DIR=%LOCALAPPDATA%\Programs\Claw-Pi.backup"

:: ── 3. Check disk space (need ~2 GB) ──
title Claw-Pi Setup - Checking disk space...
set "FREE_GB="
for /f %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "[math]::Floor((Get-PSDrive ((Split-Path -Qualifier $env:LOCALAPPDATA).TrimEnd(':'))).Free/1GB)" 2^>nul') do set "FREE_GB=%%a"

if not defined FREE_GB goto :space_ok
if !FREE_GB! GEQ 2 goto :space_ok

echo  [ERROR] Not enough disk space.
echo  Available: !FREE_GB! GB, need at least 2 GB.
echo.
pause
exit /b 1

:space_ok

:: ── 4. Check existing install ──
if not exist "%EXE_PATH%" goto :do_install

echo.
echo  ========================================
echo    Claw-Pi 已经安装好了！
echo  ========================================
echo.
echo    安装位置: %INSTALL_DIR%
echo.
echo    提示: 桌面上已经有 Claw-Pi 图标了，
echo    以后直接双击桌面图标就能启动。
echo    不需要再运行这个安装程序。
echo.
echo  ----------------------------------------
echo    [L] 立即启动 Claw-Pi（推荐）
echo    [R] 重新安装（覆盖当前版本）
echo    [Q] 退出
echo  ----------------------------------------
echo.
choice /c LRQ /m "  请选择"
if !errorlevel! equ 3 goto :already_quit
if !errorlevel! equ 2 goto :already_reinstall
goto :already_launch

:already_launch
echo.
echo  正在启动 Claw-Pi...
start "" "%EXE_PATH%"
echo.
echo  Claw-Pi 已启动！
echo  下次直接双击桌面上的 Claw-Pi 图标就行了。
echo.
timeout /t 5 /nobreak
exit /b 0

:already_quit
echo.
echo  已退出。
echo  下次直接双击桌面上的 Claw-Pi 图标就能启动。
echo.
timeout /t 3 /nobreak
exit /b 0

:already_reinstall
echo.
echo  即将重新安装 Claw-Pi...

:: Kill running process if needed
tasklist /fi "imagename eq Claw-Pi.exe" 2>nul | find /i "Claw-Pi.exe" >nul
if !errorlevel! neq 0 goto :do_install

echo.
echo  正在关闭运行中的 Claw-Pi...
taskkill /f /im "Claw-Pi.exe" >nul 2>&1
timeout /t 3 /nobreak >nul
goto :do_install

:: ── 5. Copy files with progress bar ──
:do_install
title Claw-Pi Setup - Preparing...
echo.
echo  From: %SOURCE%
echo  To:   %INSTALL_DIR%
echo  Temp: %STAGING_DIR%

:: Detect USB / removable drive
for /f "tokens=2 delims==" %%d in ('wmic logicaldisk where "DeviceID='%~d0'" get DriveType /value 2^>nul ^| find "="') do (
    if "%%d"=="2" (
        echo.
        echo  [INFO] USB drive detected. Installation may take 5-15 minutes.
        echo  Tip: temporarily disable Windows Defender real-time
        echo  protection for faster installation.
    )
)

echo.
echo  Installing Claw-Pi, please wait...
echo  Do NOT close this window.
echo.

:: Build a PowerShell installer script with progress bar
set "_PS=%TEMP%\clawpi_copy_%RANDOM%.ps1"
>"!_PS!" echo $ErrorActionPreference = 'Stop'
>>"!_PS!" echo $src = $env:CLAWPI_SRC
>>"!_PS!" echo $dst = $env:CLAWPI_DST
>>"!_PS!" echo $staging = $env:CLAWPI_STAGING
>>"!_PS!" echo $backup = $env:CLAWPI_BACKUP
>>"!_PS!" echo function Get-LongPath([string]$path) {
>>"!_PS!" echo   if ($path.StartsWith('\\?\')) { return $path }
>>"!_PS!" echo   return '\\?\' + $path
>>"!_PS!" echo }
>>"!_PS!" echo function Directory-Exists([string]$path) {
>>"!_PS!" echo   return [System.IO.Directory]::Exists((Get-LongPath $path))
>>"!_PS!" echo }
>>"!_PS!" echo function File-Exists([string]$path) {
>>"!_PS!" echo   return [System.IO.File]::Exists((Get-LongPath $path))
>>"!_PS!" echo }
>>"!_PS!" echo function Ensure-Directory([string]$path) {
>>"!_PS!" echo   $longPath = Get-LongPath $path
>>"!_PS!" echo   if (-not ([System.IO.Directory]::Exists($longPath))) {
>>"!_PS!" echo     [void][System.IO.Directory]::CreateDirectory($longPath)
>>"!_PS!" echo   }
>>"!_PS!" echo }
>>"!_PS!" echo function Remove-Tree([string]$path) {
>>"!_PS!" echo   $longPath = Get-LongPath $path
>>"!_PS!" echo   if ([System.IO.Directory]::Exists($longPath)) {
>>"!_PS!" echo     [System.IO.Directory]::Delete($longPath, $true)
>>"!_PS!" echo   }
>>"!_PS!" echo }
>>"!_PS!" echo function Move-Tree([string]$fromPath, [string]$toPath) {
>>"!_PS!" echo   [System.IO.Directory]::Move((Get-LongPath $fromPath), (Get-LongPath $toPath))
>>"!_PS!" echo }
>>"!_PS!" echo function Copy-FileWithRetry([string]$fromPath, [string]$toPath) {
>>"!_PS!" echo   $destDir = Split-Path $toPath -Parent
>>"!_PS!" echo   Ensure-Directory $destDir
>>"!_PS!" echo   $lastError = $null
>>"!_PS!" echo   foreach ($attempt in 1..3) {
>>"!_PS!" echo     try {
>>"!_PS!" echo       [System.IO.File]::Copy((Get-LongPath $fromPath), (Get-LongPath $toPath), $true)
>>"!_PS!" echo       return
>>"!_PS!" echo     } catch {
>>"!_PS!" echo       $lastError = $_
>>"!_PS!" echo       Start-Sleep -Milliseconds 250
>>"!_PS!" echo     }
>>"!_PS!" echo   }
>>"!_PS!" echo   throw $lastError
>>"!_PS!" echo }
>>"!_PS!" echo function Is-IgnorableFailure([string]$relativePath) {
>>"!_PS!" echo   $pathLower = $relativePath.ToLowerInvariant()
>>"!_PS!" echo   return $pathLower.EndsWith('.d.ts') -or $pathLower.EndsWith('.map')
>>"!_PS!" echo }
>>"!_PS!" echo Remove-Tree $staging
>>"!_PS!" echo Remove-Tree $backup
>>"!_PS!" echo Ensure-Directory $staging
>>"!_PS!" echo Write-Host '  Scanning files...'
>>"!_PS!" echo $srcLong = Get-LongPath $src
>>"!_PS!" echo $dirs = @([System.IO.Directory]::GetDirectories($srcLong, '*', [System.IO.SearchOption]::AllDirectories))
>>"!_PS!" echo $files = @([System.IO.Directory]::GetFiles($srcLong, '*', [System.IO.SearchOption]::AllDirectories))
>>"!_PS!" echo $n = $files.Count
>>"!_PS!" echo if ($n -eq 0) { Write-Host '  [ERROR] No files found.'; exit 1 }
>>"!_PS!" echo foreach ($dirLong in $dirs) {
>>"!_PS!" echo   $relDir = $dirLong.Substring($srcLong.Length).TrimStart('\')
>>"!_PS!" echo   if ($relDir.Length -gt 0) {
>>"!_PS!" echo     Ensure-Directory (Join-Path $staging $relDir)
>>"!_PS!" echo   }
>>"!_PS!" echo }
>>"!_PS!" echo Write-Host "  Found $n files. Copying..."
>>"!_PS!" echo Write-Host ''
>>"!_PS!" echo $i = 0
>>"!_PS!" echo $criticalFailureCount = 0
>>"!_PS!" echo $ignoredFailureCount = 0
>>"!_PS!" echo $failureSamples = New-Object System.Collections.Generic.List[string]
>>"!_PS!" echo foreach ($fileLong in $files) {
>>"!_PS!" echo   $i++
>>"!_PS!" echo   $pct = [math]::Min(100, [math]::Floor(($i * 100) / $n))
>>"!_PS!" echo   $sourceFile = $fileLong.Substring(4)
>>"!_PS!" echo   $rel = $fileLong.Substring($srcLong.Length).TrimStart('\')
>>"!_PS!" echo   Write-Progress -Activity 'Installing Claw-Pi' -Status "$i / $n files" -PercentComplete $pct -CurrentOperation $rel
>>"!_PS!" echo   $host.UI.RawUI.WindowTitle = "Claw-Pi Setup - $pct percent"
>>"!_PS!" echo   $destFile = Join-Path $staging $rel
>>"!_PS!" echo   try {
>>"!_PS!" echo     Copy-FileWithRetry $sourceFile $destFile
>>"!_PS!" echo   } catch {
>>"!_PS!" echo     if (Is-IgnorableFailure $rel) {
>>"!_PS!" echo       $ignoredFailureCount++
>>"!_PS!" echo     } else {
>>"!_PS!" echo       $criticalFailureCount++
>>"!_PS!" echo       if ($failureSamples.Count -lt 10) {
>>"!_PS!" echo         $failureSamples.Add($rel)
>>"!_PS!" echo       }
>>"!_PS!" echo     }
>>"!_PS!" echo   }
>>"!_PS!" echo }
>>"!_PS!" echo Write-Progress -Activity 'Installing Claw-Pi' -Completed
>>"!_PS!" echo Write-Host ''
>>"!_PS!" echo if ($ignoredFailureCount -gt 0) {
>>"!_PS!" echo   Write-Host "  [INFO] Skipped $ignoredFailureCount non-runtime files (.d.ts/.map)."
>>"!_PS!" echo }
>>"!_PS!" echo if ($criticalFailureCount -gt 0) {
>>"!_PS!" echo   Write-Host "  [ERROR] $criticalFailureCount critical files failed to copy."
>>"!_PS!" echo   foreach ($sample in $failureSamples) {
>>"!_PS!" echo     Write-Host "    $sample"
>>"!_PS!" echo   }
>>"!_PS!" echo   Remove-Tree $staging
>>"!_PS!" echo   exit 1
>>"!_PS!" echo }
>>"!_PS!" echo $requiredFiles = @('Claw-Pi.exe', 'resources\app.asar')
>>"!_PS!" echo foreach ($requiredFile in $requiredFiles) {
>>"!_PS!" echo   $sourceRequired = Join-Path $src $requiredFile
>>"!_PS!" echo   if (File-Exists $sourceRequired) {
>>"!_PS!" echo     $stagingRequired = Join-Path $staging $requiredFile
>>"!_PS!" echo     if (-not (File-Exists $stagingRequired)) {
>>"!_PS!" echo       Write-Host "  [ERROR] Missing required file: $requiredFile"
>>"!_PS!" echo       Remove-Tree $staging
>>"!_PS!" echo       exit 1
>>"!_PS!" echo     }
>>"!_PS!" echo   }
>>"!_PS!" echo }
>>"!_PS!" echo $requiredDirs = @('resources')
>>"!_PS!" echo foreach ($requiredDir in $requiredDirs) {
>>"!_PS!" echo   $sourceRequired = Join-Path $src $requiredDir
>>"!_PS!" echo   if (Directory-Exists $sourceRequired) {
>>"!_PS!" echo     $stagingRequired = Join-Path $staging $requiredDir
>>"!_PS!" echo     if (-not (Directory-Exists $stagingRequired)) {
>>"!_PS!" echo       Write-Host "  [ERROR] Missing required directory: $requiredDir"
>>"!_PS!" echo       Remove-Tree $staging
>>"!_PS!" echo       exit 1
>>"!_PS!" echo     }
>>"!_PS!" echo   }
>>"!_PS!" echo }
>>"!_PS!" echo Write-Host "  Copied: $($n - $ignoredFailureCount) / $n"
>>"!_PS!" echo if (Directory-Exists $dst) {
>>"!_PS!" echo   Move-Tree $dst $backup
>>"!_PS!" echo }
>>"!_PS!" echo try {
>>"!_PS!" echo   Move-Tree $staging $dst
>>"!_PS!" echo } catch {
>>"!_PS!" echo   Write-Host '  [ERROR] Failed to activate the new installation.'
>>"!_PS!" echo   if (Directory-Exists $staging) { Remove-Tree $staging }
>>"!_PS!" echo   if ((-not (Directory-Exists $dst)) -and (Directory-Exists $backup)) {
>>"!_PS!" echo     Move-Tree $backup $dst
>>"!_PS!" echo   }
>>"!_PS!" echo   exit 1
>>"!_PS!" echo }
>>"!_PS!" echo if (Directory-Exists $backup) {
>>"!_PS!" echo   try {
>>"!_PS!" echo     Remove-Tree $backup
>>"!_PS!" echo   } catch {
>>"!_PS!" echo     Write-Host '  [INFO] Installed successfully, but could not remove the old backup folder.'
>>"!_PS!" echo   }
>>"!_PS!" echo }
>>"!_PS!" echo exit 0

set "CLAWPI_SRC=%SOURCE%"
set "CLAWPI_DST=%INSTALL_DIR%"
set "CLAWPI_STAGING=%STAGING_DIR%"
set "CLAWPI_BACKUP=%BACKUP_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -File "!_PS!"
set "COPY_EXIT=!errorlevel!"
set "CLAWPI_SRC="
set "CLAWPI_DST="
set "CLAWPI_STAGING="
set "CLAWPI_BACKUP="
del "!_PS!" 2>nul

if !COPY_EXIT! NEQ 0 goto :copy_failed

echo.
echo  [OK] Installation complete!
echo.
goto :create_shortcut

:copy_failed
echo  [ERROR] Installation failed (code: !COPY_EXIT!).
echo  Your previous installation was kept unchanged.
echo  Check disk space or antivirus, then try again.
echo.
pause
exit /b 1

:: ── 6. Create desktop shortcut ──
:create_shortcut
title Claw-Pi Setup - Creating shortcut...
echo  Creating desktop shortcut...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell;" ^
    "$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claw-Pi.lnk'));" ^
    "$lnk.TargetPath = '%EXE_PATH%';" ^
    "$lnk.WorkingDirectory = '%INSTALL_DIR%';" ^
    "$lnk.Description = 'Claw-Pi';" ^
    "$lnk.Save()"

if !errorlevel! equ 0 goto :shortcut_ok

echo  [INFO] Shortcut creation failed. You can open manually:
echo         %EXE_PATH%
goto :launch

:shortcut_ok
echo  [OK] Desktop shortcut created!

:: ── 7. Launch app ──
:launch
echo.
echo ========================================
echo    安装完成！正在启动 Claw-Pi...
echo ========================================
echo.

title Claw-Pi - 安装完成
start "" "%EXE_PATH%"

echo  Claw-Pi 已启动！
echo.
echo  ****************************************
echo  *                                      *
echo  *  重要提示：以后启动 Claw-Pi，        *
echo  *  请直接双击【桌面上的 Claw-Pi 图标】 *
echo  *  不需要再插 U 盘、不需要再运行       *
echo  *  这个安装程序。                       *
echo  *                                      *
echo  ****************************************
echo.
echo  此窗口 10 秒后自动关闭...
timeout /t 10 /nobreak
exit /b 0
