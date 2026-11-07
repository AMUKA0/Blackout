import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import type { ActorId } from "../shared/types.ts";

// Gemini on Laptop A (the only machine with the Google login). Other devices
// reach it through the hub, so a device that is cut off loses Gemini too and
// falls back to its rules. Gemini only ever chooses among options the rules
// already judged feasible.

export const FLASH = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
export const ARGON = process.env.ARGON_MODEL ?? "gemini-4-argon";

export type DecideRequest = {
  actor: ActorId;
  tick: number;
  intent?: string;
  pos: { x: number; y: number };
  candidates: { survivor: number; eta: number; slack: number; pos: { x: number; y: number } }[];
  others: { id: ActorId; pos: { x: number; y: number }; target?: number; ageTicks: number }[];
};
export type DecideResponse = { survivor: number; reason: string; ms: number };

let ai: GoogleGenAI | null = null;
export const geminiStatus = { state: "unknown" as "ok" | "error" | "off" | "unknown", lastError: "", calls: 0, failures: 0 };

function client(): GoogleGenAI | null {
  if (ai) return ai;
  if (!process.env.GOOGLE_CLOUD_PROJECT && !process.env.GEMINI_API_KEY) {
    geminiStatus.state = "off";
    geminiStatus.lastError = "No GOOGLE_CLOUD_PROJECT in this terminal. Open a new terminal.";
    return null;
  }
  ai = new GoogleGenAI({});
  return ai;
}

const DECIDE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    survivor: { type: Type.INTEGER, description: "id of the chosen survivor, must be one of the candidates" },
    reason: { type: Type.STRING, description: "why, at most 12 words, plain English" },
  },
  required: ["survivor", "reason"],
};

export async function decide(req: DecideRequest, timeoutMs = 3000): Promise<DecideResponse> {
  const c = client();
  if (!c) throw new Error(geminiStatus.lastError);
  const t0 = Date.now();
  geminiStatus.calls++;
  const prompt = [
    `You are ${req.actor}, a rescue team in a flooded city. The network is unreliable, so you decide for yourself.`,
    req.intent ? `Your standing orders: ${req.intent}` : "",
    `Shared goal: the most survivors reached before their deadline across the whole team.`,
    `Tick ${req.tick}. You are at (${req.pos.x},${req.pos.y}). You move 1 tile per tick and need 3 ticks on site.`,
    `Survivors you could reach in time (slack = ticks to spare):`,
    ...req.candidates.map((x) => `- survivor ${x.survivor} at (${x.pos.x},${x.pos.y}), arrive in ${x.eta - req.tick} ticks, slack ${x.slack}`),
    `Other actors as you last heard them:`,
    ...req.others.map((o) => `- ${o.id} at (${o.pos.x},${o.pos.y})${o.target ? ` heading to survivor ${o.target}` : ""}, ${o.ageTicks} ticks old`),
    `Pick one survivor. Prefer the one only you can save in time; leave ones another rescuer is closer to. Reply as JSON.`,
  ]
    .filter(Boolean)
    .join("\n");

  const call = c.models.generateContent({
    model: FLASH,
    contents: prompt,
    // Minimal thinking: ~1.5s instead of 2.5-7s, same choices in testing.
    config: {
      responseMimeType: "application/json",
      responseSchema: DECIDE_SCHEMA,
      maxOutputTokens: 1024,
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  });
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs));
  try {
    const r = await Promise.race([call, timeout]);
    const parsed = JSON.parse(r.text ?? "{}") as { survivor?: number; reason?: string };
    if (!req.candidates.some((x) => x.survivor === parsed.survivor)) throw new Error(`invalid choice ${parsed.survivor}`);
    geminiStatus.state = "ok";
    return { survivor: parsed.survivor!, reason: (parsed.reason ?? "").split(/\s+/).slice(0, 14).join(" "), ms: Date.now() - t0 };
  } catch (e) {
    geminiStatus.failures++;
    geminiStatus.state = "error";
    geminiStatus.lastError = (e as Error).message.slice(0, 160);
    throw e;
  }
}

// Argon writes each actor's standing orders before the mission. Cached to
// plans/plan-<seed>.json so the demo never waits on it.
export type Plan = { seed: number; model: string; commander: string; intents: Record<ActorId, string> };

export async function writePlan(seed: number, worldSummary: string): Promise<Plan> {
  const c = client();
  if (!c) throw new Error(geminiStatus.lastError);
  const ids: ActorId[] = ["S1", "S2", "S3", "S4", "R1", "R2"];
  const schema = {
    type: Type.OBJECT,
    properties: {
      commander: { type: Type.STRING, description: "one sentence mission intent for the whole team" },
      intents: {
        type: Type.OBJECT,
        properties: Object.fromEntries(ids.map((id) => [id, { type: Type.STRING, description: `standing orders for ${id}, max 20 words` }])),
        required: ids,
      },
    },
    required: ["commander", "intents"],
  };
  const prompt = [
    "You are the mission commander for a flood rescue. Write standing orders that each actor can follow alone when the network fails.",
    "Actors: scouts S1 (NW quadrant), S2 (NE), S3 (SW), S4 (SE, works alone most often) fly fast and find survivors but cannot rescue.",
    "Rescuers R1 (west half) and R2 (east half) walk, avoid water, and extract survivors in 3 ticks.",
    "Expect: Laptop B's team (S2, S3, R2) loses contact mid-mission; S4 goes fully dark for a while.",
    "Orders must say what to do when cut off: keep sweeping, who to carry news to, when to return toward base to reconnect.",
    worldSummary,
  ].join("\n");
  const r = await c.models.generateContent({
    model: ARGON,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: 4096 },
  });
  const p = JSON.parse(r.text ?? "{}") as Omit<Plan, "seed" | "model">;
  return { seed, model: ARGON, ...p };
}
