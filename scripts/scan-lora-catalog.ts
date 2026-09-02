import { readFile } from "node:fs/promises";
import path from "node:path";
import { LoraCatalogService } from "../bridge/lora-catalog.js";

const dataDir = path.resolve(process.env.H3_DATA_DIR?.trim() || path.join(process.cwd(), "data"));
let comfyOutputDir = process.env.H3_COMFY_OUTPUT_DIR?.trim() || "";

if (!comfyOutputDir) {
  try {
    const settings = JSON.parse(
      await readFile(path.join(dataDir, "install-settings.json"), "utf8"),
    ) as { comfyOutputDir?: unknown };
    if (typeof settings.comfyOutputDir === "string") comfyOutputDir = settings.comfyOutputDir;
  } catch {
    // The explicit environment variable remains the fallback for fresh installs.
  }
}

if (!comfyOutputDir) {
  throw new Error("H3_COMFY_OUTPUT_DIR non configurata e install-settings.json non disponibile");
}

const catalog = new LoraCatalogService(dataDir, path.resolve(comfyOutputDir));
const result = await catalog.scan((message) => console.log(message));
const recognized = result.files.filter((item) => item.family !== "?").length;
const families = Object.entries(result.files.reduce<Record<string, number>>((output, item) => {
  output[item.family] = (output[item.family] ?? 0) + 1;
  return output;
}, {})).sort((left, right) => right[1] - left[1]);

console.log(`Catalogo completato: ${recognized}/${result.files.length} riconosciuti.`);
console.log(families.map(([family, count]) => `${family}: ${count}`).join(" · "));
