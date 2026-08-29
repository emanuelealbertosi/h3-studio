[CmdletBinding()]
param(
  [string]$LocalAddress = ""
)

$ErrorActionPreference = "Stop"
$ruleName = "H3 Studio LAN 3000-8787"

if ([string]::IsNullOrWhiteSpace($LocalAddress)) {
  $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" |
    Where-Object { $_.InterfaceAlias -notmatch "Tailscale|VirtualBox|VMware" } |
    Sort-Object RouteMetric, InterfaceMetric |
    Select-Object -First 1
  if (-not $route) {
    throw "Impossibile individuare l'interfaccia LAN predefinita."
  }
  $LocalAddress = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex |
    Where-Object { $_.AddressState -eq "Preferred" -and $_.IPAddress -notmatch "^127\." } |
    Select-Object -ExpandProperty IPAddress -First 1
}

$parsedAddress = $null
if (
  -not [Net.IPAddress]::TryParse($LocalAddress, [ref]$parsedAddress) -or
  $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
  $LocalAddress -eq "0.0.0.0" -or
  $LocalAddress -match "^127\."
) {
  throw "Indirizzo IPv4 LAN non valido: $LocalAddress"
}

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Description "H3 Studio frontend and bridge; local subnet only" `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Public,Private `
  -Protocol TCP `
  -LocalAddress $LocalAddress `
  -LocalPort 3000,8787 `
  -RemoteAddress LocalSubnet |
  Out-Null

Write-Host ""
Write-Host "H3 Studio LAN abilitato su http://${LocalAddress}:3000" -ForegroundColor Green
Write-Host "Porte consentite: TCP 3000 e 8787; origine: subnet locale." -ForegroundColor Green
