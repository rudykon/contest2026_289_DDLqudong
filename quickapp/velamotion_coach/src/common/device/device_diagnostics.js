import { getRecentHealth, ALL_HEALTH_TYPES } from '../sensor/health_provider.js';
import { vibrate } from './vibration_provider.js';

function pass(name, detail) { return { name, status: '通过', detail: detail || '' }; }
function warn(name, detail) { return { name, status: '边界', detail: detail || '' }; }
function fail(name, detail) { return { name, status: '失败', detail: detail || '' }; }

function resolveOnceWithTimeout(resolve, timeoutValue, timeoutMs) {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish(timeoutValue), timeoutMs || 2500);
  return finish;
}

function loadSystemFeature(name) {
  try {
    if (typeof require !== 'function') return null;
    let mod = null;
    if (name === 'device') mod = require('@system.device');
    else if (name === 'battery') mod = require('@system.battery');
    else if (name === 'sensor') mod = require('@system.sensor');
    return mod && mod.default ? mod.default : mod;
  } catch (e) {
    console.log(`system feature ${name} dynamic load failed: ${e && e.message ? e.message : e}`);
  }
  return null;
}

function getDeviceInfo() {
  return new Promise((resolve) => {
    const done = resolveOnceWithTimeout(resolve, warn('屏幕/设备', '2.5s 内无回调；需真机复测'), 2500);
    const device = loadSystemFeature('device');
    if (!device || !device.getInfo) {
      done(warn('屏幕/设备', 'system.device unavailable'));
      return;
    }
    try {
      device.getInfo({
        success: (data) => done(pass('屏幕/设备', `${data.deviceType || '--'} · ${data.screenWidth || '--'}x${data.screenHeight || '--'} · ${data.screenShape || 'unknown'}`)),
        fail: (data, code) => done(fail('屏幕/设备', `code=${code}`)),
        complete: () => {},
      });
    } catch (e) {
      done(fail('屏幕/设备', e && e.message ? e.message : String(e)));
    }
  });
}

function normalizeBatteryLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1) return Math.round(n * 100);
  return Math.round(n);
}

function getBatteryInfo() {
  return new Promise((resolve) => {
    const done = resolveOnceWithTimeout(resolve, warn('电量/功耗基线', '2.5s 内无回调；真实功耗需真机复测'), 2500);
    const battery = loadSystemFeature('battery');
    if (!battery || !battery.getStatus) {
      done(warn('电量/功耗基线', 'system.battery unavailable；真实功耗需真机复测'));
      return;
    }
    try {
      battery.getStatus({
        success: (data) => done(pass('电量/功耗基线', `${normalizeBatteryLevel(data.level)}% · ${data.charging ? '充电中' : '未充电'}；真实功耗需 15min 以上真机复测`)),
        fail: (data, code) => done(fail('电量/功耗基线', `code=${code}`)),
        complete: () => {},
      });
    } catch (e) {
      done(fail('电量/功耗基线', e && e.message ? e.message : String(e)));
    }
  });
}

function probeHealth() {
  return getRecentHealth(ALL_HEALTH_TYPES).then((list) => {
    if (!list || list.length === 0) return warn('service.health', '未返回 HEART_RATE/SPO2/STRESS；模拟器会降级到 Mock');
    const text = list.map((it) => `${it.dataType}:${Math.round(it.value || 0)}`).join(' ');
    return pass('service.health', text);
  }).catch((e) => fail('service.health', e && e.message ? e.message : String(e)));
}

function probeAccelerometer() {
  return new Promise((resolve) => {
    const sensor = loadSystemFeature('sensor');
    if (!sensor || !sensor.subscribeAccelerometer) {
      resolve(warn('真实 ACC', 'system.sensor accelerometer unavailable'));
      return;
    }
    let count = 0;
    let last = null;
    try {
      sensor.subscribeAccelerometer({
        interval: 'game',
        callback: (ret) => {
          count += 1;
          last = ret;
        },
      });
      setTimeout(() => {
        try { sensor.unsubscribeAccelerometer && sensor.unsubscribeAccelerometer(); } catch (e) {}
        if (count > 0) resolve(pass('真实 ACC', `${count} 帧 · ${Number(last.x || 0).toFixed(2)}/${Number(last.y || 0).toFixed(2)}/${Number(last.z || 0).toFixed(2)}`));
        else resolve(warn('真实 ACC', '1.2s 内无回调；检查权限/真机传感器'));
      }, 1200);
    } catch (e) {
      resolve(fail('真实 ACC', e && e.message ? e.message : String(e)));
    }
  });
}

function probeStepCounter() {
  return new Promise((resolve) => {
    const sensor = loadSystemFeature('sensor');
    if (!sensor || !sensor.subscribeStepCounter) {
      resolve(warn('真实步数', '当前 JS 引擎无 subscribeStepCounter'));
      return;
    }
    let got = false;
    let steps = 0;
    try {
      sensor.subscribeStepCounter({
        callback: (ret) => {
          got = true;
          steps = ret && ret.steps ? ret.steps : 0;
        },
      });
      setTimeout(() => {
        try { sensor.unsubscribeStepCounter && sensor.unsubscribeStepCounter(); } catch (e) {}
        resolve(got ? pass('真实步数', `累计 ${steps}`) : warn('真实步数', '1.2s 内无回调；手环/手表上需走动复测'));
      }, 1200);
    } catch (e) {
      resolve(fail('真实步数', e && e.message ? e.message : String(e)));
    }
  });
}

function probeVibration() {
  const ok = vibrate('short');
  return ok ? warn('腕上振动', '已请求 short；是否有触感必须在真机人工确认') : warn('腕上振动', '接口不可用或模拟器无触感');
}

export function runDeviceDiagnostics(callback) {
  const rows = [warn('真实 GYRO', '当前公开 JS sensor 类型未提供 gyroscope 订阅；需真机 SDK 或原生适配层')];
  Promise.all([getDeviceInfo(), getBatteryInfo(), probeHealth(), probeAccelerometer(), probeStepCounter()])
    .then((list) => {
      const out = list.concat([probeVibration()]).concat(rows);
      callback && callback(out);
    })
    .catch((e) => callback && callback([fail('真机诊断', e && e.message ? e.message : String(e))]));
}
