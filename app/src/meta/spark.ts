// Muse Spark: plans, briefs, locates things on images and judges them.
import { metaPost } from './http.ts';
import sharp from 'sharp';
import { inputHash, type Memo, type Paid } from './memo.ts';
import { envValue } from '../secrets.ts';
import { sparkUsd, type SparkTier, type Usage } from './prices.ts';

export const SPARK = 'muse-spark-1.3';

/**
 * Which Spark price tier a call goes to. DIORAMA_SPARK_TIER: "contributor" (Meta's cheaper tier, ~1/15 the price;
 * Meta may train on the prompt and answer), "standard", or "auto" (the default): contributor, except calls that
 * carry the person's own photos or drawings, which stay standard. Same model either way, so they share answers.
 */
export function sparkTier(personal = false): SparkTier {
  const want = process.env.DIORAMA_SPARK_TIER ?? 'auto';
  if (want === 'standard' || want === 'contributor') return want;
  return personal ? 'standard' : 'contributor';
}

/**
 * Development only: DIORAMA_SPARK_VIA=claude sends Spark's text and vision asks to Claude (DIORAMA_ANTHROPIC_API_KEY,
 * model DIORAMA_CLAUDE_MODEL), to test pipeline changes without spending Meta credits. Its answers are kept
 * under their own memo keys, so a world built for real (Meta, the default) never replays a Claude answer.
 */
export const sparkViaClaude = () => process.env.DIORAMA_SPARK_VIA === 'claude';
const claudeModel = () => process.env.DIORAMA_CLAUDE_MODEL || 'claude-sonnet-5-5';

export function imageDataUrl(image: Buffer): string {
  const jpeg = image[0] === 0xff && image[1] === 0xd8;
  return `data:image/${jpeg ? 'jpeg' : 'png'};base64,${image.toString('base64')}`;
}

/** personal: the images are the person's own photos or drawings (kept off the contributor tier by default). */
export type SparkAsk = { label: string; prompt: string; images?: Buffer[]; personal?: boolean };

const sparkHash = ({ prompt, images = [] }: SparkAsk) => (sparkViaClaude() ? inputHash(claudeModel(), prompt, ...images) : inputHash(SPARK, prompt, ...images));

async function askMeta({ label, prompt, images = [], personal }: SparkAsk): Promise<Paid> {
  const tier = sparkTier(personal);
  const input = images.length === 0
    ? prompt
    : [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...images.map((i) => ({ type: 'input_image', image_url: imageDataUrl(i) }))] }];
  const res = await metaPost('/responses', { model: tier === 'contributor' ? `${SPARK}-contributor` : SPARK, input });
  const body = (await res.json()) as { output?: { content?: { type: string; text?: string }[] }[]; usage?: Usage };
  const text = (body.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
  if (!text.trim()) throw new Error(`spark ${label}: empty answer`);
  return { data: Buffer.from(text, 'utf8'), usd: sparkUsd(tier, body.usage), via: tier === 'contributor' ? 'contributor' : undefined };
}

/** Claude takes images up to 5 MB each; a big painting goes as a JPEG. */
async function claudeImage(image: Buffer) {
  const jpeg = image[0] === 0xff && image[1] === 0xd8;
  if (image.length < 3_500_000) return { type: 'base64', media_type: jpeg ? 'image/jpeg' : 'image/png', data: image.toString('base64') };
  return { type: 'base64', media_type: 'image/jpeg', data: (await sharp(image).jpeg({ quality: 88 }).toBuffer()).toString('base64') };
}

async function askClaude({ label, prompt, images = [] }: SparkAsk): Promise<Paid> {
  const key = envValue('DIORAMA_ANTHROPIC_API_KEY');
  if (!key) throw new Error('DIORAMA_SPARK_VIA=claude needs DIORAMA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY)');
  const content = [...(await Promise.all(images.map(async (i) => ({ type: 'image', source: await claudeImage(i) })))), { type: 'text', text: prompt }];
  for (let n = 1; ; n++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(240_000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: claudeModel(), max_tokens: 16000, messages: [{ role: 'user', content }] }),
    });
    if (res.ok) {
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (!text.trim()) throw new Error(`spark ${label} (claude): empty answer`);
      // Paid from Anthropic credits, not Meta's: the Meta budget does not count it.
      return { data: Buffer.from(text, 'utf8'), usd: 0, via: 'claude' };
    }
    if (n === 4 || ![429, 500, 502, 503, 529].includes(res.status)) throw new Error(`spark ${label} (claude): ${res.status} ${(await res.text()).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
  }
}

export async function askSpark(memo: Memo, ask: SparkAsk): Promise<string> {
  const answer = await memo.remember('spark', ask.label, sparkHash(ask), 'txt', () => (sparkViaClaude() ? askClaude(ask) : askMeta(ask)));
  return answer.toString('utf8');
}

/** The first `{` to the last `}` of a reply, parsed. Spark often wraps JSON in prose or fences. */
export function jsonIn<T = unknown>(text: string): T {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) throw new Error(`no JSON object in: ${text.slice(0, 160)}`);
  return JSON.parse(text.slice(from, to + 1)) as T;
}

/** Asks for JSON. A reply that is not JSON is forgotten, so the next run asks again instead of replaying it. */
export async function askSparkJson<T = unknown>(memo: Memo, ask: SparkAsk): Promise<T> {
  const text = await askSpark(memo, ask);
  try {
    return jsonIn<T>(text);
  } catch (error) {
    memo.forget('spark', sparkHash(ask), 'txt');
    throw error;
  }
}
