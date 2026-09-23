import assert from 'node:assert/strict';
import { TouchGesture } from '../src/common/ui/touch_gesture.js';

const touch = (x, y, id = 0) => ({ clientX: x, clientY: y, identifier: id });
const start = (x, y) => ({ touches: [touch(x, y)] });
const release = (x, y) => ({ touches: [], changedTouches: [touch(x, y)] });
const g = new TouchGesture();
let checks = 0;
function check(name, fn) { g.cancel(); fn(); checks++; console.log('PASS ' + name); }

check('left and right swipes navigate once', () => {
  g.begin(start(310, 200), '', 1000);
  assert.deepEqual(g.move(start(230, 201)), { pageDelta: 1 });
  assert.equal(g.end(release(90, 208), 1800), null);
  assert.equal(g.end(release(90, 208), 1800), null);
  g.begin(start(90, 200), '', 2000);
  assert.deepEqual(g.end(release(300, 202), 2400), { pageDelta: -1 });
});
check('button action waits for release, bubbling cannot double fire', () => {
  g.begin(start(195, 330), 'toggleRunning', 1000);
  g.begin(start(195, 330), '', 1001);
  assert.deepEqual(g.end(release(198, 333), 1150), { action: 'toggleRunning' });
  assert.equal(g.end(release(198, 333), 1151), null);
});
check('swiping from a destructive button cancels its action', () => {
  g.begin(start(310, 330), 'clearHistory', 1000);
  assert.deepEqual(g.move(start(220, 334)), { pageDelta: 1 });
  assert.equal(g.end(release(90, 331), 1700), null);
});
check('vertical scroll stays vertical even when the path bends', () => {
  g.begin(start(195, 260), 'stopSession', 1000);
  g.move(start(195, 210));
  assert.equal(g.end(release(340, 205), 1800), null);
});
check('short drag, diagonal and returning drag cannot activate', () => {
  for (const end of [[170, 330], [90, 210]]) {
    g.begin(start(195, 330), 'toggleRunning', 1000);
    assert.equal(g.end(release(...end), 1500), null);
  }
  g.begin(start(195, 330), 'clearHistory', 2000);
  g.move(start(230, 330));
  assert.equal(g.end(release(195, 330), 2300), null);
});
check('slow event dispatch during inference does not drop taps or swipes', () => {
  g.begin(start(195, 330), 'toggleRunning', 1000);
  g.begin(start(195, 330), '', 1800);
  assert.deepEqual(g.end(release(195, 330), 6000), { action: 'toggleRunning' });
  g.begin(start(300, 200), '', 8000);
  assert.deepEqual(g.move(start(200, 202)), { pageDelta: 1 });
  assert.equal(g.end(release(90, 204), 14000), null);
});
check('missing coordinates, multiple fingers and interrupted gestures cancel', () => {
  g.begin(start(300, 200), '', 1000);
  assert.equal(g.end({ touches: [], changedTouches: [] }, 1500), null);
  g.begin(start(300, 200), 'toggleRunning', 1000);
  g.move({ touches: [touch(290, 200), touch(100, 100, 1)] });
  assert.equal(g.end(release(100, 200), 1500), null);
  g.begin(start(300, 200), '', 1000);
  g.cancel();
  assert.equal(g.end(release(100, 200), 1500), null);
});
console.log(`All ${checks} gesture checks passed`);
