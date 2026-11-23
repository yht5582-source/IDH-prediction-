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
vm.runInNewContext(src,{window,Set,Map,Number,Date,String,Object,Error});
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
console.log('HD-AI v0.9 importer regression tests passed');
