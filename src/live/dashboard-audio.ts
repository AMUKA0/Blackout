import { CONFIG } from "../shared/config.ts";
import { ACTOR_PHRASES, CALLSIGNS, HQ_LINES, NUMBERS, callClips, clipUrl, type ActorPhrase } from "../shared/voice.ts";
import type { ActorId, DeviceId } from "../shared/types.ts";
import type { FromHub } from "../net/protocol.ts";
import { Radio } from "./radio.ts";

// Turns what reaches HQ into radio traffic on Laptop A's speakers. Calls from
// a cut-off team arrive late, in a burst, when it comes back in range.

type Observe = Extract<FromHub, { type: "observe" }>;
type Status = Extract<FromHub, { type: "status" }>;

const PHRASE: Partial<Record<string, ActorPhrase>> = { found: "found", rescued: "rescued", conflict: "yield", wasted: "wasted" };

export class HqRadio {
  radio: Radio;
  private heard = new Set<string>();
  private primed = false;
  private online = new Map<DeviceId, boolean>();
  private geminiAnnounced = false;
  private lastTick = -1;

  constructor(ctx: AudioContext) {
    this.radio = new Radio(ctx);
  }

  async preload() {
    const urls = ["/audio/fx/static.mp3", "/audio/fx/static-long.mp3", ...Object.keys(HQ_LINES).map((l) => clipUrl("HQ", l))];
    for (const a of Object.keys(CALLSIGNS) as ActorId[]) {
      urls.push(clipUrl(a, "callsign"), ...Object.keys(ACTOR_PHRASES).map((p) => clipUrl(a, p)), ...NUMBERS.map((_, i) => clipUrl(a, `n${i + 1}`)));
    }
    await this.radio.preload(urls);
  }

  hq(line: keyof typeof HQ_LINES) {
    this.radio.say([clipUrl("HQ", line)], true);
  }

  onStatus(m: Status) {
    for (const d of m.devices) {
      const before = this.online.get(d.device);
      this.online.set(d.device, d.online);
      if (before === undefined || before === d.online || !m.started) continue;
      if (d.device === "B") this.hq(d.online ? "backB" : "lostB");
      if (d.device === "phone") this.hq(d.online ? "backPhone" : "lostPhone");
    }
  }

  onObserve(m: Observe) {
    if (m.tick >= 0 && this.lastTick < 0) this.hq("start");
    if (m.tick >= CONFIG.missionTicks - 1 && this.lastTick < CONFIG.missionTicks - 1) this.hq("done");
    this.lastTick = m.tick;
    if (m.gemini.state === "error" && !this.geminiAnnounced) {
      this.geminiAnnounced = true;
      this.hq("rulesOnly");
    }

    const fresh = m.events.filter((e) => {
      const key = `${e.type}:${"actor" in e ? e.actor : ""}:${e.survivor}:${e.tick}`;
      if (this.heard.has(key)) return false;
      this.heard.add(key);
      return true;
    });
    if (!this.primed) {
      this.primed = true; // a reloaded page shouldn't replay history
      return;
    }
    // Late reports first get a short summary, then the most important few.
    const late = fresh.filter((e) => e.late);
    const live = fresh.filter((e) => !e.late);
    const important = (e: (typeof fresh)[number]) => (e.type === "rescued" ? 0 : e.type === "conflict" ? 1 : e.type === "wasted" ? 2 : 3);
    for (const e of [...late.sort((a, b) => important(a) - important(b)).slice(0, 3), ...live]) {
      const phrase = PHRASE[e.type];
      if (!phrase || !("actor" in e)) continue;
      this.radio.say(callClips(e.actor, phrase, e.survivor));
    }
  }
}
