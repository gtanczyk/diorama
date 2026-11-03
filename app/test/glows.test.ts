import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { emptyMask } from '../src/image/mask.ts';
import { glowKind } from '../src/play/glow.ts';
import { brightSpots, placeGlows } from '../src/scene/glows.ts';

/** A dark night painting with a warm lamp high on a tower and a pale moonlit patch. */
async function night(): Promise<Buffer> {
  const svg = `<svg width="1200" height="896" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="896" fill="#14202c"/>
    <rect x="1040" y="60" width="40" height="300" fill="#2a2a30"/>
    <circle cx="1060" cy="80" r="11" fill="#ffe2a0"/>
    <rect x="300" y="300" width="60" height="30" fill="#d0dcdc"/>
    <rect x="600" y="500" width="22" height="30" fill="#ffd060"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('painted glows', () => {
  it('moves a planned light onto the lamp painted above it, not onto moonlit paint', async () => {
    const { spots, height } = await brightSpots(await night());
    const g = placeGlows([{ key: 'lighthouse-beam', x: 1060, y: 250, colour: '#ffe8a0' }, { key: 'window', x: 330, y: 380, colour: '#ffd95a' }], spots, [], height);
    const beam = g.find((l) => l.key === 'lighthouse-beam')!;
    expect(Math.hypot(beam.x - 1060, beam.y - 80)).toBeLessThan(6);
    // Only the pale patch near the window's point: no warm light was painted there, and the point is on nothing.
    expect(g.find((l) => l.key === 'window')).toBeUndefined();
  });

  it('keeps an unlit lamp on the thing it was planned on, and drops a light planned on bare floor', async () => {
    const { spots, height } = await brightSpots(await night());
    const tower = emptyMask(1200, 896);
    for (let y = 0; y < 400; y++) tower.bits.fill(1, y * 1200 + 100, y * 1200 + 200);
    const g = placeGlows([{ key: 'beam-source', x: 150, y: 90, colour: '#dfeaf2' }, { key: 'lamp', x: 150, y: 800, colour: '#ffb347' }], spots, [tower], height);
    expect(g).toEqual([{ key: 'beam-source', x: 150, y: 90 }]);
  });

  it('gives each painted light to one planned light', async () => {
    const { spots, height } = await brightSpots(await night());
    const g = placeGlows([{ key: 'cart-lamp', x: 620, y: 560, colour: '#ffb347' }, { key: 'cart-lamp-2', x: 600, y: 470, colour: '#ffb347' }], spots, [], height);
    expect(g).toHaveLength(1);
    expect(Math.hypot(g[0].x - 611, g[0].y - 515)).toBeLessThan(6);
  });

  it('puts a lighthouse lamp on its white-hot lamp room, not on the golden rays or the foam round it', async () => {
    const rays = Array.from({ length: 16 }, (_, i) => {
      const a = (i * Math.PI) / 8;
      return `<line x1="${1000 + 40 * Math.cos(a)}" y1="${120 + 40 * Math.sin(a)}" x2="${1000 + 260 * Math.cos(a)}" y2="${120 + 260 * Math.sin(a)}" stroke="#e8c464" stroke-width="7"/>`;
    }).join('');
    const svg = `<svg width="1200" height="896" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="896" fill="#1c2a44"/>
      <rect x="985" y="140" width="30" height="230" fill="#6a5238"/>
      ${rays}
      <rect x="992" y="110" width="16" height="22" fill="#fff4b0"/>
      <path d="M860 380 q60 -40 120 0 t120 0 t100 0 v20 h-340 z" fill="#e6e0d0"/>
    </svg>`;
    const { spots, height } = await brightSpots(await sharp(Buffer.from(svg)).png().toBuffer());
    const g = placeGlows([{ key: 'lighthouse-beam', x: 1020, y: 55, colour: '#ffe27a' }], spots, [], height);
    expect(Math.hypot(g[0].x - 1000, g[0].y - 121)).toBeLessThan(8);
  });
});

describe('glow kinds', () => {
  it('reads the most telling word of a light', () => {
    expect(glowKind('lighthouse-beam')).toBe('beam');
    expect(glowKind('lighthouse-lamp')).toBe('beam');
    expect(glowKind('lighthouse-windows')).toBe('window');
    expect(glowKind('lamp-far')).toBe('lamp');
    expect(glowKind('boat-lantern')).toBe('flame');
    expect(glowKind('distant-town')).toBe('twinkle');
  });
});
