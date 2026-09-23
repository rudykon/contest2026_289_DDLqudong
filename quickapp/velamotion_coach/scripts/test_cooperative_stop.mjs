import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CooperativeSteps } from '../src/common/ui/cooperative_steps.js';
import { syncActionPermission } from '../src/common/ui/interaction_state.js';

function scheduler() {
  const tasks = [];
  const deps = { timer(fn) { const task={fn}; tasks.push(task); return task; }, clear(task) {task.cancelled=true;} };
  return {tasks, deps, tick() {const task=tasks.shift(); if(task && !task.cancelled) task.fn();},
    flush() {let count=0; while(tasks.length){assert.ok(++count<100); this.tick();}}};
}
const q=scheduler(), steps=new CooperativeSteps(q.deps), order=[];
assert.equal(steps.run([],()=>assert.fail()),true);
assert.equal(steps.pending,false);
steps.run([()=>order.push(1),()=>order.push(2)]);
assert.deepEqual(order,[]);
assert.equal(steps.run([()=>order.push(9)]),false);
q.tick(); assert.deepEqual(order,[1]);
steps.drain(); assert.deepEqual(order,[1,2]);
steps.run([()=>order.push(3)]); q.flush(); assert.deepEqual(order,[1,2,3]);
let error;
steps.run([()=>{throw new Error('failed');},()=>assert.fail()],e=>{error=e;});
q.flush(); assert.equal(error.message,'failed'); assert.equal(steps.pending,false);

const source=fs.readFileSync(new URL('../src/pages/index/index.ux',import.meta.url),'utf8');
function method(name) {
  const start=source.indexOf(`\n  ${name}(`)+1;
  assert.ok(start>0);
  return source.slice(start,source.indexOf('\n  },',start)+4);
}
const create=new Function('CooperativeSteps','deps','events','syncActionPermission',`
  let motionFx=null, pageDisposing=false, stopGeneration=0;
  const stopWork=new CooperativeSteps(deps);
  const inferenceRunner={cancel(){events.push('cancel');}};
  const provider={stop(){events.push('stop-provider');}};
  const mockProvider=provider, realProvider=provider, healthProvider=provider;
  let lastSample={}, lastResult={warmupFraction:1,segments:[{label:'running',start:0,end:10}]};
  const riskEvents=[{title:'risk'}], trendSamples=[1,2,3];
  let selectedSceneId='original-scene';
  let saved, callback;
  const PROCESSING_STATES={PENDING_SYNC:'pending',WATCH_SCREENING:'watch'};
  const console={log(value){events.push(value);},warn(value){events.push(value);}};
  function setTrainingScreenOn(){} function clearDemoSessionTimers(){}
  function motionNeutralFrame(){return {};}
  function secFromNow(){return 12;}
  function formatSec(sec){return String(sec);}
  function patchLive(vm,patch){Object.assign(vm.live,patch);}
  function buildSummary(){events.push('summary'); return {totalSec:12,activeSec:10,segmentCount:1};}
  function activityShareRowsFromSummary(){events.push('shares');return [{label:'running'}];}
  function intensityTrendRowsFromSamples(items){return items.slice();}
  function saveSession(record,done){events.push('save');saved=record;callback=done;}
  function listSessions(){return saved?[saved]:[];}
  const page={
    isRunning:true,isFinalizing:false,live:{startButtonText:'停止'},currentSceneName:'原场景',
    applyMotionFrame(){},updateMotionChannels(){},cancelAiSummary(){},setProcessingState(){},
    reviewPatch(summary){events.push('review');return {summaryActiveShare:'80%'};},
    applyHistory(){events.push('history');}, latestSession(){return saved || null;},
    ${method('stopSession')},${method('startSession')},${method('resetSession')},${method('clearHistory')},
    ${method('beginSyncOperation')}
  };
  return {page,get saved(){return saved;},complete(ok){callback(ok);},
    changeScene(){selectedSceneId='changed';page.currentSceneName='changed';},
    destroy(){pageDisposing=true;stopGeneration++;stopWork.drain();}};
`);
for(const persisted of [true,false]) {
  const queue=scheduler(), events=[], h=create(CooperativeSteps,queue.deps,events,syncActionPermission), vm=h.page;
  assert.equal(vm.stopSession(),true);
  assert.equal(vm.isRunning,false); assert.equal(vm.isFinalizing,true);
  assert.equal(vm.live.startButtonText,'保存中');
  assert.ok(events.includes('cancel')); assert.equal(events.filter(x=>x==='stop-provider').length,3);
  assert.ok(!events.includes('summary')); assert.equal(h.saved,undefined);
  assert.equal(vm.stopSession(),false); assert.equal(vm.startSession(),false);
  assert.equal(vm.resetSession(),false); assert.equal(vm.clearHistory(),false);
  assert.equal(vm.beginSyncOperation('send'),0,'must not send the previous session while finalizing');
  h.changeScene(); queue.tick(); assert.ok(events.includes('summary'));
  assert.ok(!events.includes('shares')); queue.flush();
  assert.equal(h.saved.sceneId,'original-scene'); assert.equal(h.saved.sceneName,'原场景');
  assert.deepEqual(h.saved.summary.intensityTrend,[1,2,3]);
  assert.equal(h.saved.segments.length,1); assert.equal(h.saved.summary.riskCount,1);
  assert.equal(vm.isFinalizing,true,'must wait for actual storage callback');
  assert.notEqual(vm.live.runStatusText,'训练已保存');
  h.complete(persisted); assert.equal(vm.isFinalizing,false);
  assert.equal(vm.live.runStatusText,persisted?'训练已保存':'仅内存保存');
  assert.equal(vm.live.startButtonText,'开始');
  h.complete(!persisted); assert.equal(events.filter(x=>x==='history').length,1);
}
{
  const queue=scheduler(),events=[],h=create(CooperativeSteps,queue.deps,events,syncActionPermission);
  h.page.stopSession(); h.destroy(); assert.ok(h.saved,'destroy must drain an accepted save');
  const before=JSON.stringify(h.page.live); h.complete(true);queue.flush();
  assert.equal(JSON.stringify(h.page.live),before,'destroyed page must not receive stale callbacks');
  assert.equal(events.filter(x=>x==='save').length,1);
}
console.log('PASS staged stop, real save completion, failed save, repeat guards, captured state and destruction');
