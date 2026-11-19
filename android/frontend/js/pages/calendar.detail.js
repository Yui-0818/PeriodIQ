/* ------------------------------------------------------------------
   1 角色：Calendar 页日详情：fill/bnd/det/save/doEdit、Ruler 三件套、note 与 gate 原因。第 2 轮改动：#gcode 改人话短语（机器码仅留注释）；边界键改 aria-disabled（虚线+斜纹，不靠透明度）；三项统计改带引线的纵向读数；标尺移除方向箭头（保留首次回弹）；#dtl 四态类；reduced-motion 降级
   2 依赖：core、PG、state（state.sel/state.pOpen/state.gateR/state.grid 等）。
   3 暴露：CalendarDetail(core,PG,state) → {fill,selectDay,closeP,drawNote,nsize,RF,RP,RM}。新增类仅 x- 前缀：x-st-future x-st-old x-st-notperiod x-st-edit（#dtl 四态）、x-of（预测日分母）、x-hd x-sfx（标尺标签主/副）。
   4 不变量：四件套写入路径、日记通道、只读 gate 文案与 Ruler 参数逐字保留；gateR 经 state 供主文件绘制。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/calendar.js 第 108–188、207–241 行。
   6 禁止改动项：不改选择器/文案/aria/时长/缓动/分支顺序；不加依赖；不挂 window；不得重写编辑/保存路径；唯一文案例外：#gcode。
   迁自：demo@1cd5082 js/pages/calendar.js 第 108–188、207–241 行
   ------------------------------------------------------------------ */
const CalendarDetail = (core, PG, state) => {
const {toN,dOf,fmt,TODAY,MN,FL,PW,typeOf,softOf,info,endOf,cycAt,tierOf}=core.m,api=core.api;
// ---------- detail panel
const dpw=state.$('#dpw');
function selectDay(n){if(state.sel===n&&state.pOpen){closeP();return}state.sel=n;state.pOpen=true;const c=state.L3[1].byN[n];if(c)dpw.style.setProperty('--ox',(c.x+0)+'px');dpw.classList.add('open');fill(1);if(c){state.wave(...ptOf(c));state.buzz(8)}
setTimeout(()=>{const r=dpw.getBoundingClientRect();if(r.bottom>innerHeight-110)state.scrollBy({top:Math.min(r.bottom-innerHeight+130,r.top-90),behavior:'smooth'})},700)}
const ptOf=c=>{const r=state.cal.getBoundingClientRect();return[r.left+18+c.x,r.top+c.y]};
function closeP(){state.pOpen=false;dpw.classList.remove('open')}
state.$('#dx').onclick=closeP;
// ---------- drawer: header + stats from the API segments · boundary editing · validation gate · daily fields
const md={month:'short',day:'numeric'},MW=['','Low','Low','Dim','Dim','Even','Even','Bright','Bright','Radiant','Radiant'],
GATE={future:['Light still in transit','This day hasn’t arrived yet. Its details open once the day itself does.'],old:['Written into the sky','Only today and yesterday can be rewritten. This day is settled history.'],notperiod:['A quiet sky','No period covers this day. Mark a start above to wake it.']},
// #gcode phrases. The service's status/code (old: 400 DAILY_WINDOW, future: 422 VALIDATION_ERROR) are never rendered; the phrase follows the gate reason.
GC={edit:'Editable now',future:'Not here yet',old:'Settled history',notperiod:'No period here'},
KMSG={create:'A new period begins here.','pull-start':'Start moved earlier.',extend:'Period extended.','trim-head':'Start moved.','trim-tail':'End moved.',close:'Period closed here.',split:'Period split in two.',delete:'Period removed.'},
BLANK=()=>({pain_present:false,pain_level:null,flow_level:4,mood_level:null,mood_tags:[]}),
fade=(el,m)=>{el.textContent=m;if(state.reduce)return;el.animate([{opacity:0,filter:'blur(6px)'},{opacity:.75,filter:'blur(0)'}],{duration:520,easing:'cubic-bezier(.2,.9,.1,1)'})},say=m=>fade(state.$('#sv'),m),bsay=m=>fade(state.$('#bxm'),m);
let D=BLANK(),saveT=0,wasOk=null,noteN=0,wasFull=false,nsp=[];const dtl=state.$('#dtl');
const subOf=(n,c)=>{const g=api.getDaily(n);return g?`Flow ${g.flow_level}/10 · ${g.pain_present?`pain ${g.pain_level}/10`:'no pain'} · mood ${g.mood_level}/10`:(c&&c.e==null&&n==TODAY?'Ongoing · logged on this device':'Logged on this device')};
function fill(dir){const n=state.sel,ty=typeOf(n),sf=softOf(n),f=info(n),future=n>TODAY,c=cycAt(n),S=core.m.seg;state.$('#dd').textContent=fmt(n,{weekday:'short',month:'short',day:'numeric',year:'numeric'})+(n==TODAY?' · Today':'');
let hl,sub,s3;
if(ty=='period'){hl=`Period, day ${n-c.s+1}`;sub=subOf(n,c);s3=`<b>${n-c.s+1}</b><span>Period day · logged</span>`}
else if(ty=='pred'){const w=S.pred.find(q=>n>=q.s&&n<=q.e);hl=`Predicted period, day ${n-w.s+1}`;sub='An estimate · it may drift';s3=`<b>${n-w.s+1}<small class="x-of"> / ${w.e-w.s+1}</small></b><span>Predicted period day</span>`}
else if(ty=='ov'){hl='Ovulation day';sub=n==TODAY?'Peak fertility today':n<TODAY?'Peak fertility, estimated':'Peak fertility expected';s3='<b class="w">Peak</b><span>Ovulation day</span>'}
else if(ty=='fert'){const w=S.fert,o=S.ov;hl=`Fertile window, day ${n-w.s+1} of ${w.e-w.s+1}`;sub=n==w.e?(n==TODAY?'Closes today':'Last fertile day'):o!=null&&o>n?`Ovulation in ${o-n} day${o-n>1?'s':''}`:`Closes in ${w.e-n} day${w.e-n>1?'s':''}`;s3='<b class="w">Fertile</b><span>Window open</span>'}
else if(sf){hl='Less certain days';sub='The estimate gets softer around here';s3='<b class="w">Hazy</b><span>Less certain</span>'}
else{hl='A quiet sky';sub=f.until!=null?`${f.until} day${f.until>1?'s':''} until your next period`:'';s3='<b class="w">Quiet</b><span>Nothing mapped</span>'}
s3=`<i class="mk ${ty=='period'?'p':ty=='pred'?'d':ty=='ov'?'o':ty=='fert'?'f':sf?'l':'q'}"></i>`+s3;state.roll(state.$('#dt'),hl,dir);state.roll(state.$('#ds'),sub||'&nbsp;',dir);
state.roll(state.$('#s1'),f.cd!=null?`<b>${f.cd}</b><span>Cycle day</span>`:`<b>—</b><span>Cycle day</span>`,dir);
state.roll(state.$('#s2'),f.until!=null?`<b>${f.until}</b><span>Days until next period</span>`:`<b>—</b><span>Next period</span>`,dir);state.roll(state.$('#s3'),s3,dir);
state.$('#bxw').classList.toggle('on',!future);bnd();det()}
// boundary: Mark start / Mark end / Clear day edit the cycle INTERVAL (cross-cycle fuse, split and delete are handled in core.edit)
function bnd(){const n=state.sel,c=cycAt(n),pv=[...core.m.CYC].reverse().find(q=>endOf(q)<n);
state.$('#lqt').textContent=c?(n==TODAY&&c.e==null?'Is your period still going?':'This day sits inside a period'):(n==TODAY?'Did your period start today?':'Was this a period day?');
state.$('#bs').setAttribute('aria-pressed',!!c&&n==c.s);state.$('#be').setAttribute('aria-pressed',!!c&&c.e!=null&&c.e==n);
state.$('#be').setAttribute('aria-disabled',!c&&!pv);state.$('#bc').setAttribute('aria-disabled',!c);state.$('#brm').classList.toggle('on',!!c);
state.$('#bxs').textContent=c?`Period ${fmt(c.s,md)} – ${c.e==null?'ongoing':fmt(c.e,md)} · ${endOf(c)-c.s+1} day${endOf(c)>c.s?'s':''}`:'No period recorded on this day'}
// daily details: gate (read-only reason from the validation chain) or fields
function det(){const n=state.sel,g=api.gate(n),ok=g.ok;
if(!ok){state.gateR=g.reason;state.$('#gh').textContent=GATE[g.reason][0];state.$('#gs').textContent=GATE[g.reason][1]}
state.$('#gcode').textContent=ok?GC.edit:GC[g.reason];{const sk=ok?'edit':g.reason;['future','old','notperiod','edit'].forEach(k=>dtl.classList.toggle('x-st-'+k,k===sk))}
if(ok){D=api.getDaily(n)||BLANK();RF.v=D.flow_level;RP.v=D.pain_level||RP.v||5;RM.v=D.mood_level||RM.v||5;RM.unset=D.mood_level==null;state.$('#pt').setAttribute('aria-pressed',D.pain_present);state.$('#pgx').classList.toggle('on',D.pain_present);RF.cue();RM.cue();if(D.pain_present)RP.cue();
// [data-layer] the note lives in the journal channel (journal.get), not in the daily row. After an
// autosave commit('api') re-runs fill(); skip the value write while the textarea is focused so the
// caret never jumps to the end, but still recount from what the user currently sees.
if(document.activeElement!==nt)nt.value=api.journal.get(n).note;
noteN=api.journal.countNote(nt.value);wasFull=noteN>=NM;ntw.classList.toggle('near',noteN>=NM*.9);readouts();
// [data-layer] status line: a read-only journal day (past) gets the one mapped text when the panel
// opens; the four-piece mood prompt is period-day only; other writable days keep the saved text.
state.$('#sv').textContent=!api.journal.writable(n)?core.errors.text('JOURNAL_READONLY'):(api.isPeriodDay(n)&&D.mood_level==null?'Pick a mood to save this day.':'Saved on this device · the note never leaves it.')}
const grow=ok&&wasOk===false;state.$('#gate').classList.toggle('on',!ok);state.$('#rg').classList.toggle('on',ok);if(grow)slab();wasOk=ok;state.gsize()}
// read-only -> editable is a physical expansion: the slab swells, light rings out of it
function slab(){const dp=state.$('#dp');dp.classList.remove('grow');void dp.offsetWidth;dp.classList.add('grow');const r=state.$('#rg').getBoundingClientRect(),x=r.left+r.width/2,y=r.top+34;state.wave(x,y);core.fx({type:'ring',x,y,dur:1100})}
function readouts(){const f=D.flow_level,mv=D.mood_level;state.$('#fv').textContent=FL[tierOf(f)];state.$('#fc').textContent=`${f} of 10`;state.$('#pn').textContent=D.pain_present?D.pain_level:'–';state.$('#pc').textContent=D.pain_present?`/ 10 · ${PW[D.pain_level]}`:'No pain';state.$('#mv').textContent=mv==null?'—':mv;state.$('#mc').textContent=mv==null?'Not set yet':`/ 10 · ${MW[mv]}`}
async function save(){if(state.sel==null)return;
// [data-layer] Snapshot the day and the visible note BEFORE the first await: det() may reset #nt from
// the store after a failed daily write, and sel may change while a request is in flight.
const n=state.sel,note=nt.value,period=api.isPeriodDay(n);let fail='',skip=false,saved=false,dailyFailed=false;
// [data-layer] Channel 1: the daily four-piece is period-day only. A missing mood skips ONLY this
// channel (never returns) and never blocks the journal below.
if(period){if(D.mood_level==null){skip=true;say('Pick a mood to save this day.')}
else{const r=await api.putDaily(n,D);if(r.ok){saved=true;state.roll(state.$('#ds'),subOf(n,cycAt(n)),0)}else{fail=r.message;dailyFailed=true}}}
// [data-layer] Channel 2: the journal is a SEPARATE channel. It is written only for a writable day
// (today) and only when the text differs; a daily failure never rolls it back, and it never commits
// here. A read-only day writes nothing — its mapped text was shown once when the panel opened.
let journalFailed=false;
if(api.journal.writable(n)&&note!==api.journal.get(n).note){const jr=await api.journal.put(n,note);if(jr.ok)saved=true;else{journalFailed=true;fail=fail||jr.message}}
// [data-layer] det() reads the global sel; only refresh the panel when this save still owns that day.
if(n===state.sel&&dailyFailed&&!journalFailed)det();
// Status priority: failure > skipped-mood prompt (already said, success suppressed) > success.
if(fail)say(fail);else if(saved&&!skip)say('Saved on this device · the note never leaves it.')}
// [data-layer] core.edit is async in real mode and sync in mock mode; keep await for both.
async function doEdit(op){const n=state.sel,res=await core.edit(op,n);if(!res.ok){bsay(res.msg);return}
state.cutDay=res.kind=='split'?n:null;state.L3.forEach(L=>state.grid.refresh(L));state.cutDay=null;echo(res);state.legend();state.unm();fill(1);bsay(res.merged.length?'Periods joined.':KMSG[res.kind])}
// one boundary edit answers everywhere: constellation cells pop / extinguish with ripples, the sky warps, and Today re-forms its orbit when you return
const kick=v=>{if(!state.reduce)state.warpV+=v};
function echo(res){const c=state.L3[1].byN[res.n],pt=c?ptOf(c):[innerWidth/2,innerHeight*.4],x=pt[0],y=pt[1],k=res.kind,mg=res.merged.length;state.wave(x,y);
if(k=='delete'){core.fx({type:'ring',x,y,dur:1000});core.fx({type:'orb',from:{x,y},to:{x:state.SW*(.2+.6*state.rnd(state.now,1)),y:state.SH*.12},dur:1000});kick(700)}
else if(k=='split'){core.fx({type:'warp',x,y,dur:900});core.fx({type:'ring',x,y,dur:1100});kick(-500)}
else if(mg){core.fx({type:'warp',x,y,dur:1100});core.fx({type:'ring',x,y,dur:1300});core.fx({type:'bloom',x,y,dur:900});kick(-1300)}
else if(/create|pull|extend/.test(k)){core.fx({type:'bloom',x,y,dur:900});core.fx({type:'ring',x,y,dur:1100});kick(-800)}
else{core.fx({type:'ring',x,y,dur:1000});kick(500)}
state.buzz(k=='delete'?[8,20,8]:[10,30,10])}
state.$('#bs').onclick=()=>doEdit('start');state.$('#be').onclick=()=>doEdit('end');state.$('#bc').onclick=()=>doEdit('clear');state.$('#brm').onclick=()=>doEdit('remove');
state.$('#pt').onclick=e=>{D.pain_present=!D.pain_present;D.pain_level=D.pain_present?(RP.v||5):null;state.$('#pt').setAttribute('aria-pressed',D.pain_present);state.$('#pgx').classList.toggle('on',D.pain_present);if(D.pain_present)RP.cue();readouts();const r=e.currentTarget.getBoundingClientRect();state.wave(r.left+r.width/2,r.top+r.height/2);state.buzz(6);save()};
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
c.fillStyle=state.ik(.85);c.font='700 12px Inter,system-ui,sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(String(NM-noteN),cx,cy+.5)}
state.$('#ql').onclick=()=>{const go2=()=>selectDay(TODAY);if(state.view.y==state.TDY&&state.view.m==state.TDM){if(state.pOpen&&state.sel===TODAY){closeP();setTimeout(go2,350)}else go2()}else{state.grid.jump({y:state.TDY,m:state.TDM});setTimeout(go2,500)}};/* [data-layer] derived from TODAY */
// ---------- rulers: the same hairline scale language, now an input (flow 1-10, pain 1-10, mood 1-10)
function Ruler(cv,cfg){const r={cv,c:cv.getContext('2d'),v:cfg.v0,nv:cfg.v0,vel:0,hold:false,w:0,h:108,cfg,pad:cfg.pad||16,unset:false};
r.X=u=>r.pad+(u-cfg.min)/(cfg.max-cfg.min)*(r.w-2*r.pad);
r.cue=()=>{if(!r.cued){r.cued=1;r.cueT=-1}};
const set=e=>{const b=cv.getBoundingClientRect(),u=cfg.min+((e.clientX-b.left-r.pad)/(r.w-2*r.pad))*(cfg.max-cfg.min),v=state.clamp(Math.round(u),cfg.lo,cfg.max);if(v!==r.v||r.unset){r.v=v;cfg.on(v);state.buzz(3)}};
let st=null;cv.addEventListener('pointerdown',e=>{st={x:e.clientX,y:e.clientY,id:e.pointerId,act:false};});
cv.addEventListener('pointermove',e=>{if(!st)return;if(!st.act){const dx=Math.abs(e.clientX-st.x),dy=Math.abs(e.clientY-st.y);if(dx>6&&dx>dy){st.act=true;r.hold=true;try{cv.setPointerCapture(st.id)}catch(_){}set(e)}else return}else set(e)});
cv.addEventListener('pointerup',e=>{if(st&&!st.act)set(e);st=null;r.hold=false});cv.addEventListener('pointercancel',()=>{st=null;r.hold=false});
r.size=()=>{r.w=cv.clientWidth;cv.width=Math.round(r.w*state.dpr);cv.height=Math.round(r.h*state.dpr)};
r.draw=(t,dt)=>{if(!r.w)return;if(r.cueT===-1)r.cueT=t+1.1;else if(r.cueT>0&&t>=r.cueT){r.cueT=0;if(!state.reduce)r.nv+=r.v>5.5?-.7:.7}
const c=r.c,y0=62,sy=22,up=cfg.up,rng=cfg.max-cfg.min,fr=state.clamp((r.nv-cfg.min)/rng),un=r.unset;r.vel+=((r.v-r.nv)*420-r.vel*27)*dt;r.nv+=r.vel*dt;if(state.reduce){r.nv=r.v;r.vel=0}const nv=r.nv;c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,r.w,r.h);c.lineCap='round';
c.strokeStyle=state.ik(.3);c.lineWidth=.8;c.beginPath();c.moveTo(r.X(cfg.min),y0);c.lineTo(r.X(cfg.max),y0);c.stroke();if(!un){c.strokeStyle=state.ik(1);c.lineWidth=1.4;c.beginPath();c.moveTo(r.X(cfg.min),y0);c.lineTo(r.X(nv),y0);c.stroke()}
const n=Math.round(rng/cfg.step);for(let i=0;i<=n;i++){const u=cfg.min+i*cfg.step,x=r.X(u),maj=Math.abs(u-Math.round(u))<1e-6,mid=!maj&&Math.abs(u*2-Math.round(u*2))<1e-6,g=state.gauss(u-nv,cfg.sig),ramp=up?.5+.9*(u-cfg.min)/rng:1,h=(maj?18:mid?11:6)*ramp+11*g*(un?.3:1);c.strokeStyle=state.ik(((u<=nv+1e-6&&!un?.95:.3)+.3*g)*(up&&!un?.55+.45*(u-cfg.min)/rng:1));c.lineWidth=maj?1.5:.8;c.beginPath();c.moveTo(x,y0);c.lineTo(x,y0-h);c.stroke()}
c.textBaseline='middle';for(let u=Math.ceil(cfg.min);u<=cfg.max;u++){const lab=cfg.lab(u),on=u===r.v&&!un,x=r.X(u);
if(lab!=null){c.fillStyle=state.ik(on?1:.5);c.font=`${on?800:700} 10.5px Inter,system-ui,sans-serif`;c.textAlign=u==cfg.min?'left':u==cfg.max?'right':'center';c.fillText(lab,x+(u==cfg.min?-6:u==cfg.max?6:0),y0+19)}
if(cfg.num){c.fillStyle=state.ik(on?.95:.24+.4*state.gauss(u-nv,1.2));c.font=`${on?800:600} 9.5px Inter,system-ui,sans-serif`;c.textAlign='center';c.fillText(String(u),x,y0+35)}}
const nx=r.X(nv),gr=c.createLinearGradient(0,sy-10,0,y0+8);gr.addColorStop(0,state.ik(.2*(un?.4:1)));gr.addColorStop(.4,state.ik(.9*(un?.4:1)));gr.addColorStop(1,state.ik(.2));c.strokeStyle=gr;c.lineWidth=1;c.beginPath();c.moveTo(nx,sy);c.lineTo(nx,y0+8);c.stroke();
const gR=20+(up?16*fr:0),gg=c.createRadialGradient(nx,sy,0,nx,sy,gR);gg.addColorStop(0,state.ik((.6+(up?.3*fr:0))*(un?.4:1)));gg.addColorStop(1,state.ik(0));c.fillStyle=gg;c.fillRect(nx-gR,sy-gR,gR*2,gR*2);
const sr=6.5+(r.hold?2.5:0)+(up?3.5*fr:0);if(un){c.strokeStyle=state.ik(.8);c.lineWidth=1;state.sp(c,nx,sy,sr,0)}else{c.fillStyle=state.ik(1);state.sp(c,nx,sy,sr,1)}};return r}
const FT={1:'Spotting',3:'Light',6:'Medium',9:'Heavy'},PT={1:'Mild',5:'Moderate',8:'Strong',10:'Severe'},MT={1:'Low',10:'Radiant'};
const RF=Ruler(state.$('#rf'),{min:1,max:10,lo:1,step:.5,sig:.9,v0:4,num:1,lab:u=>FT[u]||null,on:v=>{D.flow_level=v;readouts();save()}});
const RP=Ruler(state.$('#rp'),{min:1,max:10,lo:1,step:.5,sig:.9,v0:5,num:1,lab:u=>PT[u]||null,on:v=>{D.pain_level=v;D.pain_present=true;readouts();save()}});
const RM=Ruler(state.$('#rm'),{min:1,max:10,lo:1,step:.5,sig:.9,v0:5,num:1,up:1,pad:26,lab:u=>MT[u]||null,on:v=>{D.mood_level=v;RM.unset=false;readouts();save()}});
// ruler labels: the lead word stays primary, the scale note after the first " · " recedes (same text, typographic hierarchy only)
state.$$('#rg .rd>.eb').forEach(e=>{const t=e.textContent,i=t.indexOf(' · ');if(i>0){const a=document.createElement('span'),b=document.createElement('span');a.className='x-hd';a.textContent=t.slice(0,i);b.className='x-sfx';b.textContent=t.slice(i);e.textContent='';e.append(a,b)}});
return {fill,selectDay,closeP,drawNote,nsize,RF,RP,RM};
};
