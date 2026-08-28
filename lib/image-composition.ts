export const CHARACTER_TURNAROUND_FORMAT = {
  aspectFormat: "16:9",
  width: 1792,
  height: 1008,
} as const;

export const IMAGE_EDIT_KEEP_ASPECT_FORMAT = "keep-source-aspect" as const;
const IMAGE_EDIT_TARGET_PIXELS = 1_806_336;

export function imageEditKeepAspectDimensions(
  sourceWidth: number | null | undefined,
  sourceHeight: number | null | undefined,
) {
  if (
    typeof sourceWidth !== "number" ||
    typeof sourceHeight !== "number" ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return null;
  }
  const ratio = sourceWidth / sourceHeight;
  const align = (value: number) =>
    Math.min(4096, Math.max(64, Math.round(value / 16) * 16));
  return {
    width: align(Math.sqrt(IMAGE_EDIT_TARGET_PIXELS * ratio)),
    height: align(Math.sqrt(IMAGE_EDIT_TARGET_PIXELS / ratio)),
  };
}

const CHARACTER_TURNAROUND_EXCLUSIONS =
  "[STRICT EXCLUSIONS]\nNo extra people or characters. No fifth view, duplicate angle, inset, detail panel, close-up, headshot, bust-only crop, cropped head, cropped hands, cropped feet, action pose, perspective distortion, identity drift, different face, different body, costume variation, hairstyle variation, text, captions, labels, logos, watermark, panel borders or decorative frame.";

export const IMAGE_COMPOSITION_PRESETS = [
  {
    value: "free",
    label: "Libero",
    shortLabel: "Libero",
    description: "Il prompt resta invariato.",
    promptAddition: "",
  },
  {
    value: "character-turnaround",
    label: "Character sheet / turnaround",
    shortLabel: "Character sheet",
    description: "Un foglio 16:9, quattro viste intere bloccate e coerenti.",
    promptAddition:
      "[COMPOSITION LOCK — HIGHEST PRIORITY]\nCreate ONE single 16:9 studio character-turnaround sheet, not a scene, poster or narrative illustration. Show EXACTLY FOUR non-overlapping full-body depictions of ONE identical character. LEFT-TO-RIGHT ORDER: (1) straight FRONT view, (2) FRONT THREE-QUARTER view turned toward the viewer's left, (3) exact LEFT PROFILE view, (4) straight BACK view.\n\n[IDENTITY LOCK]\nAll four depictions MUST have the same identity, face, age, body proportions, skin tone, hairstyle, outfit, colors, materials, accessories and footwear. Any named held prop must be identical in every view.\n\n[POSE LOCK]\nUse the same neutral A-pose in all four views: arms slightly away from the torso, hands visible, legs straight, feet parallel and fully visible.\n\n[SCALE AND CAMERA LOCK]\nUse equal body height, head size, ground line, camera height, near-orthographic perspective, focal length and lighting in every view. Keep equal spacing and no overlap.\n\n[BACKGROUND LOCK]\nUse one plain light-neutral seamless studio background with no environment, floor clutter or dramatic shadows.",
  },
  {
    value: "close-up",
    label: "Primo piano",
    shortLabel: "Primo piano",
    description: "Volto dominante, testa e spalle, occhi nitidi.",
    promptAddition:
      "Composition: a close-up portrait framed around the head and shoulders. Keep the face dominant in the image, the eyes sharply focused and the facial features clearly readable. Avoid a distant or full-body framing.",
  },
  {
    value: "half-body",
    label: "Mezzo busto",
    shortLabel: "Mezzo busto",
    description: "Inquadratura dalla vita in su, posa e mani leggibili.",
    promptAddition:
      "Composition: a medium waist-up portrait. Keep the head, torso and relevant hand gestures clearly visible, with balanced space around the subject. Avoid cropping through the face or framing the subject as a distant full-body figure.",
  },
  {
    value: "full-body",
    label: "Figura intera",
    shortLabel: "Figura intera",
    description: "Soggetto completo dalla testa ai piedi, senza tagli.",
    promptAddition:
      "Composition: a full-body head-to-toe view of the subject. Keep the entire figure, including the feet, visible inside the frame with natural proportions and enough breathing room. Do not crop any part of the body.",
  },
  {
    value: "object-sheet",
    label: "Oggetto sheet",
    shortLabel: "Oggetto sheet",
    description: "Piu viste coerenti dello stesso oggetto su fondo neutro.",
    promptAddition:
      "Composition: create a clean object design sheet showing the same object consistently from front, three-quarter, side and back views, plus one useful detail view. Arrange every view evenly on a simple neutral background with consistent scale, materials and construction. No text, labels or decorative frames.",
  },
  {
    value: "landscape",
    label: "Luogo",
    shortLabel: "Luogo",
    description: "Inquadratura ampia con profondita e ambiente protagonista.",
    promptAddition:
      "Composition: a wide establishing landscape view with a clear foreground, middle ground and background. Make the environment the main subject, preserve a strong sense of scale and depth, and avoid close-up portrait framing.",
  },
] as const;

export type ImageCompositionPreset =
  (typeof IMAGE_COMPOSITION_PRESETS)[number]["value"];

const presetValues = new Set<string>(
  IMAGE_COMPOSITION_PRESETS.map((preset) => preset.value),
);

export function isImageCompositionPreset(
  value: unknown,
): value is ImageCompositionPreset {
  return typeof value === "string" && presetValues.has(value);
}

export function imageCompositionPreset(value: ImageCompositionPreset) {
  return IMAGE_COMPOSITION_PRESETS.find((preset) => preset.value === value)!;
}

export function composeImagePrompt(
  userPrompt: string,
  preset: ImageCompositionPreset,
) {
  const normalizedPrompt = userPrompt.trim();
  const addition = imageCompositionPreset(preset).promptAddition;
  if (preset === "character-turnaround") {
    return `${addition}\n\n[SUBJECT AND STYLE BRIEF — APPLY IDENTICALLY TO ALL FOUR VIEWS]\nUse the following brief only for character identity, wardrobe, materials and rendering style; it must not override the composition locks above.\n${normalizedPrompt}\n\n${CHARACTER_TURNAROUND_EXCLUSIONS}`;
  }
  if (!normalizedPrompt) return addition;
  return addition ? `${normalizedPrompt}\n\n${addition}` : normalizedPrompt;
}
