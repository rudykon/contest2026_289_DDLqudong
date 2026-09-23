import { WINDOW_SIZE, STEP_SIZE, SAMPLE_PERIOD_MS, CLASS_NAMES, CLASS_COLORS, CLASS_EMOJIS } from './config.js';
import { classifyWindowWithBackend } from './model_backend.js';
import { TemporalRecordLayer } from './trl_postprocessor.js';
import { createImuFeatureWork } from './imu_features.js';

export class MotionEngine {
  constructor() {
    this.cooperativeWork = null;
    this.reset();
  }

  reset() {
    if (this.cooperativeWork) this.cooperativeWork.cancel();
    this.cooperativeWork = null;
    this.samples = [];
    this.nextWindowStart = 0;
    this.trl = new TemporalRecordLayer();
    this.lastResult = null;
    this.sessionStartMs = null;
    this.totalSamples = 0;
    this.droppedWindowCount = 0;
  }

  appendSamples(batch, options) {
    const firstTime = Number(batch[0] && batch[0].timeStamp);
    if (this.sessionStartMs === null) this.sessionStartMs = Number.isFinite(firstTime) ? firstTime : 0;
    for (let i = 0; i < batch.length; i++) this.samples.push(batch[i]);
    this.totalSamples += batch.length;

    // A slow emulator may deliver several seconds in one catch-up batch. In
    // real-time mode, classify only the newest aligned 3 s window instead of
    // replaying every stale overlap and blocking input for tens of seconds.
    const latestOnly = Boolean(options && options.latestOnly);
    const latestStart = this.samples.length - WINDOW_SIZE;
    if (latestOnly && latestStart > this.nextWindowStart) {
      const skipped = Math.floor((latestStart - this.nextWindowStart) / STEP_SIZE);
      if (skipped > 0) {
        this.nextWindowStart += skipped * STEP_SIZE;
        this.droppedWindowCount += skipped;
      }
    }
  }

  prepareNextWindow() {
    if (this.nextWindowStart + WINDOW_SIZE > this.samples.length) return null;
    const start = this.nextWindowStart;
    const end = start + WINDOW_SIZE;
    const window = this.samples.slice(start, end);
    return {
      start,
      window,
      center: window[Math.floor(window.length / 2)],
      last: window[window.length - 1],
    };
  }

  classifyPreparedWindow(prepared, features) {
    const classifierStarted = Date.now();
    const prediction = classifyWindowWithBackend(prepared.window, {
      heartRate: prepared.last.heartRate,
      spo2: prepared.last.spo2,
      stress: prepared.last.stress,
      stepCount: prepared.last.stepCount,
    }, features);
    return {
      prediction,
      classifierMs: Date.now() - classifierStarted,
    };
  }

  commitPreparedWindow(prepared, classified) {
    const centerTime = Number(prepared.center && prepared.center.timeStamp);
    const fallbackCenterTime = this.sessionStartMs + (this.trl.timesSec.length * STEP_SIZE + Math.floor(WINDOW_SIZE / 2)) * SAMPLE_PERIOD_MS;
    const centerSec = ((Number.isFinite(centerTime) ? centerTime : fallbackCenterTime) - this.sessionStartMs) / 1000;
    const trlStarted = Date.now();
    const trlState = this.trl.update(centerSec, classified.prediction.probs);
    const trlMs = Date.now() - trlStarted;
    this.lastResult = Object.assign({}, trlState, {
      classifierMs: classified.classifierMs,
      trlMs,
      latestWindow: classified.prediction,
      warmupFraction: 1,
      bufferFill: WINDOW_SIZE,
      skippedWindows: this.droppedWindowCount,
    });
    this.nextWindowStart += STEP_SIZE;
  }

  compactConsumedSamples() {
    // Keep only the overlap needed by the next sliding window. The previous
    // implementation retained every inference-rate frame for the whole workout.
    if (this.nextWindowStart > 0) {
      this.samples.splice(0, this.nextWindowStart);
      this.nextWindowStart = 0;
    }
  }

  addSamples(batch, options) {
    if (!batch || batch.length === 0) return this.currentState();
    if (this.cooperativeWork) {
      throw new Error('cannot run synchronous inference while cooperative work is pending');
    }
    this.appendSamples(batch, options);
    const latestOnly = Boolean(options && options.latestOnly);

    let updated = false;
    let prepared = this.prepareNextWindow();
    while (prepared) {
      const classified = this.classifyPreparedWindow(prepared);
      this.commitPreparedWindow(prepared, classified);
      updated = true;
      if (latestOnly) break;
      prepared = this.prepareNextWindow();
    }

    this.compactConsumedSamples();
    return updated ? this.currentState() : this.currentState();
  }

  addSamplesCooperatively(batch, options, onComplete) {
    const done = typeof onComplete === 'function' ? onComplete : () => {};
    if (!batch || batch.length === 0) {
      done(this.currentState());
      return { cancel() {}, pending: false };
    }
    if (this.cooperativeWork) {
      throw new Error('cooperative inference already pending');
    }

    const opts = options || {};
    const schedule = typeof opts.schedule === 'function'
      ? opts.schedule
      : (callback) => setTimeout(callback, 0);
    const externalCancelled = typeof opts.isCancelled === 'function'
      ? opts.isCancelled
      : () => false;
    const checkpoint = {
      samplesLength: this.samples.length,
      nextWindowStart: this.nextWindowStart,
      sessionStartMs: this.sessionStartMs,
      totalSamples: this.totalSamples,
      droppedWindowCount: this.droppedWindowCount,
    };

    this.appendSamples(batch, opts);
    const prepared = this.prepareNextWindow();
    if (!prepared) {
      done(this.currentState());
      return { cancel() {}, pending: false };
    }

    let cancelled = false;
    let settled = false;
    let work = null;
    const rollback = () => {
      if (settled) return;
      settled = true;
      if (work) work.pending = false;
      this.samples.length = checkpoint.samplesLength;
      this.nextWindowStart = checkpoint.nextWindowStart;
      this.sessionStartMs = checkpoint.sessionStartMs;
      this.totalSamples = checkpoint.totalSamples;
      this.droppedWindowCount = checkpoint.droppedWindowCount;
      if (this.cooperativeWork === work) this.cooperativeWork = null;
    };
    const shouldCancel = () => {
      let external = false;
      try {
        external = externalCancelled();
      } catch (e) {
        external = true;
      }
      if (cancelled || external) {
        rollback();
        return true;
      }
      return false;
    };
    work = {
      pending: true,
      cancel: () => {
        cancelled = true;
        rollback();
      },
    };
    this.cooperativeWork = work;

    // Classification and temporal decoding are the two expensive QuickJS
    // stages. Put them in separate tasks so touch/stop events can run between
    // them, and check cancellation before committing any new TRL state.
    const featureWork = createImuFeatureWork(prepared.window);
    let featureMs = 0;
    const classifySlice = () => {
      if (shouldCancel()) return;
      const started = Date.now();
      const ready = featureWork.step();
      featureMs += Date.now() - started;
      if (!ready) { schedule(classifySlice); return; }
      const classified = this.classifyPreparedWindow(prepared, featureWork.result);
      classified.classifierMs += featureMs;
      schedule(() => {
        if (shouldCancel()) return;
        this.commitPreparedWindow(prepared, classified);
        this.compactConsumedSamples();
        settled = true;
        work.pending = false;
        if (this.cooperativeWork === work) this.cooperativeWork = null;
        done(this.currentState());
      });
    };
    schedule(classifySlice);
    return work;
  }

  cancelCooperativeWork() {
    if (this.cooperativeWork) this.cooperativeWork.cancel();
  }

  currentState() {
    const fill = Math.min(this.samples.length, WINDOW_SIZE);
    if (!this.lastResult) {
      return {
        classIdx: 0,
        className: CLASS_NAMES[0],
        confidence: 0,
        probs: new Array(CLASS_NAMES.length).fill(0),
        smoothedProbs: new Array(CLASS_NAMES.length).fill(0),
        warmupFraction: Math.min(1, fill / WINDOW_SIZE),
        bufferFill: fill,
        decodedSeconds: 0,
        segments: [],
        stats: { totalSec: 0, byClass: {} },
        skippedWindows: this.droppedWindowCount,
        classifierMs: 0,
        trlMs: 0,
      };
    }
    return Object.assign({}, this.lastResult, {
      warmupFraction: 1,
      bufferFill: WINDOW_SIZE,
    });
  }

  sampleCount() {
    return this.totalSamples;
  }

  bufferedSampleCount() {
    return this.samples.length;
  }
}

export function probabilityRows(probs) {
  const src = probs && probs.length ? probs : new Array(CLASS_NAMES.length).fill(0);
  return CLASS_NAMES.map((name, idx) => {
    const p = Math.max(0, Math.min(1, src[idx] || 0));
    return {
      idx,
      name: `${CLASS_EMOJIS[idx]} ${name}`,
      percent: Math.round(p * 100),
      width: Math.round(p * 168),
      color: CLASS_COLORS[idx],
    };
  });
}

export function formatSec(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function segmentRows(segments) {
  const rows = (segments || []).slice(-5).reverse();
  let maxDuration = 1;
  rows.forEach((seg) => {
    maxDuration = Math.max(maxDuration, Number(seg.durationSec || 0));
  });
  return rows.map((seg) => ({
    label: `${CLASS_EMOJIS[seg.classIdx]} ${seg.className}`,
    start: formatSec(seg.startSec),
    duration: `${formatSec(seg.durationSec)}${seg.isOngoing ? ' 中' : ''}`,
    confidence: `${Math.round(seg.confidence * 100)}%`,
    width: Math.max(12, Math.round(196 * Math.min(1, Number(seg.durationSec || 0) / maxDuration))),
    color: CLASS_COLORS[seg.classIdx],
  }));
}
