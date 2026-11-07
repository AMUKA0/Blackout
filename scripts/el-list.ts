// Lists ElevenLabs voices and TTS models available to the key. Prints no secrets.
// Run: node --env-file=.env.local scripts/el-list.ts
const key = (process.env.ELEVENLABS_API_KEY ?? "").trim();
const h = { "xi-api-key": key };

const voices = (await (await fetch("https://api.elevenlabs.io/v1/voices", { headers: h })).json()) as {
  voices: { voice_id: string; name: string; labels?: Record<string, string> }[];
};
for (const v of voices.voices) {
  const l = v.labels ?? {};
  console.log(`${v.voice_id}  ${v.name.padEnd(28)} ${[l.gender, l.age, l.accent, l.description ?? l.descriptive, l.use_case].filter(Boolean).join(", ")}`);
}

const models = (await (await fetch("https://api.elevenlabs.io/v1/models", { headers: h })).json()) as {
  model_id: string; name: string; can_do_text_to_speech?: boolean;
}[];
console.log("\nTTS models:");
for (const m of models) if (m.can_do_text_to_speech) console.log(`  ${m.model_id}  ${m.name}`);
