import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { renderGuides } from '../src/model/sprites.ts';
import { boxGlb } from './fixtures/model-box.ts';

test('the larger UV sprite sheet renders real visible pixels',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uv-sheet-'));
  try {
    const png=await sharp({create:{width:32,height:32,channels:3,background:'#a4b1bf'}}).png().toBuffer();
    fs.writeFileSync(path.join(dir,'model.glb'),boxGlb([1.2,1,.4],1,[0,0,0],png));
    const views=Object.fromEntries(['front','back','left','right'].map(name=>{fs.writeFileSync(path.join(dir,`${name}.png`),png);return [name,{image:`${name}.png`,u:[1,.5],v:[-1,1],iou:1}];}));
    fs.writeFileSync(path.join(dir,'model.json'),JSON.stringify({glb:'model.glb',creature:true,views}));
    const sheet=(await renderGuides(dir,['front'],undefined,false,{texture:'model',frames:16})).front;
    const image=sharp(sheet),meta=await image.metadata();
    expect([meta.width,meta.height]).toEqual([1800,3360]);
    const stats=await image.stats();expect(stats.channels[3].max).toBeGreaterThan(0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},60000);
