import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';

test('extension progress stays with its job for clients that open after the event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-progress-'));
  const bin = path.join(dir, 'progress.mjs');
  fs.writeFileSync(bin, `console.log('@@diorama ' + JSON.stringify({type:'extension.progress',phase:'places',place:'hill',index:2,total:3,newPlaces:['hill']}));\nconsole.log('@@diorama ' + JSON.stringify({type:'extension.progress',phase:'audio'}));\n`);
  const events = new Events();
  const jobs = new Jobs(events, { cwd: dir, bin });
  try {
    const job = jobs.start('w', ['extend', 'w'], 'extend', 'agent');
    const done = await jobs.wait(job.id);
    expect(done.extension).toEqual({ phase: 'audio', newPlaces: ['hill'] });
    expect(jobs.list('w')[0].extension).toEqual(done.extension);
    expect(events.since(0, 'w').find(e => e.type === 'extension.progress')).toMatchObject({ job: job.id, phase: 'places', place: 'hill' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
