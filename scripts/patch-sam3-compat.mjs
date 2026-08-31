import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sam3Root = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!sam3Root) throw new Error("Uso: node scripts/patch-sam3-compat.mjs <cartella comfyui-sam3>");

const envPath = path.join(sam3Root, "nodes", "comfy-env.toml");
const attentionCandidates = [
  path.join(sam3Root, "nodes", "sam3", "attention.py"),
  path.join(sam3Root, "nodes", "sam3", "model", "attention.py"),
];
const requiredKitchen = 'comfy-kitchen = "==0.2.31"';
const oldMaskedDispatch = /        if sdpa_mask is not None:\r?\n            masked_fn = optimized_attention_for_device\(q\.device, mask=True\)\r?\n            out = masked_fn\(q, k, v, heads=self\.num_heads, mask=sdpa_mask, skip_reshape=True\)/;
const compatibleMaskedDispatch = `        if sdpa_mask is not None:
            # H3 Studio compatibility: arbitrary masks use PyTorch SDPA.
            out = attention_pytorch(
                q, k, v, heads=self.num_heads,
                mask=sdpa_mask, skip_reshape=True,
            )`;

const envOriginal = await readFile(envPath, "utf8");
const envExpression = /^comfy-kitchen\s*=\s*"[^"]*"\s*$/m;
if (!envExpression.test(envOriginal)) throw new Error(`Dipendenza comfy-kitchen non trovata in ${envPath}`);
const envPatched = envOriginal.replace(envExpression, requiredKitchen);
if (envPatched !== envOriginal) await writeFile(envPath, envPatched, "utf8");

let attentionPath = null;
let attentionOriginal = "";
for (const candidate of attentionCandidates) {
  try {
    attentionOriginal = await readFile(candidate, "utf8");
    attentionPath = candidate;
    break;
  } catch {}
}
if (!attentionPath) throw new Error("attention.py SAM3 non trovato");
const directSdpa = /if sdpa_mask is not None:\r?\n[\s\S]{0,500}?out = attention_pytorch\(/;
if (!directSdpa.test(attentionOriginal)) {
  if (!oldMaskedDispatch.test(attentionOriginal)) {
    throw new Error(`Versione SAM3 non riconosciuta: dispatcher masked assente in ${attentionPath}`);
  }
  const eol = attentionOriginal.includes("\r\n") ? "\r\n" : "\n";
  await writeFile(
    attentionPath,
    attentionOriginal.replace(oldMaskedDispatch, compatibleMaskedDispatch.replaceAll("\n", eol)),
    "utf8",
  );
}

console.log("[H3 Studio] Compatibilità SAM3 applicata: comfy-kitchen 0.2.31 + masked PyTorch SDPA.");
