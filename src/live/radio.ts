// One radio channel: plays clip sequences one after another with a burst of
// static in front, like a real net. Clips are decoded into memory up front so
// playback works with no network (the phone in airplane mode).

export class Radio {
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private queue: { clips: string[]; priority: boolean }[] = [];
  private playing = false;
  maxQueue = 5;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
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

  say(clips: string[], priority = false) {
    if (priority) this.queue.unshift({ clips, priority });
    else this.queue.push({ clips, priority });
    // Keep the channel current: drop the oldest routine calls if it backs up.
    while (this.queue.length > this.maxQueue) {
      const i = this.queue.findIndex((q) => !q.priority);
      this.queue.splice(i >= 0 ? i : this.queue.length - 1, 1);
    }
    if (!this.playing) void this.next();
  }

  get backlog() {
    return this.queue.length;
  }

  private play(url: string, gain = 1): Promise<void> {
    const buf = this.buffers.get(url);
    if (!buf) return Promise.resolve();
    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.buffer = buf;
      src.connect(g).connect(this.ctx.destination);
      src.onended = () => resolve();
      src.start();
    });
  }

  private async next() {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      return;
    }
    this.playing = true;
    await this.play("/audio/fx/static.mp3", 0.35);
    for (const c of item.clips) await this.play(c);
    void this.next();
  }
}
