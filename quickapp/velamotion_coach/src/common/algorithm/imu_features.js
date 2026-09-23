import { SAMPLE_RATE_HZ } from './config.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mean(values) {
  if (!values || values.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

function stats(values) {
  if (!values || values.length === 0) return { mean: 0, std: 0, min: 0, max: 0, range: 0, rms: 0 };
  let min = values[0];
  let max = values[0];
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  const m = sum / values.length;
  let varSum = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m;
    varSum += d * d;
  }
  return {
    mean: m,
    std: Math.sqrt(varSum / values.length),
    min,
    max,
    range: max - min,
    rms: Math.sqrt(sumSq / values.length),
  };
}

function zeroCrossRate(values, eps, center) {
  if (!values || values.length < 2) return 0;
  const offset = Number.isFinite(center) ? center : 0;
  let count = 0;
  let prev = values[0] - offset;
  for (let i = 1; i < values.length; i++) {
    const cur = values[i] - offset;
    if (Math.abs(prev) > eps && Math.abs(cur) > eps && ((prev < 0 && cur > 0) || (prev > 0 && cur < 0))) {
      count++;
    }
    if (Math.abs(cur) > eps) prev = cur;
  }
  return count / (values.length / SAMPLE_RATE_HZ);
}

function peakRate(values, threshold) {
  if (!values || values.length < 3) return 0;
  let count = 0;
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] > threshold && values[i] >= values[i - 1] && values[i] > values[i + 1]) {
      count++;
    }
  }
  return count / (values.length / SAMPLE_RATE_HZ);
}

function autocorrBands(values, center) {
  if (!values || values.length < 30) return { fast: 0, slow: 0 };

  // QEMU/QuickJS executes floating-point loops slowly. A four-sample block
  // average preserves the modeled 0.45-2.5 Hz wrist bands while reducing the
  // autocorrelation search to about one quarter of the original work.
  const stride = values.length >= 60 ? 4 : 2;
  const effectiveRate = SAMPLE_RATE_HZ / stride;
  const length = Math.ceil(values.length / stride);
  const downsampled = new Array(length);
  let total = 0;
  let cursor = 0;
  for (let start = 0; start < values.length; start += stride) {
    const end = Math.min(values.length, start + stride);
    let sum = 0;
    for (let i = start; i < end; i++) sum += values[i] - center;
    const value = sum / Math.max(1, end - start);
    downsampled[cursor++] = value;
    total += value;
  }

  const residualMean = total / Math.max(1, length);
  let denom = 0;
  for (let i = 0; i < length; i++) {
    const value = downsampled[i] - residualMean;
    downsampled[i] = value;
    denom += value * value;
  }
  if (denom < 1e-6) return { fast: 0, slow: 0 };

  const fastMinLag = Math.max(2, Math.floor(effectiveRate / 3.4));
  const fastMaxLag = Math.min(length - 2, Math.ceil(effectiveRate / 1.6));
  const slowMinLag = Math.max(2, Math.floor(effectiveRate / 1.1));
  const slowMaxLag = Math.min(length - 2, Math.ceil(effectiveRate / 0.45));
  const firstLag = Math.min(fastMinLag, slowMinLag);
  const lastLag = Math.max(fastMaxLag, slowMaxLag);
  let fast = 0;
  let slow = 0;

  for (let lag = firstLag; lag <= lastLag; lag++) {
    let sum = 0;
    for (let i = lag; i < length; i++) sum += downsampled[i] * downsampled[i - lag];
    const score = sum / denom;
    if (lag >= fastMinLag && lag <= fastMaxLag && score > fast) fast = score;
    if (lag >= slowMinLag && lag <= slowMaxLag && score > slow) slow = score;
  }
  return { fast: clamp(fast, 0, 1), slow: clamp(slow, 0, 1) };
}

function finiteAxis(sample, key) {
  const value = Number(sample && sample[key]);
  return Number.isFinite(value) ? value : 0;
}

function fastNorm3(x, y, z) {
  let a = Math.abs(x);
  let b = Math.abs(y);
  let c = Math.abs(z);
  let t;
  if (a < b) { t = a; a = b; b = t; }
  if (b < c) { t = b; b = c; c = t; }
  if (a < b) { t = a; a = b; b = t; }
  return a + 0.375 * b + 0.1875 * c;
}

function createAccumulator() {
  return { count: 0, sum: 0, sumSq: 0, min: Infinity, max: -Infinity };
}

function pushAccumulator(acc, value) {
  acc.count += 1;
  acc.sum += value;
  acc.sumSq += value * value;
  if (value < acc.min) acc.min = value;
  if (value > acc.max) acc.max = value;
}

function finishAccumulator(acc) {
  if (!acc.count) return { mean: 0, std: 0, min: 0, max: 0, range: 0, meanSq: 0 };
  const meanValue = acc.sum / acc.count;
  const meanSq = acc.sumSq / acc.count;
  const variance = Math.max(0, meanSq - meanValue * meanValue);
  return {
    mean: meanValue,
    std: Math.sqrt(variance),
    min: acc.min,
    max: acc.max,
    range: acc.max - acc.min,
    meanSq,
  };
}

export function computeImuFeatures(samples) {
  const work = createImuFeatureWork(samples);
  while (!work.step()) {}
  return work.result;
}

// Each sensor-sample slice is bounded. The synchronous and cooperative paths
// share the exact arithmetic, preserving the classifier's feature values.
export function createImuFeatureWork(samples) {
  const count = samples ? samples.length : 0;
  const accMag = new Array(count);
  const gyroMag = new Array(count);
  const gyroX = new Array(count);
  const gyroZ = new Array(count);

  const axAcc = createAccumulator();
  const ayAcc = createAccumulator();
  const azAcc = createAccumulator();
  const gxAcc = createAccumulator();
  const gyAcc = createAccumulator();
  const gzAcc = createAccumulator();
  const accMagAcc = createAccumulator();
  const gyroMagAcc = createAccumulator();

  let cursor = 0;
  const work = { result: null, step() {
  if (work.result) return true;
  const end = Math.min(count, cursor + 8);
  for (let i = cursor; i < end; i++) {
    const sample = samples[i];
    const ax = finiteAxis(sample, 'accX');
    const ay = finiteAxis(sample, 'accY');
    const az = finiteAxis(sample, 'accZ');
    const gx = finiteAxis(sample, 'gyroX');
    const gy = finiteAxis(sample, 'gyroY');
    const gz = finiteAxis(sample, 'gyroZ');
    const aMag = fastNorm3(ax, ay, az);
    const gMag = fastNorm3(gx, gy, gz);

    accMag[i] = aMag;
    gyroMag[i] = gMag;
    gyroX[i] = gx;
    gyroZ[i] = gz;

    pushAccumulator(axAcc, ax);
    pushAccumulator(ayAcc, ay);
    pushAccumulator(azAcc, az);
    pushAccumulator(gxAcc, gx);
    pushAccumulator(gyAcc, gy);
    pushAccumulator(gzAcc, gz);
    pushAccumulator(accMagAcc, aMag);
    pushAccumulator(gyroMagAcc, gMag);
  }

  cursor = end;
  if (cursor < count) return false;
  // Let the event loop run between accumulation and final feature reduction.
  if (!work.accumulated) { work.accumulated = true; return false; }

  const ax = finishAccumulator(axAcc);
  const ay = finishAccumulator(ayAcc);
  const az = finishAccumulator(azAcc);
  const gx = finishAccumulator(gxAcc);
  const gy = finishAccumulator(gyAcc);
  const gz = finishAccumulator(gzAcc);
  const acc = finishAccumulator(accMagAcc);
  const gyro = finishAccumulator(gyroMagAcc);

  const accPeak = peakRate(accMag, acc.mean + 0.65 * acc.std);
  const gyroPeak = peakRate(gyroMag, gyro.mean + 0.80 * gyro.std);
  const periodicity = autocorrBands(accMag, acc.mean);
  const fastPeriod = periodicity.fast;
  const slowPeriod = periodicity.slow;

  work.result = {
    accMean: acc.mean,
    accStd: acc.std,
    accRange: acc.range,
    accRms: Math.sqrt(Math.max(0, acc.meanSq)),
    gyroMean: gyro.mean,
    gyroStd: gyro.std,
    gyroRange: gyro.range,
    gyroRms: Math.sqrt(Math.max(0, gyro.meanSq)),
    accXStd: ax.std,
    accYStd: ay.std,
    accZStd: az.std,
    gyroXStd: gx.std,
    gyroYStd: gy.std,
    gyroZStd: gz.std,
    gyroZcr: zeroCrossRate(gyroZ, 0.05, gz.mean),
    gyroXcr: zeroCrossRate(gyroX, 0.05, gx.mean),
    accPeakRate: accPeak,
    gyroPeakRate: gyroPeak,
    fastPeriod,
    slowPeriod,
    gyroDominance: gyro.std / Math.max(acc.std, 0.05),
    lateralEnergy: (ax.std + ay.std) / Math.max(az.std, 0.05),
    durationSec: count / SAMPLE_RATE_HZ,
  };
  return true;
  } };
  return work;
}
export function compactFeatureLog(f) {
  return `accStd=${f.accStd.toFixed(2)}, gyroStd=${f.gyroStd.toFixed(2)}, accRange=${f.accRange.toFixed(2)}, gyroRange=${f.gyroRange.toFixed(2)}`;
}
