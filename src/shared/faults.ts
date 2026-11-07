import type { Fault } from "./types.ts";

// Live demo: only two radio links are cut on a script. Laptop B going dark is
// its real Wi-Fi being switched off, and Scout 4 is the phone's airplane mode.
export const LINK_CUTS: Fault[] = [
  { tick: 12, kind: "cut", a: "S1", b: "S2" },
  { tick: 12, kind: "cut", a: "R1", b: "R2" },
  { tick: 72, kind: "restore", a: "S1", b: "S2" },
  { tick: 72, kind: "restore", a: "R1", b: "R2" },
];

// Headless simulator only: the same cuts plus the blackouts we perform by hand
// on stage, at their target times, so the 50-map comparison is like for like.
export const SIM_FAULTS: Fault[] = [
  ...LINK_CUTS,
  { tick: 28, kind: "radioOff", device: "B" },
  { tick: 42, kind: "radioOff", device: "phone" },
  { tick: 62, kind: "radioOn", device: "phone" },
  { tick: 72, kind: "radioOn", device: "B" },
].sort((a, b) => a.tick - b.tick) as Fault[];
