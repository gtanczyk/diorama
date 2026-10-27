// Model answers are stored by a hash of everything that went in, so a rerun with the same
// inputs costs nothing, and any change to a prompt or image asks the model again.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** sound: ElevenLabs effects and music; music: MusicGen run locally; voice: speech and its Muse Voice transcript. */
/** space: a Hugging Face Space (TRELLIS, auto-rig), not a Meta model; its answers are kept the same way. */
export type ModelName = 'spark' | 'muse' | 'sam' | 'sound' | 'music' | 'voice' | 'space';

const SHARED = new Set<ModelName>(['sound', 'music', 'voice']);

export function inputHash(...parts: (string | Buffer)[]): string {
  const h = createHash('sha256');
  for (const part of parts) h.update(part).update('\u0000');
  return h.digest('hex').slice(0, 32);
}

export class Memo {
  /** Calls actually sent to each model in this process (cache hits are not counted). */
  readonly sent: Record<ModelName, number> = { spark: 0, muse: 0, sam: 0, sound: 0, music: 0, voice: 0, space: 0 };

  constructor(readonly dir: string) {}

  async remember(model: ModelName, label: string, hash: string, ext: string, ask: () => Promise<Buffer>): Promise<Buffer> {
    const file = path.join(this.dir, model, `${hash}.${ext}`);
    // Paid audio is also kept for every world on this machine: another world asking the same pays nothing.
    const shared = SHARED.has(model) ? path.join(process.env.DIORAMA_CACHE || path.join(os.homedir(), '.cache', 'diorama'), 'memo', model, `${hash}.${ext}`) : undefined;
    for (const f of [file, shared]) {
      if (!f || !fs.existsSync(f)) continue;
      this.log({ model, label, hash, ms: 0, hit: true });
      const answer = fs.readFileSync(f);
      if (f !== file) (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, answer));
      return answer;
    }
    const started = Date.now();
    const answer = await ask();
    for (const f of [file, shared]) if (f) (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, answer));
    this.sent[model]++;
    this.log({ model, label, hash, ms: Date.now() - started, hit: false });
    return answer;
  }

  /** Whether an answer is kept, here or in the cache every world shares. */
  has(model: ModelName, hash: string, ext: string): boolean {
    return fs.existsSync(path.join(this.dir, model, `${hash}.${ext}`)) || (SHARED.has(model) && fs.existsSync(path.join(process.env.DIORAMA_CACHE || path.join(os.homedir(), '.cache', 'diorama'), 'memo', model, `${hash}.${ext}`)));
  }

  /** Forgets one answer, e.g. a reply that failed its gate and must be asked again. */
  forget(model: ModelName, hash: string, ext: string) {
    fs.rmSync(path.join(this.dir, model, `${hash}.${ext}`), { force: true });
  }

  private log(entry: { model: ModelName; label: string; hash: string; ms: number; hit: boolean }) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, 'calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }
}
