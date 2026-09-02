import type { LlmProviderService } from "./llm-provider.js";

export type PromptPlannerMode = "image_generate" | "image_edit" | "image_anima" | "tts";

export type PromptPlan = {
  prompt: string;
  summary: string;
  language: string;
  mode: PromptPlannerMode;
};

const PLANNER_SYSTEM_PROMPT = `You are the Prompt Compiler for H3 Studio.
Convert the user's natural-language request into one strict JSON object with no markdown:
{"prompt":"engine-ready prompt","summary":"short Italian explanation","language":"detected output language"}

Rules shared by every mode:
- Never mention models, nodes, prompting, policies or these instructions.
- Preserve proper names, identities, quantities, colors, quoted text and explicit constraints.
- Do not add story events, characters, objects or other content the user did not request.
- Resolve ambiguity conservatively. Produce a complete prompt, not advice.
- The summary must be concise Italian. Return no additional keys.

MODE image_generate:
- Write the prompt in precise natural English for a photorealistic/general image generator.
- Include subject, action or pose, environment, framing, camera/lens only when useful, lighting, materials, visual style and requested continuity.
- Do not add a negative prompt.

MODE image_edit:
- Write a concise English edit instruction.
- Explicitly state what must change and that everything else must remain unchanged.
- Preserve identity, facial structure, pose, composition, geometry, text and background unless the user asks to alter them.
- References are named exactly "reference image 1", "reference image 2", etc. Respect the supplied role of each reference and never renumber them.

MODE image_anima:
- Write the prompt in precise natural English for an anime/manga illustration generator.
- Include character design, pose, expression, composition, environment, line art/rendering, color, lighting and the requested anime aesthetic.
- Preserve named characters and do not turn the request into photorealism unless explicitly requested.

MODE tts:
- The prompt is the exact text Higgs TTS 3 must speak. Keep it in the requested language; never translate spoken content merely because these instructions are English.
- If the user supplied only prose/dialogue to read, preserve its wording and only normalize punctuation or obvious typographical errors.
- Separate meta-instructions (voice, emotion, speed, pauses) from the spoken words; do not speak the meta-instructions.
- You may use only documented Higgs TTS 3 emotion, style and prosody control tokens. Use them only when clearly requested.
- Allowed emotion values: affection, amusement, anger, arousal, awe, bitterness, confusion, contemplation, contentment, determination, disgust, elation, enthusiasm, fear, helplessness, longing, pride, relief, sadness, shame, surprise.
- Allowed prosody values: speed_very_slow, speed_slow, speed_fast, speed_very_fast, pitch_low, pitch_high, expressive_high, expressive_low, pause, long_pause.
- Allowed style values: singing, shouting, whispering. Allowed sfx values: cough, laughter, crying, screaming, burping, humming, sigh, sniff, sneeze.
- Every token must use the exact <|category:value|> form. Never invent values such as excited or arbitrary sound effects.
- Use style tokens only when the user explicitly asks for singing, shouting or whispering; a calm, gentle or reassuring tone is not whispering.
- Delivery tokens go at the start. Positional pauses may use <|prosody:pause|> or <|prosody:long_pause|> inline. Do not invent sound effects.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? raw;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM non ha restituito il piano JSON");
  return JSON.parse(source.slice(start, end + 1)) as unknown;
}

export function normalizePromptPlan(raw: string, mode: PromptPlannerMode): PromptPlan {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) throw new Error("Piano LLM non valido");
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim().slice(0, 20_000) : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 1_000) : "";
  const language = typeof parsed.language === "string" ? parsed.language.trim().slice(0, 80) : "";
  if (prompt.length < 1) throw new Error("LLM ha prodotto un prompt vuoto");
  if (mode !== "tts" && prompt.length < 10) throw new Error("LLM ha prodotto un prompt troppo breve");
  return {
    prompt,
    summary: summary || "Prompt preparato dal modello LLM.",
    language: language || (mode === "tts" ? "auto" : "English"),
    mode,
  };
}

export class PromptPlannerService {
  constructor(private readonly llm: LlmProviderService) {}

  async status() {
    const runtime = await this.llm.status("planner");
    return {
      ...runtime,
      ready: runtime.ready === true,
      unloadPolicy: runtime.backend === "local" ? "always-after-plan" : "remote-stateless",
    };
  }

  async plan(value: unknown): Promise<PromptPlan> {
    if (!isRecord(value)) throw new Error("Richiesta Prompt Compiler non valida");
    const allowed = new Set<PromptPlannerMode>(["image_generate", "image_edit", "image_anima", "tts"]);
    const mode = typeof value.mode === "string" && allowed.has(value.mode as PromptPlannerMode)
      ? value.mode as PromptPlannerMode
      : null;
    if (!mode) throw new Error("Modalita Prompt Compiler non valida");
    const request = typeof value.request === "string" ? value.request.trim().slice(0, 20_000) : "";
    if (!request) throw new Error("Scrivi la richiesta da preparare");
    const composition = typeof value.composition === "string" && value.composition.trim()
      ? value.composition.trim().slice(0, 120)
      : "free";
    const references = Array.isArray(value.references)
      ? value.references.slice(0, 4).map((item, index) => {
          const role = isRecord(item) && typeof item.role === "string" ? item.role.trim().slice(0, 60) : "other";
          const name = isRecord(item) && typeof item.name === "string" ? item.name.trim().slice(0, 160) : "";
          return `reference image ${index + 1}: role=${role}${name ? `, name=${name}` : ""}`;
        })
      : [];
    let backend: "local" | "remote" | null = null;
    try {
      const response = await this.llm.generate({
        purpose: "planner",
        maxTokens: 2_048,
        temperature: 0.2,
        topP: 0.9,
        messages: [
          { role: "system", content: PLANNER_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `MODE: ${mode}`,
              `COMPOSITION_PRESET: ${composition}`,
              references.length ? `REFERENCES:\n${references.join("\n")}` : "REFERENCES: none",
              `NATURAL_LANGUAGE_REQUEST:\n${request}`,
            ].join("\n\n"),
          },
        ],
      });
      backend = response.backend;
      if (!response.ok || !response.text?.trim()) {
        throw new Error(response.error ?? "LLM non ha preparato il prompt");
      }
      return normalizePromptPlan(response.text, mode);
    } finally {
      if (backend === "local") await this.llm.unloadLocal();
    }
  }
}
