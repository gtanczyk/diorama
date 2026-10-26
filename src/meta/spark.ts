// Muse Spark: plans, briefs, locates things on images and judges them.
import { metaPost } from './http.ts';
import { inputHash, type Memo } from './memo.ts';

export const SPARK = 'muse-spark-1.3';

export function imageDataUrl(image: Buffer): string {
  const jpeg = image[0] === 0xff && image[1] === 0xd8;
  return `data:image/${jpeg ? 'jpeg' : 'png'};base64,${image.toString('base64')}`;
}

export type SparkAsk = { label: string; prompt: string; images?: Buffer[] };

export async function askSpark(memo: Memo, { label, prompt, images = [] }: SparkAsk): Promise<string> {
  const answer = await memo.remember('spark', label, inputHash(SPARK, prompt, ...images), 'txt', async () => {
    const input = images.length === 0
      ? prompt
      : [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...images.map((i) => ({ type: 'input_image', image_url: imageDataUrl(i) }))] }];
    const res = await metaPost('/responses', { model: SPARK, input });
    const body = (await res.json()) as { output?: { content?: { type: string; text?: string }[] }[] };
    const text = (body.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
    if (!text.trim()) throw new Error(`spark ${label}: empty answer`);
    return Buffer.from(text, 'utf8');
  });
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
    memo.forget('spark', inputHash(SPARK, ask.prompt, ...(ask.images ?? [])), 'txt');
    throw error;
  }
}
