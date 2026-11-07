import { CONFIG } from "../shared/config.ts";
import { ACTOR_PHRASES, NUMBERS, callClips, clipUrl } from "../shared/voice.ts";
import { HubClient } from "./client.ts";
import { LiveNode } from "./node.ts";
import { Radio } from "./radio.ts";
import { BRAND_MARK, CRAFT_CSS, Heading, craftSvg, wreckSvg } from "./craft.ts";

// Scout 4 on the phone. Airplane mode is its real radio switch.

const client = new HubClient("phone", `ws://${location.host}`, (url) => new WebSocket(url) as never);
let node: LiveNode | null = null;
let alone = 0;
let found = 0;
let radio: Radio | null = null;
let wasOnline = true;
let contact: boolean[] = [];

client.onMission = (m) => {
  node?.stop();
  found = 0;
  alone = 0;
  contact = [];
  node = new LiveNode("phone", client, m.seed, {
    onEvent: (e) => {
      if (e.type === "found") {
        found++;
        // HQ voices it when we're linked; alone, the phone speaks for itself.
        if (!client.online) radio?.say(callClips("S4", "found", e.survivor));
      }
    },
    onTick: (t) => {
      if (!client.online) alone++;
      contact[t] = client.online;
      if (wasOnline !== client.online && client.mission) {
        radio?.say(callClips("S4", client.online ? "back" : "lost"));
        wasOnline = client.online;
      }
    },
  });
  node.start();
};

const $ = (id: string) => document.getElementById(id)!;

function strip(): string {
  const T = CONFIG.missionTicks;
  let out = `<svg class="strip" viewBox="0 0 ${T} 18" preserveAspectRatio="none" aria-hidden="true"><rect width="${T}" height="18" rx="2" fill="currentColor" opacity=".18"/>`;
  for (let i = 0; i < contact.length; ) {
    let j = i;
    while (j < contact.length && contact[j] === contact[i]) j++;
    out += `<rect x="${i}" y="3" width="${j - i}" height="12" class="${contact[i] ? "on" : "off"}"/>`;
    i = j;
  }
  return out + "</svg>";
}

const style = document.createElement("style");
style.textContent = CRAFT_CSS;
document.head.appendChild(style);
$("craft").innerHTML = craftSvg("S4");
$("brand").innerHTML = BRAND_MARK;
const heading = new Heading();
let showingWreck = false;

$("crash").onclick = () => {
  node?.crash("S4");
  ($("crash") as HTMLButtonElement).disabled = true;
  radio?.say(callClips("S4", "mayday"), true);
};

setInterval(() => {
  const a = node?.actors[0];
  const crashed = a?.crashedAt !== undefined;
  // A crashed drone gets its own graphic and screen.
  if (crashed !== showingWreck) {
    showingWreck = crashed;
    $("craft").innerHTML = crashed ? wreckSvg("S4") : craftSvg("S4");
  }
  document.body.classList.toggle("down", crashed);
  ($("crash") as HTMLButtonElement).hidden = crashed || !client.mission || client.tick() >= CONFIG.missionTicks - 1;
  if (crashed) {
    const rec = a!.k.recovered.S4;
    $("word").textContent = "Crashed";
    $("sub").textContent = rec ? `My reports were recovered by ${rec.by === "S2" ? "Scout 2" : rec.by}.` : "Mayday sent. Waiting for a drone to reach the wreck and recover my reports.";
    $("doing").textContent = "";
    $("strip").innerHTML = strip();
    return;
  }
  if (a) {
    const deg = heading.update("S4", a.pos);
    ($("craft").querySelector(".craft-turn") as SVGGElement).style.transform = `rotate(${deg}deg)`;
  }
  const replaced = client.replaced;
  const linked = client.online;
  document.body.classList.toggle("alone", !linked && !replaced && !!client.mission);
  document.body.classList.toggle("replaced", replaced);
  if (replaced) {
    node?.stop();
    $("word").textContent = "Replaced";
    $("sub").textContent = "Another Scout 4 page connected to the hub. This one has stopped.";
    $("doing").textContent = "";
    return;
  }
  const t = client.tick();
  $("clock").textContent = t >= 0 ? `t${Math.min(t, CONFIG.missionTicks)}` : "t–";
  if (!client.mission) {
    $("word").textContent = linked ? "Linked" : "Offline";
    $("sub").textContent = linked ? "Waiting for HQ to start the mission." : "Looking for the hub.";
  } else {
    $("word").textContent = linked ? "Linked" : "Alone";
    $("sub").textContent = linked ? "In contact with the team." : "No radio, no Gemini. Still working on standing orders.";
  }
  $("doing").textContent = a ? (node!.reasons.get(a.spec.id) ?? "Sweeping my sector") : "Waiting for the mission to start.";
  $("found").textContent = String(found);
  $("alone").textContent = `${alone}s`;
  $("pos").textContent = a ? `${String.fromCharCode(65 + a.pos.x)}${a.pos.y + 1}` : "–";
  $("strip").innerHTML = strip();
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
  $("start-screen").hidden = true;
  $("ui").hidden = false;
  client.start();
};
