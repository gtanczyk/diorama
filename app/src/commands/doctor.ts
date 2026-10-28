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
  usage: 'doctor [dir]            check the API key with one call to Spark, Muse paint, Muse edit and SAM 3.1',
  async run([dir = '.diorama/doctor']) {
    const out = path.resolve(dir);
    fs.mkdirSync(out, { recursive: true });
    const memo = new Memo(path.join(out, 'memo'));
    let failed = 0;
    async function check<T>(name: string, run: () => Promise<T>, describe: (v: T) => string): Promise<T | undefined> {
      const started = Date.now();
      try {
        const value = await run();
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

    console.log(`\n  sent: spark ${memo.sent.spark}, muse ${memo.sent.muse}, sam ${memo.sent.sam} · files in ${out}`);
    if (failed) process.exit(1);
  },
});
