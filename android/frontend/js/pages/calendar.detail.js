/* ------------------------------------------------------------------
   1 角色：Calendar 页日详情：fill/bnd/det/save/doEdit、Ruler 三件套、note 与 gate 原因。第 2 轮改动：#gcode 改人话短语（机器码仅留注释）；边界键改 aria-disabled（虚线+斜纹，不靠透明度）；三项统计改带引线的纵向读数；标尺移除方向箭头（保留首次回弹）；#dtl 四态类；reduced-motion 降级
   2 依赖：core、PG、state（state.sel/state.pOpen/state.gateR/state.grid 等）。
   3 暴露：CalendarDetail(core,PG,state) → {fill,selectDay,closeP,drawNote,nsize,RF,RP,RM}。新增类仅 x- 前缀：x-st-future x-st-old x-st-notperiod x-st-edit（#dtl 四态）、x-of（预测日分母）、x-hd x-sfx（标尺标签主/副）。
   4 不变量：四件套写入路径、日记通道、只读 gate 文案与 Ruler 参数逐字保留；gateR 经 state 供主文件绘制。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/calendar.js 第 108–188、207–241 行。
   6 禁止改动项：不改选择器/时长/缓动/分支顺序；不加依赖；不挂 window；不得重写编辑/保存路径；唯一文案例外：#gcode。
   3.1.3 变更：删除周期数据前必须二次确认（#cf，默认焦点 Cancel，Escape/返回键关闭）；非今天日记真正只读；三条标尺补 role=slider/aria 值/方向键与 Home/End；其余逐字保留。
   迁自：demo@1cd5082 js/pages/calendar.js 第 108–188、207–241 行
   ------------------------------------------------------------------ */
const CalendarDetail = (core, PG, state) => {
const {toN,dOf,fmt,TODAY,MN,FL,PW,typeOf,softOf,info,endOf,cycAt,tierOf}=core.m,api=core.api;
// ---------- detail panel
const dpw=state.$('#dpw');
// [P1-1] deleting cycle data always passes through this confirmation: it names the segment and
// how many days are removed, starts focus on Cancel, and closes on Escape / hardware back.
const cf=state.$('#cf'),cft=state.$('#cft'),cfm=state.$('#cfm'),cfyes=state.$('#cfyes'),cfno=state.$('#cfno');
let cfRun=null,cfBack=null;
function hideCF(restore){if(!cf||cf.hidden)return;cf.hidden=true;cf.setAttribute('aria-hidden','true');cfRun=null;const b=cfBack;cfBack=null;if(restore&&b){try{b.focus({preventScroll:true})}catch(_){}}}
function showCF(title,msg,ok,run,opener){if(!cf)return;cfBack=opener||null;cfRun=run;cft.textContent=title;cfm.textContent=msg;cfyes.textContent=ok;cf.hidden=false;cf.setAttribute('aria-hidden','false');try{cfno.focus({preventScroll:true})}catch(_){}}
function askDelete(kind,n,opener){const c=cycAt(n);if(!c){doEdit(kind);return}
const e=endOf(c),days=e-c.s+1,span=`${dfmt(c.s,md)} – ${dfmt(e,md)} · ${core.i18n.t(core.i18n.plural(days,'ui.day'),{n:days})}`;
let title,msg,ok;
if(kind=='remove'||c.s==e){title=core.i18n.t('cal.cfDelTitle');ok=core.i18n.t('cal.cfDelOk');msg=core.i18n.t('cal.cfDelMsg',{span})}
else if(n==c.s){title=core.i18n.t('cal.cfClrTitle');ok=core.i18n.t('cal.cfClrOk');msg=core.i18n.t('cal.cfClrStart',{d:dfmt(n,md),next:dfmt(n+1,md)})}
else if(n==e){title=core.i18n.t('cal.cfClrTitle');ok=core.i18n.t('cal.cfClrOk');msg=core.i18n.t('cal.cfClrEnd',{d:dfmt(n,md),prev:dfmt(n-1,md)})}
else{title=core.i18n.t('cal.cfClrTitle');ok=core.i18n.t('cal.cfClrOk');msg=core.i18n.t('cal.cfClrSplit',{d:dfmt(n,md)})}
showCF(title,msg,ok,()=>doEdit(kind),opener)}
cfyes.onclick=()=>{const run=cfRun;hideCF(false);if(run)run()};
cfno.onclick=()=>hideCF(true);
cf.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const f=[cfno,cfyes],i=f.indexOf(document.activeElement);e.preventDefault();const nx=e.shiftKey?(i<=0?f.length-1:i-1):(i<0||i>=f.length-1?0:i+1);f[nx].focus()});
// Escape cancels the confirmation without touching data (capture so the sheet stays open)
window.addEventListener('keydown',e=>{if(e.key!=='Escape'||!cf||cf.hidden||!core.isCur('cal'))return;e.preventDefault();e.stopPropagation();hideCF(true)},true);
function selectDay(n){if(state.sel===n&&state.pOpen){closeP();return}if(n!==state.sel&&nt===document.activeElement)nt.blur();state.sel=n;state.pOpen=true;const c=state.L3[1].byN[n];if(c)dpw.style.setProperty('--ox',(c.x+0)+'px');dpw.classList.add('open');fill(1);if(c){state.wave(...ptOf(c));state.buzz(8)}
setTimeout(()=>{const r=dpw.getBoundingClientRect();if(r.bottom>innerHeight-110)state.scrollBy({top:Math.min(r.bottom-innerHeight+130,r.top-90),behavior:'smooth'})},700)}
const ptOf=c=>{const r=state.cal.getBoundingClientRect();return[r.left+18+c.x,r.top+c.y]};
function closeP(){state.pOpen=false;dpw.classList.remove('open');hideCF(false)}
state.$('#dx').onclick=closeP;
// ---------- drawer: header + stats from the API segments · boundary editing · validation gate · daily fields
const dfmt=(n,o)=>core.i18n.date(n,o),md={month:'short',day:'numeric'},
GATE={future:['cal.gateFutureT','cal.gateFutureS'],old:['cal.gateOldT','cal.gateOldS'],notperiod:['cal.gateQuietT','cal.gateQuietS']},
GC={edit:'cal.gcEdit',daily:'cal.gcEdit',future:'cal.gcFuture',old:'cal.gcOld',notperiod:'cal.gcNone'},
KMSG={create:'cal.kCreate','pull-start':'cal.kPull',extend:'cal.kExtend','trim-head':'cal.kTrimS','trim-tail':'cal.kTrimE',close:'cal.kClose',split:'cal.kSplit',delete:'cal.kDelete'},
BLANK=()=>({pain_present:false,pain_level:null,flow_level:4,mood_level:null,mood_tags:[]}),
fade=(el,m)=>{el.textContent=m;if(state.reduce)return;el.animate([{opacity:0,filter:'blur(6px)'},{opacity:.75,filter:'blur(0)'}],{duration:520,easing:'cubic-bezier(.2,.9,.1,1)'})},say=m=>fade(state.$('#sv'),m),bsay=m=>fade(state.$('#bxm'),m);
let D=BLANK(),saveT=0,wasOk=null,noteN=0,wasFull=false,nsp=[];const dtl=state.$('#dtl');
const subOf=(n,c)=>{const g=api.getDaily(n);return g?core.i18n.t('cal.subFlow',{f:g.flow_level,p:g.pain_present?core.i18n.t('cal.subPain',{p:g.pain_level}):core.i18n.t('cal.subNoPain'),m:g.mood_level}):(c&&c.e==null&&n==TODAY?core.i18n.t('cal.ongoingLogged'):core.i18n.t('cal.logged'))};
function fill(dir){state.$('#bxm').textContent='';const n=state.sel,ty=typeOf(n),sf=softOf(n),f=info(n),future=n>TODAY,c=cycAt(n),S=core.m.seg;state.$('#dd').textContent=dfmt(n,{weekday:'short',month:'short',day:'numeric',year:'numeric'})+(n==TODAY?' · '+core.i18n.t('ui.today'):'');
let hl,sub,s3;
if(ty=='period'){hl=core.i18n.t('cal.periodDayN',{n:n-c.s+1});sub=subOf(n,c);s3=`<b>${n-c.s+1}</b><span>${core.i18n.t('cal.statPeriodDay')}</span>`}
else if(ty=='pred'){const w=S.pred.find(q=>n>=q.s&&n<=q.e);hl=core.i18n.t('cal.predDayN',{n:n-w.s+1});sub=core.i18n.t('cal.predEst');s3=`<b>${n-w.s+1}<small class="x-of"> / ${w.e-w.s+1}</small></b><span>${core.i18n.t('cal.statPredDay')}</span>`}
else if(ty=='ov'){hl=core.i18n.t('cal.statOv');sub=n==TODAY?core.i18n.t('cal.peakNow'):n<TODAY?core.i18n.t('cal.peakEst'):core.i18n.t('cal.peakExpect');s3=`<b class="w">${core.i18n.t('cal.statPeak')}</b><span>${core.i18n.t('cal.statOv')}</span>`}
else if(ty=='fert'){const w=S.fert,o=S.ov;hl=core.i18n.t('cal.fertDayN',{a:n-w.s+1,b:w.e-w.s+1});sub=n==w.e?(n==TODAY?core.i18n.t('cal.fertClosesToday'):core.i18n.t('cal.fertLast')):o!=null&&o>n?core.i18n.t(core.i18n.plural(o-n,'cal.ovIn'),{n:o-n}):core.i18n.t(core.i18n.plural(w.e-n,'cal.closesIn'),{n:w.e-n});s3=`<b class="w">${core.i18n.t('cal.statFert')}</b><span>${core.i18n.t('cal.statWin')}</span>`}
else if(sf){hl=core.i18n.t('cal.lcT');sub=core.i18n.t('cal.lcS');s3=`<b class="w">${core.i18n.t('cal.statHazy')}</b><span>${core.i18n.t('cal.statLc')}</span>`}
else{hl=core.i18n.t('cal.quietT');sub=f.until!=null?core.i18n.t(core.i18n.plural(f.until,'cal.untilNext'),{n:f.until}):'';s3=`<b class="w">${core.i18n.t('cal.statQuiet')}</b><span>${core.i18n.t('cal.statNone')}</span>`}
s3=`<i class="mk ${ty=='period'?'p':ty=='pred'?'d':ty=='ov'?'o':ty=='fert'?'f':sf?'l':'q'}"></i>`+s3;state.roll(state.$('#dt'),hl,dir);state.roll(state.$('#ds'),sub||'&nbsp;',dir);
state.roll(state.$('#s1'),f.cd!=null?`<b>${f.cd}</b><span>${core.i18n.t('cal.stCd')}</span>`:`<b>—</b><span>${core.i18n.t('cal.stCd')}</span>`,dir);
state.roll(state.$('#s2'),f.until!=null?`<b>${f.until}</b><span>${core.i18n.t('cal.stUntil')}</span>`:`<b>—</b><span>${core.i18n.t('cal.stNext')}</span>`,dir);state.roll(state.$('#s3'),s3,dir);
state.$('#bxw').classList.toggle('on',!future);bnd();det()}
// boundary: Mark start / Mark end / Clear day edit the cycle INTERVAL (cross-cycle fuse, split and delete are handled in core.edit)
function bnd(){const n=state.sel,c=cycAt(n),pv=[...core.m.CYC].reverse().find(q=>endOf(q)<n);
state.$('#lqt').textContent=c?(n==TODAY&&c.e==null?core.i18n.t('cal.qStill'):core.i18n.t('cal.qInside')):(n==TODAY?core.i18n.t('cal.qStartToday'):core.i18n.t('cal.qWas'));
state.$('#bs').setAttribute('aria-pressed',!!c&&n==c.s);state.$('#be').setAttribute('aria-pressed',!!c&&c.e!=null&&c.e==n);
state.$('#be').setAttribute('aria-disabled',!c&&!pv);state.$('#bc').setAttribute('aria-disabled',!c);state.$('#brm').classList.toggle('on',!!c);
state.$('#bxs').textContent=c?core.i18n.t('cal.periodRange',{a:dfmt(c.s,md),e:c.e==null?core.i18n.t('cal.ongoing'):dfmt(c.e,md),d:core.i18n.t(core.i18n.plural(endOf(c)-c.s+1,'ui.day'),{n:endOf(c)-c.s+1})}):core.i18n.t('cal.noPeriodDay')}
// daily details: gate (read-only reason from the validation chain) or fields
function det(){const n=state.sel,g=api.gate(n),ok=g.ok,jw=api.journal.writable(n);
nt.readOnly=!jw;nt.setAttribute('aria-readonly',jw?'false':'true');
if(!ok){state.gateR=g.reason;state.$('#gh').textContent=core.i18n.t(GATE[g.reason][0]);state.$('#gs').textContent=core.i18n.t(GATE[g.reason][1])}
state.$('#gcode').textContent=core.i18n.t(ok?(jw?GC.edit:GC.daily):GC[g.reason]);{const sk=ok?'edit':g.reason;['future','old','notperiod','edit'].forEach(k=>dtl.classList.toggle('x-st-'+k,k===sk))}
D=api.getDaily(n)||BLANK();
RF.v=D.flow_level;RP.v=D.pain_level||5;RM.v=D.mood_level||RM.v||5;RM.unset=D.mood_level==null;
RF.cue();RM.cue();if(D.pain_present)RP.cue();
state.$('#pt').setAttribute('aria-pressed',D.pain_present);state.$('#pt').disabled=!ok;state.$('#pt').setAttribute('aria-disabled',ok?'false':'true');state.$('#pgx').classList.toggle('on',D.pain_present);
if(document.activeElement!==nt)nt.value=api.journal.get(n).note;
noteN=api.journal.countNote(nt.value);wasFull=noteN>=NM;ntw.classList.toggle('near',noteN>=NM*.9);readouts();
state.$('#sv').textContent=!ok
  ?core.i18n.t(GATE[g.reason][1])
  :(jw?(api.isPeriodDay(n)&&D.mood_level==null?core.i18n.t('cal.pickMood'):core.i18n.t('cal.savedNote'))
    :core.errors.text('JOURNAL_READONLY'));
const grow=ok&&wasOk===false;state.$('#gate').classList.toggle('on',!ok);state.$('#rg').classList.toggle('on',ok||jw);if(grow)slab();wasOk=ok;rulerA11y(ok);state.gsize()}
function rulerEditable(r,ed){r.ro=!ed;r.cv.setAttribute('aria-disabled',ed?'false':'true');r.cv.tabIndex=ed?0:-1}
function rulerA11y(ok){rulerEditable(RF,ok);rulerEditable(RM,ok);rulerEditable(RP,ok&&D.pain_present)}
function slab(){const dp=state.$('#dp');dp.classList.remove('grow');void dp.offsetWidth;dp.classList.add('grow');const r=state.$('#rg').getBoundingClientRect(),x=r.left+r.width/2,y=r.top+34;state.wave(x,y);core.fx({type:'ring',x,y,dur:1100})}
const PWK=[null,'cal.painW1','cal.painW1','cal.painW1','cal.painW5','cal.painW5','cal.painW5','cal.painW8','cal.painW8','cal.painW10','cal.painW10'],
MWK=[null,'cal.moodW2','cal.moodW2','cal.moodW4','cal.moodW4','cal.moodW6','cal.moodW6','cal.moodW8','cal.moodW8','cal.moodW10','cal.moodW10'];
function readouts(){const f=D.flow_level,mv=D.mood_level;state.$('#fv').textContent=core.i18n.t('cal.tier'+tierOf(f));state.$('#fc').textContent=core.i18n.t('cal.of10',{n:f});state.$('#pn').textContent=D.pain_present?D.pain_level:'–';state.$('#pc').textContent=D.pain_present?`/ 10 · ${core.i18n.t(PWK[D.pain_level])}`:core.i18n.t('cal.noPain');state.$('#mv').textContent=mv==null?'—':mv;state.$('#mc').textContent=mv==null?core.i18n.t('cal.notSet'):`/ 10 · ${core.i18n.t(MWK[mv])}`;
RF.cv.setAttribute('aria-valuenow',f);RF.cv.setAttribute('aria-valuetext',`${state.$('#fv').textContent}, ${state.$('#fc').textContent}`);
const pv=D.pain_present?(D.pain_level||5):5;RP.cv.setAttribute('aria-valuenow',pv);RP.cv.setAttribute('aria-valuetext',D.pain_present?`${state.$('#pn').textContent} ${state.$('#pc').textContent}`:core.i18n.t('cal.noPain'));
RM.cv.setAttribute('aria-valuenow',mv==null?5:mv);RM.cv.setAttribute('aria-valuetext',mv==null?core.i18n.t('cal.notSet'):`${state.$('#mv').textContent} ${state.$('#mc').textContent}`)}
async function save(){if(state.sel==null)return;
const n=state.sel,note=nt.value,period=api.gate(n).ok;let fail='',skip=false,saved=false,dailyFailed=false;
if(period){if(D.mood_level==null){skip=true;say(core.i18n.t('cal.pickMood'))}
else{const r=await api.putDaily(n,D);if(r.ok){saved=true;state.roll(state.$('#ds'),subOf(n,cycAt(n)),0)}else{fail=r.code?core.errors.text(r.code):r.message;dailyFailed=true}}}
let journalFailed=false;
if(api.journal.writable(n)&&note!==api.journal.get(n).note){const jr=await api.journal.put(n,note);if(jr.ok)saved=true;else{journalFailed=true;fail=fail||jr.message}}
if(n===state.sel&&dailyFailed&&!journalFailed)det();
if(fail)say(fail);else if(saved&&!skip)say(api.journal.writable(n)?core.i18n.t('cal.savedNote'):core.errors.text('JOURNAL_READONLY'))}
async function doEdit(op){const n=state.sel,res=await core.edit(op,n);if(!res.ok){bsay(res.msg);return}
state.cutDay=res.kind=='split'?n:null;state.L3.forEach(L=>state.grid.refresh(L));state.cutDay=null;echo(res);state.legend();state.unm();fill(1);bsay(res.merged.length?core.i18n.t('cal.kJoined'):core.i18n.t(KMSG[res.kind]))}
// one boundary edit answers everywhere: constellation cells pop / extinguish with ripples, the sky warps, and Today re-forms its orbit when you return
const kick=v=>{if(!state.reduce)state.warpV+=v};
function echo(res){const c=state.L3[1].byN[res.n],pt=c?ptOf(c):[innerWidth/2,innerHeight*.4],x=pt[0],y=pt[1],k=res.kind,mg=res.merged.length;state.wave(x,y);
if(k=='delete'){core.fx({type:'ring',x,y,dur:1000});core.fx({type:'orb',from:{x,y},to:{x:state.SW*(.2+.6*state.rnd(state.now,1)),y:state.SH*.12},dur:1000});kick(700)}
else if(k=='split'){core.fx({type:'warp',x,y,dur:900});core.fx({type:'ring',x,y,dur:1100});kick(-500)}
else if(mg){core.fx({type:'warp',x,y,dur:1100});core.fx({type:'ring',x,y,dur:1300});core.fx({type:'bloom',x,y,dur:900});kick(-1300)}
else if(/create|pull|extend/.test(k)){core.fx({type:'bloom',x,y,dur:900});core.fx({type:'ring',x,y,dur:1100});kick(-800)}
else{core.fx({type:'ring',x,y,dur:1000});kick(500)}
state.buzz(k=='delete'?[8,20,8]:[10,30,10])}
state.$('#bs').onclick=()=>doEdit('start');state.$('#be').onclick=()=>doEdit('end');state.$('#bc').onclick=e=>askDelete('clear',state.sel,e.currentTarget);state.$('#brm').onclick=e=>askDelete('remove',state.sel,e.currentTarget);
state.$('#pt').onclick=e=>{if(!api.gate(state.sel).ok)return;D.pain_present=!D.pain_present;D.pain_level=D.pain_present?(RP.v||5):null;state.$('#pt').setAttribute('aria-pressed',D.pain_present);state.$('#pgx').classList.toggle('on',D.pain_present);rulerEditable(RP,api.gate(state.sel).ok&&D.pain_present);if(D.pain_present)RP.cue();readouts();const r=e.currentTarget.getBoundingClientRect();state.wave(r.left+r.width/2,r.top+r.height/2);state.buzz(6);save()};
// ---------- note: <=api.journal.limit code points, journal channel only. The counter is a ring of ticks (one tick = 10 characters); near the limit it throws stardust and the glass thickens
const nt=state.$('#nt'),nc=state.$('#nc'),ntw=state.$('#ntw'),NM=api.journal.limit,NS=72;function nsize(){nc.width=NS*state.dpr;nc.height=NS*state.dpr}
// [data-layer] codepoint truncation + count through api.journal (never .length / .slice on the note)
nt.oninput=()=>{nt.value=api.journal.truncate(nt.value);noteN=api.journal.countNote(nt.value);ntw.classList.toggle('near',noteN>=NM*.9);
if(noteN>=NM&&!wasFull){wasFull=true;ntw.classList.remove('full');void ntw.offsetWidth;ntw.classList.add('full');const r=nc.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;state.wave(x,y);core.fx({type:'ring',x,y,dur:900});state.buzz(12)}else if(noteN<NM)wasFull=false;
// [data-layer] Clear the previous debounce so keystrokes never stack; only a writable day (today)
// arms a new 450 ms save. A read-only day writes nothing — det() showed the mapped text once.
clearTimeout(saveT);if(api.journal.writable(state.sel))saveT=setTimeout(save,450)};
function drawNote(t,dt){if(!state.$('#rg').classList.contains('on'))return;const c=nc.getContext('2d'),N=30,fr=noteN/NM,lit=Math.floor(fr*N+1e-6),cx=NS/2,cy=NS/2,T=state.reduce?0:t;c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,NS,NS);c.lineCap='round';
for(let i=0;i<N;i++){const a=-Math.PI/2+i/N*6.2832,on=i<lit,hot=on&&i>=N*.9,r1=19+(hot?Math.sin(T*9+i)*.8:0),r2=on?(hot?29+1.5*Math.sin(T*6+i):26):23;c.strokeStyle=state.ik(on?(hot?1:.8):.22);c.lineWidth=hot?1.6:1;c.beginPath();c.moveTo(cx+Math.cos(a)*r1,cy+Math.sin(a)*r1);c.lineTo(cx+Math.cos(a)*r2,cy+Math.sin(a)*r2);c.stroke()}
if(fr>=.9&&!state.reduce&&Math.random()<dt*(fr>=1?40:14)){const a=Math.random()*6.2832;nsp.push({x:cx+Math.cos(a)*27,y:cy+Math.sin(a)*27,vx:Math.cos(a)*(8+14*Math.random()),vy:Math.sin(a)*(8+14*Math.random())-6,t0:t})}
nsp=nsp.filter(p=>t-p.t0<1.4);for(const p of nsp){const u=(t-p.t0)/1.4;c.fillStyle=state.ik(.9*(1-u));c.beginPath();c.arc(p.x+p.vx*u*1.4,p.y+p.vy*u*1.4,1.3*(1-u)+.3,0,7);c.fill()}
c.fillStyle=state.ik(.85);c.font="700 12px Inter,'Noto Sans SC',system-ui,sans-serif";c.textAlign='center';c.textBaseline='middle';c.fillText(String(NM-noteN),cx,cy+.5)}
state.$('#ql').onclick=()=>{const go2=()=>selectDay(TODAY);if(state.view.y==state.TDY&&state.view.m==state.TDM){if(state.pOpen&&state.sel===TODAY){closeP();setTimeout(go2,350)}else go2()}else{state.grid.jump({y:state.TDY,m:state.TDM});setTimeout(go2,500)}};/* [data-layer] derived from TODAY */
// ---------- rulers: the same hairline scale language, now an input (flow 1-10, pain 1-10, mood 1-10)
function Ruler(cv,cfg){const r={cv,c:cv.getContext('2d'),v:cfg.v0,nv:cfg.v0,vel:0,hold:false,w:0,h:108,cfg,pad:cfg.pad||16,unset:false,ro:false};
r.X=u=>r.pad+(u-cfg.min)/(cfg.max-cfg.min)*(r.w-2*r.pad);
r.cue=()=>{if(!r.cued){r.cued=1;r.cueT=-1}};
const set=e=>{if(r.ro)return;const b=cv.getBoundingClientRect(),u=cfg.min+((e.clientX-b.left-r.pad)/(r.w-2*r.pad))*(cfg.max-cfg.min),v=state.clamp(Math.round(u),cfg.lo,cfg.max);if(v!==r.v||r.unset){r.v=v;cfg.on(v);state.buzz(3)}};
// [P2-2] keyboard equivalent of the drag: ±1 per arrow, Home/End at the ends; a read-only day
// ignores it. stopPropagation keeps the month grid from also turning on ArrowLeft/Right.
cv.addEventListener('keydown',e=>{if(r.ro)return;const dir={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[e.key];let v;if(dir!=null)v=r.v+dir;else if(e.key=='Home')v=cfg.min;else if(e.key=='End')v=cfg.max;else return;e.preventDefault();e.stopPropagation();v=state.clamp(v,cfg.lo,cfg.max);if(v!==r.v||r.unset){r.v=v;r.unset=false;cfg.on(v);state.buzz(3)}});
let st=null;cv.addEventListener('pointerdown',e=>{if(r.ro)return;st={x:e.clientX,y:e.clientY,id:e.pointerId,act:false};});
cv.addEventListener('pointermove',e=>{if(!st)return;if(!st.act){const dx=Math.abs(e.clientX-st.x),dy=Math.abs(e.clientY-st.y);if(dx>6&&dx>dy){st.act=true;r.hold=true;try{cv.setPointerCapture(st.id)}catch(_){}set(e)}else return}else set(e)});
cv.addEventListener('pointerup',e=>{if(st&&!st.act)set(e);st=null;r.hold=false});cv.addEventListener('pointercancel',()=>{st=null;r.hold=false});
r.size=()=>{r.w=cv.clientWidth;cv.width=Math.round(r.w*state.dpr);cv.height=Math.round(r.h*state.dpr)};
r.draw=(t,dt)=>{if(!r.w)return;if(r.cueT===-1)r.cueT=t+1.1;else if(r.cueT>0&&t>=r.cueT){r.cueT=0;if(!state.reduce)r.nv+=r.v>5.5?-.7:.7}
const c=r.c,y0=62,sy=22,up=cfg.up,rng=cfg.max-cfg.min,fr=state.clamp((r.nv-cfg.min)/rng),un=r.unset;r.vel+=((r.v-r.nv)*420-r.vel*27)*dt;r.nv+=r.vel*dt;if(state.reduce){r.nv=r.v;r.vel=0}const nv=r.nv;c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,r.w,r.h);c.lineCap='round';
c.strokeStyle=state.ik(.3);c.lineWidth=.8;c.beginPath();c.moveTo(r.X(cfg.min),y0);c.lineTo(r.X(cfg.max),y0);c.stroke();if(!un){c.strokeStyle=state.ik(1);c.lineWidth=1.4;c.beginPath();c.moveTo(r.X(cfg.min),y0);c.lineTo(r.X(nv),y0);c.stroke()}
const n=Math.round(rng/cfg.step);for(let i=0;i<=n;i++){const u=cfg.min+i*cfg.step,x=r.X(u),maj=Math.abs(u-Math.round(u))<1e-6,mid=!maj&&Math.abs(u*2-Math.round(u*2))<1e-6,g=state.gauss(u-nv,cfg.sig),ramp=up?.5+.9*(u-cfg.min)/rng:1,h=(maj?18:mid?11:6)*ramp+11*g*(un?.3:1);c.strokeStyle=state.ik(((u<=nv+1e-6&&!un?.95:.3)+.3*g)*(up&&!un?.55+.45*(u-cfg.min)/rng:1));c.lineWidth=maj?1.5:.8;c.beginPath();c.moveTo(x,y0);c.lineTo(x,y0-h);c.stroke()}
c.textBaseline='middle';for(let u=Math.ceil(cfg.min);u<=cfg.max;u++){const lab=cfg.lab(u),on=u===r.v&&!un,x=r.X(u);
if(lab!=null){c.fillStyle=state.ik(on?1:.5);c.font=`${on?800:700} 10.5px Inter,'Noto Sans SC',system-ui,sans-serif`;c.textAlign=u==cfg.min?'left':u==cfg.max?'right':'center';c.fillText(lab,x+(u==cfg.min?-6:u==cfg.max?6:0),y0+19)}
if(cfg.num){c.fillStyle=state.ik(on?.95:.24+.4*state.gauss(u-nv,1.2));c.font=`${on?800:600} 9.5px Inter,'Noto Sans SC',system-ui,sans-serif`;c.textAlign='center';c.fillText(String(u),x,y0+35)}}
const nx=r.X(nv),gr=c.createLinearGradient(0,sy-10,0,y0+8);gr.addColorStop(0,state.ik(.2*(un?.4:1)));gr.addColorStop(.4,state.ik(.9*(un?.4:1)));gr.addColorStop(1,state.ik(.2));c.strokeStyle=gr;c.lineWidth=1;c.beginPath();c.moveTo(nx,sy);c.lineTo(nx,y0+8);c.stroke();
const gR=20+(up?16*fr:0),gg=c.createRadialGradient(nx,sy,0,nx,sy,gR);gg.addColorStop(0,state.ik((.6+(up?.3*fr:0))*(un?.4:1)));gg.addColorStop(1,state.ik(0));c.fillStyle=gg;c.fillRect(nx-gR,sy-gR,gR*2,gR*2);
const sr=6.5+(r.hold?2.5:0)+(up?3.5*fr:0);if(un){c.strokeStyle=state.ik(.8);c.lineWidth=1;state.sp(c,nx,sy,sr,0)}else{c.fillStyle=state.ik(1);state.sp(c,nx,sy,sr,1)}};return r}
const FT={1:'cal.tier1',3:'cal.tier2',6:'cal.tier3',9:'cal.tier4'},PT={1:'cal.painW1',5:'cal.painW5',8:'cal.painW8',10:'cal.painW10'},MT={1:'cal.moodW2',10:'cal.moodW10'};
const RF=Ruler(state.$('#rf'),{min:1,max:10,lo:1,step:.5,sig:.9,v0:4,num:1,lab:u=>FT[u]?core.i18n.t(FT[u]):null,on:v=>{D.flow_level=v;readouts();save()}});
const RP=Ruler(state.$('#rp'),{min:1,max:10,lo:1,step:.5,sig:.9,v0:5,num:1,lab:u=>PT[u]?core.i18n.t(PT[u]):null,on:v=>{D.pain_level=v;D.pain_present=true;readouts();save()}});
const RM=Ruler(state.$('#rm'),{min:1,max:10,lo:1,step:.5,sig:.9,v0:5,num:1,up:1,pad:26,lab:u=>MT[u]?core.i18n.t(MT[u]):null,on:v=>{D.mood_level=v;RM.unset=false;readouts();save()}});
function splitEb(){state.$$('#rg .rd>.eb').forEach(e=>{const s=e.textContent,i=s.indexOf(' · ');if(i>0){const a=document.createElement('span'),b=document.createElement('span');a.className='x-hd';a.textContent=s.slice(0,i);b.className='x-sfx';b.textContent=s.slice(i);e.textContent='';e.append(a,b)}})}
splitEb();
function retxt(){splitEb();if(state.pOpen&&state.sel!=null)fill(0)}
return {fill,selectDay,closeP,drawNote,nsize,RF,RP,RM,retxt};
};
