// Muse Image: paints from a prompt, or from reference images whose layout it keeps.
import { metaPost } from './http.ts';
import { inputHash, type Memo } from './memo.ts';
import { imageChoice } from './choice.ts';
import { IMAGE_MODELS, paint } from './openrouter.ts';
import { PRICES } from './prices.ts';

export const MUSE = 'muse-image-1.0';

/**
 * Which model paints (Studio Setup, or DIORAMA_IMAGE_VIA): "meta" (Muse Image, the default), a short name from IMAGE_MODELS
 * (gemini-flash, gemini-lite, nano-banana, gemini-pro) or any OpenRouter image model id. Another model's
 * pictures are kept under their own memo keys, so switching back finds the Muse ones again.
 */
export function imageVia(): string | null {
  const via = imageChoice();
  return !via || via === 'meta' ? null : (IMAGE_MODELS[via] ?? via);
}

type MuseAsk = { label: string; prompt: string; size?: string; /** Changes only the memo key, to get a new take. */ take?: number };

async function firstImage(res: Response, label: string): Promise<Buffer> {
  const body = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = body.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new Error(`muse ${label}: no image in the answer`);
}

// Without output_format the API answers WebP; everything downstream reads PNG.
const PNG_OUT = { n: 1, response_format: 'b64_json', output_format: 'png' } as const;

export async function musePaint(memo: Memo, { label, prompt, size = '1200x896', take = 0 }: MuseAsk): Promise<Buffer> {
  const via = imageVia();
  if (via) return memo.remember('muse', label, inputHash(via, 'paint', size, String(take), prompt), 'png', () => paint(label, via, prompt, size));
  return memo.remember('muse', label, inputHash(MUSE, 'paint', size, String(take), prompt), 'png', async () =>
    ({ data: await firstImage(await metaPost('/images/generations', { model: MUSE, prompt, size, ...PNG_OUT }), label), usd: PRICES.museImage }));
}

export async function museEdit(memo: Memo, { label, prompt, size = '1200x896', take = 0, images }: MuseAsk & { images: Buffer[] }): Promise<Buffer> {
  if (images.length === 0) throw new Error(`muse ${label}: an edit needs an image`);
  const via = imageVia();
  if (via) return memo.remember('muse', label, inputHash(via, 'edit', size, String(take), prompt, ...images), 'png', () => paint(label, via, prompt, size, images));
  return memo.remember('muse', label, inputHash(MUSE, 'edit', size, String(take), prompt, ...images), 'png', async () => ({
    usd: PRICES.museImage,
    data: await firstImage(await metaPost('/images/edits', {
      model: MUSE,
      prompt,
      size,
      images: images.map((image) => ({ image_url: `data:image/png;base64,${image.toString('base64')}` })),
      reasoning_strength: 'low',
      tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
      ...PNG_OUT,
    }), label),
  }));
}
