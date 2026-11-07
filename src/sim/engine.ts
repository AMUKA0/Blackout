import { CONFIG } from "../shared/config.ts";
import { decide, initialState, type ActorState, type Mode } from "../shared/brain.ts";
import { cheb, euclid, samePos } from "../shared/geo.ts";
import { emptyKnowledge, merge, type Knowledge } from "../shared/knowledge.ts";
import { generateWorld } from "../shared/world.ts";
import type { ActorId, Condition, DeviceId, Fault, Pos, World } from "../shared/types.ts";

// Deterministic, headless run of one mission. The live demo replays the same
// fault timeline, so what judges see is one run of this function.

export type SimEvent =
  | { tick: number; type: "found"; actor: ActorId; survivor: number; isolated: boolean }
  | { tick: number; type: "rescued"; actor: ActorId; survivor: number; isolated: boolean }
  | { tick: number; type: "expired"; survivor: number }
  | { tick: number; type: "conflict"; actor: ActorId; winner: ActorId; survivor: number }
  | { tick: number; type: "wasted"; actor: ActorId; survivor: number }
  | { tick: number; type: "fault"; fault: Fault };

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
  converged: boolean; // all actors share identical knowledge at the end (mesh)
};

type Truth = { status: "hidden" | "waiting" | "inProgress" | "rescued" | "expired"; by?: ActorId; done?: number };

const HQ = "HQ";

function linksFor(world: World, actors: ActorState[], cut: Set<string>, off: Set<DeviceId>, withHq: boolean) {
  const links: [string, string][] = [];
  const pairKey = (a: string, b: string) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i];
      const b = actors[j];
      const sameDevice = a.spec.device === b.spec.device;
      if (sameDevice) {
        links.push([a.spec.id, b.spec.id]); // local hub on the device
        continue;
      }
      if (off.has(a.spec.device) || off.has(b.spec.device)) continue;
      if (cut.has(pairKey(a.spec.id, b.spec.id))) continue;
      if (euclid(a.pos, b.pos) <= CONFIG.radioRange) links.push([a.spec.id, b.spec.id]);
    }
  }
  if (withHq) {
    for (const a of actors) {
      if (a.spec.device !== "A" && off.has(a.spec.device)) continue;
      if (cut.has(pairKey(HQ, a.spec.id))) continue;
      if (a.spec.device === "A" || euclid(a.pos, world.base) <= CONFIG.hqRange) links.push([HQ, a.spec.id]);
    }
  }
  return links;
}

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

export function runSim(opts: { seed: number; condition: Condition; faults: Fault[]; record?: boolean }): RunResult {
  const world = generateWorld(opts.seed);
  const { condition } = opts;
  let actors = world.actors.map((spec) => initialState(spec, emptyKnowledge()));
  let hqK: Knowledge = emptyKnowledge();
  const truth = new Map<number, Truth>(world.survivors.map((s) => [s.id, { status: "hidden" }]));
  const events: SimEvent[] = [];
  const frames: Frame[] = [];
  const cut = new Set<string>();
  const off = new Set<DeviceId>();
  const stats = Object.fromEntries(
    world.actors.map((a) => [a.id, { isolatedTicks: 0, offlineTicks: 0, found: 0, rescued: 0, foundOffline: 0, rescuedOffline: 0 }]),
  ) as Record<ActorId, ActorStats>;
  let wasted = 0;
  let conflicts = 0;

  for (let tick = 0; tick < CONFIG.missionTicks; tick++) {
    // 1. Scripted faults
    for (const f of opts.faults.filter((x) => x.tick === tick)) {
      if ("device" in f) {
        if (f.kind === "radioOff") off.add(f.device);
        else off.delete(f.device);
      } else {
        const key = f.a < f.b ? `${f.a}-${f.b}` : `${f.b}-${f.a}`;
        if (f.kind === "cut") cut.add(key);
        else cut.delete(key);
      }
      events.push({ tick, type: "fault", fault: f });
    }

    // 2. World: survivors appear
    for (const s of world.survivors) {
      const t = truth.get(s.id)!;
      if (t.status === "hidden" && s.spawn <= tick) t.status = "waiting";
    }

    // 3. Radio links and who can reach whom
    const links = linksFor(world, actors, cut, off, condition === "central");
    const mainGroup = component(links, "S1"); // Laptop A is "home"
    const neighbours = (id: string) => links.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));

    // 4. Sense the truth around each actor
    actors = actors.map((s) => {
      let k = s.k;
      const offline = !mainGroup.has(s.spec.id);
      const radius = s.spec.role === "scout" ? CONFIG.scoutSense : CONFIG.rescuerSense;
      for (const sv of world.survivors) {
        if (cheb(sv.pos, s.pos) > radius) continue;
        const t = truth.get(sv.id)!;
        if (t.status === "waiting" && !k.found[sv.id]) {
          k = { ...k, found: { ...k.found, [sv.id]: { pos: sv.pos, deadline: sv.deadline, tick, by: s.spec.id } } };
          stats[s.spec.id].found++;
          if (offline) stats[s.spec.id].foundOffline++;
          events.push({ tick, type: "found", actor: s.spec.id, survivor: sv.id, isolated: offline });
        }
        if ((t.status === "rescued" || t.status === "inProgress") && !k.rescued[sv.id]) {
          k = { ...k, rescued: { ...k.rescued, [sv.id]: { tick: t.done ?? tick, by: t.by! } } };
        }
      }
      k = { ...k, seen: { ...k.seen, [s.spec.id]: { pos: s.pos, tick } } };
      return { ...s, k };
    });

    // 5. Share knowledge
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

    // 6. Decide and act
    const next: ActorState[] = [];
    for (const s0 of actors) {
      const id = s0.spec.id;
      const isolated = neighbours(id).length === 0;
      const offline = !mainGroup.has(id);
      let s: ActorState = { ...s0, isolatedFor: isolated ? s0.isolatedFor + 1 : 0 };
      if (isolated) stats[id].isolatedTicks++;
      if (offline) stats[id].offlineTicks++;

      // Finish an extraction in progress
      if (s.rescuingUntil !== undefined && tick >= s.rescuingUntil) {
        const sid = s.target!;
        const sv = world.survivors.find((x) => x.id === sid)!;
        const t = truth.get(sid)!;
        if (tick <= sv.deadline) {
          t.status = "rescued";
          t.done = tick;
          stats[id].rescued++;
          if (offline) stats[id].rescuedOffline++;
          events.push({ tick, type: "rescued", actor: id, survivor: sid, isolated: offline });
        } else {
          t.status = "expired";
          events.push({ tick, type: "expired", survivor: sid });
        }
        s = { ...s, rescuingUntil: undefined, target: undefined, k: { ...s.k, rescued: { ...s.k.rescued, [sid]: { tick, by: id } } } };
      }

      if (frozen.has(id) && s.rescuingUntil === undefined) {
        next.push({ ...s, mode: "frozen" });
        continue;
      }

      // Central HQ hands out jobs one actor at a time, so it never double-books.
      if (condition === "central") s = { ...s, k: merge(hqK, s.k) };
      const d = decide(world, s, tick);
      if (condition === "central") hqK = merge(hqK, d.next.k);
      if (d.conflictWith) {
        conflicts++;
        events.push({ tick, type: "conflict", actor: id, winner: d.conflictWith.winner, survivor: d.conflictWith.survivor });
      }
      let n = d.next;

      // Arrived at a survivor
      if (n.spec.role === "rescuer" && n.target !== undefined && n.rescuingUntil === undefined) {
        const sv = world.survivors.find((x) => x.id === n.target)!;
        if (samePos(n.pos, sv.pos)) {
          const t = truth.get(sv.id)!;
          if (t.status === "waiting") {
            t.status = "inProgress";
            t.by = id;
            t.done = tick + CONFIG.rescueTicks;
            n = { ...n, rescuingUntil: tick + CONFIG.rescueTicks, mode: "rescuing" };
          } else {
            wasted++;
            events.push({ tick, type: "wasted", actor: id, survivor: sv.id });
            n = { ...n, target: undefined, k: { ...n.k, rescued: { ...n.k.rescued, [sv.id]: { tick: t.done ?? tick, by: t.by ?? id } } } };
          }
        }
      }
      next.push(n);
    }
    actors = next;
    if (condition === "central") for (const s of actors) if (!frozen.has(s.spec.id)) hqK = merge(hqK, s.k);

    // 7. Survivors run out of time
    for (const sv of world.survivors) {
      const t = truth.get(sv.id)!;
      if (t.status === "waiting" && tick > sv.deadline) {
        t.status = "expired";
        events.push({ tick, type: "expired", survivor: sv.id });
      }
    }

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
    wasted,
    conflicts,
    events,
    stats,
    frames: opts.record ? frames : undefined,
    converged: fps.size === 1,
  };
}
