// Sound made on the spot for a world that has none of its own: a quiet music bed when the world has no music,
// and rain and sea when a place has no ambience but its weather rains or its painting holds water. A player who
// found a silent game asked three times where the music was; a missing or rejected take should never mean silence.

/** A, then F, C, G: a slow, kind minor loop that sits under any story without telling it how to feel. */
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
const BAR = 4.8;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Synth {
  private noise: AudioBuffer;
  private rain?: { gain: GainNode };
  private sea?: { gain: GainNode };
  private music?: { out: GainNode; timer: number; next: number; bar: number };

  constructor(private ctx: AudioContext, private musicBus: AudioNode, private master: AudioNode) {
    const n = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    // Pink-ish noise (Paul Kellet's filter): softer than white, so rain is not a hiss.
    let [b0, b1, b2] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
  }

  private noiseThrough(filters: BiquadFilterNode[], out: AudioNode): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    let node: AudioNode = src;
    for (const f of filters) node = node.connect(f);
    node.connect(out);
    src.start(0, Math.random() * 2);
    return src;
  }

  /** The place's own air: rain by how hard it falls, the sea's wash rolling in and out. 0 leaves each out. */
  ambience(rain: number, sea: boolean) {
    const now = this.ctx.currentTime;
    if (rain > 0 && !this.rain) {
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      this.noiseThrough([new BiquadFilterNode(this.ctx, { type: 'highpass', frequency: 700 }), new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 6500 })], gain);
      this.rain = { gain };
    }
    this.rain?.gain.gain.setTargetAtTime(rain > 0 ? 0.025 + 0.05 * rain : 0, now, 0.8);
    if (sea && !this.sea) {
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const swell = this.ctx.createGain();
      swell.gain.value = 0.6;
      // Waves: the wash swells and falls back every seven seconds or so.
      const lfo = new OscillatorNode(this.ctx, { frequency: 0.14 });
      const depth = new GainNode(this.ctx, { gain: 0.4 });
      lfo.connect(depth).connect(swell.gain);
      lfo.start();
      swell.connect(gain).connect(this.master);
      this.noiseThrough([new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 520, Q: 0.4 })], swell);
      this.sea = { gain };
    }
    this.sea?.gain.gain.setTargetAtTime(sea ? 0.12 : 0, now, 0.8);
  }

  /** The music bed: soft pad chords and a few music-box notes over them, scheduled a little ahead. */
  startMusic() {
    if (this.music) return;
    const out = this.ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(2, this.ctx.currentTime, 2);
    // A short echo for the music box, so the notes hang in the air.
    const echo = new DelayNode(this.ctx, { delayTime: 0.36 });
    const back = new GainNode(this.ctx, { gain: 0.32 });
    const wet = new GainNode(this.ctx, { gain: 0.4 });
    echo.connect(back).connect(echo);
    echo.connect(wet).connect(out);
    out.connect(this.musicBus);
    const music = { out, timer: 0, next: this.ctx.currentTime + 0.3, bar: 0 };
    const box = (midi: number, at: number, level: number) => {
      const o = new OscillatorNode(this.ctx, { type: 'sine', frequency: hz(midi) });
      const o2 = new OscillatorNode(this.ctx, { type: 'sine', frequency: hz(midi) * 3.01 });
      const g = new GainNode(this.ctx, { gain: 0 });
      const g2 = new GainNode(this.ctx, { gain: 0.12 });
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(out);
      g.connect(echo);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(level, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);
      o.start(at);
      o2.start(at);
      o.stop(at + 1.9);
      o2.stop(at + 1.9);
    };
    const pad = (notes: number[], at: number) => {
      const lp = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 900 });
      const g = new GainNode(this.ctx, { gain: 0 });
      lp.connect(g).connect(out);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.022, at + 1.6);
      g.gain.setValueAtTime(0.022, at + BAR - 0.4);
      g.gain.linearRampToValueAtTime(0, at + BAR + 1.4);
      for (const n of [notes[0] - 12, ...notes]) for (const detune of [-6, 6]) {
        const o = new OscillatorNode(this.ctx, { type: 'triangle', frequency: hz(n), detune });
        o.connect(lp);
        o.start(at);
        o.stop(at + BAR + 1.5);
      }
    };
    const tick = () => {
      while (music.next < this.ctx.currentTime + 0.5) {
        const at = music.next;
        const chord = CHORDS[music.bar % CHORDS.length];
        pad(chord, at);
        // Eight slots a bar, about half of them a note: chord tones an octave or two up, now and then the ninth.
        for (let k = 0; k < 8; k++) {
          if (Math.random() > (k % 2 ? 0.25 : 0.55)) continue;
          const tones = [...chord.map((n) => n + 12), chord[0] + 14, chord[0] + 24];
          box(tones[Math.floor(Math.random() * tones.length)], at + (k * BAR) / 8 + Math.random() * 0.02, 0.05 + Math.random() * 0.03);
        }
        music.next += BAR;
        music.bar++;
      }
    };
    tick();
    music.timer = window.setInterval(tick, 250);
    this.music = music;
  }
}
