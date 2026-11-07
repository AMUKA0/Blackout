import type { Fault } from "./types.ts";

// The demo's fault script. Ticks are seconds once the mission starts.
// The phone is the only fault done by hand on stage; its ticks here are the
// target moments, and the live run follows the real toggle.
export const DEMO_FAULTS: Fault[] = [
  { tick: 12, kind: "cut", a: "S1", b: "S2" },
  { tick: 12, kind: "cut", a: "R1", b: "R2" },
  { tick: 28, kind: "radioOff", device: "B" },
  { tick: 42, kind: "radioOff", device: "phone" },
  { tick: 62, kind: "radioOn", device: "phone" },
  { tick: 72, kind: "radioOn", device: "B" },
  { tick: 72, kind: "restore", a: "S1", b: "S2" },
  { tick: 72, kind: "restore", a: "R1", b: "R2" },
];
