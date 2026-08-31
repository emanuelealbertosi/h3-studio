import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const genericPrompt =
  "Create a coherent cinematic video with natural motion, clear continuity, readable composition and a stable ending.";
const genericRoles =
  "AUTO: infer conservative roles from the prompt and supplied references. Do not invent identity details that are not visible.";

type ApiNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

type ApiPrompt = Record<string, ApiNode>;

function apiNode(prompt: ApiPrompt, classType: string) {
  const matches = Object.values(prompt).filter((node) => node.class_type === classType);
  if (matches.length !== 1) {
    throw new Error("Expected one " + classType + " node, found " + matches.length);
  }
  return matches[0];
}

function blankApiLoras(prompt: ApiPrompt) {
  const node = apiNode(prompt, "Power Lora Loader (rgthree)");
  for (const [name, rawValue] of Object.entries(node.inputs)) {
    if (!/^lora_\d+$/.test(name) || typeof rawValue !== "object" || !rawValue) continue;
    const value = rawValue as Record<string, unknown>;
    value.on = false;
    value.lora = "";
    value.strength = 1;
  }
}

async function sanitizeApi(filename: string) {
  const filePath = path.join(root, "workflows", filename);
  const prompt = JSON.parse(await readFile(filePath, "utf8")) as ApiPrompt;
  blankApiLoras(prompt);

  const request = apiNode(prompt, "H3AIOAutopromptRequest");
  Object.assign(request.inputs, {
    generation_mode: "T2V",
    natural_prompt: genericPrompt,
    reference_roles: genericRoles,
    shot_count: 1,
    max_auto_shots: 1,
    shot_seconds: 5,
    llm_media_context: "OFF - text only",
    r2v_picture1_as_start: false,
    audio_1_role: "ignore",
    keyframe_positions: "AUTO",
    source_video_audio: "AUTO",
  });
  apiNode(prompt, "MiniMaxH3MediaLoader").inputs.media_state = "[]";
  apiNode(prompt, "H3WorkflowPresetManager").inputs.presets_json =
    JSON.stringify({ version: 2, selected: "", presets: {} });

  await writeFile(filePath, JSON.stringify(prompt, null, 2) + "\n", "utf8");
}

type UiNode = {
  id: number;
  type: string;
  widgets_values?: unknown[];
  widgets_values_named?: Record<string, unknown>;
};

type UiWorkflow = { nodes: UiNode[] };

function uiNode(workflow: UiWorkflow, type: string) {
  const matches = workflow.nodes.filter((node) => node.type === type);
  if (matches.length !== 1) {
    throw new Error("Expected one UI " + type + ", found " + matches.length);
  }
  return matches[0];
}

async function sanitizeUi() {
  const filePath = path.join(root, "workflows", "studio-backend.ui.json");
  const workflow = JSON.parse(await readFile(filePath, "utf8")) as UiWorkflow;

  const loraWidgets = uiNode(workflow, "Power Lora Loader (rgthree)").widgets_values ?? [];
  for (const rawValue of loraWidgets) {
    if (typeof rawValue !== "object" || !rawValue || !("lora" in rawValue)) continue;
    const value = rawValue as Record<string, unknown>;
    value.on = false;
    value.lora = "";
    value.strength = 1;
  }
  const loraNamed =
    uiNode(workflow, "Power Lora Loader (rgthree)").widgets_values_named ?? {};
  for (const [name, rawValue] of Object.entries(loraNamed)) {
    if (!/^lora_\d+$/.test(name) || typeof rawValue !== "object" || !rawValue) continue;
    const value = rawValue as Record<string, unknown>;
    value.on = false;
    value.lora = "";
    value.strength = 1;
  }

  const request = uiNode(workflow, "H3AIOAutopromptRequest").widgets_values;
  if (!request || request.length < 13) throw new Error("Unexpected H3AIOAutopromptRequest widgets");
  request[0] = "T2V";
  request[1] = genericPrompt;
  request[2] = genericRoles;
  request[3] = 1;
  request[4] = 1;
  request[5] = 5;
  request[6] = "OFF - text only";
  request[7] = false;
  request[8] = "ignore";
  request[10] = 512;
  request[11] = "AUTO";
  request[12] = "AUTO";
  Object.assign(
    uiNode(workflow, "H3AIOAutopromptRequest").widgets_values_named ?? {},
    {
      generation_mode: "T2V",
      natural_prompt: genericPrompt,
      reference_roles: genericRoles,
      shot_count: 1,
      max_auto_shots: 1,
      shot_seconds: 5,
      llm_media_context: "OFF - text only",
      r2v_picture1_as_start: false,
      audio_1_role: "ignore",
      keyframe_positions: "AUTO",
      source_video_audio: "AUTO",
    },
  );

  const media = uiNode(workflow, "MiniMaxH3MediaLoader").widgets_values;
  if (!media) throw new Error("Unexpected MiniMaxH3MediaLoader widgets");
  media[0] = "[]";
  const mediaNamed = uiNode(workflow, "MiniMaxH3MediaLoader").widgets_values_named;
  if (mediaNamed) mediaNamed.media_state = "[]";

  const presets = uiNode(workflow, "H3WorkflowPresetManager").widgets_values;
  if (!presets) throw new Error("Unexpected H3WorkflowPresetManager widgets");
  presets[0] = JSON.stringify({ version: 2, selected: "", presets: {} });
  const presetsNamed = uiNode(workflow, "H3WorkflowPresetManager").widgets_values_named;
  if (presetsNamed) {
    presetsNamed.presets_json = JSON.stringify({ version: 2, selected: "", presets: {} });
  }

  await writeFile(filePath, JSON.stringify(workflow, null, 2) + "\n", "utf8");
}

await Promise.all([
  sanitizeApi("studio-backend.api.json"),
  sanitizeUi(),
]);

console.log("Bundled workflows sanitized for distribution.");
