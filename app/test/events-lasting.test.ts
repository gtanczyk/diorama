import { expect, test } from 'vitest';
import { Events } from '../src/studio/events.ts';

test('a page opened late in a long build still gets its finished steps', () => {
  const events = new Events(5);
  events.publish('job.start', { world: 'w' });
  events.publish('step.start', { world: 'w', step: 'story' });
  events.publish('step.end', { world: 'w', step: 'story' });
  events.publish('call', { world: 'w', model: 'sam', hit: false });
  for (let i = 0; i < 20; i++) events.publish('log', { world: 'w', line: `line ${i}` });
  const seen = events.since(0, 'w');
  expect(seen.slice(0, 4).map((e) => e.type)).toEqual(['job.start', 'step.start', 'step.end', 'call']);
  expect(seen.filter((e) => e.type === 'log')).toHaveLength(5);
  expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((a, b) => a - b));
});

