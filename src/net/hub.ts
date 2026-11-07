import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import type { DeviceId } from "../shared/types.ts";
import { DEAD_AFTER_MS, HEARTBEAT_MS, PORT, type DeviceStatus, type FromHub, type ToHub } from "./protocol.ts";

// Laptop A. Serves the phone page and dashboard, relays messages, tracks
// which devices are alive. Press "s" to start a mission, "q" to quit.

const SEED = Number(process.env.SEED ?? 3);
const DEVICES: DeviceId[] = ["A", "B", "phone"];
const lastSeen = new Map<DeviceId, { at: number; tick: number }>();
let started: { t0: number; seed: number } | null = null;

const pages: Record<string, string> = {
  "/": "public/dashboard.html",
  "/phone": "public/phone.html",
};

function startMission() {
  started = { t0: Date.now() + 3000, seed: SEED };
  broadcast({ type: "start", ...started });
  console.log(`mission starts in 3s, seed ${SEED}`);
}

const http = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/start") {
    startMission();
    res.writeHead(204).end();
    return;
  }
  const file = pages[req.url ?? "/"];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server: http });
const clients = new Set<WebSocket>();
const send = (ws: WebSocket, m: FromHub) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
const broadcast = (m: FromHub) => clients.forEach((c) => send(c, m));

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let m: ToHub;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === "ping") send(ws, { type: "pong", t1: m.t1, server: Date.now() });
    else if (m.type === "hb") lastSeen.set(m.device, { at: Date.now(), tick: m.tick });
    else if (m.type === "hello") {
      // A restarted hub learns the running mission back from the devices.
      if (!started && m.mission) {
        started = m.mission;
        console.log(`recovered running mission from ${m.device}, seed ${started.seed}`);
      }
      if (started) send(ws, { type: "start", ...started });
    }
  });
});

function status(): DeviceStatus[] {
  const now = Date.now();
  return DEVICES.map((device) => {
    const seen = lastSeen.get(device);
    const age = seen ? now - seen.at : Infinity;
    return { device, online: age < DEAD_AFTER_MS, lastSeenMs: Number.isFinite(age) ? age : -1, tick: seen?.tick ?? -1 };
  });
}

setInterval(() => broadcast({ type: "status", devices: status(), started }), HEARTBEAT_MS);

// Laptop A's own heartbeat (its actors live in this process later).
setInterval(() => {
  const tick = started ? Math.floor((Date.now() - started.t0) / 1000) : -1;
  lastSeen.set("A", { at: Date.now(), tick });
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
  for (const ip of ips) console.log(`  phone: http://${ip}:${PORT}/phone   laptop B: HUB=${ip}`);
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
