/* HD-AI v0.9 synthetic-only CSV import. No external libraries, storage or network calls. */
(function(global){
'use strict';
function text(v){return String(v==null?'':v)}
function esc(v){return text(v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function parseCSV(str){
  str=text(str).replace(/^\uFEFF/,'');
  var rows=[],row=[],cell='',quoted=false;
  for(var i=0;i<str.length;i++){
    var c=str[i];
    if(quoted){if(c==='"'&&str[i+1]==='"'){cell+='"';i++}else if(c==='"'){quoted=false}else{cell+=c}}
    else if(c==='"'){if(cell!=='')throw Error('CSV 引號使用錯誤');quoted=true}
    else if(c===','){row.push(cell);cell=''}
    else if(c==='\r'||c==='\n'){row.push(cell);if(row.some(function(x){return x.trim()!==''}))rows.push(row);row=[];cell='';if(c==='\r'&&str[i+1]==='\n')i++}
    else cell+=c;
  }
  if(quoted)throw Error('CSV 引號未正確結束');
  row.push(cell);if(row.some(function(x){return x.trim()!==''}))rows.push(row);
  if(!rows.length)throw Error('檔案沒有內容');
  var headers=rows.shift().map(function(x){return x.trim()});
  if(headers.some(function(x){return !x}))throw Error('存在空白欄位標題');
  if(new Set(headers).size!==headers.length)throw Error('CSV 欄名重複');
  var data=rows.map(function(r,i){if(r.length!==headers.length)throw Error('第 '+(i+2)+' 列欄數不一致');var obj={};headers.forEach(function(k,j){obj[k]=r[j].trim()});return obj});
  if(data.length>5000)throw Error('單檔最多 5000 筆合成測試資料');
  return {headers:headers,rows:data};
}
var SCHEMA={
 session:{label:'療程檔',fields:['patient_id','session_id','session_start','session_end','shift_code','bed_id','session_type','pre_sbp'],
 optional:['can_status','idh_prev10_routine','idh_prev10_all','dm','source_updated_at'],
 aliases:{patient_id:['病人代碼','病人ID','patient','患者代碼'],session_id:['透析序號','療程序號','session','洗腎序號'],session_start:['開始時間','透析起始時間'],session_end:['結束時間','透析結束時間'],shift_code:['班別','shift'],bed_id:['床號','bed'],session_type:['透析類型','類型'],pre_sbp:['透析前收縮壓','透析前SBP'],can_status:['CAN狀態'],idh_prev10_routine:['近10次常規IDH'],idh_prev10_all:['近10次全部IDH'],dm:['糖尿病']}},
 vital:{label:'血壓檔',fields:['session_id','measured_at','sbp','dbp','hr','ufr_ml_kg_h'],optional:['measurement_id','measure_reason','recorded_at'],
 aliases:{session_id:['透析序號','療程序號','session','洗腎序號'],measured_at:['測量時間','血壓時間','紀錄時間'],sbp:['收縮壓'],dbp:['舒張壓'],hr:['脈搏','心跳'],ufr_ml_kg_h:['UFR','脫水速度','UF率'],measurement_id:['量測序號'],measure_reason:['量測原因','測量原因'],recorded_at:['登錄時間']}}
};
function stamp(v){
  var m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:([+-])(\d{2}):?(\d{2})|Z)?$/.exec(v);
  if(!m)return null;
  var y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]),h=Number(m[4]),mi=Number(m[5]),sec=Number(m[6]||0);
  if(mo<1||mo>12||d<1||d>31||h>23||mi>59||sec>59)return null;
  var check=new Date(Date.UTC(y,mo-1,d,h,mi,sec));
  if(check.getUTCFullYear()!==y||check.getUTCMonth()!==mo-1||check.getUTCDate()!==d)return null;
  var offset=m[7]?((m[7]==='+'?1:-1)*(Number(m[8])*60+Number(m[9]))):0;
  if(m[7]&&(Number(m[8])>14||Number(m[9])>59))return null;
  return {ms:check.getTime()-offset*60000,date:m[1]+'-'+m[2]+'-'+m[3],clock:m[4]+':'+m[5],style:m[7]||v.endsWith('Z')?'tz':'local'};
}
function n(v){if(text(v).trim()==='')return NaN;return Number(v)}
function isIntRange(x,lo,hi){return Number.isInteger(x)&&x>=lo&&x<=hi}
function mapRows(file,mapping,required){
 var out=[];for(var i=0;i<file.rows.length;i++){var input=file.rows[i],item={_line:i+2};required.fields.concat(required.optional).forEach(function(k){if(mapping[k])item[k]=input[mapping[k]]});out.push(item)}return out
}
function inspect(sessionRows,vitalRows){
 var errors=[],warnings=[],badSession=new Set(),badVital=new Set();
 function fail(type,row,message){errors.push({file:type,line:row._line,msg:message});(type==='A'?badSession:badVital).add(row._line)}
 function warn(type,row,message){warnings.push({file:type,line:row._line,msg:message})}
 var ss=new Map(),vs=new Map(),assignments=[],patientWindows=[];
 sessionRows.forEach(function(s){
   var id=s.session_id,patient=s.patient_id,start=stamp(s.session_start||''),end=stamp(s.session_end||'');
   if(!/^S[A-Za-z0-9_-]{2,25}$/.test(id||''))fail('A',s,'需使用合成療程代碼 S...；禁止使用實際病歷資訊');
   if(!/^P[A-Za-z0-9_-]{2,25}$/.test(patient||''))fail('A',s,'需使用合成病人代碼 P...；禁止使用實際病歷資訊');
   if(ss.has(id))fail('A',s,'重複 session_id');else ss.set(id,s);
   if(!start||!end||end.ms<=start.ms)fail('A',s,'療程開始／結束時間不正確');
   if(start&&end&&start.style!==end.style)fail('A',s,'時間戳記格式混用（時區與無時區）');
   if(start&&end&&start.date!==end.date)fail('A',s,'示範看板暫不支援跨午夜療程，正式院內版應使用完整 timestamp');
   if(start&&end&&end.ms-start.ms>8*3600000)warn('A',s,'療程超過 8 小時，請人工確認');
   if(!/^(0?[1-9]|[1-5]\d|60)$/.test(s.bed_id||''))fail('A',s,'床位須為 01–60');
   if(!['1','2','3','X'].includes(s.shift_code))fail('A',s,'班別僅限 1、2、3、X');
   if(!['routine','extra','urgent','inpatient'].includes(s.session_type))fail('A',s,'未知透析類型');
   if(s.session_type==='routine'&&start){
     var dow=new Date(start.date+'T12:00:00').getDay(),allowed=dow===0?[]:[1,3,5].includes(dow)?['1','2','3']:['1','2'];
     if(!allowed.includes(s.shift_code))fail('A',s,'常規透析班別與星期不符');
   }
   if(s.session_type!=='routine'&&s.shift_code!=='X')warn('A',s,'非例行透析建議使用 X 班');
   if(!Number.isFinite(n(s.pre_sbp))||n(s.pre_sbp)<40||n(s.pre_sbp)>280)fail('A',s,'透析前 SBP 超出可接受輸入範圍');
   if(s.can_status&&!['unknown','suspected','confirmed','no_evidence'].includes(s.can_status))fail('A',s,'CAN 狀態代碼錯誤');
   ['idh_prev10_routine','idh_prev10_all'].forEach(function(k){if(s[k]!==undefined&&s[k]!==''&&!isIntRange(n(s[k]),0,10))fail('A',s,k+' 必須是 0–10')});
   if(s.dm!==undefined&&s.dm!==''&&!['0','1'].includes(s.dm))fail('A',s,'dm 必須是 0 或 1');
   if(start&&end){assignments.push({s:s,start:start.ms,end:end.ms,bed:String(Number(s.bed_id)).padStart(2,'0')});patientWindows.push({s:s,start:start.ms,end:end.ms})}
 });
 for(var i=0;i<assignments.length;i++)for(var j=i+1;j<assignments.length;j++){
  var a=assignments[i],b=assignments[j];if(a.start<b.end&&b.start<a.end){
   if(a.bed===b.bed){fail('A',a.s,'與另一療程床位時段重疊');fail('A',b.s,'與另一療程床位時段重疊')}
   if(a.s.patient_id===b.s.patient_id){fail('A',a.s,'同病人療程時間重疊');fail('A',b.s,'同病人療程時間重疊')}
  }
 }
 vitalRows.forEach(function(v){
   var s=ss.get(v.session_id),time=stamp(v.measured_at||''),sb=n(v.sbp),db=n(v.dbp),hr=n(v.hr),uf=n(v.ufr_ml_kg_h);
   if(!s){fail('B',v,'找不到相符的 Session ID');return}
   if(!time){fail('B',v,'量測時間格式錯誤');return}
   var st=stamp(s.session_start||''),en=stamp(s.session_end||'');
   if(st&&en&&(time.ms<st.ms||time.ms>en.ms))fail('B',v,'量測時間不在療程時段內');
   if(st&&time.style!==st.style)fail('B',v,'量測時間時區格式與療程不一致');
   if(!Number.isFinite(sb)||sb<40||sb>280||!Number.isFinite(db)||db<20||db>180||db>=sb||!Number.isFinite(hr)||hr<20||hr>220)fail('B',v,'血壓／心跳超出格式檢查範圍');
   if(!Number.isFinite(uf)||uf<0||uf>30)fail('B',v,'UFR 請使用 mL/kg/h，且介於 0–30');
   if(sb<80)warn('B',v,'極低 SBP，需核對；不可自動刪除真實低血壓');
   var key=v.session_id+'|'+time.ms;
   if(vs.has(key)){fail('B',v,'同療程同一時間重複血壓');fail('B',vs.get(key),'同療程同一時間重複血壓')}else vs.set(key,v);
   if(v.recorded_at){var rec=stamp(v.recorded_at);if(!rec)fail('B',v,'登錄時間格式錯誤');else if(rec.ms<time.ms)warn('B',v,'登錄時間早於實際量測時間')}
   if(v.measure_reason&&!['常規每小時','血壓異常加測','症狀加測','處置後追蹤'].includes(v.measure_reason))warn('B',v,'不明量測原因，將視為常規每小時');
 });
 ss.forEach(function(s,id){if(!vitalRows.some(function(v){return v.session_id===id}))warn('A',s,'此療程沒有血壓紀錄')});
 return {errors:errors,warnings:warnings,invalidSessions:badSession.size,invalidVitals:badVital.size,totalSessions:sessionRows.length,totalVitals:vitalRows.length,ok:errors.length===0};
}
function download(name,body){
 var a=document.createElement('a');var url=URL.createObjectURL(new Blob(['\uFEFF'+body],{type:'text/csv;charset=utf-8'}));
 a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url)},1000)
}
var FILES={session:null,vital:null},MAP={session:{},vital:{}},REPORT=null;
var SAMPLE={
 session:'patient_id,session_id,session_start,session_end,shift_code,bed_id,session_type,pre_sbp,can_status,idh_prev10_routine,idh_prev10_all,dm\nP801,S801,2026-11-23T07:30,2026-11-23T11:30,1,08,routine,145,unknown,2,2,1\nP802,S802,2026-11-23T12:30,2026-11-23T16:30,2,08,routine,155,suspected,3,3,1\nP803,S803,2026-11-23T18:00,2026-11-23T22:00,X,09,urgent,132,unknown,1,1,0\n',
 vital:'session_id,measured_at,sbp,dbp,hr,ufr_ml_kg_h,measure_reason\nS801,2026-11-23T07:30,145,80,74,8,常規每小時\nS801,2026-11-23T08:30,128,72,76,9,常規每小時\nS801,2026-11-23T09:30,105,64,82,10,常規每小時\nS802,2026-11-23T12:30,155,82,75,9,常規每小時\nS802,2026-11-23T13:30,119,70,83,11,常規每小時\nS802,2026-11-23T13:45,89,52,94,11,血壓異常加測\nS803,2026-11-23T18:00,132,74,85,8,常規每小時\nS803,2026-11-23T19:00,118,71,87,8,常規每小時\n'
};
function setup(api){
 var $=function(id){return document.getElementById(id)};
 function renderFile(type){
  var t=SCHEMA[type],file=FILES[type],box=$('mapping-'+type),preview=$('preview-'+type);
  if(!file){box.innerHTML='';preview.innerHTML='';return}
  MAP[type]={};
  var all=t.fields.concat(t.optional);
  var h='<div class="scroll"><table><thead><tr><th>標準欄位</th><th>原始欄位</th></tr></thead><tbody>';
  all.forEach(function(f){
    var candidates=[f].concat(t.aliases[f]||[]),def=file.headers.find(function(k){return candidates.includes(k)})||'';
    MAP[type][f]=def;
    h+='<tr><td>'+esc(f)+(t.fields.includes(f)?' *':'')+'</td><td><select data-map-type="'+type+'" data-map-key="'+f+'"><option value="">—不對應—</option>'+file.headers.map(function(k){return '<option value="'+esc(k)+'" '+(k===def?'selected':'')+'>'+esc(k)+'</option>'}).join('')+'</select></td></tr>';
  });
  box.innerHTML=h+'</tbody></table></div>';
  box.querySelectorAll('select').forEach(function(sel){sel.addEventListener('change',function(){MAP[type][sel.dataset.mapKey]=sel.value;REPORT=null;$('importReport').textContent='欄位對應已修改，請重新檢查'})});
  preview.innerHTML='<p>'+file.rows.length+' 列，欄位 '+file.headers.length+' 個（以下僅預覽前 5 列）</p><div class="scroll"><table><thead><tr>'+file.headers.map(function(x){return '<th>'+esc(x)+'</th>'}).join('')+'</tr></thead><tbody>'+file.rows.slice(0,5).map(function(r){return '<tr>'+file.headers.map(function(k){return '<td>'+esc(r[k])+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>';
 }
 function setFile(type,source){
  FILES[type]=source;REPORT=null;renderFile(type);$('importReport').textContent='請檢查兩檔欄位對應，再按「檢查資料」。';
 }
 function readFile(type,input){
  var file=input.files[0];if(!file)return;
  if(!/\.csv$/i.test(file.name)||file.size>1000000){$('importReport').textContent='僅接受 1 MB 以下 CSV UTF-8 合成示範檔；Excel 請另存為 CSV UTF-8';input.value='';return}
  var reader=new FileReader();
  reader.onload=function(){try{setFile(type,parseCSV(reader.result))}catch(e){$('importReport').textContent=type+' 匯入失敗：'+e.message}};
  reader.onerror=function(){$('importReport').textContent='無法讀取檔案'};
  reader.readAsText(file,'utf-8');
 }
 ['session','vital'].forEach(function(type){
   $('file-'+type).addEventListener('change',function(){readFile(type,this)});
   $('sample-'+type).addEventListener('click',function(){setFile(type,parseCSV(SAMPLE[type]));$('importReport').textContent='已載入'+SCHEMA[type].label+'合成測試資料'});
   $('download-'+type).addEventListener('click',function(){download(type==='session'?'hd-ai-demo-sessions.csv':'hd-ai-demo-measurements.csv',SAMPLE[type])});
 });
 $('checkImport').addEventListener('click',function(){
  if(!FILES.session||!FILES.vital){$('importReport').textContent='請先選擇兩份合成測試檔';return}
  for(var type of ['session','vital']){
    var schema=SCHEMA[type],missing=schema.fields.filter(function(k){return !MAP[type][k]});
    if(missing.length){$('importReport').textContent=schema.label+'缺少必要欄位：'+missing.join(', ');return}
    var assigned=Object.values(MAP[type]).filter(Boolean);
    if(new Set(assigned).size!==assigned.length){$('importReport').textContent=schema.label+'的同一原始欄位不可重複對應';return}
  }
  REPORT={sessions:mapRows(FILES.session,MAP.session,SCHEMA.session),vitals:mapRows(FILES.vital,MAP.vital,SCHEMA.vital)};
  REPORT.result=inspect(REPORT.sessions,REPORT.vitals);
  var x=REPORT.result;
  $('importReport').innerHTML='<h3>'+(x.ok?'檢查通過':'檢查未通過')+'</h3><p>療程 '+x.totalSessions+' 筆｜血壓 '+x.totalVitals+' 筆｜錯誤 '+x.errors.length+' 項｜提醒 '+x.warnings.length+' 項</p>'+
    '<div class="scroll"><table><thead><tr><th>類別</th><th>檔案</th><th>列</th><th>說明</th></tr></thead><tbody>'+
    x.errors.concat(x.warnings).slice(0,100).map(function(y){return '<tr><td>'+(x.errors.includes(y)?'阻擋':'提醒')+'</td><td>'+esc(y.file)+'</td><td>'+y.line+'</td><td>'+esc(y.msg)+'</td></tr>'}).join('')+'</tbody></table></div>';
  $('applyImport').disabled=!x.ok;
 });
 $('applyImport').addEventListener('click',function(){
  if(!REPORT||!REPORT.result.ok)return;
  if(!$('syntheticOnly').checked){$('importReport').textContent='請先勾選「只包含合成教學資料」確認';return}
  try{
   var applied=api.apply(REPORT.sessions,REPORT.vitals);
   $('importReport').textContent='合成資料匯入成功：'+applied.sessions+' 次療程、'+applied.vitals+' 筆血壓。僅暫存在瀏覽器記憶體，重新整理後消失。';
   $('applyImport').disabled=true;api.onSuccess();
  }catch(e){$('importReport').textContent='未匯入任何資料：'+e.message}
 });
 $('importReport').textContent='選擇兩份合成 CSV 檔，或直接按「載入合成範例」。Excel 請先另存 CSV UTF-8。';
}
global.HDAIImporter={setup:setup,parseCSV:parseCSV,inspect:inspect,stamp:stamp};
})(window);
