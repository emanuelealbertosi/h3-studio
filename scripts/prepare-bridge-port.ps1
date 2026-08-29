[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [string]$HostAddress = "127.0.0.1",

  [ValidateRange(1, 65535)]
  [int]$Port = 8787,

  [ValidateRange(1, 60)]
  [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"

function Get-BridgeListener {
  $listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object {
        $_.LocalPort -eq $Port -and
          (Test-ListenerAddressConflict $_.LocalAddress)
      }
  )

  return @($listeners)
}

function Write-Failure([string]$Message) {
  [Console]::Error.WriteLine("[H3 Studio] $Message")
}

function Test-WildcardAddress([System.Net.IPAddress]$Address) {
  return (
    $Address.Equals([System.Net.IPAddress]::Any) -or
    $Address.Equals([System.Net.IPAddress]::IPv6Any)
  )
}

function Test-IpAddressEquals(
  [System.Net.IPAddress]$Left,
  [System.Net.IPAddress]$Right
) {
  if ($Left.IsIPv4MappedToIPv6) {
    $Left = $Left.MapToIPv4()
  }
  if ($Right.IsIPv4MappedToIPv6) {
    $Right = $Right.MapToIPv4()
  }
  return $Left.Equals($Right)
}

function Resolve-H3HostAddresses([string]$Address) {
  $normalizedAddress = $Address.Trim()
  if (
    $normalizedAddress.StartsWith('[') -and
    $normalizedAddress.EndsWith(']')
  ) {
    $normalizedAddress = $normalizedAddress.Substring(
      1,
      $normalizedAddress.Length - 2
    )
  }

  if ([string]::IsNullOrWhiteSpace($normalizedAddress)) {
    throw "Host vuoto"
  }

  if ($normalizedAddress -ieq "localhost") {
    return @(
      [System.Net.IPAddress]::Loopback,
      [System.Net.IPAddress]::IPv6Loopback
    )
  }

  $parsedAddress = $null
  if ([System.Net.IPAddress]::TryParse($normalizedAddress, [ref]$parsedAddress)) {
    return @($parsedAddress)
  }

  $resolved = @([System.Net.Dns]::GetHostAddresses($normalizedAddress))
  if ($resolved.Count -eq 0) {
    throw "Host non risolto: $normalizedAddress"
  }
  return $resolved
}

function Test-ListenerAddressConflict([string]$ListenerAddress) {
  $parsedListener = $null
  if (-not [System.Net.IPAddress]::TryParse(
    $ListenerAddress,
    [ref]$parsedListener
  )) {
    # An address we cannot classify must never be treated as safe.
    return $true
  }

  if ($requestIsWildcard -or (Test-WildcardAddress $parsedListener)) {
    return $true
  }

  foreach ($requestedAddress in $requestedAddresses) {
    if (Test-IpAddressEquals $requestedAddress $parsedListener) {
      return $true
    }
  }
  return $false
}

if (-not ("H3CommandLineParser" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class H3CommandLineParser
{
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(
        [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
        out int argumentCount
    );

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string[] Parse(string commandLine)
    {
        int argumentCount;
        IntPtr argumentVector = CommandLineToArgvW(commandLine, out argumentCount);
        if (argumentVector == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            string[] arguments = new string[argumentCount];
            for (int index = 0; index < argumentCount; index++)
            {
                IntPtr argumentPointer = Marshal.ReadIntPtr(
                    argumentVector,
                    index * IntPtr.Size
                );
                arguments[index] = Marshal.PtrToStringUni(argumentPointer);
            }
            return arguments;
        }
        finally
        {
            LocalFree(argumentVector);
        }
    }
}
"@
}

function Convert-ArgumentToFullPath([string]$Argument) {
  if ([string]::IsNullOrWhiteSpace($Argument)) {
    return $null
  }

  $candidate = $Argument
  if ($candidate -match '^--(?:import|loader|require)=(.+)$') {
    $candidate = $Matches[1]
  }

  if ($candidate.StartsWith("file:", [System.StringComparison]::OrdinalIgnoreCase)) {
    try {
      $candidate = ([System.Uri]$candidate).LocalPath
    } catch {
      return $null
    }
  }

  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    return $null
  }

  try {
    return [System.IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
  } catch {
    return $null
  }
}

function Test-PathEquals([string]$Left, [string]$Right) {
  return $Left.Equals($Right, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathWithin([string]$Candidate, [string]$Root) {
  if (Test-PathEquals $Candidate $Root) {
    return $true
  }

  return $Candidate.StartsWith(
    $Root.TrimEnd('\', '/') + '\',
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Test-H3BridgeCommandLine(
  [string]$CommandLine,
  [string]$ExpectedServerPath,
  [string]$ExpectedNodeModulesRoot
) {
  try {
    $arguments = @([H3CommandLineParser]::Parse($CommandLine))
  } catch {
    return $false
  }

  $hasProjectTsxReference = $false
  $hasExactEntrypoint = $false
  foreach ($argument in $arguments) {
    $fullPath = Convert-ArgumentToFullPath $argument
    if ($null -ne $fullPath) {
      if (Test-PathWithin $fullPath $ExpectedNodeModulesRoot) {
        $relativeModulePath = $fullPath.Substring(
          $ExpectedNodeModulesRoot.Length
        ).TrimStart('\', '/')
        if ($relativeModulePath -match '(^|[\\/])tsx(?:@[^\\/]+)?([\\/]|$)') {
          $hasProjectTsxReference = $true
        }
      }
      if (Test-PathEquals $fullPath $ExpectedServerPath) {
        $hasExactEntrypoint = $true
      }
    }

    $normalizedArgument = $argument.Replace('/', '\')
    if ($normalizedArgument.Equals(
      'bridge\server.ts',
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      $hasExactEntrypoint = $true
    }
  }

  return $hasProjectTsxReference -and $hasExactEntrypoint
}

try {
  $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
} catch {
  Write-Failure "ProjectRoot non valido: $ProjectRoot"
  exit 10
}

if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
  Write-Failure "ProjectRoot non trovato: $resolvedProjectRoot"
  exit 10
}

try {
  $requestedAddresses = @(Resolve-H3HostAddresses $HostAddress)
} catch {
  Write-Failure "Host bridge non valido '$HostAddress'. $($_.Exception.Message)"
  exit 10
}
$requestIsWildcard = @(
  $requestedAddresses | Where-Object { Test-WildcardAddress $_ }
).Count -gt 0

$expectedServerPath = [System.IO.Path]::GetFullPath(
  (Join-Path $resolvedProjectRoot "bridge\server.ts")
).TrimEnd('\', '/')
$expectedNodeModulesRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $resolvedProjectRoot "node_modules")
).TrimEnd('\', '/')

try {
  $listeners = @(Get-BridgeListener)
} catch {
  Write-Failure "Impossibile verificare ${HostAddress}:$Port. $($_.Exception.Message)"
  exit 11
}

if ($listeners.Count -eq 0) {
  Write-Output "[H3 Studio] Porta ${HostAddress}:$Port libera."
  exit 0
}

$ownerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($ownerPids.Count -ne 1) {
  Write-Failure "Più processi ascoltano su ${HostAddress}:$Port; avvio annullato."
  exit 12
}

$ownerPid = [int]$ownerPids[0]
try {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid"
} catch {
  Write-Failure "Impossibile verificare il processo PID $ownerPid; avvio annullato."
  exit 20
}

if ($null -eq $owner -or [string]::IsNullOrWhiteSpace($owner.CommandLine)) {
  Write-Failure "Command line del PID $ownerPid non disponibile; avvio annullato."
  exit 20
}

$isNode = $owner.Name -ieq "node.exe"
$isExpectedBridge = Test-H3BridgeCommandLine `
  $owner.CommandLine `
  $expectedServerPath `
  $expectedNodeModulesRoot

if (-not ($isNode -and $isExpectedBridge)) {
  Write-Failure (
    "La porta ${HostAddress}:$Port è occupata dal PID $ownerPid " +
    "($($owner.Name)), che non è il bridge di questo progetto. Avvio annullato."
  )
  exit 21
}

# Fail closed if the listener changed between inspection and termination.
$confirmedPids = @(
  Get-BridgeListener | Select-Object -ExpandProperty OwningProcess -Unique
)
if ($confirmedPids.Count -ne 1 -or [int]$confirmedPids[0] -ne $ownerPid) {
  Write-Failure "Il listener è cambiato durante la verifica; avvio annullato."
  exit 22
}

$confirmedOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid"
if (
  $null -eq $confirmedOwner -or
  $confirmedOwner.CreationDate -ne $owner.CreationDate -or
  $confirmedOwner.CommandLine -cne $owner.CommandLine
) {
  Write-Failure "Il processo proprietario è cambiato durante la verifica; avvio annullato."
  exit 22
}

$normalizedProbeHost = $HostAddress.Trim().TrimStart('[').TrimEnd(']')
if ($normalizedProbeHost -eq '0.0.0.0') {
  $normalizedProbeHost = '127.0.0.1'
} elseif ($normalizedProbeHost -eq '::') {
  $normalizedProbeHost = '::1'
}
$probeHost = if ($normalizedProbeHost.Contains(':')) {
  "[$normalizedProbeHost]"
} else {
  $normalizedProbeHost
}
$healthUri = "http://${probeHost}:$Port/api/health"

try {
  $health = Invoke-RestMethod `
    -Uri $healthUri `
    -Method Get `
    -TimeoutSec 3 `
    -ErrorAction Stop
  if ($health.bridge.status -eq 'online') {
    Write-Output (
      "[H3 Studio] Bridge del progetto già attivo (PID $ownerPid): riuso " +
      "l'istanza esistente."
    )
    # Exit 25 is an intentional launcher contract: keep this healthy bridge.
    exit 25
  }
} catch {
  Write-Output (
    "[H3 Studio] Il bridge PID $ownerPid non risponde correttamente; " +
    "verrà sostituito."
  )
}

Write-Output "[H3 Studio] Arresto bridge precedente PID $ownerPid..."
try {
  Stop-Process -Id $ownerPid -Force -ErrorAction Stop
} catch {
  Write-Failure "Impossibile arrestare il bridge PID $ownerPid. $($_.Exception.Message)"
  exit 23
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Milliseconds 100
  $remainingListeners = @(Get-BridgeListener)
  if ($remainingListeners.Count -eq 0) {
    Write-Output "[H3 Studio] Porta ${HostAddress}:$Port liberata."
    exit 0
  }
} while ([DateTime]::UtcNow -lt $deadline)

Write-Failure "La porta ${HostAddress}:$Port non si è liberata entro $TimeoutSeconds secondi."
exit 24
