// Checks .env.local values work. Never prints a value, only lengths and results.
// Run: node --env-file=.env.local scripts/check-env.ts

const env = (k: string) => (process.env[k] ?? "").trim();
const describe = (k: string) => {
  const v = env(k);
  return v ? `set (${v.length} chars)` : "EMPTY";
};

async function check(name: string, fn: () => Promise<string>) {
  try {
    console.log(`${name}: ${await fn()}`);
  } catch (e) {
    console.log(`${name}: FAILED (${e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, "<url>") : "error"})`);
  }
}

for (const k of ["ELEVENLABS_API_KEY", "N8N_URL", "DISCORD_WEBHOOK_URL"]) console.log(`${k}: ${describe(k)}`);

await check("ElevenLabs", async () => {
  if (!env("ELEVENLABS_API_KEY")) return "skipped";
  const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": env("ELEVENLABS_API_KEY") } });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { detail?: { status?: string; message?: string } };
    return `HTTP ${r.status} ${body.detail?.status ?? ""}: ${body.detail?.message ?? ""}`;
  }
  const j = (await r.json()) as { voices?: unknown[] };
  return `OK, ${j.voices?.length ?? 0} voices available`;
});

await check("n8n", async () => {
  if (!env("N8N_URL")) return "skipped";
  let base = env("N8N_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) base = `https://${base}`;
  const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
  return r.ok ? "OK, /healthz responded" : `HTTP ${r.status} from /healthz`;
});

await check("Discord webhook", async () => {
  if (!env("DISCORD_WEBHOOK_URL")) return "skipped";
  // GET returns the webhook's metadata and does not post anything.
  const r = await fetch(env("DISCORD_WEBHOOK_URL"));
  if (!r.ok) return `HTTP ${r.status}`;
  const j = (await r.json()) as { name?: string };
  return `OK, webhook named "${j.name ?? "?"}"`;
});
