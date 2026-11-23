/* HD-AI XGBoost training center: synthetic-data readiness checks ONLY.
 * No data upload, persistence, network, model fit, probability scoring, or clinical use.
 */
(function(root){
'use strict';
function escapeHtml(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]})}
function minutes(t){var x=String(t||'').match(/^(\d\d):(\d\d)$/);return x?Number(x[1])*60+Number(x[2]):NaN}
function featureAudit(sessions){
 var counts={sessions:sessions.length,patients:new Set(),days:new Set(),routine:0,excluded:0,measurements:0,windows:0,positiveWindows:0,idhs:0,unknownCAN:0,duplicateIds:0,orphans:0,invalidTime:0,invalidBP:0};
 var ids=new Set(),warnings=[];
 (sessions||[]).forEach(function(s){
  if(!s||!s.id){counts.duplicateIds++;return}
  if(ids.has(s.id))counts.duplicateIds++;ids.add(s.id);
  counts.patients.add(s.patientId);
  counts.days.add(s.date);
  if(s.type!=='routine'){counts.excluded++;return}
  counts.routine++;
  var values=(s.values||[]).slice().sort(function(a,b){return minutes(a.time)-minutes(b.time)}),start=minutes(s.start),end=minutes(s.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){counts.invalidTime++;return}
  counts.measurements+=values.length;
  if(values.some(function(v){return !Number.isFinite(minutes(v.time))||minutes(v.time)<start||minutes(v.time)>end}))counts.invalidTime++;
  if(values.some(function(v){return !Number.isFinite(Number(v.sbp))||Number(v.sbp)<40||Number(v.sbp)>280}))counts.invalidBP++;
  var firstLow=values.find(function(v){return Number(v.sbp)<90});
  if(firstLow)counts.idhs++;
  for(var i=0;i<values.length;i++){
   var m=values[i],t=minutes(m.time);
   if(!Number.isFinite(t)||!Number.isFinite(Number(m.sbp))||Number(m.sbp)<90)break;
   if(t+60>end)continue;
   if(t+60<start)continue;
   counts.windows++;
   if(firstLow&&minutes(firstLow.time)>t&&minutes(firstLow.time)<=t+60)counts.positiveWindows++;
  }
 });
 counts.patients=counts.patients.size;counts.days=counts.days.size;
 if(counts.duplicateIds)warnings.push('Session ID 重複，須修正後才可建模');
 if(counts.invalidTime||counts.invalidBP)warnings.push('時間戳記或血壓不合規');
 if(counts.routine<100)warnings.push('常規透析療程不足 100 筆（僅作示範預檢門檻，非臨床樣本數計算）');
 if(counts.days<30)warnings.push('涵蓋日期不足 30 天，無法進行有代表性的時間外驗證');
 if(counts.positiveWindows<20)warnings.push('60 分鐘新發 IDH 陽性觀測點不足 20 筆，無法可靠評估');
 if(counts.windows===0)warnings.push('沒有符合 60 分鐘完整觀測期的預測點');
 if(counts.excluded)warnings.push('非例行療程 '+counts.excluded+' 筆已排除於第一版常規訓練目標');
 warnings.push('此預檢只檢查瀏覽器合成資料，正式訓練必須在院內重做更嚴格的資料品質、資料洩漏與標籤審核');
 return {counts:counts,warnings:warnings,ready:false,reason:'公開 GitHub Pages 不支援 XGBoost 訓練或臨床資料'};
}
function trainingPlan(settings,audit){
 return {
  protocol:'HD-AI-XGB-research-v1',
  version:'1.1',
  generated_at:new Date().toISOString(),
  purpose:'RESEARCH_ONLY',
  data_source:'hospital_secure_server_preapproved_dataset',
  source_data_policy:'no_real_patient_data_on_github_pages',
  prediction_target:'first_documented_sbp_lt_90_within_next_60_min',
  prediction_horizon_minutes:Number(settings.horizon),
  training_scope:settings.scope,
  validation:'chronological_train_validation_test_with_patient_cluster_uncertainty',
  missing_data:'retain_missingness_and_data_age; never infer unmeasured BP',
  model:'XGBoost',
  model_status:'NOT_TRAINED',
  exclude_post_prediction_features:true,
  require_hospital_access_controls:true,
  current_demo_audit:audit?{sessions:audit.counts.sessions,eligible_windows:audit.counts.windows,positive_windows:audit.counts.positiveWindows}:null
 };
}
function setup(api){
 var $=function(id){return document.getElementById(id)},audit=null;
 function report(){
  audit=featureAudit(api.getSessions());
  var c=audit.counts;
  $('mlAuditCards').innerHTML=[
   ['總療程',c.sessions],['常規門診',c.routine],['獨立病人',c.patients],['日期數',c.days],
   ['血壓量測',c.measurements],['合格預測點',c.windows],['陽性預測點',c.positiveWindows],['有紀錄IDH的常規療程',c.idhs]
  ].map(function(x){return '<div class="panel"><strong>'+x[0]+'</strong><h2>'+x[1]+'</h2></div>'}).join('');
  $('mlAuditResult').innerHTML='<h3>合成資料預檢已完成</h3><p>這些是資料筆數，不是模型效能；不表示模型已訓練。</p><ul>'+audit.warnings.map(function(x){return '<li>'+escapeHtml(x)+'</li>'}).join('')+'</ul>';
  $('mlPlan').disabled=false;
  api.message('合成資料預檢完成；公開網頁不會執行模型訓練');
 }
 $('mlAudit').addEventListener('click',report);
 $('mlPlan').addEventListener('click',function(){
  if(!audit){api.message('請先執行合成資料預檢');return}
  var plan=trainingPlan({horizon:60,scope:'routine_outpatient_only'},audit);
  $('mlPlanResult').textContent=JSON.stringify(plan,null,2);
  $('mlDownload').disabled=false;
 });
 $('mlDownload').addEventListener('click',function(){
  var raw=$('mlPlanResult').textContent;
  if(!raw||raw[0]!=='{')return;
  var blob=new Blob([raw],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='hd-ai-research-training-plan.json';document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url)},1000)
 });
 $('mlTrain').addEventListener('click',function(){
  $('mlTrainResult').textContent='訓練未啟動：目前是 GitHub Pages 合成示範，沒有院內認證後端或審核過的歷史資料。請由資訊室在院內執行 ml/train.py，並建立授權的訓練服務後才能啟用真正的一鍵訓練。';
 });
 $('mlPlan').disabled=true;$('mlDownload').disabled=true;
 $('mlTrainResult').textContent='目前狀態：未連接院內訓練伺服器／模型未訓練';
 return {invalidate:function(){audit=null;$('mlAuditResult').textContent='資料已更新，請重新執行預檢';$('mlPlan').disabled=true;$('mlDownload').disabled=true;$('mlAuditCards').innerHTML='';$('mlPlanResult').textContent=''}};
}
root.HDAITrainingCenter={setup:setup,featureAudit:featureAudit,trainingPlan:trainingPlan};
})(window);
