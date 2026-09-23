import assert from 'node:assert/strict';
import { LivePatchBuffer, PAGE_LIVE_KEYS } from '../src/common/ui/live_patch.js';
import { InteractionScheduler } from '../src/common/ui/interaction_scheduler.js';
import fs from 'node:fs';
import { createImuFeatureWork, computeImuFeatures } from '../src/common/algorithm/imu_features.js';

const original = { elapsedText: '0:03', rows: [{ name: '跑步', percent: 80 }] };
const writes = [];
const vm = { pageVisible: true, live: new Proxy(original, {
  set(target, key, value) { writes.push(key); target[key] = value; return true; },
}) };
const buffer = new LivePatchBuffer();
const rowIdentity = vm.live.rows;
buffer.commit(vm, { elapsedText: '0:04', rows: [{ name: '跑步', percent: 80 }] });
assert.deepEqual(writes, ['elapsedText']);
assert.equal(vm.live.rows, rowIdentity);
writes.length = 0;
vm.pageVisible = false;
buffer.commit(vm, { ...buffer.current(vm), elapsedText: '0:05' });
buffer.commit(vm, { ...buffer.current(vm), elapsedText: '0:06', rows: [{ name: '跳绳', percent: 90 }] });
assert.deepEqual(writes, [], 'hidden updates must never touch reactive state');
assert.equal(vm.live.elapsedText, '0:04');
assert.equal(buffer.current(vm).elapsedText, '0:06');
vm.pageVisible = true;
buffer.flush(vm);
assert.equal(vm.live.elapsedText, '0:06');
assert.equal(vm.live.rows[0].name, '跳绳');
assert.deepEqual(writes, ['elapsedText']);
assert.equal(vm.live.rows, rowIdentity, 'updates must retain the native list owner');
writes.length = 0;
buffer.flush(vm);
assert.deepEqual(writes, [], 'resume replays the latest state exactly once');

const pages = new LivePatchBuffer((vm) => vm.pageState.index === 0 ? ['elapsedText'] : ['rows']);
vm.pageState = { index: 0 };
pages.commit(vm, { elapsedText: '0:07', rows: [{ name: '静坐', percent: 99 }] });
assert.equal(vm.live.rows[0].name, '跳绳', 'cached hidden page must not receive list changes');
assert.equal(pages.current(vm).rows[0].name, '静坐', 'canonical training state must stay current');
vm.pageState.index = 1;
pages.flush(vm);
assert.equal(vm.live.rows[0].name, '静坐', 'navigation must publish the latest values');

let dragging = true;
const dragBuffer = new LivePatchBuffer(null, () => !dragging);
const rowBeforeDrag = vm.live.rows[0];
dragBuffer.commit(vm, { rows: [{ name: '跑步', percent: 70 }], elapsedText: '0:08' });
assert.equal(vm.live.rows[0].name, '静坐', 'a live result must not mutate the gesture owner');
dragging = false;
dragBuffer.flush(vm);
assert.equal(vm.live.rows[0], rowBeforeDrag, 'row objects must stay stable after release');
assert.equal(vm.live.rows[0].name, '跑步');

const source = fs.readFileSync(new URL('../src/pages/index/index.ux', import.meta.url), 'utf8').split('</template>')[0];
const bounds = ['home-screen', 'ai-screen', 'timeline-screen', 'sync-screen', 'global-stop'];
for (let i = 0; i < 4; i++) {
  const template = source.slice(source.indexOf(bounds[i]), source.indexOf(bounds[i + 1]));
  const used = [...new Set([...template.matchAll(/live\.(\w+)/g)].map(match => match[1]))].sort();
  assert.deepEqual([...PAGE_LIVE_KEYS[i]].sort(), used, 'every visible binding must be refreshed');
}

let now = 0, fired = 0;
const tasks = [];
const scheduler = new InteractionScheduler({ now: () => now, timer: (fn, delay) => tasks.push({ fn, at: now + delay }) });
scheduler.schedule(() => fired++);
scheduler.touch();
now = 16;
tasks.shift().fn();
assert.equal(fired, 0, 'a touch must defer an already queued compute slice');
assert.equal(tasks[0].at, 200);
now = 100;
scheduler.touch();
now = 200;
tasks.shift().fn();
assert.equal(fired, 0, 'continued gesture must extend input priority');
now = 300;
tasks.shift().fn();
assert.equal(fired, 1, 'compute must resume once input settles');

// Compare sliced and synchronous paths, including an empty and partial window.
for (const size of [0, 1, 7, 8, 9, 48, 96]) {
  const samples = Array.from({ length: size }, (_, i) => ({
    accX: Math.sin(i) * 2, accY: Math.cos(i), accZ: 9.81,
    gyroX: i / 100, gyroY: -i / 100, gyroZ: Math.sin(i / 3),
  }));
  const expected = computeImuFeatures(samples);
  const work = createImuFeatureWork(samples);
  let turns = 1;
  while (!work.step()) turns++;
  assert.deepEqual(work.result, expected);
  assert.ok(turns >= Math.ceil(size / 8) + 1);
  assert.equal(work.step(), true, 'completed work is idempotent');
}
console.log('PASS selective updates, hidden coalescing, resume and sliced features');

// Exercise the production navigation and row-selection methods together.
// A hidden page must catch up immediately, without formatting every batch.
const pageSource = fs.readFileSync(new URL('../src/pages/index/index.ux', import.meta.url), 'utf8');
function pageMethod(name) {
  const start = pageSource.indexOf(`\n  ${name}(`) + 1;
  assert.ok(start > 0);
  return pageSource.slice(start, pageSource.indexOf('\n  },', start) + 4);
}
const stateStart = pageSource.indexOf('function pageStateFor(');
const stateFunction = pageSource.slice(stateStart, pageSource.indexOf('\n}\n', stateStart) + 2);
const calls = [];
const createPage = new Function('LivePatchBuffer', 'PAGE_LIVE_KEYS', 'calls', `
  const PAGE_NAMES = ['home','coach','timeline','sync'];
  const PAGE_COLORS = ['green','blue','purple','pink'];
  ${stateFunction}
  let lastResult = null;
  const touchGesture = { cancel() {} };
  const liveUpdates = new LivePatchBuffer(vm => PAGE_LIVE_KEYS[vm.pageState.index]);
  function probabilityRows(values) { calls.push('coach'); return values.map(percent => ({percent})); }
  function topCoachRows(rows) { return rows; }
  function segmentRows(values) { calls.push('timeline'); return values.map(label => ({label})); }
  function patchLive(vm, patch) { return liveUpdates.commit(vm, Object.assign({}, liveUpdates.current(vm), patch)); }
  return {
    pageVisible: true, pageState: pageStateFor(0),
    live: {coachClassRows: [], timelineRows: [], timelineEmpty: true},
    resetHistoryClear() {}, updateMotionChannels() {},
    setResult(value) { lastResult = value; },
    ${pageMethod('inferenceViewPatch')},
    ${pageMethod('setDemoPage')}
  };
`);
const pageVm = createPage(LivePatchBuffer, PAGE_LIVE_KEYS, calls);
const pageIdentity = pageVm.pageState;
pageVm.setResult({ probs: [70, 30], segments: ['running'] });
assert.deepEqual(pageVm.inferenceViewPatch(), {});
assert.deepEqual(calls, [], 'home must not format hidden lists');
pageVm.setDemoPage(1);
assert.equal(pageVm.pageState, pageIdentity, 'navigation must retain reactive state identity');
assert.deepEqual(pageVm.live.coachClassRows, [{percent:70}, {percent:30}]);
pageVm.setResult({ probs: [90, 10], segments: ['running', 'walking'] });
pageVm.setDemoPage(2);
assert.deepEqual(pageVm.live.timelineRows, [{label:'running'}, {label:'walking'}]);
assert.equal(pageVm.live.timelineEmpty, false);
pageVm.setDemoPage(1);
assert.equal(pageVm.live.coachClassRows[0].percent, 90, 'navigation must show the newest inference');
pageVm.pageVisible = false;
calls.length = 0;
assert.deepEqual(pageVm.inferenceViewPatch(), {});
assert.deepEqual(calls, [], 'background training must not format hidden UI');
console.log('PASS current inference on navigation and hidden-page formatting suppression');
