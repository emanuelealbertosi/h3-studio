import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const samplerPath = fileURLToPath(
  new URL(
    "../comfyui_nodes/ComfyUI-H3-Multishot/h3_reference_memory.py",
    import.meta.url,
  ),
);
const source = await readFile(samplerPath, "utf8");
const motionSource = await readFile(
  fileURLToPath(
    new URL(
      "../comfyui_nodes/ComfyUI-H3-Multishot/h3_motion_memory.py",
      import.meta.url,
    ),
  ),
  "utf8",
);

assert.match(
  source,
  /None if operation_mode == "VIDEO EXTENSION" or inpaint_enabled\s+else initial_video/,
  "VIDEO EXTENSION must not condition on the full source video",
);
assert.match(
  source,
  /operation_mode == "VIDEO EXTENSION" and shot_index == 0/,
  "the external boundary must be promoted to encoder memory",
);
assert.match(
  source,
  /prompt\.replace\([\s\S]*"<Video 1>"[\s\S]*"the supplied previous-shot boundary"/,
  "the boundary-only prompt must not keep a dangling Video 1 marker",
);
assert.match(
  source,
  /trim_boundary[\s\S]*operation_mode == "VIDEO EXTENSION"[\s\S]*images = images\[1:\]/,
  "the duplicate boundary frame must be trimmed like internal multishot shots",
);
assert.match(
  source,
  /external_motion_context_length="22"/,
  "external Continue must default to a 22-frame temporal context",
);
assert.match(
  source,
  /motion_controller\.set_external\([\s\S]*ref_video_0/,
  "the external source must seed Motion Context on clip 1",
);
assert.match(
  motionSource,
  /"context_frames": self\.external_frames/,
  "Motion Context must receive consecutive decoded source frames",
);
assert.match(
  motionSource,
  /context_latent=self\.external_latent/,
  "a saved native AV latent must be preferred for Studio Continue",
);
assert.match(
  source,
  /MiniMaxH3MotionContextLoadLatent/,
  "Studio Continue must load the source candidate native AV latent",
);
assert.match(
  source,
  /MiniMaxH3MotionContextSaveLatent/,
  "every Studio candidate must persist its native AV latent",
);

console.log("Video continuation boundary regression passed.");
