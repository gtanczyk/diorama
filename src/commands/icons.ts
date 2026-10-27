// diorama icons <slug> [item...]: items/<key>.png for every item in story.json, and items/items.json saying how each was made.
import fs from 'node:fs';
import sharp from 'sharp';
import { maskFromPng } from '../image/mask.ts';
import { maskBox } from '../image/raster.ts';
import { defineCommand } from '../registry.ts';
import { cutIcon, itemSources, ItemsInfo, MIN_CUT_PX, paintIcon, readIconFixes, redrawIcon } from '../scene/icons.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'icons',
  usage: 'icons <slug> [item...]  an inventory icon per story item: cut from the painting where the hero picks it up, else painted by Muse (items/fixes.json: how, hint, take)',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: diorama icons <slug> [item...]');
    const files = new WorldFiles(slug);
    if (!fs.existsSync(files.path('story.json'))) {
      console.log('no story.json: no items, no icons');
      return;
    }
    const world = files.world();
    const story = Story.parse(files.readJson(files.path('story.json')));
    const sources = itemSources(story);
    const fixes = readIconFixes(files);
    const infoFile = files.path('items', 'items.json');
    const info: ItemsInfo = fs.existsSync(infoFile) ? ItemsInfo.parse(files.readJson(infoFile)) : {};
    // Items the story no longer has lose their icons.
    for (const key of Object.keys(info)) if (!sources[key] && !story.items.some((i) => i.key === key)) delete info[key];
    const items = story.items.filter((i) => only.length === 0 || only.includes(i.key));
    await Promise.all(items.map(async (item) => {
      const from = sources[item.key];
      const fix = fixes[item.key] ?? {};
      let png: Buffer;
      let how: ItemsInfo[string]['how'];
      const maskFile = from && files.place(from.place, 'masks', `${from.thing}.png`);
      if (from && maskFile && fs.existsSync(maskFile) && fix.how !== 'paint') {
        const painting = fs.readFileSync(files.place(from.place, 'painting.png'));
        const mask = await maskFromPng(fs.readFileSync(maskFile));
        const box = maskBox(mask);
        const side = box ? Math.max(box[2] - box[0], box[3] - box[1]) : 0;
        // A hint from the person means the picture itself should change, so Muse redraws even a large cut-out.
        if (fix.how === 'cut' || (side >= MIN_CUT_PX && !fix.hint)) {
          png = await cutIcon(painting, mask);
          how = 'cut';
        } else {
          // Too small to blow up, or the person asked for changes: Muse redraws the cut-out.
          const crop = await sharp(await cutIcon(painting, mask, 12)).flatten({ background: '#f3ead8' }).png().toBuffer();
          png = await redrawIcon(files.memo, world, item, crop, fix.hint, fix.take);
          how = 'redraw';
        }
      } else {
        if (from) console.log(`  ${item.key}: ${from.place}/${from.thing} has no mask, Muse paints it`);
        png = await paintIcon(files.memo, world, item, fix.hint, fix.take);
        how = 'paint';
      }
      files.write(files.path('items', `${item.key}.png`), png);
      info[item.key] = { icon: `items/${item.key}.png`, how, from };
      console.log(`${item.key}: ${how}${from ? ` from ${from.place}/${from.thing}` : ''}`);
    }));
    files.write(infoFile, info);
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
