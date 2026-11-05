// The hero's car (a drive place, kind "drive") is parked in every place it drives to. Muse paints each place on its
// own, so without a reference each parks a different car; the car as painted in the drive place, cut out by its
// mask, goes to every such place's painting as how the car looks.
import fs from 'node:fs';
import sharp from 'sharp';
import type { WorldFiles } from '../world/files.ts';
import type { Place, World } from '../world/schema.ts';

/** The drive place's car, cut out on white, for a place it is parked in; undefined before it is painted and masked. */
export async function heroVehicle(files: WorldFiles, world: World, place: Place): Promise<Buffer | undefined> {
  const drive = world.places.find((p) => p.kind === 'drive');
  if (!drive || drive.key === place.key || !place.exits.some((e) => e.to === drive.key)) return undefined;
  const car = drive.exits[0]?.via;
  const [painting, mask] = [files.place(drive.key, 'painting.png'), files.place(drive.key, 'masks', `${car}.png`)];
  if (!car || !fs.existsSync(painting) || !fs.existsSync(mask)) return undefined;
  const { width, height } = await sharp(painting).metadata();
  const alpha = await sharp(mask).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
  const cut = await sharp(painting).removeAlpha().joinChannel(alpha, { raw: { width: width!, height: height!, channels: 1 } }).png().toBuffer();
  return sharp(cut).trim().flatten({ background: '#ffffff' }).png().toBuffer();
}

export const VEHICLE_PROMPT = 'shows the hero\'s car: wherever the car stands in this place, paint exactly this car (body shape, colour, trim, wheels), parked and seen from this place\'s camera; whoever sits in it is not part of it, and nothing else in that image belongs in the place.';
