import asyncio
import base64
import io
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

import folder_paths

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None


_LOCK = threading.RLock()
_SERVER_PROCESS = None
_SERVER_KEY = None
_SERVER_PORT = None
_SERVER_LOG_HANDLE = None
_SERVER_LOG_PATH = None
_RUNTIME_CACHE = None


def _version_key(path):
    numbers = tuple(int(part) for part in re.findall(r"\d+", str(path.parent.name)))
    cuda12 = 1 if "cuda12" in str(path.parent).lower() else 0
    return (cuda12, numbers, path.stat().st_mtime)


def _find_llama_server():
    global _RUNTIME_CACHE
    if _RUNTIME_CACHE and os.path.isfile(_RUNTIME_CACHE):
        return _RUNTIME_CACHE
    candidates = []
    configured = os.environ.get("H3_CHAT_LLAMA_SERVER", "").strip()
    if configured:
        candidates.append(Path(configured))
    candidates.extend([
        Path(__file__).resolve().parent / "runtime" / "llama-server.exe",
        Path(__file__).resolve().parent / "runtime" / "llama-server",
    ])
    on_path = shutil.which("llama-server") or shutil.which("llama-server.exe")
    if on_path:
        candidates.append(Path(on_path))
    lm_backends = Path.home() / ".lmstudio" / "extensions" / "backends"
    if lm_backends.is_dir():
        candidates.extend(lm_backends.glob("llama.cpp-win-x86_64-nvidia-cuda12-avx2-*/llama-server.exe"))
        candidates.extend(lm_backends.glob("llama.cpp-win-x86_64-nvidia-cuda-avx2-*/llama-server.exe"))
        candidates.extend(lm_backends.glob("llama.cpp-win-x86_64-avx2-*/llama-server.exe"))
    usable = [candidate.resolve() for candidate in candidates if candidate.is_file()]
    if not usable:
        raise RuntimeError(
            "llama-server non trovato. Installa il runtime llama.cpp di LM Studio oppure imposta "
            "H3_CHAT_LLAMA_SERVER con il percorso dell'eseguibile."
        )
    usable.sort(key=_version_key, reverse=True)
    _RUNTIME_CACHE = str(usable[0])
    return _RUNTIME_CACHE


def _runtime_status():
    try:
        executable = _find_llama_server()
        version = "unknown"
        try:
            completed = subprocess.run(
                [executable, "--version"],
                cwd=os.path.dirname(executable),
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            first = (completed.stdout or completed.stderr or "").strip().splitlines()
            if first:
                version = first[0][:160]
        except Exception:
            pass
        return None, version, executable
    except Exception as exc:
        return str(exc), None, None


def _llm_roots():
    try:
        roots = folder_paths.get_folder_paths("llm")
    except Exception:
        roots = []
    return [os.path.realpath(root) for root in roots if root]


def _safe_llm_path(relative, *, projector=False):
    value = str(relative or "").strip().replace("/", os.sep)
    if not value or os.path.isabs(value) or ".." in Path(value).parts:
        raise ValueError("Invalid relative LLM path")
    lower = value.lower()
    if not lower.endswith(".gguf"):
        raise ValueError("The Chat model must be a GGUF file")
    if projector != ("mmproj" in lower):
        raise ValueError("Model and mmproj files were assigned to the wrong fields")
    for root in _llm_roots():
        candidate = os.path.realpath(os.path.join(root, value))
        try:
            inside = os.path.commonpath([root, candidate]) == root
        except ValueError:
            inside = False
        if inside and os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError("LLM file not found in ComfyUI models/llm: " + value)


def _annotated_image_path(value):
    annotated = str(value or "").strip()
    if not annotated or len(annotated) > 1024:
        raise ValueError("Invalid Chat attachment")
    clean = annotated
    for suffix in (" [input]", " [output]", " [temp]"):
        if clean.lower().endswith(suffix):
            clean = clean[:-len(suffix)]
            break
    if os.path.isabs(clean) or ".." in Path(clean.replace("/", os.sep)).parts:
        raise ValueError("Absolute Chat attachment paths are not allowed")
    path = folder_paths.get_annotated_filepath(annotated)
    if not path or not os.path.isfile(path):
        raise FileNotFoundError("Chat image not found: " + annotated)
    return path


def _data_url(path):
    with Image.open(path) as opened:
        image = opened.convert("RGB")
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=88, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _server_running():
    return _SERVER_PROCESS is not None and _SERVER_PROCESS.poll() is None


def _release_server():
    global _SERVER_PROCESS, _SERVER_KEY, _SERVER_PORT, _SERVER_LOG_HANDLE, _SERVER_LOG_PATH
    with _LOCK:
        process = _SERVER_PROCESS
        _SERVER_PROCESS = None
        _SERVER_KEY = None
        _SERVER_PORT = None
        if process is not None and process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=12)
            except Exception:
                try:
                    process.kill()
                    process.wait(timeout=5)
                except Exception:
                    pass
        if _SERVER_LOG_HANDLE is not None:
            try:
                _SERVER_LOG_HANDLE.close()
            except Exception:
                pass
        _SERVER_LOG_HANDLE = None
        _SERVER_LOG_PATH = None


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _http_json(url, payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="GET" if payload is None else "POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"llama-server HTTP {exc.code}: {detail[:1000]}") from exc


def _log_tail():
    if not _SERVER_LOG_PATH or not os.path.isfile(_SERVER_LOG_PATH):
        return ""
    try:
        with open(_SERVER_LOG_PATH, "r", encoding="utf-8", errors="replace") as stream:
            return "\n".join(stream.read().splitlines()[-30:])
    except Exception:
        return ""


def _load_server(model_path, mmproj_path, n_ctx, n_gpu_layers, n_threads):
    global _SERVER_PROCESS, _SERVER_KEY, _SERVER_PORT, _SERVER_LOG_HANDLE, _SERVER_LOG_PATH
    executable = _find_llama_server()
    key = (executable, model_path, mmproj_path, n_ctx, n_gpu_layers, n_threads)
    if _server_running() and _SERVER_KEY == key:
        return _SERVER_PORT
    _release_server()
    try:
        import comfy.model_management as model_management
        model_management.unload_all_models()
        model_management.soft_empty_cache()
    except Exception:
        pass
    port = _free_port()
    log_dir = Path(folder_paths.get_temp_directory()) / "h3_studio_chat"
    log_dir.mkdir(parents=True, exist_ok=True)
    _SERVER_LOG_PATH = str(log_dir / "llama-server.log")
    _SERVER_LOG_HANDLE = open(_SERVER_LOG_PATH, "w", encoding="utf-8", errors="replace")
    args = [
        executable,
        "-m", model_path,
        "-mm", mmproj_path,
        "--host", "127.0.0.1",
        "--port", str(port),
        "-c", str(n_ctx),
        "-ngl", "all" if n_gpu_layers < 0 else str(n_gpu_layers),
        "-t", str(n_threads),
        "-np", "1",
        "--no-webui",
        "--reasoning", "off",
        "--log-colors", "off",
        "--timeout", "900",
    ]
    _SERVER_PROCESS = subprocess.Popen(
        args,
        cwd=os.path.dirname(executable),
        stdin=subprocess.DEVNULL,
        stdout=_SERVER_LOG_HANDLE,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    _SERVER_KEY = key
    _SERVER_PORT = port
    deadline = time.monotonic() + 240
    last_error = ""
    while time.monotonic() < deadline:
        if _SERVER_PROCESS.poll() is not None:
            tail = _log_tail()
            _release_server()
            raise RuntimeError("llama-server exited during model load.\n" + tail)
        try:
            health = _http_json(f"http://127.0.0.1:{port}/health", timeout=3)
            if health.get("status") == "ok":
                return port
        except Exception as exc:
            last_error = str(exc)
        time.sleep(1)
    tail = _log_tail()
    _release_server()
    raise RuntimeError("Timed out while loading the vision LLM: " + last_error + "\n" + tail)


def _normalize_messages(messages, image_files):
    if not isinstance(messages, list) or not messages:
        raise ValueError("Chat messages must be a non-empty array")
    result = []
    for item in messages[-24:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role in ("system", "user", "assistant") and content:
            result.append({"role": role, "content": content[:20000]})
    if not result or result[-1]["role"] != "user":
        raise ValueError("The last Chat message must come from the user")
    if image_files:
        content = [{"type": "text", "text": result[-1]["content"]}]
        content.extend(
            {"type": "image_url", "image_url": {"url": _data_url(_annotated_image_path(file))}}
            for file in image_files[:4]
        )
        result[-1] = {"role": "user", "content": content}
    return result


def _run_chat(body):
    model_path = _safe_llm_path(body.get("model"), projector=False)
    mmproj_path = _safe_llm_path(body.get("projector"), projector=True)
    n_ctx = min(262144, max(2048, int(body.get("n_ctx") or 16384)))
    n_gpu_layers = min(200, max(-1, int(body.get("n_gpu_layers", -1))))
    n_threads = min(128, max(1, int(body.get("n_threads") or 8)))
    max_tokens = min(8192, max(128, int(body.get("max_tokens") or 1536)))
    temperature = min(2.0, max(0.0, float(body.get("temperature", 0.35))))
    top_p = min(1.0, max(0.01, float(body.get("top_p", 0.9))))
    image_files = body.get("images") if isinstance(body.get("images"), list) else []
    messages = _normalize_messages(body.get("messages"), image_files)
    with _LOCK:
        port = _load_server(model_path, mmproj_path, n_ctx, n_gpu_layers, n_threads)
        response = _http_json(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            {
                "messages": messages,
                "temperature": temperature,
                "top_p": top_p,
                "max_tokens": max_tokens,
                "stream": False,
            },
            timeout=900,
        )
    choices = response.get("choices") if isinstance(response, dict) else None
    message = choices[0].get("message") if choices and isinstance(choices[0], dict) else None
    text = message.get("content") if isinstance(message, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("The LLM returned an empty Chat response")
    return {"ok": True, "text": text.strip(), "model": os.path.basename(model_path)}


class H3StudioGemma4VisionChat:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"note": ("STRING", {"default": "Managed by H3 Studio Chat API"})}}

    RETURN_TYPES = ("STRING",)
    FUNCTION = "info"
    CATEGORY = "H3 Studio/Chat"

    def info(self, note):
        return (note,)


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None and web is not None:
    routes = PromptServer.instance.routes

    @routes.get("/h3_studio/chat/status")
    async def h3_chat_status(_request):
        error, version, executable = _runtime_status()
        models = []
        projectors = []
        for root in _llm_roots():
            if not os.path.isdir(root):
                continue
            for dirpath, _, filenames in os.walk(root):
                for filename in filenames:
                    low = filename.lower()
                    if not low.endswith(".gguf"):
                        continue
                    rel = os.path.relpath(os.path.join(dirpath, filename), root).replace("/", os.sep)
                    if "mmproj" in low:
                        projectors.append(rel)
                    else:
                        models.append(rel)
        return web.json_response({
            "ok": error is None,
            "ready": error is None and bool(models) and bool(projectors),
            "loaded": _server_running(),
            "backend": "llama-server",
            "runtimeVersion": version,
            "runtimePath": executable,
            "error": error,
            "models": sorted(set(models), key=str.lower),
            "projectors": sorted(set(projectors), key=str.lower),
        })

    @routes.post("/h3_studio/chat")
    async def h3_chat(request):
        try:
            body = await request.json()
            result = await asyncio.to_thread(_run_chat, body)
            return web.json_response(result)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.post("/h3_studio/chat/unload")
    async def h3_chat_unload(_request):
        await asyncio.to_thread(_release_server)
        return web.json_response({"ok": True, "loaded": False})


NODE_CLASS_MAPPINGS = {"H3StudioGemma4VisionChat": H3StudioGemma4VisionChat}
NODE_DISPLAY_NAME_MAPPINGS = {"H3StudioGemma4VisionChat": "H3 Studio · Local Vision LLM"}
