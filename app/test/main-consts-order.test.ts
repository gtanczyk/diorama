import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

test('the shadow constants are set before the game starts drawing frames', () => {
  const src = fs.readFileSync(path.join(__dirname, '../web/main.ts'), 'utf8');
  const start = src.indexOf('await game.start()');
  for (const name of ['SIL_ROWS', 'SHADOW_CELLS']) {
    const at = src.indexOf(`const ${name} =`);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(start);
  }
});
