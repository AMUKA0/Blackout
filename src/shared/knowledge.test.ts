import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32, randInt, type Rng } from "./rng.ts";
import { claimWinner, emptyKnowledge, fingerprint, merge, withClaim, type Knowledge } from "./knowledge.ts";
import type { ActorId } from "./types.ts";

const IDS: ActorId[] = ["S1", "S2", "S3", "S4", "R1", "R2"];

function randomKnowledge(rng: Rng): Knowledge {
  let k = emptyKnowledge();
  for (let i = 0; i < randInt(rng, 0, 6); i++) {
    const id = randInt(rng, 1, 8);
    const by = IDS[randInt(rng, 0, 5)];
    k.found[id] = { pos: { x: id, y: id }, deadline: 50 + id, tick: randInt(rng, 0, 20), by };
  }
  for (let i = 0; i < randInt(rng, 0, 3); i++) {
    k.rescued[randInt(rng, 1, 8)] = { tick: randInt(rng, 0, 20), by: IDS[randInt(rng, 4, 5)] };
  }
  for (let i = 0; i < randInt(rng, 0, 5); i++) {
    k = withClaim(k, randInt(rng, 1, 8), IDS[randInt(rng, 4, 5)], {
      eta: randInt(rng, 5, 30),
      tick: randInt(rng, 0, 20),
      released: rng() < 0.3,
    });
  }
  for (const who of IDS) if (rng() < 0.5) k.seen[who] = { pos: { x: randInt(rng, 0, 15), y: randInt(rng, 0, 15) }, tick: randInt(rng, 0, 20) };
  return k;
}

test("merge is commutative, associative and idempotent", () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 500; i++) {
    const a = randomKnowledge(rng);
    const b = randomKnowledge(rng);
    const c = randomKnowledge(rng);
    assert.equal(fingerprint(merge(a, b)), fingerprint(merge(b, a)), "commutative");
    assert.equal(fingerprint(merge(merge(a, b), c)), fingerprint(merge(a, merge(b, c))), "associative");
    assert.equal(fingerprint(merge(a, a)), fingerprint(merge(a, emptyKnowledge())), "idempotent");
  }
});

test("claim winner: earliest arrival, then lowest id, released claims ignored", () => {
  let k = emptyKnowledge();
  k = withClaim(k, 1, "R2", { eta: 10, tick: 3, released: false });
  k = withClaim(k, 1, "R1", { eta: 12, tick: 3, released: false });
  assert.equal(claimWinner(k, 1), "R2");
  k = withClaim(k, 1, "R1", { eta: 10, tick: 4, released: false });
  assert.equal(claimWinner(k, 1), "R1", "tie goes to lower id");
  k = withClaim(k, 1, "R1", { eta: 10, tick: 5, released: true });
  assert.equal(claimWinner(k, 1), "R2", "released claim drops out");
});

test("both sides of a partition agree on the winner after merging", () => {
  let left = emptyKnowledge();
  let right = emptyKnowledge();
  left = withClaim(left, 7, "R1", { eta: 40, tick: 30, released: false });
  right = withClaim(right, 7, "R2", { eta: 35, tick: 31, released: false });
  assert.equal(claimWinner(merge(left, right), 7), "R2");
  assert.equal(claimWinner(merge(right, left), 7), "R2");
});
