import { CONFIG } from "../shared/config.ts";
import { initialState, type ActorState, type Mode } from "../shared/brain.ts";
import { euclid } from "../shared/geo.ts";
import { emptyKnowledge, merge, type Knowledge } from "../shared/knowledge.ts";
import {
  actActor, expireSurvivors, newTruth, pairKey, radioLinks, revealSurvivors, senseActor, toRadio, type StepEvent,
} from "../shared/step.ts";
import { generateWorld } from "../shared/world.ts";
import type { ActorId, Condition, DeviceId, Fault, Pos } from "../shared/types.ts";

// Deterministic, headless run of one mission. The live demo replays the same
// fault timeline, so what judges see is one run of this logic.

export type SimEvent = StepEvent | { tick: number; type: "fault"; fault: Fault };

export type Frame = {
  tick: number;
  actors: { id: ActorId; pos: Pos; mode: Mode; target?: number; isolated: boolean; offline: boolean }[];
  links: [string, string][];
};

export type ActorStats = { isolatedTicks: number; offlineTicks: number; found: number; rescued: number; foundOffline: number; rescuedOffline: number };

export type RunResult = {
  seed: number;
  condition: Condition;
  total: number;
  rescued: number;
  expired: number;
  wasted: number;
  conflicts: number;
  events: SimEvent[];
  stats: Record<ActorId, ActorStats>;
  frames?: Frame[];
  converged: boolean; // all actors share identical knowledge at the end
};

const HQ = "HQ";

function component(links: [string, string][], from: string): Set<string> {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    for (const [a, b] of links) {
      const o = a === n ? b : b === n ? a : undefined;
      if (o && !seen.has(o)) {
        seen.add(o);
        stack.push(o);
      }
    }
  }
  return seen;
}

export function applyFault(f: Fault, cut: Set<string>, off: Set<DeviceId>) {
  if ("device" in f) {
    if (f.kind === "radioOff") off.add(f.device);
    else off.delete(f.device);
  } else if (f.kind === "cut") cut.add(pairKey(f.a, f.b));
  else cut.delete(pairKey(f.a, f.b));
}

export function runSim(opts: { seed: number; condition: Condition; faults: Fault[]; record?: boolean }): RunResult {
  const world = generateWorld(opts.seed);
  const { condition } = opts;
  let actors: ActorState[] = world.actors.map((spec) => initialState(spec, emptyKnowledge()));
  let hqK: Knowledge = emptyKnowledge();
  const truth = newTruth(world);
  const events: SimEvent[] = [];
  const frames: Frame[] = [];
  const cut = new Set<string>();
  const off = new Set<DeviceId>();
  const stats = Object.fromEntries(
    world.actors.map((a) => [a.id, { isolatedTicks: 0, offlineTicks: 0, found: 0, rescued: 0, foundOffline: 0, rescuedOffline: 0 }]),
  ) as Record<ActorId, ActorStats>;

  const record = (evs: StepEvent[]) => {
    for (const e of evs) {
      events.push(e);
      if (e.type === "found") {
        stats[e.actor].found++;
        if (e.isolated) stats[e.actor].foundOffline++;
      } else if (e.type === "rescued") {
        stats[e.actor].rescued++;
        if (e.isolated) stats[e.actor].rescuedOffline++;
      }
    }
  };

  for (let tick = 0; tick < CONFIG.missionTicks; tick++) {
    for (const f of opts.faults.filter((x) => x.tick === tick)) {
      applyFault(f, cut, off);
      events.push({ tick, type: "fault", fault: f });
    }
    revealSurvivors(world, truth, tick);

    const links: [string, string][] = radioLinks(actors.map((s) => toRadio(s.spec, s.pos)), cut, off);
    if (condition === "central") {
      for (const a of actors) {
        if (a.spec.device !== "A" && off.has(a.spec.device)) continue;
        if (cut.has(pairKey(HQ, a.spec.id))) continue;
        if (a.spec.device === "A" || euclid(a.pos, world.base) <= CONFIG.hqRange) links.push([HQ, a.spec.id]);
      }
    }
    const mainGroup = component(links, "S1");
    const neighbours = (id: string) => links.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));

    actors = actors.map((s) => {
      const r = senseActor(world, truth, s, tick, !mainGroup.has(s.spec.id));
      record(r.events);
      return r.s;
    });

    const frozen = new Set<ActorId>();
    if (condition === "mesh") {
      const snapshot = new Map(actors.map((s) => [s.spec.id as string, s.k]));
      actors = actors.map((s) => {
        let k = s.k;
        for (const n of neighbours(s.spec.id)) k = merge(k, snapshot.get(n)!);
        return { ...s, k };
      });
    } else if (condition === "central") {
      const reach = component(links, HQ);
      for (const s of actors) if (reach.has(s.spec.id)) hqK = merge(hqK, s.k);
      actors = actors.map((s) => (reach.has(s.spec.id) ? { ...s, k: hqK } : s));
      for (const s of actors) if (!reach.has(s.spec.id)) frozen.add(s.spec.id);
    }

    actors = actors.map((s) => {
      const id = s.spec.id;
      const isolated = neighbours(id).length === 0;
      const offline = !mainGroup.has(id);
      if (isolated) stats[id].isolatedTicks++;
      if (offline) stats[id].offlineTicks++;
      const central = condition === "central" && !frozen.has(id);
      const r = actActor(world, truth, s, tick, {
        isolated,
        offline,
        frozen: frozen.has(id),
        // Central HQ hands out jobs one actor at a time, so it never double-books.
        beforeDecide: central ? (x) => ({ ...x, k: merge(hqK, x.k) }) : undefined,
        afterDecide: central ? (x) => (hqK = merge(hqK, x.k)) : undefined,
      });
      record(r.events);
      return r.s;
    });
    if (condition === "central") for (const s of actors) if (!frozen.has(s.spec.id)) hqK = merge(hqK, s.k);

    record(expireSurvivors(world, truth, tick));

    if (opts.record) {
      frames.push({
        tick,
        links,
        actors: actors.map((s) => ({
          id: s.spec.id,
          pos: s.pos,
          mode: s.mode,
          target: s.target,
          isolated: neighbours(s.spec.id).length === 0,
          offline: !mainGroup.has(s.spec.id),
        })),
      });
    }
  }

  const statuses = [...truth.values()].map((t) => t.status);
  const fps = new Set(actors.map((a) => JSON.stringify([Object.keys(a.k.found).sort(), Object.keys(a.k.rescued).sort()])));
  return {
    seed: opts.seed,
    condition,
    total: world.survivors.length,
    rescued: statuses.filter((s) => s === "rescued").length,
    expired: statuses.filter((s) => s === "expired" || s === "waiting").length,
    wasted: events.filter((e) => e.type === "wasted").length,
    conflicts: events.filter((e) => e.type === "conflict").length,
    events,
    stats,
    frames: opts.record ? frames : undefined,
    converged: fps.size === 1,
  };
}
