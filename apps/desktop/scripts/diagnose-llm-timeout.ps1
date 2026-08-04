[CmdletBinding()]
param(
  [string]$HostName = "api.clawpi.app",
  [int]$Port = 9443,
  [int]$TailLines = 300
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Get-TimeStamp {
  return Get-Date -Format "yyyyMMdd-HHmmss"
}

function Add-ReportLine {
  param([AllowEmptyString()][string]$Text = "")
  $script:Report.Add($Text)
}

function Add-Section {
  param([string]$Title)
  Add-ReportLine ""
  Add-ReportLine ("=" * 72)
  Add-ReportLine $Title
  Add-ReportLine ("=" * 72)
}

function Format-ErrorText {
  param($ErrorRecord)
  if ($null -eq $ErrorRecord) {
    return "unknown error"
  }
  if ($ErrorRecord.Exception -and $ErrorRecord.Exception.Message) {
    return $ErrorRecord.Exception.Message
  }
  return [string]$ErrorRecord
}

function Protect-Text {
  param([AllowNull()][string]$Text)
  if ($null -eq $Text) {
    return ""
  }

  $redacted = $Text
  $redacted = [regex]::Replace(
    $redacted,
    '(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/\-=]+',
    '$1***'
  )
  $redacted = [regex]::Replace(
    $redacted,
    '(?i)("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)"?\s*[:=]\s*"?)[^",\s}]+',
    '$1***'
  )
  $redacted = [regex]::Replace(
    $redacted,
    '(?i)(https?://)([^/@\s:]+):([^/@\s]+)@',
    '$1***:***@'
  )
  $redacted = [regex]::Replace(
    $redacted,
    '(?i)([?&#](?:token|key|secret|password)=)[^&#\s]+',
    '$1***'
  )
  return $redacted
}

function Format-ProxyValue {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return "<unset>"
  }
  return Protect-Text $Value.Trim()
}

function Add-CommandOutput {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Add-ReportLine ("[{0}]" -f $Label)
  try {
    $output = & $Command 2>&1 | Out-String -Width 240
    if ([string]::IsNullOrWhiteSpace($output)) {
      Add-ReportLine "<no output>"
    } else {
      Add-ReportLine (Protect-Text $output.TrimEnd())
    }
  } catch {
    Add-ReportLine ("ERROR: {0}" -f (Format-ErrorText $_))
  }
}

function Test-TcpEndpoint {
  param(
    [string]$TargetHost,
    [int]$TargetPort,
    [int]$TimeoutMs = 10000
  )

  $client = New-Object System.Net.Sockets.TcpClient
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $task = $client.ConnectAsync($TargetHost, $TargetPort)
    if (-not $task.Wait($TimeoutMs)) {
      throw "TCP connect timed out after ${TimeoutMs}ms"
    }
    if ($task.IsFaulted) {
      throw $task.Exception.GetBaseException()
    }
    $watch.Stop()
    return [pscustomobject]@{
      Success = $true
      ElapsedMs = $watch.ElapsedMilliseconds
      Error = $null
    }
  } catch {
    $watch.Stop()
    return [pscustomobject]@{
      Success = $false
      ElapsedMs = $watch.ElapsedMilliseconds
      Error = Format-ErrorText $_
    }
  } finally {
    $client.Dispose()
  }
}

function Invoke-HttpProbe {
  param(
    [string]$Url,
    [bool]$UseSystemProxy
  )

  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $UseSystemProxy
  if ($UseSystemProxy) {
    $handler.Proxy = [System.Net.WebRequest]::DefaultWebProxy
    if ($handler.Proxy) {
      $handler.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
    }
  }

  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(30)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd("Claw-Pi-Diagnostics/1.0")
  $watch = [System.Diagnostics.Stopwatch]::StartNew()

  try {
    $response = $client.GetAsync($Url).GetAwaiter().GetResult()
    $watch.Stop()
    return [pscustomobject]@{
      Success = $true
      Status = [int]$response.StatusCode
      Reason = $response.ReasonPhrase
      ElapsedMs = $watch.ElapsedMilliseconds
      Error = $null
    }
  } catch {
    $watch.Stop()
    return [pscustomobject]@{
      Success = $false
      Status = $null
      Reason = $null
      ElapsedMs = $watch.ElapsedMilliseconds
      Error = Format-ErrorText $_
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Get-SafeUriText {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return "<unset>"
  }
  try {
    $uri = [Uri]$Value
    return "{0}://{1}:{2}{3}" -f $uri.Scheme, $uri.Host, $uri.Port, $uri.AbsolutePath.TrimEnd("/")
  } catch {
    return Protect-Text $Value
  }
}

function Find-BuildConfigFiles {
  $candidates = New-Object System.Collections.Generic.List[string]

  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match '^(Claw-Pi|claw-pi|nexu)' } |
    ForEach-Object {
      try {
        if ($_.Path) {
          $candidates.Add((Join-Path (Split-Path $_.Path -Parent) "resources\build-config.json"))
        }
      } catch {
        # Access to Path can be denied for elevated processes.
      }
    }

  @(
    (Join-Path $env:LOCALAPPDATA "Programs\claw-pi-desktop\resources\build-config.json"),
    (Join-Path $env:LOCALAPPDATA "Programs\Claw-Pi\resources\build-config.json"),
    (Join-Path $env:LOCALAPPDATA "claw-pi-desktop\resources\build-config.json")
  ) | ForEach-Object { $candidates.Add($_) }

  return $candidates |
    Select-Object -Unique |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
}

function Add-JsonConfigSummary {
  param(
    [string]$Path,
    [string]$Label
  )

  Add-ReportLine ("[{0}] {1}" -f $Label, $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-ReportLine "not found"
    return
  }

  try {
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $cloud = $json.desktop.cloud
    if ($null -ne $cloud) {
      $modelItems = @($cloud.models)
      $modelIds = @(
        $modelItems |
          ForEach-Object {
            if ($_.id) { [string]$_.id } elseif ($_.name) { [string]$_.name }
          } |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
      )
      $apiKeyLength = if ($cloud.apiKey) { ([string]$cloud.apiKey).Length } else { 0 }
      Add-ReportLine ("connected={0}" -f $cloud.connected)
      Add-ReportLine ("polling={0}" -f $cloud.polling)
      Add-ReportLine ("linkUrl={0}" -f (Get-SafeUriText ([string]$cloud.linkUrl)))
      Add-ReportLine ("apiKeyPresent={0}; apiKeyLength={1}" -f ($apiKeyLength -gt 0), $apiKeyLength)
      Add-ReportLine ("modelsUpdatedAt={0}" -f $cloud.modelsUpdatedAt)
      Add-ReportLine ("modelCount={0}" -f $modelIds.Count)
      Add-ReportLine ("models={0}" -f (($modelIds | Select-Object -First 40) -join ", "))
    } else {
      Add-ReportLine "desktop.cloud not present"
    }
  } catch {
    Add-ReportLine ("ERROR parsing JSON: {0}" -f (Format-ErrorText $_))
  }
}

function Add-OpenClawConfigSummary {
  param([string]$Path)

  Add-ReportLine ("[OpenClaw config] {0}" -f $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-ReportLine "not found"
    return
  }

  try {
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $link = $json.models.providers.link
    Add-ReportLine ("defaultModel={0}" -f $json.agents.defaults.model.primary)
    Add-ReportLine ("llmIdleTimeoutSeconds={0}" -f $json.agents.defaults.llm.idleTimeoutSeconds)
    if ($null -ne $link) {
      Add-ReportLine ("link.baseUrl={0}" -f (Get-SafeUriText ([string]$link.baseUrl)))
      Add-ReportLine ("link.api={0}" -f $link.api)
      Add-ReportLine ("link.apiKeyPresent={0}" -f (-not [string]::IsNullOrWhiteSpace([string]$link.apiKey)))
      Add-ReportLine ("link.modelCount={0}" -f @($link.models).Count)
      Add-ReportLine ("link.models={0}" -f ((@($link.models) | ForEach-Object { $_.id } | Select-Object -First 40) -join ", "))
    } else {
      Add-ReportLine "models.providers.link not present"
    }
  } catch {
    Add-ReportLine ("ERROR parsing JSON: {0}" -f (Format-ErrorText $_))
  }
}

function Add-LogSummary {
  param(
    [string]$Path,
    [int]$Lines
  )

  Add-ReportLine ("[Log] {0}" -f $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-ReportLine "not found"
    return
  }

  try {
    $item = Get-Item -LiteralPath $Path
    Add-ReportLine ("size={0}; modified={1:o}" -f $item.Length, $item.LastWriteTime)
    $pattern = 'timeout|timed out|LLM|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|certificate|CERT_|401|403|407|429|9443|proxy|unauthorized|rate limit'
    $tail = @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop)
    $matches = @($tail | Select-String -Pattern $pattern -CaseSensitive:$false)
    if ($matches.Count -eq 0) {
      Add-ReportLine ("no matching errors in last {0} lines" -f $Lines)
    } else {
      $matches |
        Select-Object -Last 120 |
        ForEach-Object { Add-ReportLine (Protect-Text $_.Line) }
    }
  } catch {
    Add-ReportLine ("ERROR reading log: {0}" -f (Format-ErrorText $_))
  }
}

$Report = New-Object System.Collections.Generic.List[string]
$timestamp = Get-TimeStamp
$desktopPath = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($desktopPath) -or -not (Test-Path -LiteralPath $desktopPath)) {
  $desktopPath = $env:USERPROFILE
}
$reportPath = Join-Path $desktopPath "claw-pi-llm-timeout-$timestamp.txt"
$userDataRoot = Join-Path $env:LOCALAPPDATA "claw-pi-desktop"
$legacyUserDataRoots = @(
  (Join-Path $env:APPDATA "claw-pi-desktop"),
  (Join-Path $env:APPDATA "nexu-desktop"),
  (Join-Path $env:APPDATA "@clawpi\desktop")
)
$modelsUrl = "https://${HostName}:$Port/v1/models"

Add-ReportLine "Claw-Pi LLM timeout diagnostic"
Add-ReportLine ("generated={0:o}" -f (Get-Date))
Add-ReportLine ("computer={0}; user={1}" -f $env:COMPUTERNAME, $env:USERNAME)
Add-ReportLine ("PowerShell={0}; 64bitProcess={1}" -f $PSVersionTable.PSVersion, [Environment]::Is64BitProcess)
Add-ReportLine ("target={0}" -f $modelsUrl)
Add-ReportLine "This report intentionally omits API keys, tokens, passwords, cookies, and proxy credentials."

Add-Section "1. Operating system and Claw-Pi processes"
Add-CommandOutput "Windows" {
  Get-CimInstance Win32_OperatingSystem |
    Select-Object Caption, Version, BuildNumber, OSArchitecture, LastBootUpTime
}
Add-CommandOutput "Claw-Pi related processes" {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -match '(?i)claw|nexu|electron|openclaw' -or
      $_.CommandLine -match '(?i)claw-pi|nexu|openclaw'
    } |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
}
Add-CommandOutput "Relevant TCP connections" {
  Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object {
      $_.LocalPort -in @(18789, 50800, 50810) -or
      $_.RemotePort -eq $Port
    } |
    Select-Object State, LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess
}

Add-Section "2. DNS, TCP, and HTTPS transport"
try {
  $addresses = [System.Net.Dns]::GetHostAddresses($HostName) |
    ForEach-Object { $_.IPAddressToString }
  Add-ReportLine ("DNS {0} => {1}" -f $HostName, ($addresses -join ", "))
} catch {
  Add-ReportLine ("DNS ERROR: {0}" -f (Format-ErrorText $_))
}

$tcp = Test-TcpEndpoint -TargetHost $HostName -TargetPort $Port
Add-ReportLine ("TCP {0}:{1} success={2}; elapsedMs={3}; error={4}" -f $HostName, $Port, $tcp.Success, $tcp.ElapsedMs, $tcp.Error)

try {
  Add-Type -AssemblyName System.Net.Http
  $systemProbe = Invoke-HttpProbe -Url $modelsUrl -UseSystemProxy $true
  Add-ReportLine ("HTTPS system-proxy success={0}; status={1}; reason={2}; elapsedMs={3}; error={4}" -f $systemProbe.Success, $systemProbe.Status, $systemProbe.Reason, $systemProbe.ElapsedMs, (Protect-Text $systemProbe.Error))
  $directProbe = Invoke-HttpProbe -Url $modelsUrl -UseSystemProxy $false
  Add-ReportLine ("HTTPS direct success={0}; status={1}; reason={2}; elapsedMs={3}; error={4}" -f $directProbe.Success, $directProbe.Status, $directProbe.Reason, $directProbe.ElapsedMs, (Protect-Text $directProbe.Error))
} catch {
  Add-ReportLine ("HTTPS probe setup ERROR: {0}" -f (Format-ErrorText $_))
}

Add-ReportLine ""
Add-ReportLine "Interpretation: HTTP 200 or a quick HTTP 401 both prove DNS/TCP/TLS reachability."
Add-ReportLine "A TCP timeout indicates firewall/ISP/port blocking before authentication."
Add-ReportLine "System-proxy success plus direct failure indicates the Node child process needs explicit proxy environment variables."

Add-Section "3. Proxy configuration"
foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")) {
  Add-ReportLine ("process {0}={1}" -f $name, (Format-ProxyValue ([Environment]::GetEnvironmentVariable($name, "Process"))))
  Add-ReportLine ("user    {0}={1}" -f $name, (Format-ProxyValue ([Environment]::GetEnvironmentVariable($name, "User"))))
  Add-ReportLine ("machine {0}={1}" -f $name, (Format-ProxyValue ([Environment]::GetEnvironmentVariable($name, "Machine"))))
}
Add-CommandOutput "WinHTTP proxy" { netsh winhttp show proxy }
Add-CommandOutput "Current user Internet Settings" {
  $key = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
  [pscustomobject]@{
    ProxyEnable = $key.ProxyEnable
    ProxyServer = Format-ProxyValue ([string]$key.ProxyServer)
    AutoConfigURL = Format-ProxyValue ([string]$key.AutoConfigURL)
    AutoDetect = $key.AutoDetect
  }
}

Add-Section "4. Installed build and persisted cloud configuration"
$buildConfigs = @(Find-BuildConfigFiles)
if ($buildConfigs.Count -eq 0) {
  Add-ReportLine "No installed resources\build-config.json was found from the running process or common install paths."
} else {
  foreach ($path in $buildConfigs) {
    Add-ReportLine ("[Build config] {0}" -f $path)
    try {
      $build = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      Add-ReportLine ("version={0}" -f $build.NEXU_DESKTOP_APP_VERSION)
      Add-ReportLine ("commit={0}" -f $build.NEXU_DESKTOP_BUILD_COMMIT)
      Add-ReportLine ("builtAt={0}" -f $build.NEXU_DESKTOP_BUILD_TIME)
      Add-ReportLine ("cloudUrl={0}" -f (Get-SafeUriText ([string]$build.NEXU_CLOUD_URL)))
      Add-ReportLine ("linkUrl={0}" -f (Get-SafeUriText ([string]$build.NEXU_LINK_URL)))
    } catch {
      Add-ReportLine ("ERROR parsing build config: {0}" -f (Format-ErrorText $_))
    }
  }
}

Add-JsonConfigSummary -Path (Join-Path $userDataRoot ".claw-pi\config.json") -Label "Desktop config"
Add-OpenClawConfigSummary -Path (Join-Path $userDataRoot "runtime\openclaw\config\openclaw.json")

foreach ($legacyRoot in $legacyUserDataRoots) {
  if (Test-Path -LiteralPath $legacyRoot) {
    Add-ReportLine ("legacyUserDataPresent={0}" -f $legacyRoot)
  }
}

Add-Section "5. Local runtime health"
foreach ($url in @(
  "http://127.0.0.1:50800/health",
  "http://127.0.0.1:50800/api/internal/desktop/ready",
  "http://127.0.0.1:50810/"
)) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5
    $body = [string]$response.Content
    if ($body.Length -gt 1000) {
      $body = $body.Substring(0, 1000)
    }
    Add-ReportLine ("{0} => HTTP {1}; body={2}" -f $url, $response.StatusCode, (Protect-Text $body))
  } catch {
    $statusCode = $null
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
    Add-ReportLine ("{0} => ERROR status={1}; {2}" -f $url, $statusCode, (Format-ErrorText $_))
  }
}

Add-Section "6. Relevant recent log errors"
$logPaths = @(
  (Join-Path $userDataRoot "logs\desktop-main.log"),
  (Join-Path $userDataRoot "logs\cold-start.log"),
  (Join-Path $userDataRoot "logs\runtime-units\controller.log"),
  (Join-Path $userDataRoot "logs\runtime-units\openclaw.log"),
  (Join-Path $userDataRoot "logs\runtime-units\web.log"),
  (Join-Path $userDataRoot "logs\runtime-units\control-plane.log")
)
foreach ($path in $logPaths) {
  Add-LogSummary -Path $path -Lines $TailLines
}

Add-Section "7. Automated conclusion"
if (-not $tcp.Success) {
  Add-ReportLine "LIKELY ROOT CAUSE: TCP connection to the model endpoint failed."
  Add-ReportLine "Check firewall, ISP routing, antivirus HTTPS scanning, and whether nonstandard port 9443 is allowed."
} elseif ($systemProbe.Success -and -not $directProbe.Success) {
  Add-ReportLine "LIKELY ROOT CAUSE: this PC requires its system proxy/PAC, but the Node child process is attempting a direct connection."
  Add-ReportLine "Set HTTP_PROXY/HTTPS_PROXY for the user, keep localhost in NO_PROXY, fully exit Claw-Pi, then reopen it."
} elseif (-not $systemProbe.Success -and -not $directProbe.Success) {
  Add-ReportLine "LIKELY ROOT CAUSE: HTTPS/TLS failed even though TCP may be open."
  Add-ReportLine "Check certificate errors, antivirus HTTPS interception, Windows root certificates, and system time."
} else {
  Add-ReportLine "Transport to /v1/models is reachable."
  Add-ReportLine "Inspect controller/openclaw log lines above for upstream streaming timeout, 401, 429, stale endpoint, or model-provider errors."
}

try {
  $Report | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Host ""
  Write-Host "Claw-Pi diagnostic complete." -ForegroundColor Green
  Write-Host "Report: $reportPath"
  Write-Host "Send this TXT report back for analysis. Secrets have been redacted."
} catch {
  Write-Error ("Failed to write report: {0}" -f (Format-ErrorText $_))
  exit 1
}
