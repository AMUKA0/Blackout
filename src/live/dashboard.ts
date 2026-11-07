import { generateWorld } from "../shared/world.ts";
import type { World } from "../shared/types.ts";
import type { FromHub, ObservedActor } from "../net/protocol.ts";

// HQ view. It only knows what reaches the hub, so actors on a device that is
// offline are drawn as ghosts at their last known position.

const CELL = 36;
const NAMES: Record<string, string> = { A: "Laptop A (S1, R1)", B: "Laptop B (S2, S3, R2)", phone: "Phone (S4)" };
let world: World | null = null;
let seed = -1;

const $ = (id: string) => document.getElementById(id)!;
const svgNS = "http://www.w3.org/2000/svg";

function el(tag: string, attrs: Record<string, string | number>, text?: string) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

function drawMap(actors: ObservedActor[], links: [string, string][]) {
  if (!world) return;
  const svg = $("map");
  svg.replaceChildren();
  const size = world.size * CELL;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.appendChild(el("rect", { x: 0, y: 0, width: size, height: size, class: "land" }));
  world.water.forEach((w, i) => {
    if (w) svg.appendChild(el("rect", { x: (i % world!.size) * CELL, y: Math.floor(i / world!.size) * CELL, width: CELL, height: CELL, class: "water" }));
  });

  // What HQ knows about survivors: union of every actor's last report.
  const found = new Map<number, { x: number; y: number }>();
  const rescued = new Set<number>();
  for (const a of actors) {
    for (const [id, f] of Object.entries(a.k.found)) found.set(+id, f.pos);
    for (const id of Object.keys(a.k.rescued)) rescued.add(+id);
  }
  for (const [id, p] of found) {
    const cx = p.x * CELL + CELL / 2;
    const cy = p.y * CELL + CELL / 2;
    svg.appendChild(el("rect", { x: cx - 9, y: cy - 9, width: 18, height: 18, rx: 4, class: rescued.has(id) ? "saved" : "survivor" }));
    svg.appendChild(el("text", { x: cx, y: cy + 4, class: "sid" }, String(id)));
  }

  const pos = new Map(actors.map((a) => [a.id, a]));
  for (const [x, y] of links) {
    const a = pos.get(x as never);
    const b = pos.get(y as never);
    if (!a || !b || !a.online || !b.online) continue; // HQ can't see links it has no contact with
    svg.appendChild(el("line", { x1: a.pos.x * CELL + CELL / 2, y1: a.pos.y * CELL + CELL / 2, x2: b.pos.x * CELL + CELL / 2, y2: b.pos.y * CELL + CELL / 2, class: "link" }));
  }
  for (const a of actors) {
    const cx = a.pos.x * CELL + CELL / 2;
    const cy = a.pos.y * CELL + CELL / 2;
    const alone = !links.some(([x, y]) => (x === a.id || y === a.id) && pos.get(x as never)?.online && pos.get(y as never)?.online);
    const cls = !a.online ? "actor ghost" : alone ? "actor alone" : "actor";
    svg.appendChild(el("circle", { cx, cy, r: 15, class: cls }));
    svg.appendChild(el("text", { x: cx, y: cy + 5, class: a.online ? "aid" : "aid ghost-text" }, a.id));
  }
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", device: "dashboard" }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data) as FromHub;
    if (m.type === "status") {
      if (m.started && m.started.seed !== seed) {
        seed = m.started.seed;
        world = generateWorld(seed);
      }
      $("mission").textContent = m.started ? `Seed ${m.started.seed}` : 'No mission. Press "s" in the hub terminal.';
      $("devices").innerHTML = m.devices
        .map((d) => `<div class="card ${d.online ? "" : "down"}"><b>${NAMES[d.device]}</b><span>${d.online ? "linked" : "no contact"} · tick ${d.tick}</span></div>`)
        .join("");
    } else if (m.type === "observe") {
      $("tick").textContent = m.tick >= 0 ? `t${m.tick}` : "";
      drawMap(m.actors, m.links);
      $("reasons").innerHTML = m.actors
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => `<li class="${a.online ? "" : "stale"}"><b>${a.id}</b> ${a.online ? "" : `(last heard t${a.tick}) `}${a.reason}</li>`)
        .join("");
      $("events").innerHTML = m.events
        .slice()
        .sort((a, b) => b.tick - a.tick)
        .filter((ev) => ev.type !== "expired")
        .map((ev) => {
          const who = "actor" in ev ? ev.actor : "";
          const what = ev.type === "conflict" ? `yields survivor ${ev.survivor} to ${ev.winner}` : `${ev.type} survivor ${ev.survivor}`;
          return `<li class="${ev.late ? "late" : ""}">t${ev.tick} <b>${who}</b> ${what}${ev.late ? " (delivered late)" : ""}</li>`;
        })
        .join("");
    }
  };
  ws.onclose = () => setTimeout(connect, 500);
}
connect();
