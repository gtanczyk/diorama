import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { scene } from './fixtures/scene.ts';
import { exportWorld } from '../src/commands/export.ts';
import { MOUTHS } from '../src/play/lipsync.ts';
import { sha256 } from '../src/scene/faces-data.ts';

test('a static export carries the face atlas and distinct recordings of the same words', async () => {
  const cwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-export-'));
  try {
    const { put } = await scene(path.join(root, 'worlds'), true);
    const figure = await sharp({create:{width:16,height:32,channels:4,background:'#aaa'}}).png().toBuffer();
    const atlas = await sharp({create:{width:90,height:10,channels:4,background:'#aabbcc'}}).png().toBuffer();
    put('cast/guard.png', figure); put('cast/guard/face-atlas.png', atlas);
    put('cast/guard/face.json', {image:'face-atlas.png',imageHash:sha256(figure),imagePose:{mouth:[4,4,8,8],eyes:[]},mouths:Object.fromEntries(MOUTHS.map((m,i)=>[m,[i*10,0,10,10]])),sheets:{}});
    const voices = ['hero','guard'].map(speaker => ({speaker,text:'Cześć.',file:`sound/voice/${speaker}.mp3`,seconds:0.2,heard:'Cześć.',match:1,flags:[]}));
    for(const voice of voices)put(voice.file,Buffer.from(voice.speaker));
    put('voices.json',{cast:{},lines:voices,failures:[]});
    put('sound/lipsync.json',{version:1,byFile:Object.fromEntries(voices.map(v=>[v.file,{sha256:sha256(Buffer.from(v.speaker)),cues:[{start:0,end:0.2,value:'D'}]}]))});
    process.chdir(root);
    const out = path.join(root,'export'); await exportWorld('w',out);
    const data=JSON.parse(fs.readFileSync(path.join(out,'world-data.json'),'utf8'));
    expect(data.sound.lines['Cześć.']).toBeUndefined();
    expect(data.sound.bySpeaker.guard['Cześć.'].lipsync.cues[0].value).toBe('D');
    expect(fs.readFileSync(path.join(out,'files/cast/guard/face-atlas.png')).equals(atlas)).toBe(true);
    for(const voice of voices)expect(fs.readFileSync(path.join(out,'files',voice.file),'utf8')).toBe(voice.speaker);
  } finally { process.chdir(cwd); fs.rmSync(root,{recursive:true,force:true}); }
},15_000);
