import { CONFIG } from "../shared/config.ts";
import { initialState, type ActorState, type Candidate } from "../shared/brain.ts";
import { DEMO_FAULTS } from "../shared/faults.ts";
import { emptyKnowledge, merge, type Knowledge } from "../shared/knowledge.ts";
import { actActor, expireSurvivors, newTruth, revealSurvivors, senseActor, type StepEvent, type TruthMap } from "../shared/step.ts";
import { generateWorld } from "../shared/world.ts";
import type { ActorId, DeviceId, World } from "../shared/types.ts";
import type { BeaconActor, FromHub, ToHub } from "../net/protocol.ts";
import type { HubClient } from "./client.ts";

// Runs this device's actors in real time. Same per-actor logic as the
// simulator. Knowledge from other devices only arrives through relays, which
// the hub only delivers between actors in radio range.

export type NodeLog = { tick: number; text: string };

type GeminiSlot = {
  pending: boolean;
  sig: string;
  down?: boolean;
  answer?: { survivor: number; reason: string; tick: number };
  chosen?: number;
  chosenReason?: string;
};

export class LiveNode {
  world: World;
  actors: ActorState[];
  truth: TruthMap;
  lastTick = -1;
  log: NodeLog[] = [];
  reasons = new Map<ActorId, string>();
  private inbox: { from: ActorId; to: ActorId[]; k: Knowledge; tick: number }[] = [];
  private heardFrom = new Map<ActorId, Map<ActorId, number>>(); // to -> from -> tick
  private pendingEvents: StepEvent[] = [];
  private pendingTruth: ToHub[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly device: DeviceId;
  private client: HubClient;
  private opts: { manualRadio: boolean; onEvent?: (e: StepEvent) => void; onTick?: (t: number) => void };

  constructor(
    device: DeviceId,
    client: HubClient,
    seed: number,
    opts: { manualRadio: boolean; onEvent?: (e: StepEvent) => void; onTick?: (t: number) => void } = { manualRadio: false },
  ) {
    this.device = device;
    this.client = client;
    this.opts = opts;
    this.world = generateWorld(seed);
    this.actors = this.world.actors.filter((a) => a.device === device).map((spec) => initialState(spec, emptyKnowledge()));
    this.truth = newTruth(this.world);
    client.onMessage = (m) => this.receive(m);
  }

  start() {
    this.timer = setInterval(() => {
      const now = this.client.tick();
      while (this.lastTick < now && this.lastTick < CONFIG.missionTicks - 1) this.step(this.lastTick + 1);
    }, 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private receive(m: FromHub) {
    if (m.type === "relay") this.inbox.push(m);
    else if (m.type === "truth") {
      const t = this.truth.get(m.survivor);
      if (t && t.status !== "rescued") Object.assign(t, { status: "rescued", by: m.by, done: m.tick });
    }
  }

  private note(tick: number, text: string) {
    this.log.push({ tick, text });
    if (this.log.length > 200) this.log.shift();
  }

  isolated(id: ActorId, tick: number): boolean {
    const local = this.actors.length > 1;
    if (local) return false;
    const heard = this.heardFrom.get(id);
    return ![...(heard?.values() ?? [])].some((t) => tick - t <= 2);
  }

  step(tick: number) {
    this.lastTick = tick;

    // Scripted radio faults for this device. The phone's radio is the real
    // airplane-mode toggle, so its scripted entries are ignored.
    if (!this.opts.manualRadio) {
      for (const f of DEMO_FAULTS) {
        if (f.tick === tick && "device" in f && f.device === this.device) {
          this.client.setRadio(f.kind === "radioOn");
          this.note(tick, f.kind === "radioOn" ? "Radio back on" : "Radio off, working alone");
        }
      }
    }

    revealSurvivors(this.world, this.truth, tick);
    const offline = !this.client.online;

    // 1. Knowledge that reached us over the air since last tick
    const inbox = this.inbox.splice(0);
    this.actors = this.actors.map((s) => {
      let k = s.k;
      for (const r of inbox) {
        if (!r.to.includes(s.spec.id)) continue;
        k = merge(k, r.k);
        let heard = this.heardFrom.get(s.spec.id);
        if (!heard) this.heardFrom.set(s.spec.id, (heard = new Map()));
        heard.set(r.from, tick);
      }
      return { ...s, k };
    });

    // 2. Sense
    this.actors = this.actors.map((s) => {
      const r = senseActor(this.world, this.truth, s, tick, offline);
      this.emit(r.events);
      return r.s;
    });

    // 3. Actors on this device always share (local hub)
    const snapshot = this.actors.map((s) => s.k);
    this.actors = this.actors.map((s) => ({ ...s, k: snapshot.reduce((a, b) => merge(a, b), s.k) }));

    // 4. Decide and act. Rescuers may take Gemini's pick among their top 3.
    this.actors = this.actors.map((s) => {
      const g = this.gemini.get(s.spec.id) ?? { pending: false, sig: "" };
      this.gemini.set(s.spec.id, g);
      const pick = s.spec.role === "rescuer" ? (c: Candidate[]) => this.pickWithGemini(s, tick, c, g) : undefined;
      const r = actActor(this.world, this.truth, s, tick, { isolated: this.isolated(s.spec.id, tick), offline, pick });
      this.emit(r.events);
      if (r.reason) {
        const viaGemini = g.chosen !== undefined && r.s.target === g.chosen;
        const label = s.spec.role === "scout" ? "" : viaGemini ? "Gemini: " : g.down || offline ? "Rules (no Gemini): " : "Rules: ";
        this.reasons.set(s.spec.id, label + (viaGemini ? g.chosenReason! : r.reason));
      }
      if (r.completed) this.pendingTruth.push({ type: "truth", ...r.completed });
      return r.s;
    });
    this.emit(expireSurvivors(this.world, this.truth, tick));

    // 5. Broadcast. Events and rescues queue up while offline and go out in a
    //    burst on reconnect.
    const beacon: BeaconActor[] = this.actors.map((s) => ({
      id: s.spec.id,
      pos: s.pos,
      mode: s.mode,
      target: s.target,
      reason: this.reasons.get(s.spec.id) ?? "",
      isolatedFor: s.isolatedFor,
      k: s.k,
    }));
    if (this.client.send({ type: "beacon", device: this.device, tick, actors: beacon, events: this.pendingEvents })) {
      this.pendingEvents = [];
      for (const t of this.pendingTruth.splice(0)) this.client.send(t);
    }
    this.opts.onTick?.(tick);
  }

  // Gemini runs asynchronously. The actor never waits: it keeps its rule
  // choice, and a valid answer that arrives within 4 ticks may redirect it.
  private gemini = new Map<ActorId, GeminiSlot>();

  private pickWithGemini(s: ActorState, tick: number, cands: Candidate[], g: GeminiSlot): number | undefined {
    const sig = cands.map((c) => c.survivor).join(",");
    if (sig !== g.sig && cands.length >= 2 && this.client.online && !g.pending) {
      g.sig = sig;
      g.pending = true;
      const others = (Object.entries(s.k.seen) as [ActorId, { pos: { x: number; y: number }; tick: number }][])
        .filter(([id]) => id !== s.spec.id)
        .map(([id, v]) => {
          const target = Object.entries(s.k.claims).find(([, byActor]) => byActor[id] && !byActor[id]!.released)?.[0];
          return { id, pos: v.pos, target: target ? +target : undefined, ageTicks: tick - v.tick };
        });
      const body = {
        actor: s.spec.id,
        tick,
        pos: s.pos,
        candidates: cands.map((c) => ({ ...c, pos: s.k.found[c.survivor].pos })),
        others,
      };
      fetch(`${this.client.httpBase}/api/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = (await r.json()) as { survivor: number; reason: string };
          g.answer = { survivor: d.survivor, reason: d.reason, tick };
          g.down = false;
        })
        .catch(() => (g.down = true))
        .finally(() => (g.pending = false));
    }
    const a = g.answer;
    if (a && tick - a.tick <= 4 && cands.some((c) => c.survivor === a.survivor)) {
      g.answer = undefined; // apply once, never thrash
      g.chosen = a.survivor;
      g.chosenReason = a.reason;
      this.note(tick, `${s.spec.id} Gemini picks survivor ${a.survivor}: ${a.reason}`);
      return a.survivor;
    }
    return undefined;
  }

  private emit(events: StepEvent[]) {
    for (const e of events) {
      this.pendingEvents.push(e);
      this.opts.onEvent?.(e);
      if (e.type === "found") this.note(e.tick, `${e.actor} found survivor ${e.survivor}`);
      else if (e.type === "rescued") this.note(e.tick, `${e.actor} rescued survivor ${e.survivor}`);
      else if (e.type === "conflict") this.note(e.tick, `${e.actor} yields survivor ${e.survivor} to ${e.winner}`);
      else if (e.type === "wasted") this.note(e.tick, `${e.actor} arrived, survivor ${e.survivor} already taken`);
    }
  }
}
