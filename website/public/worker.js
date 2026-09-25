import { getScenario, scenarioDuration, sampleMotionFrame } from './lib/mock_scenarios.js';
import { CLASS_NAMES } from './lib/config.js';
import { TemporalRecordLayer } from './lib/trl_postprocessor.js';

const axes = ['accX', 'accY', 'accZ', 'gyroX', 'gyroY', 'gyroZ'];
let engine, info, timer, runId = 0, scenario = 'mixed_workout', speed = 1;
let count = 0, windows = 0, frames = [], records = [], segments = [], lastResult = null;
let state = 'idle', seed = 289, trl = new TemporalRecordLayer();
// This worker exclusively owns the original generator and its deterministic RNG.
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const send = (type, data = {}) => postMessage({ type, runId, ...data });
function stop() { clearInterval(timer); timer = undefined; }
function setState(next) { state = next; send('state', { state, elapsed: count / 16 }); }
function reset(message) {
  stop(); runId = message.runId; scenario = getScenario(message.scenario).id;
  speed = message.speed === 4 ? 4 : 1;
  count = 0; windows = 0; frames = []; records = []; segments = []; lastResult = null;
  seed = 289; trl.reset(); setState('idle');
}
function snapshot() {
  return { count, windows, elapsed: count / 16, total: scenarioDuration(getScenario(scenario)),
    stage: frames.at(-1)?.mockLabel ?? '', frames: frames.map(f => axes.map(key => f[key])),
    result: lastResult, segments };
}
function tick() {
  const frame = sampleMotionFrame(scenario, count / 16, 0);
  frames.push(frame); if (frames.length > 48) frames.shift(); count++;
  if (count >= 48 && (count - 48) % 16 === 0) {
    const input = new Float64Array(engine.memory.buffer, engine.input_ptr(), 288);
    frames.forEach((f, i) => axes.forEach((key, c) => { input[i * 6 + c] = f[key]; }));
    const start = performance.now();
    const classIdx = engine.classify(frame.heartRate);
    const ms = performance.now() - start;
    const probs = Array.from(new Float64Array(engine.memory.buffer, engine.output_ptr(), 6));
    const temporal = trl.update(count / 16 - 1.5, probs);
    segments = temporal.segments;
    lastResult = { classIdx, className: CLASS_NAMES[classIdx], confidence: probs[classIdx], probs, ms };
    records.push({ endSec: count / 16, ...lastResult }); windows++;
  }
  if (count % 4 === 0) send('data', snapshot());
  if (count >= scenarioDuration(getScenario(scenario)) * 16) { stop(); setState('done'); }
}
function start() {
  if (state === 'running' || state === 'done') return;
  setState('running');
  timer = setInterval(() => { try { tick(); } catch (error) { fail(error); } }, 1000 / 16 / speed);
}
function fail(error) { stop(); state = 'error'; send('error', { message: error.message || String(error) }); }

async function init() {
  if (typeof WebAssembly === 'undefined') throw new Error('当前浏览器不支持 WebAssembly，请使用新版浏览器。');
  const response = await fetch(new URL('./wasm/classifier.wasm', import.meta.url));
  if (!response.ok) throw new Error(`WASM 加载失败（HTTP ${response.status}）。`);
  const imports = { env: { abort() { throw new Error('WASM 计算异常'); } } };
  let instance;
  if (typeof WebAssembly.instantiateStreaming === 'function' && response.headers.get('content-type')?.split(';')[0].trim() === 'application/wasm') {
    ({ instance } = await WebAssembly.instantiateStreaming(response, imports));
  } else {
    ({ instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports));
  }
  engine = instance.exports;
  if (engine.abi_version() !== 1 || engine.window_size() !== 48) throw new Error('WASM 接口版本不匹配。');
  const metadata = await fetch(new URL('./build-info.json', import.meta.url));
  if (!metadata.ok) throw new Error('无法读取引擎构建信息。');
  info = await metadata.json();
  send('ready', { info, memoryBytes: engine.memory.buffer.byteLength });
}

onmessage = ({ data }) => {
  try {
    if (!engine) return;
    if (data.type === 'reset') { reset(data); return; }
    if (data.runId !== runId) return;
    if (data.type === 'start') start();
    if (data.type === 'pause' && state === 'running') { stop(); setState('paused'); }
    if (data.type === 'speed') {
      speed = data.speed === 4 ? 4 : 1;
      if (state === 'running') { stop(); state = 'paused'; start(); }
    }
    if (data.type === 'benchmark' && state !== 'running') {
      const repeats = 3000, hr = frames.at(-1)?.heartRate || 90;
      engine.benchmark(100, hr); // JIT warm-up excluded from the measured batch.
      const t0 = performance.now();
      const checksum = engine.benchmark(repeats, hr);
      const totalMs = performance.now() - t0;
      send('benchmark', { repeats, totalMs, averageMs: totalMs / repeats, checksum, memoryBytes: engine.memory.buffer.byteLength });
    }
    if (data.type === 'export') send('export', { session: {
      schema: 1, inputSource: 'synthetic-project-mock', seed: 289, scenario,
      sampleRateHz: 16, windowFrames: 48, stepFrames: 16, elapsedSec: count / 16,
      state, engine: info, windows: records, segments,
      notice: '合成场景演示；候选评分不等于准确率；片段为当前时序解码结果，可能仍有修正。浏览器耗时不代表实板性能。',
    } });
  } catch (error) { fail(error); }
};
init().catch(fail);
