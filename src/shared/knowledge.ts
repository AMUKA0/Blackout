import type { ActorId, Pos } from "./types.ts";

// Each actor's picture of the world. Built so that merge() is commutative,
// associative and idempotent: any two actors that exchange state, in any
// order, any number of times, end up with the same answer.
//
// - found / rescued: grow-only maps. Once known, never forgotten.
// - claims: one entry per (survivor, writer). Only the writer updates its own
//   entry, so "newest tick wins" never has two writers fighting over a key.
// - seen: last known position of each actor, newest tick wins.

export type Found = { pos: Pos; deadline: number; tick: number; by: ActorId };
export type Rescued = { tick: number; by: ActorId };
export type Claim = { eta: number; tick: number; released: boolean };
export type Seen = { pos: Pos; tick: number };

export type Knowledge = {
  found: Record<number, Found>;
  rescued: Record<number, Rescued>;
  claims: Record<number, Partial<Record<ActorId, Claim>>>;
  seen: Partial<Record<ActorId, Seen>>;
};

export const emptyKnowledge = (): Knowledge => ({ found: {}, rescued: {}, claims: {}, seen: {} });

function firstOf<T extends { tick: number; by: string }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.tick !== b.tick) return a.tick < b.tick ? a : b;
  return a.by <= b.by ? a : b;
}

function newerClaim(a: Claim | undefined, b: Claim | undefined): Claim | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.tick !== b.tick) return a.tick > b.tick ? a : b;
  if (a.released !== b.released) return a.released ? a : b; // release beats claim on a tie
  return a.eta <= b.eta ? a : b;
}

function newerSeen(a: Seen | undefined, b: Seen | undefined): Seen | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.tick !== b.tick) return a.tick > b.tick ? a : b;
  return a.pos.y * 1000 + a.pos.x <= b.pos.y * 1000 + b.pos.x ? a : b;
}

const keys = (...objs: object[]) => [...new Set(objs.flatMap((o) => Object.keys(o)))];

export function merge(a: Knowledge, b: Knowledge): Knowledge {
  const out = emptyKnowledge();
  for (const k of keys(a.found, b.found)) out.found[+k] = firstOf(a.found[+k], b.found[+k])!;
  for (const k of keys(a.rescued, b.rescued)) {
    out.rescued[+k] = firstOf(
      a.rescued[+k] && { ...a.rescued[+k] },
      b.rescued[+k] && { ...b.rescued[+k] },
    )!;
  }
  for (const k of keys(a.claims, b.claims)) {
    const ca = a.claims[+k] ?? {};
    const cb = b.claims[+k] ?? {};
    const merged: Partial<Record<ActorId, Claim>> = {};
    for (const who of keys(ca, cb) as ActorId[]) merged[who] = newerClaim(ca[who], cb[who])!;
    out.claims[+k] = merged;
  }
  for (const who of keys(a.seen, b.seen) as ActorId[]) out.seen[who] = newerSeen(a.seen[who], b.seen[who])!;
  return out;
}

// Who owns a survivor: the active claim with the earliest arrival, then lowest id.
// Every actor computes the same winner from the same knowledge.
export function claimWinner(k: Knowledge, survivor: number): ActorId | undefined {
  let best: { who: ActorId; eta: number } | undefined;
  for (const [who, c] of Object.entries(k.claims[survivor] ?? {}) as [ActorId, Claim][]) {
    if (c.released) continue;
    if (!best || c.eta < best.eta || (c.eta === best.eta && who < best.who)) best = { who, eta: c.eta };
  }
  return best?.who;
}

export function withClaim(k: Knowledge, survivor: number, who: ActorId, claim: Claim): Knowledge {
  return { ...k, claims: { ...k.claims, [survivor]: { ...k.claims[survivor], [who]: claim } } };
}

// Stable string for equality checks in tests and convergence checks.
export function fingerprint(k: Knowledge): string {
  const sortObj = (o: Record<string, unknown>): unknown =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((key) => {
          const v = o[key];
          return [key, v && typeof v === "object" && !Array.isArray(v) ? sortObj(v as Record<string, unknown>) : v];
        }),
    );
  return JSON.stringify(sortObj(k as unknown as Record<string, unknown>));
}
