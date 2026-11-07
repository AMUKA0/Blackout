import type { ActorId } from "../shared/types.ts";
import type { DeviceViewState } from "./device-view.ts";
import { BRAND_MARK, CRAFT_CSS, Heading, craftSvg, wreckSvg } from "./craft.ts";

// A laptop's own screen: each of its craft, big, turning to face where it is
// going. Fed by the laptop's local process, so it works with the Wi-Fi off,
// and its crash buttons never leave this laptop.

const NAMES: Record<string, string> = { S1: "Scout 1", S2: "Scout 2", S3: "Scout 3", S4: "Scout 4", R1: "Rescue 1", R2: "Rescue 2" };
const $ = (id: string) => document.getElementById(id)!;
const style = document.createElement("style");
style.textContent = CRAFT_CSS;
document.head.appendChild(style);
$("brand").innerHTML = BRAND_MARK;
const heading = new Heading();
let built = "";
const wreckShown = new Set<string>();
let socket: WebSocket | null = null;

function render(s: DeviceViewState) {
  const off = s.link !== "online";
  const anyDown = s.actors.some((a) => a.crashedAt !== undefined);
  document.body.classList.toggle("off", off);
  $("title").textContent = `Laptop ${s.device}`;
  $("clock").textContent = s.tick >= 0 ? `t${Math.min(s.tick, 100)}` : "t–";
  const dark = s.offlineSince !== null && s.tick >= 0 ? Math.max(0, Math.min(s.tick, 99) - s.offlineSince) : 0;
  if (s.tick < 0) {
    $("headline").textContent = off ? "Looking for the hub" : "Linked to the team";
    $("subline").textContent = "Waiting for the mission to start.";
  } else if (off) {
    $("headline").textContent = `No contact ${dark}s. Still working.`;
    $("subline").textContent = "No hub, no Gemini. These actors keep sweeping and rescuing on their standing orders.";
  } else if (anyDown) {
    $("headline").textContent = "Drone down. Mayday sent.";
    $("subline").textContent = "Its partner flies to the wreck to pick up its survivor reports, then covers its sector.";
  } else {
    $("headline").textContent = "Linked to the team";
    $("subline").textContent = "Sharing what we find with every actor in range.";
  }

  const ids = s.actors.map((a) => a.id).join(",");
  if (ids && ids !== built) {
    built = ids;
    wreckShown.clear();
    $("fleet").innerHTML = s.actors
      .map(
        (a) => `<div class="unit" id="u-${a.id}">
          <div class="craft">${craftSvg(a.id as ActorId)}</div>
          <h2>${NAMES[a.id] ?? a.id}</h2>
          <div class="doing"></div>
          <div class="facts"><span><b class="f">0</b>found</span><span><b class="r">0</b>rescued</span><span><b class="p">–</b>position</span></div>
          ${a.id.startsWith("S") ? `<button class="crash" type="button" data-actor="${a.id}">Crash ${NAMES[a.id]}</button>` : ""}
        </div>`,
      )
      .join("");
  }
  for (const a of s.actors) {
    const u = document.getElementById(`u-${a.id}`);
    if (!u) continue;
    const crashed = a.crashedAt !== undefined;
    u.classList.toggle("down", crashed);
    if (crashed && !wreckShown.has(a.id)) {
      wreckShown.add(a.id);
      u.querySelector(".craft")!.innerHTML = wreckSvg(a.id as ActorId);
    }
    const btn = u.querySelector("button.crash") as HTMLButtonElement | null;
    if (btn) btn.hidden = crashed || s.tick < 0 || s.tick >= 99;
    if (!crashed) {
      const deg = heading.update(a.id, a.pos);
      (u.querySelector(".craft-turn") as SVGGElement).style.transform = `rotate(${deg}deg)`;
      u.querySelector(".craft-svg")!.classList.toggle("craft-still", a.mode === "rescuing");
    }
    (u.querySelector(".doing") as HTMLElement).textContent = a.reason || "Waiting for the mission";
    (u.querySelector(".f") as HTMLElement).textContent = String(a.found);
    (u.querySelector(".r") as HTMLElement).textContent = a.id.startsWith("R") ? String(a.rescued) : "–";
    (u.querySelector(".p") as HTMLElement).textContent = `${String.fromCharCode(65 + a.pos.x)}${a.pos.y + 1}`;
  }
}

$("fleet").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button.crash") as HTMLButtonElement | null;
  if (!btn || !socket) return;
  socket.send(JSON.stringify({ crash: btn.dataset.actor }));
  btn.disabled = true;
  btn.textContent = "Mayday sent";
});

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  socket = ws;
  ws.onmessage = (e) => render(JSON.parse(e.data) as DeviceViewState);
  ws.onclose = () => setTimeout(connect, 500);
}
connect();
