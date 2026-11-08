import { expect, test, vi } from 'vitest';

// A place with a thing to carry off and a story change: its plate fails at once, its change plate a moment later.
vi.mock('node:fs', async (real) => {
  const fs = (await real()) as typeof import('node:fs');
  const fake = { ...fs, existsSync: () => true, readFileSync: () => Buffer.from(''), rmSync: () => {} };
  return { ...fake, default: fake };
});
vi.mock('../src/world/files.ts', () => ({
  WorldFiles: class {
    memo = { sent: { muse: 0, sam: 0 } };
    world = () => ({ places: [{ key: 'meadow' }] });
    path = (...p: string[]) => p.join('/');
    place = (...p: string[]) => p.join('/');
    write = () => {};
    readJson = (file: string) => file.endsWith('masks.json') ? { things: { bolt: { phrase: 'bolt' }, web: { phrase: 'web' } } } : {};
  },
}));
vi.mock('../src/story/schema.ts', () => ({ Story: { parse: () => ({ changes: [{ place: 'meadow', thing: 'web', when: ['happy'], looks: 'glowing web' }] }) } }));
vi.mock('../src/story/engine.ts', () => ({ removableThings: () => [{ place: 'meadow', thing: 'bolt' }] }));
vi.mock('../src/scene/layout.ts', () => ({ Layout: { parse: () => ({ floors: [] }) } }));
vi.mock('../src/scene/brief.ts', () => ({ Brief: { parse: () => ({ looks: {} }) } }));
vi.mock('../src/scene/carry.ts', () => ({ carryFrom: async () => undefined, paintingFor: () => Buffer.from(''), ran: () => {} }));
vi.mock('../src/image/mask.ts', () => ({ maskFromPng: async () => ({}), maskArea: () => 0, maskToPng: async () => Buffer.from('') }));
vi.mock('../src/image/raster.ts', () => ({ dilate: (m: unknown) => m, intersect: (m: unknown) => m }));
vi.mock('../src/scene/plates.ts', () => ({
  plateFor: async () => { throw new Error('plate: Muse timed out'); },
  changePlate: () => new Promise((_, reject) => setTimeout(() => reject(new Error('change: Muse timed out')), 20)),
  changeShape: async () => undefined,
}));

test('a failed plate fails the step without the change plate crashing the process', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { registry } = await import('../src/registry.ts');
    await import('../src/commands/plates.ts');
    await expect(registry.get('plates')!.run(['monsters'])).rejects.toThrow('plate: Muse timed out');
    await new Promise((r) => setTimeout(r, 60));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
