export type EngineOptionPolicy = "fallback" | "strict";

export function compatibleEngineOptions(
  values: string[],
  current: string,
  pattern: RegExp,
  policy: EngineOptionPolicy = "fallback",
) {
  const compatible = values.filter((value) => pattern.test(value));
  const options = compatible.length > 0 || policy === "strict"
    ? [...compatible]
    : [...values];
  if (policy === "fallback" && current && !options.includes(current)) {
    options.unshift(current);
  }
  return options;
}
