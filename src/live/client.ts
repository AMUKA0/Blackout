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

export type ClientState = "connecting" | "online" | "offline" | "radio off";

export class HubClient {
  state: ClientState = "connecting";
  mission: Mission | null = null;
  radioBlocked = false; // also blocks this device's Gemini and ElevenLabs calls
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
      if (this.ws && this.ws.readyState === 1 && Date.now() - this.lastFromHub > DEAD_AFTER_MS) this.ws.close();
    }, HEARTBEAT_MS);
    setInterval(() => this.send({ type: "ping", t1: Date.now() }), 5000);
  }

  setRadio(on: boolean) {
    this.radioBlocked = !on;
    if (!on) {
      this.state = "radio off";
      this.ws?.close();
    } else if (!this.ws) this.connect();
  }

  private connect() {
    if (this.radioBlocked) return;
    this.state = "connecting";
    let sock: Sock;
    try {
      sock = this.makeSocket(this.url);
    } catch {
      setTimeout(() => this.connect(), 500);
      return;
    }
    this.ws = sock;
    sock.onopen = () => {
      this.state = "online";
      this.lastFromHub = Date.now();
      this.send({ type: "hello", device: this.device, mission: this.mission });
      for (let i = 0; i < 5; i++) setTimeout(() => this.send({ type: "ping", t1: Date.now() }), i * 100);
    };
    sock.onmessage = (e) => {
      this.lastFromHub = Date.now();
      const m = JSON.parse(String(e.data)) as FromHub;
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
      if (this.ws === sock) this.ws = null;
      this.state = this.radioBlocked ? "radio off" : "offline";
      if (!this.radioBlocked) setTimeout(() => this.connect(), 500);
    };
    sock.onerror = () => {};
  }
}
