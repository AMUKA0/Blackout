import { HubClient } from "./client.ts";
import { LiveNode } from "./node.ts";

// Scout 4 on the phone. Airplane mode is its real radio switch.

const client = new HubClient("phone", `ws://${location.host}`, (url) => new WebSocket(url) as never);
let node: LiveNode | null = null;
let alone = 0;
let found = 0;

client.onMission = (m) => {
  node?.stop();
  found = 0;
  node = new LiveNode("phone", client, m.seed, {
    manualRadio: true,
    onEvent: (e) => {
      if (e.type === "found") found++;
    },
    onTick: () => {
      if (!client.online) alone++;
    },
  });
  node.start();
};

const $ = (id: string) => document.getElementById(id)!;

setInterval(() => {
  const a = node?.actors[0];
  document.body.classList.toggle("offline", !client.online);
  $("state").textContent = client.online ? "Linked" : "Alone, still working";
  $("doing").textContent = a ? (node!.reasons.get(a.spec.id) ?? "") : "Waiting for mission";
  $("stats").textContent = a ? `found ${found} · alone ${alone}s · at ${a.pos.x},${a.pos.y}` : "";
  $("meta").textContent = `tick ${client.tick()} · clock offset ${client.clockOffset().toFixed(0)} ms`;
}, 250);

$("start").onclick = async () => {
  try {
    const ctx = new AudioContext();
    await ctx.resume();
    (window as unknown as { __audio: AudioContext }).__audio = ctx;
  } catch {}
  $("start").hidden = true;
  $("ui").hidden = false;
  client.start();
};
