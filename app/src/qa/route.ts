import type { Page } from 'playwright';
import type { Action } from '../story/engine.ts';

type Step = { use: string; verb?: string; with?: string } | { act: Action } | { wait: number };

/** Follow a route through the same pointer targets, inventory and answers as a person. */
export async function playRoute(page: Page, steps: Step[]): Promise<{ ending: string | null; frames: number; time: number }> {
  // Track async dialogue actions triggered by DOM buttons, without invoking them ourselves.
  await page.evaluate(`(() => {
    const game = window.diorama;
    if (game.pointerRouteInstalled) return;
    game.pointerRouteInstalled = true;
    game.pointerRoutePending = 0;
    const act = game.act.bind(game);
    game.act = async (...args) => {
      game.pointerRoutePending++;
      try { return await act(...args); }
      finally { game.pointerRoutePending--; }
    };
  })()`);
  const settled = () => page.waitForFunction('window.diorama.place && !window.diorama.busy && !window.diorama.pointerRoutePending && !window.diorama.speech && window.diorama.dark === 0', undefined, { timeout: 60_000 });
  for (const step of steps) {
    if ('wait' in step) {
      await page.evaluate(`window.diorama.wait(${JSON.stringify(step.wait)})`);
      continue;
    }
    await settled();
    if ('act' in step) {
      if (step.act.kind !== 'choose' && step.act.kind !== 'leave') throw new Error(`No pointer control for ${step.act.kind}`);
      const action = step.act.kind === 'choose' ? `choose:${step.act.index}` : 'leave';
      await page.locator(`#talk button[data-action=${JSON.stringify(action)}]`).click();
    } else {
      if (step.with) await page.locator(`#inventory button[data-item=${JSON.stringify(step.with)}]`).click();
      const point = await page.evaluate<{ x: number; y: number } | null>(`(() => {
        const step = ${JSON.stringify(step)};
        const game = window.diorama;
        const hot = game.place.hots.find(h => h.thing.key === step.use);
        if (!hot) throw new Error(game.place.key + ' has no thing ' + step.use);
        const action = game.actionFor(step.use, hot, step.verb === 'look' ? 'look' : undefined);
        if (step.verb && (action.kind !== 'do' || action.verb !== step.verb || action.with !== step.with))
          throw new Error('No pointer action ' + step.verb + ' for ' + step.use);
        const canvas = document.querySelector('canvas');
        const rect = canvas.getBoundingClientRect();
        const box = game.pageRect(step.use) ?? rect;
        const hits = (x, y) => {
          const at = game.unzoom((x - rect.left) / rect.width * canvas.width, (y - rect.top) / rect.height * canvas.height);
          return game.thingAt(...at)?.thing.key === step.use && document.elementFromPoint(x, y) === canvas;
        };
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        if (hits(cx, cy)) return { x: cx, y: cy };
        // Aim inside the largest exposed patch, not at its first edge pixel. An animated NPC can
        // move between measuring and the actual pointer event, especially beside the inventory.
        const left = Math.max(0, rect.left, box.left), top = Math.max(0, rect.top, box.top);
        const right = Math.min(innerWidth, rect.right, box.right), bottom = Math.min(innerHeight, rect.bottom, box.bottom);
        const stride = 4, cols = Math.ceil((right - left) / stride);
        let previous = new Uint32Array(Math.max(0, cols) + 1), best = 0, aim = null;
        for (let y = top + 0.5; y < bottom; y += stride) {
          const row = new Uint32Array(previous.length);
          for (let c = 1, x = left + 0.5; x < right; c++, x += stride) {
            if (!hits(x, y)) continue;
            row[c] = 1 + Math.min(row[c - 1], previous[c], previous[c - 1]);
            if (row[c] > best) {
              best = row[c];
              aim = { x: x - (best - 1) * stride / 2, y: y - (best - 1) * stride / 2 };
            }
          }
          previous = row;
        }
        if (aim && hits(aim.x, aim.y)) return aim;
        // Preserve pixel-sized targets that the coarse search might step over.
        for (let y = Math.max(0, rect.top, box.top) + 0.5; y < Math.min(innerHeight, rect.bottom, box.bottom); y++) {
          for (let x = Math.max(0, rect.left, box.left) + 0.5; x < Math.min(innerWidth, rect.right, box.right); x++) {
            if (hits(x, y)) return { x, y };
          }
        }
        return null;
      })()`);
      if (!point) throw new Error(`No clickable pixel for ${step.use}: its pointer target is hidden or covered`);
      await page.mouse.click(point.x, point.y, { button: step.verb === 'look' ? 'right' : 'left' });
    }
    await settled();
  }
  return page.evaluate('({ ending: window.diorama.state.ending ?? null, frames: window.diorama.frame, time: window.diorama.time })');
}
