/* Offline regression tests for HD-AI synthetic CSV importer.
 * Usage: node tests/importer.test.js (Node.js >= 18)
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','importer.js'),'utf8');
const window={};
vm.runInNewContext(src,{window});
const imp=window.HDAIImporter;
const csv=imp.parseCSV('a,b\nx,"one,two"\ny,"quoted ""text"""\n');
assert.equal(csv.rows[0].b,'one,two');
assert.equal(csv.rows[1].b,'quoted "text"');
assert.throws(()=>imp.parseCSV('a,b\nx,"broken'),/引號/);
const A=[
{_line:2,patient_id:'P801',session_id:'S801',session_start:'2026-11-23T07:30',session_end:'2026-11-23T11:30',shift_code:'1',bed_id:'08',session_type:'routine',pre_sbp:'145'},
{_line:3,patient_id:'P802',session_id:'S802',session_start:'2026-11-23T12:30',session_end:'2026-11-23T16:30',shift_code:'2',bed_id:'08',session_type:'routine',pre_sbp:'155'}
];
const B=[
{_line:2,session_id:'S801',measured_at:'2026-11-23T07:30',sbp:'145',dbp:'80',hr:'74',ufr_ml_kg_h:'8'},
{_line:3,session_id:'S802',measured_at:'2026-11-23T12:30',sbp:'155',dbp:'80',hr:'75',ufr_ml_kg_h:'8'}
];
assert.equal(imp.inspect(A,B).ok,true,'valid two-shift same-bed sessions must be valid');
const missing=JSON.parse(JSON.stringify(B));missing[1].session_id='S999';
assert.equal(imp.inspect(A,missing).ok,false,'orphan measurements must be blocked');
const overlap=JSON.parse(JSON.stringify(A));overlap[1].session_start='2026-11-23T10:30';
assert.equal(imp.inspect(overlap,B).ok,false,'overlapping bed assignment must be blocked');
const impossible=JSON.parse(JSON.stringify(B));impossible[0].sbp='0';
assert.equal(imp.inspect(A,impossible).ok,false,'impossible SBP must be blocked');
const overnight=JSON.parse(JSON.stringify(A));overnight[1].session_end='2026-11-24T01:00';
assert.equal(imp.inspect(overnight,B).ok,false,'overnight sessions not supported in demo');
assert.equal(imp.stamp('2026-02-30T12:30'),null,'impossible calendar date must be blocked');
// ---- v1.0.1 regressions
assert.throws(()=>imp.parseCSV('a,b\n'),/只有標題列/,'header-only file must be rejected');
assert.equal(imp.inspect([],[]).ok,false,'empty import must be blocked');
assert.equal(imp.inspect(A,[B[0]]).ok,false,'session without any measurement must be blocked at check time');
const idh=JSON.parse(JSON.stringify(A));idh[0].idh_prev10_routine='4';idh[0].idh_prev10_all='2';
assert.equal(imp.inspect(idh,B).ok,false,'routine IDH count cannot exceed all-session count');
const mixed=JSON.parse(JSON.stringify(A));mixed[1].session_start='2026-11-23T12:30+08:00';mixed[1].session_end='2026-11-23T16:30+08:00';
const mixedB=JSON.parse(JSON.stringify(B));mixedB[1].measured_at='2026-11-23T12:30+08:00';
assert.equal(imp.inspect(mixed,mixedB).ok,false,'timezone style must be consistent across the batch');
const slash=imp.stamp('2026/11/23 07:30');
assert.equal(slash&&slash.date,'2026-11-23','Excel-style slash dates are accepted');
assert.equal(slash.clock,'07:30');
assert.equal(imp.stamp('2026-11/23 07:30'),null,'mixed date separators are rejected');
assert.equal(imp.stamp('2026-11-23T07:30Z').style,'tz');
// same patient in two beds at once; three sessions on one bed where only the outer pair overlaps
const P=(id,pid,bed,s,e)=>({_line:2,patient_id:pid,session_id:id,session_start:'2026-11-23T'+s,session_end:'2026-11-23T'+e,shift_code:'X',bed_id:bed,session_type:'urgent',pre_sbp:'140'});
const V=(id,t)=>({_line:2,session_id:id,measured_at:'2026-11-23T'+t,sbp:'140',dbp:'80',hr:'70',ufr_ml_kg_h:'8'});
assert.equal(imp.inspect([P('S101','P101','01','08:00','10:00'),P('S102','P101','02','09:00','11:00')],[V('S101','08:00'),V('S102','09:00')]).ok,false,'same patient overlapping in two beds must be blocked');
assert.equal(imp.inspect([P('S201','P201','03','08:00','14:00'),P('S202','P202','03','09:00','10:00'),P('S203','P203','03','13:00','15:00')],[V('S201','08:00'),V('S202','09:00'),V('S203','13:00')]).errors.filter(e=>/S203/.test(e.msg)||e.msg.includes('S201')).length>0,true,'overlap with a long earlier session is still found');
assert.equal(imp.inspect([P('S301','P301','04','08:00','10:00'),P('S302','P302','04','10:00','12:00')],[V('S301','08:00'),V('S302','10:00')]).ok,true,'back-to-back sessions on one bed are valid');
console.log('HD-AI importer regression tests passed');
