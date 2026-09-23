// One bounded unit per event-loop turn. drain() is for page destruction only:
// complete an already accepted save before its timer context disappears.
export class CooperativeSteps {
  constructor(deps) {
    const d = deps || {};
    this.timer = d.timer || ((fn, ms) => setTimeout(fn, ms));
    this.clear = d.clear || ((id) => clearTimeout(id));
    this.steps = [];
    this.pending = false;
    this.generation = 0;
    this.timerId = null;
  }
  run(steps, onError) {
    if (this.pending) return false;
    if (!steps.length) return true;
    this.steps = steps.slice();
    this.onError = onError || (() => {});
    this.pending = true;
    this.generation++;
    this.queue(32);
    return true;
  }
  queue(delay) {
    const token = this.generation;
    this.timerId = this.timer(() => {
      if (token !== this.generation || !this.pending) return;
      this.timerId = null;
      this.step();
      if (this.pending) this.queue(16);
    }, delay);
  }
  step() {
    if (!this.pending) return;
    try { this.steps.shift()(); }
    catch (error) {
      this.pending = false;
      this.steps = [];
      this.onError(error);
      return;
    }
    this.pending = this.steps.length > 0;
  }
  drain() {
    this.generation++;
    if (this.timerId !== null) this.clear(this.timerId);
    this.timerId = null;
    while (this.pending) this.step();
  }
}
