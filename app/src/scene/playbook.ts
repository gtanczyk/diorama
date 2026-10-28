// What to do about each error a place can end a build with: the fixes to try, cheapest first, and the
// step the place is rebuilt from after them. The build report and the agent's repair brief both read it,
// so a failed gate says how to get past it instead of only that it failed.
import type { Finding } from './verify.ts';

export type Play = {
  /** Where to look first. */
  look: string;
  /** Fix tools in the order to try them: each is a Studio action and keeps its fix in corrections.json. */
  tools: string[];
  /** Only when the tools did not help: it costs a model call or changes the place a lot. */
  last?: string;
};

const FLOOR_GAP: Play = {
  look: 'place_view: the red patches are floor the hero cannot reach; each yellow dashed gap names the cells to bridge and the things standing in it. '
    + 'A red patch that is no floor at all (a wall, the sky, water) is taken back, not bridged: when corrections_get shows a brush stroke or added cells there, '
    + 'corrections_clear that floor (or mask_brush erase over it); floor_cells remove does not undo a brush stroke, strokes are painted after the cells',
  tools: [
    'floor_cells: add the cells that bridge the gap (stairs, a gangway, a jetty edge)',
    'mask_fix kind: a thing drawn over the join that people walk on becomes walk-on',
    'mask_fix phrase: name the floor better for SAM ("wooden jetty planks")',
  ],
  last: 'repaint_region: paint steps or a plank across the gap (one Muse edit); when water or a drop parts the floors, or a standing thing is laid across the only way, the layout needs a floor that joins them or the thing moved (relayout and repaint: ask first)',
};

/** The camera stands too close: the hero would be taller than the frame at the front. */
const CLOSE_UP: Play = {
  look: 'place_status: the blue rulers on walk.png show how tall the hero is at the front; a DERIVE flag "too near the camera" counts the front cells shut for it',
  tools: [
    'run_step derive: shuts the front cells where the hero would be too tall; often enough on its own',
    'floor_cells remove: floor cells at the very bottom edge that stretch the scale',
  ],
  last: 'relayout and repaint the place with the camera farther back (layout now refuses a close camera; ask first)',
};

export const PLAYBOOK: Record<string, Play> = {
  FLOOR_UNREACHABLE: FLOOR_GAP,
  UNREACHABLE: FLOOR_GAP,
  NO_FLOOR: {
    look: 'place_status: the floors list says how each floor mask was found; walk.png shows what is walkable',
    tools: ['mask_fix phrase: a better name for the floor', 'floor_cells: add the cells people walk on'],
    last: 'repaint_region: make the floor read as floor (one Muse edit)',
  },
  START_BLOCKED: {
    look: 'place_view: the start (green dot) sits off the green floor',
    tools: ['floor_cells: open the cells under the start', 'mask_brush: erase the thing mask that covers the start'],
  },
  SPOT_UNREACHABLE: {
    look: 'place_view: the spot is a red dot, with a dashed line to the nearest reachable point',
    tools: ['stand_set: a spot on reachable floor next to the thing', 'mask_fix box: the box where the thing really is'],
  },
  MASK_MISSING: {
    look: 'place_status: the thing has no mask; masks/overlay.png shows what SAM found',
    tools: ['mask_fix phrase: a name SAM can find', 'mask_fix box: the box where it is', 'mask_brush: paint its mask'],
    last: 'repaint_region: make the thing visible (one Muse edit)',
  },
  MASK_WRONG: {
    look: 'place_view layer masks: the thing\'s mask against the box it should be in; the error gives the box where Spark sees the thing',
    tools: ['mask_fix box: the box from the error (or the one you see)', 'mask_fix phrase: a name SAM tells apart from its neighbour'],
    last: 'repaint_region: when the thing is not painted at all (one Muse edit)',
  },
  THING_NOT_PAINTED: {
    look: 'place_view layer painting: the thing\'s box shows something else, and Spark found the thing nowhere in the painting',
    tools: ['mask_fix box: when you do see it painted somewhere else'],
    last: 'repaint_region: paint the thing in at its box with its looks (one Muse edit), then rebuild the place from masks',
  },
  THING_MISSING: {
    look: 'world_status: the place lost the thing between layout and derive',
    tools: ['run_step masks, then derive, for the world'],
  },
  HORIZON_LOW: {
    look: 'place_status: walk.png draws the horizon as a dashed blue line and the hero as blue rulers',
    tools: ['mask_fix phrase: the floor mask may reach into the sky', 'floor_cells remove: cells high up that are not floor'],
  },
  SCALE_NEAR: CLOSE_UP,
  SCALE_FALLBACK: {
    look: 'place_status: the DERIVE flags say why Spark gave no scale ("the asks failed": a hiccup; "N usable points": its answers did not fit); walk.png\'s blue rulers show how tall the hero is where',
    tools: ['run_step derive with the place: Spark judges a person\'s height again (3 Spark calls), the walk floor and fixes stay'],
  },
  SCALE_FAR: {
    look: 'place_status: the blue rulers on walk.png show how tall the hero is at the back',
    tools: ['floor_cells remove: far floor cells near the horizon that no one should walk to'],
  },
  STEP_FAILED: {
    look: 'job_wait or job_list: the last lines of the failed job say why the step broke',
    tools: [
      'job_retry: when it was a network or model hiccup (it starts at the step where the place broke)',
      'paint_words: when paint was refused by the image safety filter (content_policy_violation) even after Spark reworded it: calm, plain words for the scene and the looks it names',
      'the fix tool for what the error names, then rebuild the place',
    ],
  },
};

const NEAR_CAMERA = /too near the camera/;

/**
 * A finding with what to do about it, when the playbook knows. flags: the place's verify flags; a floor cut off
 * right after derive shut the front rows for a close camera is a close-up, not a gap to bridge.
 */
export function withPlay(f: Finding, flags: Finding[] = []): Finding & { play?: Play } {
  const closeUp = (f.code === 'UNREACHABLE' || f.code === 'FLOOR_UNREACHABLE') && flags.some((x) => x.code === 'DERIVE' && NEAR_CAMERA.test(x.detail));
  const play = closeUp ? CLOSE_UP : PLAYBOOK[f.code];
  return play ? { ...f, play } : f;
}
