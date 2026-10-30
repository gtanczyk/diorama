import fs from 'node:fs';
import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { Geometry } from '../play/geometry.ts';
import { Reactions } from '../play/reactions.ts';
import { Layout } from '../scene/layout.ts';
import { Story } from '../story/schema.ts';
import { planReactions, reactionSource, type ReactionInput } from '../scene/reactions.ts';

export function reactionInput(files: WorldFiles, key: string): ReactionInput {
  const world = files.world(), place = world.places.find((p) => p.key === key);
  if (!place) throw new Error(`unknown place ${key}`);
  const read = (file: string) => fs.existsSync(file) ? files.readJson(file) : undefined;
  const wish = read(files.place(key, 'reactions-wish.json')) as { hint?: string } | undefined;
  const story = read(files.path('story.json'));
  return { world, place, layout: Layout.parse(files.readJson(files.place(key, 'layout.json'))),
    geometry: Geometry.parse(files.readJson(files.place(key, 'geometry.json'))),
    story: story ? Story.parse(story) : null, weather: read(files.place(key, 'weather.json')), hint: wish?.hint,
    painting: fs.readFileSync(files.place(key, 'painting.png')) };
}

defineCommand({
  name: 'reactions',
  usage: 'reactions <slug> [place...] choose and bind subtle step, area-entry and object reactions automatically',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: reactions <slug> [place...]');
    const files = new WorldFiles(slug), world = files.world();
    for (const key of only) if (!world.places.some((p) => p.key === key)) throw new Error(`unknown place ${key}`);
    await Promise.all(world.places.filter((p) => !only.length || only.includes(p.key)).map(async (p) => {
      const input = reactionInput(files, p.key), out = files.place(p.key, 'reactions.json');
      const was = fs.existsSync(out) ? Reactions.safeParse(files.readJson(out)) : undefined;
      if (was?.success && was.data.source === reactionSource(input)) { console.log(`${p.key}: reactions unchanged`); return; }
      const { plan, reactions } = await planReactions(files.memo, input);
      files.write(files.place(p.key, 'reactions-plan.json'), plan);
      // Replace only after successful binding: a failed model call preserves the last good plan.
      files.write(out, reactions);
      console.log(`${p.key}: reactions — ${reactions.areas.length} areas, ${reactions.interactions.length} interactions. ${reactions.scene}`);
    }));
  },
});
