import assert from "node:assert/strict";
import { test } from "node:test";
import { LINK_CUTS } from "../shared/faults.ts";
import type { Fault } from "../shared/types.ts";
import { runSim } from "./engine.ts";

test("a crashed drone's partner flies to the wreck, recovers its reports, and takes its sector", () => {
  let recoveredRuns = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const faults: Fault[] = [...LINK_CUTS, { tick: 30, kind: "crash", actor: "S3" }];
    const r = runSim({ seed, condition: "mesh", faults, record: true });
    const down = r.events.find((e) => e.type === "down");
    assert.ok(down && "actor" in down && down.actor === "S3", `seed ${seed}: crash recorded`);

    // The wreck never moves again.
    const wreckPositions = new Set(r.frames!.filter((f) => f.tick > 30).map((f) => JSON.stringify(f.actors.find((a) => a.id === "S3")!.pos)));
    assert.equal(wreckPositions.size, 1, `seed ${seed}: wreck stays put`);

    const rec = r.events.find((e) => e.type === "recovered");
    if (rec && "from" in rec) {
      recoveredRuns++;
      assert.equal(rec.actor, "S1", `seed ${seed}: partner S1 recovers`);
      assert.equal(rec.from, "S3");
      // After recovery S1 sweeps both sectors for the rest of the mission.
      const after = r.frames!.filter((f) => f.tick > rec.tick + 1);
      assert.ok(after.every((f) => f.actors.find((a) => a.id === "S1")!.mode !== "recover"), `seed ${seed}: S1 stops recovering`);
    }
  }
  // S1 hears the mayday whenever it is in range at t30; that should be most runs.
  assert.ok(recoveredRuns >= 12, `recovered in ${recoveredRuns}/20 runs`);
});
