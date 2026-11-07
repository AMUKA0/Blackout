import { ACTOR_PHRASES, NUMBERS, callClips, clipUrl } from "../shared/voice.ts";
import { HubClient } from "./client.ts";
import { LiveNode } from "./node.ts";
import { Radio } from "./radio.ts";

// Scout 4 on the phone. Airplane mode is its real radio switch.

const client = new HubClient("phone", `ws://${location.host}`, (url) => new WebSocket(url) as never);
let node: LiveNode | null = null;
let alone = 0;
let found = 0;

let radio: Radio | null = null;
let wasOnline = true;

client.onMission = (m) => {
  node?.stop();
  found = 0;
  node = new LiveNode("phone", client, m.seed, {
    manualRadio: true,
    onEvent: (e) => {
      if (e.type === "found") {
        found++;
        // HQ voices it when we're linked; alone, the phone speaks for itself.
        if (!client.online) radio?.say(callClips("S4", "found", e.survivor));
      }
    },
    onTick: () => {
      if (!client.online) alone++;
      if (wasOnline !== client.online && client.mission) {
        radio?.say(callClips("S4", client.online ? "back" : "lost"));
        wasOnline = client.online;
      }
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
    radio = new Radio(ctx);
    radio.maxQueue = 3;
    // Decode every Scout 4 clip now, while we still have a network.
    await radio.preload([
      "/audio/fx/static.mp3",
      ...["callsign", ...Object.keys(ACTOR_PHRASES), ...NUMBERS.map((_, i) => `n${i + 1}`)].map((c) => clipUrl("S4", c)),
    ]);
  } catch {}
  $("start").hidden = true;
  $("ui").hidden = false;
  client.start();
};
