import { loadOptionalFeature } from './optional_features.js';
const vibrator = loadOptionalFeature('vibrator');

export function vibrate(mode) {
  try {
    if (vibrator && vibrator.vibrate) {
      vibrator.vibrate({ mode: mode || 'short' });
      return true;
    }
  } catch (e) {
    console.log(`system.vibrator unavailable: ${e && e.message ? e.message : e}`);
  }
  return false;
}

export function shouldShakeRiskCard(risk, alert) {
  return Boolean(
    risk &&
    risk.shouldVibrate &&
    (risk.level === 'warning' || risk.level === 'danger') &&
    alert &&
    alert.triggered &&
    alert.key === risk.key
  );
}

export function pulseWorkoutAlert(result, sample, zone, state) {
  if (!result || result.warmupFraction < 1) return { triggered: false };
  const now = state && state.now ? state.now : Date.now();
  const lastAt = state && state.lastAlertAtMs ? state.lastAlertAtMs : 0;
  const lastKey = state && state.lastAlertKey ? state.lastAlertKey : '';
  const risk = state && state.risk ? state.risk : null;
  const minGapMs = 18000;
  let key = '';
  let mode = 'short';
  let message = '';

  if (risk && risk.shouldVibrate && risk.key) {
    key = risk.key;
    // Wrist risk feedback is intentionally a short pulse. Severity remains in
    // the card copy/color; long vibration is too disruptive for this flow.
    mode = 'short';
    message = risk.message || risk.title || '训练风险提醒';
  } else if (zone && zone.level === 'peak') {
    key = 'peak_hr';
    mode = 'short';
    message = '心率过高，已触发短振提醒';
  } else if (zone && zone.level === 'hard') {
    key = 'hard_hr';
    mode = 'short';
    message = '进入高强度区，已触发短振提醒';
  } else if (result.classIdx > 0 && result.confidence >= 0.45) {
    key = `activity_${result.classIdx}`;
    mode = 'short';
    message = `${result.className}片段稳定，已触发短振提醒`;
  }

  if (!key) return { triggered: false };
  if (key === lastKey && now - lastAt < minGapMs) return { triggered: false, key };
  if (key !== lastKey && now - lastAt < 5000) return { triggered: false, key };

  const ok = vibrate(mode);
  return { triggered: true, key, mode, message, available: ok };
}
