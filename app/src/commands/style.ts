// diorama style <slug> "<style>": give a world (or one place, or the cast) another painting style, and repaint
// what is made in it with the composition kept, so masks, walk grids and the person's fixes still fit.
import fs from 'node:fs';
import { defineCommand, registry, takeOption } from '../registry.ts';
import { readCastFixes, castFixesFile } from '../scene/cast-fixes.ts';
import { readCorrections, writeCorrections } from '../scene/corrections.ts';
import { WorldFiles } from '../world/files.ts';
import { castStyle, placeStyle, readStyled, writeStyled } from '../world/styled.ts';
import { castKeys, planLine, stylePlan, type Scope } from '../world/style-plan.ts';

const run = (name: string, args: string[]) => registry.get(name)!.run(args);

defineCommand({
  name: 'style',
  usage: 'style <slug> "<style>"  paint the world in another style: each place repainted with its composition kept (then masks to verify again), the cast repainted, their models and sprites made again [--place KEY: only that place] [--cast KEY|all: only the cast] [--estimate: only say what it redoes and costs]',
  async run(args) {
    const placeKey = takeOption(args, 'place', '');
    const castKey = takeOption(args, 'cast', '');
    const estimate = args.includes('--estimate');
    const [slug, style] = args.filter((a) => a !== '--estimate');
    if (!slug || !style) throw new Error('usage: diorama style <slug> "<style>" [--place KEY] [--cast KEY|all] [--estimate]');
    if (style.trim().length < 10) throw new Error('say the style in a few words: medium, palette, light (at least 10 letters)');
    const files = new WorldFiles(slug);
    const world = files.world();
    const scope: Scope = placeKey ? 'place' : castKey ? 'cast' : 'world';
    const key = placeKey || (castKey && castKey !== 'all' ? castKey : undefined);
    if (placeKey && !world.places.some((p) => p.key === placeKey)) throw new Error(`${slug} has no place ${placeKey}: ${world.places.map((p) => p.key).join(', ')}`);
    if (scope === 'cast' && key && !castKeys(world, files).includes(key)) throw new Error(`${slug} has no character ${key}: ${castKeys(world, files).join(', ')}`);
    const plan = stylePlan(files, world, scope, key);
    console.log(`style ${scope}${key ? ` ${key}` : ''}: ${planLine(plan)}`);
    if (estimate) return;

    // What is painted already keeps the style it was painted in, so paint and cast see the change and repaint it.
    const styled = readStyled(files);
    for (const p of world.places) if (!styled.places[p.key] && fs.existsSync(files.place(p.key, 'painting.png'))) styled.places[p.key] = placeStyle(files, world, p.key);
    for (const k of castKeys(world, files)) if (!styled.cast[k] && fs.existsSync(files.path('cast', `${k}-painting.png`))) styled.cast[k] = castStyle(files, world, k);
    styled.from ??= world.style;
    writeStyled(files, styled);

    // The new style: the world's (a place's or a character's own style gives way to it), or one place's or character's own.
    const fixes = readCastFixes(files);
    const castFix = (k: string, s: string | undefined) => {
      if (s) fixes[k] = { ...fixes[k], style: s };
      else if (fixes[k]) delete fixes[k].style;
    };
    if (scope === 'world') {
      files.write(files.path('world.json'), { ...JSON.parse(fs.readFileSync(files.path('world.json'), 'utf8')), style });
      for (const p of world.places) {
        const c = readCorrections(files.place(p.key));
        if (!c.style) continue;
        delete c.style;
        writeCorrections(files.place(p.key), c);
      }
      for (const k of Object.keys(fixes)) castFix(k, undefined);
    } else if (scope === 'place') {
      const c = readCorrections(files.place(placeKey));
      c.style = style;
      fs.mkdirSync(files.place(placeKey), { recursive: true });
      writeCorrections(files.place(placeKey), c);
    } else {
      for (const k of key ? [key] : castKeys(world, files)) castFix(k, style);
    }
    if (scope !== 'place') files.write(castFixesFile(files), fixes);

    if (plan.places.length) {
      if (scope === 'place') await run('build', [slug, '--from', 'paint', '--to', 'verify', '--place', placeKey]);
      else await run('build', [slug, '--from', 'paint', '--to', 'reactions']);
      // Icons cut from a painting are cut again from the new one; painted ones are painted in the new style.
      if (scope === 'place') await run('icons', [slug]);
    }
    if (plan.cast.length) {
      console.log('\n# cast');
      await run('cast', [slug, ...plan.cast]);
      for (const k of plan.models) {
        console.log(`\n# model ${k}`);
        await run('model', [slug, k]);
      }
      for (const k of plan.sprites) {
        console.log(`\n# sprites ${k}`);
        await run('sprites', [slug, k]);
      }
    }
    if (scope === 'world' && plan.places.length) await run('build', [slug, '--from', 'verify', '--to', 'verify']);
    console.log(`\nstyle ${slug}: ${scope}${key ? ` ${key}` : ''} now "${style}"`);
  },
});
