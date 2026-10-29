// Other models through OpenRouter, for when a world should be made with something other than Meta's:
// Gemini image models in place of Muse Image, any chat model in place of Spark. OPENROUTER_API_KEY holds
// the key; in a cloud session the proxy supplies it. A Google key (GEMINI_API_KEY or GOOGLE_API_KEY) sends Gemini pictures straight to Google instead. Answers say what they cost.
import sharp from 'sharp';
import type { Paid } from './memo.ts';

const URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Short names for the image models worth trying, as OpenRouter lists them (2026-10-28). */
export const IMAGE_MODELS: Record<string, string> = {
  'gemini-flash': 'google/gemini-3.1-flash-image',
  'gemini-lite': 'google/gemini-3.1-flash-lite-image',
  'nano-banana': 'google/gemini-nano-banana-2.1',
  'gemini-pro': 'google/gemini-3-pro-image',
};

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type Answer = { choices?: { message?: { content?: string | null; images?: { image_url?: { url?: string } }[] } }[]; usage?: { cost?: number }; error?: { message?: string } };

async function post(label: string, body: Record<string, unknown>): Promise<Answer> {
  for (let n = 1; ; n++) {
    const res = await fetch(URL, {
      method: 'POST',
      signal: AbortSignal.timeout(240_000),
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? 'proxy'}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as Answer;
    if (n === 4 || ![408, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`${label} (${body.model}): ${res.status} ${(await res.text()).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
  }
}

const dataUrl = (image: Buffer) => `data:image/${image[0] === 0xff && image[1] === 0xd8 ? 'jpeg' : 'png'};base64,${image.toString('base64')}`;
const content = (prompt: string, images: Buffer[]): Part[] => [...images.map((i) => ({ type: 'image_url' as const, image_url: { url: dataUrl(i) } })), { type: 'text', text: prompt }];

/** A chat model's text answer to a prompt and images. */
export async function chat(label: string, model: string, prompt: string, images: Buffer[] = [], system?: string, schema?: Record<string, unknown>): Promise<Paid> {
  const body = await post(label, {
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: content(prompt, images) }],
    // Structured outputs: the model's answer is held to the shape, so it always parses.
    ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } } } : {}),
  });
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error(`${label} (${model}): empty answer${body.error?.message ? `: ${body.error.message}` : ''}`);
  return { data: Buffer.from(text, 'utf8'), usd: body.usage?.cost, via: model };
}

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const googleKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

/** A Gemini picture straight from Google: the model id without OpenRouter's "google/". */
async function paintGoogle(label: string, model: string, prompt: string, ratio: string, images: Buffer[]): Promise<Buffer> {
  const parts = [...images.map((i) => ({ inlineData: { mimeType: i[0] === 0xff && i[1] === 0xd8 ? 'image/jpeg' : 'image/png', data: i.toString('base64') } })), { text: prompt }];
  for (let n = 1; ; n++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(240_000),
      headers: { 'x-goog-api-key': googleKey()!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio } } }),
    });
    if (res.ok) {
      const body = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
      const data = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
      if (!data) throw new Error(`${label} (${model}): no image in the answer`);
      return Buffer.from(data, 'base64');
    }
    if (n === 4 || ![408, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`${label} (${model}): ${res.status} ${(await res.text()).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
  }
}

/**
 * Paints (no images) or edits (with images) like Muse Image. Muse answers a size request about 1.43x larger
 * (1712x1280 for 1200x896), so the picture is brought to that size: everything after reads it as a Muse answer.
 */
export async function paint(label: string, model: string, prompt: string, size: string, images: Buffer[] = []): Promise<Paid> {
  const [w, h] = size.split('x').map(Number);
  const ratio = RATIOS.reduce((best, r) => {
    const [a, b] = r.split(':').map(Number);
    const [c, d] = best.split(':').map(Number);
    return Math.abs(Math.log(a / b / (w / h))) < Math.abs(Math.log(c / d / (w / h))) ? r : best;
  });
  const fit = (image: Buffer) => sharp(image).resize(Math.round((w * 1712) / 1200), Math.round((h * 1280) / 896), { fit: 'fill' }).png().toBuffer();
  // Google's price is not in its answer; the budget counts the call, not its dollars.
  if (model.startsWith('google/') && googleKey()) return { data: await fit(await paintGoogle(label, model.slice(7), prompt, ratio, images)), via: model };
  const body = await post(label, { model, modalities: ['image', 'text'], image_config: { aspect_ratio: ratio }, messages: [{ role: 'user', content: content(prompt, images) }] });
  const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url?.startsWith('data:')) throw new Error(`${label} (${model}): no image in the answer${body.error?.message ? `: ${body.error.message}` : ''}`);
  return { data: await fit(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')), usd: body.usage?.cost, via: model };
}
