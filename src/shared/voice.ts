import type { ActorId } from "./types.ts";

// What the radio can say. Clips are pre-rendered by scripts/voices.ts into
// public/audio/<speaker>/<clip>.mp3 so playback needs no network.

export type Speaker = ActorId | "HQ";

export const VOICES: Record<Speaker, { id: string; name: string }> = {
  HQ: { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" },
  S1: { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie" },
  S2: { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice" },
  S3: { id: "SOYHLrjzK2X1ezoPC6cr", name: "Harry" },
  S4: { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica" },
  R1: { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },
  R2: { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
};

export const CALLSIGNS: Record<ActorId, string> = {
  S1: "Scout One.", S2: "Scout Two.", S3: "Scout Three.", S4: "Scout Four.", R1: "Rescue One.", R2: "Rescue Two.",
};

// Phrases every actor can say, followed by a survivor number where marked.
export const ACTOR_PHRASES = {
  found: "Found survivor",
  rescued: "Survivor extracted. Number",
  yield: "Yielding survivor",
  wasted: "Arrived, already taken. Survivor",
  lost: "Lost contact. Continuing on my own.",
  back: "Back in contact. Sending what I've got.",
  mule: "Carrying news to rescue.",
} as const;
export type ActorPhrase = keyof typeof ACTOR_PHRASES;
export const NEEDS_NUMBER: ActorPhrase[] = ["found", "rescued", "yield", "wasted"];

export const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

export const HQ_LINES = {
  start: "Mission start. Six actors, one goal. Reach every survivor in time.",
  lostB: "Lost contact with the Laptop B team.",
  backB: "Laptop B team back in range. Receiving their backlog.",
  lostPhone: "Scout Four has gone dark.",
  backPhone: "Scout Four is back.",
  rulesOnly: "Gemini unreachable. Actors running on rules.",
  done: "Mission complete.",
} as const;
export type HqLine = keyof typeof HQ_LINES;

export const clipUrl = (speaker: Speaker, clip: string) => `/audio/${speaker}/${clip}.mp3`;

// The closing line, one clip per possible count, so it plays the moment the
// mission ends instead of being stitched together.
export function resultText(reached: number, total: number): string {
  const word = (n: number) => (n === 0 ? "None" : NUMBERS[n - 1][0].toUpperCase() + NUMBERS[n - 1].slice(1));
  return reached === total
    ? `Mission complete. All ${NUMBERS[total - 1]} survivors reached.`
    : `Mission complete. ${word(reached)} of ${NUMBERS[total - 1]} survivors reached.`;
}
export const resultClip = (reached: number) => clipUrl("HQ", `result-${reached}`);

// The clip sequence for one radio call.
export function callClips(actor: ActorId, phrase: ActorPhrase, survivor?: number): string[] {
  const clips = [clipUrl(actor, "callsign"), clipUrl(actor, phrase)];
  if (NEEDS_NUMBER.includes(phrase) && survivor) clips.push(clipUrl(actor, `n${survivor}`));
  return clips;
}
