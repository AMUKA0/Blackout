// All tunable numbers live here so the simulator, devices and dashboard agree.
export const CONFIG = {
  size: 16,
  missionTicks: 100,
  survivors: 12,
  spawnMax: 65, // last tick a survivor can appear
  deadlineMin: 28, // ticks a survivor lasts after appearing
  deadlineMax: 42,
  waterBlobs: 5,
  buildings: 34, // placement attempts; blocks of 1x1 to 2x2 with a street around each
  radioRange: 8, // euclidean tiles between two actors for a radio link
  hqRange: 9, // HQ tower range (central condition only)
  scoutSense: 2, // chebyshev radius
  rescuerSense: 1,
  scoutSpeed: 2, // tiles per tick
  rescuerSpeed: 1,
  rescueTicks: 3, // ticks on site to extract a survivor
  muleAfter: 5, // isolated ticks before a scout carries news to a rescuer
  coverAfter: 8, // ticks without hearing a partner scout before covering its sector
} as const;
