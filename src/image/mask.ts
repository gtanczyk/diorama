// A mask is one byte per pixel (0 or 1) at the size of the image it belongs to.
import sharp from 'sharp';

export type Mask = { width: number; height: number; bits: Uint8Array };

export const emptyMask = (width: number, height: number): Mask => ({ width, height, bits: new Uint8Array(width * height) });

export const maskArea = (m: Mask) => m.bits.reduce((sum, b) => sum + b, 0);

/** Writes a mask as an 8-bit grayscale PNG (0 / 255). */
export function maskToPng(m: Mask): Promise<Buffer> {
  const gray = Buffer.alloc(m.bits.length);
  for (let i = 0; i < gray.length; i++) gray[i] = m.bits[i] ? 255 : 0;
  return sharp(gray, { raw: { width: m.width, height: m.height, channels: 1 } }).png().toBuffer();
}

/** Reads any image as a mask: a pixel is set when its gray value is above the midpoint. */
export async function maskFromPng(png: Buffer): Promise<Mask> {
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  const bits = new Uint8Array(info.width * info.height);
  for (let i = 0; i < bits.length; i++) bits[i] = data[i * info.channels] > 127 ? 1 : 0;
  return { width: info.width, height: info.height, bits };
}

export async function imageSize(image: Buffer): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(image).metadata();
  if (!width || !height) throw new Error('unreadable image');
  return { width, height };
}
