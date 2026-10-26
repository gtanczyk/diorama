import { expect, test } from 'vitest';
import { indexPage, pagesUrl } from '../src/commands/publish.ts';

test('pages link from https and ssh GitHub remotes', () => {
  expect(pagesUrl('https://github.com/gtanczyk/diorama')).toBe('https://gtanczyk.github.io/diorama/');
  expect(pagesUrl('https://github.com/gtanczyk/diorama.git')).toBe('https://gtanczyk.github.io/diorama/');
  expect(pagesUrl('git@github.com:gtanczyk/diorama.git\n')).toBe('https://gtanczyk.github.io/diorama/');
  expect(pagesUrl('git@github.com:gtanczyk/gtanczyk.github.io.git')).toBe('https://gtanczyk.github.io/');
  expect(pagesUrl('https://gitlab.com/a/b')).toBeNull();
});

test('index page links each world and escapes titles', () => {
  const html = indexPage([{ slug: 'foghorn', title: 'The <Foghorn>' }]);
  expect(html).toContain('href="./foghorn/"');
  expect(html).toContain('The &#60;Foghorn&#62;');
});
