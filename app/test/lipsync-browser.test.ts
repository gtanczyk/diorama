import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('the audio source closes lips during loading, mute, suspension, interruption and completion', async () => {
  const script = (await build({ entryPoints: ['app/web/audio.ts'], bundle: true, format: 'iife', globalName: 'AudioGame', write: false })).outputFiles[0].text;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route('http://lipsync.test/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('http://lipsync.test');
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => {
      const w = window as any;
      let event: (name: string, detail: object) => void = () => {};
      const speech = { who: 'conductor' };
      const game = { data: { sound: { files: {}, places: {}, shots: {}, bySpeaker: { conductor: { Polish: {
        file: 'recording', seconds: 2, lipsync: { cues: [{ start: 0, end: 2, value: 'D' }] },
      } } } } }, speech, on: (listener: typeof event) => { event = listener; } };
      const mixer = new w.AudioGame.Mixer(game, (file: string) => file);
      await mixer.ctx.resume();
      let release!: () => void;
      const loading = new Promise<void>(resolve => { release = resolve; });
      window.fetch = async () => { await loading; return new Response(new ArrayBuffer(1)); };
      mixer.ctx.decodeAudioData = async () => mixer.ctx.createBuffer(1, 88200, 44100);
      event('say', { text: 'Polish', who: 'conductor' });
      const pending = mixer.mouth(speech).mouth;
      release();
      await new Promise(r => setTimeout(r, 80));
      const playing = mixer.mouth(speech).mouth;
      const otherSpeech = mixer.mouth({ who: 'conductor' }).mouth;
      mixer.muted = true;
      const muted = mixer.mouth(speech).mouth;
      mixer.muted = false;
      await mixer.ctx.suspend();
      const suspended = mixer.mouth(speech).mouth;
      await mixer.ctx.resume();
      const resumed = mixer.mouth(speech).mouth;
      event('silent', {});
      const interrupted = mixer.mouth(speech).mouth;
      event('say', { text: 'Polish', who: 'conductor' });
      await new Promise(r => setTimeout(r, 2100));
      const ended = mixer.mouth(speech).mouth;
      await mixer.ctx.close();
      return { pending, playing, otherSpeech, muted, suspended, resumed, interrupted, ended };
    });
    expect(result).toEqual({ pending: 'X', playing: 'D', otherSpeech: 'X', muted: 'X', suspended: 'X', resumed: 'D', interrupted: 'X', ended: 'X' });
  } finally { await browser.close(); }
}, 15_000);
