// Pictures the person hands the agent with a message (pasted, uploaded, a webcam photo): kept with the world
// under studio/pictures/, and shown to the agent as an image, so it sees what the person means.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

const PICTURE = /\.(png|jpe?g|webp|gif|heic|heif|avif)$/i;
const FILE = /^studio\/pictures\/[0-9]{2,4}\.jpg$/;

defineAction({
  name: 'picture_add',
  description: 'Keep a picture the person hands you with a message (pasted, uploaded or a webcam photo) with a world, as studio/pictures/NN.jpg. For the Studio\'s chat; the agent reads one with picture_view.',
  input: z.object({
    slug: Slug,
    name: z.string().min(1).max(120).describe('the file name, for its extension'),
    data: z.string().min(10).describe('the file, base64 (a data: URL is fine)'),
  }),
  async run({ slug, name, data }, ctx) {
    if (!PICTURE.test(name)) throw new ActionError(400, `${name}: a picture is png, jpg, webp, gif, heic or avif`);
    const dir = path.join(ctx.root, slug, 'studio', 'pictures');
    let jpeg: Buffer;
    try {
      jpeg = await sharp(Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64')).rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    } catch {
      throw new ActionError(400, `${name} is not a picture this machine can read`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const taken = fs.readdirSync(dir).map((f) => Number.parseInt(f, 10)).filter(Number.isFinite);
    const file = `${String(Math.max(0, ...taken) + 1).padStart(2, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), jpeg);
    return { file: `studio/pictures/${file}` };
  },
});

defineAction({
  name: 'picture_view',
  reads: true,
  description: 'Look at a picture the person handed you with their message: a message that starts with "[Pictures: studio/pictures/01.jpg, …]" comes with them. Call this for each one before you answer.',
  input: z.object({ slug: Slug, file: z.string().regex(FILE).describe('as the message names it, studio/pictures/NN.jpg') }),
  async run({ slug, file }, ctx) {
    const at = path.join(ctx.root, slug, file);
    if (!fs.existsSync(at)) throw new ActionError(404, `${slug} has no ${file}`);
    return { picture: file, images: [{ mimeType: 'image/jpeg', data: fs.readFileSync(at).toString('base64') }] };
  },
});
