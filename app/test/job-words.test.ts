import { expect, test } from 'vitest';
import { doneWords, jobWords } from '../studio/job-words.ts';

test('job labels read as plain words with names, not slugs or step ids', () => {
  expect(jobWords('fix princess-castle from paint')).toBe('repairing Princess castle, starting again at painting');
  expect(jobWords('build world > verify')).toBe('building the world');
  expect(jobWords('masks · tram-stop')).toBe('cutting out things in Tram stop');
  expect(jobWords('animate boat-man')).toBe('moving Boat man into 3D');
  expect(jobWords('fog canal-walk: up x2')).toBe('the fog in Canal walk');
  expect(jobWords('publish to GitHub Pages')).toBe('publish to GitHub Pages');
});

test('a finished job reads in the past tense, not as what it was doing', () => {
  expect(doneWords('fix stoisko-z-przekaskami from paint')).toBe('Repaired Stoisko z przekaskami: rebuilt from painting');
  expect(doneWords('build world > verify')).toBe('Built the world');
  expect(doneWords('masks · tram-stop')).toBe('Finished: cutting out things in Tram stop');
});
