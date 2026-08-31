[CmdletBinding()]
param(
  [string]$ComfyRoot = "",
  [switch]$SkipExternalNodes,
  [switch]$InstallPythonRequirements,
  [string]$PythonPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ComfyRoot) {
  $ComfyRoot = Read-Host "Percorso della cartella ComfyUI (quella che contiene main.py)"
}

$resolvedRoot = [System.IO.Path]::GetFullPath($ComfyRoot.Trim('"'))
if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot "main.py") -PathType Leaf)) {
  throw "La cartella indicata non contiene main.py: $resolvedRoot"
}

$customNodes = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot "custom_nodes"))
if (-not $customNodes.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Percorso custom_nodes non sicuro: $customNodes"
}
New-Item -ItemType Directory -Force -Path $customNodes | Out-Null

$projectRoot = Split-Path -Parent $PSScriptRoot
$bundledH3 = Join-Path $projectRoot "comfyui_nodes\ComfyUI-H3-Multishot"
$targetH3 = Join-Path $customNodes "ComfyUI-H3-Multishot"
if (-not (Test-Path -LiteralPath (Join-Path $bundledH3 "__init__.py") -PathType Leaf)) {
  throw "Pacchetto H3 Studio incluso non trovato: $bundledH3"
}

if (Test-Path -LiteralPath $targetH3 -PathType Container) {
  $backupRoot = Join-Path $customNodes "_h3_studio_backups"
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $archive = Join-Path $backupRoot ("ComfyUI-H3-Multishot-" + $stamp + ".zip")
  Compress-Archive -LiteralPath $targetH3 -DestinationPath $archive -CompressionLevel Fastest
  Write-Host "Backup nodo H3 esistente: $archive" -ForegroundColor Yellow
} else {
  New-Item -ItemType Directory -Force -Path $targetH3 | Out-Null
}

Copy-Item -Path (Join-Path $bundledH3 "*") -Destination $targetH3 -Recurse -Force
Write-Host "Installato H3 Studio node pack -> $targetH3" -ForegroundColor Green

$bundledChat = Join-Path $projectRoot "comfyui_nodes\H3-Studio-Gemma4-Chat"
$targetChat = Join-Path $customNodes "H3-Studio-Gemma4-Chat"
if (-not (Test-Path -LiteralPath (Join-Path $bundledChat "__init__.py") -PathType Leaf)) {
  throw "Pacchetto Chat H3 Studio incluso non trovato: $bundledChat"
}
if (Test-Path -LiteralPath $targetChat -PathType Container) {
  $backupRoot = Join-Path $customNodes "_h3_studio_backups"
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $archive = Join-Path $backupRoot ("H3-Studio-Gemma4-Chat-" + $stamp + ".zip")
  Compress-Archive -LiteralPath $targetChat -DestinationPath $archive -CompressionLevel Fastest
  Write-Host "Backup nodo Chat esistente: $archive" -ForegroundColor Yellow
} else {
  New-Item -ItemType Directory -Force -Path $targetChat | Out-Null
}
Copy-Item -Path (Join-Path $bundledChat "*") -Destination $targetChat -Recurse -Force
Write-Host "Installato H3 Studio LLM Chat -> $targetChat" -ForegroundColor Green

$installedRepos = [System.Collections.Generic.List[string]]::new()

function Install-GitRepository {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url
  )
  $target = Join-Path $customNodes $Name
  if (Test-Path -LiteralPath $target -PathType Container) {
    Write-Host "Gia presente: $Name" -ForegroundColor DarkGray
    $installedRepos.Add($target)
    return
  }
  Write-Host "Clono $Name..."
  & git clone --depth 1 $Url $target
  if ($LASTEXITCODE -ne 0) {
    throw "Clone fallito: $Url"
  }
  $installedRepos.Add($target)
}

if (-not $SkipExternalNodes) {
  & git --version | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Git non e disponibile nel PATH. Installa Git oppure usa -SkipExternalNodes."
  }

  $repositories = @(
    @{ Name = "ComfyUI-Fantastic-MiniMaxH3-PromptBuilder"; Url = "https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder.git" },
    @{ Name = "ComfyUI-DaSiWa-Nodes"; Url = "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes.git" },
    @{ Name = "rgthree-comfy"; Url = "https://github.com/rgthree/rgthree-comfy.git" },
    @{ Name = "ComfyUI-KJNodes"; Url = "https://github.com/kijai/ComfyUI-KJNodes.git" },
    @{ Name = "ComfyUI-VideoHelperSuite"; Url = "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git" },
    @{ Name = "Rebalance-Pack"; Url = "https://github.com/nova452/Rebalance-Pack.git" },
    @{ Name = "ComfyUI-H3-FaceRefine"; Url = "https://github.com/Carasibana/ComfyUI-H3-FaceRefine.git" },
    @{ Name = "Comfyui_Minimax_h3_latent_Upscaler"; Url = "https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git" }
  )
  foreach ($repo in $repositories) {
    Install-GitRepository -Name $repo.Name -Url $repo.Url
  }

  $sourceRoot = Join-Path $customNodes "_h3_studio_sources"
  New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
  $nativeRepo = Join-Path $sourceRoot "MiniMax-H3-NativeAudio-MusicVideo-Workflow"
  if (-not (Test-Path -LiteralPath $nativeRepo -PathType Container)) {
    & git clone --depth 1 "https://github.com/Shrek3OnVH5/MiniMax-H3-NativeAudio-MusicVideo-Workflow.git" $nativeRepo
    if ($LASTEXITCODE -ne 0) {
      throw "Clone fallito: MiniMax-H3-NativeAudio-MusicVideo-Workflow"
    }
  }
  $nativeSource = Join-Path $nativeRepo "custom_nodes\ComfyUI-H3-NativeAudioLock"
  $nativeTarget = Join-Path $customNodes "ComfyUI-H3-NativeAudioLock"
  if (-not (Test-Path -LiteralPath (Join-Path $nativeSource "__init__.py") -PathType Leaf)) {
    throw "NativeAudioLock non trovato nel repository sorgente."
  }
  New-Item -ItemType Directory -Force -Path $nativeTarget | Out-Null
  Copy-Item -Path (Join-Path $nativeSource "*") -Destination $nativeTarget -Recurse -Force
  $installedRepos.Add($nativeTarget)
  Write-Host "Installato ComfyUI-H3-NativeAudioLock" -ForegroundColor Green
}

if ($InstallPythonRequirements) {
  if (-not $PythonPath) {
    $portablePython = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot "..\python_embeded\python.exe"))
    $venvPython = Join-Path $resolvedRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $portablePython -PathType Leaf) {
      $PythonPath = $portablePython
    } elseif (Test-Path -LiteralPath $venvPython -PathType Leaf) {
      $PythonPath = $venvPython
    } else {
      throw "Python ComfyUI non rilevato. Passa -PythonPath con il python.exe corretto."
    }
  }
  foreach ($repoPath in $installedRepos) {
    $requirements = Join-Path $repoPath "requirements.txt"
    if (Test-Path -LiteralPath $requirements -PathType Leaf) {
      Write-Host "Installo requirements: $requirements"
      & $PythonPath -m pip install -r $requirements
      if ($LASTEXITCODE -ne 0) {
        throw "Installazione requirements fallita: $requirements"
      }
    }
  }
}

Write-Host ""
Write-Host "Nodi predisposti. Riavvia ComfyUI, poi apri Admin > Installazione in H3 Studio." -ForegroundColor Green
Write-Host "I pesi non vengono scaricati automaticamente: la checklist Admin indica nome e cartella esatti."
if (-not $InstallPythonRequirements) {
  Write-Host "Per eventuali requirements usa ComfyUI Manager oppure rilancia con -InstallPythonRequirements." -ForegroundColor Yellow
}
