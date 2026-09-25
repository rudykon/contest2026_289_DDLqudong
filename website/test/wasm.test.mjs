import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { computeImuFeatures } from '../../quickapp/velamotion_coach/src/common/algorithm/imu_features.js';
import { classifyWindow } from '../../quickapp/velamotion_coach/src/common/algorithm/tiny_classifier.js';
import { SCENARIOS, sampleMotionFrame } from '../../quickapp/velamotion_coach/src/common/sensor/mock_scenarios.js';

const binary = await fs.readFile(new URL('../dist/wasm/classifier.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(binary, { env: { abort() { throw new Error('WASM abort'); } } });
const e = instance.exports;
const input = new Float64Array(e.memory.buffer, e.input_ptr(), 288);
const output = new Float64Array(e.memory.buffer, e.output_ptr(), 6);
const features = new Float64Array(e.memory.buffer, e.features_ptr(), 23);
const axes = ['accX', 'accY', 'accZ', 'gyroX', 'gyroY', 'gyroZ'];
const keys = ['accMean', 'accStd', 'accRange', 'accRms', 'gyroMean', 'gyroStd', 'gyroRange', 'gyroRms', 'accXStd', 'accYStd', 'accZStd', 'gyroXStd', 'gyroYStd', 'gyroZStd', 'gyroZcr', 'gyroXcr', 'accPeakRate', 'gyroPeakRate', 'fastPeriod', 'slowPeriod', 'gyroDominance', 'lateralEnergy', 'durationSec'];
function fill(frames) { frames.forEach((f, i) => axes.forEach((key, c) => { input[i * 6 + c] = Number(f[key]); })); }
function compare(frames, hr, label) {
  const reference = classifyWindow(frames, { heartRate: hr });
  const referenceFeatures = computeImuFeatures(frames);
  fill(frames); const winner = e.classify(hr || 0);
  assert.equal(winner, reference.classIdx, `${label}: winner`);
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(output[i] - reference.probs[i]) < 1e-10, `${label}: probability ${i}`);
  keys.forEach((key, i) => assert.ok(Math.abs(features[i] - referenceFeatures[key]) < 1e-9 * Math.max(1, Math.abs(referenceFeatures[key])), `${label}: ${key} (${features[i]} vs ${referenceFeatures[key]})`));
}

test('real WASM exports a fixed, bounded f64 window ABI', () => {
  assert.ok(binary.length > 1000); assert.equal(e.abi_version(), 1); assert.equal(e.window_size(), 48);
  assert.equal(e.memory.buffer.byteLength, 65536);
  assert.throws(() => e.memory.grow(1), RangeError);
});

test('WASM matches 23 features, six scores and winning class of original JS across 192 seeded windows', () => {
  const originalRandom = Math.random;
  try {
    for (const initial of [289, 42, 2026]) {
      let seed = initial;
      Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      for (const scene of SCENARIOS) {
        for (const t of [0, 4, 6, 11, 19, 27, 34, 39]) {
          const frames = Array.from({ length: 48 }, (_, i) => sampleMotionFrame(scene.id, t + i / 16, 0));
          compare(frames, frames.at(-1).heartRate, `${scene.id}/${t}/${initial}`);
        }
      }
    }
  } finally { Math.random = originalRandom; }
});

test('zero, constant, signed and non-finite axes preserve original sanitization and heart-rate defaults', () => {
  const zero = Array.from({ length: 48 }, () => Object.fromEntries(axes.map(k => [k, 0])));
  const constant = zero.map(f => ({ ...f, accZ: 9.8, gyroZ: -.2 }));
  const mixed = zero.map((f, i) => ({ ...f, accX: i % 2 ? -4 : 4, accZ: 9.8, gyroY: Math.sin(i / 3) }));
  const invalid = mixed.map((f, i) => ({ ...f, accY: i % 2 ? NaN : Infinity, gyroZ: -Infinity }));
  for (const frames of [zero, constant, mixed, invalid]) for (const hr of [0, undefined, 70, 150]) compare(frames, hr, 'edge');
});

test('repeated inference keeps memory and probabilities stable; batch benchmark executes the same kernel', () => {
  const frames = Array.from({ length: 48 }, (_, i) => sampleMotionFrame('badminton', 10 + i / 16, 0));
  fill(frames); const winner = e.classify(120); const probs = Array.from(output);
  const buffer = e.memory.buffer; const checksum = e.benchmark(5000, 120);
  assert.ok(Math.abs(checksum - 5000 * (winner + probs[0])) < 1e-7);
  assert.equal(e.memory.buffer, buffer); assert.deepEqual(Array.from(output), probs);
});
