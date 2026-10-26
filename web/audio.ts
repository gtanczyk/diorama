// The play page's sound: a music bed, the place's ambience, loops that pan and fade with where the hero
// stands, footsteps on the floor under him, and one-shots for what happens in the story. Web Audio only.
import { personPx, type GeoThing, type Geometry } from '../src/play/geometry.ts';
import { levelGain, placeSound, zoneAt, type SoundData } from '../src/play/sound.ts';
import { holds, type State } from '../src/story/engine.ts';

/** What the mixer reads from the game each frame. */
export type Listened = {
  data: { sound?: SoundData };
  place?: { key: string; g: Geometry; hots: Array<{ thing: GeoThing }> };
  hero: { x: number; y: number; phase: number; path: unknown[] };
  state: State;
  viewX: number;
  speech: unknown;
  gone(): Set<string>;
  on(fn: (event: string, detail: Record<string, unknown>) => void): void;
};

type Voice = { src: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode };

const FADE = 0.6;

export class Mixer {
  readonly ctx = new AudioContext();
  private master = this.ctx.createGain();
  private musicBus = this.ctx.createGain();
  private limiter = new DynamicsCompressorNode(this.ctx, { threshold: -14, knee: 8, ratio: 8, attack: 0.004, release: 0.25 });
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | undefined>>();
  /** Running loops by id: the music, the bed, and the things of this place. */
  private voices = new Map<string, Voice>();
  private lastStep = 0;
  private lastUsed: string | undefined;
  private seen: { items: string[]; flags: string[]; talk: boolean } | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  muted = false;
  /** What started when, on the audio clock: for QA and for laying sound under a recording. */
  readonly log: Array<{ at: number; id: string; kind: string }> = [];

  constructor(private game: Listened, private url: (file: string) => string) {
    // A soft limiter at the end: one-shots on top of loops and music never clip.
    this.musicBus.connect(this.master);
    this.master.connect(this.limiter).connect(this.ctx.destination);
    // Browsers start audio only after a gesture; the first click or key resumes it.
    const resume = () => void this.ctx.resume();
    addEventListener('pointerdown', resume, { capture: true });
    addEventListener('keydown', resume, { capture: true });
    // Buttons (inventory, conversation choices) click.
    addEventListener('click', (e) => {
      if ((e.target as HTMLElement | null)?.closest?.('button')) this.shot('click');
    }, { capture: true });
    game.on((event, detail) => {
      if (event === 'enter') void this.enter(String(detail.place));
      if (event === 'use') this.lastUsed = String(detail.thing);
      if (event === 'exit' && this.lastUsed) this.shot(`exit:${this.lastUsed}`);
      if (event === 'ending') this.shot('ending');
    });
  }

  get sound(): SoundData | undefined {
    return this.game.data.sound;
  }

  private buffer(id: string): Promise<AudioBuffer | undefined> {
    const entry = this.sound?.files[id];
    if (!entry) return Promise.resolve(undefined);
    if (!this.loading.has(id)) {
      this.loading.set(id, fetch(this.url(entry.file))
        .then((r) => r.arrayBuffer())
        .then((bytes) => this.ctx.decodeAudioData(bytes))
        .then((buf) => (this.buffers.set(id, buf), buf))
        .catch(() => undefined));
    }
    return this.loading.get(id)!;
  }

  private async start(id: string, gain: number, bus: AudioNode = this.master) {
    if (this.voices.has(id)) return;
    const buf = await this.buffer(id);
    if (!buf || this.voices.has(id)) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    const pan = this.ctx.createStereoPanner();
    g.gain.value = 0;
    g.gain.setTargetAtTime(gain, this.ctx.currentTime, FADE / 3);
    src.connect(g).connect(pan).connect(bus);
    // Start somewhere inside the loop, so two places with the same take never sound in step.
    src.start(0, Math.random() * buf.duration);
    this.voices.set(id, { src, gain: g, pan });
    this.log.push({ at: this.ctx.currentTime, id, kind: 'loop' });
  }

  private stop(id: string) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, FADE / 3);
    v.src.stop(this.ctx.currentTime + FADE * 2);
  }

  /** A new place: its bed and loops fade in, the last place's fade out; the music carries on. */
  async enter(place: string) {
    const sound = this.sound;
    if (!sound) return;
    // Everything loads on the first place, so later one-shots and footsteps are ready when they fire.
    if (!this.loading.size) for (const id of Object.keys(sound.files)) void this.buffer(id);
    if (sound.music) void this.start(sound.music, levelGain('music', 2), this.musicBus);
    const here = sound.places[place];
    const keep = new Set([sound.music, here?.bed].filter(Boolean));
    for (const id of [...this.voices.keys()]) if (!keep.has(id)) this.stop(id);
    if (here?.bed) void this.start(here.bed, levelGain('bed', 2));
  }

  /** A one-shot, panned to where it happens. */
  shot(trigger: string, x?: number) {
    const id = this.sound?.shots[trigger];
    const buf = id ? this.buffers.get(id) : undefined;
    if (!id || !buf) return;
    this.play(id, buf, levelGain('shot', this.sound!.files[id].level), x === undefined ? 0 : this.panAt(x));
  }

  private play(id: string, buf: AudioBuffer, gain: number, pan: number, offset = 0, duration?: number, rate = 1) {
    this.log.push({ at: this.ctx.currentTime, id, kind: duration ? 'step' : 'shot' });
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.master);
    if (duration) {
      // A short fade at the cut, so a sliced footstep never clicks.
      g.gain.setValueAtTime(gain, this.ctx.currentTime + duration / rate - 0.03);
      g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + duration / rate);
    }
    src.start(0, offset, duration);
  }

  private panAt(x: number): number {
    const g = this.game.place?.g;
    if (!g) return 0;
    return placeSound(x, 0, x, 0, this.game.viewX || g.frame.width / 2, g.frame.width, 1).pan;
  }

  /** Every frame: loops follow the hero, footsteps follow his walk, story changes sound. */
  update() {
    const { game } = this;
    const sound = this.sound;
    const place = game.place;
    if (!sound || !place || this.ctx.state !== 'running') return;
    const here = sound.places[place.key];
    const g = place.g;
    const now = this.ctx.currentTime;
    const heroPx = personPx(g, game.hero.y);
    const gone = game.gone();

    for (const loop of here?.loops ?? []) {
      const hot = place.hots.find((h) => h.thing.key === loop.thing);
      const on = !!hot && !gone.has(loop.thing) && holds(game.state, loop.when);
      if (!on) {
        this.stop(loop.id);
        continue;
      }
      const [x0, , x1, y1] = hot.thing.box;
      const at = placeSound((x0 + x1) / 2, y1, game.hero.x, game.hero.y, game.viewX || g.frame.width / 2, g.frame.width, heroPx);
      const voice = this.voices.get(loop.id);
      if (!voice) void this.start(loop.id, at.gain * levelGain('loop', loop.level));
      else {
        voice.gain.gain.setTargetAtTime(at.gain * levelGain('loop', loop.level), now, 0.15);
        voice.pan.pan.setTargetAtTime(at.pan, now, 0.15);
      }
    }
    // Music steps back while someone speaks.
    this.musicBus.gain.setTargetAtTime(game.speech ? 0.55 : 1, now, 0.3);

    // Two footsteps per walk cycle; the floor under the hero picks the surface.
    const step = Math.floor(game.hero.phase * 2);
    if (step !== this.lastStep) {
      this.lastStep = step;
      const id = here?.zones[zoneAt(g.zone, g.cell, game.hero.x, game.hero.y)] ?? here?.zones.find(Boolean);
      const buf = id ? this.buffers.get(id) : undefined;
      const slices = id ? sound.files[id].slices : undefined;
      if (buf && slices?.length) {
        const [offset, duration] = slices[Math.floor(Math.random() * slices.length)];
        // Farther away is quieter; a little pitch and level jitter so no two steps repeat exactly.
        const depth = Math.min(1, heroPx / (g.frame.height * 0.45));
        this.play(id!, buf, levelGain('step', 2) * (0.45 + 0.55 * depth) * (0.85 + Math.random() * 0.3), this.panAt(game.hero.x) * 0.6, offset, duration, 0.93 + Math.random() * 0.14);
      }
    }

    // What the story just did: an item taken, a thing used to change something, a conversation opened.
    const s = game.state;
    const seen = this.seen;
    if (seen) {
      const hot = place.hots.find((h) => h.thing.key === this.lastUsed);
      const x = hot ? (hot.thing.box[0] + hot.thing.box[2]) / 2 : undefined;
      if (s.items.some((i) => !seen.items.includes(i))) this.shot('take', x);
      else if (s.flags.some((f) => !seen.flags.includes(f)) && this.lastUsed) this.shot(`use:${this.lastUsed}`, x);
      if (s.talk && !seen.talk) this.shot('talk', x);
    }
    this.seen = { items: [...s.items], flags: [...s.flags], talk: !!s.talk };
  }

  toggleMute() {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  /** For recordings: everything the page plays, into a webm the recorder can lay under its video. */
  record() {
    const out = this.ctx.createMediaStreamDestination();
    this.limiter.connect(out);
    this.chunks = [];
    this.recorder = new MediaRecorder(out.stream, { mimeType: 'audio/webm;codecs=opus' });
    this.recorder.ondataavailable = (e) => this.chunks.push(e.data);
    this.recorder.start(1000);
  }

  /** Stops recording; the webm as base64. */
  async stopRecording(): Promise<string> {
    const rec = this.recorder;
    if (!rec) return '';
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    const bytes = new Uint8Array(await new Blob(this.chunks, { type: 'audio/webm' }).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
}
