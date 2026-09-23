import storage from '@system.storage';

const STORAGE_KEY = 'velamotion.sessions.v1';
const MAX_SESSIONS = 8;
const sessions = [];
let memoryRevision = 0;

function replaceMemory(items) {
  sessions.splice(0, sessions.length);
  (items || []).slice(0, MAX_SESSIONS).forEach((it) => sessions.push(it));
}

function parseList(raw) {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.log(`session storage parse failed: ${e && e.message ? e.message : e}`);
    return [];
  }
}

function persist(callback) {
  const done = callback || function noop() {};
  try {
    if (!storage || !storage.set) {
      done(false);
      return;
    }
    const started = Date.now();
    const value = JSON.stringify(sessions.slice(0, MAX_SESSIONS));
    const serialized = Date.now();
    storage.set({
      key: STORAGE_KEY,
      value,
      success: () => {
        console.log(`VMC_HISTORY_STORAGE_SET count=${sessions.length}`);
        done(true);
      },
      fail: (data, code) => {
        console.log(`session storage set failed: ${code}`);
        done(false);
      },
      complete: () => {},
    });
    console.warn('VMC_STORE stringify_ms=' + (serialized-started) + ' submit_ms=' + (Date.now()-serialized) + ' chars=' + value.length);
  } catch (e) {
    console.log(`session storage unavailable: ${e && e.message ? e.message : e}`);
    done(false);
  }
}

export function loadSessions(callback) {
  const requestedRevision = memoryRevision;
  try {
    if (!storage || !storage.get) {
      if (callback) callback(listSessions());
      return;
    }
    storage.get({
      key: STORAGE_KEY,
      default: '[]',
      success: (data) => {
        if (requestedRevision === memoryRevision) replaceMemory(parseList(data));
        console.log(`VMC_HISTORY_STORAGE_GET count=${sessions.length}`);
        if (callback) callback(listSessions());
      },
      fail: (data, code) => {
        console.log(`session storage get failed: ${code}`);
        if (callback) callback(listSessions());
      },
      complete: () => {},
    });
  } catch (e) {
    console.log(`session storage load unavailable: ${e && e.message ? e.message : e}`);
    if (callback) callback(listSessions());
  }
}

export function saveSession(summary, callback) {
  const item = Object.assign({ id: `session_${Date.now()}`, savedAt: Date.now() }, summary || {});
  sessions.unshift(item);
  if (sessions.length > MAX_SESSIONS) sessions.pop();
  memoryRevision += 1;
  console.log(`VMC_HISTORY_SAVE count=${sessions.length}`);
  persist(callback);
  return item;
}

export function listSessions() {
  return sessions.slice();
}

export function clearSessions(callback) {
  replaceMemory([]);
  memoryRevision += 1;
  try {
    if (storage && storage.delete) {
      storage.delete({
        key: STORAGE_KEY,
        success: () => {
          console.log('VMC_HISTORY_STORAGE_CLEAR');
          callback && callback([]);
        },
        fail: () => {
          persist();
          if (callback) callback([]);
        },
        complete: () => {},
      });
      return;
    }
  } catch (e) {
    console.log(`session storage clear unavailable: ${e && e.message ? e.message : e}`);
  }
  persist();
  if (callback) callback([]);
}
