import { CONFIG } from "./config.ts";
import { distanceMap } from "./geo.ts";
import { mulberry32, randInt } from "./rng.ts";
import type { ActorSpec, Pos, Rect, Survivor, World } from "./types.ts";

const S = CONFIG.size;
const H = S / 2;

const QUADRANTS: Rect[] = [
  { x: 0, y: 0, w: H, h: H }, // NW
  { x: H, y: 0, w: H, h: H }, // NE
  { x: 0, y: H, w: H, h: H }, // SW
  { x: H, y: H, w: H, h: H }, // SE
];

// Device placement matches the demo: Laptop A keeps S1 + R1, Laptop B holds
// S2, S3, R2 (the group that gets cut off), the phone runs S4 alone.
const ROSTER: Omit<ActorSpec, "start">[] = [
  { id: "S1", role: "scout", device: "A", area: QUADRANTS[0] },
  { id: "S2", role: "scout", device: "B", area: QUADRANTS[1] },
  { id: "S3", role: "scout", device: "B", area: QUADRANTS[2] },
  { id: "S4", role: "scout", device: "phone", area: QUADRANTS[3] },
  { id: "R1", role: "rescuer", device: "A", area: { x: 0, y: 0, w: H, h: S } },
  { id: "R2", role: "rescuer", device: "B", area: { x: H, y: 0, w: H, h: S } },
];

export function generateWorld(seed: number): World {
  const rng = mulberry32(seed);
  const base: Pos = { x: H - 1, y: H - 1 };
  const water = new Array<boolean>(S * S).fill(false);

  for (let b = 0; b < CONFIG.waterBlobs; b++) {
    const cx = randInt(rng, 1, S - 2);
    const cy = randInt(rng, 1, S - 2);
    const r = randInt(rng, 1, 2);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        if (Math.hypot(x - cx, y - cy) > r + 0.3) continue;
        if (Math.abs(x - base.x) <= 1 && Math.abs(y - base.y) <= 1) continue;
        water[y * S + x] = true;
      }
    }
  }

  // Buildings: own random stream so the flood layout stays the same per seed.
  // Each block keeps a one-tile street around it and stays clear of base.
  const brng = mulberry32(seed ^ 0x5bd1e995);
  const buildings = new Array<boolean>(S * S).fill(false);
  for (let b = 0; b < CONFIG.buildings; b++) {
    const w = randInt(brng, 1, 2);
    const h = randInt(brng, 1, 2);
    const x0 = randInt(brng, 0, S - w);
    const y0 = randInt(brng, 0, S - h);
    let ok = true;
    for (let y = y0 - 1; y <= y0 + h && ok; y++) {
      for (let x = x0 - 1; x <= x0 + w && ok; x++) {
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        const inside = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
        if (buildings[y * S + x]) ok = false;
        if (inside && water[y * S + x]) ok = false;
        if (inside && Math.abs(x - base.x - 0.5) <= 2.5 && Math.abs(y - base.y - 0.5) <= 2.5) ok = false;
      }
    }
    if (!ok) continue;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) buildings[y * S + x] = true;
  }
  const solid = water.map((wet, i) => wet || buildings[i]);

  // Survivors only on open ground a rescuer can reach from base.
  const reach = distanceMap(S, solid, base);
  const land: Pos[] = [];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (reach[y * S + x] > 2) land.push({ x, y });
    }
  }

  const survivors: Survivor[] = [];
  const used = new Set<number>();
  while (survivors.length < CONFIG.survivors && used.size < land.length) {
    const idx = randInt(rng, 0, land.length - 1);
    if (used.has(idx)) continue;
    used.add(idx);
    const spawn = randInt(rng, 0, CONFIG.spawnMax);
    survivors.push({
      id: 0,
      pos: land[idx],
      spawn,
      deadline: spawn + randInt(rng, CONFIG.deadlineMin, CONFIG.deadlineMax),
    });
  }
  survivors.sort((a, b) => a.spawn - b.spawn || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
  survivors.forEach((s, i) => (s.id = i + 1));

  const offsets: Pos[] = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
  ];
  const actors = ROSTER.map((r, i) => ({
    ...r,
    start: { x: base.x + offsets[i].x, y: base.y + offsets[i].y },
  }));

  return { seed, size: S, water, buildings, solid, base, survivors, actors };
}

// Lawnmower loop through an area, row spacing set by sensing radius.
export function patrolRoute(area: Rect, sense: number): Pos[] {
  const rows: number[] = [];
  for (let y = area.y + sense; y < area.y + area.h; y += sense * 2 + 1) rows.push(y);
  const last = area.y + area.h - 1 - sense;
  if (rows.length === 0 || rows[rows.length - 1] < last) rows.push(Math.max(area.y, last));
  const route: Pos[] = [];
  rows.forEach((y, i) => {
    const left = { x: area.x, y };
    const right = { x: area.x + area.w - 1, y };
    route.push(...(i % 2 === 0 ? [left, right] : [right, left]));
  });
  return route;
}
