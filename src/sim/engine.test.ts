import assert from "node:assert/strict";
import { test } from "node:test";
import { SIM_FAULTS } from "../shared/faults.ts";
import { runSim } from "./engine.ts";

test("same seed and faults give the same run", () => {
  const a = runSim({ seed: 3, condition: "mesh", faults: SIM_FAULTS });
  const b = runSim({ seed: 3, condition: "mesh", faults: SIM_FAULTS });
  assert.deepEqual(a.events, b.events);
  assert.equal(a.rescued, b.rescued);
});

test("mesh actors converge to the same knowledge after reconnect", () => {
  for (let seed = 1; seed <= 20; seed++) {
    assert.ok(runSim({ seed, condition: "mesh", faults: SIM_FAULTS }).converged, `seed ${seed}`);
  }
});

test("no survivor is rescued twice", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = runSim({ seed, condition: "mesh", faults: SIM_FAULTS });
    const ids = r.events.filter((e) => e.type === "rescued").map((e) => ("survivor" in e ? e.survivor : -1));
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}`);
  }
});

test("random fault storms never break convergence once links return", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const faults = [
      { tick: 5 + (seed % 7), kind: "radioOff" as const, device: "B" as const },
      { tick: 10 + (seed % 11), kind: "radioOff" as const, device: "phone" as const },
      { tick: 15 + (seed % 5), kind: "cut" as const, a: "S1" as const, b: "R2" as const },
      { tick: 60, kind: "radioOn" as const, device: "B" as const },
      { tick: 61, kind: "radioOn" as const, device: "phone" as const },
      { tick: 62, kind: "restore" as const, a: "S1" as const, b: "R2" as const },
    ];
    assert.ok(runSim({ seed, condition: "mesh", faults }).converged, `seed ${seed}`);
  }
});
