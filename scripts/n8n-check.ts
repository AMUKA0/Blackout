// Checks the deployed workflow and its webhook. Prints no secrets.
//   node --env-file-if-exists=.env.local scripts/n8n-check.ts
const u = (process.env.N8N_URL ?? "").trim().replace(/\/+$/, "");
const base = u && !/^https?:\/\//.test(u) ? `https://${u}` : u;
const key = (process.env.N8N_API_KEY ?? "").trim();
const h = { "X-N8N-API-KEY": key, accept: "application/json" };

const list = (await (await fetch(`${base}/api/v1/workflows?name=${encodeURIComponent("Blackout HQ link")}`, { headers: h })).json()) as {
  data: { id: string; name: string; active: boolean; nodes: { name: string; type: string; webhookId?: string; parameters: { path?: string } }[] }[];
};
for (const w of list.data) {
  const hook = w.nodes.find((n) => n.type === "n8n-nodes-base.webhook");
  console.log(`workflow ${w.id} "${w.name}" active=${w.active} webhook path=${hook?.parameters.path}`);
}

for (const path of ["webhook/blackout", "webhook-test/blackout"]) {
  const r = await fetch(`${base}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "events", tick: 0, seq: 0, heldMs: 0, backlog: 0, discord: "", lateCount: 0, lateFrom: [], events: [{ tick: 0, type: "found", actor: "S1", survivor: 0, text: "check" }] }),
  });
  console.log(`POST /${path}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
}

const ex = (await (await fetch(`${base}/api/v1/executions?limit=5`, { headers: h })).json()) as { data?: { id: string; workflowId: string; status: string; startedAt: string }[] };
console.log("recent executions:", (ex.data ?? []).map((e) => `${e.id} ${e.status} ${e.startedAt}`).join(" | ") || "none");
