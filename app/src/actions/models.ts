// Studio Setup's model pick: which model answers Spark's asks and which paints, with what each needs.
import { z } from 'zod';
import { readModelChoice, writeModelChoice } from '../meta/choice.ts';
import { imageVia } from '../meta/muse.ts';
import { sparkVia } from '../meta/spark.ts';
import { envValue } from '../secrets.ts';
import { defineAction } from './registry.ts';

const google = () => !!envValue('GEMINI_API_KEY');
const openrouter = () => !!envValue('OPENROUTER_API_KEY');

/** What Setup offers; `ready` says whether this machine has the key it needs. */
function options() {
  const anthropic = !!envValue('DIORAMA_ANTHROPIC_API_KEY');
  const gemini = google() || openrouter();
  return {
    spark: [
      { id: 'meta', label: 'Muse Spark (Meta)', ready: !!envValue('META_API_KEY') },
      { id: 'claude', label: 'Claude Sonnet 5.5', ready: anthropic },
      { id: 'openrouter:anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 via OpenRouter', ready: openrouter() },
    ],
    image: [
      { id: 'meta', label: 'Muse Image (Meta)', ready: !!envValue('META_API_KEY') },
      { id: 'gemini-flash', label: 'Gemini 3.1 Flash Image', ready: gemini },
      { id: 'gemini-lite', label: 'Gemini 3.1 Flash Lite Image', ready: gemini },
      { id: 'nano-banana', label: 'Nano Banana 2.1', ready: gemini },
      { id: 'gemini-pro', label: 'Gemini 3 Pro Image', ready: gemini },
    ],
  };
}

function state() {
  const picked = readModelChoice();
  return {
    spark: process.env.DIORAMA_SPARK_VIA || picked.spark || 'meta',
    image: process.env.DIORAMA_IMAGE_VIA || picked.image || 'meta',
    /** Set where the Studio was started: Setup shows it and cannot change it. */
    env: { spark: process.env.DIORAMA_SPARK_VIA ?? null, image: process.env.DIORAMA_IMAGE_VIA ?? null },
    resolved: { spark: sparkVia(), image: imageVia() },
    options: options(),
  };
}

defineAction({
  name: 'models_get',
  reads: true,
  description: 'Which models make worlds now: Spark\'s asks (Muse Spark or Claude) and pictures (Muse Image or a Gemini image model), and what Setup offers.',
  input: z.object({}),
  async run() {
    return state();
  },
});

defineAction({
  name: 'models_set',
  description: 'Pick the model for Spark\'s asks (meta, claude, openrouter:<model>) and for pictures (meta, gemini-flash, gemini-lite, nano-banana, gemini-pro). '
    + 'Other models\' answers keep their own memo keys; meta goes back to the Meta answers. The hackathon demo stays on meta.',
  input: z.object({ spark: z.string().min(1).optional(), image: z.string().min(1).optional() }),
  async run({ spark, image }) {
    const was = readModelChoice();
    writeModelChoice({ spark: spark ?? was.spark, image: image ?? was.image });
    return state();
  },
});
