import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { decide as geminiDecide, geminiStatus, type DecideRequest, type Plan } from "./gemini.ts";
import { networkInterfaces } from "node:os";
import { extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { applyFault } from "../sim/engine.ts";
import { DEMO_FAULTS } from "../shared/faults.ts";
import { radioLinks, type StepEvent } from "../shared/step.ts";
import type { ActorId, DeviceId } from "../shared/types.ts";
import { DEAD_AFTER_MS, HEARTBEAT_MS, PORT, tickAt, type DeviceStatus, type FromHub, type Mission, type ObservedActor, type ToHub } from "./protocol.ts";

// Laptop A. Plays the part of the air between devices: an actor's broadcast
// only reaches actors in radio range on devices that are online. Also serves
// the phone page and the HQ dashboard. Press "s" to start, "q" to quit.

const SEED = Number(process.env.SEED ?? 3);
const DEVICES: DeviceId[] = ["A", "B", "phone"];
const lastSeen = new Map<DeviceId, { at: number; tick: number }>();
const sockets = new Map<DeviceId, WebSocket>();
const dashboards = new Set<WebSocket>();
const latest = new Map<ActorId, ObservedActor>();
const recentEvents: (StepEvent & { device: DeviceId; late: boolean; arrived: number })[] = [];
const truth: { survivor: number; tick: number; by: ActorId }[] = [];
let started: Mission | null = null;
let plan: Plan | null = null;

function loadPlan(seed: number) {
  const file = `plans/plan-${seed}.json`;
  plan = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Plan) : null;
  console.log(plan ? `loaded Argon standing orders from ${file}` : `no ${file}; run: node scripts/plan.ts ${seed}`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mp3": "audio/mpeg", ".json": "application/json" };
const ROUTES: Record<string, string> = { "/": "public/dashboard.html", "/phone": "public/phone.html" };

function startMission() {
  started = { t0: Date.now() + 3000, seed: SEED };
  latest.clear();
  truth.length = 0;
  recentEvents.length = 0;
  loadPlan(SEED);
  broadcastAll({ type: "start", ...started });
  console.log(`mission starts in 3s, seed ${SEED}`);
}

const http = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (req.method === "POST" && url === "/api/start") {
    startMission();
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && url === "/api/decide") {
    readJson(req)
      .then((body) => {
        const r = body as DecideRequest;
        return geminiDecide({ ...r, intent: plan?.intents[r.actor] });
      })
      .then((d) => {
        console.log(`gemini ${d.ms}ms -> survivor ${d.survivor}: ${d.reason}`);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(d));
      })
      .catch((e) => {
        console.log(`gemini failed: ${(e as Error).message}`);
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      });
    return;
  }
  const file = ROUTES[url] ?? (url.startsWith("/js/") || url.startsWith("/audio/") ? `public${url}` : null);
  if (!file || file.includes("..") || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server: http });
const send = (ws: WebSocket | undefined, m: FromHub) => ws && ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
const broadcastAll = (m: FromHub) => {
  sockets.forEach((s) => send(s, m));
  dashboards.forEach((s) => send(s, m));
};

const online = (d: DeviceId) => {
  const s = lastSeen.get(d);
  return !!s && Date.now() - s.at < DEAD_AFTER_MS && sockets.get(d)?.readyState === 1;
};

function currentLinks(tick: number) {
  const cut = new Set<string>();
  const off = new Set<DeviceId>();
  for (const f of DEMO_FAULTS) if (f.tick <= tick && !("device" in f)) applyFault(f, cut, off);
  for (const d of DEVICES) if (!online(d)) off.add(d);
  const actors = [...latest.values()].map((a) => ({ id: a.id, device: a.device, pos: a.pos }));
  return { links: radioLinks(actors, cut, off), off };
}

wss.on("connection", (ws) => {
  let me: DeviceId | "dashboard" | null = null;
  ws.on("close", () => {
    if (me === "dashboard") dashboards.delete(ws);
    else if (me && sockets.get(me) === ws) sockets.delete(me);
  });
  ws.on("message", (raw) => {
    let m: ToHub;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === "ping") send(ws, { type: "pong", t1: m.t1, server: Date.now() });
    else if (m.type === "hello") {
      me = m.device;
      if (m.device === "dashboard") dashboards.add(ws);
      else {
        sockets.set(m.device, ws);
        lastSeen.set(m.device, { at: Date.now(), tick: -1 });
      }
      if (!started && m.mission) {
        started = m.mission;
        console.log(`recovered running mission from ${m.device}, seed ${started.seed}`);
      }
      if (started) send(ws, { type: "start", ...started });
      for (const t of truth) send(ws, { type: "truth", ...t });
    } else if (m.type === "hb") lastSeen.set(m.device, { at: Date.now(), tick: m.tick });
    else if (m.type === "truth") {
      // First completed rescue wins. A later one for the same survivor came
      // from the other side of a partition: it was wasted effort.
      const prior = truth.find((t) => t.survivor === m.survivor);
      if (!prior || m.tick < prior.tick || (m.tick === prior.tick && m.by < prior.by)) {
        if (prior) truth.splice(truth.indexOf(prior), 1);
        truth.push({ survivor: m.survivor, tick: m.tick, by: m.by });
        for (const [, s] of sockets) if (s !== ws) send(s, m);
      }
    } else if (m.type === "beacon") {
      lastSeen.set(m.device, { at: Date.now(), tick: m.tick });
      for (const a of m.actors) latest.set(a.id, { ...a, device: m.device, tick: m.tick, online: true });
      for (const e of m.events) {
        let ev: StepEvent = e;
        if (e.type === "rescued") {
          // Whoever finished first rescued them, however late the report arrived.
          const i = recentEvents.findIndex((x) => x.type === "rescued" && x.survivor === e.survivor);
          if (i >= 0) {
            const first = recentEvents[i] as Extract<StepEvent, { type: "rescued" }> & { device: DeviceId; late: boolean; arrived: number };
            if (e.tick < first.tick || (e.tick === first.tick && e.actor < first.actor)) {
              recentEvents[i] = { tick: first.tick, type: "wasted", actor: first.actor, survivor: first.survivor, device: first.device, late: first.late, arrived: first.arrived };
            } else ev = { tick: e.tick, type: "wasted", actor: e.actor, survivor: e.survivor };
          }
        }
        recentEvents.push({ ...ev, device: m.device, late: m.tick - e.tick > 2, arrived: m.tick });
        if (recentEvents.length > 60) recentEvents.shift();
      }
      // Deliver each actor's state to the actors on other devices in range.
      const { links } = currentLinks(m.tick);
      for (const a of m.actors) {
        const byDevice = new Map<DeviceId, ActorId[]>();
        for (const [x, y] of links) {
          const other = x === a.id ? y : y === a.id ? x : null;
          if (!other) continue;
          const dev = latest.get(other)?.device;
          if (!dev || dev === m.device) continue;
          byDevice.set(dev, [...(byDevice.get(dev) ?? []), other]);
        }
        for (const [dev, to] of byDevice) send(sockets.get(dev), { type: "relay", from: a.id, to, tick: m.tick, k: a.k });
      }
    }
  });
});

function status(): DeviceStatus[] {
  const now = Date.now();
  return DEVICES.map((device) => {
    const seen = lastSeen.get(device);
    const age = seen ? now - seen.at : Infinity;
    return { device, online: online(device), lastSeenMs: Number.isFinite(age) ? age : -1, tick: seen?.tick ?? -1 };
  });
}

setInterval(() => {
  const st = status();
  // Status goes to devices too: it doubles as the keep-alive that tells a
  // device the hub is still there when none of its actors are in range.
  broadcastAll({ type: "status", devices: st, started });
  const tick = started ? tickAt(Date.now(), started.t0) : -1;
  const { links } = currentLinks(tick);
  const actors = [...latest.values()].map((a) => ({ ...a, online: online(a.device) }));
  const gemini = { state: geminiStatus.state, calls: geminiStatus.calls, failures: geminiStatus.failures };
  const p = plan ? { commander: plan.commander, intents: plan.intents } : null;
  dashboards.forEach((d) => send(d, { type: "observe", tick, actors, links, events: recentEvents.slice(-30), gemini, plan: p }));
}, HEARTBEAT_MS);

let lastLine = "";
setInterval(() => {
  const line = status()
    .map((d) => `${d.device}:${d.online ? "up" : "DOWN"}(t${d.tick})`)
    .join("  ");
  if (line !== lastLine) console.log(new Date().toLocaleTimeString(), line);
  lastLine = line;
}, 1000);

http.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  console.log(`hub on port ${PORT}. Dashboard: http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  phone: http://${ip}:${PORT}/phone   laptop B: $env:HUB="${ip}"`);
  console.log('press "s" to start a mission, "q" to quit');
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (b) => {
    const key = String(b);
    if (key === "s") startMission();
    if (key === "q" || key === "\u0003") process.exit(0);
  });
}
