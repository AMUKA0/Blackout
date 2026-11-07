import type { DeviceId } from "../shared/types.ts";
import { bestOffset, DEAD_AFTER_MS, HEARTBEAT_MS, offsetFrom, tickAt, type FromHub, type Mission, type Sample, type ToHub } from "../net/protocol.ts";

// Connection to the hub, shared by laptops (ws package) and the phone (browser
// WebSocket). Handles reconnects, heartbeats, clock sync and the radio switch.

type Sock = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type ClientState = "connecting" | "online" | "offline" | "radio off" | "replaced";

export class HubClient {
  state: ClientState = "connecting";
  mission: Mission | null = null;
  radioBlocked = false; // also blocks this device's Gemini and ElevenLabs calls
  replaced = false;
  private ws: Sock | null = null;
  private offset = 0;
  private samples: Sample[] = [];
  private lastFromHub = 0;
  onMessage: (m: FromHub) => void = () => {};
  onMission: (m: Mission) => void = () => {};

  readonly device: DeviceId;
  private url: string;
  private makeSocket: (url: string) => Sock;

  constructor(device: DeviceId, url: string, makeSocket: (url: string) => Sock) {
    this.device = device;
    this.url = url;
    this.makeSocket = makeSocket;
  }

  get httpBase() {
    return this.url.replace(/^ws/, "http");
  }
  hubNow = () => Date.now() + this.offset;
  tick = () => (this.mission ? tickAt(this.hubNow(), this.mission.t0) : -1);
  get online() {
    return this.state === "online";
  }
  clockOffset = () => this.offset;

  send(m: ToHub): boolean {
    if (this.radioBlocked || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  start() {
    this.connect();
    setInterval(() => {
      this.send({ type: "hb", device: this.device, tick: this.tick() });
      // Hub silent for 2s: treat the link as dead now. With Wi-Fi switched
      // off the socket never closes cleanly, so waiting for it takes ~30s.
      if (this.ws && this.ws.readyState === 1 && Date.now() - this.lastFromHub > DEAD_AFTER_MS) this.drop();
    }, HEARTBEAT_MS);
    setInterval(() => this.send({ type: "ping", t1: Date.now() }), 5000);
  }

  setRadio(on: boolean) {
    if (this.replaced) return;
    this.radioBlocked = !on;
    if (!on) {
      this.state = "radio off";
      this.ws?.close();
    } else if (!this.ws) this.connect();
  }

  // Abandon the current socket at once and start reconnecting.
  private drop() {
    const sock = this.ws;
    this.ws = null;
    if (this.replaced) return;
    this.state = this.radioBlocked ? "radio off" : "offline";
    try {
      const s = sock as unknown as { terminate?: () => void; close: () => void };
      if (s?.terminate) s.terminate();
      else s?.close();
    } catch {}
    if (!this.radioBlocked) setTimeout(() => this.connect(), 500);
  }

  private connect() {
    if (this.radioBlocked || this.ws) return;
    if (this.state !== "offline") this.state = "connecting";
    let sock: Sock;
    try {
      sock = this.makeSocket(this.url);
    } catch {
      setTimeout(() => this.connect(), 500);
      return;
    }
    this.ws = sock;
    // A connect attempt that hangs (Wi-Fi rejoining) is retried after 3s.
    setTimeout(() => {
      if (this.ws === sock && sock.readyState === 0) this.drop();
    }, 3000);
    sock.onopen = () => {
      this.state = "online";
      this.lastFromHub = Date.now();
      this.send({ type: "hello", device: this.device, mission: this.mission });
      for (let i = 0; i < 5; i++) setTimeout(() => this.send({ type: "ping", t1: Date.now() }), i * 100);
    };
    sock.onmessage = (e) => {
      this.lastFromHub = Date.now();
      const m = JSON.parse(String(e.data)) as FromHub;
      if (m.type === "kicked") {
        // Another tab or laptop is now this device. Stop for good.
        this.replaced = true;
        this.radioBlocked = true;
        this.state = "replaced";
        sock.close();
        return;
      }
      if (m.type === "pong") {
        this.samples.push(offsetFrom(m.t1, m.server, Date.now()));
        if (this.samples.length > 20) this.samples.shift();
        this.offset = bestOffset(this.samples);
      } else if (m.type === "start") {
        if (!this.mission || this.mission.t0 !== m.t0) {
          this.mission = { t0: m.t0, seed: m.seed };
          this.onMission(this.mission);
        }
      }
      this.onMessage(m);
    };
    sock.onclose = () => {
      if (this.ws !== sock) return; // already dropped and replaced
      this.ws = null;
      if (this.replaced) return;
      this.state = this.radioBlocked ? "radio off" : "offline";
      if (!this.radioBlocked) setTimeout(() => this.connect(), 500);
    };
    sock.onerror = () => {};
  }
}
