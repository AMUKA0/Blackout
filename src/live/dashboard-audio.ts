import { CONFIG } from "../shared/config.ts";
import { ACTOR_PHRASES, CALLSIGNS, HQ_LINES, NUMBERS, callClips, clipUrl, resultClip, type ActorPhrase } from "../shared/voice.ts";
import type { ActorId, DeviceId } from "../shared/types.ts";
import type { FromHub } from "../net/protocol.ts";
import { Radio } from "./radio.ts";

// Turns what reaches HQ into radio traffic on Laptop A's speakers. Calls from
// a cut-off team arrive late, in a burst, when it comes back in range.

type Observe = Extract<FromHub, { type: "observe" }>;
type Status = Extract<FromHub, { type: "status" }>;

const PHRASE: Partial<Record<string, ActorPhrase>> = {
  found: "found",
  rescued: "rescued",
  conflict: "yield",
  wasted: "wasted",
  down: "mayday",
  recovered: "recovered",
};

export class HqRadio {
  radio: Radio;
  private heard = new Set<string>();
  private primed = false;
  private online = new Map<DeviceId, boolean>();
  private geminiAnnounced = false;
  private lastTick = -1;
  private finished = false;

  constructor(ctx: AudioContext) {
    this.radio = new Radio(ctx);
  }

  async preload() {
    const urls = [
      "/audio/fx/static.mp3",
      "/audio/fx/static-long.mp3",
      ...Object.keys(HQ_LINES).map((l) => clipUrl("HQ", l)),
      ...Array.from({ length: CONFIG.survivors + 1 }, (_, n) => resultClip(n)),
    ];
    for (const a of Object.keys(CALLSIGNS) as ActorId[]) {
      urls.push(clipUrl(a, "callsign"), ...Object.keys(ACTOR_PHRASES).map((p) => clipUrl(a, p)), ...NUMBERS.map((_, i) => clipUrl(a, `n${i + 1}`)));
    }
    await this.radio.preload(urls);
  }

  hq(line: keyof typeof HQ_LINES) {
    this.radio.say([clipUrl("HQ", line)], true);
  }

  onStatus(m: Status) {
    if (this.finished) return;
    for (const d of m.devices) {
      const before = this.online.get(d.device);
      this.online.set(d.device, d.online);
      if (before === undefined || before === d.online || !m.started) continue;
      if (d.device === "B") this.hq(d.online ? "backB" : "lostB");
      if (d.device === "phone") this.hq(d.online ? "backPhone" : "lostPhone");
    }
  }

  onObserve(m: Observe) {
    const last = CONFIG.missionTicks - 1;
    // A new mission (the clock jumped back, countdown included) reopens the
    // channel and forgets the last run's calls: same seed, same events.
    if (this.lastTick >= 0 && m.tick < this.lastTick - 5) {
      this.radio.reset();
      this.finished = false;
      this.geminiAnnounced = false;
      this.heard.clear();
      this.lastTick = -1;
    }
    // Radio switched on after a mission already ended: stay quiet.
    if (this.lastTick < 0 && m.tick >= last) {
      this.finished = true;
      this.lastTick = m.tick;
      return;
    }
    if (m.tick >= 0 && this.lastTick < 0) this.hq("start");
    if (this.finished) {
      this.lastTick = m.tick;
      return;
    }
    // The closing line ends the demo on time: it cuts in, then the radio is silent.
    if (m.tick >= last) {
      this.finished = true;
      this.lastTick = m.tick;
      this.radio.finish([resultClip(Math.min(m.score.reached, CONFIG.survivors))]);
      return;
    }
    // In the last few seconds, don't start calls the closing line would cut off.
    const quietEnd = m.tick >= last - 3;
    this.lastTick = m.tick;
    if (m.gemini.state === "error" && !this.geminiAnnounced && !quietEnd) {
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
    if (quietEnd) return;
    // Late reports first get a short summary, then the most important few.
    const late = fresh.filter((e) => e.late);
    const live = fresh.filter((e) => !e.late);
    const important = (e: (typeof fresh)[number]) => (e.type === "rescued" ? 0 : e.type === "conflict" ? 1 : e.type === "wasted" ? 2 : 3);
    // The backlog burst may wait longer (it follows the "back in range" line);
    // the closing line still cuts it off at the end of the mission.
    for (const e of late.sort((a, b) => important(a) - important(b)).slice(0, 3)) {
      const phrase = PHRASE[e.type];
      if (phrase && "actor" in e) this.radio.say(callClips(e.actor, phrase, e.survivor), false, 15000);
    }
    for (const e of live) {
      const phrase = PHRASE[e.type];
      if (!phrase || !("actor" in e)) continue;
      // A mayday jumps the queue, then HQ explains what happens next.
      if (e.type === "down") {
        this.radio.say(callClips(e.actor, phrase), true);
        this.radio.say([clipUrl("HQ", "droneDown")], false, 12000);
      } else if (e.type === "recovered") this.radio.say(callClips(e.actor, phrase), false, 12000);
      else this.radio.say(callClips(e.actor, phrase, e.survivor));
    }
  }
}
