import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineAction } from './registry.ts';
import { VIDEO_CHUNK, VIDEO_MAX, VIDEO_STEP, VideoId, inspectVideo, readVideoPart, save, videoDir, videoState } from '../world/video.ts';

defineAction({ name: 'video_upload', description: 'Upload a video brief in ordered chunks, up to 2 GB and 4 hours. Start with name and size, then send id, byte offset and base64 data. Repeated identical chunks are safe.', input: z.object({ id: VideoId.optional(), name: z.string().max(200).optional(), size: z.number().int().positive().max(VIDEO_MAX).optional(), offset: z.number().int().nonnegative().optional(), data: z.string().max(Math.ceil(VIDEO_CHUNK / 3) * 4 + 4).optional() }), async run(input, ctx) {
  if (!input.id) {
    if (!input.name || !/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(input.name) || !input.size) throw new Error('Choose an MP4, MOV, WebM, MKV, M4V or AVI video, up to 2 GB.');
    const id = randomBytes(16).toString('hex'), dir = videoDir(ctx.root, id);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'source'), '');
    save(path.join(dir, 'upload.json'), { name: input.name, size: input.size, received: 0 }); return { id, received: 0 };
  }
  const dir = videoDir(ctx.root, input.id), state = videoState(dir), file = path.join(dir, 'source');
  if (input.offset === undefined || !input.data) return { id: input.id, received: state.received };
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length || bytes.length > VIDEO_CHUNK || input.offset + bytes.length > state.size) throw new Error('Invalid video chunk size.');
  if (input.offset < state.received) {
    const fd = fs.openSync(file, 'r'); const old = Buffer.alloc(bytes.length);
    try { fs.readSync(fd, old, 0, bytes.length, input.offset); } finally { fs.closeSync(fd); }
    if (input.offset + bytes.length > state.received || !old.equals(bytes)) throw new Error('Conflicting video chunk.');
    return { id: input.id, received: state.received };
  }
  if (input.offset !== state.received) throw new Error(`Resume the video at byte ${state.received}.`);
  // Positional writes also recover safely if the process stops before saving the offset.
  const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, bytes, 0, bytes.length, input.offset); } finally { fs.closeSync(fd); }
  state.received += bytes.length; save(path.join(dir, 'upload.json'), state);
  return { id: input.id, received: state.received };
} });
defineAction({ name: 'video_inspect', description: 'Finish a video upload, inspect duration and audio, and report how many intervals need analysis.', input: z.object({ id: VideoId }), async run({ id }, ctx) {
  const state = await inspectVideo(videoDir(ctx.root, id)); return { ...state, parts: Math.ceil(state.duration / VIDEO_STEP) };
} });
defineAction({ name: 'video_read', description: 'Read one 30-second interval of a movie, with frames and timestamped speech; intervals run in order. Results are cached for resuming.', input: z.object({ id: VideoId, index: z.number().int().nonnegative(), note: z.string().max(4000).default('') }), async run({ id, index, note }, ctx) { return readVideoPart(ctx.root, id, index, note); } });
defineAction({ name: 'video_result', description: 'Return a completed video interpretation and useful reference frames for review before creating a world. Keeps the source and full timestamped evidence.', input: z.object({ id: VideoId }), async run({ id }, ctx) {
  const dir = videoDir(ctx.root, id), state = videoState(dir);
  if (!state.duration) throw new Error('Inspect the video first.');
  const count = Math.ceil(state.duration / VIDEO_STEP);
  const parts = Array.from({ length: count }, (_, i) => JSON.parse(fs.readFileSync(path.join(dir, `part-${i}.json`), 'utf8')));
  const selected = parts.flatMap((p) => p.reading.frames.filter((f: { use: boolean }) => f.use).map((f: { at: number }) => f.at)) as number[];
  // Review capacity is explicit. All intervals remain archived even when only 32 reference images fit the world.
  const times = selected.length <= 32 ? selected : Array.from({ length: 32 }, (_, i) => selected[Math.round(i * (selected.length - 1) / 31)]);
  return { idea: parts.at(-1).reading.idea, observations: parts.map((p, i) => ({ at: i * VIDEO_STEP, text: p.reading.observations })), totalFrames: selected.length,
    speech: parts.flatMap((p, i) => p.speech ? [{ at: i * VIDEO_STEP, ...p.speech }] : []),
    photos: times.map((at) => ({ name: `video-${id.slice(0, 6)}-${at}s.jpg`, data: `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, `frame-${at}.jpg`)).toString('base64')}` })) };
} });
