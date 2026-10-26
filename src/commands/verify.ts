// diorama verify <slug> [place...]: verify.json per place; exits 1 when a place has errors.
import { Geometry } from '../play/geometry.ts';
import { defineCommand } from '../registry.ts';
import { verifyPlace, type MaskNotes } from '../scene/verify.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'verify',
  usage: 'verify <slug> [place...] check each place can be walked and used (verify.json)',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: diorama verify <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    let failed = 0;
    for (const place of world.places.filter((p) => only.length === 0 || only.includes(p.key))) {
      const at = (...parts: string[]) => files.place(place.key, ...parts);
      const geometry = Geometry.parse(files.readJson(at('geometry.json')));
      const verdict = verifyPlace(place, geometry, files.readJson(at('masks.json')) as MaskNotes);
      files.write(at('verify.json'), verdict);
      if (!verdict.ok) failed++;
      console.log(`${place.key}: ${verdict.ok ? 'ok' : `${verdict.errors.length} error(s)`}, ${verdict.flags.length} flag(s)`);
      for (const e of verdict.errors) console.log(`  ERROR ${e.code}${e.key ? ` ${e.key}` : ''}: ${e.detail}`);
      for (const f of verdict.flags) console.log(`  flag  ${f.code}${f.key ? ` ${f.key}` : ''}: ${f.detail}`);
    }
    if (failed) process.exitCode = 1;
  },
});
