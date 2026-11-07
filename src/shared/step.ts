import { CONFIG } from "./config.ts";
import { decide, NAME, RECOVER_RANGE, type ActorState, type Candidate } from "./brain.ts";
import { cheb, euclid, samePos } from "./geo.ts";
import type { ActorId, ActorSpec, DeviceId, Pos, World } from "./types.ts";

// One actor's turn: sense the world, then decide and act. Shared by the
// headless simulator and the live devices so both behave identically.

export type Truth = { status: "hidden" | "waiting" | "inProgress" | "rescued" | "expired"; by?: ActorId; done?: number };
export type TruthMap = Map<number, Truth>;

export type StepEvent =
  | { tick: number; type: "found"; actor: ActorId; survivor: number; isolated: boolean }
  | { tick: number; type: "rescued"; actor: ActorId; survivor: number; isolated: boolean }
  | { tick: number; type: "expired"; survivor: number }
  | { tick: number; type: "conflict"; actor: ActorId; winner: ActorId; survivor: number }
  | { tick: number; type: "wasted"; actor: ActorId; survivor: number }
  | { tick: number; type: "down"; actor: ActorId; survivor: 0; pos: Pos }
  | { tick: number; type: "recovered"; actor: ActorId; survivor: 0; from: ActorId; reports: number };

// A drone goes down: it stops where it is and sends one last mayday. After
// this tick its radio only reaches someone who comes to the wreck.
export function crashActor(s: ActorState, tick: number): { s: ActorState; event: StepEvent } {
  const k = { ...s.k, down: { ...s.k.down, [s.spec.id]: { pos: s.pos, tick, by: s.spec.id } } };
  return {
    s: { ...s, k, crashedAt: tick, mode: "down", target: undefined, rescuingUntil: undefined },
    event: { tick, type: "down", actor: s.spec.id, survivor: 0, pos: s.pos },
  };
}

export const newTruth = (world: World): TruthMap => new Map(world.survivors.map((s) => [s.id, { status: "hidden" } as Truth]));

export function revealSurvivors(world: World, truth: TruthMap, tick: number) {
  for (const s of world.survivors) {
    const t = truth.get(s.id)!;
    if (t.status === "hidden" && s.spawn <= tick) t.status = "waiting";
  }
}

export function expireSurvivors(world: World, truth: TruthMap, tick: number): StepEvent[] {
  const out: StepEvent[] = [];
  for (const sv of world.survivors) {
    const t = truth.get(sv.id)!;
    if (t.status === "waiting" && tick > sv.deadline) {
      t.status = "expired";
      out.push({ tick, type: "expired", survivor: sv.id });
    }
  }
  return out;
}

export function senseActor(world: World, truth: TruthMap, s: ActorState, tick: number, offline: boolean) {
  const events: StepEvent[] = [];
  if (s.crashedAt !== undefined) return { s, events }; // a wreck sees nothing
  let k = s.k;
  const radius = s.spec.role === "scout" ? CONFIG.scoutSense : CONFIG.rescuerSense;
  for (const sv of world.survivors) {
    if (cheb(sv.pos, s.pos) > radius) continue;
    const t = truth.get(sv.id)!;
    if (t.status === "waiting" && !k.found[sv.id]) {
      k = { ...k, found: { ...k.found, [sv.id]: { pos: sv.pos, deadline: sv.deadline, tick, by: s.spec.id } } };
      events.push({ tick, type: "found", actor: s.spec.id, survivor: sv.id, isolated: offline });
    }
    if ((t.status === "rescued" || t.status === "inProgress") && !k.rescued[sv.id]) {
      k = { ...k, rescued: { ...k.rescued, [sv.id]: { tick: t.done ?? tick, by: t.by! } } };
    }
  }
  k = { ...k, seen: { ...k.seen, [s.spec.id]: { pos: s.pos, tick } } };
  return { s: { ...s, k }, events };
}

export type ActOptions = {
  isolated: boolean;
  offline: boolean;
  frozen?: boolean;
  beforeDecide?: (s: ActorState) => ActorState;
  afterDecide?: (s: ActorState) => void;
  pick?: (c: Candidate[]) => number | undefined;
};

export type ActResult = {
  s: ActorState;
  events: StepEvent[];
  completed?: { survivor: number; tick: number; by: ActorId };
  reason?: string;
};

export function actActor(world: World, truth: TruthMap, s0: ActorState, tick: number, o: ActOptions): ActResult {
  const id = s0.spec.id;
  const events: StepEvent[] = [];
  let completed: ActResult["completed"];
  let s: ActorState = { ...s0, isolatedFor: o.isolated ? s0.isolatedFor + 1 : 0 };

  // A wreck does nothing, except notice a visitor close enough to read it.
  if (s.crashedAt !== undefined) {
    if (!s.k.recovered[id]) {
      const visitor = (Object.entries(s.k.seen) as [ActorId, { pos: Pos; tick: number }][]).find(
        ([who, v]) => who !== id && who.startsWith("S") && v.tick >= tick - 1 && euclid(v.pos, s.pos) <= RECOVER_RANGE,
      );
      if (visitor) s = { ...s, k: { ...s.k, recovered: { ...s.k.recovered, [id]: { tick, by: visitor[0] } } } };
    }
    return { s: { ...s, mode: "down" }, events, reason: s.k.recovered[id] ? `Down. Reports recovered by ${NAME[s.k.recovered[id]!.by]}` : "Down. Waiting for a drone to recover my reports" };
  }

  // The recovering drone announces the hand-over once.
  for (const [wreck, rec] of Object.entries(s.k.recovered) as [ActorId, { tick: number; by: ActorId }][]) {
    if (rec.by !== id || s.recoveredFrom?.includes(wreck)) continue;
    const reports = Object.values(s.k.found).filter((f) => f.by === wreck).length;
    events.push({ tick, type: "recovered", actor: id, survivor: 0, from: wreck, reports });
    s = { ...s, recoveredFrom: [...(s.recoveredFrom ?? []), wreck] };
  }

  // Finish an extraction in progress
  if (s.rescuingUntil !== undefined && tick >= s.rescuingUntil) {
    const sid = s.target!;
    const sv = world.survivors.find((x) => x.id === sid)!;
    const t = truth.get(sid)!;
    if (tick <= sv.deadline) {
      t.status = "rescued";
      t.done = tick;
      t.by = id;
      completed = { survivor: sid, tick, by: id };
      events.push({ tick, type: "rescued", actor: id, survivor: sid, isolated: o.offline });
    } else {
      t.status = "expired";
      events.push({ tick, type: "expired", survivor: sid });
    }
    s = { ...s, rescuingUntil: undefined, target: undefined, k: { ...s.k, rescued: { ...s.k.rescued, [sid]: { tick, by: id } } } };
  }

  if (o.frozen && s.rescuingUntil === undefined) return { s: { ...s, mode: "frozen" }, events, completed, reason: "No orders from HQ, holding" };

  if (o.beforeDecide) s = o.beforeDecide(s);
  const d = decide(world, s, tick, o.pick);
  o.afterDecide?.(d.next);
  if (d.conflictWith) events.push({ tick, type: "conflict", actor: id, winner: d.conflictWith.winner, survivor: d.conflictWith.survivor });
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
        events.push({ tick, type: "wasted", actor: id, survivor: sv.id });
        n = { ...n, target: undefined, k: { ...n.k, rescued: { ...n.k.rescued, [sv.id]: { tick: t.done ?? tick, by: t.by ?? id } } } };
      }
    }
  }
  return { s: n, events, completed, reason: d.reason };
}

// Radio links between actors. Actors on the same device always share a link
// (the device's own local hub); other pairs need range, no scripted cut, and
// both devices' radios on.
export type RadioActor = { id: ActorId; device: DeviceId; pos: Pos; down?: boolean };

export const pairKey = (a: string, b: string) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export function radioLinks(actors: RadioActor[], cut: Set<string>, off: Set<DeviceId>): [ActorId, ActorId][] {
  const links: [ActorId, ActorId][] = [];
  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i];
      const b = actors[j];
      // A wreck can only be read by someone right next to it.
      if (a.down || b.down) {
        const reachable = a.device === b.device || (!off.has(a.device) && !off.has(b.device));
        if (reachable && euclid(a.pos, b.pos) <= RECOVER_RANGE) links.push([a.id, b.id]);
        continue;
      }
      if (a.device === b.device) {
        links.push([a.id, b.id]);
        continue;
      }
      if (off.has(a.device) || off.has(b.device)) continue;
      if (cut.has(pairKey(a.id, b.id))) continue;
      if (euclid(a.pos, b.pos) <= CONFIG.radioRange) links.push([a.id, b.id]);
    }
  }
  return links;
}

export const toRadio = (spec: ActorSpec, pos: Pos, down = false): RadioActor => ({ id: spec.id, device: spec.device, pos, down });
