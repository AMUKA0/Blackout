import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { DeviceId, Pos } from "../shared/types.ts";

// A local page for a laptop's own actors. It is served by the laptop itself,
// so it keeps working while that laptop's radio to the hub is off.

export type DeviceViewState = {
  device: DeviceId;
  link: string; // client state: online, radio off, offline...
  tick: number;
  offlineSince: number | null;
  hubOffline: boolean;
  actors: { id: string; pos: Pos; mode: string; reason: string; found: number; rescued: number; crashedAt?: number }[];
};

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };

export function startDeviceView(port: number, getState: () => DeviceViewState, onCrash: (actor: string) => void = () => {}) {
  const http = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const file = url === "/" ? "public/device.html" : url.startsWith("/js/") || url.startsWith("/fonts/") ? `public${url}` : null;
    if (!file || file.includes("..") || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ server: http });
  // A port already in use must never take the laptop's actors down with it.
  wss.on("error", () => {});
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    // The page's crash buttons work with the Wi-Fi off: they never leave this laptop.
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { crash?: string };
        if (m.crash) onCrash(m.crash);
      } catch {}
    });
  });
  setInterval(() => {
    const msg = JSON.stringify(getState());
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  }, 250);
  http.on("error", (e) => console.log(`device view not started on port ${port}: ${(e as Error).message}`));
  http.listen(port, "127.0.0.1", () => console.log(`this laptop's craft view: http://localhost:${port}/`));
}
