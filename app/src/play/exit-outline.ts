// Visual coverage for a walkable exit. Never used as a collision or interaction mask.
import type { Geometry, GeoThing } from './geometry.ts';
export type OutlineMask = { bits: Uint8Array; area: number };
export function exitOutline(mask: OutlineMask, thing: GeoThing, g: Geometry): { mask: OutlineMask; box: [number,number,number,number] } | undefined {
  if (thing.role !== 'exit' || !['walk-on','flat'].includes(thing.kind ?? '')) return;
  const {width:W,height:H}=g.frame;
  const left=new Int32Array(H).fill(W),right=new Int32Array(H).fill(-1);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(mask.bits[y*W+x]){left[y]=Math.min(left[y],x);right[y]=x;}
  // Steps are measured independently of the exit's object mask. Only include bands
  // that overlap its painted pixels, then follow that same run through neighbouring bands.
  const bands=(g.steps ?? []).map(step=>{
    const rows:Array<[number,number,number]>=[]; let overlap=0,total=0;
    for(let i=0;i<step.top.length;i++) {
      const top=step.top[i],bottom=step.bottom[i];if(top<0||bottom<top)continue;
      for(let x=Math.max(0,Math.round(step.x0+i*step.every));x<Math.min(W,Math.round(step.x0+(i+1)*step.every));x++) {
        const a=Math.max(0,Math.floor(top)),b=Math.min(H-1,Math.ceil(bottom));
        rows.push([x,a,b]);for(let y=a;y<=b;y++){total++;if(mask.bits[y*W+x])overlap++;}
      }
    }
    const box = rows.length ? [Math.min(...rows.map(r=>r[0])),Math.min(...rows.map(r=>r[1])),Math.max(...rows.map(r=>r[0]))+1,Math.max(...rows.map(r=>r[2]))+1] : [0,0,0,0];
    return {rows,overlap,total,box};
  });
  // Seed from observed steps and follow adjacent bands with substantial horizontal
  // overlap. This reaches an edge tread outside the object's truncated box.
  const selected=new Set(bands.filter(b=>b.total && b.overlap/b.total>.1));
  let added=true;
  while(added){added=false;for(const band of bands)if(band.total&&!selected.has(band))for(const near of selected){
    const a=band.box,b=near.box;
    const overlap=Math.min(a[2],b[2])-Math.max(a[0],b[0]);
    const gap=Math.max(0,a[1]-b[3],b[1]-a[3]);
    if(overlap/Math.max(1,Math.min(a[2]-a[0],b[2]-b[0]))>.6 && gap<=Math.max(8,H*.03)) {selected.add(band);added=true;break;}
  }}
  for(const band of selected)for(const [x,a,b]of band.rows)for(let y=a;y<=b;y++){left[y]=Math.min(left[y],x);right[y]=Math.max(right[y],x);}
  const rows=Array.from({length:H},(_,y)=>y).filter(y=>right[y]>=left[y]);
  if(!rows.length)return;
  // Bridge missing risers between observed rows, rather than outlining each tread.
  for(let i=1;i<rows.length;i++) {
    const a=rows[i-1],b=rows[i];
    if(b-a>Math.max(32,H*.15))continue;
    for(let y=a+1;y<b;y++){const t=(y-a)/(b-a);left[y]=Math.round(left[a]*(1-t)+left[b]*t);right[y]=Math.round(right[a]*(1-t)+right[b]*t);}
  }
  const bits=new Uint8Array(W*H);let area=0,x0=W,y0=H,x1=0,y1=0;
  for(let y=0;y<H;y++)if(right[y]>=left[y]){
    bits.fill(1,y*W+left[y],y*W+right[y]+1);area+=right[y]-left[y]+1;
    x0=Math.min(x0,left[y]);x1=Math.max(x1,right[y]+1);y0=Math.min(y0,y);y1=y+1;
  }
  return {mask:{bits,area},box:[x0,y0,x1,y1]};
}
