import { WebSocket } from "ws";
import { PORT } from "../net/protocol.ts";
import type { DeviceId } from "../shared/types.ts";
import { HubClient } from "./client.ts";
import { LiveNode } from "./node.ts";

// Runs one laptop's actors. Laptop A: node src/live/laptop.ts A
// Laptop B:  $env:HUB="<laptop A ip>"; node src/live/laptop.ts B
// Press "r" to toggle this device's radio by hand, "q" to quit.

const device = (process.argv[2] ?? "A") as DeviceId;
const hub = process.env.HUB ?? "localhost";
const client = new HubClient(device, `ws://${hub}:${PORT}`, (url) => new WebSocket(url) as never);
let node: LiveNode | null = null;

client.onMission = (m) => {
  node?.stop();
  node = new LiveNode(device, client, m.seed, { manualRadio: false });
  node.start();
  console.log(`mission seed ${m.seed}, my actors: ${node.actors.map((a) => a.spec.id).join(", ")}`);
};
client.start();

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

console.log(`device ${device} -> ws://${hub}:${PORT}. "r" toggles radio, "q" quits.`);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (b) => {
    const key = String(b);
    if (key === "r") client.setRadio(client.radioBlocked);
    if (key === "q" || key === "\u0003") process.exit(0);
  });
}
