// SAM 3.1: finds every instance of one concept in an image, or one object per box.
import { buildObjectPrompt, decodeMaskToRaster, parseImageStream, recordsOfKind, type ResponsesEvent } from '@meta-sam/parser';
import { emptyMask, imageSize, type Mask } from '../image/mask.ts';
import { metaPost } from './http.ts';
import { inputHash, type Memo } from './memo.ts';

export const SAM = 'sam-3.1';

/** Pixel box; right and bottom are exclusive, as in @meta-sam/parser. */
export type Box = { left: number; top: number; right: number; bottom: number };
export type Found = { id: string; box: Box; confidence?: number; mask: Mask };
/** At most this many boxes go in one request. */
export const SAM_MAX_BOXES = 16;

async function* serverEvents(res: Response): AsyncIterable<ResponsesEvent> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (data && data !== '[DONE]') yield JSON.parse(data) as ResponsesEvent;
    }
  }
}

async function* fromText(text: string): AsyncIterable<ResponsesEvent> {
  const where = { item_id: 'memo', output_index: 0, content_index: 0 };
  yield { type: 'response.output_text.delta', ...where, delta: text };
  yield { type: 'response.output_text.done', ...where, text };
  yield { type: 'response.completed' };
}

async function records(events: AsyncIterable<ResponsesEvent>) {
  const stream = parseImageStream(events);
  for await (const _snapshot of stream);
  return stream.finalResult;
}

/** Turns SAM's output text into one full-size mask per instance found. */
export async function readSamOutput(text: string, width: number, height: number): Promise<Found[]> {
  const { records: all } = await records(fromText(text));
  return recordsOfKind(all, 'mask').map((r) => {
    const raster = decodeMaskToRaster(r.mask);
    const { left, top, right, bottom } = r.bounds;
    const mask = emptyMask(width, height);
    // The raster covers the bounds box at its own resolution.
    for (let y = Math.max(top, 0); y < Math.min(bottom, height); y++) {
      const ry = Math.floor(((y - top) / (bottom - top)) * r.mask.height);
      for (let x = Math.max(left, 0); x < Math.min(right, width); x++) {
        const rx = Math.floor(((x - left) / (right - left)) * r.mask.width);
        mask.bits[y * width + x] = raster[ry * r.mask.width + rx] ? 1 : 0;
      }
    }
    return { id: r.objectId, box: { left, top, right, bottom }, confidence: r.confidence, mask };
  });
}

/** Segments a PNG by a concept ("rowing boat") or by boxes. An empty list means nothing was found. */
export async function samFind(memo: Memo, { label, image, prompt }: { label: string; image: Buffer; prompt: string | Box[] }): Promise<Found[]> {
  const { width, height } = await imageSize(image);
  if (Array.isArray(prompt) && prompt.length > SAM_MAX_BOXES) throw new Error(`sam ${label}: at most ${SAM_MAX_BOXES} boxes per request`);
  const text = typeof prompt === 'string'
    ? prompt
    : buildObjectPrompt({ size: { width, height }, objects: prompt.map((box, id) => ({ id, prompts: [{ box }] })) });
  const output = await memo.remember('sam', label, inputHash(SAM, text, image), 'txt', async () => {
    const res = await metaPost('/responses', {
      model: SAM,
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text },
        { type: 'input_image', image_url: `data:image/png;base64,${image.toString('base64')}` },
      ] }],
      metadata: { include_confidence: 'true' },
      stream: true,
    }, 'text/event-stream');
    return Buffer.from((await records(serverEvents(res))).rawOutput, 'utf8');
  });
  return readSamOutput(output.toString('utf8'), width, height);
}
