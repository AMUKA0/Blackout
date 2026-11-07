// Link from the hub to n8n Cloud. n8n can't reach a laptop, so the hub
// pushes to one webhook. Everything goes through an outbox: if n8n is
// unreachable (or the link is blocked for the table demo), messages wait and
// are replayed in order, with how long each was held.

export type N8nKind = "status" | "events" | "report";

type Outgoing = { kind: N8nKind; seq: number; queuedAt: number; payload: Record<string, unknown> };

function normalise(url: string | undefined): string | null {
  const u = (url ?? "").trim().replace(/\/+$/, "");
  if (!u) return null;
  return /^https?:\/\//.test(u) ? u : `https://${u}`;
}

export class N8nLink {
  readonly base = normalise(process.env.N8N_URL);
  readonly path = process.env.N8N_WEBHOOK_PATH ?? "blackout";
  private discord = (process.env.DISCORD_WEBHOOK_URL ?? "").trim();
  private queue: Outgoing[] = [];
  private seq = 0;
  private sending = false;
  blocked = false; // simulated outage for the n8n judges
  state: "off" | "ok" | "down" | "blocked" = this.base ? "ok" : "off";
  sent = 0;
  lastError = "";

  private timer: ReturnType<typeof setInterval>;

  constructor() {
    this.timer = setInterval(() => void this.flush(), 700);
  }

  stop() {
    clearInterval(this.timer);
  }

  get queued() {
    return this.queue.length;
  }

  push(kind: N8nKind, payload: Record<string, unknown>) {
    if (!this.base) return;
    this.queue.push({ kind, seq: ++this.seq, queuedAt: Date.now(), payload });
  }

  setBlocked(on: boolean) {
    this.blocked = on;
    this.state = on ? "blocked" : this.state === "blocked" ? "ok" : this.state;
  }

  private async flush() {
    if (!this.base || this.sending || this.queue.length === 0) return;
    if (this.blocked) {
      this.state = "blocked";
      return;
    }
    this.sending = true;
    try {
      while (this.queue.length > 0 && !this.blocked) {
        const m = this.queue[0];
        const body = {
          kind: m.kind,
          seq: m.seq,
          queuedAt: m.queuedAt,
          sentAt: Date.now(),
          heldMs: Date.now() - m.queuedAt,
          backlog: this.queue.length - 1,
          discord: this.discord,
          ...m.payload,
        };
        const r = await fetch(`${this.base}/webhook/${this.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.queue.shift();
        this.sent++;
        this.state = "ok";
      }
    } catch (e) {
      this.state = "down";
      this.lastError = (e as Error).message.slice(0, 120);
    } finally {
      this.sending = false;
    }
  }
}
