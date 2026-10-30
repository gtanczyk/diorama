// A small, registered mouth patch keeps the existing painted face, cap and body intact.
import { faceAt, type Articulation, type Box, type FaceDefinition, type FacePose, type FaceState, type Mouth } from '../src/play/lipsync.ts';

type Surface = HTMLImageElement | HTMLCanvasElement;

/** Draw a full-size mask so pixels outside the gradient's rectangle are cleared too. */
function feather(c: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) {
  const mask = Object.assign(document.createElement('canvas'), { width: c.canvas.width, height: c.canvas.height });
  const m = mask.getContext('2d')!;
  m.translate(cx, cy); m.scale(rx, ry);
  const fade = m.createRadialGradient(0, 0, 0.68, 0, 0, 1);
  fade.addColorStop(0, '#fff'); fade.addColorStop(1, '#fff0');
  m.fillStyle = fade; m.fillRect(-1, -1, 2, 2);
  c.globalCompositeOperation = 'destination-in'; c.drawImage(mask, 0, 0);
  c.globalCompositeOperation = 'source-over';
}
export class PaintedFace {
  private patches = new Map<string, Map<Mouth, HTMLCanvasElement>>();
  private canvas = document.createElement('canvas');
  private cache = '';
  private revision = 0;
  get version() { return this.revision; }
  private blend = document.createElement('canvas');
  private neutral = new Map<string, HTMLCanvasElement>();
  private closed = new Map<string, HTMLCanvasElement>();
  private closure = document.createElement('canvas');

  constructor(private info: FaceDefinition, atlas: HTMLImageElement, only?: readonly string[]) {
    for (const [view, mouths] of Object.entries({ default: info.mouths, ...info.atlases })) {
    if (only && !only.includes(view)) continue;
    const patches = new Map<Mouth, HTMLCanvasElement>();
    for (const [mouth, [x, y, width, height]] of Object.entries(mouths)) {
      const patch = Object.assign(document.createElement('canvas'), { width, height });
      const c = patch.getContext('2d')!;
      const anchor = info.anchors?.[view], frame = info.frames?.[view]?.[mouth as Mouth] ?? anchor;
      const dx = anchor && frame ? (anchor[0] + anchor[2] / 2 - frame[0] - frame[2] / 2) * width : 0;
      const dy = anchor && frame ? (anchor[1] - frame[1]) * height : 0;
      c.drawImage(atlas, x, y, width, height, dx, dy, width, height);
      if(mouth==='X'){
        const raw=Object.assign(document.createElement('canvas'),{width,height});
        raw.getContext('2d')!.drawImage(patch,0,0);this.neutral.set(view,raw);
      }
      // Feather only the outer beard/skin; the lips in the centre stay opaque.
      const [cx, cy, rx, ry] = anchor && frame ? [
        (anchor[0] + anchor[2] / 2) * width, (anchor[1] + frame[3] / 2) * height,
        Math.max(frame[2] / 2 + anchor[2] * 0.12, anchor[2] * 0.65) * width,
        (frame[3] / 2 + anchor[2] * 0.12) * height,
      ] : [width / 2, height / 2, width / 2, height / 2];
      feather(c, cx, cy, rx, ry);
      patches.set(mouth as Mouth, patch);
    }
    this.patches.set(view, patches);
    }
  }

  draw(image: Surface, sheet: string, cell: number, cols: number, rows: number, articulation: Articulation, time: number, sourceCell = cell, override?: FacePose, performance?: FaceState): CanvasImageSource {
    const pose = override ?? (sheet === '$image' ? this.info.imagePose : this.info.sheets[sheet]?.[cell]);
    const width = image.width / cols, height = image.height / rows;
    // Only the explicitly registered poses are touched.
    if (!pose) return image;
    const state = performance ?? faceAt(articulation, time, this.info.seed);
    const { blink, brow: lift } = state;
    const patches = this.patches.get(pose.atlas ?? 'default');
    if (!patches) return image;
    const key = [sheet, cell, pose.atlas, image instanceof HTMLCanvasElement ? Math.floor(time * 60) : '', pose.mouth.join(','), pose.lips?.join(','), pose.sourceOpen, articulation.mouth, articulation.previous, articulation.mix.toFixed(2), blink.toFixed(2), lift.toFixed(2)].join(':');
    if (key === this.cache) return this.canvas;
    this.cache = key;
    this.revision++;
    if (this.canvas.width !== width || this.canvas.height !== height) Object.assign(this.canvas, { width, height });
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, width, height);
    const ox = (sourceCell % cols) * width, oy = Math.floor(sourceCell / cols) * height;
    c.drawImage(image, ox, oy, width, height, 0, 0, width, height);
    const [x, y, w, h] = pose.mouth;
    const view = pose.atlas ?? 'default', anchor = this.info.anchors?.[view];
    const neutral = patches.get('X')!;
    const destination: Box = pose.lips && anchor ? (() => {
      // Uniform scale from the ORIGINAL mouth corners. The nose, jaw and beard stay as painted.
      const [lx,ly,lw] = pose.lips, scale = lw / (anchor[2] * neutral.width);
      const pw = neutral.width * scale, ph = neutral.height * scale;
      return [lx + lw / 2 - (anchor[0] + anchor[2] / 2) * pw, ly - anchor[1] * ph, pw, ph];
    })() : [x,y,w,h];
    if(pose.sourceOpen && pose.lips && anchor && this.info.frames?.[view]){
      const height=pose.lips[3]/(destination[2]/neutral.width),key=`${view}:${height.toFixed(2)}`;
      let closed=this.closed.get(key);
      if(!closed){
        const raw=this.neutral.get(view)!;
        closed=Object.assign(document.createElement('canvas'),{width:raw.width,height:raw.height});
        const n=closed.getContext('2d')!;n.drawImage(raw,0,0);
        const h=Math.max(height,anchor[3]*raw.height);
        feather(n, (anchor[0]+anchor[2]/2)*raw.width, anchor[1]*raw.height+h/2,
          anchor[2]*raw.width*.7, h/2+anchor[2]*raw.width*.12);
        this.closed.set(key,closed);
      }
      if(this.closure.width!==neutral.width||this.closure.height!==neutral.height)Object.assign(this.closure,{width:neutral.width,height:neutral.height});
      const n=this.closure.getContext('2d')!;n.clearRect(0,0,this.closure.width,this.closure.height);n.drawImage(closed,0,0);
      n.globalCompositeOperation='destination-in';n.drawImage(image,ox+destination[0],oy+destination[1],destination[2],destination[3],0,0,this.closure.width,this.closure.height);n.globalCompositeOperation='source-over';
      c.drawImage(this.closure,...destination);
    }
    if (this.blend.width !== neutral.width || this.blend.height !== neutral.height) Object.assign(this.blend, { width: neutral.width, height: neutral.height });
    const blend = this.blend.getContext('2d')!;
    blend.clearRect(0,0,this.blend.width,this.blend.height);
    // A single premultiplied crossfade avoids stacking two feathered lower faces over the original.
    blend.globalCompositeOperation = 'lighter';
    for (const [mouth,weight] of [[articulation.previous,1-articulation.mix],[articulation.mouth,articulation.mix]] as Array<[Mouth,number]>) {
      // Closed source art stays exact; originally open gestures have the neutral underlay above.
      if (!pose.lips || !anchor || !this.info.frames?.[view] || mouth === 'X' || mouth === 'A' || weight <= 0) continue;
      blend.globalAlpha = weight;
      blend.drawImage(patches.get(mouth)!,0,0,this.blend.width,this.blend.height);
    }
    blend.globalAlpha = 1;
    // Lip paint cannot grow past the source silhouette, including a puckered profile.
    blend.globalCompositeOperation = 'destination-in';
    blend.drawImage(image,ox+destination[0],oy+destination[1],destination[2],destination[3],0,0,this.blend.width,this.blend.height);
    blend.globalCompositeOperation = 'source-over';
    c.drawImage(this.blend, ...destination);
    for (const eye of pose.eyes) this.eye(c, image, ox, oy, eye, blink, lift);
    return this.canvas;
  }

  /** Compress the original painted eye between its lids; retain the surrounding skin and brow texture. */
  private eye(c: CanvasRenderingContext2D, image: Surface, ox: number, oy: number, [x, y, w, h]: Box, blink: number, lift: number) {
    if (blink < 0.01 && lift < 0.01) return;
    const middle = h * 0.5, half = h * 0.18, open = Math.max(0.025, half * (1 - blink));
    const source = [0, h * 0.2, middle - half, middle + half, h];
    const target = [0, h * 0.2 - lift, middle - open, middle + open, h];
    for (let i = 0; i < source.length - 1; i++) {
      c.drawImage(image, ox + x, oy + y + source[i], w, source[i + 1] - source[i], x, y + target[i], w, target[i + 1] - target[i]);
    }
  }
}
