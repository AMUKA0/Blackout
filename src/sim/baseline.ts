import { mkdirSync, writeFileSync } from "node:fs";
import { DEMO_FAULTS } from "../shared/faults.ts";
import type { Condition } from "../shared/types.ts";
import { runSim, type RunResult } from "./engine.ts";

// Runs all three conditions over many seeds with the SAME fault timeline,
// then picks demo seeds where our design clearly matters and a claim
// conflict resolves right after the reconnect.

const SEEDS = Number(process.argv[2] ?? 50);
const conditions: Condition[] = ["central", "independent", "mesh"];
const reconnectTick = Math.max(...DEMO_FAULTS.filter((f) => f.kind === "radioOn").map((f) => f.tick));

const results: Record<Condition, RunResult[]> = { central: [], independent: [], mesh: [] };
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const c of conditions) results[c].push(runSim({ seed, condition: c, faults: DEMO_FAULTS }));
}

const pct = (r: RunResult) => (100 * r.rescued) / r.total;
const summary = conditions.map((c) => {
  const v = results[c].map(pct);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return {
    condition: c,
    meanPct: +mean.toFixed(1),
    sdPct: +sd.toFixed(1),
    minPct: +Math.min(...v).toFixed(1),
    maxPct: +Math.max(...v).toFixed(1),
    wastedAvg: +(results[c].reduce((a, r) => a + r.wasted, 0) / SEEDS).toFixed(2),
    conflictsAvg: +(results[c].reduce((a, r) => a + r.conflicts, 0) / SEEDS).toFixed(2),
  };
});
console.table(summary);

const meshConverged = results.mesh.filter((r) => r.converged).length;
console.log(`mesh runs where every actor ended with identical knowledge: ${meshConverged}/${SEEDS}`);

const demoSeeds = results.mesh
  .map((m, i) => {
    const ind = results.independent[i];
    const cen = results.central[i];
    const cueConflict = m.events.some((e) => e.type === "conflict" && e.tick >= reconnectTick && e.tick <= reconnectTick + 8);
    const offlineWork = Object.values(m.stats).reduce((a, s) => a + s.foundOffline + s.rescuedOffline, 0);
    return { seed: m.seed, mesh: m.rescued, independent: ind.rescued, central: cen.rescued, total: m.total, cueConflict, offlineWork };
  })
  .filter((d) => d.cueConflict && d.mesh > d.independent && d.mesh > d.central)
  .sort((a, b) => b.mesh - b.independent - (a.mesh - a.independent) || b.offlineWork - a.offlineWork)
  .slice(0, 8);
console.log("Demo seed candidates (conflict resolves within 8 ticks of reconnect):");
console.table(demoSeeds);

mkdirSync("out", { recursive: true });
writeFileSync("out/baseline.json", JSON.stringify({ seeds: SEEDS, summary, demoSeeds, perSeed: conditions.map((c) => ({ condition: c, rescued: results[c].map((r) => r.rescued) })) }, null, 2));
console.log("wrote out/baseline.json");
