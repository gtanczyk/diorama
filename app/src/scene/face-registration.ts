import sharp from 'sharp';
import type { Box, FacePose } from '../play/lipsync.ts';

/** The cut-out PNG is cropped; the rig retains its padded paint canvas. Their dimensions are not equivalent. */
export async function alphaBounds(image: Buffer): Promise<Box> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] > 32) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) throw new Error('Cannot register an empty figure');
  return [left, top, right - left + 1, bottom - top + 1];
}

export async function registerRigFace(pose: FacePose, cropped: Buffer, standing: Buffer, sheetScale = 1): Promise<FacePose> {
  const [a, b] = await Promise.all([alphaBounds(cropped), alphaBounds(standing)]);
  const sx = b[2] / a[2] / sheetScale, sy = b[3] / a[3] / sheetScale;
  const dx = b[0] / sheetScale - a[0] * sx, dy = b[1] / sheetScale - a[1] * sy;
  const transform = ([x, y, w, h]: Box): Box => [x * sx + dx, y * sy + dy, w * sx, h * sy];
  return { ...pose, mouth: transform(pose.mouth), eyes: pose.eyes.map(transform), ...(pose.lips ? { lips: transform(pose.lips) } : {}), ...(pose.suggestedLips ? {suggestedLips:transform(pose.suggestedLips)} : {}) };
}
