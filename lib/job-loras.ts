export const MAX_JOB_LORAS = 5;
const MAX_JOB_LORA_OVERRIDE_ROWS = 10;

export type JobLoraOverride = {
  name: string;
  strength: number;
  enabled: boolean;
};

export type EffectiveJobLora = {
  name: string;
  strength: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeJobLoraOverrides(value: unknown): JobLoraOverride[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Gli override LoRA devono essere un array");
  if (value.length > MAX_JOB_LORA_OVERRIDE_ROWS) {
    throw new Error(`Troppi override LoRA per esecuzione`);
  }
  const names = new Set<string>();
  return value.flatMap((item, index) => {
    if (!isRecord(item)) throw new Error(`Override LoRA ${index + 1} non valido`);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) return [];
    if (name.length > 1_024) throw new Error(`Nome LoRA ${index + 1} non valido`);
    const key = name.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error(`Il LoRA ${name} è selezionato più di una volta`);
    names.add(key);
    const strength = Number(item.strength);
    if (!Number.isFinite(strength) || strength < -2 || strength > 2) {
      throw new Error(`La strength del LoRA ${name} deve essere compresa fra -2 e 2`);
    }
    return [{ name, strength, enabled: item.enabled !== false }];
  });
}

export function resolveJobLoras(
  defaults: ReadonlyArray<EffectiveJobLora>,
  overrides: ReadonlyArray<JobLoraOverride> | undefined,
) {
  if (overrides === undefined) return defaults.map((item) => ({ ...item }));
  const ordered = defaults.map((item) => item.name);
  const values = new Map(
    defaults.map((item) => [item.name.toLocaleLowerCase("en-US"), { ...item, enabled: true }]),
  );
  for (const override of overrides) {
    const key = override.name.toLocaleLowerCase("en-US");
    if (!values.has(key)) ordered.push(override.name);
    values.set(key, { ...override });
  }
  const enabled = ordered.flatMap((name) => {
    const value = values.get(name.toLocaleLowerCase("en-US"));
    return value?.enabled ? [{ name: value.name, strength: value.strength }] : [];
  });
  if (enabled.length > MAX_JOB_LORAS) {
    throw new Error(`Puoi attivare al massimo ${MAX_JOB_LORAS} LoRA per esecuzione`);
  }
  return enabled;
}
