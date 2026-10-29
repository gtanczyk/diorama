// Muse Spark: plans, briefs, locates things on images and judges them.
import { metaPost } from './http.ts';
import sharp from 'sharp';
import { inputHash, type Memo, type Paid } from './memo.ts';
import { envValue } from '../secrets.ts';
import { sparkChoice } from './choice.ts';
import { chat } from './openrouter.ts';
import { sparkUsd, type SparkTier, type Usage } from './prices.ts';
import { answerSchema } from './schema.ts';
import type { ZodType } from 'zod';

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
 * Which model answers Spark's asks (Studio Setup, or DIORAMA_SPARK_VIA): "meta" (the default), "claude" (Anthropic's API with
 * DIORAMA_ANTHROPIC_API_KEY, model DIORAMA_CLAUDE_MODEL, default Sonnet 5.5) or "openrouter:<model id>".
 * Another model's answers are kept under their own memo keys, so a Meta build never replays them.
 */
export function sparkVia(): string | null {
  const via = sparkChoice();
  if (!via || via === 'meta') return null;
  return via === 'claude' ? `anthropic:${process.env.DIORAMA_CLAUDE_MODEL || 'claude-sonnet-5-5'}` : via;
}

export function imageDataUrl(image: Buffer): string {
  const jpeg = image[0] === 0xff && image[1] === 0xd8;
  return `data:image/${jpeg ? 'jpeg' : 'png'};base64,${image.toString('base64')}`;
}

/**
 * personal: the images are the person's own photos or drawings (kept off the contributor tier by default).
 * schema: the answer's shape. Claude (direct or via OpenRouter) is held to it by structured outputs, so its JSON
 * always parses. The caller still checks the answer (zod limits, its own rules): structured outputs hold only the shape.
 */
export type SparkAsk<T = unknown> = { label: string; prompt: string; images?: Buffer[]; personal?: boolean; schema?: ZodType<T, any, any> };

const sparkHash = ({ prompt, images = [] }: SparkAsk) => inputHash(sparkVia()?.replace(/^anthropic:/, '') ?? SPARK, prompt, ...images);

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

/**
 * Shapes the API would not compile into a grammar (the whole story is too large for it), asked plainly from then on:
 * the JSON repair in jsonIn and askSparkJson's retries still hold those answers.
 */
const refused = new Set<string>();
const heldTo = (schema?: ZodType) => {
  const format = schema && answerSchema(schema);
  return format && !refused.has(JSON.stringify(format)) ? format : undefined;
};
function refuse(label: string, format: object, why: string) {
  refused.add(JSON.stringify(format));
  // Said in plain words on the progress card; the API's own message only says which limit.
  const limit = /too large|too complex/i.test(why) ? 'the answer\'s shape is too big for it' : 'it did not accept the answer\'s shape';
  console.log(`  ${label}: Claude asked for plain JSON instead (${limit})`);
}

async function askOpenRouter(model: string, { label, prompt, images, schema }: SparkAsk): Promise<Paid> {
  const format = heldTo(schema);
  try {
    return await chat(`spark ${label}`, model, prompt, images, CLAUDE_SYSTEM, format);
  } catch (error) {
    if (!format || !/: 400 /.test(String(error))) throw error;
    refuse(label, format, String(error));
    return chat(`spark ${label}`, model, prompt, images, CLAUDE_SYSTEM);
  }
}

/** Spark's prompts were written for Spark; this keeps another model's answers in the shape they expect. */
const CLAUDE_SYSTEM = 'You stand in for a vision-language model inside a game-making pipeline. When asked for JSON, reply with one valid JSON value and nothing else: no prose, no code fences. Inside JSON strings never use a plain double quote; for quotations in any language use the typographic quotes of that language (for Polish „ and ”) or single quotes. Keep the answer as short as the request allows.';

async function askClaude(model: string, { label, prompt, images = [], schema }: SparkAsk): Promise<Paid> {
  const key = envValue('DIORAMA_ANTHROPIC_API_KEY');
  if (!key) throw new Error('DIORAMA_SPARK_VIA=claude needs DIORAMA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY); openrouter:anthropic/claude-sonnet-5.5 goes without');
  const content = [...(await Promise.all(images.map(async (i) => ({ type: 'image', source: await claudeImage(i) })))), { type: 'text', text: prompt }];
  let format = heldTo(schema);
  for (let n = 1; ; n++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(240_000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 32000,
        system: CLAUDE_SYSTEM,
        messages: [{ role: 'user', content }],
        ...(format ? { output_config: { format: { type: 'json_schema', schema: format } } } : {}),
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
      if (body.stop_reason === 'max_tokens') throw new Error(`spark ${label} (claude): the answer ran past ${32000} tokens and was cut off`);
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (!text.trim()) throw new Error(`spark ${label} (claude): empty answer`);
      const usage = (body as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      // Paid from Anthropic credits, not Meta's: the budget counts it apart. Sonnet 5.5 list price.
      return { data: Buffer.from(text, 'utf8'), usd: ((usage?.input_tokens ?? 0) * 2 + (usage?.output_tokens ?? 0) * 10) / 1e6, via: model };
    }
    if (res.status === 400 && format) {
      refuse(label, format, await res.text());
      format = undefined;
      continue;
    }
    if (n === 4 || ![429, 500, 502, 503, 529].includes(res.status)) throw new Error(`spark ${label} (claude): ${res.status} ${(await res.text()).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
  }
}

export async function askSpark(memo: Memo, ask: SparkAsk): Promise<string> {
  const via = sparkVia();
  const answer = await memo.remember('spark', ask.label, sparkHash(ask), 'txt', () =>
    !via ? askMeta(ask) : via.startsWith('anthropic:') ? askClaude(via.slice(10), ask) : askOpenRouter(via.replace(/^openrouter:/, ''), ask));
  return answer.toString('utf8');
}

/**
 * A bare `"` inside a string, escaped: models writing Polish or German quote „like this" close with a plain
 * quote. A quote ends the string only when what follows can come after a string (`,` `:` `}` `]` or the end).
 */
export function escapeStrayQuotes(json: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString && c === '\\') {
      out += c + (json[++i] ?? '');
      continue;
    }
    if (c === '"') {
      if (!inString) inString = true;
      else if (/^\s*([,:}\]]|$)/.test(json.slice(i + 1, i + 40))) inString = false;
      else {
        out += '\\"';
        continue;
      }
    }
    // A raw line break inside a string is not JSON either.
    out += inString && c === '\n' ? '\\n' : c;
  }
  return out;
}

/** The first `{` to the last `}` of a reply, parsed. Spark often wraps JSON in prose or fences. */
export function jsonIn<T = unknown>(text: string): T {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) throw new Error(`no JSON object in: ${text.slice(0, 160)}`);
  const body = text.slice(from, to + 1);
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    try {
      return JSON.parse(escapeStrayQuotes(body)) as T;
    } catch {
      throw error;
    }
  }
}

/**
 * Asks for JSON. A reply that is not JSON is forgotten, so the next run asks again instead of replaying it, and is
 * asked again at once (twice more), told what broke: a long reply in Polish often quotes a word with bare double
 * quotes inside a string, and one broken story should not stop the whole build.
 */
export async function askSparkJson<T = unknown>(memo: Memo, ask: SparkAsk<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tried: SparkAsk<T> = attempt === 0 ? ask : {
      ...ask,
      prompt: `${ask.prompt}\n\nYour previous answer was not valid JSON (${last instanceof Error ? last.message.slice(0, 120) : 'unreadable'}). Answer with valid JSON only: inside a string, never use a bare double quote (write \\" or use „…” or single quotes).`,
    };
    const text = await askSpark(memo, tried);
    try {
      return jsonIn<T>(text);
    } catch (error) {
      memo.forget('spark', sparkHash(tried), 'txt');
      last = error;
    }
  }
  throw last;
}
