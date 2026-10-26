// diorama reel <slug> [place]: the build-up of a place as a video, one beat per step (film/reel-<place>.mp4).
import { execFileSync } from 'node:child_process';
import { placeBeats, SCREEN } from '../film/reel.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'reel',
  usage: 'reel <slug> [place]  the build-up of a place as a video, a beat per step (film/reel-<place>.mp4) [--beat 7] [--fade 0.6] [--clean: no captions]',
  async run(args) {
    const beat = Number(takeOption(args, 'beat', '7'));
    const fade = Number(takeOption(args, 'fade', '0.6'));
    const clean = args.includes('--clean');
    const [slug, only] = args.filter((a) => a !== '--clean');
    if (!slug) throw new Error('usage: diorama reel <slug> [place]');
    const files = new WorldFiles(slug);
    const placeKey = only ?? files.world().start;
    const beats = await placeBeats(files, placeKey, clean);
    if (beats.length < 2) throw new Error(`${placeKey} has ${beats.length} step(s) to show; run diorama build first`);

    const name = `reel-${placeKey}${clean ? '-clean' : ''}`;
    const stills = beats.map((b, i) => {
      const file = files.path('film', name, `${String(i + 1).padStart(2, '0')}-${b.key}.png`);
      files.write(file, b.still);
      return file;
    });
    // Each still holds for one beat; a transition overlaps the end of one beat with the start of the next,
    // so beat i starts at i * beat seconds and the film's cuts land on the click track.
    const inputs = stills.flatMap((f, i) => ['-loop', '1', '-t', String(beat + (i < stills.length - 1 ? fade : 0)), '-i', f]);
    let chain = '';
    let last = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = i === stills.length - 1 ? '[out]' : `[x${i}]`;
      chain += `${last}[${i}:v]xfade=transition=${beats[i].enter}:duration=${fade}:offset=${i * beat}${out};`;
      last = out;
    }
    const mp4 = files.path('film', `${name}.mp4`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${chain}[out]fps=30,format=yuv420p[v]`, '-map', '[v]',
      '-s', `${SCREEN.width}x${SCREEN.height}`, '-c:v', 'libx264', '-crf', '20', mp4], { stdio: 'inherit' });
    files.write(files.path('film', `${name}.json`), {
      place: placeKey, beat, fade,
      beats: beats.map((b, i) => ({ key: b.key, title: b.title, by: b.by, start: i * beat, still: stills[i] })),
    });
    console.log(`${mp4}: ${beats.length} beats (${beats.map((b) => b.key).join(' > ')}), ${beats.length * beat}s`);
  },
});
