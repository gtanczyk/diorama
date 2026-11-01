// The pipeline as an animated diagram for the film: every step of a Diorama build appears in turn, with the model
// that does it and what it made for the lantern harbour (the plan, the painting, the cut-outs, the depth...), joined
// by arrows, then the Studio agent and the self-repair loop around it. Rendered frame by frame (smooth.ts).
//   npx tsx app/demo/architecture-take.ts [--seconds 15] [--out app/demo/footage/architecture.mp4]
// Pictures come from footage/lantern5/method, footage/mock and a frame of footage/lantern6/walk (gitignored).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { takeOption } from '../src/registry.ts';
import { HOLD_FRAMES, smoothTake } from './smooth.ts';

const args = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(takeOption(args, 'out', path.join(here, 'footage/architecture.mp4')));
const seconds = Number(takeOption(args, 'seconds', '15'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
const foot = (...p: string[]) => path.join(here, 'footage', ...p);
const copy = (from: string, name: string) => (fs.existsSync(from) ? (fs.copyFileSync(from, path.join(work, name)), name) : '');
const game = path.join(work, 'game.png');
const walkClip = foot('lantern6/walk/lantern-harbour--harbour-pier.mp4');
if (fs.existsSync(walkClip)) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '6', '-i', walkClip, '-frames:v', '1', '-vf', 'scale=480:-1', game]);

type Node = { title: string; by: string; img?: string; html?: string };
const story = `<svg viewBox="0 0 240 150"><g stroke="#e8c27a" stroke-width="2.5" fill="none"><path d="M40 40 L120 30 L200 45 M120 30 L120 90 M40 40 L60 110 L120 90 L190 115"/></g><g fill="#f6e7c8">${[[40, 40], [120, 30], [200, 45], [120, 90], [60, 110], [190, 115]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9"/>`).join('')}</g></svg>`;
const wave = `<svg viewBox="0 0 240 150"><g stroke="#9fd0ff" stroke-width="5" stroke-linecap="round">${Array.from({ length: 22 }, (_, i) => { const h = 10 + 50 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)); return `<line x1="${14 + i * 10.3}" x2="${14 + i * 10.3}" y1="${75 - h}" y2="${75 + h}"/>`; }).join('')}</g></svg>`;
const idea = `<div class="idea">“A foggy harbour at night. The old lighthouse has gone dark…”</div>`;
const ship = `<div class="ship"><b>.zip</b><span>GitHub Pages</span><span>any browser</span></div>`;
const nodes: Node[] = [
  { title: 'Your idea', by: 'text · photo · voice', html: idea },
  { title: 'World and story', by: 'Muse Spark', html: story },
  { title: 'Plan of each place', by: 'Muse Spark', img: copy(foot('lantern5/method/1-plan.png'), 'plan.png') },
  { title: 'Painting', by: 'Muse Image', img: copy(foot('lantern5/method/2-painting.png'), 'paint.png') },
  { title: 'Cut-outs', by: 'SAM 3.1', img: copy(foot('lantern5/method/3-masks.png'), 'masks.png') },
  { title: 'Depth', by: 'Depth Anything', img: copy(foot('lantern5/method/4-depth.png'), 'depth.png') },
  { title: 'Floor, scale, light', by: 'measured in code', img: copy(foot('lantern5/method/6-walk.png'), 'walk.png') },
  { title: 'Empty stage', by: 'Muse Image', img: copy(foot('lantern5/method/5-backdrop.png'), 'back.png') },
  { title: 'Cast in 3D', by: 'Muse Image · TRELLIS', img: copy(foot('mock/lighthouse-keeper.png'), 'cast.png') },
  { title: 'Voices and sound', by: 'ElevenLabs', html: wave },
  { title: 'The game', by: '2.5D in the browser', img: fs.existsSync(game) ? 'game.png' : '' },
  { title: 'Share', by: 'one command', html: ship },
];

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:radial-gradient(ellipse at 50% 40%,#1b2133,#07080c 78%);font-family:Inter,'DejaVu Sans',sans-serif;color:#f3eee6}
.n{position:absolute;width:262px;height:262px;border-radius:20px;background:#141925;box-shadow:0 18px 50px #0009,0 0 0 1.5px #2c3448;opacity:0;transform:translateY(24px) scale(.94)}
.n .pic{position:absolute;left:11px;top:11px;width:240px;height:150px;border-radius:12px;overflow:hidden;background:#0c0f17;display:grid;place-items:center}
.n .pic img{width:100%;height:100%;object-fit:cover}.n .pic svg{width:100%;height:100%}
.n .t{position:absolute;left:16px;right:12px;top:172px;font-size:23px;font-weight:700;line-height:1.15}
.n .b{position:absolute;left:16px;bottom:16px;padding:5px 12px;border-radius:14px;background:#2f5bea;font-size:16px;font-weight:700;white-space:nowrap}
.n .k{position:absolute;right:14px;bottom:18px;font-size:16px;color:#7f889c;font-weight:700}
.idea{padding:14px 16px;font-family:Caladea,Georgia,serif;font-style:italic;font-size:20px;line-height:1.3;color:#f6e7c8}
.ship{display:flex;flex-direction:column;align-items:center;gap:8px;font-size:18px;color:#cfd6e6}.ship b{font-size:40px;color:#fff}
svg.links{position:absolute;inset:0;width:1920px;height:1080px}
svg.links path{fill:none;stroke:#e8c27a;stroke-width:4;stroke-linecap:round}
.band{position:absolute;left:120px;right:120px;border-radius:18px;padding:16px 24px;font-size:26px;font-weight:700;text-align:center;opacity:0}
#agent{top:46px;background:#1f2a1f;box-shadow:0 0 0 2px #5fbf7a;color:#d8f5df}
#loop{bottom:40px;background:#2a1f1f;box-shadow:0 0 0 2px #e07a5f;color:#f8ddd5}
h1{position:absolute;left:0;right:0;top:470px;margin:0;text-align:center;font-size:30px;font-weight:600;color:#8b93a6;letter-spacing:.2em;text-transform:uppercase;opacity:0}
</style>
<svg class="links" id="links"></svg>
<div class="band" id="agent">Diorama Studio: a coding agent (Muse Code · Claude Code · Codex) runs and fixes every step through MCP</div>
${nodes.map((n, i) => `<div class="n" id="n${i}"><div class="pic">${n.img ? `<img src="${n.img}">` : n.html ?? ''}</div><div class="t">${n.title}</div><div class="b">${n.by}</div><div class="k">${i + 1}</div></div>`).join('')}
<div class="band" id="loop">Every place is played by a bot and checked: a broken step repairs itself and builds again</div>
<script>
const T=${seconds};const N=${nodes.length};
// Two rows of six, left to right; the second row starts under the first.
const pos=i=>{const r=Math.floor(i/6),c=i%6;return [96+c*300,170+r*420]};
const nodes=[...Array(N)].map((_,i)=>document.getElementById('n'+i));
nodes.forEach((n,i)=>{const [x,y]=pos(i);n.style.left=x+'px';n.style.top=y+'px'});
const svg=document.getElementById('links');
const paths=[];
for(let i=0;i<N-1;i++){const [x0,y0]=pos(i),[x1,y1]=pos(i+1);let d;
 if(Math.floor(i/6)===Math.floor((i+1)/6))d='M'+(x0+262)+' '+(y0+131)+' L'+(x1-4)+' '+(y1+131);
 else d='M'+(x0+131)+' '+(y0+262)+' C'+(x0+131)+' '+(y0+380)+' '+(x1+131)+' '+(y1-120)+' '+(x1+131)+' '+(y1-4);
 const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);svg.appendChild(p);const L=p.getTotalLength();p.style.strokeDasharray=L;p.style.strokeDashoffset=L;paths.push([p,L])}
const ease=x=>x<0?0:x>1?1:x*x*(3-2*x);
const step=0.72,start=0.5;
function frame(now){const t=now/1000;
 nodes.forEach((n,i)=>{const a=ease((t-start-i*step)/0.45);n.style.opacity=a;n.style.transform='translateY('+(24*(1-a))+'px) scale('+(0.94+0.06*a)+')'});
 paths.forEach(([p,L],i)=>{const a=ease((t-start-i*step-0.3)/0.45);p.style.strokeDashoffset=L*(1-a)});
 const end=start+N*step;
 document.getElementById('agent').style.opacity=ease((t-end)/0.6);
 document.getElementById('loop').style.opacity=ease((t-end-0.8)/0.6);
 requestAnimationFrame(frame)}
requestAnimationFrame(frame);
</script>`;
fs.writeFileSync(path.join(work, 'index.html'), html);

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(HOLD_FRAMES);
await page.goto(`file://${path.join(work, 'index.html')}`);
await page.waitForTimeout(1500);
fs.mkdirSync(path.dirname(out), { recursive: true });
await smoothTake(page, seconds, out);
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(out);
