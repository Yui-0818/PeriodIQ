/* ------------------------------------------------------------------
   1 角色：You 页装配/资料/头像/隐私/主循环（旧 you.js 主体）
   2 依赖：core、PG 与 you.settings/transfer/dialog/scene.js。
   3 暴露：boot_you(core,PG) → {size,cacheInk,setSY,wave,refresh}。
   4 不变量：DOM/文案/事件顺序不变；共享状态经 state 读写。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/you.js。
   6 禁止改动项：不改选择器/class/文案/aria/时长/缓动/分支顺序；不加依赖；不挂 window。
   迁自：demo@1cd5082 js/pages/you.js 第 1–359 行
   ------------------------------------------------------------------ */
function boot_you(core,PG){const PGID='you';
const $=s=>PG.querySelector(s)||core.dummy(),$$=s=>[...PG.querySelectorAll(s)],root=document.documentElement;
const requestAnimationFrame=f=>core.raf(PGID,f);
const addEventListener=(t,f,o)=>{window.addEventListener(t,e=>{if(core.isCur(PGID))f(e)},o)};
// 迭代1（3.0.1）：文案走 core.i18n；复数走 plural；日期显示走 date()
const t=(k,v)=>core.i18n.t(k,v),plw=(n,b)=>core.i18n.t(core.i18n.plural(n,b),{n}),dfmt=(n,o)=>core.i18n.date(n,o);

const 
reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,mq=matchMedia('(prefers-color-scheme:dark)'),clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),lerp=(a,b,t)=>a+(b-a)*t,
rnd=(i,k=1)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)},gauss=(d,s)=>Math.exp(-d*d/(2*s*s)),
sp=(c,x,y,r,f)=>{c.beginPath();c.moveTo(x,y-r);c.quadraticCurveTo(x,y,x+r,y);c.quadraticCurveTo(x,y,x,y+r);c.quadraticCurveTo(x,y,x-r,y);c.quadraticCurveTo(x,y,x,y-r);f?c.fill():c.stroke()};
let dm,skyT=-9;
const cacheInk=()=>{const cs=getComputedStyle(root);state.ink=cs.getPropertyValue('--ink').trim();state.bgc=cs.getPropertyValue('--bg').trim()},ik=a=>`rgba(${state.ink},${clamp(a)})`,ib=a=>`rgba(${state.bgc},${clamp(a)})`,wave=(x,y)=>reduce||state.waves.push({x,y,t:state.now});
// ---------- state
let em=0,ex=0,oi=-1,editOpen=false,nOn=false,avDef=true,wiping=false;
const state={scrollY:0,ink:'0,0,0',bgc:'255,255,255',dpr:1,SW:0,SH:0,now:0,px:.5,py:.4,spx:.5,spy:.4,lastMove:-9,waves:[],wipeT:-9,imp:0,W:394,pm:0,intro:0,hp:0,holding:false,avCX:0,avCY:0,avS:104,avSeed:0,avForm:0,appearance:'dark',dS:null};
const H0=660,EXMAX=150,PTOP=84,PNH=H0-PTOP-92,REST=[[.17,80,100,100,0],[.83,92,104,104,0],[.28,404,176,116,1],[.73,470,168,128,1],[.47,596,100,100,1]];
const prof=core.profile,DB={records:[]};function syncDB(){DB.records=core.hist().map(o=>({d:core.m.fmt(o.s),p:o.per,c:o.len}))}syncDB();
const stage=$('#stage'),nm=$('#nm'),sbt=$('#sbt'),ebtn=$('#ebtn'),ed=$('#ed'),av=$('#av'),avc=$('#avc'),avx=avc.getContext('2d'),nin=$('#nin'),ncnt=$('#ncnt');
const sats=$$('.sat').map((el,i)=>({el,i,face:el.querySelector('.face'),bd:el.querySelector('.bd'),cx:0,cy:0,w:12,h:12,vx:0,vy:0,vw:0,vh:0,e:0,m:0,ph:rnd(i,1)*6.28,ready:false}));
let morphT=0,closeT=0;const morphStart=()=>{stage.classList.add('morphing');clearTimeout(morphT);morphT=setTimeout(()=>stage.classList.remove('morphing'),1100)};
const fadeOut=el=>{const s=sats.find(t=>t.el===el);if(s){s.fx=s.cx-s.w/2;s.fy=s.cy-s.h/2;s.fz=true}el.classList.add('closing');clearTimeout(closeT);closeT=setTimeout(()=>sats.forEach(t=>{t.el.classList.remove('closing');t.fz=false;t.bd.style.transform=''}),380)};
const setState=(i,t)=>{sats[i].el.querySelector('.fs').textContent=t;const c=sats[i].el.querySelector('.fsv');c&&(c.textContent=t)};
const say=(sel,msg)=>{const el=$(sel);el.textContent=msg;el.animate([{opacity:0,filter:'blur(6px)'},{opacity:1,filter:'blur(0)'}],{duration:560,easing:'cubic-bezier(.2,.9,.1,1)'})};
// 迭代1（3.0.1）：令牌守卫 —— 快速连续 flick（如输入草稿后立即取消）时，两次淡出动画的 onfinish
// 竞态会让过期的旧文案后到者覆写；仅最后一次调用允许写 textContent。时长/缓动/分支不变。
const flick=(el,txt)=>{if(el.textContent==txt)return;if(reduce){el.textContent=txt;return}const fk={};el._fk=fk;el.animate([{opacity:1,filter:'blur(0)'},{opacity:0,filter:'blur(10px)'}],{duration:200}).onfinish=()=>{if(el._fk!==fk)return;el.textContent=txt;el.animate([{opacity:0,filter:'blur(10px)'},{opacity:1,filter:'blur(0)'}],{duration:520,easing:'cubic-bezier(.2,.9,.1,1)'})}};
// ---------- gravity: a wave through the stars + a shove for every body
function pulseAt(x,y,k=1){const sr=stage.getBoundingClientRect();sats.forEach(s=>{const dx=s.cx+sr.left-x,dy=s.cy+sr.top-y,d=Math.hypot(dx,dy)+30;s.vx+=dx/d*k*700/(1+d/70);s.vy+=dy/d*k*700/(1+d/70)})}
function layout(s){const i=s.i;if(oi<0){const r=REST[i];return{cx:r[0]*state.W,cy:r[1]+(r[4]?ex+10*em:0),w:r[2],h:r[3]}}if(oi==i)return{cx:state.W/2,cy:PTOP+PNH/2,w:state.W,h:PNH};const o=[0,1,2,3,4].filter(k=>k!=oi),n=o.indexOf(i);return{cx:state.W*(.14+.72*n/3),cy:H0-44,w:52,h:52}}
function openZ(i){if(oi==i)return;const prev=oi>=0?sats[oi].el:null;sats[i].el.classList.remove('closing');sats[i].fz=false;sats[i].bd.style.transform='';if(editOpen)setEdit(false);oi=i;sats.forEach(s=>{const on=s.i==i;s.el.classList.toggle('open',on);s.face.inert=on;s.bd.inert=!on;s.face.setAttribute('aria-expanded',on);if(on)s.bd.querySelector('.sc').scrollTop=0});
if(prev&&prev!==sats[i].el)fadeOut(prev);
const s=sats[i],sr=stage.getBoundingClientRect();s.el.style.setProperty('--px','35%');s.el.style.setProperty('--py','86px');s.el.style.setProperty('--ang','0deg');wave(sr.left+s.cx,sr.top+s.cy);pulseAt(sr.left+s.cx,sr.top+s.cy,1);core.buzz(10);morphStart();if(i==1)state.settings.selDays(state.ST.reminder_days,false)}
function closeZ(){if(oi<0)return;const s=sats[oi],sr=stage.getBoundingClientRect();oi=-1;sats.forEach(t=>{t.el.classList.remove('open');t.face.inert=false;t.bd.inert=true;t.face.setAttribute('aria-expanded',false)});pulseAt(sr.left+state.W/2,sr.top+state.avCY,.8);wave(sr.left+state.avCX,sr.top+state.avCY);fadeOut(s.el);morphStart()}
sats.forEach(s=>{s.face.onclick=()=>openZ(s.i);s.el.querySelector('.x').onclick=closeZ});
stage.addEventListener('click',e=>{if(e.target===stage||e.target.id=='pf')closeZ()});addEventListener('keydown',e=>{if(e.key=='Escape')state.dS?state.dialog.closeDlg():closeZ()});
// ---------- profile + avatar sigil
const hash=s=>{let h=7;for(const c of s)h=(h*31+c.charCodeAt(0))%100003;return h};
function setEdit(on){editOpen=on;flick(ebtn,on?t('ui.cancel'):t('you.edit'));if(on){if(oi>=0)closeZ();setTimeout(()=>nin.focus({preventScroll:true}),520)}else{nin.value=prof.name;count();preview();state.avSeed=prof.name?hash(prof.name):0;avDef=!prof.name}}
ebtn.onclick=()=>setEdit(!editOpen);
const count=()=>{ncnt.textContent=`${nin.value.length} / 24`;ncnt.classList.toggle('hot',nin.value.length>=22)};
function preview(){flick(nm,nin.value.trim()||t('you.noname'))}
function reseed(){if(!avDef)state.avSeed=hash(nin.value);state.avForm=0}
nin.oninput=()=>{count();preview();avDef=!nin.value.trim();reseed()};
$('#rav').onclick=()=>{avDef=true;state.avSeed=0;state.avForm=0;const r=av.getBoundingClientRect();wave(r.left+r.width/2,r.top+r.height/2);core.buzz(8)};
// [data-layer] profile is an async auth write: await the Promise, consume r.message on failure.
// The API already emits 'profile' after updating core.profile.name; the page must not emit twice.
// 迭代1（3.0.1）bug3：空昵称且账号已有昵称时先二次确认（对话框走词典），确认后才写空值。
// 迭代1（3.0.1）保存同步：profile 事件在 await 期间到达（editOpen 仍 true，syncNick 让位不覆盖），
// 关闭编辑后补一次 syncNick()+preview() —— #nm/#nin 与显示名（昵称或用户名回落）保持一致，
// 真实模式清空昵称后不再停留「No nickname」直到下次进页。
async function doSave(){const r=await core.api.auth.profile({nickname:nin.value});if(!r.ok){flick(ncnt,r.message);return}editOpen=false;flick(ebtn,t('you.edit'));syncNick();preview();const b=av.getBoundingClientRect();wave(b.left+b.width/2,b.top+b.height/2);pulseAt(b.left+b.width/2,b.top+b.height/2,1.2);core.buzz(12)}
$('#sav').onclick=async()=>{
if(!nin.value.trim()&&prof.name){state.dialog.showDlg({origin:pos($('#sav')),step:'',title:t('you.confirmEmptyTitle'),text:t('you.confirmEmptyText'),ok:t('you.confirmEmptyOk'),no:t('ui.cancel'),K:{title:'you.confirmEmptyTitle',text:'you.confirmEmptyText',ok:'you.confirmEmptyOk',no:'ui.cancel'},onOk:()=>({ok:true,after:()=>doSave()})});return}
await doSave()};
av.onclick=()=>{const r=av.getBoundingClientRect();wave(r.left+r.width/2,r.top+r.height/2);pulseAt(r.left+r.width/2,r.top+r.height/2,1)};
// 迭代1（3.0.1）：fmtH 按语言切换（en 12 小时 AM/PM；zh-CN/es 24 小时）；pl 走 plural 键
const TAU=Math.PI*2,fmtH=h=>core.i18n.locale()==='en'?`${h%12||12}:00 ${h<12?'AM':'PM'}`:`${String(h%24).padStart(2,'0')}:00`,
pl=(n,w)=>plw(n,w=='cycle'?'ui.cycle':w=='daily record'?'you.wDRec':w=='prediction'?'you.wPred':'ui.record'),esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pos=el=>{const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,el}};
state.root=root;state.stage=stage;state.sats=sats;state.reduce=reduce;state.ik=ik;state.ib=ib;state.sp=sp;state.gauss=gauss;state.clamp=clamp;state.lerp=lerp;state.wave=wave;state.pulseAt=pulseAt;state.say=say;state.setState=setState;state.pos=pos;state.TAU=TAU;state.fmtH=fmtH;state.pl=pl;state.esc=esc;state.syncDB=syncDB;state.stamp=stamp;state.avc=avc;state.avx=avx;state.rnd=rnd;state.mq=mq;state.$=$;state.$$=$$;state.requestAnimationFrame=requestAnimationFrame;
// About: the runtime version comes from /health (A._version); no literal version anywhere in the page.
const aver=$('#aver'),avlab=$('#avlab');
function paintVersion(){const v=typeof core.api._version==='string'&&core.api._version?core.api._version:'';aver.textContent=v||'—';avlab.textContent=v?t('you.version'):t('you.versionNA')}
core.on('model',()=>{if(core.isCur(PGID))paintVersion()});
const settings=YouSettings(core,PG,state);state.settings=settings;
const transfer=YouTransfer(core,PG,state);state.transfer=transfer;
const dialog=YouDialog(core,PG,state);state.dialog=dialog;
// ---------- privacy: keep me signed in (POST /auth/persistence), change password, log out, delete account (hold, then password)
const al=$('#al');function setPersist(on){al.setAttribute('aria-checked',on);const p=pos(al.querySelector('.tk2'));wave(p.x,p.y)}
// [data-layer] 422 still means "enter a password"; a wrong password uses its mapped text; every
// other status (notably 503 PERSISTENCE_UNAVAILABLE) must surface the mapped r.message, never
// claim the password was wrong.
// 迭代1（3.0.1）：对话框文案全部走词典（K 存键，语言切换时可由 repaintDlg 实时重写）
const needPw=r=>{if(r.status==422)return t('you.needPw');if(r.code=='WRONG_PASSWORD')return t('you.wrongPw2');return r.message||core.errors.text('HTTP_ERROR')};
// [data-layer] clear/persistence are Promise-returning auth writes; the switch flips only on success.
al.onclick=async()=>{if(al.getAttribute('aria-checked')=='true'){const r=await core.api.auth.clearPersistence();if(!r.ok){say('#prs',r.message);return}setPersist(false);core.buzz(6);say('#prs',t('you.prsCleared'));return}
state.dialog.showDlg({origin:pos(al),step:t('you.dKeepStep'),title:t('you.dPwTitle'),text:t('you.dPwText'),secret:true,ok:t('you.dPwOk'),no:t('ui.cancel'),K:{step:'you.dKeepStep',title:'you.dPwTitle',text:'you.dPwText',ok:'you.dPwOk',no:'ui.cancel'},onOk:pw=>core.api.auth.persistence(pw).then(r=>r.ok?{ok:true,after:()=>{setPersist(true);say('#prs',t('you.prsOn'))}}:{ok:false,message:needPw(r)})})};
// [data-layer] the second step awaits changePassword; success clears the session in the API, so the
// page only keeps the existing switch/message side effects.
function changePw(el,msg){
const og=pos(el);let cur='';
state.dialog.showDlg({origin:og,step:t('you.cpStep1'),title:t('you.cpCur'),text:msg||t('you.cpCurText'),secret:true,ok:t('you.cpNext'),no:t('ui.cancel'),K:{step:'you.cpStep1',title:'you.cpCur',text:msg?null:'you.cpCurText',ok:'you.cpNext',no:'ui.cancel'},onOk:pw=>{
if(!pw)return{ok:false,message:t('you.needPw')};
cur=pw;
return{ok:true,next:()=>({step:t('you.cpStep2'),title:t('you.cpNew'),text:t('you.cpNewText'),secret:true,ok:t('you.cpOk'),no:t('ui.cancel'),K:{step:'you.cpStep2',title:'you.cpNew',text:'you.cpNewText',ok:'you.cpOk',no:'ui.cancel'},onOk:np=>core.api.auth.changePassword(cur,np).then(r=>{
if(r.ok)return{ok:true,after:()=>{setPersist(false);say('#prs',t('you.cpDone'))}};
if(r.code=='WRONG_PASSWORD')return{ok:false,message:t('you.cpWrong'),then:()=>changePw(el,t('you.cpRetry'))};
return{ok:false,message:r.status==422?t('you.cpNeedNew'):(r.message||core.errors.text('HTTP_ERROR'))}
})})};
}});
}
$('#pwb').onclick=e=>changePw(e.currentTarget);
// [data-layer] logout resolves only after the server deletes the session; failure keeps local data
// but still re-syncs the switch from auth.state() (a 401 was already cleared by the global guard),
// success keeps the original copy/wave/pulse.
$('#lo').onclick=async()=>{const was=al.getAttribute('aria-checked')=='true';const r=await core.api.auth.logout();if(!r.ok){say('#prs',r.message);al.setAttribute('aria-checked',!!core.api.auth.state().persistent);return}if(was)setPersist(false);say('#prs',t('you.loDone')+(was?t('you.loOff'):''));const p=pos($('#lo'));wave(p.x,p.y);pulseAt(p.x,p.y,.9)};
// [data-layer] delete-account is a Promise; success hands wipe the owning dialog so the Erased UI
// is painted only while that same dialog is still on screen.
$('#del').onclick=e=>state.dialog.showDlg({origin:pos(e.currentTarget),step:t('you.delStep1'),title:t('you.delTitle'),text:t('you.delText',{c:DB.records.length==1?t('you.delC1'):t('you.delCN',{n:DB.records.length})}),hold:true,no:t('you.delNo'),K:{step:'you.delStep1',title:'you.delTitle',text:'you.delText',tvars:{c:DB.records.length==1?t('you.delC1'):t('you.delCN',{n:DB.records.length})},no:'you.delNo'},onHold:()=>state.dialog.showDlg({step:t('you.delStep2'),title:t('you.delPwTitle'),text:t('you.delPwText'),secret:true,ok:t('you.delOk'),no:t('you.delNo'),K:{step:'you.delStep2',title:'you.delPwTitle',text:'you.delPwText',ok:'you.delOk',no:'you.delNo'},onOk:pw=>core.api.auth.deleteAccount(pw).then(r=>r.ok?{ok:true,keepOpen:true,after:wipe}:{ok:false,message:needPw(r)})},true)});
state.hb.addEventListener('pointerdown',e=>{state.holding=true;try{state.hb.setPointerCapture(e.pointerId)}catch(_){}core.buzz(6)});['pointerup','pointercancel'].forEach(k=>state.hb.addEventListener(k,()=>state.holding=false));
state.hb.addEventListener('keydown',e=>{if(e.key=='Enter'||e.key==' '){state.holding=true;e.preventDefault()}});state.hb.addEventListener('keyup',()=>state.holding=false);
function stamp(){sbt.textContent=core.m.CYC.length?t('you.since',{d:dfmt(core.m.CYC[0].s,{month:'long',year:'numeric'})}):t('you.none')}
// [data-layer] real deleteAccount already ran signOut (stores/profile empty, no seed); the mock
// provider's resetData still reseeds the demo. Data/page side effects run even if the dialog was
// closed/replaced while the Promise was pending; only the owning dialog paints Erased/closes.
function wipe(owner){syncDB();stamp();wiping=true;state.holding=false;state.wipeT=state.now;nin.value='';count();preview();avDef=true;state.avSeed=0;state.avForm=0;state.ST=core.api.settings().data;state.settings.paintSettings(false);al.setAttribute('aria-checked',false);
if(state.dS!==owner){wiping=false;return}
state.dialog.dstep.textContent=t('you.done');state.dialog.dh.textContent=t('you.erased');state.dialog.dpx.textContent=t('you.erasedText')+(core.api._mode==='real'?'':t('you.erasedDemo'));state.dialog.sec.classList.remove('on');state.dialog.demo.textContent='';state.dialog.dok.hidden=true;state.dialog.dno.hidden=true;state.hb.hidden=true;state.dialog.derr.textContent='';state.dS.secret=false;state.dS.hold=false;
const sr=stage.getBoundingClientRect();wave(sr.left+state.avCX,sr.top+state.avCY);pulseAt(sr.left+state.avCX,sr.top+state.avCY,-1.6);core.buzz([20,40,20]);setTimeout(function(){if(state.dS===owner){state.dialog.closeDlg();closeZ()}wiping=false},2000)}
addEventListener('pointermove',e=>{state.px=e.clientX/innerWidth;state.py=e.clientY/innerHeight;state.lastMove=state.now});
// lens refraction (Chromium)
dm=core.dm();
function drawFx(t,dt){if(oi==1)state.settings.dials.forEach(d=>d.draw(t,dt));if(oi==2)state.transfer.drawAir(t,dt);if(state.dS){state.dialog.drawDlg(t,dt);if(state.dS.secret)state.dialog.drawSec(t,dt)}}
function size(){state.dpr=Math.min(devicePixelRatio||1,2);state.SW=innerWidth;state.SH=innerHeight;state.sky.width=state.SW*state.dpr;state.sky.height=state.SH*state.dpr;state.W=stage.clientWidth;stage.style.setProperty('--pw',state.W+'px');stage.style.setProperty('--ph',PNH+'px');stage.style.setProperty('--x-w',state.W+'px');avc.width=avc.height=Math.round(104*state.dpr);state.dialog.fitCv()}
const scene=YouScene(core,PG,state);state.scene=scene;
// ---------- one clock: springs for bodies, profile choreography, light on the glass
let last=0;
function loop(ts){const t=ts/1000,rdt=Math.min(.25,t-last||.016),dt=Math.min(.033,rdt);last=t;state.now=t;state.intro=reduce?3:state.intro+dt*.9;
if(t-state.lastMove>2.5){state.px=.5+.3*Math.sin(t*.35);state.py=.4+.25*Math.cos(t*.27)}state.spx+=(state.px-state.spx)*.07;state.spy+=(state.py-state.spy)*.07;
const k1=1-Math.exp(-dt*6);state.pm+=((oi>=0?1:0)-state.pm)*k1;em+=((editOpen?1:0)-em)*(1-Math.exp(-dt*7));ex=em*EXMAX;stage.style.height=(H0+ex)+'px';
// profile lockup: hero -> compact
state.avS=104-56*state.pm;state.avCX=(state.W/2-52)*(1-state.pm)+state.avS/2;state.avCY=lerp(18,10,state.pm)+state.avS/2;const nl=lerp(state.W/2,62,state.pm),tx=-50*(1-state.pm);
av.style.cssText+=`;width:${state.avS}px;height:${state.avS}px;transform:translate(${(state.W/2-52)*(1-state.pm)}px,${lerp(18,10,state.pm)}px)`;av.style.left=av.style.top='0px';
nm.style.cssText+=`;left:${nl}px;top:${lerp(136,22,state.pm)}px;font-size:${lerp(52,24,state.pm)}px;transform:translateX(${tx}%);font-weight:${(780+60*Math.sin(t*.8)).toFixed(0)}`;
const fo=clamp(1-state.pm*2.4);sbt.style.cssText+=`;left:${state.W/2}px;top:222px;transform:translateX(-50%);opacity:${(.6*fo).toFixed(3)}`;
ebtn.style.cssText+=`;left:${state.W/2}px;top:262px;transform:translateX(-50%);opacity:${fo.toFixed(3)};pointer-events:${fo>.5?'auto':'none'}`;
ed.style.cssText+=`;left:0;right:0;top:326px;height:${ex.toFixed(1)}px;opacity:${clamp(em*1.2).toFixed(3)};pointer-events:${em>.5?'auto':'none'}`;
// bodies
const sr=stage.getBoundingClientRect();
sats.forEach(s=>{const g=layout(s);if(!s.ready){s.cx=state.avCX;s.cy=state.avCY;s.w=s.h=10;s.ready=true;s.vx=(rnd(s.i,5)-.5)*400;s.vy=(rnd(s.i,6)-.5)*400}
const fl=1-state.pm,pdx=state.spx*state.SW-(sr.left+s.cx),pdy=state.spy*state.SH-(sr.top+s.cy),pd=Math.hypot(pdx,pdy)+1,pull=fl*clamp(1-pd/340)*16,fx=Math.sin(t*(.5+.1*s.i)+s.ph)*8*fl+(state.spx-.5)*10*fl+pdx/pd*pull,fy=Math.cos(t*(.42+.08*s.i)+s.ph)*8*fl+(state.spy-.5)*8*fl+pdy/pd*pull;
const hit=clamp(state.intro*1.6-s.i*.16);
if(reduce){s.cx=g.cx;s.cy=g.cy;s.w=g.w;s.h=g.h}else{for(const [p,v,q] of [['cx','vx',g.cx+fx],['cy','vy',g.cy+fy],['w','vw',g.w],['h','vh',g.h]]){const tg=hit<=0?(p=='cx'?state.avCX:p=='cy'?state.avCY:10):q;s[v]+=((tg-s[p])*170-s[v]*16)*dt;s[p]+=s[v]*dt}}
const w=Math.max(8,s.w),h=Math.max(8,s.h),e=clamp((w-REST[s.i][2])/(state.W-REST[s.i][2])),mini=(oi>=0&&oi!=s.i)?1:0;s.m+=(mini-s.m)*k1;s.e=e;
const base=lerp(Math.min(w,h)/2,44,Math.pow(e,.7)),wb=1-e,r=[0,1,2,3].map(c=>Math.max(2,base*(1+wb*.13*Math.sin(t*(.7+.2*c)+s.ph+c*1.7)))),bl=lerp(r[3],14,e);
const st=s.el.style;st.width=w.toFixed(1)+'px';st.height=h.toFixed(1)+'px';st.transform=`translate3d(${(s.cx-w/2).toFixed(1)}px,${(s.cy-h/2).toFixed(1)}px,0)`;st.borderRadius=`${r[0].toFixed(1)}px ${r[1].toFixed(1)}px ${r[2].toFixed(1)}px ${bl.toFixed(1)}px`;st.setProperty('--e',e.toFixed(3));st.setProperty('--m',s.m.toFixed(3));st.zIndex=oi==s.i?3:1;if(s.fz)s.bd.style.transform=`translate(${(s.fx-(s.cx-w/2)).toFixed(1)}px,${(s.fy-(s.cy-h/2)).toFixed(1)}px)`});
// light on the glass
// freeze the expanded card's light; a static highlight keeps the large glass layer cheap to composite
const gx=state.spx*state.SW,gy=state.spy*state.SH,openGlass=oi>=0?sats[oi].el:null;$$('.glass').forEach(el=>{if(el===openGlass)return;const r=el.getBoundingClientRect();if(r.bottom<0||r.top>state.SH)return;el.style.setProperty('--px',(gx-r.left).toFixed(0)+'px');el.style.setProperty('--py',(gy-r.top).toFixed(0)+'px');el.style.setProperty('--ang',(Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90).toFixed(0)+'deg')});
if(dm)dm.setAttribute('scale',(30+12*(oi>=0?1:0)*state.pm+10*Math.min(1,Math.abs(state.imp)+state.waves.length*.3)).toFixed(1));
// hold-to-erase + implosion
if(state.holding||state.hp>0){state.hp=clamp(state.hp+(state.holding?rdt/1.4:-rdt*2.4));state.hb.style.setProperty('--p',state.hp.toFixed(3));if(state.hp>=1&&state.dS&&state.dS.hold&&!state.dS.held){state.dS.held=true;state.holding=false;state.dS.onHold&&state.dS.onHold()}}
const age=t-state.wipeT;state.imp=age>=0&&age<1.9?(age<.8?Math.pow(age/.8,2):Math.max(0,1-(age-.8)/1.1)):0;
// while a card is open the sky runs at ~30fps so the expanded glass keeps the frame budget
if(oi<0||t-skyT>.032){state.scene.drawSky(t);skyT=t}state.scene.drawAv(t,dt);drawFx(t,dt);requestAnimationFrame(loop)}
cacheInk();state.scene.LKB();size();count();preview();stamp();state.settings.paintSettings(false);paintVersion();requestAnimationFrame(()=>{size()});if('ResizeObserver' in window){let _rz;new ResizeObserver(()=>{clearTimeout(_rz);_rz=setTimeout(size,80)}).observe(stage)}requestAnimationFrame(loop);document.fonts&&document.fonts.ready.then(size);
// ---------- 迭代1（3.0.1）bug3：昵称 boot 同步 + hydrate 后再同步 ----------
// boot_you 收尾把 core.profile.name 写进 #nin（与 setEdit(false) 的填充一致）；profile 事件
// （hydrate/登录/保存后由 API 层发出，页面不重复 emit）再次同步；用户正在输入或编辑面板打开时不覆盖。
const syncNick=()=>{if(editOpen||document.activeElement===nin)return;if((nin.value||'')!==(prof.name||'')){nin.value=prof.name||'';count();preview();state.avSeed=prof.name?hash(prof.name):0;avDef=!prof.name}};
syncNick();
try{core.on('profile',syncNick)}catch(_){}
// ---------- 迭代1（3.0.1）：本页唯一 'lang' 监听 —— 文案直写、不走进入动画；对话框开着时实时重写文本 ----------
core.on('lang',()=>{preview();stamp();paintVersion();flick(ebtn,editOpen?t('ui.cancel'):t('you.edit'));state.settings.paintSettings(false);state.setState(0,{light:t('you.light'),dark:t('you.dark'),system:t('you.system')}[state.appearance]||t('you.dark'));if(state.dS&&state.dialog.repaintDlg)state.dialog.repaintDlg()});

return {size,cacheInk,setSY:v=>{state.scrollY=v},wave,refresh:()=>{syncDB();stamp();state.ST=core.api.settings().data;state.settings.paintSettings(false);paintVersion();al.setAttribute('aria-checked',core.api.auth.state().persistent)}};}
