import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sam3Root = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!sam3Root) {
  throw new Error("Uso: node scripts/patch-sam3-compat.mjs <cartella comfyui-sam3>");
}

const envPath = path.join(sam3Root, "nodes", "comfy-env.toml");
const attentionPath = path.join(sam3Root, "nodes", "sam3", "attention.py");
const requiredKitchen = 'comfy-kitchen = "==0.2.31"';
const oldMaskedDispatch = /        if sdpa_mask is not None:\r?\n            masked_fn = optimized_attention_for_device\(q\.device, mask=True\)\r?\n            out = masked_fn\(q, k, v, heads=self\.num_heads, mask=sdpa_mask, skip_reshape=True\)/;
const compatibleMaskedDispatch = `        if sdpa_mask is not None:
            # H3 Studio compatibility: arbitrary masks must use PyTorch SDPA
            # directly. The generic dispatcher may choose flash-attn, which
            # rejects masks and logs one fallback warning per transformer block.
            out = attention_pytorch(
                q,
                k,
                v,
                heads=self.num_heads,
                mask=sdpa_mask,
                skip_reshape=True,
            )`;

async function patchEnvironment() {
  const original = await readFile(envPath, "utf8");
  const expression = /^comfy-kitchen\s*=\s*"[^"]*"\s*$/m;
  if (!expression.test(original)) {
    throw new Error(`Dipendenza comfy-kitchen non trovata in ${envPath}`);
  }
  const patched = original.replace(expression, requiredKitchen);
  if (patched !== original) await writeFile(envPath, patched, "utf8");
  return patched !== original;
}

async function patchMaskedAttention() {
  const original = await readFile(attentionPath, "utf8");
  const directSdpa = /if sdpa_mask is not None:\r?\n[\s\S]{0,900}?out = attention_pytorch\(/;
  if (directSdpa.test(original)) return false;
  if (!oldMaskedDispatch.test(original)) {
    throw new Error(
      `Versione SAM3 non riconosciuta: il dispatcher masked atteso non è presente in ${attentionPath}`,
    );
  }
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  await writeFile(attentionPath, original.replace(
    oldMaskedDispatch,
    compatibleMaskedDispatch.replaceAll("\n", eol),
  ), "utf8");
  return true;
}

const envChanged = await patchEnvironment();
const attentionChanged = await patchMaskedAttention();
console.log(
  `[H3 Studio] Compatibilità SAM3: comfy-kitchen ${envChanged ? "allineato" : "già corretto"}; ` +
    `masked SDPA ${attentionChanged ? "applicato" : "già corretto"}.`,
);
