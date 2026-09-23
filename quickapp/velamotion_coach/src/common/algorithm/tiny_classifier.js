import {
  CLASS_BG,
  CLASS_BADMINTON,
  CLASS_JUMP_ROPE,
  CLASS_FLYING,
  CLASS_RUNNING,
  CLASS_PINGPONG,
  CLASS_NAMES,
} from './config.js';
import { computeImuFeatures } from './imu_features.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function band(v, lo, hi) {
  if (v <= lo || v >= hi) return 0;
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  return clamp01(1 - Math.abs(v - mid) / half);
}

function high(v, lo, hi) {
  return clamp01((v - lo) / (hi - lo));
}

function low(v, lo, hi) {
  return clamp01((hi - v) / (hi - lo));
}

const EXP_NEG_HALF_LUT = [1, 0.60653066, 0.36787944, 0.22313016, 0.13533528, 0.082085, 0.04978707, 0.03019738, 0.01831564, 0.011109, 0.00673795, 0.00408677, 0.00247875, 0.00150344, 0.00091188, 0.00055308, 0.00033546];

function fastExpNegative(delta) {
  if (delta <= 0) return 1;
  const scaled = delta * 2;
  const index = Math.floor(scaled);
  if (index >= EXP_NEG_HALF_LUT.length - 1) return EXP_NEG_HALF_LUT[EXP_NEG_HALF_LUT.length - 1];
  const fraction = scaled - index;
  return EXP_NEG_HALF_LUT[index] + (EXP_NEG_HALF_LUT[index + 1] - EXP_NEG_HALF_LUT[index]) * fraction;
}

function softmax(scores) {
  let max = scores[0];
  for (let i = 1; i < scores.length; i++) if (scores[i] > max) max = scores[i];
  const weights = new Array(scores.length);
  let sum = 0;
  for (let i = 0; i < scores.length; i++) {
    const weight = fastExpNegative(max - scores[i]);
    weights[i] = weight;
    sum += weight;
  }
  const denom = Math.max(sum, 1e-9);
  for (let i = 0; i < weights.length; i++) weights[i] /= denom;
  return weights;
}

function argMax(values) {
  let idx = 0;
  let best = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > best) {
      best = values[i];
      idx = i;
    }
  }
  return idx;
}

export function classifyWindow(samples, health, features) {
  const f = features || computeImuFeatures(samples);
  const hr = health && health.heartRate ? health.heartRate : null;

  const scores = new Array(CLASS_NAMES.length).fill(-0.2);

  // Background / static: very low inertial variation.
  scores[CLASS_BG] =
    2.4 * low(f.accStd, 0.12, 0.75) +
    2.0 * low(f.gyroStd, 0.03, 0.45) +
    0.6 * low(f.accRange, 0.8, 3.0);

  // Running: high vertical acceleration, 2-3Hz periodicity, medium arm swing.
  // In the Mock generator, running and jump-rope both have periodic vertical
  // impacts; gyroY and accMean help separate running from rope jumping.
  scores[CLASS_RUNNING] =
    1.9 * band(f.accStd, 1.8, 5.6) +
    1.5 * band(f.gyroStd, 0.22, 1.6) +
    1.7 * f.fastPeriod +
    1.0 * band(f.accPeakRate, 1.4, 4.2) +
    1.0 * high(f.gyroYStd, 0.42, 1.0) +
    0.6 * low(f.accMean, 10.0, 11.2) +
    0.4 * high(hr || 90, 95, 145);

  // Jump rope: strong impact peaks, high acceleration range, low wrist rotation,
  // and a higher mean acceleration caused by repeated upward impulses.
  scores[CLASS_JUMP_ROPE] =
    1.8 * high(f.accRange, 5.0, 12.0) +
    1.2 * band(f.accPeakRate, 1.5, 4.0) +
    0.8 * f.fastPeriod +
    1.0 * low(f.gyroYStd, 0.18, 0.58) +
    0.9 * high(f.accMean, 10.2, 11.4) +
    0.9 * high(f.accMean, 10.55, 11.35) +
    0.6 * high(f.gyroZcr, 6.0, 10.0) +
    0.5 * low(f.gyroMean, 0.2, 0.75) +
    0.3 * high(hr || 90, 100, 150);

  // Flying / arm raise: slower periodic arm motion, moderate accel and gyro.
  // Penalize large bursty gyro range so badminton does not collapse into this class.
  scores[CLASS_FLYING] =
    1.8 * f.slowPeriod +
    1.3 * band(f.accStd, 0.30, 1.40) +
    1.3 * band(f.gyroStd, 0.18, 0.75) +
    0.8 * high(f.lateralEnergy, 1.8, 3.2) +
    0.7 * low(f.gyroRange, 0.7, 2.6) +
    0.5 * low(f.gyroZcr, 1.5, 5.0) +
    0.2 * low(hr || 100, 120, 160);

  // Badminton: bursty lateral movement and strong gyro swings.
  scores[CLASS_BADMINTON] =
    2.0 * high(f.gyroRange, 3.2, 7.0) +
    1.5 * high(f.gyroStd, 0.9, 2.6) +
    1.2 * high(f.accRange, 2.4, 6.2) +
    1.2 * high(f.lateralEnergy, 0.9, 2.3) +
    0.6 * band(f.gyroPeakRate, 0.8, 5.5);

  // Ping-pong: very quick wrist rotations, high gyro-Z crossing, smaller translation than badminton.
  scores[CLASS_PINGPONG] =
    2.3 * high(f.gyroZStd, 0.75, 2.2) +
    1.6 * high(f.gyroZcr, 4.0, 10.0) +
    1.1 * high(f.gyroDominance, 1.0, 3.5) +
    1.0 * low(f.accStd, 0.5, 2.0) +
    0.6 * high(f.gyroPeakRate, 2.0, 8.0) +
    0.9 * high(f.gyroZStd, 0.65, 1.1) +
    0.7 * high(f.gyroZcr, 5.0, 9.0) +
    0.6 * low(f.accRange, 0.7, 1.8);

  // A small background prior avoids over-reporting activity in warm-up or noisy rest.
  if (f.accStd < 0.35 && f.gyroStd < 0.18) scores[CLASS_BG] += 1.4;
  if (f.accStd > 0.9 || f.gyroStd > 0.45) scores[CLASS_BG] -= 1.2;

  const probs = softmax(scores);
  const classIdx = argMax(probs);
  return {
    classIdx,
    className: CLASS_NAMES[classIdx],
    confidence: probs[classIdx],
    probs,
    features: f,
  };
}
