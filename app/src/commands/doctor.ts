// diorama doctor: one live call per model, so a bad key or a changed API shows up before a build.
import fs from 'node:fs';
import path from 'node:path';
import { maskArea, maskToPng } from '../image/mask.ts';
import { Memo } from '../meta/memo.ts';
import { museEdit, musePaint } from '../meta/muse.ts';
import { samFind } from '../meta/sam.ts';
import { askSparkJson } from '../meta/spark.ts';
import { defineCommand } from '../registry.ts';

defineCommand({
  name: 'doctor',
  usage: 'doctor [dir] [--now]    check the API key with one call to Spark, Muse paint, Muse edit and SAM 3.1; --now skips the memo and says if the network and Meta are fast enough for a live build',
  async run(args) {
    const nowAt = args.indexOf('--now');
    if (nowAt >= 0) args.splice(nowAt, 1);
    const [dir = '.diorama/doctor'] = args;
    const out = path.resolve(dir);
    fs.mkdirSync(out, { recursive: true });
    // A memo hit takes no time, so --now asks afresh to measure this network and Meta as they are.
    const memo = new Memo(path.join(out, nowAt >= 0 ? `memo-${Date.now()}` : 'memo'));
    let failed = 0;
    const took: Record<string, number> = {};
    async function check<T>(name: string, run: () => Promise<T>, describe: (v: T) => string): Promise<T | undefined> {
      const started = Date.now();
      try {
        const value = await run();
        took[name] = Date.now() - started;
        console.log(`  ok    ${name.padEnd(11)}${`${Date.now() - started} ms`.padStart(9)}  ${describe(value)}`);
        return value;
      } catch (error) {
        failed++;
        console.log(`  FAIL  ${name.padEnd(11)}${error instanceof Error ? error.message : error}`);
      }
    }

    await check('spark', () => askSparkJson<{ thing: string }>(memo, {
      label: 'doctor',
      prompt: 'Name one thing a traveller might find at a crossroads inn. Reply as JSON: {"thing": "..."}',
    }), (a) => `"${a.thing}"`);

    const painting = await check('muse paint', () => musePaint(memo, {
      label: 'doctor',
      prompt: 'A painted background for a 2D adventure game: the yard of a crossroads inn at dusk, a cart with a wooden barrel, a well, lanterns on the porch. Gouache, no people, no text.',
    }), (png) => `${Math.round(png.length / 1024)} KB`);
    if (!painting) return void process.exit(1);
    fs.writeFileSync(path.join(out, 'paint.png'), painting);

    const edited = await check('muse edit', () => museEdit(memo, {
      label: 'doctor',
      images: [painting],
      prompt: 'The same yard on a snowy winter night. Keep the composition exactly.',
    }), (png) => `${Math.round(png.length / 1024)} KB`);
    if (edited) fs.writeFileSync(path.join(out, 'edit.png'), edited);

    const found = await check('sam', () => samFind(memo, { label: 'doctor', image: painting, prompt: 'barrel' }),
      (f) => `${f.length} barrel(s), ${f.reduce((s, x) => s + maskArea(x.mask), 0)} px`);
    if (found?.[0]) fs.writeFileSync(path.join(out, 'sam-barrel.png'), await maskToPng(found[0].mask));

    if (nowAt >= 0) console.log(`\n  ${liveVerdict(took)}`);
    console.log(`\n  sent: spark ${memo.sent.spark}, muse ${memo.sent.muse}, sam ${memo.sent.sam} · files in ${out}`);
    if (failed) process.exit(1);
  },
});

/** Slower than this, one call is a sign of a slow network or a busy Meta: a 25-drawing build took 45 min at 3x these. */
const SLOW_MS: Record<string, number> = { spark: 30_000, 'muse paint': 60_000, 'muse edit': 60_000, sam: 20_000 };

/** Whether a build in front of people will finish in time, from one call to each model. */
export function liveVerdict(took: Record<string, number>): string {
  const slow = Object.entries(SLOW_MS).filter(([name, limit]) => (took[name] ?? Infinity) > limit).map(([name]) => name);
  if (!slow.length) return 'fast enough for a live build (3 places in about 15 min)';
  return `SLOW: ${slow.join(', ')}. A live build may take 30+ min: play a world built beforehand, or build with fewer drawings and places`;
}
