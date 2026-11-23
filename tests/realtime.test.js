/* Offline regression tests for HD-AI synthetic playback controller.
 * Usage: node tests/realtime.test.js (Node.js >= 18)
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const window={};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','realtime.js'),'utf8'),{window,setInterval,clearInterval});
const RT=window.HDAIRealtime;
const v=(time,sbp,ufr)=>({time,sbp,dbp:60,hr:80,reason:'常規每小時',ufr});
function fixture(){return [
 {id:'S1',patientId:'P1',bed:'01',date:'2026-11-23',shift:'X',start:'12:30',end:'16:30',ufr:11,
  // deliberately unsorted: a manual extra reading appended after the hourly ones
  values:[v('12:30',155,9),v('13:30',138,9),v('14:45',88,11),v('14:30',105,10)]},
 {id:'S2',patientId:'P2',bed:'02',date:'2026-11-23',shift:'X',start:'14:00',end:'18:00',ufr:8,values:[v('14:00',140),v('15:00',132)]},
 {id:'S3',patientId:'P3',bed:'03',date:'2026-11-23',shift:'1',start:'07:30',end:'11:30',ufr:8,values:[v('07:30',150)]}
];}
// same thresholds as the page: <90 => 3, <110 => 2 here for test purposes
const rank=s=>{const l=s.values[s.values.length-1];return l.sbp<90?3:l.sbp<110?2:0};
let sessions=fixture(),last=null,refreshes=0;
const ctl=RT.createController({getSessions:()=>sessions,rank,refresh:st=>{last=st;refreshes++},error:m=>{throw Error(m)}});
assert.throws(()=>ctl.step(15),/請先開始/);
assert.throws(()=>ctl.begin('2026-11-23','3'),/沒有可播放/);
assert.equal(ctl.isActive(),false,'failed begin leaves controller inactive');

let st=ctl.begin('2026-11-23','X');
assert.equal(st.time,'12:30');
assert.equal(sessions[0].values.length,1,'only readings up to the simulated clock are visible');
assert.equal(sessions[0].ufr,9,'UFR follows the simulated clock, not the end-of-session value');
assert.equal(sessions[1].values.length,0,'session that has not started has no readings (must not crash)');
assert.equal(st.waiting,1);assert.equal(st.missing,0);
assert.equal(sessions[2].values.length,1,'other shifts are untouched');

for(let i=0;i<8;i++)st=ctl.step(15);           // 14:30
assert.equal(st.time,'14:30');
assert.equal(sessions[0].values[sessions[0].values.length-1].sbp,105,'unsorted source readings are replayed in time order');
assert.equal(st.alerts.length,1);assert.equal(st.alerts[0].level,2);assert.equal(st.alerts[0].sbp,105);
st=ctl.step(15);                               // 14:45
assert.equal(st.alerts.length,2,'escalation raises a new alert');
assert.equal(st.alerts[0].level,3);assert.equal(st.alerts[0].measuredAt,'14:45');
assert.equal(sessions[0].ufr,11);
st=ctl.step(15);
assert.equal(st.alerts.length,2,'no duplicate alert while the level is unchanged');

assert.equal(ctl.acknowledge(st.alerts[1].id).ack,true);
assert.equal(ctl.acknowledgeSession('S1','通知醫師'),1,'session-level ack clears remaining alerts');
assert.equal(ctl.snapshot().alerts.every(a=>a.ack),true);
assert.throws(()=>ctl.acknowledge('A999'),/找不到/);

for(let i=0;i<40;i++)st=ctl.step(15);
assert.equal(st.time,'18:00','clock stops at the end of the last session');
assert.equal(st.finished,true);
assert.equal(st.stale,1,'only in-progress sessions count as stale');

ctl.reset();
assert.equal(ctl.isActive(),false);
assert.deepEqual(sessions.map(s=>s.values.length),[4,2,1],'reset restores every reading');
assert.equal(sessions[0].ufr,11,'reset restores session UFR');
assert.equal(last.alerts.length,0);

// data replaced while playing (CSV import): reset must not write old readings into new sessions
ctl.begin('2026-11-23','X');sessions=[{id:'S9',patientId:'P9',bed:'09',date:'2026-11-23',shift:'X',start:'08:00',end:'12:00',ufr:8,values:[v('08:00',150)]}];
ctl.reset();assert.equal(sessions[0].values.length,1);
assert.equal(RT.clock(1500),'01:00');
console.log('HD-AI playback regression tests passed');
