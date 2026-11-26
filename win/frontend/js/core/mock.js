/* PeriodIQ demo mock provider (classic script; no ES modules).
 * Demonstration-only fake backend. Contract source is Win/backend; this file
 * must not be referenced by the real provider.
 * Installed only when mode is file:// or ?mock=1, via js/core/api.surface.js's startup
 * assembly + js/core/api.mock.js's installMock().
 */
(function(){
const m=core.m,D=core._data;
const CYC=m.CYC,DAILY=m.DAILY,PRED=core.PRED,profile=core.profile;
const TODAY=m.TODAY,iso=D.iso,un=D.un,rnd=D.rnd,clamp=D.clamp,nowStamp=D.nowStamp,endOf=m.endOf,toN=m.toN,lvOf=m.lvOf,tierOf=m.tierOf,cycAt=m.cycAt;
const commit=core.commit,resetData=core.resetData,nextCycleId=D.nextCycleId,nextDailyId=D.nextDailyId,nextJournalId=D.nextJournalId;
const SEEDS=[[[2026,6,18],[2,2,2,1,1,1],[2,2,1,1,0,0]],[[2026,7,15],[2,3,3,2,2,1],[3,3,2,1,0,0]],[[2026,8,12],[3,4,4,3,2,1],[6,5,4,2,1,1]],[[2026,9,10],[2,3,3,2,1,1],[4,3,2,1,1,0]]];
const api=(()=>{const fl={fert:1,ov:1,lc:1,pred:1},W=(s,e)=>({start:iso(s),end:iso(e)}),isInt=(v,a,b)=>Number.isInteger(v)&&v>=a&&v<=b;
function serve(){const so=[...CYC].sort((a,b)=>a.s-b.s||a.id-b.id),st=so.map(c=>c.s);if(st.length<2)return{available:false,ovulation_date:null,fertile_window:null,less_certain_windows:[],predicted_period_windows:[]};
const iv=st.slice(1).map((s,i)=>s-st[i]),avg=clamp(Math.round(iv.reduce((a,b)=>a+b,0)/iv.length),21,45),runs=so.map(c=>endOf(c)-c.s+1),pl=Math.max(3,Math.round(runs.reduce((a,b)=>a+b,0)/runs.length))||6,
pn=Math.max(st[st.length-1]+avg,TODAY+1),ov=pn-14,lc=(s,e,phase,basis)=>({phase,basis,start:iso(s),end:iso(e)}),win=[];
// less-certain windows describe THIS cycle (latest start on/before today), as fertility.py does:
// follicular = day after it ends -> day before the fertile window; luteal = day after fertile -> day before the predicted onset.
// An unfilled period_end is replaced by the predicted end (pl) and flagged basis:'predicted'; a window with no days is not returned.
let cur=null;for(const c of so)if(c.s<=TODAY)cur=c;
// predicted period windows mirror fertility.py: the ongoing period (only when its end is unfilled) then the next one, 0-2 segments
const pw=[];if(cur&&cur.e==null)pw.push(W(cur.s,cur.s+pl-1));pw.push(W(pn,pn+pl-1));
// boundary defence (fertility.py W1): ovulation on/before the current period start -> no ovulation/fertile window is returned
if(cur&&ov<=cur.s)return{available:true,ovulation_date:null,fertile_window:null,less_certain_windows:[],predicted_period_windows:pw};
const fs=cur?Math.max(ov-5,cur.s):ov-5;
if(cur){const ce=cur.e!=null?cur.e:cur.s+pl-1;
if(ce+1<=fs-1)win.push(lc(ce+1,fs-1,'follicular',cur.e!=null?'actual':'predicted'));
if(ov+2<=pn-1)win.push(lc(ov+2,pn-1,'luteal',null))}
return{available:true,ovulation_date:iso(ov),fertile_window:W(fs,ov+1),less_certain_windows:win,predicted_period_windows:pw}}
const bad=(field,message)=>({ok:false,status:422,code:'VALIDATION_ERROR',reason:'field',field,message});
// validation chain, in contract order: 1 fields (422) -> 2 future (422) -> 3 backfill window (400) -> 4 not a period day (400)
function validateDaily(n,b){b=b||{};
if(typeof b.pain_present!='boolean')return bad('pain_present','pain_present must be true or false.');
if(b.pain_present?!isInt(b.pain_level,1,10):b.pain_level!==null)return bad('pain_level','pain_level is 1–10 when pain is present, otherwise null.');
if(!isInt(b.flow_level,1,10))return bad('flow_level','flow_level must be 1–10.');
if(!isInt(b.mood_level,1,10))return bad('mood_level','mood_level is required (1–10).');
// mood_tags: omitted -> []; otherwise the ONE vocabulary/limit check
// lives in core.api.moodTags.validate (no list or cap duplicated here). 422 + field 'mood_tags'.
if(b.mood_tags!==undefined&&!core.api.moodTags.validate(b.mood_tags).ok)return bad('mood_tags','mood_tags must be a list of at most '+core.api.moodTags.limit+' known ids without duplicates.');
// legacy mood_note: same 300-code-point limit as the journal channel (#28); ASCII behavior unchanged.
if(b.mood_note!=null&&(typeof b.mood_note!='string'||core.api.journal.countNote(b.mood_note)>core.api.journal.limit))return bad('mood_note','mood_note must be text of at most '+core.api.journal.limit+' characters.');
if(n>TODAY)return{ok:false,status:422,code:'VALIDATION_ERROR',reason:'future',message:'Date is in the future.'};
if(n<TODAY-1)return{ok:false,status:400,code:'DAILY_WINDOW',reason:'old',message:'Only today and yesterday can be edited.'};
if(!cycAt(n))return{ok:false,status:400,code:'NOT_PERIOD_DAY',reason:'notperiod',message:'This day is not covered by a period.'};
return{ok:true}}
// /cycles mock: same neighbour rules as the backend. It never merges: adjacency/overlap is decided here (400 DATE_OVERLAP).
// No commit() inside these methods — core.edit commits once so a rejected request cannot half-apply.
const cyIso=s=>typeof s=='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&un(s)!=null&&iso(un(s))===s,
cyFail=(status,code,message,field)=>Object.assign({ok:false,status,code,message},field?{field}:{}),
cyNeigh=(s,ex)=>{let pv=null,nx=null;for(const c of CYC){if(c.id===ex)continue;if(c.s<s){if(!pv||c.s>pv.s)pv=c}else if(!nx||c.s<nx.s)nx=c}return{pv,nx}},
cyChk=(s,e,ex)=>{const{pv,nx}=cyNeigh(s,ex);if(pv&&s<=(pv.e==null?pv.s:pv.e))return cyFail(400,'DATE_OVERLAP','This period overlaps the one before it.');if(nx&&(e==null?s:e)>=nx.s)return cyFail(400,'DATE_OVERLAP','This period overlaps the one after it.');return null},
cyRes=(status,c)=>Object.assign({ok:true,status,id:c.id,period_start:iso(c.s),period_end:c.e==null?null:iso(c.e)}),
// keep CYC ordered (start asc, then id) after a write so a direct endpoint call cannot skew predictions
cySort=()=>{CYC.sort((a,b)=>a.s-b.s||a.id-b.id);return CYC};
return{predictions(){const p=serve();if(!fl.fert)p.fertile_window=null;if(!fl.ov)p.ovulation_date=null;if(!fl.lc)p.less_certain_windows=[];if(!fl.pred)p.predicted_period_windows=[];return p},
// console helper to exercise missing segments: core.api.scenario('noFertile'|'noOvulation'|'noPrediction'|'noLessCertain'|'bare'|'full')
scenario(name){const off={full:[],noFertile:['fert'],noOvulation:['ov'],noPrediction:['pred'],noLessCertain:['lc'],bare:['fert','ov','lc','pred']}[name];if(!off)return Object.keys({full:1,noFertile:1,noOvulation:1,noPrediction:1,noLessCertain:1,bare:1});Object.assign(fl,{fert:1,ov:1,lc:1,pred:1});off.forEach(k=>fl[k]=0);commit('api')},
// [data-layer] Gate is the date window only: today/yesterday editable, future 422, older 400 — the
// same predicate and shape as the real api.gate. Period coverage does NOT participate in the gate;
// whether the daily four-piece can be written is decided by PUT /daily-records (this provider's
// putDaily -> validateDaily -> NOT_PERIOD_DAY, same as the backend). 经期与否不参与 gate 判定；
// 四件套是否可写由 PUT /daily-records 的结果决定。
validateDaily,gate:n=>{
if(n>TODAY)return{ok:false,status:422,code:'VALIDATION_ERROR',reason:'future',message:'Date is in the future.'};
if(n<TODAY-1)return{ok:false,status:400,code:'DAILY_WINDOW',reason:'old',message:'Only today and yesterday can be edited.'};
return{ok:true}},
putDaily(n,b){const r=validateDaily(n,b);if(r.ok){const pv=DAILY[n],tags=Array.isArray(b.mood_tags)?b.mood_tags.slice():[],row={id:pv?pv.id:nextDailyId(),created_at:pv?pv.created_at:nowStamp(),updated_at:nowStamp(),pain_present:b.pain_present,pain_level:b.pain_present?b.pain_level:null,flow_level:b.flow_level,mood_level:b.mood_level,mood_tags:tags,mood_note:typeof b.mood_note=='string'?b.mood_note:''};DAILY[n]=row;commit('cal');return good({id:row.id,record_date:iso(n),pain_present:row.pain_present,pain_level:row.pain_level,flow_level:row.flow_level,mood_level:row.mood_level,mood_tags:tags.slice(),created_at:row.created_at,updated_at:row.updated_at})}return r},
getDaily:n=>{const g=DAILY[n];if(!g)return null;const o=Object.assign({},g);o.mood_tags=Array.isArray(o.mood_tags)?o.mood_tags.slice():[];return o},
exportDaily:n=>{const g=DAILY[n];if(!g)return null;const o=Object.assign({},g);delete o.mood_note;delete o.mood_tags;return o},
// Mock journal write: validation order mirrors the backend (date path 422 -> note length 422 ->
// future 422 / past 400 -> blank delete). Returns a JournalOut shape ONLY: it never touches the
// store and never commits — the api modules own the store write and the single commit (same as real mode).
journalPutSync(date,text){const n=typeof date=='number'?(Number.isInteger(date)?date:null):un(date);if(n==null)return fail(422,'VALIDATION_ERROR','date must be a real date.');const t=text==null?'':String(text);if(core.api.journal.countNote(t)>core.api.journal.limit)return fail(422,'VALIDATION_ERROR','Journal text is limited to '+core.api.journal.limit+' characters.');if(n>TODAY)return fail(422,'VALIDATION_ERROR','Journal date must not be in the future.');if(n<TODAY)return fail(400,'JOURNAL_READONLY','Only today’s journal can be edited.');if(!t.trim())return good({id:null,record_date:iso(n),note:null,created_at:null,updated_at:null});const cur=core._data.journalGet(n),ts=nowStamp();return good({id:cur&&cur.id!=null?cur.id:nextJournalId(),record_date:iso(n),note:t,created_at:cur&&cur.created_at!=null?cur.created_at:ts,updated_at:ts})},
cycles:{
list(){return[...CYC].sort((a,b)=>b.s-a.s).map(c=>({id:c.id,period_start:iso(c.s),period_end:c.e==null?null:iso(c.e),period_days:c.e==null?null:c.e-c.s+1}))},
create(b){b=b||{};if(!cyIso(b.period_start))return bad('period_start','period_start must be a date as YYYY-MM-DD.');const s=un(b.period_start);let e=null;
if(b.period_end!=null){if(!cyIso(b.period_end))return bad('period_end','period_end must be a date as YYYY-MM-DD.');e=un(b.period_end)}
if(s>TODAY)return bad('period_start','The start date can’t be in the future.');if(e!=null&&e>TODAY)return bad('period_end','The end date can’t be in the future.');
if(e!=null&&e<s)return cyFail(400,'INVALID_PERIOD_END','The end date can’t be before the start date.');const o=cyChk(s,e,null);if(o)return o;
const c={id:nextCycleId(),s,e,note:typeof b.note=='string'?b.note:''};CYC.push(c);cySort();return cyRes(201,c)},
update(id,b){b=b||{};const c=CYC.find(q=>q.id===id);if(!c)return cyFail(404,'NOT_FOUND','That period no longer exists.');
if(b.clear_period_end&&b.period_end!=null)return bad('clear_period_end','clear_period_end and period_end can’t be sent together.');
let s=c.s;if(b.period_start!=null){if(!cyIso(b.period_start))return bad('period_start','period_start must be a date as YYYY-MM-DD.');s=un(b.period_start)}
let e=b.clear_period_end?null:c.e;if(b.period_end!=null){if(!cyIso(b.period_end))return bad('period_end','period_end must be a date as YYYY-MM-DD.');e=un(b.period_end)}
if(s>TODAY)return bad('period_start','The start date can’t be in the future.');if(e!=null&&e>TODAY)return bad('period_end','The end date can’t be in the future.');
if(e!=null&&e<s)return cyFail(400,'INVALID_PERIOD_END','The end date can’t be before the start date.');const o=cyChk(s,e,id);if(o)return o;
c.s=s;c.e=e;if(typeof b.note=='string')c.note=b.note;cySort();return cyRes(200,c)},
remove(id){const i=CYC.findIndex(q=>q.id===id);if(i<0)return cyFail(404,'NOT_FOUND','That period no longer exists.');CYC.splice(i,1);return{ok:true,status:200,deleted:true,id}}
}}})();
const SDEF={reminder_master:false,reminder_advance:false,reminder_on_day:false,reminder_overdue:false,reminder_days:3,reminder_trio_hour:9,reminder_fill_hour:21,reminder_daily_fill:false},SET=Object.assign({},SDEF),
CAPS={cycles:1000,predictions:2000,daily_records:4000},XCAPS={cycles:1000,predictions:1000,daily_records:2000},MAX_IMPORT_BYTES=8*1024*1024,DEMO_PW='demo1234',AUTH={password:DEMO_PW,persist:false};
const fail=(status,code,message,extra)=>Object.assign({ok:false,status,code,message},extra),vfail=(field,message)=>fail(422,'VALIDATION_ERROR',message,{field}),good=data=>({ok:true,status:200,data}),
isoOk=s=>typeof s=='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&un(s)!=null&&iso(un(s))===s;
// ---- import/export helpers: same contract numbers as Win/backend (settings.py docstring, services/gate.py)
const NUM=v=>typeof v=='number'&&isFinite(v),
GATE_EXPECT={G1:'7–90 days',G2:'not later than today',G3:'within 14 days of the history median',G4:'no more than 90 days between starts',G5:'2–10 days'},
histLengths=()=>{const so=[...CYC].sort((a,b)=>a.s-b.s||a.id-b.id),out=[];for(let i=1;i<so.length;i++){const g=so[i].s-so[i-1].s;if(g>=7&&g<=90)out.push(g)}return out},
gateDate=v=>typeof v=='string'&&v?isoOk(v.slice(0,10))?v.slice(0,10):null:null,
median=a=>{const b=a.slice().sort((x,y)=>x-y),m=b.length>>1;return b.length?(b.length%2?b[m]:(b[m-1]+b[m])/2):null};
// G1-G5, mirror of services/gate.py::evaluate_gate (dates compared as ISO strings, gaps in whole days).
// history=null/[] -> G3/G4 not applicable; derived lengths/gaps are chronological, never list order.
function gateEval(rows,history){
const hs=(history||[]).filter(NUM),hm=hs.length?median(hs):null,an=[];
const entries=rows.map((c,i)=>({i,c,s:c&&typeof c=='object'?gateDate(c.period_start):null,e:c&&typeof c=='object'?gateDate(c.period_end):null})),
chrono=entries.filter(t=>t.s!=null).slice().sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0),derived={},gaps={};
for(let k=1;k<chrono.length;k++){const gap=un(chrono[k].s)-un(chrono[k-1].s);derived[chrono[k].i]=gap;gaps[chrono[k].i]=gap}
const push=(code,field,value,message)=>an.push({code,field,value,expected:GATE_EXPECT[code],message});
entries.forEach(({i,c,s,e})=>{if(!c||typeof c!='object')return;
const pcl=NUM(c.cycle_length)?c.cycle_length:null,ppd=NUM(c.period_days)?c.period_days:null,
cl=pcl!=null?pcl:(derived[i]!=null?derived[i]:null),per=ppd!=null?ppd:(s&&e?un(e)-un(s)+1:null),label=s||('#'+(i+1));
if(cl!=null&&(cl<7||cl>90))push('G1','cycle_length',cl,`Record ${label} has a cycle length of ${cl} days, outside ${GATE_EXPECT.G1}.`);
if(s&&s>TODAY_ISO)push('G2','period_start',s,`Record ${label} starts on ${s}, which is after today (${TODAY_ISO}).`);
if(e&&e>TODAY_ISO)push('G2','period_end',e,`Record ${label} ends on ${e}, which is after today (${TODAY_ISO}).`);
if(hm!=null&&cl!=null&&Math.abs(cl-hm)>14)push('G3','cycle_length',cl,`Record ${label} is ${Math.abs(cl-hm)} days away from the history median of ${hm} days.`);
if(hm!=null&&gaps[i]!=null&&gaps[i]>90)push('G4','period_start_gap',gaps[i],`Record ${label} starts ${gaps[i]} days after the previous one, over ${GATE_EXPECT.G4}.`);
if(per!=null&&(per<2||per>10))push('G5','period_days',per,`Record ${label} lasts ${per} days, outside ${GATE_EXPECT.G5}.`)});
return an}
const MP_NUM=['mean_cycle','std_cycle','ema_cycle','prior_mean','prior_std'],
mpBadKey=o=>{for(const k of MP_NUM)if(k in o&&!NUM(o[k]))return k;
if(o.prior_weight!=null&&(!NUM(o.prior_weight)||o.prior_weight<0||o.prior_weight>1))return 'prior_weight';
if(o.n_records!=null&&(!(Number.isInteger(o.n_records)&&o.n_records>=0)))return 'n_records';return null};
// object -> JSON text; JSON text -> validated and kept verbatim; null/'' -> "{}"; anything else -> 400
function mpNorm(v,pd){if(v==null)return{ok:true,value:'{}'};
 if(typeof v=='object'&&!Array.isArray(v)){const k=mpBadKey(v);return k?{ok:false,message:`Prediction ${pd} model_params_json.${k} is not a valid value.`}:{ok:true,value:JSON.stringify(v)}}
 if(typeof v=='string'){if(!v)return{ok:true,value:'{}'};let o;try{o=JSON.parse(v)}catch(_){return{ok:false,message:`Prediction ${pd} model_params_json is not valid JSON text.`}}
  if(!o||typeof o!='object'||Array.isArray(o))return{ok:false,message:`Prediction ${pd} model_params_json must be a JSON object.`};
  const k=mpBadKey(o);return k?{ok:false,message:`Prediction ${pd} model_params_json.${k} is not a valid value.`}:{ok:true,value:v}}
 return{ok:false,message:`Prediction ${pd} model_params_json must be an object, JSON text or null.`}}
// model_params row mirrors crud.get_model_params (demo single user -> user_id 1).
// mean/std over adjacent start intervals; ema approximated by mean; priors fixed as the backend defaults.
function calcModel(){const st=[...CYC].sort((a,b)=>a.s-b.s||a.id-b.id).map(c=>c.s),iv=st.slice(1).map((s,i)=>s-st[i]),
r4=x=>Math.round(x*1e4)/1e4,raw=iv.length?iv.reduce((a,b)=>a+b,0)/iv.length:28,
mean=r4(raw),sd=iv.length>1?r4(Math.sqrt(iv.reduce((a,b)=>a+(b-raw)*(b-raw),0)/(iv.length-1))):7;
return{user_id:1,mean_cycle:mean,std_cycle:sd,n_records:iv.length,ema_cycle:mean,prior_mean:28,prior_std:7,prior_weight:0.5,updated_at:nowStamp()}}
let MODEL_PARAMS=calcModel();
const TODAY_ISO=iso(TODAY),predKey=p=>[String(p.predicted_date||''),String(p.created_at||''),Number(p.id)||0],
predCmp=(a,b)=>{const x=predKey(a),y=predKey(b);for(let i=0;i<3;i++){if(x[i]<y[i])return -1;if(x[i]>y[i])return 1}return 0};
api.settings=function(patch){if(patch===undefined)return good(Object.assign({},SET));
if(patch===null||typeof patch!='object'||Array.isArray(patch))return vfail('body','Settings must be an object.');
const next=Object.assign({},SET);for(const k of Object.keys(patch)){if(!(k in SDEF))return vfail(k,'Unknown setting: '+k+'.');const v=patch[k];
if(k=='reminder_days'){if(![1,2,3,5,7].includes(v))return vfail(k,'reminder_days must be one of 1, 2, 3, 5, 7.')}
else if(/_hour$/.test(k)){if(!Number.isInteger(v)||v<0||v>23)return vfail(k,k+' must be a whole hour from 0 to 23.')}
else if(typeof v!='boolean')return vfail(k,k+' must be true or false.');next[k]=v}
Object.assign(SET,next);return good(Object.assign({},SET))};
// GET /export: all three lists keep the latest N (cycles/predictions 1000, daily_records 2000) in canonical ASC order;
// full totals and *_truncated flags stay derived from the untruncated data.
// GET /export: aligned with Win/backend shape (cycles ASC, latest N, cycles totals).
// Q3: cycles ASC + id/user_id + cycles_total/truncated; predictions/daily keep the latest N.
api.export=function(){
const asc=CYC.slice().sort((a,b)=>a.s-b.s||a.id-b.id),clen=new Map();
for(let i=1;i<asc.length;i++){const g=asc[i].s-asc[i-1].s;clen.set(asc[i].id,g>=7&&g<=90?g:null)}
const cyclesAll=asc.map(c=>({id:c.id,user_id:1,period_start:iso(c.s),period_end:c.e==null?null:iso(c.e),cycle_length:clen.has(c.id)?clen.get(c.id):null,period_days:c.e==null?null:c.e-c.s+1,note:c.note||'',is_anomalous:false})),
cycles=cyclesAll.slice(-XCAPS.cycles),
dailyAll=Object.keys(DAILY).map(Number).sort((a,b)=>a-b).map(n=>{const g=DAILY[n];return{id:g.id,user_id:1,record_date:iso(n),pain_present:g.pain_present?1:0,pain_level:g.pain_present?g.pain_level:null,flow_level:g.flow_level,mood_level:g.mood_level,created_at:g.created_at,updated_at:g.updated_at}}),
predAll=PRED.slice().sort(predCmp),
predictions=predAll.slice(-XCAPS.predictions).map(p=>Object.assign({},p)),daily=dailyAll.slice(-XCAPS.daily_records);
return good({cycles,predictions,model_params:Object.assign({},MODEL_PARAMS),app_settings:{},exported_at:TODAY_ISO,cycles_total:cyclesAll.length,cycles_truncated:cyclesAll.length>XCAPS.cycles,predictions_total:predAll.length,predictions_truncated:predAll.length>XCAPS.predictions,daily_records:daily,daily_records_total:dailyAll.length,daily_records_truncated:dailyAll.length>XCAPS.daily_records})};
// full overwrite, same order as POST /import: types -> caps (422) -> EMPTY_IMPORT -> G1-G5 gate -> structure.
// JSON backups arrive as raw text (or an object); CSV is converted to {cycles:[...]} by the frontend first.
api.import=function(payload,opts){opts=opts||{};let p=payload;
// 8 MiB body gate, before parse/type checks (backend main.import_body_size_gate: strictly greater than the limit is rejected)
const raw=typeof payload=='string'?payload:(()=>{try{return JSON.stringify(payload)}catch(_){return ''}})();
if(new TextEncoder().encode(raw).length>MAX_IMPORT_BYTES)return fail(400,'IMPORT_TOO_LARGE','This backup is too large. The import limit is 8 MB.');
if(typeof p=='string'){if(!p.trim())return fail(400,'EMPTY_IMPORT','The file is empty.');try{p=JSON.parse(p)}catch(_){return fail(400,'INVALID_IMPORT','The file is not valid JSON.')}}
if(p==null||typeof p!='object'||Array.isArray(p))return fail(400,'INVALID_IMPORT','The file is not a PeriodIQ export.');
// list[dict] is required when the key is sent: absent/undefined -> default, explicit null or non-list -> 422 (Pydantic)
for(const k of ['cycles','predictions','daily_records']){if(!(k in p)||p[k]===undefined)continue;const a=p[k];
if(a==null||!Array.isArray(a))return vfail(k,`${k} must be a list.`);
for(let i=0;i<a.length;i++){const row=a[i];if(!row||typeof row!='object'||Array.isArray(row))return vfail(`${k}[${i}]`,`${k}[${i}] must be an object.`)}}
if(p.app_settings!=null&&(typeof p.app_settings!='object'||Array.isArray(p.app_settings)))return vfail('app_settings','app_settings must be an object.');
if(p.model_params!=null&&(typeof p.model_params!='object'||Array.isArray(p.model_params)))return vfail('model_params','model_params must be an object.');
const cyIn=p.cycles||[],prIn=p.predictions||[],drIn=p.daily_records||[];
const over=cyIn.length>CAPS.cycles?'cycles':prIn.length>CAPS.predictions?'predictions':drIn.length>CAPS.daily_records?'daily_records':null;
if(over)return fail(422,'VALIDATION_ERROR',`Too many ${over} in this file (limit ${CAPS[over]}).`,{field:over});
if(!cyIn.length)return fail(400,'EMPTY_IMPORT','There are no cycles in this file.');
// gate runs on the raw file with the pre-import CYC as history; allow_anomalies only skips the block
const anomalies=gateEval(cyIn,histLengths());
if(anomalies.length&&!opts.allow_anomalies)return fail(400,'DATA_ANOMALY','Some cycles look unusual.',{anomalies,total:anomalies.length});
const cy=[];
for(let i=0;i<cyIn.length;i++){const c=cyIn[i];
if(!c||typeof c!='object'||Array.isArray(c))return vfail(`cycles[${i}]`,`cycles[${i}] must be an object.`);
if(!isoOk(c.period_start))return fail(400,'INVALID_IMPORT',`cycles[${i}].period_start must be a real date as YYYY-MM-DD.`);
const s=un(c.period_start);let e=null;
if(c.period_end!=null){if(!isoOk(c.period_end))return fail(400,'INVALID_IMPORT',`cycles[${i}].period_end must be a real date as YYYY-MM-DD.`);e=un(c.period_end)}
if(e!=null&&e<s)return fail(400,'INVALID_IMPORT',`Cycle ${c.period_start} ends before it starts.`);
const note=String(c.note==null?'':c.note);if(note.length>2000)return fail(400,'INVALID_IMPORT',`cycles[${i}].note is longer than 2000 characters.`);
const ia=c.is_anomalous;if(ia!=null&&!(ia===true||ia===false||ia===0||ia===1))return fail(400,'INVALID_IMPORT',`cycles[${i}].is_anomalous must be true/false or 0/1.`);
if(s>TODAY||(e!=null&&e>TODAY))return fail(400,'INVALID_IMPORT',`Cycle ${c.period_start} is in the future.`);
cy.push({s,e,i,note})}
cy.sort((a,b)=>a.s-b.s||a.i-b.i);
const MV=['none','cold_start_1','cold_start_2','bayesian_v1','unknown'],pr=[];
for(let i=0;i<prIn.length;i++){const q=prIn[i];
if(!q||typeof q!='object'||Array.isArray(q))return vfail(`predictions[${i}]`,`predictions[${i}] must be an object.`);
const pd=q.predicted_date,up=q.predicted_start_upper,lo=q.predicted_start_lower;
if(!isoOk(pd)||!isoOk(lo)||!isoOk(up))return fail(400,'INVALID_IMPORT',`predictions[${i}] needs predicted_date, predicted_start_lower and predicted_start_upper as YYYY-MM-DD.`);
if(!(lo<=pd&&pd<=up))return fail(400,'INVALID_IMPORT',`Prediction ${pd} has reversed bounds (lower <= predicted <= upper).`);
if(!NUM(q.confidence)||q.confidence<0||q.confidence>1)return fail(400,'INVALID_IMPORT',`Prediction ${pd} confidence must be a number from 0 to 1.`);
const mv=q.model_version===undefined?'unknown':String(q.model_version);
if(mv.length>32||!MV.includes(mv))return fail(400,'INVALID_IMPORT',`Prediction ${pd} model_version is not one of ${MV.join('/')}.`);
const ad=q.actual_date==null?null:q.actual_date;
if(ad!=null&&!isoOk(ad))return fail(400,'INVALID_IMPORT',`Prediction ${pd} actual_date must be a real date as YYYY-MM-DD or null.`);
const ed=Number.isInteger(q.error_days)?q.error_days:null;
let ca=q.created_at;if(typeof ca!='string'||!ca)ca=nowStamp();
else if(ca.length>32||/[\u0000-\u001f\u007f]/.test(ca))return fail(400,'INVALID_IMPORT',`Prediction ${pd} created_at is invalid.`);
const mp=mpNorm(q.model_params_json,pd);if(!mp.ok)return fail(400,'INVALID_IMPORT',mp.message);
pr.push({predicted_date:pd,predicted_start_lower:lo,predicted_start_upper:up,confidence:q.confidence,model_version:mv,model_params_json:mp.value,actual_date:ad,error_days:ed,created_at:ca})}
pr.sort(predCmp);pr.forEach((q,i)=>{q.id=i+1});
const dr=[];
for(let i=0;i<drIn.length;i++){const d=drIn[i];
if(!d||typeof d!='object'||Array.isArray(d))return vfail(`daily_records[${i}]`,`daily_records[${i}] must be an object.`);
if(!isoOk(d.record_date))return fail(400,'INVALID_IMPORT',`daily_records[${i}].record_date must be a real date as YYYY-MM-DD.`);
const n=un(d.record_date);
if(n>TODAY)return fail(400,'INVALID_DAILY',`Daily record ${d.record_date} is in the future.`);
const pp=d.pain_present;if(!(typeof pp=='boolean'||pp===0||pp===1))return fail(400,'INVALID_DAILY',`Daily record ${d.record_date} needs pain_present true/false or 0/1.`);
const ppb=pp===true||pp===1,plv=d.pain_level==null?null:d.pain_level;
if(ppb&&!(Number.isInteger(plv)&&plv>=1&&plv<=10))return fail(400,'INVALID_DAILY',`Daily record ${d.record_date} needs pain_level 1–10 when pain is present.`);
if(!ppb&&plv!=null)return fail(400,'INVALID_DAILY',`Daily record ${d.record_date} must leave pain_level empty when there is no pain.`);
if(!(Number.isInteger(d.flow_level)&&d.flow_level>=1&&d.flow_level<=10))return fail(400,'INVALID_DAILY',`Daily record ${d.record_date} needs flow_level 1–10.`);
if(!(Number.isInteger(d.mood_level)&&d.mood_level>=1&&d.mood_level<=10))return fail(400,'INVALID_DAILY',`Daily record ${d.record_date} needs mood_level 1–10.`);
// created_at/updated_at follow settings._validate_created_at: missing/non-string/empty -> now, otherwise <=32 chars and no control chars
let ca=d.created_at;if(typeof ca!='string'||!ca)ca=nowStamp();
else if(ca.length>32||/[\u0000-\u001f\u007f]/.test(ca))return fail(400,'INVALID_IMPORT',`Daily record ${d.record_date} created_at is invalid (at most 32 characters, no control characters).`);
let ua=d.updated_at;if(typeof ua!='string'||!ua)ua=nowStamp();
else if(ua.length>32||/[\u0000-\u001f\u007f]/.test(ua))return fail(400,'INVALID_IMPORT',`Daily record ${d.record_date} updated_at is invalid (at most 32 characters, no control characters).`);
dr.push({n,pain_present:ppb,pain_level:ppb?plv:null,flow_level:d.flow_level,mood_level:d.mood_level,created_at:ca,updated_at:ua})}
// full overwrite: cycles (with notes) / predictions / daily come from the file; cycles never empty here.
// model_params in the file is ignored (backend recomputes from the imported cycles): always calcModel().
CYC.length=0;cy.forEach(c=>CYC.push({id:nextCycleId(),s:c.s,e:c.e,note:c.note}));norm();
PRED.length=0;pr.forEach(q=>PRED.push(q));
for(const k in DAILY)delete DAILY[k];
D.resetDailyIds();dr.forEach(r=>{DAILY[r.n]={id:nextDailyId(),created_at:r.created_at,updated_at:r.updated_at,pain_present:r.pain_present,pain_level:r.pain_level,flow_level:r.flow_level,mood_level:r.mood_level,mood_tags:[],mood_note:''}});
// backfill actual_date/error_days from the imported cycles (mirror prediction_service.rebackfill_prediction_actuals; idempotent)
const starts=CYC.map(c=>c.s);
for(const q of PRED){const pd=un(q.predicted_date);if(pd==null)continue;let lo=0,hi=starts.length;while(lo<hi){const md=(lo+hi)>>1;if(starts[md]<pd)lo=md+1;else hi=md}
if(lo==0||lo>=starts.length)continue;const a=starts[lo];q.actual_date=iso(a);q.error_days=Math.abs(a-pd)}
commit('api');
return good({imported_cycles:CYC.length,imported_predictions:PRED.length,imported_daily_records:dr.length,message:'Import complete.'})};
api.auth={state:()=>({persistent:AUTH.persist,demo_password:DEMO_PW}),
persistence(password){if(typeof password!='string'||!password.length)return vfail('password','Password is required.');if(password!==AUTH.password)return fail(400,'WRONG_PASSWORD','That password is not right.');AUTH.persist=true;return good({persistent:true})},
clearPersistence(){AUTH.persist=false;return good({persistent:false})},
changePassword(cur,next){if(typeof cur!='string'||!cur.length)return vfail('current_password','Current password is required.');if(typeof next!='string'||!next.length)return vfail('new_password','New password is required.');if(cur!==AUTH.password)return fail(400,'WRONG_PASSWORD','That password is not right.');AUTH.password=next;AUTH.persist=false;return good({persistent:false})},
logout(){AUTH.persist=false;return good({persistent:false})},
deleteAccount(password){if(typeof password!='string'||!password.length)return vfail('password','Password is required.');if(password!==AUTH.password)return fail(400,'WRONG_PASSWORD','That password is not right.');resetData();return good({deleted:true,persistent:false})},
profile(patch){if(patch===undefined)return good({nickname:profile.name});if(!patch||typeof patch.nickname!='string'||patch.nickname.trim().length>24)return vfail('nickname','nickname must be text of at most 24 characters.');profile.name=patch.nickname.trim();return good({nickname:profile.name})}};
function resetMock(){Object.assign(SET,SDEF);AUTH.password=DEMO_PW;AUTH.persist=false}
// mock prediction history: a few already-verified predictions derived from the seeded cycles
function seedPred(){PRED.length=0;const st=CYC.slice().sort((a,b)=>a.s-b.s||a.id-b.id).map(c=>c.s);
for(let i=1;i<st.length;i++){const off=i%2?1:0,pd=st[i]-off;
PRED.push({id:PRED.length+1,predicted_date:iso(pd),predicted_start_lower:iso(pd-4),predicted_start_upper:iso(pd+3),confidence:Math.round((.62+.08*rnd(i,9))*100)/100,model_version:i<2?'cold_start_2':'bayesian_v1',model_params_json:JSON.stringify({mean_cycle:st[i]-st[i-1],std_cycle:2.5,n_records:i}),actual_date:iso(st[i]),error_days:st[i]-pd,created_at:iso(st[i-1])+' 08:00:00'})}}
function seed(){CYC.length=0;PRED.length=0;for(const k in DAILY)delete DAILY[k];D.resetIds();SEEDS.forEach(([d,f,pn])=>{const s=toN(...d);CYC.push({id:nextCycleId(),s,e:s+5,note:''});for(let k=0;k<6;k++){const ts=iso(s+k)+' 07:30:00';DAILY[s+k]={id:nextDailyId(),created_at:ts,updated_at:ts,pain_present:pn[k]>0,pain_level:pn[k]>0?pn[k]:null,flow_level:lvOf[f[k]],mood_level:4+Math.floor(rnd(s+k,3)*5),mood_note:''}}});seedPred()}
function norm(){CYC.sort((a,b)=>a.s-b.s);return []}

// Installed only by api.installMock(): a real-mode page must never seed demo
// data on core.resetData() or recompute from mock hooks.
function installHooks(){core._data.onRecompute(()=>{MODEL_PARAMS=calcModel()});core._data.setResetHook(()=>{resetMock();seed()})}
core._providers.mock={predictions:api.predictions,scenario:api.scenario,validateDaily:api.validateDaily,gate:api.gate,getDaily:api.getDaily,putDailySync:api.putDaily,exportDaily:api.exportDaily,journalPutSync:api.journalPutSync,cycles:api.cycles,settings:api.settings,exportSync:api.export,importSync:api.import,auth:api.auth,seed,resetMock,installHooks};
})();
