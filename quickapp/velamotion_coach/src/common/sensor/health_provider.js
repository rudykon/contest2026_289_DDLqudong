// Official service.health v1.0.0 wrapper.
// Verified supported data types: HEART_RATE(0), SPO2(6), STRESS(9).
import { loadOptionalFeature } from '../device/optional_features.js';
const health = loadOptionalFeature('health');

export const DATA_TYPES = health && health.DATA_TYPES
  ? health.DATA_TYPES
  : { HEART_RATE: 0, SPO2: 6, STRESS: 9 };
export const ALL_HEALTH_TYPES = [DATA_TYPES.HEART_RATE, DATA_TYPES.SPO2, DATA_TYPES.STRESS];

function normalizeSamples(list) {
  return (list || []).map((it) => ({
    ok: true,
    dataType: it.dataType,
    value: it.data && it.data.value,
    timeStamp: it.data && it.data.timeStamp,
  }));
}

export function getRecentHealth(dataTypes, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (list) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(list || []);
    };

    timer = setTimeout(() => done([]), timeoutMs || 3000);
    try {
      if (!health || !health.getRecentSamples) {
        done([]);
        return;
      }
      const maybePromise = health.getRecentSamples({
        dataTypes,
        success: (list) => done(normalizeSamples(list)),
        fail: () => done([]),
        complete: () => {},
      });
      if (maybePromise && maybePromise.then) {
        maybePromise
          .then((list) => done(normalizeSamples(list)))
          .catch(() => done([]));
      }
    } catch (e) {
      done([]);
    }
  });
}

export class HealthProvider {
  constructor(onSample, onError) {
    this.onSample = onSample;
    this.onError = onError;
    this.active = false;
    this.activeTypes = [];
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.activeTypes = [];
    if (!health || typeof health.subscribeSample !== 'function') {
      ALL_HEALTH_TYPES.forEach((dataType) => {
        if (this.onError) this.onError({ ok: false, dataType, code: 203, unsupported: true });
      });
      return;
    }
    getRecentHealth(ALL_HEALTH_TYPES).then((list) => {
      list.forEach((sample) => this.onSample && this.onSample(sample));
    });

    ALL_HEALTH_TYPES.forEach((dataType) => {
      try {
        health.subscribeSample({
          dataType,
          callback: (sample) => {
            if (this.onSample) {
              this.onSample({
                ok: true,
                dataType,
                value: sample && sample.value,
                timeStamp: sample && sample.timeStamp,
              });
            }
          },
          fail: (data, code) => {
            if (this.onError) this.onError({ ok: false, dataType, code, unsupported: code === 203 });
          },
        });
        this.activeTypes.push(dataType);
      } catch (e) {
        if (this.onError) {
          this.onError({
            ok: false,
            dataType,
            code: 200,
            unsupported: false,
            message: e && e.message ? e.message : String(e),
          });
        }
      }
    });
  }

  stop() {
    if (!this.active) return;
    this.activeTypes.forEach((dataType) => {
      try {
        health.unsubscribeSample({ dataType });
      } catch (e) {
        console.log(`service.health unsubscribe failed: ${e && e.message ? e.message : e}`);
      }
    });
    this.activeTypes = [];
    this.active = false;
  }
}
