// Give touch handling and the following frame priority over the next model slice.
export class InteractionScheduler {
  constructor(deps) {
    this.now = deps && deps.now || (() => Date.now());
    this.timer = deps && deps.timer || ((callback, delay) => setTimeout(callback, delay));
    this.until = 0;
  }
  touch() { this.until = this.now() + 200; }
  schedule(callback) {
    const run = () => {
      const wait = this.until - this.now();
      if (wait > 0) this.timer(run, wait);
      else callback();
    };
    return this.timer(run, Math.max(16, this.until - this.now()));
  }
}
