// Times a realistic decide prompt across models and thinking settings.
//   node scripts/gemini-latency.ts
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";

const ai = new GoogleGenAI({});
const schema = {
  type: Type.OBJECT,
  properties: { survivor: { type: Type.INTEGER }, reason: { type: Type.STRING } },
  required: ["survivor", "reason"],
};
const prompt = `You are R1, a rescue team. Tick 40. You are at (4,8). Survivors you could reach in time:
- survivor 3 at (2,3), arrive in 5 ticks, slack 12
- survivor 7 at (6,13), arrive in 6 ticks, slack 4
- survivor 5 at (7,1), arrive in 7 ticks, slack 20
Other actors: R2 at (12,9) heading to survivor 9. Pick one survivor. Reply as JSON with survivor and a reason under 12 words.`;

const configs: [string, string, Record<string, unknown>][] = [
  ["gemini-3.6-flash", "default", {}],
  ["gemini-3.6-flash", "thinking low", { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }],
  ["gemini-3.6-flash", "thinking minimal", { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }],
  ["gemini-3.5-flash-lite", "default", {}],
  ["gemini-3.5-flash-lite", "thinking minimal", { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }],
];

for (const [model, label, extra] of configs) {
  const times: number[] = [];
  let out = "";
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const r = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: 1024, temperature: 0.2, ...extra },
      });
      times.push(Date.now() - t0);
      out = (r.text ?? "").replace(/\s+/g, " ").slice(0, 90);
    } catch (e) {
      out = `ERROR ${(e as Error).message.slice(0, 90)}`;
      break;
    }
  }
  console.log(`${model.padEnd(22)} ${label.padEnd(17)} ${times.map((t) => `${t}ms`).join(" ").padEnd(22)} ${out}`);
}
