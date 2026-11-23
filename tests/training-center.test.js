/* Offline regression tests for the HD-AI training-center readiness audit.
 * Usage: node tests/training-center.test.js (Node.js >= 18)
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const window={};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','training-center.js'),'utf8'),{window});
const TC=window.HDAITrainingCenter;
const v=(time,sbp)=>({time,sbp,dbp:60,hr:80});
const S=(id,type,values,extra)=>Object.assign({id,patientId:'P'+id,date:'2026-11-23',type,start:'12:30',end:'16:30',values},extra||{});
// Same labelling rule as ml/train.py make_features: one landmark per at-risk reading with a full
// 60-minute horizon inside the session; positive when the first recorded SBP<90 falls in (t, t+60].
let a=TC.featureAudit([S('S1','routine',[v('12:30',155),v('13:30',138),v('14:30',105),v('14:45',88),v('15:30',110)])]).counts;
assert.equal(a.windows,3,'readings at/after the first SBP<90 are not new-onset landmarks');
assert.equal(a.positiveWindows,1,'only the 14:30 landmark sees the 14:45 event within 60 minutes');
assert.equal(a.idhs,1);assert.equal(a.measurements,5);
a=TC.featureAudit([S('S2','routine',[v('12:30',150),v('15:45',140),v('16:30',130)])]).counts;
assert.equal(a.windows,1,'landmarks without a full 60-minute horizon are excluded, not counted as negatives');
a=TC.featureAudit([S('S3','urgent',[v('12:30',80)]),S('S4','routine',[]),S('S4','routine',[v('12:30',150)]),null]).counts;
assert.equal(a.excluded,1,'non-routine sessions are excluded');assert.equal(a.routine,2);
assert.equal(a.duplicateIds,1);assert.equal(a.missingIds,1);assert.equal(a.noBP,1);assert.equal(a.idhs,0);
assert.equal(TC.featureAudit(null).counts.sessions,0,'missing input does not throw');
const r=TC.featureAudit([S('S5','routine',[v('12:30',150)])]);
assert.equal(r.ready,false,'the public demo never reports ready-to-train');
const plan=TC.trainingPlan({horizon:60,scope:'routine_outpatient_only'},r);
assert.equal(plan.model_status,'NOT_TRAINED');assert.equal(plan.prediction_horizon_minutes,60);
assert.equal(plan.current_demo_audit.eligible_windows,1);
console.log('HD-AI training-center regression tests passed');
