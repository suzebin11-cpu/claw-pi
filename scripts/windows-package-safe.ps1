param(
  [switch]$Portable,
  [switch]$ReuseBuilds,
  [switch]$ReuseRuntimeInstall,
  [switch]$ReuseOpenClawSidecar,
  [switch]$FastMode,
  [switch]$StopOpenClawProcesses,
  [string]$ReleaseDir = "E:\nexu-build-output"
)

$ErrorActionPreference = "Stop"

function Set-OptionalEnv {
  param(
    [string]$Name,
    [bool]$Enabled
  )

  if ($Enabled) {
    Set-Item -Path "Env:$Name" -Value "1"
  } else {
    Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
  }
}

function Test-PathInside {
  param(
    [string]$ParentPath,
    [string]$CandidatePath
  )

  $parent = [System.IO.Path]::TrimEndingDirectorySeparator(
    [System.IO.Path]::GetFullPath($ParentPath)
  )
  $candidate = [System.IO.Path]::TrimEndingDirectorySeparator(
    [System.IO.Path]::GetFullPath($CandidatePath)
  )

  return $candidate.StartsWith(
    $parent + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -or $candidate.Equals($parent, [System.StringComparison]::OrdinalIgnoreCase)
}

function Ensure-TrueShim {
  $shimDir = Join-Path $env:LOCALAPPDATA "bin"
  $shimPath = Join-Path $shimDir "true.cmd"
  if (-not (Test-Path $shimPath)) {
    New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
    Set-Content -Path $shimPath -Value "@exit /b 0" -Encoding Ascii
  }

  if (-not (($env:PATH -split ";") -contains $shimDir)) {
    $env:PATH = "$shimDir;$env:PATH"
  }
}

function Stop-OpenClawProcesses {
  $pattern = "openclaw-runtime|openclaw\\openclaw\.mjs|postinstall\.mjs|node-gyp|node-pre-gyp"
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match $pattern } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
        Write-Host "[windows-package-safe] stopped process $($_.ProcessId)"
      } catch {
        Write-Warning "[windows-package-safe] failed to stop process $($_.ProcessId): $($_.Exception.Message)"
      }
    }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resolvedReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)

if (Test-PathInside -ParentPath $repoRoot -CandidatePath $resolvedReleaseDir) {
  throw "ReleaseDir must be outside the repository root: $resolvedReleaseDir"
}

if ($ReuseOpenClawSidecar) {
  $ReuseRuntimeInstall = $true
}

Ensure-TrueShim

if ($StopOpenClawProcesses) {
  Stop-OpenClawProcesses
}

Set-Location $repoRoot

Set-Item -Path "Env:NEXU_DESKTOP_RELEASE_DIR" -Value $resolvedReleaseDir
Set-OptionalEnv -Name "NEXU_DESKTOP_USE_EXISTING_BUILDS" -Enabled $ReuseBuilds
Set-OptionalEnv -Name "NEXU_DESKTOP_USE_EXISTING_RUNTIME_INSTALL" -Enabled $ReuseRuntimeInstall
Set-OptionalEnv -Name "NEXU_DESKTOP_USE_EXISTING_OPENCLAW_SIDECAR" -Enabled $ReuseOpenClawSidecar
Set-OptionalEnv -Name "NEXU_DESKTOP_ELECTRON_BUILDER_FAST_MODE" -Enabled $FastMode

$distCommand = if ($Portable) { "dist:win:portable" } else { "dist:win" }

Write-Host "[windows-package-safe] repoRoot=$repoRoot"
Write-Host "[windows-package-safe] releaseDir=$resolvedReleaseDir"
Write-Host "[windows-package-safe] command=pnpm $distCommand"
Write-Host "[windows-package-safe] reuseBuilds=$ReuseBuilds reuseRuntimeInstall=$ReuseRuntimeInstall reuseOpenClawSidecar=$ReuseOpenClawSidecar fastMode=$FastMode"

& pnpm $distCommand
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
