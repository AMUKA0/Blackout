import { CONFIG } from "./config.ts";
import { cheb, distanceMap, nextStep, samePos, stepToward } from "./geo.ts";
import { claimWinner, withClaim, type Knowledge } from "./knowledge.ts";
import { patrolRoute } from "./world.ts";
import type { ActorId, ActorSpec, Pos, World } from "./types.ts";

// The rule brain. It runs on every device with no network and no model.
// Gemini later only picks among the candidates this file produces.

export type Mode = "patrol" | "cover" | "recover" | "rescue" | "rescuing" | "mule" | "frozen" | "down";

// Scouts are paired with the scout in the same half of the map (west: S1/S3,
// east: S2/S4). If a partner goes quiet, its sector has nobody reporting to
// the rescuers we can still reach, so we sweep it too.
const PARTNER: Partial<Record<ActorId, ActorId>> = { S1: "S3", S3: "S1", S2: "S4", S4: "S2" };

export type ActorState = {
  spec: ActorSpec;
  pos: Pos;
  k: Knowledge;
  target?: number; // survivor id a rescuer is heading to
  rescuingUntil?: number;
  routeIdx: number;
  isolatedFor: number; // consecutive ticks with no radio neighbour
  mode: Mode;
  crashedAt?: number; // a drone that went down: it stops, and only a visitor can read it
  recoveredFrom?: ActorId[]; // wrecks this drone has already announced recovering
};

export const isDown = (s: ActorState, tick: number) => s.crashedAt !== undefined && tick > s.crashedAt;
export const NAME: Record<ActorId, string> = { S1: "Scout 1", S2: "Scout 2", S3: "Scout 3", S4: "Scout 4", R1: "Rescue 1", R2: "Rescue 2" };
export const RECOVER_RANGE = 1.5; // tiles: close enough to read a wreck's reports

export type Candidate = { survivor: number; eta: number; slack: number };

export type Decision = {
  next: ActorState;
  conflictWith?: { survivor: number; winner: ActorId }; // lost a claim on merge
  candidates: Candidate[];
  reason: string;
};

const distCache = new Map<string, Int16Array>();
export function landDistance(world: World, to: Pos): Int16Array {
  const key = `${world.seed}:${to.x},${to.y}`;
  let d = distCache.get(key);
  if (!d) {
    d = distanceMap(world.size, world.solid, to); // around water and buildings
    distCache.set(key, d);
  }
  return d;
}

const routes = new Map<string, Pos[]>();
function routeFor(spec: ActorSpec): Pos[] {
  let r = routes.get(spec.id);
  if (!r) {
    r = patrolRoute(spec.area, spec.role === "scout" ? CONFIG.scoutSense : CONFIG.rescuerSense);
    routes.set(spec.id, r);
  }
  return r;
}

export function initialState(spec: ActorSpec, k: Knowledge): ActorState {
  return { spec, pos: spec.start, k, routeIdx: 0, isolatedFor: 0, mode: "patrol" };
}

function patrol(world: World, s: ActorState, speed: number, extra?: ActorSpec): ActorState {
  const route = extra ? [...routeFor(s.spec), ...routeFor(extra)] : routeFor(s.spec);
  let { pos } = s;
  let routeIdx = s.routeIdx % route.length;
  for (let i = 0; i < speed; i++) {
    if (samePos(pos, route[routeIdx])) routeIdx = (routeIdx + 1) % route.length;
    const goal = route[routeIdx];
    if (s.spec.role === "scout") pos = stepToward(pos, goal);
    else {
      const next = nextStep(world.size, landDistance(world, goal), pos);
      // Waypoint is on water or cut off: skip it rather than stand still.
      if (next) pos = next;
      else routeIdx = (routeIdx + 1) % route.length;
    }
  }
  return { ...s, pos, routeIdx, mode: extra ? "cover" : "patrol" };
}

// The partner whose sector this scout should also sweep, if it has gone quiet.
function silentPartner(world: World, s: ActorState, tick: number): ActorSpec | undefined {
  const id = PARTNER[s.spec.id];
  if (!id) return undefined;
  const spec = world.actors.find((a) => a.id === id);
  if (s.k.down[id]) return spec; // crashed: its sector is ours for good
  if (tick < CONFIG.coverAfter) return undefined;
  const seen = s.k.seen[id];
  if (seen && tick - seen.tick < CONFIG.coverAfter) return undefined;
  return spec;
}

// A wreck this drone should fly to: its partner's, or, if that wreck's own
// partner is unavailable (crashed, never seen, or silent), the nearest
// working drone goes. Each drone works this out alone from what it knows.
const SCOUTS: ActorId[] = ["S1", "S2", "S3", "S4"];

function available(s: ActorState, id: ActorId, tick: number): boolean {
  if (id === s.spec.id) return true;
  if (s.k.down[id]) return false;
  const seen = s.k.seen[id];
  return !!seen && tick - seen.tick < CONFIG.coverAfter;
}

function wreckToRecover(s: ActorState, tick: number): { id: ActorId; pos: Pos } | undefined {
  for (const [id, down] of Object.entries(s.k.down) as [ActorId, { pos: Pos }][]) {
    if (id === s.spec.id || !down || s.k.recovered[id]) continue;
    if (PARTNER[s.spec.id] === id) return { id, pos: down.pos };
    const partner = PARTNER[id];
    if (partner && available(s, partner, tick)) continue; // its partner will go
    // Fallback: the closest working drone I know of goes (ties: lower id).
    const dist = (who: ActorId) => cheb(who === s.spec.id ? s.pos : s.k.seen[who]!.pos, down.pos);
    const candidates = SCOUTS.filter((x) => x !== id && available(s, x, tick));
    const best = candidates.sort((a, b) => dist(a) - dist(b) || (a < b ? -1 : 1))[0];
    if (best === s.spec.id) return { id, pos: down.pos };
  }
  return undefined;
}

// A wreck whose reports this drone recovered: that sector is now ours.
function inheritedSector(world: World, s: ActorState): ActorSpec | undefined {
  const entry = (Object.entries(s.k.recovered) as [ActorId, { by: ActorId }][]).find(([, r]) => r?.by === s.spec.id);
  return entry ? world.actors.find((a) => a.id === entry[0]) : undefined;
}

// Rescue jobs this rescuer could still finish in time, most urgent first.
export function rescueCandidates(world: World, s: ActorState, tick: number): Candidate[] {
  const out: Candidate[] = [];
  for (const [key, f] of Object.entries(s.k.found)) {
    const id = +key;
    if (s.k.rescued[id]) continue;
    const owner = claimWinner(s.k, id);
    if (owner && owner !== s.spec.id) continue;
    const d = landDistance(world, f.pos)[s.pos.y * world.size + s.pos.x];
    if (d < 0) continue;
    const eta = tick + Math.ceil(d / CONFIG.rescuerSpeed);
    const slack = f.deadline - (eta + CONFIG.rescueTicks);
    if (slack < 0) continue;
    out.push({ survivor: id, eta, slack });
  }
  out.sort((a, b) => a.slack - b.slack || a.eta - b.eta || a.survivor - b.survivor);
  return out;
}

export function decide(
  world: World,
  s: ActorState,
  tick: number,
  pick?: (c: Candidate[]) => number | undefined, // optional override (Gemini)
): Decision {
  if (s.spec.role === "scout") return decideScout(world, s, tick);
  return decideRescuer(world, s, tick, pick);
}

function decideScout(world: World, s: ActorState, tick: number): Decision {
  // Alone for a while and holding news nobody has acted on: carry it to the
  // nearest rescuer we last saw. This is the store-and-forward behaviour.
  if (s.isolatedFor >= CONFIG.muleAfter) {
    const news = Object.entries(s.k.found).some(
      ([id, f]) => f.by === s.spec.id && !s.k.rescued[+id] && !claimWinner(s.k, +id) && f.deadline > tick,
    );
    const rescuers = (["R1", "R2"] as const)
      .map((r) => s.k.seen[r])
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => cheb(a.pos, s.pos) - cheb(b.pos, s.pos));
    if (news && rescuers.length > 0) {
      let pos = s.pos;
      for (let i = 0; i < CONFIG.scoutSpeed; i++) pos = stepToward(pos, rescuers[0].pos);
      return { next: { ...s, pos, mode: "mule" }, candidates: [], reason: "Carrying news to the nearest rescuer" };
    }
  }
  // Partner crashed: fly to its wreck first and pick up its reports.
  const wreck = wreckToRecover(s, tick);
  if (wreck) {
    let pos = s.pos;
    for (let i = 0; i < CONFIG.scoutSpeed && cheb(pos, wreck.pos) > 1; i++) pos = stepToward(pos, wreck.pos);
    const at = `${String.fromCharCode(65 + wreck.pos.x)}${wreck.pos.y + 1}`;
    return { next: { ...s, pos, mode: "recover" }, candidates: [], reason: `Flying to ${NAME[wreck.id]}'s wreck at ${at} to recover its reports` };
  }
  const partner = inheritedSector(world, s) ?? silentPartner(world, s, tick);
  if (partner) {
    const crashed = !!s.k.down[partner.id];
    return {
      next: patrol(world, s, CONFIG.scoutSpeed, partner),
      candidates: [],
      reason: crashed ? `Covering ${NAME[partner.id]}'s sector since it crashed` : `Covering ${NAME[partner.id]}'s sector while it is out of contact`,
    };
  }
  return { next: patrol(world, s, CONFIG.scoutSpeed), candidates: [], reason: "Sweeping my sector" };
}

function decideRescuer(
  world: World,
  s: ActorState,
  tick: number,
  pick?: (c: Candidate[]) => number | undefined,
): Decision {
  if (s.rescuingUntil !== undefined) {
    return { next: { ...s, mode: "rescuing" }, candidates: [], reason: "Extracting survivor" };
  }

  let state = s;
  let conflictWith: Decision["conflictWith"];

  // Did a merge just tell us someone else owns our target?
  if (state.target !== undefined) {
    const owner = claimWinner(state.k, state.target);
    const done = !!state.k.rescued[state.target];
    if (owner && owner !== state.spec.id && !done) conflictWith = { survivor: state.target, winner: owner };
    if ((owner && owner !== state.spec.id) || done) state = { ...state, target: undefined };
  }

  const candidates = rescueCandidates(world, state, tick);
  const current = candidates.find((c) => c.survivor === state.target);
  // An override (Gemini) may only choose among the top feasible options.
  const override = candidates.length > 0 ? pick?.(candidates.slice(0, 3)) : undefined;
  const chosen = candidates.find((c) => c.survivor === override) ?? current ?? candidates[0];

  // Release an old claim we are walking away from.
  let k = state.k;
  if (s.target !== undefined && s.target !== chosen?.survivor && !k.rescued[s.target]) {
    const mine = k.claims[s.target]?.[s.spec.id];
    if (mine && !mine.released) k = withClaim(k, s.target, s.spec.id, { ...mine, tick, released: true });
  }

  if (!chosen) {
    const moved = patrol(world, { ...state, k, target: undefined }, CONFIG.rescuerSpeed);
    return { next: moved, conflictWith, candidates, reason: "No known survivors, searching my half" };
  }

  const prev = k.claims[chosen.survivor]?.[s.spec.id];
  if (!prev || prev.released || prev.eta !== chosen.eta) {
    k = withClaim(k, chosen.survivor, s.spec.id, { eta: chosen.eta, tick, released: false });
  }

  const goal = k.found[chosen.survivor].pos;
  let pos = state.pos;
  for (let i = 0; i < CONFIG.rescuerSpeed; i++) pos = nextStep(world.size, landDistance(world, goal), pos) ?? pos;
  return {
    next: { ...state, k, pos, target: chosen.survivor, mode: "rescue" },
    conflictWith,
    candidates,
    reason: `Heading to survivor ${chosen.survivor}, ${chosen.slack} ticks to spare`,
  };
}
