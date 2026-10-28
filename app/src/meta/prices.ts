// Meta Model API list prices (dev.meta.ai/docs/pricing-rate-limits, read 2026-10-28), so every call sent can say
// what it cost. Contributor tier: same Spark, Meta may train on the prompts and answers.
export const PRICES = {
  /** Per image returned, generation or edit alike. */
  museImage: 0.01,
  /** Per image segmented. */
  sam: 0.0025,
  /** Per million tokens. */
  spark: {
    standard: { input: 1.25, cached: 0.15, output: 4.25 },
    contributor: { input: 0.1, cached: 0.002, output: 0.2 },
  },
  /** Per hour of audio. */
  voiceTranscribe: 0.18,
} as const;

export type SparkTier = keyof typeof PRICES.spark;
export type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };

export function sparkUsd(tier: SparkTier, usage: Usage | undefined): number | undefined {
  if (!usage) return undefined;
  const p = PRICES.spark[tier];
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return (((usage.input_tokens ?? 0) - cached) * p.input + cached * p.cached + (usage.output_tokens ?? 0) * p.output) / 1e6;
}
