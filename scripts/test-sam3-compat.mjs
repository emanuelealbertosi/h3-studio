import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "h3-sam3-compat-"));
try {
  const sam3 = path.join(root, "comfyui-sam3");
  const nodes = path.join(sam3, "nodes");
  const model = path.join(nodes, "sam3");
  await mkdir(model, { recursive: true });
  await writeFile(path.join(nodes, "comfy-env.toml"), '[pypi-dependencies]\ncomfy-kitchen = "*"\n');
  await writeFile(
    path.join(model, "attention.py"),
    `class SplitMultiheadAttention:\n` +
      `    def forward(self):\n` +
      `        if sdpa_mask is not None:\n` +
      `            masked_fn = optimized_attention_for_device(q.device, mask=True)\n` +
      `            out = masked_fn(q, k, v, heads=self.num_heads, mask=sdpa_mask, skip_reshape=True)\n`,
  );

  const patcher = path.resolve("scripts", "patch-sam3-compat.mjs");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(process.execPath, [patcher, sam3], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const env = await readFile(path.join(nodes, "comfy-env.toml"), "utf8");
  const attention = await readFile(path.join(model, "attention.py"), "utf8");
  assert.match(env, /comfy-kitchen = "==0\.2\.31"/);
  assert.match(attention, /H3 Studio compatibility: arbitrary masks/);
  assert.doesNotMatch(attention, /masked_fn = optimized_attention_for_device/);
  console.log("SAM3 compatibility patch test passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
