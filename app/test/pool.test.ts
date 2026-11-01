import { describe, expect, it } from 'vitest';
import { inLane, mapLimit } from '../src/world/pool.ts';
import { inStep, currentStep } from '../src/meta/step.ts';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cast pool', () => {
  it('runs at most the limit at once, keeps order and per-item errors', async () => {
    let open = 0, most = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      most = Math.max(most, ++open);
      await tick(5);
      open--;
      if (n === 4) throw new Error('four');
      return n * 10;
    });
    expect(most).toBe(3);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 30, 'x', 50, 60, 70]);
  });

  it('a lane holds work to its limit across callers', async () => {
    let open = 0, most = 0;
    await Promise.all(Array.from({ length: 6 }, () => inLane('test-space', 2, async () => {
      most = Math.max(most, ++open);
      await tick(5);
      open--;
    })));
    expect(most).toBe(2);
  });

  it('model calls know the step they were asked in, also side by side', async () => {
    const seen: Array<string | undefined> = [];
    await Promise.all([
      inStep('paint', async () => { await tick(3); seen.push(currentStep()); }),
      inStep('model', async () => { await tick(1); seen.push(currentStep()); }),
    ]);
    expect(seen.sort()).toEqual(['model', 'paint']);
    expect(currentStep()).toBeUndefined();
  });
});

describe('memo', () => {
  it('the same question asked twice at once is paid once', async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const { Memo } = await import('../src/meta/memo.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-'));
    const memo = new Memo(dir);
    let paid = 0;
    const ask = async () => { paid++; await tick(10); return Buffer.from('door creak'); };
    const [a, b] = await Promise.all([memo.remember('spark', 'exit:a', 'h1', 'txt', ask), memo.remember('spark', 'exit:b', 'h1', 'txt', ask)]);
    expect(paid).toBe(1);
    expect(a.toString()).toBe(b.toString());
    expect(memo.sent.spark).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
