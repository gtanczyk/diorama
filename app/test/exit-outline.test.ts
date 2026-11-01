import { expect,test } from 'vitest';
import { exitOutline } from '../src/play/exit-outline.ts';
import type { Geometry,GeoThing } from '../src/play/geometry.ts';
const thing:GeoThing={key:'stairs',role:'exit',kind:'walk-on',box:[10,10,35,80],stand:[25,80]};
const geometry={frame:{width:80,height:100},steps:[]} as unknown as Geometry;
function pixels(rects:number[][]){const bits=new Uint8Array(8000);let area=0;for(const [x0,y0,x1,y1] of rects)for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(!bits[y*80+x]){bits[y*80+x]=1;area++;}return{bits,area};}
const step=(x:number,top:number,bottom:number)=>({x0:x,every:5,top:[top,top,top,top],bottom:[bottom,bottom,bottom,bottom]});
test('an exit has one continuous visual region between fragmented treads; original mask stays untouched',()=>{
 const mask=pixels([[10,10,25,15],[15,25,30,30],[20,40,35,45]]),before=mask.bits.slice();
 const result=exitOutline(mask,thing,geometry)!;
 expect(result.mask.bits[20*80+20]).toBe(1);
 expect(result.mask.bits[35*80+25]).toBe(1);
 expect(result.box).toEqual([10,10,35,45]);
 expect(mask.bits).toEqual(before);
});
test('the same stair run reaches the frame edge beyond the truncated object box',()=>{
 const mask=pixels([[10,20,30,26],[10,30,30,36]]);
 const g={...geometry,steps:[step(10,0,8),step(10,10,18),step(10,20,28),step(55,0,8)]};
 const result=exitOutline(mask,thing,g)!;
 expect(result.box[1]).toBe(0);expect(result.mask.bits[15]).toBe(1);
 expect(result.mask.bits[60]).toBe(0);
});
test('ordinary objects, wall doorways and NPCs retain their exact masks',()=>{
 const mask=pixels([[10,10,20,20]]);
 for(const target of [{...thing,role:'item' as const},{...thing,kind:'wall' as const},{...thing,role:'npc' as const}])expect(exitOutline(mask,target,geometry)).toBeUndefined();
});
test('large unobserved gaps are not filled',()=>{
 const mask=pixels([[10,2,20,6],[10,70,20,75]]);
 expect(exitOutline(mask,thing,geometry)!.mask.bits[40*80+15]).toBe(0);
});
