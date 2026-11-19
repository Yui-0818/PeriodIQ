/* ===== state.js =====
 * 1 角色：全局内存态与日期/周期派生：CYC/DAILY/JOURNAL/PRED/P/LOG/profile/MOOD、hydrate 应用、journal 存取、recompute/cycleNow/hist/stats、_data 桥。
 * 2 依赖：浏览器 document/matchMedia/performance；必须在 fx/edit/app/core 之前加载。
 * 3 暴露：root,reduce,clamp,rnd,buzz,DAY,toN,dOf,fmt,TODAY,MN,FL,PW,iso,un,tierOf,lvOf,endOf,CYC,DAILY,JOURNAL,PRED,P,LOG,profile,MOOD,uid,duid,juid,psig,cycAt,days,sigOf,m,api,providers,recomputeHooks,resetHook,nowStamp,nextCycleId,nextDailyId,parse,HP,applyHydrate,journalGet,journalRange,journalPut,nextJournalId,recompute,adopt,cycleNow,hist,stats,_data（顶层词法声明，不挂 window）。
 * 4 不变量：CYC 按 s 升序；P/LOG 只能由 recompute 重建；JOURNAL 私有，仅经 journalGet/journalRange/journalPut 访问；uid/duid/juid 单调；预测只来自 HP（api.predictions()），UI 不自行计算。
 * 5 契约来源：Win\backend 周期/日记/预测数据契约（总纲见 js/core/transport.js 顶部原 api.js 1–75 行契约头）；本文件无数据层标记注释。
 * 6 禁止改动项：任何函数体、常量与阈值（21/45、3、6、7 等）、错误文案、TODAY 语义、既有注释与行序。
 * 迁自：前端demo/app拆解版@1cd5082 js/core.js 第 3–59、118–128、196 行
 */
const root=document.documentElement,reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),
rnd=(i,k=1)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)},buzz=p=>{try{navigator.userActivation&&navigator.userActivation.hasBeenActive&&navigator.vibrate&&navigator.vibrate(p)}catch(_){}};
// ================= one cycle model for the whole app (whole days, UTC) =================
const DAY=864e5,toN=(y,mo,d)=>Math.floor(Date.UTC(y,mo,d)/DAY),dOf=n=>new Date(n*DAY),fmt=(n,o)=>dOf(n).toLocaleDateString('en',Object.assign({timeZone:'UTC'},o)),TODAY=(d=>toN(d.getFullYear(),d.getMonth(),d.getDate()))(new Date()),
MN=['January','February','March','April','May','June','July','August','September','October','November','December'],FL=['','Spotting','Light','Medium','Heavy'],PW=['None','Mild','Mild','Mild','Moderate','Moderate','Moderate','Strong','Strong','Severe','Severe'];
// ---- cycle INTERVALS are the only local truth: {id,s,e|null}. e=null means "ongoing" (covers through TODAY).
// ---- Ovulation, fertile window, less-certain days and predicted periods are NEVER computed by the UI: they come from api.predictions().
const iso=n=>dOf(n).toISOString().slice(0,10),un=s=>{const a=String(s||'').split('-').map(Number);return a.length==3&&a.every(Number.isFinite)?toN(a[0],a[1]-1,a[2]):null},
tierOf=v=>v<=2?1:v<=4?2:v<=7?3:4,lvOf=[0,1,3,6,9],endOf=c=>c.e==null?TODAY:c.e;
const CYC=[],DAILY={},JOURNAL={},PRED=[],P=new Set(),LOG={},profile={name:''},MOOD={};let uid=1,duid=1,juid=1,psig='';
MOOD[toN(2026,9,10)]={mood:'Calm, a little tired',sym:['Cramps','Lower back ache','Fatigue']};MOOD[toN(2026,8,12)]={mood:'Irritable, then steady',sym:['Cramps','Headache','Bloating','Cravings']};MOOD[toN(2026,7,15)]={mood:'Steady',sym:['Mild cramps','Tender breasts']};
const cycAt=n=>{for(let i=CYC.length-1;i>=0;i--){const c=CYC[i];if(n>=c.s&&n<=endOf(c))return c}return null},days=()=>{const s=new Set();CYC.forEach(c=>{for(let d=c.s;d<=endOf(c);d++)s.add(d)});return s},sigOf=()=>[...P].sort((a,b)=>a-b).join();
const m={DAY,toN,dOf,fmt,TODAY,MN,FL,PW,P,LOG,M:{},CYC,DAILY,endOf,cycAt,tierOf,lvOf,seg:{ov:null,fert:null,lc:[],pred:[]}};
// ================= data-layer internal bridge (not page API) =================
const api={},providers={},recomputeHooks=[];let resetHook=null;
const nowStamp=()=>new Date().toISOString().slice(0,19).replace('T',' ');
const nextCycleId=()=>uid++,nextDailyId=()=>duid++;
const parse = function parse(p){const S={ov:null,fert:null,lc:[],pred:[]};if(!p)return S;S.ov=un(p.ovulation_date);const f=p.fertile_window;if(f&&un(f.start)!=null&&un(f.end)!=null)S.fert={s:un(f.start),e:un(f.end)};
// less-certain windows keep the service's phase/basis (missing -> null); predicted periods only need {s,e}
const wins=(a,o,meta)=>(a||[]).forEach(w=>{if(w&&un(w.start)!=null&&un(w.end)!=null)o.push(meta?{s:un(w.start),e:un(w.end),phase:w.phase||null,basis:w.basis==null?null:w.basis}:{s:un(w.start),e:un(w.end)})});wins(p.less_certain_windows,S.lc,1);wins(p.predicted_period_windows,S.pred);return S};
// ---- hydrate: the ONE loading entry for the real data layer. cycles/daily/predictions land in
// memory together (all-or-nothing upstream); pages keep reading the same sync model afterwards.
// journal is a SEPARATE optional channel: it arrives on its own request and its failure never fails
// hydration, so it is deliberately NOT part of that all-or-nothing set (an empty list still clears it).
let HP=null;
const applyHydrate = function applyHydrate(h){const c=(h&&h.cycles)||[],d=(h&&h.daily)||[],j=(h&&h.journal)||[];
CYC.length=0;c.slice().sort((a,b)=>a.s-b.s||(a.id||0)-(b.id||0)).forEach(x=>CYC.push({id:x.id,s:x.s,e:x.e==null?null:x.e,note:x.note||''}));
for(const k in DAILY)delete DAILY[k];
d.forEach(r=>{if(r.n==null)return;DAILY[r.n]={id:r.id,created_at:r.created_at==null?null:r.created_at,updated_at:r.updated_at==null?null:r.updated_at,pain_present:!!r.pain_present,pain_level:r.pain_present&&r.pain_level!=null?r.pain_level:null,flow_level:r.flow_level,mood_level:r.mood_level,mood_tags:Array.isArray(r.mood_tags)?r.mood_tags:[],mood_note:''}});
for(const k in JOURNAL)delete JOURNAL[k];
j.forEach(r=>{if(!r)return;const n=r.n==null?un(r.record_date):r.n;if(n==null)return;JOURNAL[n]={id:r.id==null?null:r.id,note:typeof r.note=='string'?r.note:'',created_at:r.created_at==null?null:r.created_at,updated_at:r.updated_at==null?null:r.updated_at,record_date:typeof r.record_date=='string'?r.record_date:iso(n)}});
HP=(h&&h.predictions)||null;
uid=c.reduce((m,x)=>Math.max(m,(x.id||0)+1),1);duid=d.reduce((m,x)=>Math.max(m,(x.id||0)+1),1);juid=j.reduce((m,x)=>{const v=x&&x.id;const id=(typeof v==='number'||(typeof v==='string'&&v.trim()!==''))?Number(v):NaN;return Number.isFinite(id)?Math.max(m,id+1):m},1)};
// ---- journal store accessors (JOURNAL stays private; the api modules only call these, never the map).
// note is always a string in memory: upstream null / non-strings are normalized to '' on the way in.
const journalGet = function journalGet(n){const r=JOURNAL[n];return r?Object.assign({},r):null};
const journalRange = function journalRange(from,to){if(from==null||to==null||from>to)return[];const out=[];Object.keys(JOURNAL).map(Number).filter(n=>n>=from&&n<=to).sort((a,b)=>a-b).forEach(n=>out.push(Object.assign({n},JOURNAL[n])));return out};
const journalPut = function journalPut(n,row){if(row==null){delete JOURNAL[n];return}JOURNAL[n]={id:row.id==null?null:row.id,note:typeof row.note=='string'?row.note:'',created_at:row.created_at==null?null:row.created_at,updated_at:row.updated_at==null?null:row.updated_at,record_date:typeof row.record_date=='string'?row.record_date:iso(n)}};
const nextJournalId=()=>juid++;
// the backend never joins adjacent cycles (the /cycles neighbours decide what is legal); keep the name, drop the merge
const recompute = function recompute(){CYC.sort((a,b)=>a.s-b.s);P.clear();for(const k in LOG)delete LOG[k];
for(const c of CYC)for(let d=c.s;d<=endOf(c);d++){P.add(d);const g=DAILY[d];LOG[d]=g?{flow:tierOf(g.flow_level),pain:g.pain_present&&g.pain_level?g.pain_level:0}:{flow:2,pain:1}}
const starts=CYC.map(c=>c.s),runs=CYC.map(c=>endOf(c)-c.s+1);let avg=28;
if(starts.length>1){const iv=starts.slice(1).map((s,i)=>s-starts[i]);avg=clamp(Math.round(iv.reduce((a,b)=>a+b,0)/iv.length),21,45)}
const cr=CYC.filter(c=>c.e!=null).map(c=>c.e-c.s+1),plen=cr.length?Math.max(3,Math.round(cr.reduce((a,b)=>a+b,0)/cr.length)):6,S=m.seg=parse(api.predictions()),all=[...starts];const nw=S.pred.find(w=>w.s>TODAY);if(nw)all.push(nw.s);
const rng=w=>{const a=[];for(let d=w.s;d<=w.e;d++)a.push(d);return a},pred=new Set(S.pred.flatMap(rng)),ov=new Set(S.ov==null?[]:[S.ov]),fert=new Set(S.fert?rng(S.fert).filter(d=>d!==S.ov):[]),cyc=[];
if(S.ov!=null){const c=[...CYC].reverse().find(q=>q.s<S.ov);if(c){const pe=endOf(c);if(S.ov>pe+1)cyc.push({s:c.s,pe,ov:S.ov})}}
m.M={starts,all,avg,plen,last:starts.length?starts[starts.length-1]:TODAY-14,pred,ov,fert,cyc,runs};psig=sigOf();
// single source of truth: every commit recomputes model_params from the current cycles (backend full_recompute_model_params)
for(const fn of recomputeHooks) fn();};
// legacy bridge: if an out-of-scope page edited the old day Set (P) / LOG directly (e.g. a backup import), adopt it back into intervals
const adopt = function adopt(){if(sigOf()===psig)return;const ds=[...P].sort((a,b)=>a-b);CYC.length=0;let s=null,pv=null;ds.forEach(d=>{if(pv==null||d!=pv+1){if(s!=null)CYC.push({id:nextCycleId(),s,e:pv,note:''});s=d}pv=d});if(s!=null)CYC.push({id:nextCycleId(),s,e:pv,note:''});
ds.forEach(d=>{const g=LOG[d];if(g&&!DAILY[d])DAILY[d]={id:nextDailyId(),created_at:nowStamp(),updated_at:nowStamp(),pain_present:g.pain>0,pain_level:g.pain>0?g.pain:null,flow_level:lvOf[clamp(g.flow||2,1,4)],mood_level:5,mood_note:''}})};
m.typeOf=n=>P.has(n)?'period':m.M.pred.has(n)?'pred':m.M.ov.has(n)?'ov':m.M.fert.has(n)?'fert':null;
m.softOf=n=>m.seg.lc.some(w=>n>=w.s&&n<=w.e);
m.info=n=>{let cs=null,ns=null;for(const s of m.M.all){if(s<=n)cs=s;else{ns=s;break}}return{cs,ns,cd:cs==null?null:n-cs+1,until:ns==null?null:ns-n}};
m.runIdx=(n,set)=>{let k=1;while(set.has(n-k))k++;return k};
// the cycle we are inside right now. Fields that the service did not provide are null (never filled in locally).
const cycleNow=()=>{const S=m.seg,c=CYC.filter(q=>q.s<=TODAY).pop();if(!c)return{cs:null,ns:null,cd:null,until:null,len:null,per:null,ov:null,fs:null,fe:null};
const cs=c.s,pw=S.pred.find(w=>w.s>TODAY),ns=pw?pw.s:null;return{cs,ns,cd:TODAY-cs+1,until:ns==null?null:ns-TODAY,len:ns==null?null:ns-cs,per:endOf(c)-cs+1,ov:S.ov==null?null:S.ov-cs+1,fs:S.fert?S.fert.s-cs+1:null,fe:S.fert?S.fert.e-cs+1:null}};
// records, newest first, for History. flow entries are 4 tiers or null (no entry); pain is 0..10 or null (nothing logged).
const hist=()=>{const st=m.M.starts,out=[];for(let i=st.length-1;i>=0;i--){const c=CYC[i],s=c.s,run=endOf(c)-s+1,fl=[],pn=[];for(let k=0;k<run;k++){const g=DAILY[s+k];fl.push(g?tierOf(g.flow_level):null);pn.push(g?(g.pain_present&&g.pain_level?g.pain_level:0):null)}
const mm=api._mode!=='mock'?{mood:'',sym:[]}:(MOOD[s]||{mood:'',sym:[]}),pk=pn.filter(v=>v!=null);out.push({s,per:c.e==null?null:run,fl,pain:pk.length?Math.max(0,...pk):null,mood:mm.mood,sym:mm.sym,first:i==0})}
const fw=(m.seg&&m.seg.pred||[]).find(w=>w.s>TODAY),ns=fw?fw.s:null;out.forEach((o,i)=>{const gap=i>0?out[i-1].s-o.s:null;o.len=gap!=null&&(gap<7||gap>90)?null:gap;o.segLen=i==0?Math.max(1,ns!=null?ns-o.s:TODAY-o.s+1):out[i-1].s-o.s;o.dn=o.first?fmt(o.s,{month:'short'}):String(dOf(o.s).getUTCDate());
o.eb=o.first?fmt(o.s,{month:'short',year:'numeric'}):fmt(o.s,{month:'short',day:'numeric',year:'numeric'})+' · '+fmt(o.s,{weekday:'short'})});return out};
// numbers for Insights
const stats=()=>{const st=m.M.starts,all=st.slice(1).map((s,i)=>s-st[i]),iv=all.filter(x=>x>=7&&x<=90),n=iv.length,cr=CYC.filter(c=>c.e!=null).map(c=>c.e-c.s+1),avg=n?Math.round(iv.reduce((a,b)=>a+b,0)/n):null,avgPer=cr.length?Math.round(cr.reduce((a,b)=>a+b,0)/cr.length):null;
return{total:st.length,complete:n,iv,avg,avgPer,shortest:n?Math.min(...iv):null,longest:n?Math.max(...iv):null,abn:all.filter(x=>x<21||x>35).length,first:st[0],last:st[st.length-1],starts:st}};
const _data={recompute,nowStamp,iso,un,rnd,clamp,nextCycleId,nextDailyId,nextJournalId,applyHydrate,journalGet,journalRange,journalPut,predictions:()=>HP,resetIds(){uid=1;duid=1;juid=1},resetDailyIds(){duid=1},onRecompute(fn){recomputeHooks.push(fn)},setResetHook(fn){resetHook=fn}};
