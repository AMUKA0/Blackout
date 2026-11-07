export type Pos = { x: number; y: number };
export type Role = "scout" | "rescuer";
export type ActorId = "S1" | "S2" | "S3" | "S4" | "R1" | "R2";
export type DeviceId = "A" | "B" | "phone";

export type Rect = { x: number; y: number; w: number; h: number };

export type ActorSpec = {
  id: ActorId;
  role: Role;
  device: DeviceId;
  area: Rect; // scouts patrol a quadrant, rescuers a half
  start: Pos;
};

export type Survivor = {
  id: number;
  pos: Pos;
  spawn: number; // tick it appears
  deadline: number; // last tick a rescue can complete
};

export type World = {
  seed: number;
  size: number;
  water: boolean[]; // index y * size + x; rescuers cannot enter
  buildings: boolean[]; // rescuers route around them; scouts fly over
  solid: boolean[]; // water or building: what ground routes avoid
  base: Pos;
  survivors: Survivor[];
  actors: ActorSpec[];
};

export type Condition = "central" | "independent" | "mesh";

// Faults are the scripted timeline. The live demo runs the same list.
export type Fault =
  | { tick: number; kind: "cut" | "restore"; a: ActorId; b: ActorId }
  | { tick: number; kind: "radioOff" | "radioOn"; device: DeviceId };
