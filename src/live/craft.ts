import type { ActorId, Pos } from "../shared/types.ts";

// Large top-down craft for the device screens: a quadcopter drone for scouts,
// a rescue boat for rescuers. Same shapes as the HQ map, drawn bigger, with
// spinning rotors and a wake so the screen shows the craft is moving.

export function craftSvg(id: ActorId): string {
  const drone = id.startsWith("S");
  const body = drone
    ? `${[[-21, -21], [21, -21], [-21, 21], [21, 21]]
        .map(
          ([x, y]) => `<line x1="0" y1="0" x2="${x}" y2="${y}" class="arm"/>
          <circle cx="${x}" cy="${y}" r="13" class="rotor"/>
          <g class="blades" style="transform-origin:${x}px ${y}px"><line x1="${x - 11}" y1="${y}" x2="${x + 11}" y2="${y}"/><line x1="${x}" y1="${y - 11}" x2="${x}" y2="${y + 11}"/></g>
          <circle cx="${x}" cy="${y}" r="2.6" class="hub"/>`,
        )
        .join("")}
       <circle r="15" class="hull"/>
       <path d="M-7 -21 0 -27 7 -21" class="nose"/>`
    : `<path d="M-6 44 L-9 60 M6 44 L9 60 M0 44 L0 64" class="wake"/>
       <path d="M0 -40 C17 -25 22 -8 22 13 L22 29 Q22 36 15 36 L-15 36 Q-22 36 -22 29 L-22 13 C-22 -8 -17 -25 0 -40 Z" class="hull"/>
       <path d="M0 -31 C12 -19 16 -6 16 12 L16 26 Q16 30 12 30 L-12 30 Q-16 30 -16 26 L-16 12 C-16 -6 -12 -19 0 -31 Z" class="gunwale"/>
       <rect x="-9" y="2" width="18" height="14" rx="3" class="cabin"/>`;
  return `<svg class="craft-svg" viewBox="-70 -70 140 140" role="img" aria-label="${drone ? "Drone" : "Rescue boat"} ${id}">
    <g class="craft-turn">${body}</g>
    <text y="${drone ? 1 : -8}" class="craft-id">${id}</text>
  </svg>`;
}

// A crashed drone: broken frame, snapped rotors, a red cross and rising smoke.
// Deliberately a different silhouette from a working or offline drone.
export function wreckSvg(id: ActorId): string {
  return `<svg class="craft-svg wreck-svg" viewBox="-70 -70 140 140" role="img" aria-label="Crashed drone ${id}">
    <g class="smoke"><circle cx="6" cy="-30" r="9"/><circle cx="-4" cy="-44" r="12"/><circle cx="8" cy="-58" r="15"/></g>
    <g class="debris" transform="rotate(-18)">
      <line x1="0" y1="0" x2="-21" y2="-21" class="arm"/><line x1="0" y1="0" x2="15" y2="-8" class="arm broken"/>
      <line x1="0" y1="0" x2="-14" y2="17" class="arm broken"/><line x1="0" y1="0" x2="21" y2="21" class="arm"/>
      <circle cx="-21" cy="-21" r="13" class="rotor broken"/><circle cx="21" cy="21" r="13" class="rotor broken"/>
      <path d="M26 -14 l9 -5 M-24 24 l-6 8 M30 2 l6 4" class="shard"/>
      <circle r="15" class="hull"/>
      <path d="M-7 -7 7 7 M7 -7 -7 7" class="cross"/>
    </g>
    <text y="34" class="craft-id wreck-id">${id} DOWN</text>
  </svg>`;
}

// The Blackout mark: three linked nodes, one link cut, the isolated node pink.
export const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true"><g fill="none" stroke-linecap="round">
  <path d="M7.2 19.6 12.8 9.6M8.6 21.4h4.2" stroke="#8fb0e8" stroke-width="2"/><path d="m17.2 19.2 2.6 2.6m0-2.6-2.6 2.6" stroke="#ff5d71" stroke-width="2"/>
  <circle cx="6" cy="21.4" r="3" fill="#eef2fb"/><circle cx="14" cy="7.4" r="3" fill="#eef2fb"/><circle cx="22.8" cy="21.4" r="3" fill="#f4b6c2"/></g></svg>`;

// Keeps a smoothed heading from position changes; holds it while stationary.
export class Heading {
  private last = new Map<string, Pos>();
  private deg = new Map<string, number>();
  update(id: string, pos: Pos): number {
    const prev = this.last.get(id);
    this.last.set(id, pos);
    const cur = this.deg.get(id) ?? 0;
    if (!prev || (prev.x === pos.x && prev.y === pos.y)) return cur;
    const want = (Math.atan2(pos.y - prev.y, pos.x - prev.x) * 180) / Math.PI + 90;
    // Turn the short way round.
    const next = cur + (((want - cur + 540) % 360) - 180);
    this.deg.set(id, next);
    return next;
  }
}

export const CRAFT_CSS = `
.craft-svg { width: 100%; height: 100%; overflow: visible; display: block; }
.craft-turn { transition: transform .8s cubic-bezier(.2,.8,.2,1); }
.craft-svg .arm { stroke: currentColor; stroke-width: 5; stroke-linecap: round; }
.craft-svg .rotor { fill: rgba(10,20,51,.35); stroke: var(--craft-accent, #8fb0e8); stroke-width: 2.4; }
.craft-svg .blades line { stroke: var(--craft-accent, #8fb0e8); stroke-width: 2.6; stroke-linecap: round; opacity: .85; }
.craft-svg .blades { animation: spin .35s linear infinite; }
.craft-svg .hub { fill: currentColor; }
.craft-svg .hull { fill: currentColor; }
.craft-svg .nose { fill: none; stroke: currentColor; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
.craft-svg .gunwale { fill: none; stroke: var(--craft-accent, #8fb0e8); stroke-width: 2; }
.craft-svg .cabin { fill: var(--craft-accent, #8fb0e8); opacity: .5; }
.craft-svg .wake { fill: none; stroke: var(--craft-accent, #8fb0e8); stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 3 7; animation: wake .6s linear infinite; opacity: .7; }
.craft-svg .craft-id { fill: var(--craft-ink, #0a1433); font: 800 15px "Barlow", system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
.craft-still .blades, .craft-still .wake { animation: none; }
.wreck-svg .smoke circle { fill: #8a92a8; opacity: 0; animation: smoke 2.4s ease-out infinite; }
.wreck-svg .smoke circle:nth-child(2) { animation-delay: .8s; } .wreck-svg .smoke circle:nth-child(3) { animation-delay: 1.6s; }
.wreck-svg .arm { stroke: #5a4650; stroke-width: 5; stroke-linecap: round; }
.wreck-svg .arm.broken { stroke-dasharray: 9 5; }
.wreck-svg .rotor { fill: none; stroke: #6d5a64; stroke-width: 2.4; }
.wreck-svg .rotor.broken { stroke-dasharray: 22 12; }
.wreck-svg .shard { stroke: #ff5d71; stroke-width: 2.4; stroke-linecap: round; }
.wreck-svg .hull { fill: #2a1a22; stroke: #ff5d71; stroke-width: 3; }
.wreck-svg .cross { stroke: #ff5d71; stroke-width: 3.5; stroke-linecap: round; }
.wreck-svg .wreck-id { fill: #ff5d71; font-size: 13px; letter-spacing: .06em; }
@keyframes smoke { 0% { opacity: 0; transform: translateY(14px) scale(.6); } 30% { opacity: .55; } 100% { opacity: 0; transform: translateY(-12px) scale(1.25); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes wake { to { stroke-dashoffset: -10; } }
@media (prefers-reduced-motion: reduce) { .craft-svg .blades, .craft-svg .wake, .wreck-svg .smoke circle { animation: none; } .wreck-svg .smoke circle { opacity: .35; } .craft-turn { transition: none; } }
`;
