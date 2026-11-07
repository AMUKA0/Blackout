import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { decide as geminiDecide, geminiStatus, summarise, type DecideRequest, type Plan } from "./gemini.ts";
import { N8nLink } from "./n8n.ts";
import { generateWorld } from "../shared/world.ts";
import { networkInterfaces } from "node:os";
import { extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { applyFault } from "../sim/engine.ts";
import { CONFIG } from "../shared/config.ts";
import { DEMO_FAULTS } from "../shared/faults.ts";
import { radioLinks, type StepEvent } from "../shared/step.ts";
import type { ActorId, DeviceId } from "../shared/types.ts";
import { DEAD_AFTER_MS, HEARTBEAT_MS, PORT, tickAt, type DeviceStatus, type FromHub, type Mission, type ObservedActor, type ToHub } from "./protocol.ts";

// Laptop A. Plays the part of the air between devices: an actor's broadcast
// only reaches actors in radio range on devices that are online. Also serves
// the phone page and the HQ dashboard. Press "s" to start, "q" to quit.

const SEED = Number(process.env.SEED ?? 13);
const DEVICES: DeviceId[] = ["A", "B", "phone"];
const lastSeen = new Map<DeviceId, { at: number; tick: number }>();
const sockets = new Map<DeviceId, WebSocket>();
const dashboards = new Set<WebSocket>();
const latest = new Map<ActorId, ObservedActor>();
const recentEvents: (StepEvent & { device: DeviceId; late: boolean; arrived: number })[] = [];
const truth: { survivor: number; tick: number; by: ActorId }[] = [];
let started: Mission | null = null;
let plan: Plan | null = null;

// n8n: every status change, a batch of events every 3s, and one report at the end.
const n8n = new N8nLink();
const LABELS: Record<DeviceId, string> = { A: "Laptop A team (S1, R1)", B: "Laptop B team (S2, S3, R2)", phone: "Scout 4 (phone)" };
const missionEvents: (StepEvent & { device: DeviceId; late: boolean })[] = [];
let n8nBatch: (StepEvent & { device: DeviceId; late: boolean })[] = [];
let reportSent = false;
const wasOnline = new Map<DeviceId, boolean>();

function n8nTick(tick: number) {
  if (!started) return;
  for (const d of DEVICES) {
    const now = online(d);
    const before = wasOnline.get(d);
    wasOnline.set(d, now);
    if (before === undefined || before === now || tick < 0) continue;
    const actors = [...latest.values()].filter((a) => a.device === d).map((a) => a.id);
    n8n.push("status", { device: d, label: LABELS[d], online: now, tick, at: Date.now(), actors });
  }
  if (tick >= CONFIG.missionTicks - 1 && !reportSent) {
    reportSent = true;
    void sendReport(tick);
  }
}

setInterval(() => {
  if (n8nBatch.length === 0 || !started) return;
  const events = n8nBatch;
  n8nBatch = [];
  n8n.push("events", {
    tick: tickAt(Date.now(), started.t0),
    events: events.map((e) => ({ ...e, text: describe(e) })),
    lateCount: events.filter((e) => e.late).length,
    lateFrom: [...new Set(events.filter((e) => e.late).map((e) => LABELS[e.device]))],
  });
}, 3000);

function describe(e: StepEvent): string {
  if (e.type === "found") return `${e.actor} found survivor ${e.survivor}${e.isolated ? " while cut off" : ""}`;
  if (e.type === "rescued") return `${e.actor} rescued survivor ${e.survivor}${e.isolated ? " while cut off" : ""}`;
  if (e.type === "conflict") return `${e.actor} yielded survivor ${e.survivor} to ${e.winner}`;
  if (e.type === "wasted") return `${e.actor} reached survivor ${e.survivor} after someone else (wasted trip)`;
  return `survivor ${e.survivor} lost`;
}

async function sendReport(tick: number) {
  const total = generateWorld(started!.seed).survivors.length;
  const rescued = truth.length;
  const count = (t: string) => missionEvents.filter((e) => e.type === t).length;
  const offlineRescues = missionEvents.filter((e) => e.type === "rescued" && e.isolated).length;
  const offlineFinds = missionEvents.filter((e) => e.type === "found" && e.isolated).length;
  const report = {
    seed: started!.seed,
    tick,
    total,
    rescued,
    lost: total - rescued,
    wasted: count("wasted"),
    conflicts: count("conflict"),
    lateReports: missionEvents.filter((e) => e.late).length,
    offlineFinds,
    offlineRescues,
    survivors: truth.map((t) => ({ id: t.survivor, by: t.by, tick: t.tick })).sort((a, b) => a.tick - b.tick),
    gemini: { calls: geminiStatus.calls, failures: geminiStatus.failures },
  };
  const summary = await summarise(report).catch(
    () => `${rescued} of ${total} survivors reached. ${offlineFinds} found and ${offlineRescues} rescued by actors out of contact. ${report.conflicts} claim conflicts resolved on reconnect.`,
  );
  n8n.push("report", { ...report, summary });
  console.log(`mission report queued for n8n: ${summary}`);
}

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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
const ROUTES: Record<string, string> = { "/": "public/dashboard.html", "/phone": "public/phone.html" };

function startMission() {
  started = { t0: Date.now() + 3000, seed: SEED };
  latest.clear();
  truth.length = 0;
  recentEvents.length = 0;
  missionEvents.length = 0;
  n8nBatch = [];
  reportSent = false;
  wasOnline.clear();
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
  if (req.method === "POST" && url === "/api/n8n/toggle") {
    n8n.setBlocked(!n8n.blocked);
    console.log(n8n.blocked ? "n8n link BLOCKED (simulated outage), queueing" : "n8n link restored, replaying queue");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ blocked: n8n.blocked }));
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
  const file =
    ROUTES[url] ?? (["/js/", "/audio/", "/fonts/"].some((p) => url.startsWith(p)) || url === "/baseline.json" ? `public${url}` : null);
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
  // Scripted cuts between actors on devices HQ can still hear.
  const known = new Map(actors.map((a) => [a.id, a]));
  const cuts = [...cut]
    .map((k) => k.split("-") as [ActorId, ActorId])
    .filter(([a, b]) => known.has(a) && known.has(b) && !off.has(known.get(a)!.device) && !off.has(known.get(b)!.device));
  return { links: radioLinks(actors, cut, off), off, cuts };
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
        // One client per device: the newest takes over, the old one stops.
        const old = sockets.get(m.device);
        if (old && old !== ws && old.readyState === old.OPEN) {
          send(old, { type: "kicked", reason: `another ${m.device} connected` });
          old.close();
          console.log(`a new ${m.device} client replaced the old one`);
        }
        sockets.set(m.device, ws);
        lastSeen.set(m.device, { at: Date.now(), tick: -1 });
      }
      // Only adopt a mission from a device if it is still running.
      if (!started && m.mission && tickAt(Date.now(), m.mission.t0) < CONFIG.missionTicks) {
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
        missionEvents.push({ ...ev, device: m.device, late: m.tick - e.tick > 2 });
        n8nBatch.push({ ...ev, device: m.device, late: m.tick - e.tick > 2 });
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
  const { links, cuts } = currentLinks(tick);
  const actors = [...latest.values()].map((a) => ({ ...a, online: online(a.device) }));
  const gemini = { state: geminiStatus.state, calls: geminiStatus.calls, failures: geminiStatus.failures };
  const p = plan ? { commander: plan.commander, intents: plan.intents } : null;
  const n8nState = { state: n8n.state, queued: n8n.queued, sent: n8n.sent };
  n8nTick(tick);
  const total = started ? generateWorld(started.seed).survivors.length : 0;
  // Every device reports expiries it sees, so count each survivor once.
  const saved = new Set(truth.map((t) => t.survivor));
  const lost = new Set(missionEvents.filter((e) => e.type === "expired" && !saved.has(e.survivor)).map((e) => e.survivor)).size;
  dashboards.forEach((d) =>
    send(d, { type: "observe", tick, actors, links, cuts, events: recentEvents.slice(-40), gemini, plan: p, n8n: n8nState, score: { reached: truth.length, total, lost } }),
  );
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
    if (key === "n") {
      n8n.setBlocked(!n8n.blocked);
      console.log(n8n.blocked ? "n8n link BLOCKED (simulated outage), queueing" : "n8n link restored, replaying queue");
    }
    if (key === "q" || key === "\u0003") process.exit(0);
  });
}
