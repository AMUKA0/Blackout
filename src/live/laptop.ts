import { WebSocket } from "ws";
import { PORT } from "../net/protocol.ts";
import type { DeviceId } from "../shared/types.ts";
import { HubClient } from "./client.ts";
import { LiveNode } from "./node.ts";
import { startDeviceView } from "./device-view.ts";

// Runs one laptop's actors. Laptop A: node src/live/laptop.ts A
// Laptop B:  $env:HUB="<laptop A ip>"; node src/live/laptop.ts B
// Press "r" to toggle this device's radio by hand, "q" to quit.

const device = (process.argv[2] ?? "A") as DeviceId;
const hub = process.env.HUB ?? "localhost";
const target = hub.includes(":") ? hub : `${hub}:${PORT}`; // HUB may carry its own port
const client = new HubClient(device, `ws://${target}`, (url) => new WebSocket(url) as never);
let node: LiveNode | null = null;
let counts = new Map<string, { found: number; rescued: number }>();
let offlineSince: number | null = null;

client.onMission = (m) => {
  node?.stop();
  counts = new Map();
  offlineSince = null;
  node = new LiveNode(device, client, m.seed, {
    onEvent: (e) => {
      if (e.type !== "found" && e.type !== "rescued") return;
      const c = counts.get(e.actor) ?? { found: 0, rescued: 0 };
      c[e.type]++;
      counts.set(e.actor, c);
    },
    onTick: (t) => {
      if (!client.online && offlineSince === null) offlineSince = t;
      if (client.online) offlineSince = null;
    },
  });
  node.start();
  console.log(`mission seed ${m.seed}, my actors: ${node.actors.map((a) => a.spec.id).join(", ")}`);
};
client.start();

// This laptop's own screen: its craft, served locally so it works offline.
startDeviceView(Number(process.env.VIEW_PORT ?? (device === "A" ? 8081 : 8082)), () => ({
  device,
  link: client.state,
  tick: client.tick(),
  offlineSince,
  hubOffline: client.hubOffline,
  actors: (node?.actors ?? []).map((a) => ({
    id: a.spec.id,
    pos: a.pos,
    mode: a.mode,
    reason: node!.reasons.get(a.spec.id) ?? "",
    found: counts.get(a.spec.id)?.found ?? 0,
    rescued: counts.get(a.spec.id)?.rescued ?? 0,
    crashedAt: a.crashedAt,
  })),
}), (actor) => {
  node?.crash(actor as never);
  console.log(`crash ${actor} requested from this laptop's screen`);
});

let shown = 0;
setInterval(() => {
  if (!node) return;
  for (const l of node.log.slice(shown)) console.log(`t${l.tick}  ${l.text}`);
  shown = node.log.length;
}, 250);

let lastLine = "";
setInterval(() => {
  const actors = node?.actors.map((a) => `${a.spec.id}@${a.pos.x},${a.pos.y}:${a.mode}`).join(" ") ?? "";
  if (client.replaced) {
    console.log(`another ${device} connected to the hub; this one is stopping`);
    process.exit(0);
  }
  const line = `${device} ${client.state.padEnd(10)} tick ${client.tick()}  ${actors}`;
  if (line !== lastLine) console.log(line);
  lastLine = line;
}, 1000);

console.log(`device ${device} -> ws://${target}. "r" toggles radio, "q" quits.`);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (b) => {
    const key = String(b);
    if (key === "r") client.setRadio(client.radioBlocked);
    if (key === "q" || key === "\u0003") process.exit(0);
  });
}
