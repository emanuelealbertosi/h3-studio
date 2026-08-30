param(
    [string]$ModelRoot = "H:\H3-Studio-Models",
    [int]$WaitForPid = 0
)

$ErrorActionPreference = "Stop"

if ($WaitForPid -gt 0) {
    $existing = Get-Process -Id $WaitForPid -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[LTX 2.5] Attendo il download RedGraft PID $WaitForPid..."
        Wait-Process -Id $WaitForPid
    }
}

$downloads = @(
    @{
        Folder = "text_encoders"
        Name = "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
        Size = 15372969374L
    },
    @{
        Folder = "vae"
        Name = "ltx-2.5-video-vae-conv-bf16.safetensors"
        Size = 1452269922L
    },
    @{
        Folder = "vae"
        Name = "ltx-2.5-audio-vae-bf16.safetensors"
        Size = 364866540L
    }
)

foreach ($item in $downloads) {
    $directory = Join-Path $ModelRoot $item.Folder
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $destination = Join-Path $directory $item.Name
    $url = "https://huggingface.co/PulpCut/LTX-2.5-INT8-ConvRot-safetensors/resolve/main/$($item.Folder)/$($item.Name)"
    if ((Test-Path -LiteralPath $destination) -and (Get-Item -LiteralPath $destination).Length -eq $item.Size) {
        Write-Host "[LTX 2.5] Presente: $($item.Name)"
        continue
    }
    Write-Host "[LTX 2.5] Download: $($item.Name)"
    & curl.exe -L --fail --retry 8 --retry-delay 5 -C - -o $destination $url
    if ($LASTEXITCODE -ne 0) { throw "Download fallito: $($item.Name)" }
    $actual = (Get-Item -LiteralPath $destination).Length
    if ($actual -ne $item.Size) {
        throw "Dimensione non valida per $($item.Name): $actual invece di $($item.Size) byte"
    }
}

Write-Host "[LTX 2.5] Encoder e VAE completati. Riavvia ComfyUI per aggiornare l'elenco modelli."
