import { WebSocket } from "ws";
import type { DeviceId } from "../shared/types.ts";
import { bestOffset, DEAD_AFTER_MS, HEARTBEAT_MS, offsetFrom, PORT, tickAt, type FromHub, type Sample, type ToHub } from "./protocol.ts";

// Laptop B (or any laptop device). Usage:  HUB=192.168.x.x node src/net/device.ts B
// Press "r" to toggle the radio. Radio off closes the socket AND sets
// radio.blocked, which later also blocks this device's Gemini and ElevenLabs
// calls, so the partition is honest.

const device = (process.argv[2] ?? "B") as DeviceId;
const url = `ws://${process.env.HUB ?? "localhost"}:${PORT}`;

export const radio = { blocked: false };

let ws: WebSocket | null = null;
let lastFromHub = 0;
let offset = 0;
const samples: Sample[] = [];
let mission: { t0: number; seed: number } | null = null;
let state = "connecting";

const hubNow = () => Date.now() + offset;
const tick = () => (mission ? tickAt(hubNow(), mission.t0) : -1);
const send = (m: ToHub) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

function connect() {
  if (radio.blocked) return;
  state = "connecting";
  const sock = new WebSocket(url);
  ws = sock;
  sock.on("open", () => {
    state = "online";
    lastFromHub = Date.now();
    send({ type: "hello", device, mission });
    for (let i = 0; i < 5; i++) setTimeout(() => send({ type: "ping", t1: Date.now() }), i * 100);
  });
  sock.on("message", (raw) => {
    lastFromHub = Date.now();
    const m = JSON.parse(String(raw)) as FromHub;
    if (m.type === "pong") {
      samples.push(offsetFrom(m.t1, m.server, Date.now()));
      if (samples.length > 20) samples.shift();
      offset = bestOffset(samples);
    } else if (m.type === "start") {
      mission = { t0: m.t0, seed: m.seed };
    }
  });
  sock.on("close", () => {
    if (ws === sock) ws = null;
    state = radio.blocked ? "radio off" : "offline";
    if (!radio.blocked) setTimeout(connect, 500);
  });
  sock.on("error", () => {}); // close follows
}

// Heartbeat out; treat 2s of silence from the hub as a dead link.
setInterval(() => {
  send({ type: "hb", device, tick: tick() });
  if (ws && Date.now() - lastFromHub > DEAD_AFTER_MS) ws.terminate();
}, HEARTBEAT_MS);

setInterval(() => send({ type: "ping", t1: Date.now() }), 5000);

let lastLine = "";
setInterval(() => {
  const line = `${device} ${state.padEnd(10)} tick ${tick()}  clock offset ${offset.toFixed(0)}ms`;
  if (line !== lastLine) console.log(new Date().toLocaleTimeString(), line);
  lastLine = line;
}, 1000);

connect();
console.log(`device ${device} -> ${url}. Press "r" to toggle radio, "q" to quit.`);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (b) => {
    const key = String(b);
    if (key === "r") {
      radio.blocked = !radio.blocked;
      if (radio.blocked) ws?.close();
      else connect();
      console.log(radio.blocked ? "RADIO OFF (hub, Gemini and ElevenLabs blocked)" : "radio on");
    }
    if (key === "q" || key === "\u0003") process.exit(0);
  });
}
