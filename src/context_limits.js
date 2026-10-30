export const CONTEXT_LIMIT_DEFAULTS = {
  llmContextTitleLimit: 300,
  llmContextHeadingLimit: 250,
  llmContextParagraphLimit: 2400,
  llmContextBeforeLimit: 450,
  llmContextAfterLimit: 450,
  llmContextTotalLimit: 4000,
};

export const CONTEXT_LIMIT_MAX = 12000;

export function normalizeContextLimits(settings = {}) {
  const output = {};
  for (const [key, fallback] of Object.entries(CONTEXT_LIMIT_DEFAULTS)) {
    const value = settings?.[key];
    const number = value === "" || value == null ? fallback : Number(value);
    const name = key.slice("llmContext".length, -"Limit".length).toLowerCase();
    output[name] = Number.isFinite(number)
      ? Math.max(0, Math.min(CONTEXT_LIMIT_MAX, Math.floor(number)))
      : fallback;
  }
  return output;
}
