import type { Pos } from "./types.ts";

export const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const euclid = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y);
export const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;

// One flying step (8 directions, no obstacles).
export function stepToward(from: Pos, to: Pos): Pos {
  return { x: from.x + Math.sign(to.x - from.x), y: from.y + Math.sign(to.y - from.y) };
}

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

// BFS distance map over land, 8 directions. -1 = unreachable.
export function distanceMap(size: number, water: boolean[], target: Pos): Int16Array {
  const dist = new Int16Array(size * size).fill(-1);
  const start = target.y * size + target.x;
  if (water[start]) return dist;
  dist[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % size;
    const y = (i - x) / size;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (water[j] || dist[j] !== -1) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

// Next land step that lowers the distance to the target, or null if stuck.
export function nextStep(size: number, dist: Int16Array, from: Pos): Pos | null {
  const here = dist[from.y * size + from.x];
  if (here <= 0) return null;
  let best: Pos | null = null;
  let bestD = here;
  for (const [dx, dy] of DIRS) {
    const nx = from.x + dx;
    const ny = from.y + dy;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    const d = dist[ny * size + nx];
    if (d >= 0 && d < bestD) {
      bestD = d;
      best = { x: nx, y: ny };
    }
  }
  return best;
}
