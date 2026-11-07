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
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes wake { to { stroke-dashoffset: -10; } }
@media (prefers-reduced-motion: reduce) { .craft-svg .blades, .craft-svg .wake { animation: none; } .craft-turn { transition: none; } }
`;
