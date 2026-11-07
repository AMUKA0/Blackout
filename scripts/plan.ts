// Asks Argon for standing orders for a seed and caches them before the demo.
//   node scripts/plan.ts 3
import { mkdirSync, writeFileSync } from "node:fs";
import { writePlan, ARGON } from "../src/net/gemini.ts";
import { generateWorld } from "../src/shared/world.ts";

const seed = Number(process.argv[2] ?? 3);
const world = generateWorld(seed);
const water = world.water.filter(Boolean).length;
const summary = `Map ${world.size}x${world.size}, base at (${world.base.x},${world.base.y}), ${water} water tiles. ${world.survivors.length} survivors appear between tick 0 and ${Math.max(...world.survivors.map((s) => s.spawn))}.`;

const t0 = Date.now();
console.log(`asking ${ARGON} for seed ${seed}...`);
const plan = await writePlan(seed, summary);
mkdirSync("plans", { recursive: true });
writeFileSync(`plans/plan-${seed}.json`, JSON.stringify(plan, null, 2));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> plans/plan-${seed}.json`);
console.log(`commander: ${plan.commander}`);
for (const [id, text] of Object.entries(plan.intents)) console.log(`  ${id}: ${text}`);
