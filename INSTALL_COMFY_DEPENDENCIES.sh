#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
COMFY_ROOT=""; PYTHON_PATH=""; SKIP_EXTERNAL=0; INSTALL_REQUIREMENTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --comfy-root) COMFY_ROOT="${2:-}"; shift 2 ;;
    --python) PYTHON_PATH="${2:-}"; shift 2 ;;
    --skip-external-nodes) SKIP_EXTERNAL=1; shift ;;
    --install-python-requirements) INSTALL_REQUIREMENTS=1; shift ;;
    -h|--help) printf 'Uso: %s [--comfy-root PATH] [--skip-external-nodes] [--install-python-requirements] [--python PATH]\n' "$0"; exit 0 ;;
    *) printf '[ERRORE] Argomento sconosciuto: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$COMFY_ROOT" ]]; then read -r -p 'Cartella ComfyUI (contiene main.py): ' COMFY_ROOT; fi
COMFY_ROOT="$(realpath -m -- "$COMFY_ROOT")"
[[ -f "$COMFY_ROOT/main.py" ]] || { printf '[ERRORE] main.py non trovato in %s\n' "$COMFY_ROOT" >&2; exit 1; }
CUSTOM_NODES="$(realpath -m -- "$COMFY_ROOT/custom_nodes")"
case "$CUSTOM_NODES/" in "$COMFY_ROOT/"*) ;; *) printf '[ERRORE] Percorso custom_nodes non sicuro.\n' >&2; exit 1 ;; esac
mkdir -p "$CUSTOM_NODES" "$CUSTOM_NODES/_h3_studio_backups"

backup_and_copy() {
  local source="$1" name="$2" target="$CUSTOM_NODES/$2" stamp archive
  [[ -f "$source/__init__.py" ]] || { printf '[ERRORE] Nodo incluso non trovato: %s\n' "$source" >&2; exit 1; }
  if [[ -d "$target" ]]; then
    stamp="$(date -u +%Y%m%d-%H%M%S)"; archive="$CUSTOM_NODES/_h3_studio_backups/${name}-${stamp}.tar.gz"
    tar -C "$CUSTOM_NODES" -czf "$archive" "$name"
    printf '[H3 Studio] Backup: %s\n' "$archive"
  fi
  mkdir -p "$target"; cp -a "$source/." "$target/"
  printf '[H3 Studio] Installato %s -> %s\n' "$name" "$target"
}

backup_and_copy "$ROOT/comfyui_nodes/ComfyUI-H3-Multishot" "ComfyUI-H3-Multishot"
backup_and_copy "$ROOT/comfyui_nodes/H3-Studio-Gemma4-Chat" "H3-Studio-Gemma4-Chat"

INSTALLED=("$CUSTOM_NODES/ComfyUI-H3-Multishot" "$CUSTOM_NODES/H3-Studio-Gemma4-Chat")
clone_if_missing() {
  local name="$1" url="$2" target="$CUSTOM_NODES/$1"
  if [[ -d "$target" ]]; then printf '[H3 Studio] Già presente: %s\n' "$name"; else git clone --depth 1 "$url" "$target"; fi
  INSTALLED+=("$target")
}

if [[ $SKIP_EXTERNAL -eq 0 ]]; then
  command -v git >/dev/null 2>&1 || { printf '[ERRORE] Git non disponibile.\n' >&2; exit 1; }
  clone_if_missing ComfyUI-Fantastic-MiniMaxH3-PromptBuilder https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder.git
  clone_if_missing ComfyUI-DaSiWa-Nodes https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes.git
  clone_if_missing rgthree-comfy https://github.com/rgthree/rgthree-comfy.git
  clone_if_missing ComfyUI-KJNodes https://github.com/kijai/ComfyUI-KJNodes.git
  clone_if_missing ComfyUI-VideoHelperSuite https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git
  clone_if_missing ComfyUI-MiniMax-H3-PDD-Acc https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc.git
  clone_if_missing Rebalance-Pack https://github.com/nova452/Rebalance-Pack.git
  clone_if_missing ComfyUI-H3-FaceRefine https://github.com/Carasibana/ComfyUI-H3-FaceRefine.git
  clone_if_missing Comfyui_Minimax_h3_latent_Upscaler https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git
  SOURCE_ROOT="$CUSTOM_NODES/_h3_studio_sources"; mkdir -p "$SOURCE_ROOT"
  NATIVE_REPO="$SOURCE_ROOT/MiniMax-H3-NativeAudio-MusicVideo-Workflow"
  [[ -d "$NATIVE_REPO" ]] || git clone --depth 1 https://github.com/Shrek3OnVH5/MiniMax-H3-NativeAudio-MusicVideo-Workflow.git "$NATIVE_REPO"
  NATIVE_SOURCE="$NATIVE_REPO/custom_nodes/ComfyUI-H3-NativeAudioLock"
  [[ -f "$NATIVE_SOURCE/__init__.py" ]] || { printf '[ERRORE] NativeAudioLock non trovato.\n' >&2; exit 1; }
  mkdir -p "$CUSTOM_NODES/ComfyUI-H3-NativeAudioLock"; cp -a "$NATIVE_SOURCE/." "$CUSTOM_NODES/ComfyUI-H3-NativeAudioLock/"
  INSTALLED+=("$CUSTOM_NODES/ComfyUI-H3-NativeAudioLock")
fi

if [[ $INSTALL_REQUIREMENTS -eq 1 ]]; then
  if [[ -z "$PYTHON_PATH" ]]; then
    for candidate in "$COMFY_ROOT/.venv/bin/python" "$COMFY_ROOT/venv/bin/python"; do [[ -x "$candidate" ]] && PYTHON_PATH="$candidate" && break; done
  fi
  [[ -n "$PYTHON_PATH" && -x "$PYTHON_PATH" ]] || { printf '[ERRORE] Python ComfyUI non rilevato: usa --python /percorso/python.\n' >&2; exit 1; }
  for repo in "${INSTALLED[@]}"; do [[ -f "$repo/requirements.txt" ]] && "$PYTHON_PATH" -m pip install -r "$repo/requirements.txt"; done
fi

printf '\nNodi predisposti. Riavvia ComfyUI e apri Admin > Installazione.\n'
printf 'I pesi non vengono scaricati automaticamente.\n'
