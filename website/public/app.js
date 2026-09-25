import { CLASS_NAMES } from './lib/config.js';

const $ = id => document.getElementById(id);
const colors = ['#82917d', '#b66d48', '#639055', '#a08a3f', '#28765a', '#8275a9'];
const clock = sec => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const timeText = ms => ms < .01 ? '< 0.01 ms' : `${ms.toFixed(2)} ms`;
let worker, ready = false, state = 'loading', runId = 0, bootId = 0, timer;
let last = null, benchmarkBusy = false, drawPending = false;

const rows = CLASS_NAMES.map((name, i) => {
  const row = document.createElement('div'); row.className = 'prob-row';
  const label = document.createElement('span'); label.textContent = name;
  const track = document.createElement('div'); track.className = 'prob-track';
  const bar = document.createElement('div'); bar.className = 'prob-fill'; bar.style.background = colors[i]; track.append(bar);
  const value = document.createElement('output'); value.textContent = '—'; row.append(label, track, value);
  $('probabilities').append(row); return { row, bar, value };
});

function send(type, extra = {}) { worker?.postMessage({ type, runId, ...extra }); }
function controls() {
  const label = state === 'running' ? '暂停演示 Ⅱ' : state === 'paused' ? '继续演示 ▶' : state === 'done' ? '再试一次 ↺' : '开始演示 ▶';
  $('start').textContent = label; $('watch-start').textContent = ready ? label : state === 'error' ? '引擎加载失败' : '加载引擎…';
  $('start').disabled = $('watch-start').disabled = !ready || benchmarkBusy;
  $('reset').disabled = !ready || benchmarkBusy;
  $('benchmark').disabled = !ready || state === 'running' || benchmarkBusy;
  $('benchmark').textContent = benchmarkBusy ? '正在本机计算…' : '测一下本机算力 ↗';
  $('export-session').disabled = !ready || !last?.windows;
  $('scenario').disabled = $('speed').disabled = benchmarkBusy;
}
function reset() {
  runId++; last = null; state = ready ? 'idle' : state; benchmarkBusy = false;
  ['elapsed', 'watch-duration', 'watch-clock'].forEach(id => { $(id).textContent = '00:00'; });
  $('window-count').textContent = '0'; $('inference-time').textContent = '—';
  $('sample-count').textContent = '0 / 48 帧'; $('result-state').textContent = ready ? '等待开始' : '引擎加载中';
  $('result-name').textContent = '准备就绪'; $('result-score').textContent = $('watch-confidence').textContent = '—';
  $('watch-class').textContent = '跟上你的节奏'; $('watch-caption').textContent = '准备好，动起来';
  $('input-stage').textContent = '等待开始 · 先积累 3 秒窗口';
  $('segment-count').textContent = '尚无片段'; $('timeline').replaceChildren();
  const hint = document.createElement('p'); hint.textContent = '开始训练后，活动片段会出现在这里。推荐以 4× 速度体验混合训练。'; $('timeline').append(hint);
  $('session-note').textContent = '使用项目原有的平滑与时序解码，片段会随新窗口修正。';
  rows.forEach(({ row, bar, value }) => { row.classList.remove('winner'); bar.style.width = '0'; value.textContent = '—'; });
  if (ready) send('reset', { scenario: $('scenario').value, speed: Number($('speed').value) });
  controls(); queueDraw();
}
function toggle() {
  if (!ready || benchmarkBusy) return;
  if (state === 'done') reset();
  send(state === 'running' ? 'pause' : 'start');
}
function render(data) {
  last = data;
  ['elapsed', 'watch-duration', 'watch-clock'].forEach(id => { $(id).textContent = clock(data.elapsed); });
  $('window-count').textContent = data.windows;
  $('sample-count').textContent = `${Math.min(48, data.count)} / 48 帧`;
  $('input-stage').textContent = `模拟输入：${data.stage} · ${clock(data.elapsed)} / ${clock(data.total)}`;
  $('watch-caption').textContent = data.result ? '当前活动候选' : '正在积累运动信号';
  if (data.result) {
    const result = data.result;
    $('result-name').textContent = $('watch-class').textContent = result.className;
    $('result-state').textContent = 'WASM 窗口候选';
    $('result-score').textContent = $('watch-confidence').textContent = `${(result.confidence * 100).toFixed(1)}%`;
    $('inference-time').textContent = timeText(result.ms);
    rows.forEach(({ row, bar, value }, i) => {
      row.classList.toggle('winner', i === result.classIdx);
      bar.style.width = `${result.probs[i] * 100}%`; value.textContent = `${(result.probs[i] * 100).toFixed(1)}%`;
    });
  } else { $('result-state').textContent = '积累首个 3 秒窗口'; }
  $('segment-count').textContent = `${data.segments.length} 个片段`;
  $('timeline').replaceChildren();
  if (!data.segments.length) {
    const hint = document.createElement('p'); hint.textContent = data.windows ? '等待稳定的运动片段；静止时段不会列为训练。' : '正在积累信号，首个窗口需要 3 秒演示时间。'; $('timeline').append(hint);
  } else {
    for (const segment of data.segments) {
      const block = document.createElement('div'); block.className = 'segment';
      block.style.setProperty('--seg-color', colors[segment.classIdx] + '26');
      block.style.flexGrow = segment.durationSec;
      const name = document.createElement('b'); name.textContent = segment.className;
      const duration = document.createElement('span'); duration.textContent = `${clock(segment.startSec)}–${clock(segment.endSec)}`;
      block.append(name, duration); $('timeline').append(block);
    }
  }
  controls(); queueDraw();
}

function draw(canvas, offset, min, max) {
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (!rect.width || !rect.height) return;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, left = 32, right = w - 8, top = 12, bottom = h - 16;
  const frames = last?.frames || [];
  for (const f of frames) for (let c = offset; c < offset + 3; c++) { min = Math.min(min, f[c]); max = Math.max(max, f[c]); }
  min = Math.floor(min); max = Math.ceil(max);
  const y = v => bottom - (v - min) / (max - min) * (bottom - top);
  ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#7a897e'; ctx.strokeStyle = '#e3e9df'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.fillText(String(Math.round(v)), 2, yy + 3);
  }
  for (let i = 0; i <= 3; i++) {
    const x = left + (right - left) * i / 3;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillText(`${i - 3}s`, Math.min(x, right - 14), h - 1);
  }
  const lineColors = ['#367962', '#b89348', '#9294bd'];
  for (let c = 0; c < 3; c++) {
    ctx.strokeStyle = lineColors[c]; ctx.lineWidth = 1.8; ctx.beginPath();
    frames.forEach((f, i) => { const x = left + (i + 48 - frames.length) / 47 * (right - left); i ? ctx.lineTo(x, y(f[c + offset])) : ctx.moveTo(x, y(f[c + offset])); }); ctx.stroke();
  }
}
function queueDraw() {
  if (drawPending) return; drawPending = true;
  requestAnimationFrame(() => { drawPending = false; draw($('signal-canvas'), 0, -5, 15); draw($('gyro-canvas'), 3, -3, 3); });
}
function fail(message) {
  clearTimeout(timer); worker?.terminate(); ready = false; state = 'error'; benchmarkBusy = false;
  $('engine-error').hidden = false; $('engine-error-message').textContent = `演示引擎暂不可用：${message} 你仍可浏览作品介绍与实板照片。`;
  $('engine-status').textContent = 'WASM 未就绪'; $('engine-status').classList.add('error');
  $('result-state').textContent = '计算已停止'; controls();
}
function boot() {
  clearTimeout(timer); worker?.terminate(); const currentBoot = ++bootId;
  ready = false; state = 'loading'; reset();
  $('engine-error').hidden = true; $('engine-status').classList.remove('error'); $('engine-status').textContent = '正在加载 WASM';
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    timer = setTimeout(() => fail('加载超时，请检查网络后重试。'), 20000);
    worker.onerror = () => { if (currentBoot === bootId) fail('浏览器未能启动计算线程。'); };
    worker.onmessage = ({ data }) => {
      if (currentBoot !== bootId) return;
      if (data.type === 'ready') {
        clearTimeout(timer); ready = true; state = 'idle';
        $('engine-status').textContent = '● WASM 已就绪 · 本地运行';
        $('wasm-size').textContent = `引擎 ${(data.info.wasmBytes / 1024).toFixed(1)} KB。`;
        reset(); return;
      }
      if (data.type === 'error') { fail(data.message); return; }
      if (data.runId !== runId) return;
      if (data.type === 'data') render(data);
      if (data.type === 'state') {
        state = data.state;
        if (state === 'done') $('session-note').textContent = '本次演示完成。可以导出结果，或换一个场景继续体验；末尾片段为当前解码结果。';
        if (state === 'paused') $('session-note').textContent = '演示已暂停，继续后会从当前窗口接着计算。';
        if (state === 'running') $('session-note').textContent = '正在本地计算；片段会随新窗口修正。切到后台自动暂停。';
        controls();
      }
      if (data.type === 'benchmark') {
        benchmarkBusy = false;
        $('benchmark-result').textContent = `${data.repeats.toLocaleString()} 次 / ${data.totalMs.toFixed(1)} ms · 平均 ${data.averageMs.toFixed(4)} ms / 窗口`;
        $('benchmark-result').title = '相同输入窗口的 WASM 内核批量计时，不含页面绘制与 JS 时序解码。受设备、浏览器和计时精度影响，不能代表板端性能。';
        controls();
      }
      if (data.type === 'export') {
        const blob = new Blob([JSON.stringify(data.session, null, 2) + '\n'], { type: 'application/json' });
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = `velamotion-demo-${data.session.scenario}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    };
  } catch (error) { fail(error.message); }
}

$('start').addEventListener('click', toggle); $('watch-start').addEventListener('click', toggle);
$('hero-start').addEventListener('click', () => { if (ready && state !== 'running') toggle(); });
$('reset').addEventListener('click', reset); $('scenario').addEventListener('change', reset);
$('speed').addEventListener('change', () => send('speed', { speed: Number($('speed').value) }));
$('benchmark').addEventListener('click', () => { benchmarkBusy = true; controls(); send('benchmark'); });
$('export-session').addEventListener('click', () => send('export'));
$('retry-engine').addEventListener('click', boot);
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'running') send('pause'); });
addEventListener('pagehide', () => { if (state === 'running') send('pause'); });
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(queueDraw).observe($('signal-canvas').parentElement);
else addEventListener('resize', queueDraw);
boot();
