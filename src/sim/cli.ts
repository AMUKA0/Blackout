import { mkdirSync, writeFileSync } from "node:fs";
import { DEMO_FAULTS } from "../shared/faults.ts";
import type { Condition } from "../shared/types.ts";
import { runSim } from "./engine.ts";

// Usage: npm run sim -- <seed> [mesh|central|independent]
const seed = Number(process.argv[2] ?? 1);
const condition = (process.argv[3] ?? "mesh") as Condition;
const r = runSim({ seed, condition, faults: DEMO_FAULTS, record: true });

console.log(`seed ${seed}, ${condition}: rescued ${r.rescued}/${r.total}, expired ${r.expired}, wasted ${r.wasted}, conflicts ${r.conflicts}, converged ${r.converged}`);
for (const e of r.events) {
  if (e.type === "fault") console.log(`t${e.tick}  FAULT ${JSON.stringify(e.fault)}`);
  else if (e.type === "expired") console.log(`t${e.tick}  survivor ${e.survivor} lost`);
  else if (e.type === "conflict") console.log(`t${e.tick}  ${e.actor} yields survivor ${e.survivor} to ${e.winner}`);
  else console.log(`t${e.tick}  ${e.actor} ${e.type} survivor ${e.survivor}${"isolated" in e && e.isolated ? " (while cut off)" : ""}`);
}
console.table(r.stats);

mkdirSync("out", { recursive: true });
writeFileSync(`out/run-${seed}-${condition}.json`, JSON.stringify(r));
console.log(`wrote out/run-${seed}-${condition}.json (${r.frames!.length} frames)`);
