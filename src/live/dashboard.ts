import { CONFIG } from "../shared/config.ts";
import { generateWorld } from "../shared/world.ts";
import type { ActorId, DeviceId, Pos, World } from "../shared/types.ts";
import type { DeviceStatus, FromHub, ObservedActor } from "../net/protocol.ts";
import { HqRadio } from "./dashboard-audio.ts";
import { BRAND_MARK } from "./craft.ts";

// HQ view. It only knows what reaches the hub: actors on a device it has no
// contact with are drawn as ghosts at their last report, inside a warning zone.

type Observe = Extract<FromHub, { type: "observe" }>;
type Status = Extract<FromHub, { type: "status" }>;

const CELL = 40;
const M = 26; // margin for axis labels
const ACTORS: ActorId[] = ["S1", "S2", "S3", "S4", "R1", "R2"];
const ROLE: Record<ActorId, string> = { S1: "Scout 1", S2: "Scout 2", S3: "Scout 3", S4: "Scout 4", R1: "Rescue 1", R2: "Rescue 2" };
const DEVICE_OF: Record<ActorId, DeviceId> = { S1: "A", R1: "A", S2: "B", S3: "B", R2: "B", S4: "phone" };
const DEVICE_NAME: Record<DeviceId, string> = { A: "Laptop A", B: "Laptop B", phone: "Phone" };
const TEAM: Record<DeviceId, string> = { A: "Laptop A team", B: "Laptop B team", phone: "Scout 4" };
const NS = "http://www.w3.org/2000/svg";
const $ = (id: string) => document.getElementById(id)!;
$("brand").innerHTML = BRAND_MARK;

type Contact = "linked" | "alone" | "dark" | "absent" | "down";
// Devices that have reported in this mission. One that never joined is not
// "dark": HQ never had contact to lose.
let joined = new Set<DeviceId>();
// Mission clock for durations: stops at the last tick even if the hub runs on.
const missionNow = (tick: number) => Math.min(tick, CONFIG.missionTicks - 1);
let world: World | null = null;
let seed = -1;
let devices: DeviceStatus[] = [];
let darkSince = new Map<DeviceId, number>();
let history = new Map<ActorId, Contact[]>();
let lastTick = -1;
let lastBacklog: { team: string; count: number; tick: number } | null = null;
let seenLate = new Set<string>();

// ---------- helpers ----------
const ref = (p: Pos) => `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
const cx = (p: Pos) => p.x * CELL + CELL / 2;
const cy = (p: Pos) => p.y * CELL + CELL / 2;
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------- map: static layer ----------
const svg = $("map") as unknown as SVGSVGElement;
const layers: Record<string, SVGGElement> = {};
const actorNodes = new Map<ActorId, SVGGElement>();
const shown = new Map<ActorId, { x: number; y: number }>();

function buildMap(w: World) {
  svg.replaceChildren();
  const size = w.size * CELL;
  svg.setAttribute("viewBox", `${-M} ${-M} ${size + M + 6} ${size + M + 6}`);
  const defs = el("defs");
  defs.innerHTML = `
    <radialGradient id="halo"><stop offset="0" stop-color="#8fb0e8" stop-opacity=".16"/><stop offset=".7" stop-color="#8fb0e8" stop-opacity=".05"/><stop offset="1" stop-color="#8fb0e8" stop-opacity="0"/></radialGradient>
    <filter id="flood" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="9" result="b"/><feColorMatrix in="b" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 30 -14"/>
    </filter>
    <filter id="storm" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="16" result="b"/><feColorMatrix in="b" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 24 -10"/>
    </filter>
    <filter id="storm-edge" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="16" result="b"/><feColorMatrix in="b" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 24 -10" result="s"/>
      <feMorphology in="s" operator="erode" radius="1.6" result="e"/><feComposite in="s" in2="e" operator="out"/>
    </filter>
    <clipPath id="landclip"><rect width="${size}" height="${size}" rx="14"/></clipPath>
    <marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M1 1 9 5 1 9" fill="none" stroke="#ffa62b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
    <marker id="arrow-red" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M1 1 9 5 1 9" fill="none" stroke="#ff5d71" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>`;
  svg.appendChild(defs);

  const base = el("g");
  base.appendChild(el("rect", { width: size, height: size, rx: 14, class: "m-land" }));
  const clipped = el("g", { "clip-path": "url(#landclip)" });
  // Floods as soft organic shapes: each water tile is a blob, merged.
  const flood = el("g", { filter: "url(#flood)" });
  w.water.forEach((wet, i) => {
    if (wet) flood.appendChild(el("circle", { cx: (i % w.size) * CELL + CELL / 2, cy: Math.floor(i / w.size) * CELL + CELL / 2, r: CELL * 0.78, class: "m-water" }));
  });
  clipped.appendChild(flood);
  // Grid as quiet dots at tile corners.
  for (let y = 1; y < w.size; y++) for (let x = 1; x < w.size; x++) clipped.appendChild(el("circle", { cx: x * CELL, cy: y * CELL, r: x % 4 === 0 && y % 4 === 0 ? 1.8 : 1.1, class: "m-dot" }));
  base.appendChild(clipped);
  for (let i = 0; i < w.size; i++) {
    base.appendChild(el("text", { x: i * CELL + CELL / 2, y: -10, class: "m-axis" }, String.fromCharCode(65 + i)));
    base.appendChild(el("text", { x: -13, y: i * CELL + CELL / 2 + 4, class: "m-axis" }, String(i + 1)));
  }
  base.appendChild(el("rect", { x: w.base.x * CELL - 6, y: w.base.y * CELL - 6, width: CELL * 2 + 12, height: CELL * 2 + 12, rx: 14, class: "m-base" }));
  base.appendChild(el("text", { x: w.base.x * CELL - 2, y: w.base.y * CELL - 12, class: "m-base-label" }, "BASE"));
  svg.appendChild(base);

  for (const name of ["halos", "zones", "buildings", "intent", "links", "survivors", "actors", "labels"]) {
    layers[name] = el("g");
    svg.appendChild(layers[name]);
  }
  actorNodes.clear();
  shown.clear();
  heading.clear();
  buildBuildings(w);
}

// Buildings: rooftops seen from above. Rescuers route around them; a scout
// flying over one makes it fade so you can see the drone inside the block.
type Block = { x: number; y: number; w: number; h: number; node: SVGGElement };
let blocks: Block[] = [];

function buildBuildings(w: World) {
  blocks = [];
  const seen = new Set<number>();
  for (let i = 0; i < w.buildings.length; i++) {
    if (!w.buildings[i] || seen.has(i)) continue;
    // Each building is a small rectangle of tiles: grow right and down.
    const x0 = i % w.size;
    const y0 = Math.floor(i / w.size);
    let bw = 1;
    let bh = 1;
    while (x0 + bw < w.size && w.buildings[y0 * w.size + x0 + bw]) bw++;
    while (y0 + bh < w.size && w.buildings[(y0 + bh) * w.size + x0]) bh++;
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) seen.add(y * w.size + x);
    const px = x0 * CELL + 3;
    const py = y0 * CELL + 3;
    const pw = bw * CELL - 6;
    const ph = bh * CELL - 6;
    const g = el("g", { class: "m-bldg" });
    g.appendChild(el("rect", { x: px + 3, y: py + 4, width: pw, height: ph, rx: 4, class: "side" }));
    g.appendChild(el("rect", { x: px, y: py, width: pw, height: ph, rx: 4, class: "roof" }));
    g.appendChild(el("rect", { x: px + 6, y: py + 6, width: pw - 12, height: ph - 12, rx: 2, class: "parapet" }));
    // Roof plant: a couple of small units, placed from the block's position.
    const units = Math.max(1, Math.round((bw * bh) / 2));
    for (let u = 0; u < units; u++) {
      const ux = px + 10 + ((x0 * 7 + u * 13) % Math.max(1, pw - 26));
      const uy = py + 10 + ((y0 * 5 + u * 11) % Math.max(1, ph - 24));
      g.appendChild(el("rect", { x: ux, y: uy, width: 8, height: 6, rx: 1.5, class: "unit" }));
    }
    layers.buildings.appendChild(g);
    blocks.push({ x: px - 4, y: py - 4, w: pw + 8, h: ph + 8, node: g });
  }
}

// Top-down craft art. Scouts are quadcopter drones, rescuers are rescue boats.
const heading = new Map<ActorId, number>();

function makeCraft(id: ActorId): SVGGElement {
  const g = el("g", { class: "m-actor" });
  g.appendChild(el("circle", { class: "pulse", r: 15 }));
  const art = el("g", { class: "art" });
  if (id.startsWith("S")) {
    for (const [dx, dy] of [[-10, -10], [10, -10], [-10, 10], [10, 10]]) {
      art.appendChild(el("line", { x1: 0, y1: 0, x2: dx, y2: dy, class: "arm" }));
      art.appendChild(el("circle", { cx: dx, cy: dy, r: 6.4, class: "rotor" }));
      art.appendChild(el("circle", { cx: dx, cy: dy, r: 1.6, class: "hub" }));
    }
    art.appendChild(el("circle", { r: 10, class: "hull" }));
    art.appendChild(el("path", { d: "M-4 -12.5 0 -15.5 4 -12.5", class: "nose" }));
  } else {
    art.appendChild(el("path", { d: "M0 -21 C9 -13 12 -4 12 7 L12 15 Q12 19 8 19 L-8 19 Q-12 19 -12 15 L-12 7 C-12 -4 -9 -13 0 -21 Z", class: "hull" }));
    art.appendChild(el("path", { d: "M0 -21 C9 -13 12 -4 12 7 L12 15 Q12 19 8 19 L-8 19 Q-12 19 -12 15 L-12 7 C-12 -4 -9 -13 0 -21 Z", class: "gunwale" }));
    art.appendChild(el("line", { x1: -8, y1: 16, x2: 8, y2: 16, class: "stern" }));
  }
  g.appendChild(art);
  g.appendChild(el("text", { y: id.startsWith("S") ? 0 : 2, class: "label" }, id));
  // Crashed: its own silhouette (snapped frame, red cross, smoke).
  const wreck = el("g", { class: "wreck-art" });
  for (const [i, [x, y, r]] of [[3, -16, 4], [-2, -23, 5.5], [4, -31, 7]].entries()) {
    wreck.appendChild(el("circle", { cx: x, cy: y, r, class: "smoke", style: `animation-delay:${i * 0.8}s` }));
  }
  wreck.appendChild(el("line", { x1: 0, y1: 0, x2: -10, y2: -10, class: "w-arm" }));
  wreck.appendChild(el("line", { x1: 0, y1: 0, x2: 7, y2: -3, class: "w-arm" }));
  wreck.appendChild(el("line", { x1: 0, y1: 0, x2: 10, y2: 10, class: "w-arm" }));
  wreck.appendChild(el("circle", { cx: -10, cy: -10, r: 6.4, class: "w-rotor" }));
  wreck.appendChild(el("circle", { cx: 10, cy: 10, r: 6.4, class: "w-rotor" }));
  wreck.appendChild(el("circle", { r: 9, class: "w-hull" }));
  wreck.appendChild(el("path", { d: "M-4 -4 4 4M4 -4 -4 4", class: "w-cross" }));
  g.appendChild(wreck);
  // Offline: a tag that says so, instead of only a fainter outline.
  const tag = el("g", { class: "nosig", transform: "translate(0 -27)" });
  tag.appendChild(el("rect", { x: -31, y: -9, width: 62, height: 17, rx: 8.5 }));
  tag.appendChild(el("path", { d: "M-24 2 a6 6 0 0 1 8 -6 M-25.5 -1.5 a10 10 0 0 1 12.5 -6.5 M-26 -6 l10 10", class: "nosig-icon" }));
  tag.appendChild(el("text", { x: 5, y: 3.5 }, "NO SIGNAL"));
  g.appendChild(tag);
  g.appendChild(el("title", {}, ROLE[id]));
  return g;
}

// ---------- map: moving layer (every frame) ----------
// Nodes, links, packets and coverage are drawn from a smoothed position each
// frame, so lines stay attached to the dots as they glide.
let current: Observe | null = null;
let lastFrame = performance.now();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function frame(now: number) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (current && world) {
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 4.5);
    for (const a of current.actors) {
      const target = { x: cx(a.pos), y: cy(a.pos) };
      const s = shown.get(a.id) ?? target;
      shown.set(a.id, { x: s.x + (target.x - s.x) * k, y: s.y + (target.y - s.y) * k });
    }
    drawMoving(current, now);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function drawMoving(m: Observe, now: number) {
  const byId = new Map(m.actors.map((a) => [a.id, a]));
  const at = (id: ActorId) => shown.get(id)!;
  const online = (a?: ObservedActor) => !!a && a.online;
  const linksLive = m.links.filter(([x, y]) => online(byId.get(x)) && online(byId.get(y)));
  const linked = (id: ActorId) => linksLive.some(([x, y]) => x === id || y === id);

  layers.halos.replaceChildren();
  for (const a of m.actors) {
    if (!a.online || a.crashedAt !== undefined) continue;
    const p = at(a.id);
    const r = CONFIG.radioRange * CELL;
    layers.halos.appendChild(el("circle", { cx: p.x, cy: p.y, r, class: "m-halo" }));
    layers.halos.appendChild(el("circle", { cx: p.x, cy: p.y, r, class: "m-range" }));
  }

  layers.links.replaceChildren();
  linksLive.forEach(([x, y], i) => {
    const a = at(x);
    const b = at(y);
    layers.links.appendChild(el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "m-link" }));
    if (reduceMotion) return;
    // A packet travelling the link: knowledge being shared.
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = ((now / 1000) * (90 / Math.max(len, 40)) + i * 0.37) % 1;
    const dir = i % 2 === 0;
    const u = dir ? t : 1 - t;
    layers.links.appendChild(el("circle", { cx: a.x + (b.x - a.x) * u, cy: a.y + (b.y - a.y) * u, r: 2.6, class: "m-packet", opacity: (Math.sin(t * Math.PI) * 0.9 + 0.1).toFixed(2) }));
  });
  for (const [x, y] of m.cuts) {
    if (!online(byId.get(x)) || !online(byId.get(y))) continue;
    const a = at(x);
    const b = at(y);
    layers.links.appendChild(el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "m-cut" }));
    const g = el("g", { class: "m-cut-x", transform: `translate(${((a.x + b.x) / 2).toFixed(1)} ${((a.y + b.y) / 2).toFixed(1)})` });
    g.appendChild(el("circle", { r: 10 }));
    g.appendChild(el("path", { d: "M-4.2 -4.2 4.2 4.2M4.2 -4.2 -4.2 4.2" }));
    layers.links.appendChild(g);
  }

  for (const a of m.actors) {
    let g = actorNodes.get(a.id);
    if (!g) {
      g = makeCraft(a.id);
      layers.actors.appendChild(g);
      actorNodes.set(a.id, g);
    }
    const p = at(a.id);
    const target = { x: cx(a.pos), y: cy(a.pos) };
    // Point the craft where it is going (boats show a bow; drones a nose).
    if (Math.hypot(target.x - p.x, target.y - p.y) > 2) {
      const want = (Math.atan2(target.y - p.y, target.x - p.x) * 180) / Math.PI + 90;
      const cur = heading.get(a.id) ?? want;
      const diff = ((want - cur + 540) % 360) - 180;
      heading.set(a.id, cur + diff * 0.15);
    }
    g.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    (g.querySelector(".art") as SVGGElement).setAttribute("transform", `rotate(${(heading.get(a.id) ?? 0).toFixed(1)})`);
    const state = a.crashedAt !== undefined ? "wreck" : !a.online ? "ghost" : linked(a.id) ? "" : "alone";
    const cls = `m-actor ${a.id.startsWith("S") ? "drone" : "boat"} ${state} ${a.mode === "rescuing" ? "rescuing" : ""}`;
    if (g.getAttribute("class") !== cls) g.setAttribute("class", cls);
  }

  // A drone over a building: the roof fades so you can see it inside.
  for (const b of blocks) {
    const inside = m.actors.some((a) => {
      if (!a.id.startsWith("S")) return false;
      const p = shown.get(a.id);
      return !!p && p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
    });
    b.node.classList.toggle("entered", inside);
  }
}

// ---------- map: per-update layer ----------
function drawMap(m: Observe) {
  if (!world) return;
  current = m;

  // Storm cells over teams HQ cannot hear: two merged bands, like isobars.
  layers.zones.replaceChildren();
  layers.labels.replaceChildren();
  for (const d of ["B", "phone"] as DeviceId[]) {
    const ghosts = m.actors.filter((a) => a.device === d && !a.online);
    if (ghosts.length === 0) continue;
    const alone = d === "phone";
    const since = darkSince.get(d);
    const secs = since !== undefined && m.tick >= 0 ? Math.max(0, missionNow(m.tick) - since) : 0;
    // The zone spreads the longer HQ is in the dark: an actor can move a tile
    // per tick, so where it might be really does widen. A team's cells merge.
    const grow = Math.min(secs, 30) / 30;
    const outerR = 1.8 + 1.6 * grow;
    const innerR = 1.1 + 1.0 * grow;
    // Opacity goes on the wrapper: the merge filters need opaque input.
    for (const [cls, r, filter] of [["m-zone-outer", outerR, "storm"], ["m-zone-inner", innerR, "storm"], ["m-zone-edge", outerR, "storm-edge"]] as const) {
      const wrap = el("g", { class: `${cls}${alone ? " alone" : ""}` });
      const blob = el("g", { filter: `url(#${filter})` });
      for (const g of ghosts) blob.appendChild(el("circle", { cx: cx(g.pos), cy: cy(g.pos), r: CELL * r }));
      wrap.appendChild(blob);
      layers.zones.appendChild(wrap);
    }
    const top = ghosts.reduce((a, b) => (b.pos.y < a.pos.y ? b : a));
    const text = `${TEAM[d]} · no contact ${secs}s`;
    const w = text.length * 6.6 + 22;
    const x = Math.min(Math.max(cx(top.pos) - w / 2, 0), world.size * CELL - w);
    const y = Math.max(cy(top.pos) - CELL * (outerR + 0.5), 4);
    const label = el("g", { class: alone ? "m-zone-label alone" : "m-zone-label" });
    label.appendChild(el("rect", { x, y, width: w, height: 24, rx: 12 }));
    label.appendChild(el("text", { x: x + 11, y: y + 16.5 }, text));
    layers.labels.appendChild(label);
  }

  // Survivors as HQ knows them, each with a countdown ring to its deadline.
  const found = new Map<number, { pos: Pos; deadline: number; tick: number }>();
  const rescued = new Set<number>();
  for (const a of m.actors) {
    for (const [id, f] of Object.entries(a.k.found)) found.set(+id, f);
    for (const id of Object.keys(a.k.rescued)) rescued.add(+id);
  }
  layers.survivors.replaceChildren();
  for (const [id, f] of found) {
    const saved = rescued.has(id);
    const expired = !saved && m.tick > f.deadline;
    if (expired) continue;
    const g = el("g", { class: saved ? "m-surv saved" : "m-surv", transform: `translate(${cx(f.pos)} ${cy(f.pos)})` });
    if (saved) {
      g.appendChild(el("circle", { class: "core", r: 10 }));
      g.appendChild(el("path", { d: "M-4.5 0.3 -1.2 3.6 5 -3.2" }));
    } else {
      const R = 14;
      const C = 2 * Math.PI * R;
      const left = Math.max(0, Math.min(1, (f.deadline - m.tick) / Math.max(1, f.deadline - f.tick)));
      g.appendChild(el("circle", { class: "clock-bg", r: R }));
      g.appendChild(el("circle", { class: "clock-fg", r: R, "stroke-dasharray": `${(C * left).toFixed(1)} ${C.toFixed(1)}`, transform: "rotate(-90)" }));
      g.appendChild(el("rect", { class: "core", x: -8, y: -8, width: 16, height: 16, rx: 3, transform: "rotate(45)" }));
      g.appendChild(el("text", { y: 3.8 }, String(id)));
    }
    layers.survivors.appendChild(g);
  }

  // Ghosts show their last stated intent: a dotted track to their target.
  layers.intent.replaceChildren();
  for (const a of m.actors) {
    if (a.online || a.target === undefined) continue;
    const t = found.get(a.target);
    if (!t) continue;
    layers.intent.appendChild(el("line", { x1: cx(a.pos), y1: cy(a.pos), x2: cx(t.pos), y2: cy(t.pos), class: "m-intent", "marker-end": "url(#arrow)" }));
  }

  // Wrecks: a red tag until a drone has read them, and the recovery flight.
  const downs = new Map<ActorId, { pos: Pos; tick: number }>();
  const recovered = new Map<ActorId, { by: ActorId }>();
  for (const a of m.actors) {
    for (const [id, d] of Object.entries(a.k.down ?? {})) if (d) downs.set(id as ActorId, d);
    for (const [id, r] of Object.entries(a.k.recovered ?? {})) if (r) recovered.set(id as ActorId, r);
  }
  for (const [id, d] of downs) {
    const rec = recovered.get(id);
    const text = rec ? `${id} reports recovered by ${rec.by}` : `${id} down at ${ref(d.pos)}`;
    const w = text.length * 6.6 + 22;
    const x = Math.min(Math.max(cx(d.pos) - w / 2, 0), world.size * CELL - w);
    const y = Math.min(cy(d.pos) + 24, world.size * CELL - 28);
    const label = el("g", { class: rec ? "m-wreck-label done" : "m-wreck-label" });
    label.appendChild(el("rect", { x, y, width: w, height: 24, rx: 12 }));
    label.appendChild(el("text", { x: x + 11, y: y + 16.5 }, text));
    layers.labels.appendChild(label);
    if (!rec) {
      for (const a of m.actors) {
        if (a.mode !== "recover" || !a.online) continue;
        layers.intent.appendChild(el("line", { x1: cx(a.pos), y1: cy(a.pos), x2: cx(d.pos), y2: cy(d.pos), class: "m-recover", "marker-end": "url(#arrow-red)" }));
      }
    }
  }
}

// ---------- contact strips ----------
function contactOf(a: ObservedActor | undefined, m: Observe): Contact {
  // The phone runs one actor, so when HQ loses it, it is alone, not a team.
  if (!a) return "absent";
  if (a.crashedAt !== undefined) return "down";
  if (!a.online && a.device === "phone") return "alone";
  if (!a.online) return "dark";
  return m.links.some(([x, y]) => (x === a.id || y === a.id) && m.actors.find((o) => o.id === (x === a.id ? y : x))?.online) ? "linked" : "alone";
}

function recordHistory(m: Observe) {
  if (m.tick < 0) return;
  for (const id of ACTORS) {
    const h = history.get(id) ?? [];
    const c = contactOf(m.actors.find((a) => a.id === id), m);
    const t = missionNow(m.tick);
    const last = h.length ? h[h.length - 1] : c;
    while (h.length < t) h.push(last);
    h[t] = c;
    history.set(id, h);
  }
}

const STRIP: Record<Contact, string> = { linked: "#8fb0e8", alone: "#f4b6c2", dark: "#ffa62b", absent: "transparent", down: "#ff5d71" };

function stripSvg(h: Contact[], tick: number) {
  const T = CONFIG.missionTicks;
  let out = `<svg class="strip" viewBox="0 0 ${T} 10" preserveAspectRatio="none" aria-hidden="true"><rect width="${T}" height="10" rx="5" fill="rgba(150,178,235,.12)"/>`;
  for (let i = 0; i < h.length; ) {
    let j = i;
    while (j < h.length && h[j] === h[i]) j++;
    out += `<rect x="${i}" y="0" width="${j - i}" height="10" fill="${STRIP[h[i]]}"/>`;
    i = j;
  }
  if (tick >= 0 && tick < T) out += `<rect x="${tick}" y="0" width=".7" height="10" fill="#eef2fb"/>`;
  return out + "</svg>";
}

function runLength(h: Contact[], c: Contact): number {
  let n = 0;
  for (let i = h.length - 1; i >= 0 && h[i] === c; i--) n++;
  return n;
}

function drawRows(m: Observe) {
  $("rows").innerHTML = ACTORS.map((id) => {
    const a = m.actors.find((x) => x.id === id);
    const h = history.get(id) ?? [];
    const c = h.length ? h[h.length - 1] : contactOf(a, m);
    // Cut-off time comes from the same clock as the band and map label.
    const since = a && !a.online ? darkSince.get(DEVICE_OF[id]) : undefined;
    const secs = since !== undefined ? Math.max(0, missionNow(m.tick) - since) : runLength(h, c);
    const state =
      m.tick < 0 ? ""
      : c === "linked" ? "linked"
      : c === "absent" ? "not joined"
      : c === "down" ? `crashed t${a!.crashedAt}`
      : `${c} ${secs}s`;
    // Operator control: crash a drone HQ can still reach.
    const crashBtn = id.startsWith("S") && a && a.online && c !== "down" && m.tick >= 0 && m.tick < CONFIG.missionTicks - 1
      ? `<button class="crash" type="button" data-actor="${id}" aria-label="Crash ${ROLE[id]}">Crash</button>`
      : "";
    const reason = a?.reason ?? "";
    const parts = reason.match(/^(Gemini|Rules \(no Gemini\)|Rules): (.*)$/);
    const body = parts ? `<em class="${parts[1] === "Gemini" ? "gemini" : ""}">${esc(parts[1])}</em>${esc(parts[2])}` : esc(reason || "Waiting for the mission");
    const stale = a && !a.online ? `Last heard t${a.tick}. ` : "";
    return `<div class="row">
      <div class="who"><span class="tag ${id.startsWith("R") ? "rescuer" : ""} ${c === "linked" ? "" : c}">${id}</span><span><b>${ROLE[id]}</b><small>${DEVICE_NAME[DEVICE_OF[id]]}${a ? ` · ${ref(a.pos)}` : ""}</small></span></div>
      ${stripSvg(h, m.tick)}
      <div class="state ${c === "linked" ? "" : c}"><span>${state}</span>${crashBtn}</div>
      <div class="reason">${esc(stale)}${body}</div>
    </div>`;
  }).join("");
}

// ---------- radio log ----------
function drawEvents(m: Observe) {
  const pos = new Map<number, Pos>();
  for (const a of m.actors) for (const [id, f] of Object.entries(a.k.found)) pos.set(+id, f.pos);
  const evs = m.events.filter((e) => e.type !== "expired").slice().sort((a, b) => b.arrived - a.arrived || b.tick - a.tick);

  const late = m.events.filter((e) => e.late && !seenLate.has(`${e.type}${e.survivor}${e.tick}`));
  if (late.length >= 2) lastBacklog = { team: TEAM[late[0].device], count: late.length, tick: m.tick };
  for (const e of late) seenLate.add(`${e.type}${e.survivor}${e.tick}`);

  const items: string[] = [];
  let backlogShown = false;
  for (const e of evs) {
    if (e.late && !backlogShown) {
      const n = evs.filter((x) => x.late && x.arrived === e.arrived).length;
      items.push(`<div class="backlog">${esc(TEAM[e.device])} backlog: ${n} reports written out of contact, delivered t${e.arrived}</div>`);
      backlogShown = true;
    }
    const p = pos.get(e.survivor);
    const actor = "actor" in e ? e.actor : "";
    const what =
      e.type === "found" ? `Found survivor ${e.survivor}`
      : e.type === "rescued" ? `Rescued survivor ${e.survivor}`
      : e.type === "conflict" ? `Yields survivor ${e.survivor} to ${e.winner}`
      : e.type === "down" ? "Mayday: crashed"
      : e.type === "recovered"
        ? e.reports > 0
          ? `Recovered ${e.reports} survivor ${e.reports === 1 ? "report" : "reports"} from ${e.from}'s wreck, took over its sector`
          : `Reached ${e.from}'s wreck (no survivor reports on it), took over its sector`
      : `Wasted trip to survivor ${e.survivor}`;
    if (e.type === "down") pos.set(0, e.pos);
    items.push(`<div class="ev ${e.type} ${e.late ? "late" : ""}"><span class="t">t${e.tick}</span><span class="a">${actor}</span><span class="what">${what}</span><span class="ref">${p ? ref(p) : ""}</span>${
      e.late ? `<span class="late-tag">written t${e.tick}, delivered t${e.arrived}</span>` : ""
    }</div>`);
  }
  $("events").innerHTML = items.length ? items.join("") : `<p class="empty">Nothing reported yet. Scouts call in survivors as they find them.</p>`;
  $("log-count").textContent = evs.length ? String(evs.length) : "";
}

function drawOrders(m: Observe) {
  $("panel-orders").innerHTML = m.plan
    ? `<p class="commander">${esc(m.plan.commander)}</p><dl>${ACTORS.map((id) => `<dt>${id}</dt><dd>${esc(m.plan!.intents[id] ?? "")}</dd>`).join("")}</dl>
       <p class="src">Written by gemini-4-argon before the mission. Gemini reads them when choosing; behaviour while cut off comes from each actor's rules.</p>`
    : `<p class="empty">No standing orders loaded. Run node scripts/plan.ts ${seed} on Laptop A.</p>`;
}

// ---------- situation band ----------
// A crash outranks everything but the end: who went down, who is recovering it.
function crashBand(m: Observe, set: (cls: string, head: string, sub: string) => void): boolean {
  const downs = new Map<ActorId, { pos: Pos; tick: number }>();
  const recovered = new Map<ActorId, { tick: number; by: ActorId }>();
  for (const a of m.actors) {
    for (const [id, d] of Object.entries(a.k.down ?? {})) if (d) downs.set(id as ActorId, d);
    for (const [id, r] of Object.entries(a.k.recovered ?? {})) if (r) recovered.set(id as ActorId, r);
  }
  const now = missionNow(m.tick);
  for (const [id, d] of downs) {
    const rec = recovered.get(id);
    if (!rec) {
      const helper = m.actors.find((a) => a.mode === "recover" && a.online);
      set(
        "down",
        `${ROLE[id]} crashed at ${ref(d.pos)}.`,
        helper ? `${ROLE[helper.id]} is flying to the wreck to pick up its survivor reports, then it takes over the sector.` : "Its partner heard the mayday and is on its way to the wreck.",
      );
      return true;
    }
    if (now - rec.tick <= 6) {
      const reports = Object.values(m.actors.find((a) => a.id === rec.by)?.k.found ?? {}).filter((f) => f.by === id).length;
      set(
        "back",
        `${ROLE[rec.by]} reached ${ROLE[id]}'s wreck.`,
        reports > 0
          ? `${reports} survivor ${reports === 1 ? "report" : "reports"} recovered and handed on to the rescue boats. ${ROLE[rec.by]} now covers both sectors.`
          : `No survivor reports were stranded on it. ${ROLE[rec.by]} now covers both sectors.`,
      );
      return true;
    }
  }
  return false;
}
let baseline: { condition: string; meanPct: number }[] | null = null;
fetch("/baseline.json").then((r) => (r.ok ? r.json() : null)).then((j) => (baseline = j?.conditions ?? null)).catch(() => {});

function drawBand(m: Observe) {
  const set = (cls: string, head: string, sub: string) => {
    $("band").className = `band ${cls}`;
    if ($("headline").textContent !== head) $("headline").textContent = head;
    if ($("subline").textContent !== sub) $("subline").textContent = sub;
  };
  const dark = devices.filter((d) => !d.online && d.device !== "A" && joined.has(d.device));
  if (m.tick < 0) {
    set("", "Ready. Six actors, one goal.", "Reach every survivor before their deadline, whatever happens to the network.");
  } else if (m.tick >= CONFIG.missionTicks - 1) {
    set("done", `Mission complete. ${m.score.reached} of ${m.score.total} survivors reached.`, `${m.score.lost} not reached. Average over 50 maps with the same failures:`);
    if (baseline) {
      const names: Record<string, string> = { mesh: "Blackout", central: "Central control", independent: "No sharing" };
      $("results").innerHTML = ["mesh", "central", "independent"]
        .map((c) => baseline!.find((b) => b.condition === c))
        .filter((b): b is { condition: string; meanPct: number } => !!b)
        .map((b) => `<div class="result ${b.condition === "mesh" ? "ours" : ""}"><span>${names[b.condition]}</span><span class="track"><span class="fill" style="width:${b.meanPct}%"></span></span><b>${Math.round(b.meanPct)}%</b></div>`)
        .join("");
    }
  } else if (crashBand(m, set)) {
    // set by crashBand
  } else if (dark.length > 0) {
    const now = missionNow(m.tick);
    const parts = dark.map((d) => `${TEAM[d.device]} dark ${Math.max(0, now - (darkSince.get(d.device) ?? now))}s`);
    const onlyPhone = dark.length === 1 && dark[0].device === "phone";
    set(
      onlyPhone ? "alone" : "dark",
      `${parts.join(" · ")}. Still working.`,
      onlyPhone ? "No radio, no Gemini. Scout 4 keeps sweeping on its standing orders and reports when it is back." : "HQ shows their last report. They keep sweeping and rescuing on standing orders, without Gemini.",
    );
  } else if (lastBacklog && m.tick - lastBacklog.tick <= 6) {
    set("back", `${lastBacklog.team} back. ${lastBacklog.count} reports delivered late.`, "Merged into everyone's picture. Claim conflicts settle on the earliest arrival.");
  } else if (m.cuts.length > 0) {
    set("cut", `${m.cuts.length} radio ${m.cuts.length === 1 ? "link" : "links"} cut. Messages route around.`, "Each actor passes what it knows to whoever is in range, so news still reaches the team.");
  } else {
    set("", `All teams in contact. ${m.score.reached} reached so far.`, "Scouts find survivors, rescuers reach them. Every decision is made on the device.");
  }
}

// ---------- shell ----------
function drawShell(m: Observe) {
  $("tick").textContent = m.tick >= 0 ? `t${Math.min(m.tick, CONFIG.missionTicks)}` : "t–";
  // Only what HQ knows: survivors reported so far, not the map's true total.
  const found = new Set<number>();
  for (const a of m.actors) for (const id of Object.keys(a.k.found)) found.add(+id);
  $("reached").textContent = String(m.score.reached);
  $("lost").textContent = String(m.score.lost);
  $("found").textContent = String(found.size);
  const g = m.gemini;
  $("gemini").className = `chip ${g.state === "ok" ? "ok" : g.state === "error" ? "bad" : ""}`;
  $("gemini").innerHTML = `<i></i>${g.state === "ok" ? `Gemini · ${g.calls}` : g.state === "error" ? "Gemini off" : "Gemini"}`;
  const n = m.n8n;
  $("n8n").className = `chip ${n.state === "ok" ? "ok" : n.state === "off" ? "" : "warn"}`;
  $("n8n").innerHTML = `<i></i>${
    n.state === "off" ? "n8n off"
    : n.state === "blocked" ? `n8n cut · ${n.queued} held`
    : n.state === "down" ? `n8n unreachable · ${n.queued} held`
    : `n8n · ${n.sent} sent`
  }`;
  $("n8n-toggle").textContent = n.state === "blocked" ? "Restore n8n" : "Cut n8n";
  // Browsers only play sound after a click, so a silent radio must be obvious.
  if (!radio && !$("radio").hasAttribute("disabled")) {
    const running = m.tick >= 0 && m.tick < CONFIG.missionTicks;
    $("radio").classList.toggle("attention", running);
    $("radio").textContent = running ? "Radio is off" : "Turn on radio";
  }
  $("n8n-toggle").toggleAttribute("disabled", n.state === "off");
}

function onStatus(m: Status) {
  devices = m.devices;
  if (m.started && m.started.seed !== seed) {
    seed = m.started.seed;
    world = generateWorld(seed);
    buildMap(world);
  }
  for (const d of m.devices) {
    if (!d.online && !darkSince.has(d.device) && lastTick >= 0 && joined.has(d.device)) darkSince.set(d.device, missionNow(lastTick));
    if (d.online) darkSince.delete(d.device);
  }
  $("start").textContent = m.started ? "Restart" : "Start mission";
}

function onObserve(m: Observe) {
  if (m.tick < lastTick - 5) {
    // A new mission started: forget the old one.
    history = new Map();
    seenLate = new Set();
    lastBacklog = null;
    darkSince = new Map();
    joined = new Set();
    shown.clear();
  }
  for (const a of m.actors) joined.add(a.device);
  lastTick = m.tick;
  recordHistory(m);
  drawShell(m);
  drawMap(m);
  drawRows(m);
  drawEvents(m);
  drawOrders(m);
  drawBand(m);
}

// ---------- controls ----------
let radio: HqRadio | null = null;
$("radio").onclick = async () => {
  const ctx = new AudioContext();
  await ctx.resume();
  const r = new HqRadio(ctx);
  $("radio").textContent = "Loading voices";
  $("radio").classList.remove("attention");
  $("radio").setAttribute("disabled", "");
  await r.preload();
  radio = r;
  (window as unknown as { hqRadio: HqRadio }).hqRadio = r; // inspectable from devtools
  $("radio").textContent = "Radio on";
};
$("n8n-toggle").onclick = () => void fetch("/api/n8n/toggle", { method: "POST" });
// Crash buttons live in rows that redraw every update, so listen on the list.
$("rows").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button.crash") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Crashing";
  void fetch("/api/crash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: btn.dataset.actor }) });
});
$("start").onclick = () => {
  if (lastTick >= 0 && lastTick < CONFIG.missionTicks - 1 && !confirm("Restart the mission from t0?")) return;
  void fetch("/api/start", { method: "POST" });
};
for (const [tab, panel] of [["tab-log", "panel-log"], ["tab-orders", "panel-orders"]] as const) {
  $(tab).onclick = () => {
    for (const [t, p] of [["tab-log", "panel-log"], ["tab-orders", "panel-orders"]] as const) {
      $(t).setAttribute("aria-selected", String(t === tab));
      $(p).hidden = p !== panel;
    }
  };
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", device: "dashboard" }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data) as FromHub;
    if (m.type === "status") {
      onStatus(m);
      radio?.onStatus(m);
    } else if (m.type === "observe") {
      onObserve(m);
      radio?.onObserve(m);
    }
  };
  ws.onclose = () => setTimeout(connect, 500);
}
connect();
