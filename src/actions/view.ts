// Looking at a place the way the fix tools see it: what the hero can and cannot reach, and why.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { Geometry } from '../play/geometry.ts';
import { diagnose, diagnosisPicture } from '../scene/diagnose.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

defineAction({
  name: 'place_view',
  reads: true,
  description: 'Look at a place\'s walkable floor: a picture (the painting with the 60 px cell grid floor_cells takes, reached floor green, '
    + 'unreached floor red, each gap to bridge as a yellow dashed line, unreachable stand spots red, the start green) and the same in words: '
    + 'per floor how much is reached, each unreached patch with the cells of its shortest gap and the things standing in it, and stand spots '
    + 'off the floor with the nearest reachable point. Use it before floor_cells, stand_set or mask_fix kind.',
  input: z.object({ slug: Slug, place: z.string().min(1) }),
  async run({ slug, place }, ctx) {
    const dir = path.join(ctx.root, slug, 'places', place);
    const at = (f: string) => path.join(dir, f);
    if (!fs.existsSync(at('geometry.json'))) throw new ActionError(404, `${slug}/${place} has no geometry.json yet: build it up to derive first`);
    const g = Geometry.parse(JSON.parse(fs.readFileSync(at('geometry.json'), 'utf8')));
    const diagnosis = diagnose(g);
    const painting = ['painting.png', 'blockin.png'].map(at).find((f) => fs.existsSync(f));
    if (!painting) return { diagnosis };
    const picture = await diagnosisPicture(fs.readFileSync(painting), g, diagnosis);
    // Kept beside the other review pictures, so the page can show what the agent looked at.
    fs.writeFileSync(at('diagnose.png'), picture);
    const jpeg = await sharp(picture).jpeg({ quality: 78 }).toBuffer();
    return { diagnosis, picture: `places/${place}/diagnose.png`, images: [{ mimeType: 'image/jpeg', data: jpeg.toString('base64') }] };
  },
});
