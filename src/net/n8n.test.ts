import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

// The outbox must hold messages while n8n is unreachable and replay them in
// order, with how long each was held, once it is back.

function fakeN8n(port: number, received: { seq: number; heldMs: number; kind: string }[]): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const j = JSON.parse(body);
      received.push({ seq: j.seq, heldMs: j.heldMs, kind: j.kind });
      res.writeHead(200).end("{}");
    });
    s.listen(port, () => resolve(s));
  });
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

test("outbox queues during an outage and replays in order", async () => {
  const port = 5799;
  process.env.N8N_URL = `http://localhost:${port}`;
  const { N8nLink } = await import("./n8n.ts");
  const link = new N8nLink();
  const received: { seq: number; heldMs: number; kind: string }[] = [];

  // n8n is down: nothing listening yet.
  link.push("status", { device: "B", online: false });
  link.push("events", { events: [] });
  await until(() => link.state === "down");
  assert.equal(link.queued, 2);

  // Simulated outage on top: still holds.
  link.setBlocked(true);
  link.push("report", { rescued: 9 });
  const server = await fakeN8n(port, received);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(received.length, 0, "blocked link sends nothing");

  link.setBlocked(false);
  await until(() => received.length === 3);
  assert.deepEqual(received.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(received.map((r) => r.kind), ["status", "events", "report"]);
  assert.ok(received[0].heldMs >= 1500, "held time is reported");
  assert.equal(link.queued, 0);
  assert.equal(link.state, "ok");
  link.stop();
  server.closeAllConnections();
  server.close();
});
