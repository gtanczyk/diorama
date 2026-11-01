// The build bar's world-wide steps open a live view: what each works from and what it made (Grzegorz: a click on
// "Item icons" did nothing). step_work reads it from the world's files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyMask, maskToPng } from '../src/image/mask.ts';
import { stepWork } from '../src/actions/step-work.ts';
import { WorldFiles } from '../src/world/files.ts';

test('item icons: where SAM cuts each item from (painting crop + mask), and the icon once it lands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-stepwork-'));
  try {
    const w = path.join(root, 'yard');
    fs.mkdirSync(path.join(w, 'places', 'steps', 'masks'), { recursive: true });
    fs.mkdirSync(path.join(w, 'items'), { recursive: true });
    fs.writeFileSync(path.join(w, 'world.json'), JSON.stringify({
      title: 'Yard', pitch: 'A yard.', style: 'gouache', start: 'steps', hero: { key: 'kid', looks: 'a child' },
      places: [{ key: 'steps', shows: 'river steps', mood: 'calm', things: [{ key: 'paper-boat', role: 'item', looks: 'a paper boat' }], exits: [] }],
    }));
    fs.writeFileSync(path.join(w, 'story.json'), JSON.stringify({
      intro: 'Hi.', items: [{ key: 'paper-boat', name: 'paper boat' }, { key: 'ticket', name: 'tram ticket' }],
      interactions: [{ place: 'steps', thing: 'paper-boat', verb: 'take', say: 'Got it.', do: [{ give: 'paper-boat' }], once: true }],
      endings: [{ key: 'end', title: 'End', text: 'The end.' }],
    }));
    fs.writeFileSync(path.join(w, 'places', 'steps', 'painting.png'), await sharp({ create: { width: 1200, height: 896, channels: 3, background: '#556677' } }).png().toBuffer());
    const mask = emptyMask(1200, 896);
    for (let y = 400; y < 440; y++) for (let x = 600; x < 660; x++) mask.bits[y * 1200 + x] = 1;
    fs.writeFileSync(path.join(w, 'places', 'steps', 'masks', 'paper-boat.png'), await maskToPng(mask));

    const before = await stepWork(new WorldFiles('yard', root), 'icons');
    expect(before.map((c) => c.key)).toEqual(['paper-boat', 'ticket']);
    const boat = before[0];
    expect(boat.from?.mask?.file).toBe('places/steps/masks/paper-boat.png');
    // The crop holds the thing, with some of the place around it.
    const [x0, y0, x1, y1] = boat.from!.box!;
    expect(x0 * 1200).toBeLessThan(600);
    expect(x1 * 1200).toBeGreaterThan(660);
    expect(y0 * 896).toBeLessThan(400);
    expect(y1 * 896).toBeGreaterThan(440);
    expect(boat.made).toBeNull();
    // Handed over: nothing to cut it from, Muse paints it.
    expect(before[1].from).toBeNull();

    fs.writeFileSync(path.join(w, 'items', 'paper-boat.png'), await sharp({ create: { width: 192, height: 192, channels: 4, background: '#ffffff00' } }).png().toBuffer());
    const after = await stepWork(new WorldFiles('yard', root), 'icons');
    expect(after[0].made).toMatchObject({ file: 'items/paper-boat.png' });
    expect(after[0].at).toBeGreaterThan(0);
    // Plates: the taken boat, the place without it once painted.
    const plates = await stepWork(new WorldFiles('yard', root), 'plates');
    expect(plates.map((c) => c.key)).toEqual(['steps/paper-boat']);
    expect(plates[0].made).toBeNull();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
