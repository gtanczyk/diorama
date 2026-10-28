// Geometry checks shared by the build, saved-world loader and browser (no filesystem imports).
export const MIN_DEPTH = 0.08;

/** Reject degenerate meshes and paper-like bodies, including cards lying down or tilted. */
export function shapeProblem(p: ArrayLike<number>): string | null {
  if (p.length < 12 || p.length % 3) return 'invalid: too few vertices';
  const axes: number[][] = [[], [], []];
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) return 'invalid: non-finite vertex';
    axes[i % 3].push(p[i]);
  }
  const spans = axes.map((a) => {
    a.sort((x, y) => x - y);
    return a[Math.floor(a.length * 0.98)] - a[Math.floor(a.length * 0.02)];
  });
  if (spans.some((s) => s <= 0)) return 'flat: zero body extent';
  if (spans[2] / spans[1] < MIN_DEPTH) return `flat: ${(spans[2] / spans[1]).toFixed(2)} of its height deep`;

  // Principal axes expose a thin sheet even when all three world-axis extents look substantial.
  // Compare thickness to the middle axis, not the longest: a long animal can still have a round body.
  const n = p.length / 3, mean = axes.map((a) => a.reduce((sum, x) => sum + x, 0) / n);
  const scale = Math.max(...spans);
  const cov = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < p.length; i += 3) {
    const v = [0, 1, 2].map((a) => (p[i + a] - mean[a]) / scale);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += v[a] * v[b] / n;
  }
  // Jacobi diagonalisation of the symmetric 3x3 covariance matrix.
  for (let step = 0; step < 20; step++) {
    let a = 0, b = 1;
    for (const [x, y] of [[0, 2], [1, 2]]) if (Math.abs(cov[x][y]) > Math.abs(cov[a][b])) [a, b] = [x, y];
    if (Math.abs(cov[a][b]) < 1e-12) break;
    const angle = 0.5 * Math.atan2(2 * cov[a][b], cov[b][b] - cov[a][a]);
    const c = Math.cos(angle), s = Math.sin(angle), aa = cov[a][a], bb = cov[b][b], ab = cov[a][b];
    for (let k = 0; k < 3; k++) if (k !== a && k !== b) {
      const ka = cov[k][a], kb = cov[k][b];
      cov[k][a] = cov[a][k] = c * ka - s * kb;
      cov[k][b] = cov[b][k] = s * ka + c * kb;
    }
    cov[a][a] = c * c * aa - 2 * c * s * ab + s * s * bb;
    cov[b][b] = s * s * aa + 2 * c * s * ab + c * c * bb;
    cov[a][b] = cov[b][a] = 0;
  }
  const variance = [cov[0][0], cov[1][1], cov[2][2]].sort((a, b) => a - b);
  const thickness = Math.sqrt(Math.max(0, variance[0]) / variance[1]);
  if (!Number.isFinite(thickness) || thickness < MIN_DEPTH) return `flat: body thickness ratio ${thickness.toFixed(3)} (minimum ${MIN_DEPTH})`;
  return null;
}
