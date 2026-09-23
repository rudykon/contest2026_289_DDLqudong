import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MotionEngine } from '../src/common/algorithm/motion_engine.js';
import { CooperativeMotionRunner } from '../src/common/algorithm/cooperative_motion_runner.js';
import { TemporalRecordLayer } from '../src/common/algorithm/trl_postprocessor.js';
import { MockSensorProvider } from '../src/common/sensor/mock_sensor_provider.js';
import {
  MotionFxController,
  heartRateIntervalMs,
  motionNeutralFrame,
} from '../src/common/ui/motion_fx_controller.js';
import {
  CLASS_NAMES,
  WINDOW_SEC,
  STEP_SEC,
  WINDOW_SIZE,
  STEP_SIZE,
  SAMPLE_PERIOD_MS,
  DEMO_MIN_SEGMENT_SEC,
  DEMO_SHORT_GAP_SEC,
  CONF_MIN,
  AVG_SMOOTH_SIZE,
  MEDIAN_SIZE,
} from '../src/common/algorithm/config.js';
import {
  MODEL_BACKEND_STATUS,
  classifyWindowWithBackend,
  setNativeModelBackend,
} from '../src/common/algorithm/model_backend.js';
import { buildLocalAiSummary, requestAiSummary } from '../src/common/ai/summary_provider.js';
import {
  buildExportPreview,
  buildExportText,
  diagnosePhoneLink,
  sendSessionToPhone,
  subscribePhoneMessages,
} from '../src/common/sync/interconnect_sync.js';
import {
  PROCESSING_STATES,
  confirmedPreciseResult,
  inspectPreciseResult,
  preciseResultAcceptance,
  processingStateView,
} from '../src/common/sync/processing_state.js';
import { analyzeWorkoutRisk, classifyHrZone } from '../src/common/algorithm/intensity_rules.js';
import {
  getDiagnosticStartPermission,
  getRealTrainingPermission,
  getSessionStartPermission,
} from '../src/common/device/operation_guard.js';
import {
  HISTORY_CLEAR_ACTIONS,
  historyClearAction,
  syncActionPermission,
  wrappedPageIndex,
} from '../src/common/ui/interaction_state.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMotionFxHarness(options = {}) {
  let nowMs = 1000;
  const originMs = nowMs;
  let nextTimerId = 0;
  const timers = new Map();
  const frames = [];
  const fx = new MotionFxController({
    frameMs: options.frameMs,
    breatheHalfMs: options.breatheHalfMs,
    baselineStepMs: options.baselineStepMs,
    now: () => nowMs,
    setTimeout(callback, delayMs) {
      const id = ++nextTimerId;
      timers.set(id, { callback, dueMs: nowMs + delayMs });
      assert.ok(timers.size <= 1, 'MotionFxController must keep one active deadline timer');
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });

  const start = () => fx.start((frame) => frames.push({ atMs: nowMs - originMs, ...frame }));
  const nextTimer = () => {
    const entry = timers.entries().next().value;
    return entry ? { id: entry[0], ...entry[1] } : null;
  };
  const runThrough = (elapsedMs) => {
    const targetMs = originMs + elapsedMs;
    while (true) {
      const timer = nextTimer();
      if (!timer || timer.dueMs > targetMs) break;
      timers.delete(timer.id);
      nowMs = timer.dueMs;
      timer.callback();
    }
    nowMs = targetMs;
  };
  return { fx, frames, timers, start, nextTimer, runThrough, now: () => nowMs };
}

function makeSamples(count, startMs, mutate) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const sample = {
      accX: 0.01,
      accY: -0.01,
      accZ: 9.81,
      gyroX: 0.001,
      gyroY: -0.001,
      gyroZ: 0.001,
      heartRate: 72,
      spo2: 98,
      stress: 18,
      stepCount: 0,
      timeStamp: startMs + i * SAMPLE_PERIOD_MS,
    };
    if (mutate) mutate(sample, i);
    samples.push(sample);
  }
  return samples;
}

function assertProbabilityVector(result) {
  assert.ok(result);
  assert.equal(result.probs.length, 6);
  result.probs.forEach((value) => assert.ok(Number.isFinite(value) && value >= 0));
  const sum = result.probs.reduce((acc, value) => acc + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
  assert.ok(Number.isFinite(result.confidence));
}

function referenceSegments(pathValues, timesSec, probabilityRows) {
  const raw = [];
  if (pathValues.length > 0) {
    let current = pathValues[0];
    let startIndex = 0;
    for (let i = 1; i <= pathValues.length; i += 1) {
      if (i === pathValues.length || pathValues[i] !== current) {
        if (current > 0) {
          const endIndex = i - 1;
          const startSec = Math.max(0, timesSec[startIndex] - WINDOW_SEC / 2);
          const endSec = Math.max(startSec, timesSec[endIndex] + WINDOW_SEC / 2);
          let confidence = 0;
          for (let row = startIndex; row <= endIndex; row += 1) {
            confidence += probabilityRows[row][current];
          }
          confidence /= Math.max(1, endIndex - startIndex + 1);
          raw.push({
            classIdx: current,
            className: CLASS_NAMES[current],
            startSec,
            endSec,
            durationSec: Math.max(0, endSec - startSec),
            confidence,
            startWindowIdx: startIndex,
            endWindowIdx: endIndex,
            isOngoing: i === pathValues.length,
          });
        }
        if (i < pathValues.length) {
          current = pathValues[i];
          startIndex = i;
        }
      }
    }
  }

  const merged = [];
  raw.slice().sort((a, b) => a.startSec - b.startSec).forEach((source) => {
    const segment = Object.assign({}, source);
    const previous = merged[merged.length - 1];
    const gap = previous ? segment.startSec - previous.endSec : Infinity;
    if (previous && previous.classIdx === segment.classIdx && gap < DEMO_SHORT_GAP_SEC) {
      previous.endSec = Math.max(previous.endSec, segment.endSec);
      previous.durationSec = Math.max(0, previous.endSec - previous.startSec);
      previous.confidence = (previous.confidence + segment.confidence) / 2;
      previous.isOngoing = previous.isOngoing || segment.isOngoing;
    } else {
      merged.push(segment);
    }
  });

  const resolved = [];
  merged.slice().sort((a, b) => a.startSec - b.startSec).forEach((source) => {
    const segment = Object.assign({}, source);
    const previous = resolved[resolved.length - 1];
    if (previous && segment.startSec < previous.endSec) {
      if (previous.classIdx === segment.classIdx) {
        previous.endSec = Math.max(previous.endSec, segment.endSec);
        previous.durationSec = Math.max(0, previous.endSec - previous.startSec);
        previous.confidence = Math.max(previous.confidence, segment.confidence);
        previous.isOngoing = previous.isOngoing || segment.isOngoing;
      } else {
        const midpoint = (segment.startSec + previous.endSec) / 2;
        previous.endSec = Math.max(previous.startSec, midpoint);
        previous.durationSec = Math.max(0, previous.endSec - previous.startSec);
        segment.startSec = Math.min(segment.endSec, midpoint);
        segment.durationSec = Math.max(0, segment.endSec - segment.startSec);
        if (segment.durationSec > 0) resolved.push(segment);
      }
    } else {
      resolved.push(segment);
    }
  });

  return resolved.filter((segment) => {
    if (segment.confidence < CONF_MIN) return false;
    if (segment.isOngoing) {
      return segment.durationSec >= Math.min(2, DEMO_MIN_SEGMENT_SEC);
    }
    return segment.durationSec >= DEMO_MIN_SEGMENT_SEC;
  });
}

function referenceStats(pathValues) {
  const byClass = {};
  for (let i = 0; i < pathValues.length; i += 1) {
    const classIdx = pathValues[i];
    byClass[classIdx] = (byClass[classIdx] || 0) + STEP_SEC;
  }
  return { totalSec: pathValues.length * STEP_SEC, byClass };
}

function assertNear(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
}

function assertSegmentsMatchReference(actual, expected) {
  assert.equal(actual.length, expected.length, 'visible segment count');
  for (let i = 0; i < expected.length; i += 1) {
    const left = actual[i];
    const right = expected[i];
    ['classIdx', 'className', 'startWindowIdx', 'endWindowIdx', 'isOngoing'].forEach((key) => {
      assert.equal(left[key], right[key], `segment ${i} ${key}`);
    });
    ['startSec', 'endSec', 'durationSec', 'confidence'].forEach((key) => {
      assertNear(left[key], right[key], `segment ${i} ${key}`);
    });
  }
}

function strongProbability(classIdx) {
  const probabilities = new Array(CLASS_NAMES.length).fill(0.01);
  probabilities[classIdx] = 0.95;
  return probabilities;
}

function baselineUniformFilter(matrix, size) {
  if (matrix.length === 0) return [];
  const half = Math.floor(size / 2);
  return matrix.map((row, timeIndex) => row.map((_, classIdx) => {
    let sum = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      const sourceIndex = Math.max(0, Math.min(matrix.length - 1, timeIndex + offset));
      sum += matrix[sourceIndex][classIdx];
    }
    return sum / size;
  }));
}

function baselineMedian(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function baselineMedianFilter(matrix, size) {
  if (matrix.length === 0) return [];
  const half = Math.floor(size / 2);
  return matrix.map((row, timeIndex) => row.map((_, classIdx) => {
    const values = [];
    for (let offset = -half; offset <= half; offset += 1) {
      const sourceIndex = Math.max(0, Math.min(matrix.length - 1, timeIndex + offset));
      values.push(matrix[sourceIndex][classIdx]);
    }
    return baselineMedian(values);
  }));
}

function baselineViterbi(probabilityRows) {
  if (probabilityRows.length === 0) return [];
  const stateCount = probabilityRows[0].length;
  const transitions = Array.from({ length: stateCount }, (_, previous) => (
    Array.from({ length: stateCount }, (_, current) => (previous === current ? 0.97 : 0.001))
  ));
  for (let classIdx = 1; classIdx < stateCount; classIdx += 1) {
    transitions[0][classIdx] = 0.01;
    transitions[classIdx][0] = 0.05;
  }
  const logTransitions = transitions.map((row) => {
    const sum = row.reduce((left, right) => left + right, 0) || 1;
    return row.map((value) => Math.log(value / sum + 1e-10));
  });
  const scores = [];
  const backPointers = [];
  scores[0] = probabilityRows[0].map((probability) => (
    Math.log(1 / stateCount) + Math.log(probability + 1e-10)
  ));
  backPointers[0] = new Array(stateCount).fill(0);

  for (let timeIndex = 1; timeIndex < probabilityRows.length; timeIndex += 1) {
    scores[timeIndex] = new Array(stateCount);
    backPointers[timeIndex] = new Array(stateCount);
    for (let current = 0; current < stateCount; current += 1) {
      let bestScore = -Infinity;
      let bestPrevious = 0;
      for (let previous = 0; previous < stateCount; previous += 1) {
        const candidate = scores[timeIndex - 1][previous]
          + logTransitions[previous][current];
        if (candidate > bestScore) {
          bestScore = candidate;
          bestPrevious = previous;
        }
      }
      scores[timeIndex][current] = bestScore
        + Math.log(probabilityRows[timeIndex][current] + 1e-10);
      backPointers[timeIndex][current] = bestPrevious;
    }
  }

  const pathValues = new Array(probabilityRows.length);
  const finalScores = scores[scores.length - 1];
  pathValues[pathValues.length - 1] = finalScores.indexOf(Math.max(...finalScores));
  for (let timeIndex = pathValues.length - 2; timeIndex >= 0; timeIndex -= 1) {
    pathValues[timeIndex] = backPointers[timeIndex + 1][pathValues[timeIndex + 1]];
  }
  return pathValues;
}

function decodeGitBaseline(probabilityRows) {
  const averaged = baselineUniformFilter(probabilityRows, AVG_SMOOTH_SIZE);
  const smoothed = baselineMedianFilter(averaged, MEDIAN_SIZE);
  return { smoothed, path: baselineViterbi(smoothed) };
}

function assertProbabilityRowsNear(actual, expected, label) {
  assert.equal(actual.length, expected.length, label + ' row count');
  for (let row = 0; row < expected.length; row += 1) {
    assert.equal(actual[row].length, expected[row].length, `${label} row ${row} width`);
    for (let column = 0; column < expected[row].length; column += 1) {
      assertNear(actual[row][column], expected[row][column], `${label} [${row}][${column}]`);
    }
  }
}

async function importTransformed(relativePath, replacements, tag) {
  let source = await fs.readFile(path.join(projectRoot, relativePath), 'utf8');
  replacements.forEach(([needle, replacement]) => {
    assert.ok(source.includes(needle), 'missing transform anchor in ' + relativePath + ': ' + needle);
    source = source.replace(needle, replacement);
  });
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return import('data:text/javascript;base64,' + encoded + '#' + tag + '_' + Date.now());
}

test('MotionEngine keeps the raw IMU buffer bounded', () => {
  const engine = new MotionEngine();
  const chunks = 250;
  for (let i = 0; i < chunks; i += 1) {
    engine.addSamples(makeSamples(STEP_SIZE, i * 1000));
  }
  assert.equal(engine.sampleCount(), chunks * STEP_SIZE);
  assert.ok(engine.bufferedSampleCount() < WINDOW_SIZE);
  assert.ok(engine.trl.probs.length > 200);
  assert.equal(engine.currentState().warmupFraction, 1);
});

test('cooperative inference yields between classifier and TRL without changing the result', () => {
  const batch = makeSamples(WINDOW_SIZE, 1000, (sample, index) => {
    sample.accX = Math.sin(index * 0.43) * 2.1;
    sample.accY = Math.cos(index * 0.31) * 1.4;
    sample.accZ = 9.81 + Math.sin(index * 0.78) * 2.8;
    sample.gyroY = Math.sin(index * 0.55) * 0.9;
    sample.gyroZ = Math.cos(index * 0.67) * 0.7;
  });
  const expected = new MotionEngine().addSamples(batch, { latestOnly: true });
  const engine = new MotionEngine();
  const scheduled = [];
  let actual = null;

  const work = engine.addSamplesCooperatively(batch, {
    latestOnly: true,
    schedule(callback) { scheduled.push(callback); },
  }, (result) => { actual = result; });

  assert.equal(work.pending, true);
  assert.equal(scheduled.length, 1, 'classification must start in a later event-loop task');
  assert.equal(actual, null);
  scheduled.shift()();
  assert.equal(scheduled.length, 1, 'feature extraction must yield to input between slices');
  assert.equal(engine.trl.probs.length, 0, 'classification alone must not commit temporal state');
  let taskCount = 1;
  while (scheduled.length) { scheduled.shift()(); taskCount += 1; }
  assert.ok(taskCount >= Math.ceil(WINDOW_SIZE / 8) + 2, 'feature slices and TRL must remain independently cancellable');

  assert.ok(actual);
  assert.equal(work.pending, false);
  assert.equal(actual.classIdx, expected.classIdx);
  assertProbabilityRowsNear([actual.probs], [expected.probs], 'cooperative raw probability');
  assertProbabilityRowsNear([actual.smoothedProbs], [expected.smoothedProbs], 'cooperative smoothed probability');
  assert.deepEqual(actual.segments, expected.segments);
});

test('cooperative runner bounds queued samples and stop cancels before TRL commit', () => {
  const scheduled = [];
  const engine = new MotionEngine();
  const runner = new CooperativeMotionRunner(engine, {
    maxPendingSamples: WINDOW_SIZE,
    schedule(callback) { scheduled.push(callback); },
  });
  let resultCount = 0;
  const first = makeSamples(WINDOW_SIZE, 1000);
  const later = makeSamples(WINDOW_SIZE * 2, 5000);

  runner.submit(first, null, () => { resultCount += 1; });
  assert.equal(runner.pendingSampleCount(), WINDOW_SIZE);
  scheduled.shift()(); // pump: schedules classification
  assert.equal(runner.busy, true);
  runner.submit(later, null, () => { resultCount += 1; });
  assert.equal(runner.pendingSampleCount(), WINDOW_SIZE, 'only the newest complete window is retained');
  scheduled.shift()(); // classification: schedules TRL
  assert.equal(engine.trl.probs.length, 0);

  runner.cancel();
  while (scheduled.length) scheduled.shift()();
  assert.equal(resultCount, 0, 'a stopped session must not publish a stale inference result');
  assert.equal(engine.trl.probs.length, 0, 'a stopped session must not commit pending TRL state');
  assert.equal(engine.sampleCount(), 0, 'cancel restores the pre-work engine checkpoint');
  assert.equal(runner.pendingSampleCount(), 0);
});

test('TemporalRecordLayer keeps long-history updates incremental', () => {
  const trl = new TemporalRecordLayer();
  const background = [0.92, 0.02, 0.02, 0.01, 0.02, 0.01];
  for (let i = 0; i < 400; i += 1) trl.update(i + 1.5, background);

  const protectOldHistory = (array, label) => new Proxy(array, {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) {
        const index = Number(property);
        if (index < target.length - 48) {
          throw new Error(label + ' rescanned old index ' + index);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  trl.timesSec = protectOldHistory(trl.timesSec, 'timesSec');
  trl.probs = protectOldHistory(trl.probs, 'probs');
  trl.averaged = protectOldHistory(trl.averaged, 'averaged');
  trl.smoothed = protectOldHistory(trl.smoothed, 'smoothed');
  trl.path = protectOldHistory(trl.path, 'path');

  const result = trl.update(401.5, background);
  assert.equal(result.classIdx, 0);
  assert.equal(result.segments.length, 0);
  assert.equal(result.decodedSeconds, 401);
  assert.ok(Math.abs(result.stats.byClass[0] - 401) < 1e-9);
});

test('TemporalRecordLayer preserves Git baseline centered smoothing and current Viterbi state', () => {
  const trl = new TemporalRecordLayer();
  const inputs = [];
  [[1, 12], [2, 12], [0, 5], [1, 12]].forEach(([classIdx, count]) => {
    for (let i = 0; i < count; i += 1) inputs.push(strongProbability(classIdx));
  });

  const observed = [];
  inputs.forEach((probabilities, frameIndex) => {
    observed.push(probabilities);
    const expected = decodeGitBaseline(observed);
    const result = trl.update(frameIndex + WINDOW_SEC / 2, probabilities);
    const finalIndex = expected.path.length - 1;

    assertProbabilityRowsNear(trl.smoothed, expected.smoothed, `frame ${frameIndex} smoothed`);
    assert.equal(result.classIdx, expected.path[finalIndex], `frame ${frameIndex} classIdx`);
    assert.equal(result.className, CLASS_NAMES[expected.path[finalIndex]], `frame ${frameIndex} className`);
    assertProbabilityRowsNear(
      [result.smoothedProbs],
      [expected.smoothed[finalIndex]],
      `frame ${frameIndex} current smoothing`,
    );
    assertNear(
      result.confidence,
      expected.smoothed[finalIndex][expected.path[finalIndex]],
      `frame ${frameIndex} confidence`,
    );
    assert.equal(result.decodedSeconds, frameIndex + 1, `frame ${frameIndex} decodedSeconds`);
  });
});

test('TemporalRecordLayer incremental segments match full-history reference frame by frame', () => {
  const trl = new TemporalRecordLayer();
  const plan = [
    [0, 8], [1, 15], [0, 7], [1, 12], [2, 13], [0, 4],
    [2, 9], [3, 7], [0, 10], [4, 18], [5, 11], [0, 8],
  ];
  const inputs = [];
  plan.forEach(([classIdx, count]) => {
    for (let i = 0; i < count; i += 1) inputs.push(strongProbability(classIdx));
  });
  for (let i = 0; i < 7; i += 1) {
    inputs.splice(47 + i, 0, new Array(CLASS_NAMES.length).fill(1 / CLASS_NAMES.length));
  }

  let centerTimeSec = 1.5;
  inputs.forEach((probabilities, index) => {
    const result = trl.update(centerTimeSec, probabilities);
    const expectedSegments = referenceSegments(trl.path, trl.timesSec, trl.smoothed);
    const expectedStats = referenceStats(trl.path);
    assertSegmentsMatchReference(result.segments, expectedSegments);
    assertNear(result.stats.totalSec, expectedStats.totalSec, `frame ${index} totalSec`);
    const classKeys = new Set([
      ...Object.keys(result.stats.byClass),
      ...Object.keys(expectedStats.byClass),
    ]);
    classKeys.forEach((key) => {
      assertNear(
        result.stats.byClass[key] || 0,
        expectedStats.byClass[key] || 0,
        `frame ${index} class ${key} duration`,
      );
    });
    // Keep this decoded background run short in wall time so the two class-1
    // runs exercise the baseline's same-class short-gap merge.
    centerTimeSec += index >= 23 && index < 30
      ? 0.1
      : [0.75, 1, 1.25, 0.9][index % 4];
  });
  assert.ok(
    trl.rawSegments.length > trl.segmentRecords.length,
    'scenario must exercise same-class merging across a short background gap',
  );
});

test('TemporalRecordLayer removes a short segment when it stops being ongoing', () => {
  const trl = new TemporalRecordLayer();
  let centerTimeSec = 1.5;
  let wasVisible = false;
  const frames = [
    ...new Array(12).fill(0),
    ...new Array(8).fill(1),
    ...new Array(12).fill(0),
  ];
  frames.forEach((classIdx, index) => {
    const result = trl.update(centerTimeSec, strongProbability(classIdx));
    const expectedSegments = referenceSegments(trl.path, trl.timesSec, trl.smoothed);
    assertSegmentsMatchReference(result.segments, expectedSegments);
    if (result.segments.length > 0) wasVisible = true;
    centerTimeSec += index < 11 ? 1 : 0.1;
  });

  assert.equal(wasVisible, true, 'the ongoing 2-second threshold was not reached');
  assert.equal(trl.segmentRecords.length, 1);
  assert.ok(trl.segmentRecords[0].segment.durationSec < DEMO_MIN_SEGMENT_SEC);
  assert.equal(trl.segmentRecords[0].segment.isOngoing, false);
  assert.equal(trl.segments.length, 0, 'closed segment below 5 seconds must be hidden');
});

test('TemporalRecordLayer does not scan old segment history after many transitions', () => {
  const trl = new TemporalRecordLayer();
  let centerTimeSec = 1.5;
  for (let block = 0; block < 80; block += 1) {
    const classIdx = block % 2 ? 2 : 1;
    for (let i = 0; i < 12; i += 1) {
      trl.update(centerTimeSec, strongProbability(classIdx));
      centerTimeSec += 1;
    }
  }
  assert.ok(trl.rawSegments.length > 50);
  assert.ok(trl.segments.length > 50);

  const protectOldHistory = (array, label) => new Proxy(array, {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) {
        const index = Number(property);
        if (index < target.length - 48) {
          throw new Error(label + ' rescanned old index ' + index);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  trl.timesSec = protectOldHistory(trl.timesSec, 'timesSec');
  trl.probs = protectOldHistory(trl.probs, 'probs');
  trl.averaged = protectOldHistory(trl.averaged, 'averaged');
  trl.smoothed = protectOldHistory(trl.smoothed, 'smoothed');
  trl.path = protectOldHistory(trl.path, 'path');
  trl.rawSegments = protectOldHistory(trl.rawSegments, 'rawSegments');
  trl.segmentRecords = protectOldHistory(trl.segmentRecords, 'segmentRecords');
  trl.segments = protectOldHistory(trl.segments, 'segments');

  const lastClass = trl.path[trl.path.length - 1];
  const result = trl.update(centerTimeSec, strongProbability(lastClass));
  assert.strictEqual(result.segments, trl.segments);
  assert.ok(result.segments.length > 50);
});

test('timestamp zero remains a valid session origin', () => {
  const engine = new MotionEngine();
  const result = engine.addSamples(makeSamples(WINDOW_SIZE + 2 * STEP_SIZE, 0));
  assert.equal(engine.sessionStartMs, 0);
  assert.equal(engine.trl.timesSec[0], Math.floor(WINDOW_SIZE / 2) * SAMPLE_PERIOD_MS / 1000);
  assert.ok(engine.trl.timesSec.every(Number.isFinite));
  assertProbabilityVector(result);
});

test('invalid sensor numbers are contained before classification', () => {
  const engine = new MotionEngine();
  const result = engine.addSamples(makeSamples(WINDOW_SIZE, 0, (sample, i) => {
    if (i % 3 === 0) sample.accX = Infinity;
    if (i % 3 === 1) sample.accY = NaN;
    if (i % 7 === 0) sample.gyroZ = -Infinity;
    if (i === Math.floor(WINDOW_SIZE / 2)) sample.timeStamp = NaN;
    if (i === WINDOW_SIZE - 1) sample.heartRate = Infinity;
  }));
  assertProbabilityVector(result);
  assert.ok(Number.isFinite(result.latestWindow.features.accStd));
  assert.ok(Number.isFinite(result.latestWindow.features.gyroStd));
  assert.ok(Number.isFinite(engine.trl.timesSec[0]));
});

test('static high-HR warning requires genuinely low motion and cadence', () => {
  const movingResult = {
    warmupFraction: 1,
    classIdx: 0,
    latestWindow: { features: { accStd: 2.1 } },
  };
  const movingTrend = Array.from({ length: 8 }, (_, index) => ({
    elapsedSec: index,
    bpm: 145,
    stepCount: index * 2,
    accStd: 1.8,
  }));
  const movingSample = { heartRate: 145, stepCount: 16 };
  const movingRisk = analyzeWorkoutRisk(
    movingResult,
    movingSample,
    classifyHrZone(movingSample.heartRate),
    movingTrend,
  );
  assert.notEqual(movingRisk.key, 'static_high_hr');

  const staticResult = {
    warmupFraction: 1,
    classIdx: 0,
    latestWindow: { features: { accStd: 0.04 } },
  };
  const staticTrend = Array.from({ length: 8 }, (_, index) => ({
    elapsedSec: index,
    bpm: 145,
    stepCount: 0,
    accStd: 0.05,
  }));
  const staticRisk = analyzeWorkoutRisk(
    staticResult,
    { heartRate: 145, stepCount: 0 },
    classifyHrZone(145),
    staticTrend,
  );
  assert.equal(staticRisk.key, 'static_high_hr');
});

test('ordinary activity never shakes the risk card and risk feedback is always short', async () => {
  const vibrationModes = [];
  globalThis.__vmcVibratorMock = {
    vibrate(options) {
      vibrationModes.push(options && options.mode);
    },
  };
  const vibration = await importTransformed(
    'src/common/device/vibration_provider.js',
    [["import { loadOptionalFeature } from './optional_features.js';", 'const loadOptionalFeature = () => globalThis.__vmcVibratorMock;']],
    'vibration-policy',
  );
  try {
    const result = { warmupFraction: 1, classIdx: 4, className: '跑步', confidence: 0.82 };
    const ordinaryRisk = { key: 'stable', level: 'ok', shouldVibrate: false };
    const ordinaryAlert = vibration.pulseWorkoutAlert(result, { heartRate: 110 }, { level: 'easy' }, {
      now: 10000,
      lastAlertAtMs: 0,
      lastAlertKey: '',
      risk: ordinaryRisk,
    });
    assert.equal(ordinaryAlert.triggered, true);
    assert.equal(ordinaryAlert.mode, 'short');
    assert.equal(vibration.shouldShakeRiskCard(ordinaryRisk, ordinaryAlert), false);

    const warningRisk = {
      key: 'fatigue_running',
      level: 'warning',
      shouldVibrate: true,
      mode: 'long',
      message: '降低配速',
    };
    const riskAlert = vibration.pulseWorkoutAlert(result, { heartRate: 162 }, { level: 'hard' }, {
      now: 30000,
      lastAlertAtMs: 0,
      lastAlertKey: '',
      risk: warningRisk,
    });
    assert.equal(riskAlert.triggered, true);
    assert.equal(riskAlert.mode, 'short', 'risk mode input must not re-enable a long vibration');
    assert.equal(vibration.shouldShakeRiskCard(warningRisk, riskAlert), true);
    assert.equal(vibration.shouldShakeRiskCard(warningRisk, { ...riskAlert, key: 'activity_4' }), false);
    assert.deepEqual(vibrationModes, ['short', 'short']);
  } finally {
    delete globalThis.__vmcVibratorMock;
  }
});

test('native backend infers classIdx from the probability argmax', () => {
  setNativeModelBackend({
    classifyWindow() {
      return { probs: [1, 2, 1, 2, 10, 4] };
    },
  });
  const result = classifyWindowWithBackend(makeSamples(WINDOW_SIZE, 0), {});
  assert.equal(result.classIdx, 4);
  assert.equal(result.className, '跑步');
  assert.equal(MODEL_BACKEND_STATUS.active, 'native_quantized_model');
  assertProbabilityVector(result);
  setNativeModelBackend(null);
});

test('invalid or throwing native backends fall back to tiny_classifier', () => {
  setNativeModelBackend({
    classifyWindow() {
      return { probs: [0.5, NaN, 0.5, 0, 0, 0] };
    },
  });
  const invalidResult = classifyWindowWithBackend(makeSamples(WINDOW_SIZE, 0), {});
  assert.equal(MODEL_BACKEND_STATUS.active, 'tiny_classifier');
  assertProbabilityVector(invalidResult);

  setNativeModelBackend({
    classifyWindow() {
      throw new Error('native failure');
    },
  });
  const thrownResult = classifyWindowWithBackend(makeSamples(WINDOW_SIZE, 0), {});
  assert.equal(MODEL_BACKEND_STATUS.active, 'tiny_classifier');
  assertProbabilityVector(thrownResult);
  setNativeModelBackend(null);
});

test('AI summary uses one completion when callback and Promise both resolve', async () => {
  const payload = {
    sceneName: '疲劳跑步',
    summary: { totalSec: 42, activeSec: 34, segmentCount: 2, zoneLabel: '高强度' },
    activityShareRows: [{ name: '跑步', percent: '81%' }],
    riskEvents: [{ title: '疲劳提醒', message: '动作幅度下降' }],
  };
  const local = buildLocalAiSummary(payload);
  assert.ok(local.includes('疲劳跑步'));
  assert.ok(local.includes('动作幅度下降'));

  const oldRequire = globalThis.require;
  globalThis.require = (name) => {
    if (name !== '@system.velaclaw') throw new Error('unexpected module ' + name);
    return {
      ask(options) {
        options.success({ answer: '回调侧总结' });
        return Promise.resolve({ answer: 'Promise 侧总结' });
      },
    };
  };

  let callbackCount = 0;
  let answer = null;
  try {
    requestAiSummary(payload, (result) => {
      callbackCount += 1;
      if (!answer) answer = result;
    });
    await delay(20);
  } finally {
    if (oldRequire === undefined) delete globalThis.require;
    else globalThis.require = oldRequire;
  }
  assert.equal(callbackCount, 1);
  assert.equal(answer.source, 'velaclaw');
  assert.equal(answer.text, '回调侧总结');
});

test('interconnect export is stable and callbacks complete once', async () => {
  const session = {
    sceneId: 'running',
    savedAt: 123,
    summary: {
      totalSec: 42,
      activeSec: 35,
      segmentCount: 2,
      riskCount: 1,
      activityShares: [{ name: '跑步', percent: 83 }],
    },
  };
  const payload = JSON.parse(buildExportText(session));
  assert.equal(payload.type, 'velamotion.session.summary');
  assert.equal(payload.totalSec, 42);
  assert.ok(buildExportPreview(session).length <= 153);

  const oldRequire = globalThis.require;
  const previousMessageHandler = () => {};
  const connection = {
    onmessage: previousMessageHandler,
    diagnosis(options) {
      options.success({ status: 0 });
      options.fail({}, 500);
    },
    send(options) {
      options.success();
      options.fail({}, 500);
    },
  };
  globalThis.require = (name) => {
    if (name !== '@system.interconnect') throw new Error('unexpected module ' + name);
    return {
      instance() {
        return connection;
      },
    };
  };

  let diagnoseCount = 0;
  let sendCount = 0;
  const received = [];
  try {
    diagnosePhoneLink((result) => {
      diagnoseCount += 1;
      assert.equal(result.ok, true);
    });
    sendSessionToPhone(session, (result) => {
      sendCount += 1;
      assert.equal(result.ok, true);
    });
    const unsubscribe = subscribePhoneMessages((message) => received.push(message));
    connection.onmessage({ data: '{"type":"unrelated"}' });
    connection.onmessage({ data: '{invalid json' });
    connection.onmessage({ preciseResult: { summary: { totalSec: 42 } } });
    unsubscribe();
    assert.equal(connection.onmessage, previousMessageHandler);
    await delay(5);
  } finally {
    if (oldRequire === undefined) delete globalThis.require;
    else globalThis.require = oldRequire;
  }
  assert.equal(diagnoseCount, 1);
  assert.equal(sendCount, 1);
  assert.equal(received.length, 2);
  assert.equal(received[0].type, 'unrelated');
  assert.equal(received[1].preciseResult.summary.totalSec, 42);
});

test('watch interaction guards wrap navigation and protect destructive or duplicate actions', () => {
  assert.equal(wrappedPageIndex(0, -1, 4), 3);
  assert.equal(wrappedPageIndex(3, 1, 4), 0);
  assert.equal(wrappedPageIndex(2, 1, 4), 3);

  assert.equal(historyClearAction({ hasItems: false }), HISTORY_CLEAR_ACTIONS.EMPTY);
  assert.equal(historyClearAction({ hasItems: true, busy: true }), HISTORY_CLEAR_ACTIONS.BUSY);
  assert.equal(historyClearAction({ hasItems: true, armed: false }), HISTORY_CLEAR_ACTIONS.ARM);
  assert.equal(historyClearAction({ hasItems: true, armed: true }), HISTORY_CLEAR_ACTIONS.CONFIRM);

  assert.deepEqual(syncActionPermission({ action: 'send', busy: true, hasRecord: true }), {
    allowed: false, feedback: '请稍候', reason: 'busy',
  });
  assert.deepEqual(syncActionPermission({ action: 'send', isRunning: true, hasRecord: true }), {
    allowed: false, feedback: '先停止', reason: 'training',
  });
  assert.deepEqual(syncActionPermission({ action: 'send', hasRecord: false }), {
    allowed: false, feedback: '无记录', reason: 'empty',
  });
  assert.equal(syncActionPermission({ action: 'diagnose', isRunning: true }).allowed, true);
  assert.equal(syncActionPermission({ action: 'send', hasRecord: true }).allowed, true);
});

test('motion controller keeps one deadline and pause invalidates stale work', () => {
  const harness = createMotionFxHarness();
  harness.fx.setChannels({ sync: true });
  harness.start();
  assert.equal(harness.fx.isRunning(), true);
  assert.equal(harness.timers.size, 1);
  const staleTimer = harness.nextTimer();
  harness.fx.pause();
  assert.equal(harness.fx.isRunning(), false);
  assert.equal(harness.timers.size, 0);
  staleTimer.callback();
  assert.equal(harness.frames.length, 0, 'generation token must reject a stale callback');
  assert.equal(harness.timers.size, 0);
});

test('idle buddy breath is a 2.4 second gated cycle', () => {
  const harness = createMotionFxHarness();
  harness.fx.setChannels({ breathe: true });
  harness.start();
  assert.equal(harness.nextTimer().dueMs - harness.now(), 1200);
  harness.runThrough(1200);
  assert.equal(harness.frames.at(-1).buddyBreathScale, 1.035);
  harness.runThrough(2400);
  assert.equal(harness.frames.at(-1).buddyBreathScale, 1);
  harness.fx.setChannels({ breathe: false });
  assert.equal(harness.frames.at(-1).buddyBreathScale, 1);
  assert.equal(harness.timers.size, 0);
});

test('pause resets channel phases so resume starts with a visible first step', () => {
  const harness = createMotionFxHarness();
  harness.fx.setChannels({ breathe: true, baseline: true, sync: true });
  harness.start();
  harness.runThrough(1200);
  assert.equal(harness.frames.at(-1).buddyBreathScale, 1.035);
  assert.notEqual(harness.fx.baselinePhase, 2);
  assert.notEqual(harness.fx.syncPhase, 0);

  harness.fx.pause();
  assert.equal(harness.fx.breatheExpanded, false);
  assert.equal(harness.fx.baselinePhase, 2);
  assert.equal(harness.fx.syncPhase, 0);
  harness.start();
  assert.equal(harness.nextTimer().dueMs - harness.now(), 140);
  harness.runThrough(2400);
  assert.equal(harness.frames.at(-1).buddyBreathScale, 1.035,
    'the first breathe half-cycle after resume must expand instead of repeating neutral');
});

test('baseline dots hop in order every 120-160ms until the channel stops', () => {
  const harness = createMotionFxHarness({ baselineStepMs: 140 });
  harness.fx.setChannels({ baseline: true });
  harness.start();
  harness.runThrough(140);
  assert.equal(harness.frames.at(-1).baselineDot1Y, -5);
  harness.runThrough(280);
  assert.equal(harness.frames.at(-1).baselineDot2Y, -5);
  harness.runThrough(420);
  assert.equal(harness.frames.at(-1).baselineDot3Y, -5);
  harness.fx.setChannels({ baseline: false });
  assert.equal(harness.frames.at(-1).baselineDot1Y, 0);
  assert.equal(harness.frames.at(-1).baselineDot2Y, 0);
  assert.equal(harness.frames.at(-1).baselineDot3Y, 0);
  assert.equal(harness.frames.at(-1).baselineDot1Opacity, 0);
  assert.equal(harness.timers.size, 0);
});

test('start button shrinks into its ring and fully restores within 220ms', () => {
  const harness = createMotionFxHarness();
  harness.start();
  assert.equal(harness.fx.triggerStartRing(), true);
  harness.runThrough(80);
  assert.equal(harness.frames.at(-1).startButtonScale, 0.72);
  assert.equal(harness.frames.at(-1).startRingOpacity, 0.96);
  harness.runThrough(220);
  assert.equal(harness.frames.at(-1).atMs, 220);
  assert.equal(harness.frames.at(-1).startButtonScale, 1);
  assert.equal(harness.frames.at(-1).startButtonOpacity, 1);
  assert.equal(harness.frames.at(-1).startRingOpacity, 0);
});

test('activity pop duration is clamped to 180-240ms', () => {
  const shortHarness = createMotionFxHarness();
  shortHarness.start();
  shortHarness.fx.triggerActivityPop(20);
  shortHarness.runThrough(180);
  assert.equal(shortHarness.frames.at(-1).atMs, 180);
  assert.equal(shortHarness.frames.at(-1).activityScale, 1);

  const longHarness = createMotionFxHarness();
  longHarness.start();
  longHarness.fx.triggerActivityPop(900);
  longHarness.runThrough(240);
  assert.equal(longHarness.frames.at(-1).atMs, 240);
  assert.equal(longHarness.frames.at(-1).activityOpacity, 1);
});

test('heart pulse follows bpm with a 500ms floor and subtle scale', () => {
  assert.equal(heartRateIntervalMs(60), 1000);
  assert.equal(heartRateIntervalMs(120), 500);
  assert.equal(heartRateIntervalMs(200), 500);
  assert.equal(heartRateIntervalMs(0), 0);
  const harness = createMotionFxHarness();
  harness.fx.setHeartRate(60);
  harness.fx.setChannels({ heart: true });
  harness.start();
  harness.runThrough(1000);
  assert.equal(harness.frames.at(-1).heartScale, 1.04);
  harness.runThrough(1140);
  assert.equal(harness.frames.at(-1).heartScale, 1);
  harness.fx.setChannels({ heart: false });
  assert.equal(harness.timers.size, 0);
});

test('risk alert shakes left-right exactly twice and ends neutral', () => {
  const harness = createMotionFxHarness();
  harness.start();
  harness.fx.triggerRiskShake();
  harness.runThrough(300);
  const offsets = harness.frames
    .filter((frame) => [60, 120, 180, 240].includes(frame.atMs))
    .map((frame) => frame.riskTranslateX);
  assert.deepEqual(offsets, [-6, 6, -6, 6]);
  assert.equal(harness.frames.at(-1).riskTranslateX, 0);
});

test('goal celebration sends three stars in distinct directions and hides by 700ms', () => {
  const harness = createMotionFxHarness();
  harness.start();
  harness.fx.triggerGoalStars();
  harness.runThrough(500);
  const spread = harness.frames.at(-1);
  assert.ok(spread.goalStar1X < 0 && spread.goalStar1Y < 0);
  assert.ok(spread.goalStar2Y < spread.goalStar1Y);
  assert.ok(spread.goalStar3X > 0 && spread.goalStar3Y < 0);
  harness.runThrough(700);
  assert.equal(harness.frames.at(-1).atMs, 700);
  assert.equal(harness.frames.at(-1).goalStar1Opacity, 0);
  assert.equal(harness.frames.at(-1).goalStar2Opacity, 0);
  assert.equal(harness.frames.at(-1).goalStar3Opacity, 0);
  assert.equal(harness.frames.at(-1).goalMessageOpacity, 0);
});

test('precise result stamp pops once and remains visible after 320ms', () => {
  const harness = createMotionFxHarness();
  harness.start();
  harness.fx.triggerPreciseStamp();
  harness.runThrough(320);
  assert.equal(harness.frames.at(-1).atMs, 320);
  assert.equal(harness.frames.at(-1).preciseStampScale, 1);
  assert.equal(harness.frames.at(-1).preciseStampOpacity, 1);
  assert.equal(motionNeutralFrame(true).preciseStampOpacity, 1);
  assert.equal(motionNeutralFrame(false).preciseStampOpacity, 0);

  harness.fx.pause();
  harness.start();
  harness.fx.setPreciseVisible(true);
  harness.fx.setChannels({ breathe: true });
  harness.runThrough(1520);
  assert.equal(harness.frames.at(-1).preciseStampOpacity, 1,
    'home breathe after resume must not erase a confirmed stamp');
  harness.fx.setChannels({ breathe: false, sync: true });
  harness.runThrough(2170);
  assert.equal(harness.frames.at(-1).preciseStampOpacity, 1,
    'sync dot updates must preserve the confirmed stamp');
});

test('processing state is honest and precise review requires an inbound preciseResult', () => {
  assert.equal(processingStateView(PROCESSING_STATES.WATCH_SCREENING).text, '腕上初筛');
  assert.equal(processingStateView(PROCESSING_STATES.PENDING_SYNC).text, '待同步');
  const sent = processingStateView(PROCESSING_STATES.AWAITING_PRECISE);
  assert.equal(sent.text, '待同步');
  assert.ok(sent.detail.includes('已发手机 / 等待精确结果'));
  assert.equal(processingStateView(PROCESSING_STATES.PHONE_PRECISE).text, '手机精确复盘');
  assert.equal(confirmedPreciseResult(null), null);
  assert.equal(confirmedPreciseResult({ ok: true, status: 'sent' }), null);
  assert.equal(confirmedPreciseResult({ preciseResult: null }), null);

  const degraded = inspectPreciseResult({
    type: 'velamotion.session.precise_result',
    version: 1,
    preciseResult: { completeScaleSet: false, scalesUsed: [3, 5, 8], summary: { totalSec: 42 } },
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.result, null);
  assert.equal(confirmedPreciseResult({
    type: 'velamotion.session.precise_result',
    version: 1,
    preciseResult: { completeScaleSet: true, scalesUsed: [3, 5] },
  }), null, 'a claimed complete result still needs every 3/5/8 second scale');

  const precise = confirmedPreciseResult({
    type: 'velamotion.session.precise_result',
    version: 1,
    preciseResult: {
      completeScaleSet: true,
      scalesUsed: ['3s', 5, 8],
      summary: {
        totalSec: '42',
        activeSec: -1,
        segmentCount: 3,
        riskCount: 1,
        activityShares: [{ name: '跑步', percent: 80 }],
      },
      segments: [{ className: '跑步' }],
      aiSummary: '手机精算完成',
    },
  });
  assert.equal(precise.totalSec, 42);
  assert.equal(precise.activeSec, null);
  assert.equal(precise.segmentCount, 3);
  assert.equal(precise.segments.length, 1);
  assert.equal(precise.aiSummary, '手机精算完成');
  assert.deepEqual(precise.scalesUsed, [3, 5, 8]);
  assert.equal(precise.completeScaleSet, true);
});

test('precise results are accepted only for an explicitly sent pending record', () => {
  [
    PROCESSING_STATES.WATCH_SCREENING,
    PROCESSING_STATES.PENDING_SYNC,
    PROCESSING_STATES.PHONE_PRECISE,
  ].forEach((processingStateKey) => {
    assert.deepEqual(
      preciseResultAcceptance({ isRunning: false, processingStateKey, hasPendingRecord: true }),
      { allowed: false, reason: 'not_awaiting_precise' },
    );
  });
  assert.deepEqual(
    preciseResultAcceptance({
      isRunning: true,
      processingStateKey: PROCESSING_STATES.AWAITING_PRECISE,
      hasPendingRecord: true,
    }),
    { allowed: false, reason: 'training_active' },
  );
  assert.deepEqual(
    preciseResultAcceptance({
      isRunning: false,
      processingStateKey: PROCESSING_STATES.AWAITING_PRECISE,
      hasPendingRecord: false,
    }),
    { allowed: false, reason: 'no_pending_record' },
  );
  assert.deepEqual(
    preciseResultAcceptance({
      isRunning: false,
      processingStateKey: PROCESSING_STATES.AWAITING_PRECISE,
      hasPendingRecord: true,
    }),
    { allowed: true, reason: 'awaiting_precise' },
  );
});

test('storage revision prevents a stale async load from erasing a save', async () => {
  let pendingGet = null;
  let setCount = 0;
  globalThis.__vmcStorageMock = {
    get(options) {
      pendingGet = options;
    },
    set(options) {
      setCount += 1;
      queueMicrotask(() => options.success && options.success());
    },
    delete(options) {
      queueMicrotask(() => options.success && options.success());
    },
  };

  const store = await importTransformed(
    'src/common/storage/session_store.js',
    [['import storage from \'@system.storage\';', 'const storage = globalThis.__vmcStorageMock;']],
    'storage',
  );
  let loadedRows = null;
  store.loadSessions((rows) => {
    loadedRows = rows;
  });
  assert.ok(pendingGet);

  let persisted = null;
  const saved = store.saveSession({ sceneId: 'running', sceneName: '跑步节奏' }, (ok) => {
    persisted = ok;
  });
  await delay(0);
  pendingGet.success(JSON.stringify([{ id: 'stale_record', sceneId: 'static' }]));

  assert.equal(persisted, true);
  assert.equal(setCount, 1);
  assert.equal(store.listSessions()[0].id, saved.id);
  assert.equal(loadedRows[0].id, saved.id);

  await new Promise((resolve) => store.clearSessions(resolve));
  assert.deepEqual(store.listSessions(), []);
  delete globalThis.__vmcStorageMock;
});

test('service.health wrapper normalizes callback/Promise and unsubscribes active types', async () => {
  const subscriptions = [];
  const unsubscriptions = [];
  globalThis.__vmcHealthMock = {
    DATA_TYPES: { HEART_RATE: 0, SPO2: 6, STRESS: 9 },
    getRecentSamples(options) {
      options.success([{ dataType: 0, data: { value: 73, timeStamp: 1000 } }]);
      return Promise.resolve([{ dataType: 0, data: { value: 99, timeStamp: 2000 } }]);
    },
    subscribeSample(options) {
      if (options.dataType === 6) throw new Error('SPO2 unavailable');
      subscriptions.push(options.dataType);
      if (options.dataType === 0) options.callback({ value: 74, timeStamp: 1100 });
    },
    unsubscribeSample(options) {
      unsubscriptions.push(options.dataType);
    },
  };

  const healthModule = await importTransformed(
    'src/common/sensor/health_provider.js',
    [["import { loadOptionalFeature } from '../device/optional_features.js';", 'const loadOptionalFeature = () => globalThis.__vmcHealthMock;']],
    'health',
  );
  const recent = await healthModule.getRecentHealth([healthModule.DATA_TYPES.HEART_RATE], 100);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].value, 73);

  const samples = [];
  const errors = [];
  const provider = new healthModule.HealthProvider(
    (sample) => samples.push(sample),
    (error) => errors.push(error),
  );
  provider.start();
  await delay(0);
  assert.deepEqual(provider.activeTypes, [0, 9]);
  assert.deepEqual(subscriptions, [0, 9]);
  assert.equal(errors.length, 1);
  assert.ok(samples.some((sample) => sample.value === 74));
  provider.stop();
  assert.deepEqual(unsubscriptions, [0, 9]);
  delete globalThis.__vmcHealthMock;
});

test("Mock sensor waits for each callback and stop prevents rescheduling", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, ms) => {
    const handle = { callback, ms };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = () => {};

  const provider = new MockSensorProvider();
  let callbackCount = 0;
  try {
    provider.start("static", () => {
      callbackCount += 1;
      if (callbackCount === 2) provider.stop();
    });
    assert.equal(callbackCount, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, provider.tickMs);

    const next = scheduled.shift();
    next.callback();
    assert.equal(callbackCount, 2);
    assert.equal(provider.active, false);
    assert.equal(scheduled.length, 0);
  } finally {
    provider.stop();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("Mock sensor applies backpressure without expanding slow batches and ignores a stale timer after stop", () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  let fakeNow = 100000;

  Date.now = () => fakeNow;
  globalThis.setTimeout = (callback, ms) => {
    const handle = { callback, ms, cancelled: false };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle) handle.cancelled = true;
  };

  const provider = new MockSensorProvider();
  const batches = [];
  const expectedBatchSize = Math.round(provider.tickMs / SAMPLE_PERIOD_MS);
  const slowCallbackMs = 2200;
  try {
    provider.start("running", (batch) => {
      batches.push(batch);
      // Reproduce the Vela5/QuickJS callback cost that previously caused every
      // following Mock batch to expand to the three-second catch-up cap.
      fakeNow += slowCallbackMs;
    });

    assert.equal(expectedBatchSize, STEP_SIZE);
    assert.equal(batches.length, 1);
    assert.equal(scheduled.length, 1);

    for (let tick = 0; tick < 5; tick += 1) {
      const timer = scheduled.shift();
      assert.ok(timer);
      assert.equal(timer.cancelled, false);
      assert.equal(timer.ms, slowCallbackMs);
      fakeNow += timer.ms;
      timer.callback();
      assert.equal(scheduled.length, 1, "only one next timer may be pending");
    }

    assert.deepEqual(batches.map((batch) => batch.length), new Array(6).fill(expectedBatchSize));
    const frames = batches.flat();
    frames.forEach((frame, index) => {
      assert.equal(frame.timeStamp, provider.startedAtMs + Math.round(index * SAMPLE_PERIOD_MS));
      if (index > 0) assert.ok(frame.timeStamp > frames[index - 1].timeStamp);
    });

    const staleTimer = scheduled.shift();
    const batchCountAtStop = batches.length;
    provider.stop();
    assert.equal(staleTimer.cancelled, true);
    staleTimer.callback();
    assert.equal(batches.length, batchCountAtStop);
    assert.equal(scheduled.length, 0);
  } finally {
    provider.stop();
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

async function loadRealSensorModule(tag) {
  return importTransformed(
    'src/common/sensor/real_sensor_provider.js',
    [
      ["import { SAMPLE_PERIOD_MS } from '../algorithm/config.js';", 'const SAMPLE_PERIOD_MS = 62.5;'],
      ["import { DATA_TYPES } from './health_provider.js';", 'const DATA_TYPES = { HEART_RATE: 0, SPO2: 6, STRESS: 9 };'],
    ],
    tag,
  );
}

function createFakeTimer(startMs) {
  let now = startMs || 0;
  let nextId = 1;
  const timers = [];
  return {
    now: () => now,
    setTimeout(callback, delayMs) {
      const timer = { id: nextId, callback, delayMs, cancelled: false };
      nextId += 1;
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id);
      if (timer) timer.cancelled = true;
    },
    setNow(timeMs) {
      now = timeMs;
    },
    fireNextAt(timeMs) {
      now = timeMs;
      const index = timers.findIndex((item) => !item.cancelled);
      assert.ok(index >= 0, 'expected a scheduled provider tick');
      const timer = timers.splice(index, 1)[0];
      timer.callback();
    },
    activeCount() {
      return timers.filter((item) => !item.cancelled).length;
    },
  };
}

test('real sensor never emits fabricated samples when the API is absent', async () => {
  const realModule = await loadRealSensorModule('real_sensor_absent');
  const fake = createFakeTimer(1000);
  let batchCount = 0;
  const provider = new realModule.RealSensorProvider({
    now: fake.now,
    loadSensor: () => null,
    setTimeout: fake.setTimeout,
    clearTimeout: fake.clearTimeout,
  });
  const capabilities = provider.getCapabilities();
  assert.deepEqual(capabilities, {
    accelerometer: false,
    gyroscope: false,
    fullActivityRecognition: false,
    mode: 'unavailable',
    reason: 'accelerometer_not_available',
  });
  const status = provider.start(() => {
    batchCount += 1;
  });
  assert.equal(status.active, false);
  assert.equal(status.ready, false);
  assert.equal(status.accelerometer, 'not_available');
  assert.equal(batchCount, 0);
  assert.equal(fake.activeCount(), 0);
  provider.emitTick();
  assert.equal(batchCount, 0);
});

test('real sensor ignores invalid frames and times out without a first valid frame', async () => {
  const realModule = await loadRealSensorModule('real_sensor_first_frame');
  const fake = createFakeTimer(1000);
  let accOptions = null;
  let batchCount = 0;
  let accUnsubscribeCount = 0;
  const statuses = [];
  const sensor = {
    subscribeAccelerometer(options) {
      accOptions = options;
    },
    unsubscribeAccelerometer() {
      accUnsubscribeCount += 1;
    },
  };
  const provider = new realModule.RealSensorProvider({
    now: fake.now,
    loadSensor: () => sensor,
    setTimeout: fake.setTimeout,
    clearTimeout: fake.clearTimeout,
  });
  provider.start(() => {
    batchCount += 1;
  }, {
    firstFrameTimeoutMs: 500,
    onStatus: (status) => statuses.push(status),
  });
  assert.ok(accOptions);
  accOptions.callback({ x: NaN, y: Infinity, z: 9.8 });
  accOptions.callback({ x: '1', y: 2, z: 9.8 });
  assert.equal(provider.getStatus().ready, false);
  assert.equal(provider.getStatus().invalidFrames, 2);
  assert.deepEqual(
    statuses.map((status) => status.accelerometer),
    ['subscribing', 'waiting_for_valid_frame'],
    'repeated invalid frames must not emit repeated state notifications',
  );
  fake.fireNextAt(1100);
  assert.equal(batchCount, 0);
  fake.fireNextAt(1500);
  assert.equal(batchCount, 0);
  assert.equal(provider.getStatus().active, false);
  assert.equal(provider.getStatus().accelerometer, 'timeout_waiting_for_first_frame');
  assert.equal(accUnsubscribeCount, 1);
  assert.equal(fake.activeCount(), 0);
  assert.equal(statuses.at(-1).accelerometer, 'timeout_waiting_for_first_frame');
  statuses.slice(1).forEach((status, index) => {
    const previous = statuses[index];
    assert.notDeepEqual(
      [status.active, status.ready, status.accelerometer, status.stepCounter],
      [previous.active, previous.ready, previous.accelerometer, previous.stepCounter],
    );
  });
});

test('real sensor uses a fixed 16 Hz grid and exposes ACC-only degradation', async () => {
  const realModule = await loadRealSensorModule('real_sensor_fixed_grid');
  const fake = createFakeTimer(0);
  let accOptions = null;
  let stepOptions = null;
  let accUnsubscribeCount = 0;
  let stepUnsubscribeCount = 0;
  const sensor = {
    subscribeAccelerometer(options) {
      accOptions = options;
    },
    subscribeStepCounter(options) {
      stepOptions = options;
    },
    unsubscribeAccelerometer() {
      accUnsubscribeCount += 1;
    },
    unsubscribeStepCounter() {
      stepUnsubscribeCount += 1;
    },
  };
  const provider = new realModule.RealSensorProvider({
    now: fake.now,
    loadSensor: () => sensor,
    setTimeout: fake.setTimeout,
    clearTimeout: fake.clearTimeout,
  });
  const samples = [];
  const statuses = [];
  let lastBatch = [];
  provider.start((batch) => {
    lastBatch = batch;
    samples.push(...batch);
  }, {
    tickMs: 100,
    onStatus: (status) => statuses.push(status),
  });
  assert.ok(accOptions);
  assert.ok(stepOptions);
  assert.deepEqual(provider.getCapabilities(), {
    accelerometer: true,
    gyroscope: false,
    fullActivityRecognition: false,
    mode: 'accelerometer_only',
    reason: 'gyroscope_not_available_in_js_api',
  });
  assert.equal(provider.staleTimeoutMs, 1000);
  stepOptions.callback({ steps: '123' });
  assert.equal(provider.latestSteps, 0, 'numeric strings must not be accepted as sensor values');
  stepOptions.callback({ steps: 123 });
  provider.updateHealth({ ok: true, dataType: 0, value: Infinity });
  provider.updateHealth({ ok: true, dataType: 0, value: '88' });
  assert.equal(provider.latestHealth.heartRate, 0);
  provider.updateHealth({ ok: true, dataType: 0, value: 88 });
  accOptions.callback({ x: 0, y: 0, z: 9 });

  for (let tick = 1; tick <= 30; tick += 1) {
    const timeMs = tick * 100;
    fake.fireNextAt(timeMs);
    accOptions.callback({ x: tick, y: tick * 2, z: 9 + tick / 10 });
  }
  // The callback at 3000 ms arrives after that tick. A later tick may emit up
  // to that real frame, but never hold it into the future.
  fake.fireNextAt(3100);

  assert.equal(samples.length, 49);
  assert.equal(samples[0].timeStamp, 0);
  assert.equal(samples[48].timeStamp, 3000);
  assert.equal(samples[47].timeStamp - samples[0].timeStamp, 2937.5);
  samples.forEach((sample, index) => {
    ['accX', 'accY', 'accZ', 'gyroX', 'gyroY', 'gyroZ', 'heartRate', 'stepCount', 'timeStamp'].forEach((key) => {
      assert.ok(Number.isFinite(sample[key]), key + ' is not finite');
    });
    if (index > 0) assert.equal(sample.timeStamp - samples[index - 1].timeStamp, 62.5);
    assert.equal(sample.gyroAvailable, false);
    assert.equal(sample.fullActivityRecognition, false);
    assert.equal(sample.recognitionMode, 'accelerometer_only');
  });
  assert.equal(samples[0].heartRate, 88);
  assert.equal(samples[0].stepCount, 123);
  assert.equal(provider.getStatus().emittedSamples, 49);
  assert.equal(provider.getStatus().ready, true);

  const lastBatchBeforeGap = lastBatch;
  const statusCountBeforeGap = statuses.length;
  fake.fireNextAt(10000);
  assert.strictEqual(lastBatch, lastBatchBeforeGap, 'a stale tick must not publish another batch');
  assert.equal(samples.length, 49, 'the last real frame must not be held across the gap');
  assert.equal(provider.getStatus().active, true);
  assert.equal(provider.getStatus().ready, false);
  assert.equal(provider.getStatus().accelerometer, 'stale');
  assert.equal(provider.getStatus().droppedSamples, 0);
  assert.equal(statuses.length, statusCountBeforeGap + 1);

  // First-frame timeout is only a startup policy. Once a real frame has been
  // seen, a prolonged stale stream remains subscribed and waits for recovery.
  const staleStatusCount = statuses.length;
  fake.fireNextAt(20000);
  assert.equal(provider.getStatus().active, true);
  assert.equal(provider.getStatus().accelerometer, 'stale');
  assert.equal(statuses.length, staleStatusCount, 'an unchanged stale state must not re-notify');

  const recoveryStart = samples.length;
  fake.setNow(20000);
  accOptions.callback({ x: 200, y: 400, z: 10 });
  fake.setNow(20100);
  accOptions.callback({ x: 201, y: 402, z: 10.1 });
  fake.fireNextAt(20100);
  assert.deepEqual(
    samples.slice(recoveryStart).map((sample) => sample.timeStamp),
    [20000, 20062.5],
    'recovery must re-anchor instead of backfilling the disconnected interval',
  );
  assert.ok(samples.slice(recoveryStart).every((sample) => sample.timeStamp >= 20000));
  assert.equal(provider.getStatus().ready, true);
  assert.equal(fake.activeCount(), 1, 'provider must schedule only after onBatch returns');

  provider.stop();
  assert.equal(accUnsubscribeCount, 1);
  assert.equal(stepUnsubscribeCount, 1);
  statuses.slice(1).forEach((status, index) => {
    const previous = statuses[index];
    assert.notDeepEqual(
      [status.active, status.ready, status.accelerometer, status.stepCounter],
      [previous.active, previous.ready, previous.accelerometer, previous.stepCounter],
      'status callbacks must be lifecycle transitions only',
    );
  });
});

test('real sensor clears and re-anchors when a recovery callback arrives before the stale tick', async () => {
  const realModule = await loadRealSensorModule('real_sensor_callback_first_recovery');
  const fake = createFakeTimer(0);
  let accOptions = null;
  const sensor = {
    subscribeAccelerometer(options) {
      accOptions = options;
    },
    unsubscribeAccelerometer() {},
  };
  const provider = new realModule.RealSensorProvider({
    now: fake.now,
    loadSensor: () => sensor,
    setTimeout: fake.setTimeout,
    clearTimeout: fake.clearTimeout,
  });
  const samples = [];
  const statuses = [];
  provider.start((batch) => samples.push(...batch), {
    staleTimeoutMs: 500,
    onStatus: (status) => statuses.push(status),
  });

  accOptions.callback({ x: 0, y: 0, z: 9 });
  fake.fireNextAt(100);
  assert.deepEqual(samples.map((sample) => sample.timeStamp), [0]);

  const statusCountBeforeRecovery = statuses.length;
  fake.setNow(700);
  accOptions.callback({ x: 7, y: 14, z: 9.7 });
  assert.deepEqual(
    statuses.slice(statusCountBeforeRecovery).map((status) => status.accelerometer),
    ['stale', 'ok'],
    'a late callback must clear the stale grid before establishing recovery',
  );
  assert.equal(provider.nextSampleTimeMs, 700);
  assert.equal(provider.accFrames.length, 1);

  fake.setNow(800);
  accOptions.callback({ x: 8, y: 16, z: 9.8 });
  fake.fireNextAt(800);
  assert.deepEqual(samples.slice(1).map((sample) => sample.timeStamp), [700, 762.5]);
  assert.equal(samples[2].accX, 7.625, 'the grid point must interpolate between real frames');
  assert.equal(provider.accAt(800.1), null, 'the final real frame must not be held into the future');
  provider.stop();
});

test('real sensor MAX_BATCH cap applies only to a backlog bracketed by real frames', async () => {
  const realModule = await loadRealSensorModule('real_sensor_bracketed_max_batch');
  const fake = createFakeTimer(0);
  let accOptions = null;
  const sensor = {
    subscribeAccelerometer(options) {
      accOptions = options;
    },
    unsubscribeAccelerometer() {},
  };
  const provider = new realModule.RealSensorProvider({
    now: fake.now,
    loadSensor: () => sensor,
    setTimeout: fake.setTimeout,
    clearTimeout: fake.clearTimeout,
  });
  const batches = [];
  provider.start((batch) => batches.push(batch), { staleTimeoutMs: 20000 });
  accOptions.callback({ x: 0, y: 0, z: 9 });
  fake.setNow(7000);
  accOptions.callback({ x: 70, y: 140, z: 10 });
  fake.fireNextAt(7000);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 60);
  assert.equal(batches[0][0].timeStamp, 3312.5);
  assert.equal(batches[0].at(-1).timeStamp, 7000);
  assert.equal(provider.getStatus().droppedSamples, 53);
  assert.ok(batches[0].every((sample) => sample.timeStamp >= 0 && sample.timeStamp <= 7000));
  provider.stop();
});

test('real sensor subscription fail callback tears down safely even when invoked synchronously', async () => {
  const realModule = await loadRealSensorModule('real_sensor_sync_fail');
  const fake = createFakeTimer(0);
  let accOptions = null;
  let accUnsubscribeCount = 0;
  let stepSubscribeCount = 0;
  const sensor = {
    subscribeAccelerometer(options) {
      accOptions = options;
      options.fail({ message: 'permission_denied' }, 401);
    },
    subscribeStepCounter() {
      stepSubscribeCount += 1;
    },
    unsubscribeAccelerometer() {
      accUnsubscribeCount += 1;
    },
  };
  const provider = new realModule.RealSensorProvider({
    now: fake.now,
    loadSensor: () => sensor,
    setTimeout: fake.setTimeout,
    clearTimeout: fake.clearTimeout,
  });
  const statuses = [];
  let batchCount = 0;
  const status = provider.start(() => {
    batchCount += 1;
  }, { onStatus: (snapshot) => statuses.push(snapshot) });

  assert.equal(status.active, false);
  assert.equal(status.ready, false);
  assert.equal(status.accelerometer, 'error:permission_denied');
  assert.equal(accUnsubscribeCount, 1);
  assert.equal(stepSubscribeCount, 0, 'startup must stop after a synchronous ACC failure');
  assert.equal(fake.activeCount(), 0);
  assert.equal(statuses.length, 1);
  assert.doesNotThrow(() => accOptions.fail({ message: 'late_failure' }, 500));
  assert.doesNotThrow(() => accOptions.callback({ x: 1, y: 2, z: 3 }));
  assert.equal(accUnsubscribeCount, 1);
  assert.equal(batchCount, 0);
});

test('device diagnostics are blocked for the whole active training session', async () => {
  const permission = getDiagnosticStartPermission(true, false);
  assert.equal(permission.allowed, false);
  assert.ok(permission.message.includes('请先停止'));

  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  const methodStart = page.indexOf('runDiagnostics() {');
  const guardAt = page.indexOf('getDiagnosticStartPermission(this.isRunning, this.isDiagnosing)', methodStart);
  const probeAt = page.indexOf('runDeviceDiagnostics((rows)', methodStart);
  assert.ok(methodStart >= 0 && guardAt > methodStart && probeAt > guardAt);
  assert.ok(page.includes('if (!permission.allowed)'));
});

test('training cannot start until an in-flight device diagnosis completes', async () => {
  const permission = getSessionStartPermission(true);
  assert.equal(permission.allowed, false);
  assert.ok(permission.message.includes('诊断中'));

  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  const methodStart = page.indexOf('startSession(startOffsetSec) {');
  const guardAt = page.indexOf('getSessionStartPermission(this.isDiagnosing)', methodStart);
  const providerAt = page.indexOf('this.startHealthProvider()', methodStart);
  assert.ok(methodStart >= 0 && guardAt > methodStart && providerAt > guardAt);
  assert.ok(page.includes("this.isDiagnosing = true;"));
  assert.ok(page.includes("this.isDiagnosing = false;"));
});

test('real training never starts or saves when six-axis capability is incomplete', async () => {
  const noAcc = getRealTrainingPermission({
    accelerometer: false,
    gyroscope: false,
    fullActivityRecognition: false,
  });
  assert.equal(noAcc.allowed, false);
  assert.ok(noAcc.message.includes('ACC 不可用'));

  const accOnly = getRealTrainingPermission({
    accelerometer: true,
    gyroscope: false,
    fullActivityRecognition: false,
  });
  assert.equal(accOnly.allowed, false);
  assert.equal(accOnly.message, '仅 ACC 可用，缺少 GYRO，完整运动识别未启动');

  assert.equal(getRealTrainingPermission({
    accelerometer: true,
    gyroscope: true,
    fullActivityRecognition: true,
  }).allowed, true);

  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  const extractPageMethod = (name) => {
    const signatureAt = page.indexOf(`\n  ${name}(`);
    assert.ok(signatureAt >= 0, `missing page method: ${name}`);
    const methodStart = signatureAt + 1;
    const bodyStart = page.indexOf('{', methodStart);
    let depth = 0;
    for (let index = bodyStart; index < page.length; index += 1) {
      if (page[index] === '{') depth += 1;
      if (page[index] === '}') depth -= 1;
      if (depth === 0) return page.slice(methodStart, index + 1);
    }
    throw new Error(`unterminated page method: ${name}`);
  };

  // Execute the production page methods in a dependency-spy harness. This
  // verifies behavior at the guard boundary instead of relying on statement
  // order or exact whitespace in index.ux.
  const startMethod = extractPageMethod('startSession');
  const stopMethod = extractPageMethod('stopSession');
  const events = [];
  const createHarness = new Function(
    'getSessionStartPermission',
    'getRealTrainingPermission',
    'events',
    `
      let dataProviderMode = 'real';
      let realProvider = {
        getCapabilities() {
          events.push('real.capabilities');
          return {
            accelerometer: true,
            gyroscope: false,
            fullActivityRecognition: false,
            reason: 'gyroscope_not_available_in_js_api',
          };
        },
        start() { events.push('real.start'); },
        stop() { events.push('real.stop'); },
      };
      let mockProvider = {
        start() { events.push('mock.start'); },
        stop() { events.push('mock.stop'); },
      };
      let healthProvider = { stop() { events.push('health.stop'); } };
      let engine = null;
      let lastResult = null;
      let lastSample = null;
      let sessionStartMs = 0;
      let lastAlertAtMs = 0;
      let lastAlertKey = '';
      let trendSamples = [];
      let riskEvents = [];
      let lastTrendSecond = -1;
      let lastRiskEventAtMs = 0;
      let lastRiskEventKey = '';
      let lastSummarySnapshot = null;
      const PROCESSING_STATES = { WATCH_SCREENING: 'watch_screening' };

      function patchLive(vm, patch) {
        vm.live = Object.assign({}, vm.live || {}, patch || {});
        return vm.live;
      }
      function createInitialLiveState() { return {}; }
      function watchDiagnosticRows(rows) { return rows || []; }
      function setTrainingScreenOn() { events.push('screen.keep-on'); }
      function clearDemoSessionTimers() { events.push('demo.clear-timers'); }
      function saveSession() { events.push('storage.save'); }
      class MotionEngine {
        constructor() { events.push('engine.create'); }
        reset() { events.push('engine.reset'); }
      }
      class MockSensorProvider {
        constructor() { events.push('mock.create'); }
      }
      class RealSensorProvider {
        constructor() { events.push('real.create'); }
      }
      const console = { log(value) { events.push('log:' + value); } };
      const pageMethods = {
        ${startMethod},
        ${stopMethod},
      };
      return {
        start(vm) { return pageMethods.startSession.call(vm); },
        stop(vm) { return pageMethods.stopSession.call(vm); },
      };
    `,
  );
  const harness = createHarness(
    getSessionStartPermission,
    getRealTrainingPermission,
    events,
  );
  const vm = {
    isDiagnosing: false,
    isRunning: false,
    live: {},
    setProcessingState(key, detail) { events.push('processing:' + key + ':' + detail); },
    startHealthProvider() { events.push('health.start'); },
  };

  assert.equal(harness.start(vm), false);
  assert.equal(vm.isRunning, false);
  assert.equal(vm.storageStatusText, '未启动');
  assert.equal(vm.live.alertStatusText, '不会保存');
  assert.ok(events.includes('real.capabilities'));
  assert.ok(events.includes('real.stop'), 'denied startup should tear down the real provider');
  assert.deepEqual(events.filter((event) => [
    'screen.keep-on',
    'engine.create',
    'engine.reset',
    'health.start',
    'real.start',
    'mock.start',
    'storage.save',
  ].includes(event)), []);

  const eventCountBeforeStop = events.length;
  assert.equal(harness.stop(vm), false);
  assert.equal(events.includes('storage.save'), false);
  assert.equal(events.length, eventCountBeforeStop + 1, 'blocked session stop should only log and return');
});

test('active training exposes a global stop action on every page', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  assert.ok(page.includes('class="global-stop" show="{{ isRunning && !pageState.showHome }}"'));
  assert.ok(page.includes('value="停止训练" ontouchstart="queueTouchAction(\'stopSession\')"'));
  assert.ok(page.includes('ontouchstart="queueTouchAction(\'stopSession\')"'));
  assert.ok(page.includes('new CooperativeMotionRunner(engine, inferenceSchedule)'));
  assert.ok(page.includes('if (inferenceRunner) inferenceRunner.cancel();'));
  assert.ok(page.includes("VMC_SESSION_STOP_IGNORED reason=not_running"));
  const stopStyle = page.match(/\.global-stop\s*\{([\s\S]*?)\}/);
  assert.ok(stopStyle);
  assert.match(stopStyle[1], /left:\s*145px;/);
  assert.match(stopStyle[1], /top:\s*5px;/);
  assert.match(stopStyle[1], /width:\s*96px;/);
});

test('watch template ships exactly four core pages and folds secondary tools into them', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  const screenBlocks = page.match(/class="screen\s+[^\"]+"\s+show="\{\{\s*pageState\./g) || [];
  assert.equal(screenBlocks.length, 4, 'the watch package must contain exactly four pageState screens');
  assert.deepEqual(
    [...page.matchAll(/class="screen\s+([^\s\"]+)[^\"]*"\s+show="\{\{\s*pageState\.(show\w+)/g)]
      .map((match) => [match[1], match[2]]),
    [
      ['home-screen', 'showHome'],
      ['ai-screen', 'showCoach'],
      ['timeline-screen', 'showTimeline'],
      ['sync-screen', 'showSyncReview'],
    ],
  );
  assert.ok(page.includes('const PAGE_NAMES = ["01 首页", "02 腕上教练", "03 动作时间线", "04 同步复盘"];'));
  assert.ok(page.includes('const pageSchedule = [0, 1, 2, 3];'));
  assert.ok(page.includes("this.showReviewPanelDiagnostic = name === 'diagnostic';"));
  assert.ok(page.includes("this.showReviewPanelPrivacy = name === 'privacy';"));
  assert.equal((page.match(/class="coach-view" if=/g) || []).length, 2,
    'both coach conditional views need an explicit column container on openVela');
  const coachViewStyle = page.match(/\.coach-view\s*\{([\s\S]*?)\}/);
  assert.ok(coachViewStyle && /flex-direction:\s*column;/.test(coachViewStyle[1]));
  ['showMode', 'showRisk', 'showSummary', 'showAiSummary', 'showHistory', 'showDiagnostic', 'showPrivacy']
    .forEach((legacyFlag) => assert.equal(page.includes(`pageState.${legacyFlag}`), false));
});

test('home ships a code-native buddy and only celebrates the real 30 second goal crossing', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  assert.ok(page.includes('class="motion-buddy"'));
  assert.equal((page.match(/class="buddy-eye"/g) || []).length, 2);
  assert.equal((page.match(/class="buddy-cheek"/g) || []).length, 2);
  assert.ok(page.includes('class="buddy-activity">{{ live.activityEmoji }}'));
  assert.ok(page.includes('const GOAL_ACTIVE_SEC = 30;'));
  assert.ok(page.includes('if (!goalActiveReached && summary.activeSec >= GOAL_ACTIVE_SEC)'));
  assert.equal((page.match(/this\.triggerMotionEffect\('goal'\)/g) || []).length, 1);
  assert.equal((page.match(/class="goal-star goal-star-/g) || []).length, 3);
  assert.ok(page.includes('class="start-action"'));
  assert.ok(page.includes('class="start-ring"'));
  assert.ok(page.includes('startButtonScale'));
  ['.activity-buddy-pop', '.heart-buddy-pulse', '.baseline-dot', '.sync-link-dot', '.start-ring', '.goal-star', '.precise-stamp']
    .forEach((selector) => assert.ok(page.includes(selector), `missing motion selector ${selector}`));
  assert.ok((page.match(/transition-property:\s*(?:transform|opacity|transform, opacity);/g) || []).length >= 10);
  assert.equal(page.includes('animation-name:'), false, 'simulator-inert CSS keyframes must not drive product motion');
});

test('watch UI ships the mint-soda companion hierarchy without unsupported descendant selectors', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  assert.ok(page.includes('<text class="app-title">小芽 · {{ dataSourceText }}</text>'));
  assert.ok(page.includes('class="buddy-sprout"'));
  assert.ok(page.includes('class="buddy-leaf buddy-leaf-left"'));
  assert.ok(page.includes('class="buddy-leaf buddy-leaf-right"'));
  assert.ok(page.includes('class="metric-card metric-heart"'));
  assert.ok(page.includes('class="metric-card metric-steps"'));
  assert.ok(page.includes('class="metric-card metric-zone"'));
  assert.ok(page.includes('class="coach-advice-box"'));
  ['#F4FAF7', '#DFF6EE', '#EAF5FF', '#F1F4FF', '#22312D', '#239B78', '#5364CC']
    .forEach((color) => assert.ok(page.includes(color), 'missing UI palette token ' + color));
  assert.ok(page.includes('.activity-buddy-pop,\n.heart-buddy-pulse,\n.motion-buddy {\n  width: 78px;'));
  assert.ok(/class="start-ring"[^>]*ontouchstart="queueTouchAction\('toggleRunning'\)"/.test(page),
    'the start-ring layer must queue a confirmed tap');
  assert.equal(/^\.[^{,\n]+\s+\./m.test(page), false,
    'Vela CSS does not support descendant selectors');
});

test('watch pages keep glanceable density and readable board action labels', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  assert.equal(page.includes('<text class="app-subtitle">'), false);
  assert.equal(page.includes('<text class="process-detail">'), false);
  assert.equal(page.includes('<text class="metric-label">'), false);
  assert.equal(page.includes('<text class="page-kicker">'), false);
  assert.equal(page.includes('<text class="coach-live-tip">'), false);
  assert.equal(page.includes('<div class="prob-heading">'), false);
  assert.equal(page.includes('<div class="sync-state core-sync-state">'), false);
  assert.equal((page.match(/class="page-title"/g) || []).length, 3);
  assert.ok(page.includes('startButtonText: "开始"'));
  assert.ok(page.includes('startButtonText: "停止"'));
  assert.ok(page.includes('<text class="metric-icon">心率</text>'));
  assert.equal(page.includes('▶') || page.includes('♥'), false, 'board fonts lack these glyphs');
  assert.ok(page.includes('value="设备" ontouchstart="queueTouchAction(\'showDiagnosticPanel\')"'));
  assert.ok(page.includes('value="隐私" ontouchstart="queueTouchAction(\'showPrivacyPanel\')"'));
  assert.ok(page.includes('/* Watch-density refinement: one glance, one result, one action. */'));
  assert.ok(page.includes('class="page-dots" show="{{ !isRunning }}"'));
  assert.ok(page.includes('value="桌面" ontouchstart="queueTouchAction(\'returnToDesktop\')"'));
  assert.ok(page.includes('left: 340px;'));
  assert.ok(page.includes('width: 56px;'));
});

test('watch secondary actions expose selection, confirmation, and recoverable busy feedback', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  assert.ok(page.includes('const action = historyClearAction({'));
  assert.ok(page.includes("this.historyClearButtonText = '再按';"));
  assert.ok(page.includes('}, 2600);'));
  assert.ok(page.includes("const generation = this.beginSyncOperation('diagnose');"));
  assert.ok(page.includes("const generation = this.beginSyncOperation('send');"));
  assert.ok(page.includes("this.syncFeedbackText = '可重试';"));
  assert.ok(page.includes('}, 5200);'));
  assert.ok(page.includes('}, 7000);'));
  assert.ok(page.includes('style="background-color: {{ sceneRunningBg }}; color: {{ sceneRunningColor }};"'));
  assert.ok(page.includes('show="{{ !isRunning }}" type="button" value="{{ coachToolsButtonText }}"'));
  assert.ok(page.includes('show="{{ !live.timelineEmpty && !isRunning }}" type="button" value="{{ timelineViewButtonText }}"'));
});

test('default visual hierarchy reserves orange for intensity and risk states', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  const config = await fs.readFile(path.join(projectRoot, 'src/common/algorithm/config.js'), 'utf8');
  const processing = await fs.readFile(path.join(projectRoot, 'src/common/sync/processing_state.js'), 'utf8');
  const lowOrangeLayer = page.slice(page.indexOf('/* Low-orange refinement:'));
  assert.ok(lowOrangeLayer.includes('background-color: #239B78;'));
  assert.ok(lowOrangeLayer.includes('background-color: #5364CC;'));
  assert.equal(/#(?:FF6900|FF7A3D|FF8A4C|F97316|C6511C)/i.test(lowOrangeLayer), false);
  assert.ok(config.includes("'#16755A', '#8B5CF6'"), 'running should use deep mint');
  assert.ok(processing.includes("pending_sync: {\n    text: '待同步',\n    detail: '表端摘要已保存，可发送手机精算',\n    color: '#62A9E8'"));
});

test('coach and sync pages progressively disclose dense secondary information', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  assert.ok(page.includes('function topCoachRows(rows)'));
  assert.ok(page.includes('.slice(0, 2);'));
  assert.ok(page.includes('for="{{ live.coachClassRows }}"'));
  assert.equal((page.match(/class="review-tab review-tab-wide"/g) || []).length, 3);
  assert.ok(page.includes('value="同步" ontouchstart="queueTouchAction(\'showSyncPanel\')"'));
  assert.ok(page.includes('value="历史" ontouchstart="queueTouchAction(\'showHistoryPanel\')"'));
  assert.ok(page.includes('value="更多" ontouchstart="queueTouchAction(\'showDiagnosticPanel\')"'));
  assert.equal((page.match(/class="more-tabs"/g) || []).length, 2);
  assert.ok(page.includes("const moreActive = name === 'diagnostic' || name === 'privacy';"));
  assert.ok(page.includes("this.reviewMoreTabBg = moreActive ? '#22312D' : '#FFFFFF';"));
});

test('watch lifecycle pauses only effects and send success cannot forge a precise review', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  const sliceMethod = (name, nextName) => {
    const start = page.indexOf(`\n  ${name}()`);
    const end = page.indexOf(`\n  ${nextName}()`, start + 1);
    assert.ok(start >= 0 && end > start, `missing method boundary: ${name} -> ${nextName}`);
    return page.slice(start, end);
  };
  const onReady = sliceMethod('onReady', 'onShow');
  const onShow = sliceMethod('onShow', 'onHide');
  const onHide = sliceMethod('onHide', 'onDestroy');
  const onDestroyStart = page.indexOf('\n  onDestroy()');
  const onDestroyEnd = page.indexOf('\n  setDemoPage(index)', onDestroyStart + 1);
  const onDestroy = page.slice(onDestroyStart, onDestroyEnd);
  const sendStart = page.indexOf('\n  sendLatestToPhone()');
  const sendEnd = page.indexOf('\n  runDiagnostics()', sendStart + 1);
  const send = page.slice(sendStart, sendEnd);
  const receiveStart = page.indexOf('\n  handlePhoneMessage(payload)');
  const receiveEnd = page.indexOf('\n  startHealthProvider()', receiveStart + 1);
  const receive = page.slice(receiveStart, receiveEnd);

  assert.ok(onReady.includes('setTrainingScreenOn(false);'));
  assert.ok(onShow.includes('setTrainingScreenOn(this.isRunning);'));
  assert.ok(onHide.includes('if (motionFx) motionFx.pause();'));
  assert.ok(onHide.includes('setTrainingScreenOn(false);'));
  assert.ok(onHide.includes('this.applyMotionFrame(motionNeutralFrame(this.preciseReviewReady));'));
  assert.equal(/(?:mockProvider|realProvider|healthProvider|inferenceRunner)\.(?:stop|cancel)\(/.test(onHide), false,
    'hiding the page must not interrupt an active acquisition session');
  assert.ok(page.includes('this.animationPowerSave = level !== null && level <= 0.20 && !charging;'));
  assert.ok(page.includes('const policyGeneration = ++batteryPolicyGeneration;'));
  assert.ok(page.includes('pageDisposing || policyGeneration !== batteryPolicyGeneration'));
  assert.ok(onDestroy.includes('this.pageVisible = false;'));
  assert.ok(onDestroy.includes('pageDisposing = true;'));
  assert.ok(onDestroy.includes('if (autoStartTimer) clearTimeout(autoStartTimer);'));

  assert.ok(send.includes('PROCESSING_STATES.AWAITING_PRECISE'));
  assert.ok(send.includes('this.preciseReviewReady = false;'));
  assert.equal(send.includes('this.preciseReviewReady = true;'), false);
  assert.ok(receive.includes('const inspected = inspectPreciseResult(payload);'));
  assert.ok(receive.includes('const acceptance = preciseResultAcceptance({'));
  assert.ok(receive.includes('hasPendingRecord: Boolean(this.latestSession())'));
  assert.ok(receive.indexOf('preciseResultAcceptance({') < receive.indexOf('inspectPreciseResult(payload)'),
    'unsolicited or duplicate results must be rejected before payload inspection/application');
  assert.ok(receive.includes("inspected.status === 'degraded'"));
  assert.ok(receive.includes('手机结果为降级模型，未作为精确复盘'));
  assert.ok(receive.includes('PROCESSING_STATES.PHONE_PRECISE'));
  assert.ok(receive.includes('this.preciseReviewReady = true;'));
  assert.equal((page.match(/this\.preciseReviewReady\s*=\s*true;/g) || []).length, 1,
    'only a confirmed inbound preciseResult may reveal the precise-review stamp');
});

test('production source keeps autonomous demo behavior disabled', async () => {
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  assert.ok(page.includes('const AUTO_START_DEMO = false;'));
  assert.ok(page.includes('const AUTO_PAGE_DEMO = false;'));
  assert.ok(page.includes("this.applyScene('fatigue_running', true);"));
  assert.ok(page.includes('function clearDemoSessionTimers()'));
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.build, 'aiot build');
});

test('watch UI avoids unsupported color emoji glyphs', async () => {
  const config = await fs.readFile(path.join(projectRoot, 'src/common/algorithm/config.js'), 'utf8');
  const page = await fs.readFile(path.join(projectRoot, 'src/pages/index/index.ux'), 'utf8');
  ['💤', '🏸', '🪢', '🦅', '🏃', '🏓', '⌚'].forEach((glyph) => {
    assert.equal(config.includes(glyph) || page.includes(glyph), false, 'unsupported glyph remains: ' + glyph);
  });
});

test('missing board services do not prevent startup or fabricate health samples', async () => {
  const oldRequire = globalThis.require;
  globalThis.require = () => { throw new Error('native feature not registered'); };
  try {
    const optional = await importTransformed('src/common/device/optional_features.js', [], 'optional');
    for (const name of ['health', 'vibrator', 'brightness', 'battery']) {
      assert.equal(optional.loadOptionalFeature(name), null);
    }
    const health = await importTransformed('src/common/sensor/health_provider.js', [
      ["import { loadOptionalFeature } from '../device/optional_features.js';", 'const loadOptionalFeature = () => null;'],
    ], 'missing-health');
    const samples = [];
    const errors = [];
    const provider = new health.HealthProvider((sample) => samples.push(sample), (error) => errors.push(error));
    provider.start();
    assert.deepEqual(await health.getRecentHealth([0], 100), []);
    provider.stop();
    assert.deepEqual(samples, []);
    assert.equal(errors.length, 3);
    assert.ok(errors.every((error) => error.unsupported && error.code === 203));
    assert.deepEqual(provider.activeTypes, []);
  } finally {
    if (oldRequire === undefined) delete globalThis.require;
    else globalThis.require = oldRequire;
  }
});

let failures = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log('[core-test] PASS ' + item.name);
  } catch (error) {
    failures += 1;
    console.error('[core-test] FAIL ' + item.name);
    console.error(error && error.stack ? error.stack : error);
  }
}

if (failures > 0) {
  console.error('[core-test] ' + failures + ' test(s) failed');
  process.exit(1);
}
console.log('[core-test] all ' + tests.length + ' checks passed');
