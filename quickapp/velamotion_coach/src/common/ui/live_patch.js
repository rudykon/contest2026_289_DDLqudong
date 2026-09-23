// Preserve reactive object/array identity when displayed values did not change.
// Replacing the entire live object wakes every binding on the watch runtime.
export function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(right, key) || !sameValue(left[key], right[key])) return false;
  }
  return true;
}

function updateValue(target, key, next) {
  const current = target[key];
  if (sameValue(current, next)) return;
  if (Array.isArray(current) && Array.isArray(next)) {
    // Keep each live row's native widget alive while values change. Replacing
    // a list during a drag can delete the widget that owns the touch stream.
    const common = Math.min(current.length, next.length);
    for (let i = 0; i < common; i++) {
      if (current[i] && next[i] && typeof current[i] === 'object' && typeof next[i] === 'object') {
        Object.keys(next[i]).forEach(field => updateValue(current[i], field, next[i][field]));
      } else if (!sameValue(current[i], next[i])) current.splice(i, 1, next[i]);
    }
    if (current.length > next.length) current.splice(next.length);
    for (let i = common; i < next.length; i++) current.push(next[i]);
  } else target[key] = next;
}

export class LivePatchBuffer {
  constructor(selectKeys, canPublish) {
    this.pending = null;
    this.selectKeys = selectKeys;
    this.canPublish = canPublish;
  }

  current(vm) { return this.pending || vm.live; }

  commit(vm, next) {
    this.pending = next;
    if (!vm.pageVisible || (this.canPublish && !this.canPublish())) {
      return next;
    }
    const current = vm.live;
    if (!current) vm.live = next;
    else (this.selectKeys ? this.selectKeys(vm) : Object.keys(next)).forEach((key) => {
      updateValue(current, key, next[key]);
    });
    return next;
  }

  flush(vm) { if (this.pending) this.commit(vm, this.pending); }
}

export const PAGE_LIVE_KEYS = [
  ['activityColor', 'activityEmoji', 'activityName', 'elapsedText', 'hrText', 'riskBgColor', 'riskColor', 'riskTitle', 'runMarkerColor', 'startButtonText', 'stepText', 'zoneInk', 'zoneText'],
  ['activityColor', 'activityEmoji', 'activityName', 'coachClassRows', 'coachTipLines', 'confidenceText', 'riskBgColor'],
  ['aiSummaryButtonText', 'aiSummaryLines', 'summaryActive', 'summaryActiveShare', 'summaryRisk', 'summarySegments', 'summaryTotal', 'timelineEmpty', 'timelineRows'],
  [],
];
