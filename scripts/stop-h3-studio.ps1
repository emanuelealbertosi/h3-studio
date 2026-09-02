[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [ValidateRange(1, 60)]
  [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = 'Stop'

function Write-H3Error([string]$Message) {
  [Console]::Error.WriteLine("[H3 Studio] $Message")
}

function Normalize-CommandLine([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }
  return $Value.Replace('/', '\').ToLowerInvariant()
}

function Test-H3WorkloadMarker([string]$CommandLine) {
  $line = Normalize-CommandLine $CommandLine
  if ($line.Contains('bridge\server.ts')) {
    return $true
  }
  if ($line -match 'vinext(?:\.cmd)?[^\r\n]*\sdev(?:\s|$)') {
    return $true
  }
  if ($line -match 'vinext[\\/]dist[\\/][^\r\n]*\sdev(?:\s|$)') {
    return $true
  }
  return $false
}

function Get-ConfiguredBridgePort([string]$Root) {
  $defaultPort = 8787
  $envPath = Join-Path $Root '.env'
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    return $defaultPort
  }

  foreach ($line in Get-Content -LiteralPath $envPath -ErrorAction Stop) {
    if ($line -notmatch '^\s*H3_BRIDGE_PORT\s*=\s*(.*?)\s*$') {
      continue
    }
    $raw = $Matches[1].Trim().Trim('"').Trim("'")
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) {
      return $parsed
    }
  }
  return $defaultPort
}

function Get-Ancestry([object]$Process, [hashtable]$ProcessById) {
  $result = [System.Collections.Generic.List[object]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $current = $Process
  for ($depth = 0; $null -ne $current -and $depth -lt 32; $depth++) {
    $pidValue = [int]$current.ProcessId
    if (-not $seen.Add($pidValue)) {
      break
    }
    $result.Add($current)
    $parentId = [int]$current.ParentProcessId
    if (-not $ProcessById.ContainsKey($parentId)) {
      break
    }
    $current = $ProcessById[$parentId]
  }
  return @($result)
}

function Test-BelongsToH3(
  [object]$Process,
  [hashtable]$ProcessById,
  [string]$NormalizedRoot
) {
  $ancestry = @(Get-Ancestry $Process $ProcessById)
  $hasRoot = $false
  $hasWorkload = $false
  foreach ($item in $ancestry) {
    $line = Normalize-CommandLine ([string]$item.CommandLine)
    if ($line.Contains($NormalizedRoot)) {
      $hasRoot = $true
    }
    if (Test-H3WorkloadMarker $line) {
      $hasWorkload = $true
    }
  }
  return $hasRoot -and $hasWorkload
}

function Get-ListenerOwners([int[]]$Ports) {
  $owners = @()
  foreach ($port in $Ports) {
    $owners += @(
      Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object @{n='Port';e={$port}}, LocalAddress, OwningProcess
    )
  }
  return @($owners)
}

try {
  $resolvedRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
} catch {
  Write-H3Error "Percorso progetto non valido: $ProjectRoot"
  exit 10
}

if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
  Write-H3Error "Cartella progetto non trovata: $resolvedRoot"
  exit 10
}

$normalizedRoot = Normalize-CommandLine $resolvedRoot
$bridgePort = Get-ConfiguredBridgePort $resolvedRoot
$ports = @(3000, $bridgePort) | Select-Object -Unique

try {
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
  Write-H3Error "Impossibile leggere i processi Windows. $($_.Exception.Message)"
  exit 11
}

$processById = @{}
foreach ($process in $allProcesses) {
  $processById[[int]$process.ProcessId] = $process
}

$h3Processes = @(
  $allProcesses | Where-Object {
    $_.ProcessId -ne $PID -and
    (Test-BelongsToH3 $_ $processById $normalizedRoot)
  }
)
$h3Ids = @($h3Processes | ForEach-Object { [int]$_.ProcessId })
$h3Set = [System.Collections.Generic.HashSet[int]]::new()
foreach ($id in $h3Ids) {
  [void]$h3Set.Add($id)
}

# Stop only the highest H3 ancestors. taskkill /T then includes helpers spawned
# by the bridge (LLM/audio workers) without touching an independently launched
# ComfyUI process.
$roots = @(
  $h3Processes | Where-Object {
    -not $h3Set.Contains([int]$_.ParentProcessId)
  }
)

$failed = [System.Collections.Generic.List[int]]::new()
foreach ($rootProcess in $roots) {
  $targetPid = [int]$rootProcess.ProcessId
  $name = [string]$rootProcess.Name
  Write-Output "[H3 Studio] Arresto albero PID $targetPid ($name)..."
  & "$env:SystemRoot\System32\taskkill.exe" /PID $targetPid /T /F 2>&1 | ForEach-Object {
    Write-Output "  $_"
  }
  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
    $failed.Add($targetPid)
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
  $alive = @(
    $h3Ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
  )
  if ($alive.Count -eq 0) {
    break
  }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)

$stillAlive = @(
  $h3Ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
)
foreach ($id in $stillAlive) {
  if (-not $failed.Contains([int]$id)) {
    $failed.Add([int]$id)
  }
}

$listeners = @(Get-ListenerOwners $ports)
$foreignListeners = @()
foreach ($listener in $listeners) {
  $ownerId = [int]$listener.OwningProcess
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
  # Tailscale Serve owns listeners on the Tailscale IPv4/IPv6 addresses while
  # proxying H3. It is a machine service, not an orphaned H3 process, and must
  # remain active when the local Studio is stopped.
  $isTailscaleProxy = $null -ne $owner -and $owner.Name -ieq 'tailscaled.exe'
  if (
    $null -ne $owner -and
    -not $isTailscaleProxy -and
    -not (Test-BelongsToH3 $owner $processById $normalizedRoot)
  ) {
    $foreignListeners += $listener
  }
}

$runDir = Join-Path $resolvedRoot 'data\run'
if (Test-Path -LiteralPath $runDir -PathType Container) {
  Get-ChildItem -LiteralPath $runDir -Filter '*.pid' -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

if ($failed.Count -gt 0) {
  Write-H3Error "Non sono riuscito ad arrestare i PID: $($failed -join ', ')."
  exit 20
}

if ($foreignListeners.Count -gt 0) {
  foreach ($listener in $foreignListeners) {
    $ownerId = [int]$listener.OwningProcess
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
    $ownerName = if ($null -ne $owner) { $owner.Name } else { 'processo sconosciuto' }
    Write-H3Error (
      "La porta $($listener.Port) resta occupata dal PID $ownerId " +
      "($ownerName), che non appartiene a questo H3 Studio. Non è stato terminato."
    )
  }
  exit 21
}

if ($h3Ids.Count -eq 0) {
  Write-Output '[H3 Studio] Nessun processo del progetto attivo.'
} else {
  Write-Output "[H3 Studio] Arrestati $($h3Ids.Count) processi del progetto."
}
Write-Output "[H3 Studio] Listener locali sulle porte 3000 e $bridgePort verificati."
Write-Output '[H3 Studio] ComfyUI e gli eventuali proxy Tailscale non sono stati toccati.'
exit 0
