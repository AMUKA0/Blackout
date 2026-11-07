import type { Fault } from "./types.ts";

// Live demo: no scripted faults. Every failure on stage is real: Laptop B's
// Wi-Fi, the phone's airplane mode, a drone crash, or the hub taken offline.
export const LINK_CUTS: Fault[] = [];

// Headless simulator only: the blackouts we perform by hand on stage, at their
// target times, plus two link cuts, so the 50-map comparison is like for like
// with the numbers already published on the results chart.
export const SIM_FAULTS: Fault[] = [
  { tick: 12, kind: "cut", a: "S1", b: "S2" },
  { tick: 12, kind: "cut", a: "R1", b: "R2" },
  { tick: 28, kind: "radioOff", device: "B" },
  { tick: 42, kind: "radioOff", device: "phone" },
  { tick: 62, kind: "radioOn", device: "phone" },
  { tick: 72, kind: "radioOn", device: "B" },
  { tick: 72, kind: "restore", a: "S1", b: "S2" },
  { tick: 72, kind: "restore", a: "R1", b: "R2" },
];
