import fs from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';

let browser: Browser, source: string;
beforeAll(async () => {
  source = (await build({ stdin: { contents: `
    import {h,render} from 'preact'; import {useState} from 'preact/hooks'; import {IdeaReview} from './app/studio/idea-review.tsx'; import {Lightbox} from './app/studio/lightbox.tsx';
    const input=window.testInput??{idea:'Smok szuka domu',photos:[],videos:[]}; window.builds=[];
    function App(){const [open,setOpen]=useState(true); return open ? h(IdeaReview,{input,busy:false,error:'',onBuild:(choices,sketch)=>{window.builds.push({input,choices,...(sketch?{sketch}:{})});setOpen(false)},onBack:()=>setOpen(false)}) : h('button',{onClick:()=>setOpen(true)},'Open review')};
    render(h('div',{id:'app'},h('main',{class:'start reviewing'},h(App)),h(Lightbox)),document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => { await browser?.close(); });

async function open(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('http://review.test/', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.route('**/api/actions/idea_preview', r => r.fulfill({ json: { result: { image: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#ebe3d5"/><circle cx="240" cy="160" r="65" fill="#faf6ee" stroke="#6f675d" stroke-width="4"/></svg>') } } }));
  await page.goto('http://review.test/');
  await page.addStyleTag({ content: fs.readFileSync('app/studio/style.css', 'utf8') });
  await page.addScriptTag({ content: source });
  await page.getByRole('region', { name: 'Shape your world' }).waitFor();
}
const result = { understanding: 'Smok szuka drogi do domu.', questions: [{ question: 'Czyj to klucz?', why: 'To określi komu pomożemy.', options: ['Smoka', 'Sowy'] }], styles: [{ title: 'Ołówek', description: 'Czarna kreska na jasnym papierze, z dziecięcymi proporcjami.' }, { title: 'Papierowa wycinanka', description: 'Warstwy kolorowego papieru, proste kształty i miękkie cienie.' }] };

test('one conversational question at a time, optional looks, and explicit choices reach the build', async () => {
  const page = await browser.newPage({ viewport: { width: 980, height: 900 } });
  try {
    const requests: any[] = [];
    const previewRequests: string[] = [];
    page.on('request', r => { if (r.url().endsWith('/idea_sketch')) previewRequests.push(r.url()); });
    await page.route('**/api/actions/idea_review', r => {
      const input = r.request().postDataJSON(); requests.push(input);
      return r.fulfill({ json: { result: input.choices ? { ...result, questions: [] } : result } });
    });
    await open(page);
    await page.getByRole('button', { name: 'Something else…' }).waitFor();
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await page.getByText('Smok szuka domu', {exact:true}).count()).toBe(1);
    await page.screenshot({ path: '/tmp/diorama-question-actions-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/diorama-question-actions-mobile.png' });
    await page.setViewportSize({ width: 980, height: 900 });
    await page.getByRole('button', { name: 'Something else…' }).click();
    expect(await page.getByRole('textbox').count()).toBe(1);
    expect(await page.locator('fieldset').count()).toBe(0);
    expect(await page.getByText(result.understanding).count()).toBe(0);
    expect(await page.getByText(result.styles[0].description).count()).toBe(0);
    expect(await page.evaluate(() => (window as any).builds)).toEqual([]);
    await page.getByRole('region', { name: 'Shape your world' }).screenshot({ path: '/tmp/diorama-idea-review-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.idea-review').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.getByRole('region', { name: 'Shape your world' }).screenshot({ path: '/tmp/diorama-idea-review-mobile.png' });
    await page.getByRole('textbox', { name: 'Your reply' }).fill('Sowy, ale smok go pożyczył. Bez walki.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await page.getByText('Your story is ready for its first sketches.').waitFor();
    expect(requests[1].choices.answers).toEqual([{ question: 'Czyj to klucz?', answer: 'Sowy, ale smok go pożyczył. Bez walki.' }]);
    await page.getByRole('button', { name: 'Show me some looks' }).click();
    await page.getByRole('button', { name: /^Ołówek/ }).click();
    expect(await page.getByRole('button', { name: 'Skip & build now', exact: true }).getAttribute('class')).toBe('ghost');
    expect(await page.getByRole('button', { name: 'Choose cast & places', exact: true }).getAttribute('class')).toBe('primary');
    await page.getByRole('button', { name: 'Skip & build now', exact: true }).click();
    const builds = await page.evaluate(() => (window as any).builds);
    expect(builds).toEqual([{ input: { idea: 'Smok szuka domu', photos: [], videos: [] }, choices: { answers: [{ question: 'Czyj to klucz?', answer: 'Sowy, ale smok go pożyczył. Bez walki.' }], style: result.styles[0].description } }]);
    expect(JSON.stringify(builds)).not.toContain(result.understanding);
    expect(JSON.stringify(builds)).not.toContain(result.styles[1].description);
    expect(previewRequests).toEqual([]);
  } finally { await page.close(); }
});

test('skip stays usable during analysis; a late result cannot start another build or reopen the dialog', async () => {
  const page = await browser.newPage();
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(r => release = r), requested = new Promise<void>(r => entered = r);
  try {
    await page.route('**/api/actions/idea_review', async r => { entered(); await wait; await r.fulfill({ json: { result } }).catch(() => {}); });
    await open(page); await requested;
    const thinking = page.getByRole('button', { name: 'Thinking…', exact: true });
    expect(await thinking.isDisabled()).toBe(true);
    expect(await thinking.getAttribute('aria-busy')).toBe('true');
    expect(await thinking.locator('.review-spinner').count()).toBe(1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await thinking.locator('.review-spinner').evaluate(e => getComputedStyle(e).animationName)).toBe('review-spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await thinking.locator('.review-spinner').evaluate(e => getComputedStyle(e).animationName)).toBe('none');
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.screenshot({ path: '/tmp/diorama-review-waiting-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/diorama-review-waiting-mobile.png' });
    await page.getByRole('button', { name: 'Skip & build' }).click();
    expect(await page.evaluate(() => (window as any).builds)).toEqual([{ input: { idea: 'Smok szuka domu', photos: [], videos: [] } }]);
    release();
    await page.getByRole('button', { name: 'Open review' }).waitFor();
    expect(await page.getByRole('region', { name: 'Shape your world' }).count()).toBe(0);
  } finally { release(); await page.close(); }
});

test('service failure allows skip without inventing answers', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ status: 502, json: { error: 'Temporarily unavailable' } }));
    await open(page);
    await page.getByRole('alert').waitFor();
    await page.getByRole('button', { name: 'Skip & build' }).click();
    expect(await page.evaluate(() => (window as any).builds[0].choices)).toBeUndefined();
  } finally { await page.close(); }
});

test('original drawing choices display immediately without asking an image model', async () => {
  const page = await browser.newPage();
  const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const previewCalls: string[] = [];
  page.on('request', r => { if (r.url().endsWith('/idea_preview')) previewCalls.push(r.url()); });
  try {
    await page.addInitScript(({ picture }) => { (window as any).testInput = { idea: 'Smok szuka domu', photos: [{ name: 'dragon.png', data: picture }, { name: 'owl.png', data: picture }], videos: [] }; }, { picture });
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: { ...result, questions: [{ ...result.questions[0], visuals: [{ photo: 0, scene: 'The dragon' }, { photo: 1, scene: 'The owl' }] }] } } }));
    await open(page);
    await page.getByRole('button', { name: 'Sowy', exact: true }).waitFor();
    expect(await page.locator('.idea-card img').count()).toBe(2);
    expect(await page.locator('.idea-card img').first().getAttribute('src')).toBe(picture);
    expect(previewCalls).toEqual([]);
    await page.getByRole('button', { name: 'Skip & build' }).click();
    expect(await page.evaluate(() => (window as any).builds[0].input.photos.length)).toBe(2);
  } finally { await page.close(); }
});

test('skip during a follow-up keeps the answer already given', async () => {
  const page = await browser.newPage();
  let release!: () => void;
  const wait = new Promise<void>(r => release = r);
  try {
    await page.route('**/api/actions/idea_review', async r => {
      if (r.request().postDataJSON().choices) await wait;
      await r.fulfill({ json: { result } }).catch(() => {});
    });
    await open(page);
    await page.getByRole('button', { name: 'Sowy', exact: true }).click();
    await page.getByText('Got it. One moment…').waitFor();
    expect(await page.getByRole('button', { name: 'Thinking…', exact: true }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Skip & build' }).click();
    expect(await page.evaluate(() => (window as any).builds[0].choices)).toEqual({ answers: [{ question: 'Czyj to klucz?', answer: 'Sowy' }] });
  } finally { release(); await page.close(); }
});

test('a quick reply advances and the conversation stops after one follow-up', async () => {
  const page = await browser.newPage();
  let calls = 0;
  try {
    await page.route('**/api/actions/idea_review', r => { calls++; return r.fulfill({ json: { result: calls === 1 ? result : { ...result, questions: [{ question: 'Co otwiera?', why: '', options: ['Dom', 'Skrzynię'] }] } } }); });
    await open(page);
    await page.getByRole('button', { name: 'Sowy', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Choose cast & places' }).isDisabled()).toBe(true);
    expect(await page.locator('footer .review-spinner').count()).toBe(0);
    await page.getByRole('button', { name: 'Sowy', exact: true }).click();
    await page.getByRole('button', { name: 'Dom', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Choose cast & places' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Dom', exact: true }).click();
    await page.getByRole('button', { name: 'Skip & build now', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Choose cast & places' }).isEnabled()).toBe(true);
    expect(calls).toBe(2);
    expect(await page.getByRole('textbox').count()).toBe(0);
    await page.getByRole('button', { name: 'Skip & build now', exact: true }).click();
    expect((await page.evaluate(() => (window as any).builds[0].choices.answers)).length).toBe(2);
  } finally { await page.close(); }
});

test('back allows editing the idea without creating a world', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result } }));
    await open(page);
    await page.getByRole('button', { name: 'Back to idea' }).click();
    await page.getByRole('button', { name: 'Open review' }).waitFor();
    expect(await page.evaluate(() => (window as any).builds)).toEqual([]);
  } finally { await page.close(); }
});

test('world storyboard keeps alternatives selectable and builds only the approved cast and places', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const id = 'c'.repeat(32);
  const assets = [
    { kind: 'character', key: 'dragon', label: 'Smok', role: 'hero', looks: 'A white dragon' },
    { kind: 'character', key: 'owl', label: 'Sowa', role: 'npc', looks: 'A round owl' },
    { kind: 'place', key: 'house', label: 'Domek na łące', role: 'place', looks: 'A house in a meadow' },
    { kind: 'place', key: 'bridge', label: 'Most nad rzeką', role: 'place', looks: 'A wooden bridge' },
  ];
  const imageCalls: any[] = [];
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: { ...result, questions: [] } } }));
    await page.route('**/api/actions/idea_sketch', r => r.fulfill({ json: { result: { id, title: 'Smocza poczta', pitch: 'Pomóż smokowi dostarczyć list do sowy.', assets } } }));
    await page.route('**/api/actions/idea_sketch_image', r => {
      const request = r.request().postDataJSON(); imageCalls.push(request);
      const colour = request.take ? '#c78132' : request.kind === 'place' ? '#adbf8b' : '#c8b0d4';
      const image = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#eee5d6"/><path d="M120 290V160L240 60L360 160V290Z" fill="${colour}" stroke="#554c41" stroke-width="4"/></svg>`);
      return r.fulfill({ json: { result: { image } } });
    });
    await open(page);
    await page.getByRole('button', { name: 'Choose cast & places' }).click();
    await page.getByRole('button', { name: 'Build this version' }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.idea-storyboard button.primary')!.disabled);
    expect(await page.evaluate(() => (window as any).builds)).toEqual([]);
    expect(await page.getByText('PREVIEW', { exact: true }).count()).toBe(4);
    expect(imageCalls).toHaveLength(4);
    const dragon = page.getByRole('article', { name: 'Smok', exact: true });
    await dragon.getByRole('button', { name: 'Another version' }).click();
    const first = dragon.getByRole('button', { name: 'Smok, version 1' });
    await first.waitFor(); await first.click();
    expect(await first.getAttribute('aria-pressed')).toBe('true');
    expect(imageCalls).toHaveLength(5);
    expect(imageCalls[4]).toMatchObject({ key: 'dragon', take: 1 });
    await page.screenshot({ path: '/tmp/diorama-storyboard-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.idea-review').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/diorama-storyboard-mobile.png' });
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const lastCard = await page.getByRole('article', { name: 'Most nad rzeką' }).boundingBox();
    const footer = await page.locator('.idea-storyboard footer').boundingBox();
    expect(lastCard!.y).toBeGreaterThanOrEqual(0);
    expect(lastCard!.y + lastCard!.height).toBeLessThanOrEqual(footer!.y);
    await page.screenshot({ path: '/tmp/diorama-storyboard-mobile-bottom.png' });
    await page.getByRole('button', { name: 'Build this version' }).click();
    expect(await page.evaluate(() => (window as any).builds)).toEqual([{ input: { idea: 'Smok szuka domu', photos: [], videos: [] }, sketch: { id, selections: { 'character:dragon': 0, 'character:owl': 0, 'place:house': 0, 'place:bridge': 0 } } }]);
  } finally { await page.close(); }
});

test('a failed storyboard image prevents approval but skip still builds with the accepted answers', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: r.request().postDataJSON().choices ? { ...result, questions: [] } : result } }));
    await page.route('**/api/actions/idea_sketch', r => r.fulfill({ json: { result: { id: 'c'.repeat(32), title: 'Home', pitch: 'An owl comes home', assets: [{ kind: 'character', key: 'owl', label: 'Sowa', role: 'hero', looks: 'An owl' }] } } }));
    await page.route('**/api/actions/idea_sketch_image', r => r.fulfill({ status: 502, json: { error: 'Image service unavailable' } }));
    await open(page);
    await page.getByRole('button', { name: 'Sowy', exact: true }).click();
    await page.getByRole('button', { name: 'Choose cast & places' }).click();
    await page.getByRole('button', { name: 'Retry preview' }).waitFor();
    expect(await page.getByRole('button', { name: 'Build this version' }).isDisabled()).toBe(true);
    await expect.poll(() => page.locator('footer .review-spinner').count()).toBe(0);
    await page.getByRole('button', { name: 'Skip & build' }).click();
    expect(await page.evaluate(() => (window as any).builds[0])).toEqual({ input: { idea: 'Smok szuka domu', photos: [], videos: [] }, choices: { answers: [{ question: 'Czyj to klucz?', answer: 'Sowy' }] } });
  } finally { await page.close(); }
});

test('chosen pictures remain visible; editing an earlier choice drops dependent answers and reuses its original pictures', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
  const reviews: any[] = [], paintings: any[] = [];
  page.on('request', r => { if (r.url().endsWith('/idea_preview')) paintings.push(r.postDataJSON()); });
  try {
    await page.route('**/api/actions/idea_review', r => {
      const input = r.request().postDataJSON(); reviews.push(input);
      return r.fulfill({ json: { result: input.choices ? { ...result, questions: [{ question: 'Co otwiera?', why: '', options: ['Dom', 'Skrzynię'] }] } : result } });
    });
    await open(page);
    const initial = page.getByRole('button', { name: 'Sowy', exact: true });
    await initial.locator('img').waitFor();
    const picture = await initial.locator('img').getAttribute('src');
    await initial.click();
    const first = page.getByRole('region', { name: 'Decision: Czyj to klucz?' });
    await page.getByRole('button', { name: 'Dom', exact: true }).click();
    expect(await first.getByRole('button', { name: 'Sowy', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await first.getByRole('button', { name: 'Sowy', exact: true }).locator('img').getAttribute('src')).toBe(picture);
    expect(await first.getByRole('button', { name: 'Smoka', exact: true }).count()).toBe(0);
    await page.screenshot({ path: '/tmp/diorama-retained-choices.png' });
    const paintedBefore = paintings.length;
    await first.getByRole('button', { name: 'Change answer: Czyj to klucz?' }).click();
    await first.getByRole('button', { name: 'Smoka', exact: true }).click();
    await page.getByRole('button', { name: 'Skrzynię', exact: true }).waitFor();
    expect(reviews).toHaveLength(3);
    expect(reviews[2].choices.answers).toEqual([{ question: 'Czyj to klucz?', answer: 'Smoka' }]);
    expect(await page.getByRole('region', { name: 'Decision: Co otwiera?' }).count()).toBe(0);
    expect(await first.getByRole('button', { name: 'Smoka', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(paintings.length).toBe(paintedBefore);
    await page.getByRole('button', { name: 'Skip & build', exact: true }).click();
    expect(await page.evaluate(() => (window as any).builds[0].choices.answers)).toEqual([{ question: 'Czyj to klucz?', answer: 'Smoka' }]);
  } finally { await page.close(); }
});

test('late follow-up for a replaced choice cannot overwrite the current conversation', async () => {
  const page = await browser.newPage();
  let release!: () => void;
  const wait = new Promise<void>(r => release = r);
  try {
    await page.route('**/api/actions/idea_review', async r => {
      const answer = r.request().postDataJSON().choices?.answers[0]?.answer;
      if (answer === 'Sowy') await wait;
      await r.fulfill({ json: { result: !answer ? result : { ...result, questions: [{ question: answer === 'Sowy' ? 'Old question?' : 'New question?', why: '', options: ['Dalej'] }] } } }).catch(() => {});
    });
    await open(page);
    await page.getByRole('button', { name: 'Sowy', exact: true }).click();
    await page.getByText('Got it. One moment…').waitFor();
    await page.getByRole('button', { name: 'Change answer: Czyj to klucz?' }).click();
    await page.getByRole('button', { name: 'Smoka', exact: true }).click();
    await page.getByText('New question?', { exact: true }).waitFor();
    const oldResponse = page.waitForResponse(r => r.url().endsWith('/idea_review') && r.request().postDataJSON().choices?.answers[0]?.answer === 'Sowy');
    release(); await oldResponse;
    // A browser frame lets the stale promise callback run before checking the visible branch.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.getByText('Old question?', { exact: true }).count()).toBe(0);
    expect(await page.getByText('New question?', { exact: true }).isVisible()).toBe(true);
  } finally { release(); await page.close(); }
});

test('free-text answers can be edited; cancelling or choosing the same answer keeps an approved preview intact', async () => {
  const page = await browser.newPage();
  const previews: any[] = [];
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: r.request().postDataJSON().choices ? { ...result, questions: [] } : result } }));
    await page.route('**/api/actions/idea_sketch', r => { previews.push(r.request().postDataJSON()); return r.fulfill({ json: { result: { id: 'c'.repeat(32), pitch: 'An owl comes home', assets: [{ kind: 'character', key: 'owl', label: 'Sowa', role: 'hero' }] } } }); });
    await page.route('**/api/actions/idea_sketch_image', r => r.fulfill({ json: { result: { image: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="30" fill="tan"/></svg>') } } }));
    await open(page);
    await page.getByRole('button', { name: 'Something else…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your reply', exact: true }).fill('To klucz jeża.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await page.getByRole('button', { name: 'Change answer: Czyj to klucz?' }).click();
    await page.getByRole('textbox', { name: 'Change your reply', exact: true }).fill('To klucz babci.');
    await page.getByRole('button', { name: 'Save change' }).click();
    await page.getByRole('button', { name: 'Choose cast & places' }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.idea-storyboard button.primary')!.disabled);
    for (const same of [false, true]) {
      await page.getByRole('button', { name: 'Change answer: Czyj to klucz?' }).click();
      if (same) await page.getByRole('button', { name: 'Save change' }).click();
      else await page.getByRole('button', { name: 'Cancel change: Czyj to klucz?' }).click();
      expect(await page.getByRole('button', { name: 'Build this version' }).isEnabled()).toBe(true);
    }
    expect(previews).toHaveLength(1);
    expect(previews[0].choices.answers).toEqual([{ question: 'Czyj to klucz?', answer: 'To klucz babci.' }]);
    await page.getByRole('button', { name: 'Build this version' }).click();
    expect(await page.evaluate(() => (window as any).builds[0].choices.answers)).toEqual(previews[0].choices.answers);
  } finally { await page.close(); }
});

test('changing the chosen style from the storyboard invalidates its approval and previews the new style', async () => {
  const page = await browser.newPage();
  const previews: any[] = [];
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: { ...result, questions: [] } } }));
    await page.route('**/api/actions/idea_sketch', r => { previews.push(r.request().postDataJSON()); return r.fulfill({ json: { result: { id: 'd'.repeat(32), pitch: 'A little world', assets: [] } } }); });
    await open(page);
    await page.getByRole('button', { name: 'Show me some looks' }).click();
    await page.getByRole('button', { name: 'Ołówek', exact: true }).click();
    await page.getByRole('region', { name: 'Chosen look' }).locator('img').waitFor();
    await page.getByRole('button', { name: 'Choose cast & places' }).click();
    await page.getByRole('button', { name: 'Build this version' }).waitFor();
    await page.getByRole('button', { name: 'Change look' }).click();
    await page.getByRole('button', { name: 'Papierowa wycinanka', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Build this version' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Choose cast & places' }).click();
    await page.getByRole('button', { name: 'Build this version' }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.idea-storyboard button.primary')!.disabled);
    expect(previews.map(p => p.choices.style)).toEqual(result.styles.map(s => s.description));
  } finally { await page.close(); }
});

test('a preview enlarges and accepts pasted visual direction; retries preserve the edit and later revisions use the selected version', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  const calls: any[] = [];
  const id = 'e'.repeat(32);
  const picture = (size: number, colour: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${colour}"/><circle cx="50%" cy="45%" r="22%" fill="#faf6ee"/></svg>`);
  const small = picture(480, '#adbf8b'), large = picture(1600, '#adbf8b');
  let failed = false;
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: { ...result, questions: [] } } }));
    await page.route('**/api/actions/idea_sketch', r => r.fulfill({ json: { result: { id, title: 'Smok', pitch: 'Smok szuka domu.', assets: [{ key: 'dragon', kind: 'character', role: 'hero', label: 'Smok' }, { key: 'owl', kind: 'character', role: 'npc', label: 'Sowa' }] } } }));
    await page.route('**/api/actions/idea_sketch_image', r => {
      const body = r.request().postDataJSON(); calls.push(body);
      if (body.take === 1 && !failed) { failed = true; return r.fulfill({ status: 502, json: { error: 'Temporary outage' } }); }
      return r.fulfill({ json: { result: { image: body.take ? picture(480, '#c78132') : small, largeImage: body.take ? picture(1600, '#c78132') : large, nextTake: body.take + 1 } } });
    });
    await open(page);
    await page.getByRole('button', { name: 'Choose cast & places' }).click();
    const dragon = page.getByRole('article', { name: 'Smok', exact: true });
    await dragon.getByRole('button', { name: 'Enlarge Smok' }).click();
    const box = page.getByRole('dialog', { name: 'Picture' });
    await box.waitFor();
    expect(await box.locator('img').getAttribute('src')).toBe(large);
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'detached' });
    await dragon.getByRole('button', { name: 'Change…' }).click();
    const words = dragon.getByRole('textbox', { name: 'Changes for Smok' });
    await words.fill('Większe skrzydła, zachowaj pyszczek.');
    await words.evaluate(el => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 20;
      canvas.getContext('2d')!.fillRect(0, 0, 20, 20);
      const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([bytes], 'wings.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await dragon.getByAltText('Your reference').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await words.scrollIntoViewIfNeeded();
    expect(await dragon.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/diorama-concept-edit-mobile.png' });
    await page.setViewportSize({ width: 1100, height: 950 });
    await page.screenshot({ path: '/tmp/diorama-concept-edit-desktop.png' });
    await dragon.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await dragon.getByRole('button', { name: 'Retry preview' }).waitFor();
    expect(await dragon.locator('.concept-art').getAttribute('src')).toBe(small);
    await dragon.getByRole('button', { name: 'Retry preview' }).click();
    await dragon.getByRole('button', { name: 'Smok, version 2' }).waitFor();
    const edits = calls.filter(c => c.take === 1);
    expect(edits).toHaveLength(2); expect(edits[0]).toEqual(edits[1]);
    expect(edits[0]).toMatchObject({ key: 'dragon', baseTake: 0, change: 'Większe skrzydła, zachowaj pyszczek.', reference: { name: 'wings.png', data: expect.stringContaining('data:image/') } });
    expect(await dragon.getByRole('button', { name: 'Smok, version 2' }).getAttribute('aria-pressed')).toBe('true');
    await dragon.getByRole('button', { name: 'Change…' }).click();
    await dragon.getByRole('textbox').fill('Teraz niebieski kapelusz.');
    await dragon.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await dragon.getByRole('button', { name: 'Smok, version 3' }).waitFor();
    expect(calls.at(-1)).toMatchObject({ take: 2, baseTake: 1, change: 'Teraz niebieski kapelusz.' });
    expect(calls.at(-1).reference).toBeUndefined();
    expect(calls.filter(c => c.key === 'owl')).toHaveLength(1);
    await page.getByRole('button', { name: 'Build this version' }).click();
    expect(await page.evaluate(() => (window as any).builds[0].sketch)).toEqual({ id, selections: { 'character:dragon': 2, 'character:owl': 0 } });
  } finally { await page.close(); }
});

test('text story choices make no images, mix with visual follow-ups and stay editable', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const reviews: any[] = [], images: any[] = [];
  const first = { question: 'Dlaczego kot ukradł bilet?', why: '', presentation: 'text', options: ['Chce zatrzymać przyjaciela', 'Chroni sekret promu', 'Sam chce odpłynąć'] };
  const next = { question: 'Gdzie schował bilet?', why: '', presentation: 'pictures', options: ['Pod kapeluszem', 'W latarni'], visuals: [{ scene: 'A ferry ticket hidden under a hat' }, { scene: 'A ferry ticket hidden in a lantern' }] };
  page.on('request', r => { if (r.url().endsWith('/idea_preview')) images.push(r.postDataJSON()); });
  try {
    await page.route('**/api/actions/idea_review', r => {
      const body = r.request().postDataJSON(); reviews.push(body);
      const answer = body.choices?.answers[0]?.answer;
      return r.fulfill({ json: { result: { understanding: 'Kot i ostatni prom.', questions: !answer ? [first] : answer === first.options[0] ? [next] : [], styles: [] } } });
    });
    await open(page);
    await page.getByRole('button', { name: first.options[0], exact: true }).waitFor();
    expect(await page.locator('.idea-card').count()).toBe(0);
    expect(images).toEqual([]);
    await page.screenshot({ path: '/tmp/diorama-text-question-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.idea-review').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/diorama-text-question-mobile.png' });
    await page.getByRole('button', { name: first.options[0], exact: true }).click();
    await page.getByRole('button', { name: next.options[0], exact: true }).locator('img').waitFor();
    expect(images).toHaveLength(2);
    await page.getByRole('button', { name: next.options[0], exact: true }).click();
    const history = page.getByRole('region', { name: `Decision: ${first.question}` });
    expect(await history.locator('img').count()).toBe(0);
    expect(await history.getByRole('button', { name: first.options[0], exact: true }).getAttribute('aria-pressed')).toBe('true');
    await history.getByRole('button', { name: `Change answer: ${first.question}` }).click();
    await history.getByRole('button', { name: first.options[1], exact: true }).click();
    await page.getByRole('button', { name: 'Skip & build now', exact: true }).waitFor();
    expect(reviews.at(-1).choices.answers).toEqual([{ question: first.question, answer: first.options[1] }]);
    expect(images).toHaveLength(2);
    await page.getByRole('button', { name: 'Skip & build now', exact: true }).click();
    expect(await page.evaluate(() => (window as any).builds[0].choices.answers)).toEqual([{ question: first.question, answer: first.options[1] }]);
  } finally { await page.close(); }
});

test.each(['choose', 'dismiss', 'build'])('an all-text conversation offers looks automatically without blocking build: %s', async action => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const images: unknown[] = [];
  const first = { question: 'Dlaczego pasażer wraca?', why: '', presentation: 'text', options: ['Szuka przyjaciela', 'Chce odzyskać wspomnienie'] };
  const second = { question: 'Komu zaufa?', why: '', presentation: 'text', options: ['Motorniczemu', 'Nieznajomej'] };
  page.on('request', r => { if (r.url().endsWith('/idea_preview')) images.push(r.postDataJSON()); });
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: { ...result, questions: [r.request().postDataJSON().choices ? second : first] } } }));
    await open(page);
    await page.getByRole('button', { name: first.options[0], exact: true }).click();
    await page.getByRole('button', { name: second.options[0], exact: true }).waitFor();
    expect(images).toHaveLength(0);
    await page.getByRole('button', { name: second.options[0], exact: true }).click();
    const looks = page.getByRole('region', { name: 'Looks for your world' });
    await looks.waitFor();
    await expect.poll(() => images.length).toBe(2);
    expect(await page.getByRole('button', { name: 'Skip & build now', exact: true }).isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Choose cast & places', exact: true }).isEnabled()).toBe(true);
    if (action === 'choose') {
      await looks.locator('.idea-card img').first().waitFor();
      await page.screenshot({ path: '/tmp/diorama-automatic-looks.png' });
      await looks.getByRole('button', { name: result.styles[0].title, exact: true }).click();
      await page.getByRole('region', { name: 'Chosen look' }).waitFor();
    } else if (action === 'dismiss') {
      await looks.getByRole('button', { name: 'Not now', exact: true }).click();
      expect(await looks.count()).toBe(0);
      await page.getByText('Your story is ready for its first sketches.').waitFor();
      expect(images).toHaveLength(2);
    }
    await page.getByRole('button', { name: 'Skip & build now', exact: true }).click();
    const choices = await page.evaluate(() => (window as any).builds[0].choices);
    expect(choices.answers).toEqual([{ question: first.question, answer: first.options[0] }, { question: second.question, answer: second.options[0] }]);
    expect(choices.style).toBe(action === 'choose' ? result.styles[0].description : undefined);
  } finally { await page.close(); }
});

test.each([false, true])('a custom style is previewed, explicitly selected and passed to cast planning (reference: %s)', async reference => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const requests: any[] = [], previewRequests: any[] = [], plans: any[] = [];
  const style = 'Cobalt ink on rough paper with warm lantern light.';
  const referenceId = 'f'.repeat(32), sketchId = 'a'.repeat(32);
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result: { ...result, questions: [], styles: [] } } }));
    await page.route('**/api/actions/idea_style', r => { requests.push(r.request().postDataJSON()); return r.fulfill({ json: { result: { title: 'My blue ink', description: style, ...(reference && { reference: referenceId }) } } }); });
    await page.route('**/api/actions/idea_sketch', r => { plans.push(r.request().postDataJSON()); return r.fulfill({ json: { result: { id: sketchId, title: 'Blue tram', pitch: 'An owl catches a tram', assets: [{ kind: 'character', key: 'owl', label: 'Owl', role: 'hero', looks: 'A round owl' }] } } }); });
    await page.route('**/api/actions/idea_sketch_image', r => r.fulfill({ json: { result: { image: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#789"/></svg>') } } }));
    page.on('request', r => { if (r.url().endsWith('/idea_preview')) previewRequests.push(r.postDataJSON()); });
    await open(page);
    await page.getByRole('button', { name: 'My own style…', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Your own style' });
    const words = editor.getByRole('textbox', { name: 'Changes for your style' });
    await words.fill(style);
    if (reference) {
      await words.evaluate(el => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 20;
        canvas.getContext('2d')!.fillRect(0, 0, 20, 20);
        const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
        const data = new DataTransfer(); data.items.add(new File([bytes], 'ink.png', { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await editor.getByAltText('Your reference').waitFor();
    }
    await editor.getByRole('button', { name: 'Preview my style' }).click();
    await editor.getByRole('button', { name: 'Use this style' }).waitFor();
    expect(await page.getByRole('region', { name: 'Chosen look' }).count()).toBe(0);
    expect(requests[0]).toMatchObject({ words: style });
    expect(!!requests[0].reference).toBe(reference);
    expect(previewRequests[0].styleReference).toBe(reference ? referenceId : undefined);
    // A changed draft must not silently select the older generated result.
    await words.fill(style + ' Softer shadows.');
    await editor.getByRole('button', { name: 'Use this style' }).waitFor({ state: 'detached' });
    await editor.getByRole('button', { name: 'Preview my style' }).click();
    await editor.getByRole('button', { name: 'Use this style' }).waitFor();
    await page.screenshot({ path: `/tmp/diorama-custom-style-${reference}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.getByRole('button', { name: 'Use this style' }).scrollIntoViewIfNeeded();
    expect(await page.locator('.idea-review').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/diorama-custom-style-mobile.png' });
    await editor.getByRole('button', { name: 'Use this style' }).click();
    await page.getByRole('region', { name: 'Chosen look' }).waitFor();
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.screenshot({ path: '/tmp/diorama-style-next-step.png' });
    await page.getByRole('button', { name: 'Choose cast & places', exact: true }).click();
    await page.getByRole('article', { name: 'Owl', exact: true }).waitFor();
    expect(plans[0].choices).toEqual({ answers: [], style, ...(reference && { styleReference: referenceId }) });
    expect(await page.evaluate(() => (window as any).builds)).toEqual([]);
    await page.getByRole('button', { name: 'Build this version' }).click();
    expect(await page.evaluate(() => (window as any).builds[0])).toMatchObject({ choices: plans[0].choices, sketch: { id: sketchId, selections: { 'character:owl': 0 } } });
  } finally { await page.close(); }
});

test('every look card has a magnifier that opens its picture big without choosing it', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.route('**/api/actions/idea_review', r => r.fulfill({ json: { result } }));
    await open(page);
    await page.route('**/api/actions/idea_preview', r => {
      const fill = r.request().postDataJSON().style?.startsWith('Czarna') ? '#ddd' : '#f3c';
      return r.fulfill({ json: { result: { image: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="${fill}"/></svg>`) } } });
    });
    await page.getByRole('button', { name: 'Show me some looks' }).click();
    const zoom = page.getByRole('button', { name: 'Enlarge Papierowa wycinanka' });
    await zoom.waitFor();
    expect(await page.getByRole('button', { name: /^Enlarge / }).count()).toBe(2);
    await zoom.click();
    const box = page.getByRole('dialog', { name: 'Picture' });
    await box.waitFor();
    expect(await box.getByText('2 / 2').count()).toBe(1);
    const img = await box.locator('img').boundingBox();
    expect(img!.y >= 0 && img!.y + img!.height <= 800 && img!.x + img!.width <= 1280).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await page.keyboard.press('ArrowLeft');
    expect(await box.getByText('1 / 2').count()).toBe(1);
    await page.keyboard.press('Escape');
    expect(await page.getByRole('dialog').count()).toBe(0);
    // Looking is not choosing: the look picker is still open and nothing is marked.
    expect(await page.locator('.idea-card.selected').count()).toBe(0);
    await page.getByText('Which look?').waitFor();
    // Keyboard: focus the magnifier and press Enter.
    await page.getByRole('button', { name: 'Enlarge Ołówek' }).focus();
    await page.keyboard.press('Enter');
    expect(await page.getByRole('dialog', { name: 'Picture' }).getByText('1 / 2').count()).toBe(1);
    await page.keyboard.press('Escape');
    expect(await page.locator('.idea-card.selected').count()).toBe(0);
  } finally { await page.close(); }
});

test('queued and sketching labels fit in their cards at desktop and mobile sizes', async () => {
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  try {
    await page.route('**/api/actions/idea_review',r=>r.fulfill({json:{result:{...result,questions:[]}}}));
    await page.route('**/api/actions/idea_sketch',r=>r.fulfill({json:{result:{id:'d'.repeat(32),title:'World',pitch:'A little world',assets:['one','two','three'].map(key=>({kind:'character',key,label:key,role:'npc',looks:'A small animal'}))}}}));
    await page.route('**/api/actions/idea_sketch_image',async r=>{await gate;await r.abort().catch(()=>{});});
    await open(page);
    await page.getByText('Your story is ready for its first sketches.').waitFor();
    expect(await page.getByText('Select Choose cast & places below to see your characters and locations.').isVisible()).toBe(true);
    await page.getByRole('button',{name:'Choose cast & places'}).click();
    await page.getByText('Waiting for a brush…',{exact:true}).first().waitFor();
    for(const width of [1100,390]) {
      await page.setViewportSize({width,height:900});
      for(const text of ['Waiting for a brush…','Sketching…']) {
        const label=page.locator('.concept-placeholder').getByText(text,{exact:true}).first();
        const box=await label.boundingBox(), parent=await label.locator('..').locator('..').boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(parent!.y);
        expect(box!.y+box!.height).toBeLessThanOrEqual(parent!.y+parent!.height);
      }
    }
  } finally { release(); await page.close(); }
});

test('adding a character and a place keeps the chosen versions in the approved expanded world',async()=>{
  const page=await browser.newPage({viewport:{width:1100,height:1000}});
  const first='a'.repeat(32),second='b'.repeat(32);
  const initial=[{kind:'character',key:'owl',label:'Owl',role:'hero',looks:'A round owl'},{kind:'place',key:'house',label:'House',role:'place',looks:'A little house'}];
  const extra=[{kind:'character',key:'fox',label:'Fox',role:'npc',looks:'A red fox'},{kind:'place',key:'garden',label:'Garden',role:'place',looks:'A quiet garden'}];
  let sent:unknown;
  try {
    await page.route('**/api/actions/idea_review',r=>r.fulfill({json:{result:{...result,questions:[]}}}));
    await page.route('**/api/actions/idea_sketch',r=>r.fulfill({json:{result:{id:first,title:'World',pitch:'A little world',assets:initial}}}));
    await page.route('**/api/actions/idea_sketch_expand',r=>{sent=r.request().postDataJSON();return r.fulfill({json:{result:{id:second,title:'World',pitch:'A larger world',assets:[...initial,...extra]}}});});
    await page.route('**/api/actions/idea_sketch_image',r=>r.fulfill({json:{result:{image:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')}}}));
    await open(page);await page.getByRole('button',{name:'Choose cast & places'}).click();
    const add=page.getByRole('button',{name:'Add characters or places…'});await expect.poll(()=>add.isEnabled()).toBe(true);
    const owl=page.getByRole('article',{name:'Owl'});await owl.getByRole('button',{name:'Another version'}).click();
    await owl.getByRole('button',{name:'Owl, version 2'}).waitFor();
    await expect.poll(()=>add.isEnabled()).toBe(true);
    await add.click();await page.getByRole('textbox',{name:'Who else, or where else?'}).fill('Add a fox and a garden');
    await page.getByRole('button',{name:'Add to my world'}).click();
    await page.getByRole('article',{name:'Fox'}).waitFor();await page.getByRole('article',{name:'Garden'}).waitFor();
    const build=page.getByRole('button',{name:'Build this version'});await expect.poll(()=>build.isEnabled()).toBe(true);
    expect(sent).toEqual({id:first,wish:'Add a fox and a garden'});
    await build.click();
    expect(await page.evaluate(()=>(window as any).builds[0].sketch)).toEqual({id:second,selections:{'character:owl':1,'place:house':0,'character:fox':0,'place:garden':0}});
  } finally {await page.close();}
});
