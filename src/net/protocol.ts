import type { DeviceId } from "../shared/types.ts";

// Wire format between devices and the hub. Plain JSON over WebSocket.
// The hub only carries traffic; it never tells an actor what to do.

export const PORT = 8080;
export const HEARTBEAT_MS = 500;
export const DEAD_AFTER_MS = 2000;

export type ToHub =
  | { type: "hello"; device: DeviceId | "dashboard"; mission?: { t0: number; seed: number } | null }
  | { type: "hb"; device: DeviceId; tick: number }
  | { type: "ping"; t1: number }; // clock sync request, client clock

export type FromHub =
  | { type: "pong"; t1: number; server: number }
  | { type: "start"; t0: number; seed: number } // mission start on the hub clock
  | { type: "status"; devices: DeviceStatus[]; started: { t0: number; seed: number } | null };

export type DeviceStatus = { device: DeviceId; online: boolean; lastSeenMs: number; tick: number };

// Clock offset from ping samples: keep the sample with the smallest round trip.
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
