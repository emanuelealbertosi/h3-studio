import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type LoraCatalogEntry = {
  name: string;
  family: string;
  prefix: string;
  baseModel: string | null;
  modelName: string | null;
  versionName: string | null;
  source: "civitai" | "sidecar" | "filename" | "unknown";
  modelId: number | null;
  modelVersionId: number | null;
};

type StoredFile = LoraCatalogEntry & {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
};

type StoredCatalog = {
  version: 1;
  updatedAt: string;
  roots: string[];
  files: StoredFile[];
};

type CivitaiVersion = {
  id?: unknown;
  modelId?: unknown;
  name?: unknown;
  baseModel?: unknown;
  model?: { name?: unknown };
  files?: Array<{ hashes?: { SHA256?: unknown } }>;
};

const MODEL_EXTENSIONS = new Set([".safetensors", ".pt", ".ckpt"]);

function cleanYamlValue(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function normalizeRelative(value: string) {
  return value.split(/[\\/]+/).filter(Boolean).join("\\");
}

function familyFromText(value: string | null | undefined) {
  const text = (value ?? "").toLocaleLowerCase("en-US");
  if (/minimax|maximin.*r2v|(?:^|[_ -])h3(?:[_ -]|$)|hunyuan.?video.?1\.5/.test(text)) return "H3";
  if (/illustrious|\billu\b|\[ill\]|\bilxl\b|igilxl/.test(text)) return "ILLU";
  if (/noobai|noob.?ai/.test(text)) return "NOOBAI";
  if (/anima/.test(text)) return "ANIMA";
  if (/qwen/.test(text)) return "QWEN";
  if (/ltx/.test(text)) return "LTX";
  if (/wan\s*2|wan2/.test(text)) return "WAN";
  if (/krea/.test(text)) return "KREA";
  if (/klein/.test(text)) return "KLEIN";
  if (/flux/.test(text)) return "FLUX";
  if (/pony/.test(text)) return "PONY";
  if (/sdxl|stable.?diffusion.?xl/.test(text)) return "SDXL";
  if (/sd.?1[._ -]?5|stable.?diffusion.?1[._ -]?5/.test(text)) return "SD15";
  if (/zimage|z.?image/.test(text)) return "ZIMAGE";
  return "?";
}

function catalogEntry(
  name: string,
  version: CivitaiVersion | null,
  source: LoraCatalogEntry["source"],
): LoraCatalogEntry {
  const baseModel = typeof version?.baseModel === "string" ? version.baseModel.trim() : null;
  const modelName = typeof version?.model?.name === "string" ? version.model.name.trim() : null;
  const versionName = typeof version?.name === "string" ? version.name.trim() : null;
  const family = familyFromText(baseModel)
    .replace("?", familyFromText(`${modelName ?? ""} ${name}`));
  return {
    name,
    family,
    prefix: family,
    baseModel,
    modelName,
    versionName,
    source: family === "?" && !version ? "unknown" : source,
    modelId: typeof version?.modelId === "number" ? version.modelId : null,
    modelVersionId: typeof version?.id === "number" ? version.id : null,
  };
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function walkModels(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string) => {
    const items = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const target = path.join(directory, item.name);
      if (item.isDirectory()) await visit(target);
      else if (item.isFile() && MODEL_EXTENSIONS.has(path.extname(item.name).toLocaleLowerCase("en-US"))) {
        output.push(target);
      }
    }
  };
  if (await exists(root)) await visit(root);
  return output;
}

async function sha256(target: string) {
  const sidecar = target.replace(/\.[^.]+$/, ".sha256");
  if (await exists(sidecar)) {
    const value = (await readFile(sidecar, "utf8")).trim().split(/\s+/)[0]?.toUpperCase();
    if (/^[A-F0-9]{64}$/.test(value ?? "")) return value!;
  }
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

async function readSidecar(target: string): Promise<CivitaiVersion | null> {
  const sidecar = target.replace(/\.[^.]+$/, ".civitai.info");
  if (!(await exists(sidecar))) return null;
  try {
    return JSON.parse(await readFile(sidecar, "utf8")) as CivitaiVersion;
  } catch {
    return null;
  }
}

function hashesFromVersion(version: CivitaiVersion) {
  return new Set(
    (version.files ?? []).flatMap((file) => {
      const hash = file.hashes?.SHA256;
      return typeof hash === "string" ? [hash.toUpperCase()] : [];
    }),
  );
}

async function externalLoraRoots(comfyRoot: string) {
  const configPath = path.join(comfyRoot, "extra_model_paths.yaml");
  if (!(await exists(configPath))) return [];
  const lines = (await readFile(configPath, "utf8")).split(/\r?\n/);
  const roots: string[] = [];
  let basePath = "";
  let collectingLoras = false;
  let loraIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const base = trimmed.match(/^base_path:\s*(.+)$/i);
    if (base) {
      basePath = cleanYamlValue(base[1]);
      collectingLoras = false;
      continue;
    }
    const loras = trimmed.match(/^loras?:\s*(.*)$/i);
    if (loras) {
      collectingLoras = true;
      loraIndent = indent;
      const inline = cleanYamlValue(loras[1]);
      if (inline && inline !== "|") roots.push(path.resolve(basePath, inline));
      continue;
    }
    if (collectingLoras && indent > loraIndent && !trimmed.includes(":")) {
      roots.push(path.resolve(basePath, cleanYamlValue(trimmed.replace(/^[-]\s*/, ""))));
      continue;
    }
    if (indent <= loraIndent) collectingLoras = false;
  }
  return roots;
}

export class LoraCatalogService {
  private readonly catalogPath: string;
  private scanPromise: Promise<StoredCatalog> | null = null;

  constructor(
    dataDir: string,
    private readonly comfyOutputDir: string,
  ) {
    this.catalogPath = path.join(dataDir, "lora-catalog.json");
  }

  private async load(): Promise<StoredCatalog> {
    try {
      const parsed = JSON.parse(await readFile(this.catalogPath, "utf8")) as StoredCatalog;
      return parsed.version === 1 && Array.isArray(parsed.files)
        ? parsed
        : { version: 1, updatedAt: "", roots: [], files: [] };
    } catch {
      return { version: 1, updatedAt: "", roots: [], files: [] };
    }
  }

  async status() {
    const stored = await this.load();
    return {
      scanning: this.scanPromise !== null,
      updatedAt: stored.updatedAt || null,
      files: stored.files.length,
      recognized: stored.files.filter((item) => item.family !== "?").length,
      roots: stored.roots,
    };
  }

  async forAvailable(available: string[]) {
    const stored = await this.load();
    const byName = new Map(stored.files.map((item) => [item.name.toLocaleLowerCase("en-US"), item]));
    return Object.fromEntries(available.map((name) => {
      const found = byName.get(normalizeRelative(name).toLocaleLowerCase("en-US"));
      return [name, found
        ? catalogEntry(name, {
            id: found.modelVersionId,
            modelId: found.modelId,
            name: found.versionName,
            baseModel: found.baseModel,
            model: { name: found.modelName },
          }, found.source)
        : catalogEntry(name, null, "filename")];
    }));
  }

  async scan(onProgress?: (message: string) => void): Promise<StoredCatalog> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanInternal(onProgress).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  private async scanInternal(onProgress?: (message: string) => void) {
    const comfyRoot = path.dirname(path.resolve(this.comfyOutputDir));
    const roots = [...new Set([
      path.join(comfyRoot, "models", "loras"),
      ...(await externalLoraRoots(comfyRoot)),
      ...(process.env.H3_LORA_ROOTS ?? "").split(path.delimiter).map((item) => item.trim()).filter(Boolean),
    ].map((item) => path.resolve(item)))];
    const previous = await this.load();
    const previousByPath = new Map(previous.files.map((item) => [item.path.toLocaleLowerCase("en-US"), item]));
    const discovered = (await Promise.all(roots.map(async (root) =>
      (await walkModels(root)).map((file) => ({ root, file })),
    ))).flat();
    onProgress?.(`Trovati ${discovered.length} LoRA in ${roots.length} archivi.`);

    const files: StoredFile[] = [];
    const unresolved: StoredFile[] = [];
    for (let index = 0; index < discovered.length; index += 1) {
      const { root, file } = discovered[index];
      const details = await stat(file);
      const name = normalizeRelative(path.relative(root, file));
      const cached = previousByPath.get(file.toLocaleLowerCase("en-US"));
      if (cached && cached.size === details.size && Math.trunc(cached.mtimeMs) === Math.trunc(details.mtimeMs)) {
        const normalized = catalogEntry(name, {
          id: cached.modelVersionId,
          modelId: cached.modelId,
          name: cached.versionName,
          baseModel: cached.baseModel,
          model: { name: cached.modelName },
        }, cached.source);
        files.push({ ...cached, ...normalized, name });
        continue;
      }
      const sidecar = await readSidecar(file);
      const hash = await sha256(file);
      const entry = catalogEntry(name, sidecar, sidecar ? "sidecar" : "filename");
      const stored = { ...entry, path: file, size: details.size, mtimeMs: details.mtimeMs, sha256: hash };
      files.push(stored);
      if (!sidecar) unresolved.push(stored);
      if ((index + 1) % 10 === 0 || index + 1 === discovered.length) {
        onProgress?.(`Hash LoRA ${index + 1}/${discovered.length}`);
      }
    }

    for (let offset = 0; offset < unresolved.length; offset += 100) {
      const batch = unresolved.slice(offset, offset + 100);
      const response = await fetch("https://civitai.com/api/v1/model-versions/by-hash", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(batch.map((item) => item.sha256)),
      });
      if (!response.ok) throw new Error(`Civitai ha risposto HTTP ${response.status}`);
      const versions = await response.json() as CivitaiVersion[];
      const versionByHash = new Map<string, CivitaiVersion>();
      for (const version of versions) {
        for (const hash of hashesFromVersion(version)) versionByHash.set(hash, version);
      }
      for (const item of batch) {
        const version = versionByHash.get(item.sha256);
        const updated = catalogEntry(item.name, version ?? null, version ? "civitai" : "filename");
        Object.assign(item, updated);
      }
      onProgress?.(`Civitai ${Math.min(offset + batch.length, unresolved.length)}/${unresolved.length}`);
    }

    const stored: StoredCatalog = {
      version: 1,
      updatedAt: new Date().toISOString(),
      roots,
      files,
    };
    await writeFile(this.catalogPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    return stored;
  }
}
