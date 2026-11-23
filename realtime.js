/* HD-AI v1.1.1 synthetic playback. No HTTP, no patient data storage, no predictive model. */
(function(global){
'use strict';
function minutes(t){var x=String(t).split(':');return Number(x[0])*60+Number(x[1])}
function clock(m){return String(Math.floor(m/60)%24).padStart(2,'0')+':'+String(m%60).padStart(2,'0')}
function escapeHTML(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
/* 複製並依時間排序：手動加測的紀錄不一定照時間順序存放 */
function sortedCopy(xs){return xs.map(function(x){return Object.assign({},x)}).sort(function(a,b){return minutes(a.time)-minutes(b.time)})}
var STALE_MIN=75;

/* createController 不碰 DOM，可在 Node 直接測試。
 * api: getSessions() / rank(session) / refresh(snapshot) / error(message) */
function createController(api){
 var state={active:false,running:false,minute:null,end:null,day:null,shift:null,alerts:[]};
 var originals=new Map(),previous=new Map(),timer=null,seq=0;
 function scoped(){return api.getSessions().filter(function(s){return s.date===state.day&&s.shift===state.shift})}
 function summarize(){
  var stale=0,missing=0,waiting=0,ss=state.active?scoped():[];
  ss.forEach(function(s){
   /* 只對「模擬時間內正在進行」的療程計算資料新鮮度 */
   if(minutes(s.start)>state.minute){waiting++;return}
   if(minutes(s.end)<state.minute)return;
   if(!s.values.length){missing++;return}
   var last=Math.max.apply(null,s.values.map(function(v){return minutes(v.time)}));
   if(state.minute-last>STALE_MIN)stale++;
  });
  return {active:state.active,running:state.running,finished:state.active&&state.minute>=state.end,
    time:state.minute===null?null:clock(state.minute),day:state.day,shift:state.shift,
    alerts:state.alerts.map(function(a){return Object.assign({},a)}),
    stale:stale,missing:missing,waiting:waiting,count:ss.length};
 }
 function refresh(){api.refresh(summarize())}
 function evaluate(){
  scoped().forEach(function(s){
   var o=originals.get(s.id);if(!o)return;
   var now=o.values.filter(function(v){return minutes(v.time)<=state.minute});
   s.values=now.map(function(v){return Object.assign({},v)});
   var latest=now.length?now[now.length-1]:null;
   /* 量測列帶有 UFR（匯入資料）時，只使用模擬時間之前的值，避免提前看到未來的 UFR */
   if(latest&&typeof latest.ufr==='number'&&isFinite(latest.ufr))s.ufr=latest.ufr;
   var prior=previous.get(s.id)||0,level=latest?api.rank(s):0;
   if(latest&&level>=2&&level>prior){
    state.alerts.unshift({id:'A'+(++seq),sessionId:s.id,patientId:s.patientId,bed:s.bed,
      date:s.date,shift:s.shift,at:clock(state.minute),measuredAt:latest.time,sbp:latest.sbp,
      level:level,ack:false,ackAt:null,action:null});
   }
   previous.set(s.id,level);
  });
  refresh();
 }
 function stopTimer(){if(timer!==null){clearInterval(timer);timer=null}state.running=false}
 function reset(){
  stopTimer();
  var byId=new Map();api.getSessions().forEach(function(s){byId.set(s.id,s)});
  originals.forEach(function(o,id){var s=byId.get(id);if(s){s.values=o.values;s.ufr=o.ufr}});
  originals.clear();previous.clear();
  state.active=false;state.minute=null;state.end=null;state.alerts=[];state.day=null;state.shift=null;seq=0;
  refresh();
 }
 function begin(day,shift){
  if(state.active)reset();
  var all=api.getSessions().filter(function(s){return s.date===day&&s.shift===shift});
  if(!all.some(function(s){return s.values.length}))throw Error('此日期班別沒有可播放的合成血壓紀錄');
  state.day=day;state.shift=shift;state.active=true;state.running=false;
  state.minute=Math.min.apply(null,all.map(function(s){return minutes(s.start)}));
  state.end=Math.max.apply(null,all.map(function(s){return minutes(s.end)}));
  all.forEach(function(s){originals.set(s.id,{values:sortedCopy(s.values),ufr:s.ufr});previous.set(s.id,0)});
  evaluate();
  return summarize();
 }
 function step(delta){
  if(!state.active)throw Error('請先開始合成資料回放');
  var next=Math.min(state.minute+delta,state.end);
  if(next<=state.minute){stopTimer();refresh();return summarize()}
  state.minute=next;
  if(state.minute>=state.end)stopTimer();
  evaluate();
  return summarize();
 }
 function run(){if(!state.active)throw Error('請先開始合成資料回放');if(state.running||state.minute>=state.end)return;
  state.running=true;timer=setInterval(function(){try{step(15)}catch(e){stopTimer();api.error(e.message)}},2000);refresh()}
 function pause(){stopTimer();refresh()}
 function mark(item,action){item.ack=true;item.ackAt=clock(state.minute);item.action=action||'已查看／待依 SOP 評估'}
 function acknowledge(id,action){
  var item=state.alerts.find(function(x){return x.id===id});
  if(!item)throw Error('找不到警示紀錄');
  mark(item,action);refresh();
  return Object.assign({},item);
 }
 /* 在療程監測頁確認時，一次確認該療程所有尚未確認的回放警示 */
 function acknowledgeSession(sessionId,action){
  var n=0;state.alerts.forEach(function(x){if(x.sessionId===sessionId&&!x.ack){mark(x,action);n++}});
  if(n)refresh();return n;
 }
 return {begin:begin,step:step,run:run,pause:pause,reset:reset,acknowledge:acknowledge,acknowledgeSession:acknowledgeSession,
   snapshot:summarize,isActive:function(){return state.active},now:function(){return state.minute===null?null:clock(state.minute)}};
}

/* setup 負責回放面板的 DOM。
 * api 另需：open(sessionId) / info(message) / onAck(alert)（選用，於警示列表按「確認」時呼叫） */
function setup(api){
 var $=function(id){return document.getElementById(id)};
 function render(st){
  $('liveState').textContent=!st.active?'未啟用｜目前是靜態合成紀錄':('合成回放 '+st.day+'／班別 '+st.shift+'／模擬時間 '+st.time+'｜'+(st.finished?'已到班別結束':st.running?'播放中':'已暫停'));
  $('liveFresh').textContent=st.active?'同班 '+st.count+' 個療程｜進行中且超過 '+STALE_MIN+' 分鐘未有新血壓 '+st.stale+' 床｜進行中但尚無血壓 '+st.missing+' 床'+(st.waiting?'｜尚未開始 '+st.waiting+' 床':''):'本頁未連線院內電子透析紀錄／透析機。按下「開始合成回放」才會模擬資料更新。';
  $('liveAlerts').innerHTML=st.alerts.length?'<div class="scroll"><table><thead><tr><th>操作</th><th>模擬時間</th><th>床位</th><th>病人</th><th>級別</th><th>血壓（量測時間）</th><th>確認</th></tr></thead><tbody>'+st.alerts.map(function(a){
   return '<tr'+(a.level===3&&!a.ack?' class="danger"':'')+'><td><button class="small" data-open-alert="'+escapeHTML(a.sessionId)+'">查看</button> <button class="small" data-ack-alert="'+escapeHTML(a.id)+'"'+(a.ack?' disabled':'')+'>確認</button></td><td>'+escapeHTML(a.at)+'</td><td>'+escapeHTML(a.bed)+'</td><td>'+escapeHTML(a.patientId)+'</td><td>'+(a.level===3?'已記錄異常':'高注意')+'</td><td>SBP '+escapeHTML(a.sbp)+'（'+escapeHTML(a.measuredAt)+'）</td><td>'+(a.ack?'已確認 '+escapeHTML(a.ackAt):'待確認')+'</td></tr>'
  }).join('')+'</tbody></table></div>':'<p class="muted">目前尚無高注意或已發生異常的合成回放警示</p>';
  $('liveStart').disabled=st.active;
  $('liveStep').disabled=!st.active||st.finished;
  $('liveRun').disabled=!st.active||st.running||st.finished;
  $('livePause').disabled=!st.running;
  $('liveReset').disabled=!st.active;
  $('liveSimulationBanner').textContent=st.active?'合成時鐘 '+st.time+'｜非真實即時連線｜非 XGBoost 預測':'合成靜態資料｜非即時監測';
 }
 var ctl=createController({getSessions:api.getSessions,rank:api.rank,error:api.error,
   refresh:function(st){render(st);api.refresh(st)}});
 function guard(fn){return function(ev){try{fn(ev)}catch(e){api.error(e.message)}}}
 $('liveStart').addEventListener('click',guard(function(){ctl.begin($('day').value,$('shift').value);api.info('已開始合成回放：只顯示模擬時間之前的血壓')}));
 $('liveStep').addEventListener('click',guard(function(){ctl.step(15)}));
 $('liveRun').addEventListener('click',guard(function(){ctl.run()}));
 $('livePause').addEventListener('click',function(){ctl.pause()});
 $('liveReset').addEventListener('click',function(){ctl.reset();api.info('已恢復原始合成紀錄')});
 /* 事件委派：每次重繪不必重新綁定按鈕 */
 $('liveAlerts').addEventListener('click',guard(function(e){
  var t=e&&e.target&&e.target.closest?e.target:null;if(!t)return;
  var o=t.closest('[data-open-alert]'),a=t.closest('[data-ack-alert]');
  if(o)api.open(o.dataset.openAlert);
  else if(a){var item=ctl.acknowledge(a.dataset.ackAlert,'已查看，需依院內 SOP 評估');if(api.onAck)api.onAck(item);api.info('已確認合成警示（僅瀏覽器內有效）')}
 }));
 $('day').addEventListener('change',function(){if(ctl.isActive())ctl.reset()});
 $('shift').addEventListener('change',function(){if(ctl.isActive())ctl.reset()});
 render(ctl.snapshot());
 return {
  controller:ctl,
  refresh:render,
  isActive:ctl.isActive,
  now:ctl.now,
  externalReset:function(){if(ctl.isActive())ctl.reset()},
  acknowledgeForSession:function(sessionId,action){return ctl.acknowledgeSession(sessionId,action)}
 };
}
global.HDAIRealtime={setup:setup,createController:createController,clock:clock};
})(typeof window!=='undefined'?window:globalThis);
