// The hero as a 3D model: TRELLIS reconstructs a textured mesh from Muse's front view, then
// Make-It-Animatable gives it a humanoid skeleton (Mixamo bone names) and skin weights. Both run as
// public Hugging Face Spaces (MIT); their answers are kept in the world's memo like model calls.
import { inputHash, type Memo } from '../meta/memo.ts';
import { filesNamed, Space } from './space.ts';

export const TRELLIS = 'trellis-community/TRELLIS';
export const AUTORIG = 'jasongzy/Make-It-Animatable';

/** Front view (PNG) to a textured GLB, about 30 s of GPU. */
export async function reconstruct(memo: Memo, key: string, front: Buffer, seed = 1): Promise<Buffer> {
  return memo.remember('space', `${key}-trellis`, inputHash(TRELLIS, String(seed), front), 'glb', async () => {
    const space = new Space(TRELLIS);
    // The app keeps each session's files in its own folder, made when the page loads.
    await space.call('start_session', []);
    const image = await space.upload('front.png', front);
    const [pre] = await space.call('preprocess_image', [image]);
    const cut = await space.upload('cut.png', await space.download(pre[0] as { path: string; url?: string }));
    // image, multiimages, seed, ss guidance + steps, slat guidance + steps, multiimage algo, mesh simplify, texture size
    const events = await space.call('generate_and_extract_glb', [cut, [], seed, 7.5, 12, 3.0, 12, 'stochastic', 0.95, 1024]);
    const [glb] = filesNamed(events, '.glb');
    if (!glb) throw new Error('TRELLIS answered without a model');
    return space.download(glb);
  });
}

/** Textured GLB to a skinned GLB in its own pose (no reset to a T-pose, no animation), about 15 s of GPU. */
export async function autoRig(memo: Memo, key: string, model: Buffer): Promise<Buffer> {
  return memo.remember('space', `${key}-rig`, inputHash(AUTORIG, 'keep-pose', model), 'glb', async () => {
    const space = new Space(AUTORIG);
    const input = await space.upload(`${key}.glb`, model);
    // input, no fingers, rest pose, rest parts, gaussian, opacity, input normals, weight fix, bone shown,
    // reset to rest, animation file, retarget, in place
    await space.call('pipeline', [input, true, 'No', [], false, 0.01, false, true, 'LeftArm', false, null, true, true]);
    // The pipeline keeps joints and weights in the session; the Blender step after it writes the rigged model.
    // reset to rest, no fingers, rest pose, rest parts, animation file, retarget, in place
    const events = await space.call('vis_blender', [false, true, 'No', [], null, true, true]);
    const rigged = filesNamed(events, `${key}.glb`)[0] ?? filesNamed(events, '.glb').find((f) => !/joints|normed|sample|bw|rest/.test(f.path));
    if (!rigged) throw new Error('auto-rig answered without a rigged model');
    return space.download(rigged);
  });
}
