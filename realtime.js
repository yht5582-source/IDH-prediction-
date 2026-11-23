/* HD-AI v1.0 synthetic playback. No HTTP, no patient data storage, no predictive model. */
(function(global){
'use strict';
function cloneValues(xs){return xs.map(function(x){return Object.assign({},x)})}
function minutes(t){var x=t.split(':');return Number(x[0])*60+Number(x[1])}
function clock(m){return String(Math.floor(m/60)%24).padStart(2,'0')+':'+String(m%60).padStart(2,'0')}
function escapeHTML(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function createController(api){
 var state={active:false,running:false,minute:null,day:null,shift:null,alerts:[],lastStep:null};
 var originals=new Map(),observed=new Map(),timer=null,previous=new Map(),seq=0;
 function scoped(){return api.getSessions().filter(function(s){return s.date===state.day&&s.shift===state.shift})}
 function summarize(){
  var ss=scoped(),stale=0,missing=0;ss.forEach(function(s){
   if(!s.values.length){missing++;return}
   var last=s.values.slice().sort(function(a,b){return minutes(b.time)-minutes(a.time)})[0];
   if(state.minute-minutes(last.time)>75)stale++;
  });
  return {active:state.active,running:state.running,time:state.minute===null?null:clock(state.minute),
    day:state.day,shift:state.shift,alerts:state.alerts.map(function(a){return Object.assign({},a)}),
    stale:stale,missing:missing,count:ss.length};
 }
 function refresh(){api.refresh(summarize())}
 function evaluate(){
  if(!state.active)return;
  scoped().forEach(function(s){
   var values=originals.get(s.id)||[];
   var now=values.filter(function(v){return minutes(v.time)<=state.minute});
   s.values=cloneValues(now);
   var latest=now.length?now[now.length-1]:null;
   var prior=previous.get(s.id)||0;
   var level=latest?api.rank(s):0;
   if(latest&&level>=2&&level>prior){
    state.alerts.unshift({id:'A'+(++seq),sessionId:s.id,patientId:s.patientId,bed:s.bed,
      date:s.date,shift:s.shift,at:clock(state.minute),measuredAt:latest.time,
      level:level,ack:false,ackAt:null,action:null,revision:s.values.length});
   }
   previous.set(s.id,level);
  });
  state.lastStep=state.minute;
  refresh();
 }
 function stopTimer(){if(timer!==null){clearInterval(timer);timer=null}state.running=false}
 function reset(){
  stopTimer();
  originals.forEach(function(v,id){var s=api.getSessions().find(function(x){return x.id===id});if(s)s.values=cloneValues(v)});
  originals.clear();observed.clear();previous.clear();
  state.active=false;state.minute=null;state.alerts=[];state.day=null;state.shift=null;seq=0;
  refresh();
 }
 function begin(day,shift){
  if(state.active)reset();
  var ss=api.getSessions().filter(function(s){return s.date===day&&s.shift===shift&&s.values.length});
  if(!ss.length)throw Error('此日期班別沒有可播放的合成血壓紀錄');
  state.day=day;state.shift=shift;state.active=true;state.running=false;
  state.minute=Math.min.apply(null,ss.map(function(s){return minutes(s.start)}));
  ss.forEach(function(s){originals.set(s.id,cloneValues(s.values));previous.set(s.id,0)});
  evaluate();
  return summarize();
 }
 function step(delta){
  if(!state.active)throw Error('請先開始合成資料回放');
  var end=Math.max.apply(null,scoped().map(function(s){return minutes(s.end)}));
  var next=Math.min(state.minute+delta,end);
  if(next<=state.minute){stopTimer();refresh();return summarize()}
  state.minute=next;evaluate();
  if(state.minute>=end)stopTimer();
  return summarize();
 }
 function run(){if(!state.active)throw Error('請先開始合成資料回放');if(state.running)return;
  state.running=true;timer=setInterval(function(){try{step(15)}catch(e){stopTimer();api.error(e.message)}},2000);refresh()}
 function pause(){stopTimer();refresh()}
 function acknowledge(id,action){
  var item=state.alerts.find(function(x){return x.id===id});
  if(!item)throw Error('找不到警示紀錄');
  item.ack=true;item.ackAt=clock(state.minute);item.action=action||'已查看／待依 SOP 評估';refresh();
  return item;
 }
 return {begin:begin,step:step,run:run,pause:pause,reset:reset,acknowledge:acknowledge,snapshot:summarize};
}
function setup(api){
 var $=function(id){return document.getElementById(id)}, ctl=createController(api);
 function render(st){
  $('liveState').textContent=!st.active?'未啟用｜目前是靜態合成紀錄':('合成回放 '+st.day+'／班別 '+st.shift+'／模擬時間 '+st.time+'｜'+(st.running?'播放中':'已暫停'));
  $('liveFresh').textContent=st.active?'同班 '+st.count+' 個療程｜超過75分鐘未有新血壓 '+st.stale+' 床｜目前無血壓 '+st.missing+' 床':'本頁未連線院內電子透析紀錄／透析機。按下「開始回放」才會模擬資料更新。';
  $('liveAlerts').innerHTML=st.alerts.length?'<div class="scroll"><table><thead><tr><th>模擬時間</th><th>床位</th><th>病人</th><th>級別</th><th>最新血壓時間</th><th>確認</th><th>操作</th></tr></thead><tbody>'+st.alerts.map(function(a){
   return '<tr><td>'+a.at+'</td><td>'+escapeHTML(a.bed)+'</td><td>'+escapeHTML(a.patientId)+'</td><td>'+(a.level===3?'已記錄異常':'高注意')+'</td><td>'+a.measuredAt+'</td><td>'+(a.ack?'已確認 '+escapeHTML(a.ackAt):'待確認')+'</td><td><button data-open-alert="'+escapeHTML(a.sessionId)+'">查看病人</button> <button data-ack-alert="'+a.id+'" '+(a.ack?'disabled':'')+'>確認</button></td></tr>'
  }).join('')+'</tbody></table></div>':'<p class="muted">目前尚無高注意或已發生異常的合成回放警示</p>';
  $('liveAlerts').querySelectorAll('[data-open-alert]').forEach(function(b){b.addEventListener('click',function(){api.open(b.dataset.openAlert)})});
  $('liveAlerts').querySelectorAll('[data-ack-alert]').forEach(function(b){b.addEventListener('click',function(){ctl.acknowledge(b.dataset.ackAlert,'已查看，需依院內 SOP 評估');api.info('已確認合成警示（僅瀏覽器內有效）')})});
  $('liveStart').disabled=st.active;
  $('liveStep').disabled=!st.active;
  $('liveRun').disabled=!st.active||st.running;
  $('livePause').disabled=!st.running;
  $('liveReset').disabled=!st.active;
  $('liveSimulationBanner').textContent=st.active?'合成時鐘 '+st.time+'｜非真實即時連線｜非 XGBoost 預測':'合成靜態資料｜非即時監測';
 }
 $('liveStart').addEventListener('click',function(){try{ctl.begin($('day').value,$('shift').value);api.info('已開始合成回放：只顯示模擬時間之前的血壓')}catch(e){api.error(e.message)}});
 $('liveStep').addEventListener('click',function(){try{ctl.step(15)}catch(e){api.error(e.message)}});
 $('liveRun').addEventListener('click',function(){try{ctl.run()}catch(e){api.error(e.message)}});
 $('livePause').addEventListener('click',function(){ctl.pause()});
 $('liveReset').addEventListener('click',function(){ctl.reset();api.info('已恢復原始合成紀錄')});
 $('day').addEventListener('change',function(){if(ctl.snapshot().active)ctl.reset()});
 $('shift').addEventListener('change',function(){if(ctl.snapshot().active)ctl.reset()});
 render(ctl.snapshot());
 return {
  controller:ctl,
  refresh:render,
  externalReset:function(){if(ctl.snapshot().active)ctl.reset()},
  acknowledgeForSession:function(sessionId,action){
   var alert=ctl.snapshot().alerts.find(function(x){return x.sessionId===sessionId&&!x.ack});
   if(alert)ctl.acknowledge(alert.id,action);
  }
 };
}
global.HDAIRealtime={setup:setup,createController:createController,clock:clock};
})(window);
