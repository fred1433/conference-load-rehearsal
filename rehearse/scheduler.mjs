// Open-model scheduling: every action fires at an absolute offset on a shared
// clock, whether or not earlier requests have answered. A slow system therefore
// still receives the conference burst it would receive in the room, instead of
// a loop that waits and quietly lowers the load (coordinated omission).
export class Clock {
  constructor() { this.t0 = performance.now(); this.lateness = []; }
  now() { return performance.now() - this.t0; }
  at(offsetMs, fn, tag = 'action') {
    const delay = Math.max(0, offsetMs - this.now());
    return setTimeout(() => {
      const late = this.now() - offsetMs;
      this.lateness.push({ tag, late });
      Promise.resolve().then(() => fn(offsetMs)).catch((e) => console.error(`[${tag}]`, e));
    }, delay);
  }
}
