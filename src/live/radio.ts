// One radio channel: plays clip sequences one after another with a burst of
// static in front, like a real net. Clips are decoded into memory up front so
// playback works with no network (the phone in airplane mode).
//
// The radio must stay on the demo's clock: a routine call that has waited too
// long is dropped rather than played late, and finish() cuts whatever is
// playing for the closing line, after which nothing else is spoken.

type Item = { clips: string[]; priority: boolean; at: number; maxAge: number };

export class Radio {
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private queue: Item[] = [];
  private playing = false;
  private current: AudioBufferSourceNode | null = null;
  private generation = 0; // bumped by finish() to abandon whatever was playing
  private finished = false;
  maxQueue = 4;
  maxAgeMs = 6000; // routine calls older than this are stale; drop them
  played = 0; // clips actually started, for checking the radio works

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get loaded() {
    return this.buffers.size;
  }

  get backlog() {
    return this.queue.length;
  }

  async preload(urls: string[]) {
    await Promise.all(
      urls.map(async (u) => {
        if (this.buffers.has(u)) return;
        try {
          const data = await (await fetch(u)).arrayBuffer();
          this.buffers.set(u, await this.ctx.decodeAudioData(data));
        } catch {
          // Missing clip: that call just plays without it.
        }
      }),
    );
  }

  // maxAge: how long this call may wait before it is too stale to play.
  say(clips: string[], priority = false, maxAge = this.maxAgeMs) {
    if (this.finished) return;
    const item = { clips, priority, at: performance.now(), maxAge };
    if (priority) this.queue.unshift(item);
    else this.queue.push(item);
    // Keep the channel current: drop the oldest routine calls if it backs up.
    while (this.queue.length > this.maxQueue) {
      const i = this.queue.findIndex((q) => !q.priority);
      this.queue.splice(i >= 0 ? i : this.queue.length - 1, 1);
    }
    if (!this.playing) void this.next();
  }

  // End of mission: stop mid-word if needed, play the closing line, then stay silent.
  finish(clips: string[]) {
    this.finished = true;
    this.queue = [];
    this.generation++;
    try {
      this.current?.stop();
    } catch {}
    this.current = null;
    const gen = this.generation;
    this.playing = true;
    void (async () => {
      await this.play("/audio/fx/static.mp3", gen, 0.35);
      for (const c of clips) await this.play(c, gen);
      if (gen === this.generation) this.playing = false;
    })();
  }

  // Start of a new mission: open the channel again.
  reset() {
    this.finished = false;
    this.queue = [];
    this.generation++;
    try {
      this.current?.stop();
    } catch {}
    this.current = null;
    this.playing = false;
  }

  private play(url: string, gen: number, gain = 1): Promise<void> {
    const buf = this.buffers.get(url);
    if (!buf || gen !== this.generation) return Promise.resolve();
    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.buffer = buf;
      src.connect(g).connect(this.ctx.destination);
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      src.start();
      this.played++;
    });
  }

  private async next() {
    const gen = this.generation;
    let item = this.queue.shift();
    // Skip anything that has gone stale while waiting.
    while (item && !item.priority && performance.now() - item.at > item.maxAge) item = this.queue.shift();
    if (!item || gen !== this.generation) {
      if (gen === this.generation) this.playing = false;
      return;
    }
    this.playing = true;
    await this.play("/audio/fx/static.mp3", gen, 0.35);
    for (const c of item.clips) {
      if (gen !== this.generation) return;
      await this.play(c, gen);
    }
    if (gen === this.generation) void this.next();
  }
}
