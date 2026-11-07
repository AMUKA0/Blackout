// Builds the "Blackout HQ link" n8n workflow, writes n8n/blackout.workflow.json
// (importable by hand), and, if N8N_API_KEY is set, creates or updates it in
// n8n Cloud, activates it, and sends a test message.
//   npm run n8n:deploy
import { mkdirSync, writeFileSync } from "node:fs";

const NAME = "Blackout HQ link";
const PATH = process.env.N8N_WEBHOOK_PATH ?? "blackout";
const base = (() => {
  const u = (process.env.N8N_URL ?? "").trim().replace(/\/+$/, "");
  return u && !/^https?:\/\//.test(u) ? `https://${u}` : u;
})();
const apiKey = (process.env.N8N_API_KEY ?? "").trim();

// ---- Code node bodies (run inside n8n) ----
const held = `const heldNote = (b) => b.heldMs > 4000 ? \`[held \${Math.round(b.heldMs / 1000)}s in the hub outbox while n8n was unreachable, \${b.backlog} more queued] \` : '';`;

const watchdog = `${held}
// Opens an incident when a team goes quiet, closes it with the duration when it returns.
const store = $getWorkflowStaticData('global');
store.incidents = store.incidents || {};
const out = [];
for (const item of $input.all()) {
  const b = item.json.body;
  let content;
  if (!b.online) {
    store.incidents[b.device] = { openedAt: b.at, tick: b.tick };
    content = \`INCIDENT OPEN: \${b.label} lost contact at t\${b.tick}. Actors \${b.actors.join(', ')} continue on standing orders.\`;
  } else {
    const inc = store.incidents[b.device];
    delete store.incidents[b.device];
    const secs = inc ? Math.round((b.at - inc.openedAt) / 1000) : null;
    content = \`INCIDENT CLOSED: \${b.label} back in contact at t\${b.tick}\${secs !== null ? \` after \${secs}s dark\` : ''}. Merging their reports.\`;
  }
  out.push({ json: { kind: 'status', device: b.device, online: b.online, content: heldNote(b) + content, openIncidents: Object.keys(store.incidents), discord: b.discord || '' } });
}
return out;`;

const fieldLog = `${held}
// Summarises a batch of field events. A late batch is a team's backlog arriving after a blackout.
const out = [];
for (const item of $input.all()) {
  const b = item.json.body;
  const lines = b.events.map((e) => \`t\${e.tick} \${e.text}\${e.late ? ' (reported late)' : ''}\`);
  const rescues = b.events.filter((e) => e.type === 'rescued').length;
  const content = b.lateCount > 0
    ? \`BACKLOG RECEIVED: \${b.lateCount} reports written while out of contact by \${b.lateFrom.join(', ')}.\\n\${lines.slice(0, 10).join('\\n')}\`
    : \`Field log t\${b.tick}: \${lines.join('; ')}\`;
  const notify = b.lateCount > 0 || rescues > 0;
  out.push({ json: { kind: 'events', content: heldNote(b) + content, events: b.events.length, rescues, late: b.lateCount, discord: notify ? (b.discord || '') : '' } });
}
return out;`;

const prealert = `${held}
// The end-of-mission report becomes a hospital pre-alert.
const b = $input.first().json.body;
const incoming = b.survivors.map((s) => \`#\${s.id} (\${s.by}, t\${s.tick})\`).join(', ');
const content = [
  'HOSPITAL PRE-ALERT',
  \`\${b.rescued} of \${b.total} survivors extracted, \${b.lost} not reached.\`,
  \`Incoming: \${incoming || 'none'}\`,
  b.summary,
  \`Out of contact: \${b.offlineFinds} found, \${b.offlineRescues} rescued. Conflicts resolved: \${b.conflicts}. Wasted trips: \${b.wasted}. Late reports: \${b.lateReports}.\`,
].join('\\n');
return [{ json: { kind: 'report', content: heldNote(b) + content, rescued: b.rescued, total: b.total, discord: b.discord || '' } }];`;

// ---- Workflow ----
const cond = (id: string, kind: string) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
    conditions: [{ id, leftValue: "={{ $json.body.kind }}", rightValue: kind, operator: { type: "string", operation: "equals" } }],
    combinator: "and",
  },
  renameOutput: true,
  outputKey: kind,
});

const workflow = {
  name: NAME,
  nodes: [
    {
      id: "a1f0c3d2-0000-4000-8000-000000000001",
      name: "Blackout hub",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 300],
      webhookId: "6b1f6a52-3c1e-4d55-9b0e-b1ac0ff00001",
      parameters: { httpMethod: "POST", path: PATH, responseMode: "onReceived", options: {} },
    },
    {
      id: "a1f0c3d2-0000-4000-8000-000000000002",
      name: "Route by kind",
      type: "n8n-nodes-base.switch",
      typeVersion: 3,
      position: [240, 300],
      parameters: { rules: { values: [cond("k-status", "status"), cond("k-events", "events"), cond("k-report", "report")] }, options: {} },
    },
    { id: "a1f0c3d2-0000-4000-8000-000000000003", name: "Watchdog: incidents", type: "n8n-nodes-base.code", typeVersion: 2, position: [520, 120], parameters: { jsCode: watchdog } },
    { id: "a1f0c3d2-0000-4000-8000-000000000004", name: "Field log and backlog", type: "n8n-nodes-base.code", typeVersion: 2, position: [520, 300], parameters: { jsCode: fieldLog } },
    { id: "a1f0c3d2-0000-4000-8000-000000000005", name: "Hospital pre-alert", type: "n8n-nodes-base.code", typeVersion: 2, position: [520, 480], parameters: { jsCode: prealert } },
    {
      id: "a1f0c3d2-0000-4000-8000-000000000006",
      name: "Discord set?",
      type: "n8n-nodes-base.filter",
      typeVersion: 2,
      position: [780, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
          conditions: [{ id: "has-discord", leftValue: "={{ $json.discord }}", rightValue: "", operator: { type: "string", operation: "notEmpty", singleValue: true } }],
          combinator: "and",
        },
        options: {},
      },
    },
    {
      id: "a1f0c3d2-0000-4000-8000-000000000007",
      name: "Post to Discord",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [1020, 300],
      onError: "continueRegularOutput",
      parameters: {
        method: "POST",
        url: "={{ $json.discord }}",
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify({ content: $json.content.slice(0, 1900) }) }}",
        options: {},
      },
    },
  ],
  connections: {
    "Blackout hub": { main: [[{ node: "Route by kind", type: "main", index: 0 }]] },
    "Route by kind": {
      main: [
        [{ node: "Watchdog: incidents", type: "main", index: 0 }],
        [{ node: "Field log and backlog", type: "main", index: 0 }],
        [{ node: "Hospital pre-alert", type: "main", index: 0 }],
      ],
    },
    "Watchdog: incidents": { main: [[{ node: "Discord set?", type: "main", index: 0 }]] },
    "Field log and backlog": { main: [[{ node: "Discord set?", type: "main", index: 0 }]] },
    "Hospital pre-alert": { main: [[{ node: "Discord set?", type: "main", index: 0 }]] },
    "Discord set?": { main: [[{ node: "Post to Discord", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1" },
};

mkdirSync("n8n", { recursive: true });
writeFileSync("n8n/blackout.workflow.json", JSON.stringify(workflow, null, 2));
console.log("wrote n8n/blackout.workflow.json");

if (!base) {
  console.log("N8N_URL not set; import the file by hand.");
  process.exit(0);
}
if (!apiKey) {
  console.log("N8N_API_KEY not set. Either add it to .env.local and re-run, or import n8n/blackout.workflow.json in n8n and click Publish/Activate.");
  process.exit(0);
}

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "X-N8N-API-KEY": apiKey, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const existing = (await api("GET", `/workflows?name=${encodeURIComponent(NAME)}`)) as { data: { id: string; name: string }[] };
const found = existing.data.find((w) => w.name === NAME);
const { name, nodes, connections, settings } = workflow;
const saved = found
  ? await api("PUT", `/workflows/${found.id}`, { name, nodes, connections, settings })
  : await api("POST", "/workflows", { name, nodes, connections, settings });
console.log(`${found ? "updated" : "created"} workflow ${saved.id}`);
await api("POST", `/workflows/${saved.id}/activate`);
console.log("activated");

const test = await fetch(`${base}/webhook/${PATH}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "events", tick: 0, seq: 0, heldMs: 0, backlog: 0, discord: "", lateCount: 0, lateFrom: [], events: [{ tick: 0, type: "found", actor: "S1", survivor: 0, text: "deploy test from scripts/n8n-deploy.ts" }] }),
});
console.log(`test webhook: HTTP ${test.status}`);
