import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('closed lips retain the source pixels, articulation stays near the lip corners, and a crossfade never stacks two faces', async () => {
  const script = (await build({ entryPoints: ['app/web/face.ts'], bundle: true, format: 'iife', globalName: 'Faces', write: false })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => {
      const w = window as any;
      const source = Object.assign(document.createElement('canvas'), { width:120, height:180 });
      const c = source.getContext('2d')!; c.fillStyle='#446688'; c.fillRect(0,0,120,180);
      c.fillStyle='#221111'; c.fillRect(50,60,16,3);
      const atlas = new Image(); atlas.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><path fill="#f20" d="M0 0h128v128H0z"/></svg>'); await atlas.decode();
      const info = { image:'atlas.png', mouths:Object.fromEntries(['X','A','B','C','D','E','F','G','H'].map(m=>[m,[0,0,128,128]])), sheets:{}, anchors:{default:[0.2,0.3,0.6,0.2]}, frames:{default:Object.fromEntries(['X','A','B','C','D','E','F','G','H'].map(m=>[m,[0.2,0.3,0.6,0.2]]))}, imagePose:{mouth:[40,50,40,30],lips:[50,60,16,3],eyes:[]} };
      const face = new w.Faces.PaintedFace(info,atlas);
      const pixels = (surface: HTMLCanvasElement) => new Uint8ClampedArray(surface.getContext('2d')!.getImageData(0,0,120,180).data);
      const render = (mouth: string,mix=1) => pixels(face.draw(source,'$image',0,1,1,{mouth,previous:mouth,mix,energy:0},0));
      const original=pixels(source), rest=render('X'), closed=render('A'), open=render('D'), fade=render('D',0.5);
      const equal=(a:Uint8ClampedArray,b:Uint8ClampedArray)=>a.every((v,i)=>v===b[i]);
      let changed=0, outside=0, difference=0;
      for(let i=0;i<open.length;i+=4) if(open.slice(i,i+4).some((v,k)=>v!==original[i+k])) {
        changed++; const x=i/4%120,y=Math.floor(i/4/120);
        if(x<46||x>70||y<56||y>71) outside++;
      }
      for(let i=0;i<open.length;i++) difference=Math.max(difference,Math.abs(open[i]-fade[i]));
      const unregistered=new w.Faces.PaintedFace({...info,anchors:undefined},atlas);
      const fallback=pixels(unregistered.draw(source,'$image',0,1,1,{mouth:'D',previous:'D',mix:1,energy:0},0));
      return {rest:equal(rest,original),closed:equal(closed,original),changed,outside,difference,fallback:equal(fallback,original)};
    });
    expect(result.rest).toBe(true); expect(result.closed).toBe(true); expect(result.fallback).toBe(true);
    expect(result.changed).toBeGreaterThan(20); expect(result.outside).toBe(0); expect(result.difference).toBeLessThanOrEqual(2);
  } finally { await browser.close(); }
});


test('individually shifted atlas frames align to the same original mouth corners and upper rim', async () => {
  const script = (await build({ entryPoints:['app/web/face.ts'], bundle:true, format:'iife', globalName:'Faces', write:false })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page=await browser.newPage(); await page.addScriptTag({content:script});
    const difference=await page.evaluate(async()=>{
      const source=Object.assign(document.createElement('canvas'),{width:120,height:180});
      source.getContext('2d')!.fillStyle='#446688'; source.getContext('2d')!.fillRect(0,0,120,180);
      const atlas=new Image();
      atlas.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128"><path fill="#f20" d="M64 48h32v24H64z M144 16h32v24h-32z"/></svg>'); await atlas.decode();
      const mouths=Object.fromEntries(['X','A','B','C','D','E','F','G','H'].map(m=>[m,[0,0,128,128]])); mouths.D=[128,0,128,128];
      const anchor=[0.25,0.25,0.25,0.1875];
      const face=new (window as any).Faces.PaintedFace({image:'atlas.png',mouths,sheets:{},anchors:{default:anchor},frames:{default:{C:[0.5,0.375,0.25,0.1875],D:[0.125,0.125,0.25,0.1875]}},imagePose:{mouth:[40,50,40,30],lips:[50,60,16,3],eyes:[]}},atlas);
      const pixels=(mouth:string)=>new Uint8ClampedArray((face.draw(source,'$image',0,1,1,{mouth,previous:mouth,mix:1,energy:0},0) as HTMLCanvasElement).getContext('2d')!.getImageData(0,0,120,180).data);
      const first=pixels('C'),second=pixels('D'); return first.reduce((max,v,i)=>Math.max(max,Math.abs(v-second[i])),0);
    });
    expect(difference).toBeLessThanOrEqual(1);
  } finally { await browser.close(); }
});

test('a source gesture painted with an open mouth closes for silence and M/B/P without changing a closed source pose',async()=>{
  const script=(await build({entryPoints:['app/web/face.ts'],bundle:true,format:'iife',globalName:'Faces',write:false})).outputFiles[0].text;
  const browser=await chromium.launch();
  try{
    const page=await browser.newPage();await page.addScriptTag({content:script});
    const result=await page.evaluate(async()=>{
      const source=Object.assign(document.createElement('canvas'),{width:120,height:180}),c=source.getContext('2d')!;
      c.fillStyle='#778899';c.fillRect(0,0,66,180);c.fillStyle='#000';c.fillRect(50,61,16,8);
      const atlas=new Image();atlas.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><path fill="#778899" d="M0 0h128v128H0z"/><path fill="#000" d="M32 32h64v8H32z"/></svg>');await atlas.decode();
      const mouths=Object.fromEntries(['X','A','B','C','D','E','F','G','H'].map(m=>[m,[0,0,128,128]])),anchor=[.25,.25,.5,.0625];
      const make=(open:boolean)=>new (window as any).Faces.PaintedFace({image:'a.png',mouths,anchors:{default:anchor},frames:{default:{X:anchor}},sheets:{},imagePose:{mouth:[40,50,40,30],lips:[50,60,16,9],eyes:[],sourceOpen:open}},atlas);
      const open=make(true),closed=make(false);
      const at=(face:any,mouth:string)=>{const image=face.draw(source,'$image',0,1,1,{mouth,previous:mouth,mix:1,energy:0},0) as HTMLCanvasElement;return Array.from(image.getContext('2d')!.getImageData(58,66,1,1).data);};
      const silence=at(open,'X'),pressed=at(open,'A'),original=at(closed,'X');const image=open.draw(source,'$image',0,1,1,{mouth:'D',previous:'D',mix:1,energy:0},0) as HTMLCanvasElement;const outside=image.getContext('2d')!.getImageData(70,66,1,1).data[3];return{silence,pressed,original,outside};
    });
    expect(result.original.slice(0,3)).toEqual([0,0,0]);expect(result.silence[0]).toBeGreaterThan(80);expect(result.pressed).toEqual(result.silence);expect(result.outside).toBe(0);
  }finally{await browser.close();}
});
