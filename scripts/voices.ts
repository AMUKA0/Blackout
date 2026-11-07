// Pre-renders every radio clip with ElevenLabs into public/audio. Skips clips
// that already exist, so re-running only fills gaps. Run on Laptop A:
//   node --env-file=.env.local scripts/voices.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { ACTOR_PHRASES, CALLSIGNS, HQ_LINES, NUMBERS, VOICES, type Speaker } from "../src/shared/voice.ts";
import type { ActorId } from "../src/shared/types.ts";

const key = (process.env.ELEVENLABS_API_KEY ?? "").trim();
if (!key) throw new Error("ELEVENLABS_API_KEY missing in .env.local");
const MODELS = ["eleven_v4", "eleven_multilingual_v2"];

type Job = { speaker: Speaker; clip: string; text: string };
const jobs: Job[] = [];
for (const actor of Object.keys(CALLSIGNS) as ActorId[]) {
  jobs.push({ speaker: actor, clip: "callsign", text: CALLSIGNS[actor] });
  for (const [clip, text] of Object.entries(ACTOR_PHRASES)) jobs.push({ speaker: actor, clip, text });
  NUMBERS.forEach((n, i) => jobs.push({ speaker: actor, clip: `n${i + 1}`, text: `${n[0].toUpperCase()}${n.slice(1)}.` }));
}
for (const [clip, text] of Object.entries(HQ_LINES)) jobs.push({ speaker: "HQ", clip, text });

async function tts(job: Job): Promise<Buffer> {
  let last = "";
  for (const model of MODELS) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES[job.speaker].id}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: job.text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
    });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    last = `${model}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
  }
  throw new Error(last);
}

async function sfx(path: string, text: string, seconds: number) {
  if (existsSync(path)) return;
  const r = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: 0.6 }),
  });
  if (!r.ok) throw new Error(`sound effect: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  console.log(`made ${path}`);
}

const todo = jobs.filter((j) => !existsSync(`public/audio/${j.speaker}/${j.clip}.mp3`));
console.log(`${jobs.length} clips, ${todo.length} to render, ${todo.reduce((a, j) => a + j.text.length, 0)} characters`);
let failed = 0;
for (let i = 0; i < todo.length; i += 4) {
  await Promise.all(
    todo.slice(i, i + 4).map(async (j) => {
      try {
        const audio = await tts(j);
        mkdirSync(`public/audio/${j.speaker}`, { recursive: true });
        writeFileSync(`public/audio/${j.speaker}/${j.clip}.mp3`, audio);
      } catch (e) {
        failed++;
        console.log(`FAILED ${j.speaker}/${j.clip}: ${(e as Error).message}`);
      }
    }),
  );
  process.stdout.write(`\r${Math.min(i + 4, todo.length)}/${todo.length}`);
}
console.log("");
mkdirSync("public/audio/fx", { recursive: true });
await sfx("public/audio/fx/static.mp3", "Short burst of walkie-talkie radio static with a squelch click at the end", 0.8);
await sfx("public/audio/fx/static-long.mp3", "Crackling radio static, a channel cutting out, interference and dropouts", 2);
console.log(failed ? `${failed} clips failed` : "all clips rendered");
