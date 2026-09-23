import { classifyWindow } from './tiny_classifier.js';
import { CLASS_NAMES } from './config.js';

let injectedNativeBackend = null;

export const MODEL_BACKEND_STATUS = {
  active: 'tiny_classifier',
  nativeAvailable: false,
  note: 'Quick App JS uses tiny_classifier by default. A native/quantized backend can be registered via setNativeModelBackend() or exposed as globalThis.velamotionModel without changing MotionEngine/TRL/UI.',
};

export function setNativeModelBackend(backend) {
  injectedNativeBackend = backend || null;
}

function normalizeBackend(mod) {
  return mod && mod.default ? mod.default : mod;
}

function loadNativeBackend() {
  if (injectedNativeBackend) return normalizeBackend(injectedNativeBackend);
  try {
    const rootObj = typeof globalThis !== 'undefined' ? globalThis : null;
    if (rootObj && rootObj.velamotionModel) return normalizeBackend(rootObj.velamotionModel);
    if (rootObj && rootObj.__velamotionModel) return normalizeBackend(rootObj.__velamotionModel);
  } catch (e) {}
  return null;
}

function normalizeNativeResult(res) {
  if (!res || !Array.isArray(res.probs) || res.probs.length !== CLASS_NAMES.length) return null;
  const probs = res.probs.map((v) => Number(v));
  if (probs.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const sum = probs.reduce((acc, v) => acc + v, 0);
  if (!(sum > 0)) return null;
  const normalized = probs.map((v) => v / sum);
  let classIdx = Number.isInteger(res.classIdx) ? res.classIdx : -1;
  if (classIdx < 0 || classIdx >= CLASS_NAMES.length) {
    classIdx = normalized.reduce((best, value, idx, arr) => (value > arr[best] ? idx : best), 0);
  }
  return Object.assign({}, res, {
    classIdx,
    className: CLASS_NAMES[classIdx],
    confidence: normalized[classIdx],
    probs: normalized,
    features: res.features || {},
  });
}

export function classifyWindowWithBackend(samples, context, features) {
  const nativeBackend = loadNativeBackend();
  if (nativeBackend && nativeBackend.classifyWindow) {
    try {
      const res = normalizeNativeResult(nativeBackend.classifyWindow({ samples, context: context || {} }));
      if (res) {
        MODEL_BACKEND_STATUS.active = 'native_quantized_model';
        MODEL_BACKEND_STATUS.nativeAvailable = true;
        return res;
      }
      console.log('native model backend returned an invalid probability vector, fallback tiny_classifier');
    } catch (e) {
      console.log(`native model backend failed, fallback tiny_classifier: ${e && e.message ? e.message : e}`);
    }
  }
  MODEL_BACKEND_STATUS.active = 'tiny_classifier';
  MODEL_BACKEND_STATUS.nativeAvailable = false;
  return classifyWindow(samples, context, features);
}
