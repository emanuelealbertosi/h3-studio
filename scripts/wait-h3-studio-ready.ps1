[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BridgeUrl,

  [Parameter(Mandatory = $true)]
  [string]$WebUrl,

  [ValidateRange(10, 600)]
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$startedAt = [DateTime]::UtcNow
$nextProgressAt = 5

function Get-ElapsedSeconds {
  return [int][Math]::Floor(([DateTime]::UtcNow - $startedAt).TotalSeconds)
}

function Write-Phase {
  param([string]$Message)

  $elapsed = Get-ElapsedSeconds
  Write-Host ('[H3 Studio +{0:mm\:ss}] {1}' -f [TimeSpan]::FromSeconds($elapsed), $Message)
}

function Test-Endpoint {
  param(
    [string]$Uri,
    [switch]$RequireHealthyBridge
  )

  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri $Uri `
      -TimeoutSec 3 `
      -Headers @{ 'Cache-Control' = 'no-cache' }

    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
      return $false
    }

    if ($RequireHealthyBridge) {
      $payload = $response.Content | ConvertFrom-Json
      return $payload.bridge.status -eq 'online'
    }

    return $true
  } catch {
    return $false
  }
}

function Wait-Endpoint {
  param(
    [string]$Label,
    [string]$ReadyLabel = 'pronto',
    [string]$Uri,
    [switch]$RequireHealthyBridge
  )

  while ((Get-ElapsedSeconds) -lt $TimeoutSeconds) {
    if (Test-Endpoint -Uri $Uri -RequireHealthyBridge:$RequireHealthyBridge) {
      Write-Phase "$Label $ReadyLabel."
      return $true
    }

    $elapsed = Get-ElapsedSeconds
    if ($elapsed -ge $nextProgressAt) {
      Write-Phase "$Label in caricamento; attendo una risposta HTTP valida..."
      $script:nextProgressAt = $elapsed + 5
    }

    Start-Sleep -Milliseconds 750
  }

  Write-Phase "TIMEOUT: $Label non e diventato pronto entro $TimeoutSeconds secondi ($Uri)."
  return $false
}

Write-Phase 'Processi avviati. Verifico il bridge...'
if (-not (Wait-Endpoint -Label 'Bridge' -Uri $BridgeUrl -RequireHealthyBridge)) {
  exit 1
}

Write-Phase 'Pre-riscaldo l interfaccia web (la prima compilazione puo richiedere tempo)...'
if (-not (Wait-Endpoint -Label 'Interfaccia web' -ReadyLabel 'pronta' -Uri $WebUrl)) {
  exit 2
}

Write-Phase 'Avvio completato: H3 Studio e raggiungibile.'
exit 0
