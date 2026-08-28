param(
  [string]$Root = "",
  [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Root) {
  $Root = Join-Path $projectRoot "data\runtimes\audio-cpp"
}
$Root = [System.IO.Path]::GetFullPath($Root)
$downloadDir = Join-Path $Root "downloads"
$modelRoot = Join-Path $Root "models"
$logPath = Join-Path $Root "install.log"

New-Item -ItemType Directory -Force -Path $Root, $downloadDir, $modelRoot | Out-Null

function Write-InstallLog([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Get-ResumableFile {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][long]$MinimumBytes
  )
  if ((Test-Path -LiteralPath $Target) -and (Get-Item -LiteralPath $Target).Length -ge $MinimumBytes) {
    Write-InstallLog "Gia presente: $Target"
    return
  }
  $partial = "$Target.part"
  Write-InstallLog "Download: $Url"
  $arguments = @("-L", "--fail", "--retry", "10", "--retry-delay", "5", "--connect-timeout", "30")
  if ((Test-Path -LiteralPath $partial) -and (Get-Item -LiteralPath $partial).Length -gt 0) {
    $arguments += @("-C", "-")
    Write-InstallLog "Ripresa da $((Get-Item -LiteralPath $partial).Length) byte"
  }
  $arguments += @("-o", $partial, $Url)
  & curl.exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "Download fallito con codice ${LASTEXITCODE}: $Url" }
  if ((Get-Item -LiteralPath $partial).Length -lt $MinimumBytes) {
    throw "File incompleto: $partial"
  }
  Move-Item -LiteralPath $partial -Destination $Target -Force
}

function Expand-AudioPackage([string]$Archive) {
  $stage = Join-Path $downloadDir ([System.IO.Path]::GetFileNameWithoutExtension($Archive))
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $stage -Force
  Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
    $_.Extension -in @(".exe", ".dll", ".json")
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Root $_.Name) -Force
  }
  Remove-Item -LiteralPath $stage -Recurse -Force
}

$release = "v0.7.0"
$baseRelease = "https://github.com/0xShug0/audio.cpp/releases/download/$release"
if ($CpuOnly) {
  $binaryName = "audio-v0.7.0-bin-windows-x64-cpu.zip"
  $runtimeName = $null
} else {
  $binaryName = "audio-v0.7.0-bin-windows-x64-cuda13.3.zip"
  $runtimeName = "audio-v0.7.0-cudart-windows-x64-cuda13.3.zip"
}

Write-InstallLog "Installazione audio.cpp $release in $Root"
$binaryArchive = Join-Path $downloadDir $binaryName
Get-ResumableFile -Url "$baseRelease/$binaryName" -Target $binaryArchive -MinimumBytes 10MB
Expand-AudioPackage $binaryArchive
if ($runtimeName) {
  $runtimeArchive = Join-Path $downloadDir $runtimeName
  Get-ResumableFile -Url "$baseRelease/$runtimeName" -Target $runtimeArchive -MinimumBytes 100MB
  Expand-AudioPackage $runtimeArchive
}

$separatorDir = Join-Path $modelRoot "BS-RoFormer-ep368-GGUF"
$seedVcDir = Join-Path $modelRoot "SeedVC-MLX-GGUF"
New-Item -ItemType Directory -Force -Path $separatorDir, $seedVcDir | Out-Null
$separatorModel = Join-Path $separatorDir "bs-roformer-ep368-q8_0.gguf"
$seedVcModel = Join-Path $seedVcDir "seed-vc-mlx-q8_0.gguf"
Get-ResumableFile -Url "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/BS-RoFormer-ep368-GGUF/bs-roformer-ep368-q8_0.gguf?download=true" -Target $separatorModel -MinimumBytes 150MB
Get-ResumableFile -Url "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/SeedVC-MLX-GGUF/seed-vc-mlx-q8_0.gguf?download=true" -Target $seedVcModel -MinimumBytes 2GB

$cli = Join-Path $Root "audiocpp_cli.exe"
if (-not (Test-Path -LiteralPath $cli)) { throw "audiocpp_cli.exe non trovato dopo l'estrazione" }
Write-InstallLog "Verifica del runtime"
& $cli --help | Select-Object -First 5 | ForEach-Object { Write-InstallLog $_ }
if ($LASTEXITCODE -ne 0) { throw "audiocpp_cli.exe non si avvia correttamente" }

Write-InstallLog "Installazione completata. Riavvia H3 Studio e controlla Admin > audio.cpp - Seed-VC."
