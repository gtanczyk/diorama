import { expect, test } from 'vitest';
import { jobWords } from '../studio/job-words.ts';

test('job labels read as plain words with names, not slugs or step ids', () => {
  expect(jobWords('fix princess-castle from paint')).toBe('repairing Princess castle, starting again at painting');
  expect(jobWords('build world > verify')).toBe('building the world');
  expect(jobWords('masks · tram-stop')).toBe('cutting out things in Tram stop');
  expect(jobWords('animate boat-man')).toBe('moving Boat man into 3D');
  expect(jobWords('fog canal-walk: up x2')).toBe('the fog in Canal walk');
  expect(jobWords('publish to GitHub Pages')).toBe('publish to GitHub Pages');
});
