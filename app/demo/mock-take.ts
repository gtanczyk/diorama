// The film's Studio scenes as a mock: the real Studio's look (paper, serif, picture cards), fed with the showcase
// world's own pictures, animated on a fixed timeline and stepped frame by frame (smooth.ts). No model calls and no
// live Studio: what the viewer sees is what Diorama does, told in one take with the world the film then plays.
//   npx tsx app/demo/mock-take.ts [--images app/demo/footage/mock] [--out app/demo/footage/mock/studio.mp4]
// Needs in --images: <place>.png and <place>-plan.png for the four places, and <character>.png for the cast.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { takeOption } from '../src/registry.ts';
import { HOLD_FRAMES, smoothTake } from './smooth.ts';

const args = process.argv.slice(2);
const images = path.resolve(takeOption(args, 'images', 'app/demo/footage/mock'));
const out = path.resolve(takeOption(args, 'out', path.join(images, 'studio.mp4')));

const IDEA = 'A foggy harbour at night. The old lighthouse has gone dark and the fishing boats are still out. A young lamplighter has one night to wake it.';
const PLACES = [
  { key: 'harbour-pier', name: 'Harbour pier' },
  { key: 'lantern-market', name: 'Lantern market' },
  { key: 'river-dock', name: 'River dock' },
  { key: 'lighthouse-point', name: 'Lighthouse point' },
];
const CAST = [
  { key: 'lamplighter', name: 'The lamplighter' },
  { key: 'candle-child', name: 'The candle child' },
  { key: 'lighthouse-keeper', name: 'The old keeper' },
];
/** Seconds: when each beat starts. */
const T = { type: 0.6, typed: 5.2, think: 5.6, q1: 7.6, pick1: 10.4, q2: 11.6, pick2: 14.6, ready: 15.6, build: 17.2, built: 31, end: 33 };

const html = `<!doctype html><meta charset="utf-8"><style>
:root{--paper:#f4efe5;--card:#fffdf8;--ink:#2a2622;--faint:#8b847a;--line:#e3dccf;--accent:#c9822b;--display:'Caladea','Bitstream Charter',Georgia,serif}
*{box-sizing:border-box}
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:var(--paper);font-family:Inter,sans-serif;color:var(--ink)}
.rail{position:absolute;left:0;top:0;bottom:0;width:150px;border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;padding-top:34px;gap:10px}
.rail .logo{font-family:var(--display);font-size:22px;margin-top:6px}
.rail .plus{width:46px;height:46px;border-radius:50%;background:var(--card);box-shadow:0 2px 8px #0001;display:grid;place-items:center;font-size:24px;margin:18px 0}
.rail .thumb{width:96px;height:64px;border-radius:8px;background-size:cover;background-position:center;box-shadow:0 2px 6px #0002;opacity:.0}
#stage{position:absolute;left:150px;right:0;top:0;bottom:0}
.scene{position:absolute;inset:0;opacity:0}
.col{position:absolute;left:50%;transform:translateX(-50%);width:1200px}
.idea{top:90px;background:var(--card);border-radius:6px;box-shadow:0 10px 40px #0000000f;padding:44px 52px}
.kicker{font-size:15px;letter-spacing:.18em;color:var(--faint);text-transform:uppercase}
.idea p{font-family:var(--display);font-style:italic;font-size:44px;line-height:1.3;margin:18px 0 0;min-height:172px}
.caret{display:inline-block;width:3px;height:44px;background:var(--ink);vertical-align:-6px;margin-left:2px}
.go{position:absolute;right:52px;bottom:-30px;background:var(--accent);color:#fff;font-weight:600;font-size:20px;padding:16px 34px;border-radius:30px;box-shadow:0 8px 24px #c9822b55}
.think{position:absolute;left:50%;top:560px;transform:translateX(-50%);display:flex;gap:16px;align-items:center;font-size:24px;color:var(--faint)}
.dot{width:12px;height:12px;border-radius:50%;background:var(--accent)}
.badge{display:inline-block;background:#2b4bd8;color:#fff;font-weight:600;font-size:18px;padding:6px 16px;border-radius:20px}
.q{top:420px}
.q h2{font-family:var(--display);font-weight:400;font-size:46px;margin:0 0 26px}
.cards{display:flex;gap:30px}
.card{width:380px;background:var(--card);border-radius:6px;box-shadow:0 8px 30px #00000014;padding:14px 14px 18px;border:2px solid transparent;transition:none;position:relative}
.card .pic{height:250px;border-radius:3px;background-size:cover;background-position:center;background-color:#dedbd4}
.card b{display:block;font-family:var(--display);font-weight:400;font-size:30px;text-align:center;margin-top:14px}
.card small{display:block;text-align:center;color:var(--faint);font-size:14px;letter-spacing:.06em;margin-top:4px}
.card .tick{position:absolute;right:26px;top:26px;width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:24px;opacity:0}
.cursor{position:absolute;width:28px;height:28px;left:0;top:0;z-index:9;pointer-events:none}
.ready{top:840px;font-family:var(--display);font-size:52px}
.build h2{font-family:var(--display);font-weight:400;font-size:46px;margin:0}
.build .sub{color:var(--faint);font-size:20px;margin-top:8px}
.tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:26px;margin-top:30px}
.tile{position:relative;height:330px;border-radius:6px;overflow:hidden;background:#d9d4ca;box-shadow:0 8px 30px #0000001a}
.tile .img{position:absolute;inset:0;background-size:cover;background-position:center}
.tile .label{position:absolute;left:14px;bottom:12px;background:#000a;color:#fff;font-size:18px;padding:6px 14px;border-radius:16px}
.tile .step{position:absolute;right:14px;top:12px;background:#fffffff0;font-size:16px;padding:6px 14px;border-radius:16px;font-weight:600}
.castrow{display:flex;gap:18px;margin-top:22px}
.who{width:140px;height:104px;border-radius:6px;background-size:cover;background-position:center;background-color:#dedbd4;box-shadow:0 4px 14px #0002;opacity:0}
.bar{height:8px;border-radius:4px;background:var(--line);margin-top:22px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--accent)}
</style>
<div class="rail"><svg width="40" height="44" viewBox="0 0 40 44"><path d="M6 42V18a14 14 0 0 1 28 0v24z" fill="none" stroke="#2a2622" stroke-width="2.5"/><circle cx="20" cy="24" r="4" fill="#c9822b"/><path d="M10 42c4-6 16-6 20 0" fill="none" stroke="#2a2622" stroke-width="2"/></svg><div class="logo">Diorama</div><div class="plus">+</div>
${PLACES.slice(0, 3).map((p) => `<div class="thumb" style="background-image:url(${p.key}.png)"></div>`).join('')}</div>
<div id="stage">
 <div class="scene" id="s-idea">
  <div class="col idea"><div class="kicker">Your idea</div><p><span id="typed"></span><span class="caret" id="caret"></span></p><div class="go" id="go">Shape my world →</div></div>
  <div class="think" id="think"><span class="badge">Muse Spark</span><span class="dot" id="d1"></span><span class="dot" id="d2"></span><span class="dot" id="d3"></span><span>reads your idea</span></div>
  <div class="col q" id="q1"><h2>Who do you play?</h2><div class="cards">${CAST.map((c, i) => `<div class="card" id="c1-${i}"><div class="pic" style="background-image:url(${c.key}.png)"></div><b>${c.name}</b><small>Concept sketch</small><div class="tick">✓</div></div>`).join('')}</div></div>
  <div class="col q" id="q2"><h2>What wakes the lighthouse?</h2><div class="cards">
   <div class="card" id="c2-0"><div class="pic" style="background-image:url(harbour-pier.png);background-position:28% 60%;background-size:260%"></div><b>Old lamp oil</b><small>Concept sketch</small><div class="tick">✓</div></div>
   <div class="card" id="c2-1"><div class="pic" style="background-image:url(lantern-market.png);background-position:50% 30%;background-size:180%"></div><b>Every lantern in town</b><small>Concept sketch</small><div class="tick">✓</div></div>
   <div class="card" id="c2-2"><div class="pic" style="background-image:url(river-dock.png);background-position:70% 75%;background-size:200%"></div><b>A paper candle boat</b><small>Concept sketch</small><div class="tick">✓</div></div>
  </div></div>
  <div class="col ready" id="ready">Ready to build your world.<div class="go" id="go2" style="right:0;bottom:6px">Build my world</div></div>
 </div>
 <div class="scene build" id="s-build"><div class="col" style="top:56px">
  <h2>The Lantern Harbour at Night</h2><div class="sub" id="status">Planning four places…</div>
  <div class="bar"><i id="bar"></i></div>
  <div class="tiles">${PLACES.map((p, i) => `<div class="tile"><div class="img" id="plan-${i}" style="background-image:url(${p.key}-plan.png);opacity:0"></div><div class="img" id="paint-${i}" style="background-image:url(${p.key}.png);opacity:0"></div><div class="step" id="step-${i}">Waiting</div><div class="label">${p.name}</div></div>`).join('')}</div>
  <div class="castrow">${CAST.map((c, i) => `<div class="who" id="who-${i}" style="background-image:url(${c.key}.png)"></div>`).join('')}</div>
 </div></div>
</div>
<svg class="cursor" id="cursor" viewBox="0 0 28 28"><path d="M3 2l20 11-9 2-4 9z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>
<script>
const T=${JSON.stringify(T)};const IDEA=${JSON.stringify(IDEA)};
const $=(id)=>document.getElementById(id);const clamp=(x)=>x<0?0:x>1?1:x;const ease=(x)=>{x=clamp(x);return x*x*(3-2*x)};
const fade=(t,a,b,d=0.5)=>ease((t-a)/d)*(1-ease((t-b)/d));
const centre=(el)=>{const r=el.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]};
function cursorPath(t){
 // Where the pointer is: resting, then gliding to each thing it clicks a moment before the click.
 const stops=[[T.type,[1500,900]],[T.typed-0.6,'go'],[T.q1+1.2,[1300,980]],[T.pick1-0.7,'c1-0'],[T.q2+1,[1300,980]],[T.pick2-0.7,'c2-1'],[T.ready+0.2,[1500,980]],[T.build-0.7,'go2'],[T.build+1.4,[1880,1060]]];
 const at=(s)=>typeof s==='string'?centre($(s)):s;
 let p=at(stops[0][1]);
 for(let i=1;i<stops.length;i++){const [t0]=stops[i-1];const [t1,s]=stops[i];if(t>=t1){p=at(s);continue}if(t>t0){const a=at(stops[i-1][1]),b=at(s);const k=ease((t-Math.max(t0,t1-0.9))/0.9);p=[a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k]}break}
 return p;
}
function frame(now){const t=now/1000;
 $('s-idea').style.opacity=String(fade(t,0,T.build+0.3,0.4));
 $('s-build').style.opacity=String(ease((t-T.build-0.2)/0.6));
 // Typing, a natural rhythm: faster mid-word, a beat at commas and full stops.
 const n=Math.floor(clamp((t-T.type)/(T.typed-T.type))*IDEA.length);$('typed').textContent=IDEA.slice(0,n);
 $('caret').style.opacity=t<T.typed?(Math.floor(t*2)%2?'0':'1'):'0';
 const ideaUp=ease((t-T.think)/0.8);
 document.querySelector('.idea').style.transform='translateX(-50%) translateY('+(-ideaUp*0)+'px) scale('+(1-0.0*ideaUp)+')';
 $('go').style.transform='scale('+(1-0.08*fade(t,T.typed-0.05,T.typed+0.1,0.08))+')';
 $('go').style.opacity=String(1-ease((t-T.typed-0.2)/0.4));
 $('think').style.opacity=String(fade(t,T.think,T.q1,0.3));
 [1,2,3].forEach(i=>$('d'+i).style.opacity=String(0.25+0.75*Math.max(0,Math.sin(t*6-i))));
 // Question 1, then it slides up out of the way for question 2.
 const q1=ease((t-T.q1)/0.6),q1out=ease((t-T.q2+0.4)/0.6);
 $('q1').style.opacity=String(q1*(1-q1out));$('q1').style.transform='translateX(-50%) translateY('+(40*(1-q1)-120*q1out)+'px)';
 const q2=ease((t-T.q2)/0.6),q2out=ease((t-T.ready)/0.5);
 $('q2').style.opacity=String(q2*(1-q2out));$('q2').style.transform='translateX(-50%) translateY('+(40*(1-q2)-120*q2out)+'px)';
 [0,1,2].forEach(i=>{const c=$('c1-'+i);c.style.opacity=String(ease((t-T.q1-0.15*i)/0.5));});
 [0,1,2].forEach(i=>{const c=$('c2-'+i);c.style.opacity=String(ease((t-T.q2-0.15*i)/0.5));});
 const pick=(id,at)=>{const c=$(id);const k=ease((t-at)/0.25);c.style.borderColor=k>0.5?'#c9822b':'transparent';c.querySelector('.tick').style.opacity=String(k);c.style.transform='scale('+(1+0.03*k-0.04*fade(t,at-0.05,at+0.08,0.08))+')'};
 pick('c1-0',T.pick1);pick('c2-1',T.pick2);
 $('ready').style.opacity=String(fade(t,T.ready,T.build+0.2,0.5));
 $('go2').style.transform='scale('+(1-0.08*fade(t,T.build-0.05,T.build+0.1,0.08))+')';
 // The build: each place shows its plan, then its painting fades in over it; the cast arrives under them.
 const B=T.build+0.6,span=T.built-B;
 const steps=['Planning','Painting','Cutting out','Depth','Ready'];
 [0,1,2,3].forEach(i=>{const s=B+i*1.1;
  $('plan-'+i).style.opacity=String(ease((t-s)/0.6));
  const paint=s+3.2+i*0.6;$('paint-'+i).style.opacity=String(ease((t-paint)/1.4));
  const k=t<s?-1:t<paint?0:t<paint+2?1:t<paint+3.5?2:t<paint+5?3:4;
  $('step-'+i).textContent=k<0?'Waiting':steps[k];$('step-'+i).style.color=k===4?'#2f7d3a':'#2a2622';});
 CAST.forEach((c,i)=>{$('who-'+i).style.opacity=String(ease((t-B-6-i*1.2)/0.6))});
 $('bar').style.width=(100*clamp((t-B)/span))+'%';
 const lines=['Muse Spark plans four places…','Muse Image paints each place over its plan…','SAM 3.1 cuts out everything you can touch…','Painting the cast, giving them voices…','Ready to play.'];
 $('status').textContent=lines[Math.min(4,Math.floor(clamp((t-B)/span)*4.999))];
 const [cx,cy]=cursorPath(t);$('cursor').style.transform='translate('+(cx-3)+'px,'+(cy-2)+'px)';
 requestAnimationFrame(frame)}
const CAST=${JSON.stringify(CAST)};
requestAnimationFrame(frame);
</script>`;
fs.writeFileSync(path.join(images, 'index.html'), html);

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(HOLD_FRAMES);
await page.goto(`file://${path.join(images, 'index.html')}`);
await page.waitForLoadState('load');
await page.waitForTimeout(800);
await smoothTake(page, T.end, out);
await browser.close();
console.log(out);
