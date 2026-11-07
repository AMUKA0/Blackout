import type { Mode } from "../shared/brain.ts";
import type { Knowledge } from "../shared/knowledge.ts";
import type { StepEvent } from "../shared/step.ts";
import type { ActorId, DeviceId, Pos } from "../shared/types.ts";

// Wire format between devices and the hub. Plain JSON over WebSocket.
// The hub plays the role of the air: it delivers an actor's broadcast only to
// actors within radio range. It never tells an actor what to do.

export const PORT = 8080;
export const HEARTBEAT_MS = 500;
export const DEAD_AFTER_MS = 2000;

export type Mission = { t0: number; seed: number };

export type BeaconActor = {
  id: ActorId;
  pos: Pos;
  mode: Mode;
  target?: number;
  reason: string;
  isolatedFor: number;
  k: Knowledge;
};

export type ToHub =
  | { type: "hello"; device: DeviceId | "dashboard"; mission?: Mission | null }
  | { type: "hb"; device: DeviceId; tick: number }
  | { type: "ping"; t1: number }
  | { type: "beacon"; device: DeviceId; tick: number; actors: BeaconActor[]; events: StepEvent[] }
  | { type: "truth"; survivor: number; tick: number; by: ActorId };

export type DeviceStatus = { device: DeviceId; online: boolean; lastSeenMs: number; tick: number };

export type ObservedActor = BeaconActor & { device: DeviceId; tick: number; online: boolean };

export type FromHub =
  | { type: "pong"; t1: number; server: number }
  | { type: "kicked"; reason: string } // another client took over this device
  | { type: "start"; t0: number; seed: number }
  | { type: "status"; devices: DeviceStatus[]; started: Mission | null }
  | { type: "relay"; from: ActorId; to: ActorId[]; tick: number; k: Knowledge }
  | { type: "truth"; survivor: number; tick: number; by: ActorId }
  | {
      type: "observe";
      tick: number;
      actors: ObservedActor[];
      links: [ActorId, ActorId][];
      events: (StepEvent & { device: DeviceId; late: boolean; arrived: number })[];
      gemini: { state: string; calls: number; failures: number };
      plan: { commander: string; intents: Partial<Record<ActorId, string>> } | null;
    };

export type Sample = { offset: number; rtt: number };
export function offsetFrom(t1: number, server: number, t3: number): Sample {
  const rtt = t3 - t1;
  return { offset: server - (t1 + rtt / 2), rtt };
}
export function bestOffset(samples: Sample[]): number {
  return samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
}

export function tickAt(hubNow: number, t0: number): number {
  return Math.floor((hubNow - t0) / 1000);
}
