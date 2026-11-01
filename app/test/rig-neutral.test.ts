import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('../src/scene/rig.ts',()=>({rigFigure:vi.fn()}));
vi.mock('../src/scene/rig-check.ts',()=>({checkSheet:vi.fn()}));
vi.mock('../src/meta/muse.ts',()=>({museEdit:vi.fn(),musePaint:vi.fn()}));
vi.mock('../src/meta/spark.ts',()=>({askSparkJson:vi.fn()}));
import {rigCast} from '../src/commands/cast.ts';
import {rigFigure} from '../src/scene/rig.ts';
import {checkSheet} from '../src/scene/rig-check.ts';
import {museEdit} from '../src/meta/muse.ts';
import {askSparkJson} from '../src/meta/spark.ts';
import {WorldFiles} from '../src/world/files.ts';
let root:string, files:WorldFiles;
const rig={size:[10,10],ground:9,height:9,hip:[5,5],shoulder:{near:[4,2],far:[6,2]},leg:{near:{knee:[4,6],ankle:[4,9]},far:{knee:[6,6],ankle:[6,9]}},parts:[],sheet:{file:'walk.png',cols:4,rows:3,frames:8,cell:[10,10],scale:1}};
beforeEach(()=>{
  vi.clearAllMocks();root=fs.mkdtempSync(path.join(os.tmpdir(),'neutral-rig-'));files=new WorldFiles('w',root);
  files.write(files.path('cast','hero-painting.png'),Buffer.from('original'));
  vi.mocked(rigFigure).mockResolvedValue({rig:structuredClone(rig),parts:{'walk.png':Buffer.from('sheet')},issues:[]} as any);
  vi.mocked(museEdit).mockResolvedValue(Buffer.from('neutral'));
  vi.mocked(askSparkJson).mockResolvedValue({matches:true,neutral:true,heldPreserved:true,reason:'same character'});
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
test('a torn walk gets a verified neutral retry without replacing the source painting',async()=>{
  vi.mocked(checkSheet).mockResolvedValueOnce({ok:false,holes:.1,loose:0,why:'holes'}).mockResolvedValueOnce({ok:true,holes:0,loose:0});
  await rigCast(files,'hero',Buffer.from('original'));
  expect(rigFigure).toHaveBeenCalledTimes(2);
  expect(vi.mocked(rigFigure).mock.calls[1][2]).toEqual(Buffer.from('neutral'));
  expect(files.readJson(files.path('cast','hero','rig.json'))).toMatchObject({check:{ok:true}});
  expect(fs.readFileSync(files.path('cast','hero-painting.png'),'utf8')).toBe('original');
});
test('a neutral pose that loses a held object is refused',async()=>{
  vi.mocked(checkSheet).mockResolvedValue({ok:false,holes:.1,loose:0,why:'holes'});
  vi.mocked(askSparkJson).mockResolvedValue({matches:true,neutral:true,heldPreserved:false,reason:'lantern missing'});
  await rigCast(files,'hero',Buffer.from('original'));
  expect(rigFigure).toHaveBeenCalledTimes(1);
  expect(files.readJson(files.path('cast','hero','rig.json'))).toMatchObject({check:{ok:false}});
  expect(files.readJson(files.path('cast','hero','rig-attempt.json'))).toMatchObject({reason:expect.stringContaining('lantern missing')});
});
test('a passing walk does not trigger an image or vision call',async()=>{
  vi.mocked(checkSheet).mockResolvedValue({ok:true,holes:0,loose:0});
  await rigCast(files,'hero',Buffer.from('original'));
  expect(museEdit).not.toHaveBeenCalled();expect(askSparkJson).not.toHaveBeenCalled();
});
