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
const t=(k,v)=>core.i18n.t(k,v),plw=(n,b)=>core.i18n.t(core.i18n.plural(n,b),{n}),dfmt=(n,o)=>core.i18n.date(n,o);

const 
reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,mq=matchMedia('(prefers-color-scheme:dark)'),clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),lerp=(a,b,t)=>a+(b-a)*t,
rnd=(i,k=1)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)},gauss=(d,s)=>Math.exp(-d*d/(2*s*s)),
sp=(c,x,y,r,f)=>{c.beginPath();c.moveTo(x,y-r);c.quadraticCurveTo(x,y,x+r,y);c.quadraticCurveTo(x,y,x,y+r);c.quadraticCurveTo(x,y,x-r,y);c.quadraticCurveTo(x,y,x,y-r);f?c.fill():c.stroke()};
const isMob=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||!document.body.classList.contains('piq-shell');
const setGlassLight=(el,px,py,ang,w,h)=>{if(core.glassLight){core.glassLight(el,px,py,ang,w,h);return}const qx=Math.round(px*10)/10,qy=Math.round(py*10)/10,qa=Math.round(ang*10)/10;if(el._gpx===qx&&el._gpy===qy&&el._gang===qa)return;el._gpx=qx;el._gpy=qy;el._gang=qa;el.style.setProperty('--px',qx+'px');el.style.setProperty('--py',qy+'px');el.style.setProperty('--ang',qa+'deg')};
let dm,skyT=-9,avT=-9,skyOnce=true,lsy=0,dyReady=false;
const cacheInk=()=>{const cs=getComputedStyle(root);state.ink=cs.getPropertyValue('--ink').trim();state.bgc=cs.getPropertyValue('--bg').trim();skyOnce=true},ik=a=>`rgba(${state.ink},${clamp(a)})`,ib=a=>`rgba(${state.bgc},${clamp(a)})`,wave=(x,y)=>reduce||state.waves.push({x,y,t:state.now});
// ---------- state
let em=0,ex=0,oi=-1,editOpen=false,nOn=false,avDef=true,wiping=false;
// 主题选择是设备级偏好：Android 宿主在文档起始处把落盘值写进 window.__piqThemeMode（未选过则缺席，
// 保持既有暗色首屏）。这里只读它作为 Appearance 的当前项，落盘/应用见 you.settings.js。
const themeMode=window.__piqThemeMode==='light'||window.__piqThemeMode==='dark'||window.__piqThemeMode==='system'?window.__piqThemeMode:'dark';
const state={scrollY:0,ink:'0,0,0',bgc:'255,255,255',dpr:1,SW:0,SH:0,now:0,px:.5,py:.4,spx:.5,spy:.4,lastMove:-9,waves:[],wipeT:-9,imp:0,W:394,pm:0,intro:0,hp:0,holding:false,avCX:0,avCY:0,avS:104,avSeed:0,avForm:0,appearance:themeMode,dS:null,sr:null};
let srDirty=true,nmDirty=true,nmRefW=0,nmRefFs=52;
const H0=660,EXMAX=isMob?160:150,PTOP=84,PNH=H0-PTOP-92,REST=[[.17,80,100,100,0],[.83,92,104,104,0],[.28,404,176,116,1],[.73,470,168,128,1],[.47,596,100,100,1]];
const prof=core.profile,DB={records:[]};function syncDB(){DB.records=core.hist().map(o=>({d:core.m.fmt(o.s),p:o.per,c:o.len}))}syncDB();
const stage=$('#stage'),nm=$('#nm'),sbt=$('#sbt'),ebtn=$('#ebtn'),ed=$('#ed'),av=$('#av'),avc=$('#avc'),avx=avc.getContext('2d'),nin=$('#nin'),ncnt=$('#ncnt');
const sats=$$('.sat').map((el,i)=>({el,i,face:el.querySelector('.face'),bd:el.querySelector('.bd'),cx:0,cy:0,w:12,h:12,vx:0,vy:0,vw:0,vh:0,e:0,m:0,ph:rnd(i,1)*6.28,ready:false}));
const satSet=new Set(sats.map(s=>s.el)),otherGlass=$$('.glass').filter(el=>!satSet.has(el));let otherRects=[];
let morphT=0,closeT=0,stHT=0;
const morphStart=()=>{srDirty=true;stage.classList.add('morphing');clearTimeout(morphT);morphT=setTimeout(()=>{stage.classList.remove('morphing');srDirty=true},isMob?520:760)};
const fadeOut=el=>{const s=sats.find(t=>t.el===el);if(s){s.fx=s.cx-s.w/2;s.fy=s.cy-s.h/2;s.fz=true}el.classList.add('closing');clearTimeout(closeT);closeT=setTimeout(()=>sats.forEach(t=>{t.el.classList.remove('closing');t.fz=false;t.bd.style.transform=''}),380)};
const setState=(i,t)=>{sats[i].el.querySelector('.fs').textContent=t;const c=sats[i].el.querySelector('.fsv');c&&(c.textContent=t)};
const say=(sel,msg)=>{const el=$(sel);el.textContent=msg;el.animate([{opacity:0,filter:'blur(6px)'},{opacity:1,filter:'blur(0)'}],{duration:560,easing:'cubic-bezier(.2,.9,.1,1)'})};
const flick=(el,txt)=>{if(el.textContent==txt)return;if(reduce||isMob){el.textContent=txt;return}el.animate([{opacity:1,filter:'blur(0)'},{opacity:0,filter:'blur(10px)'}],{duration:200}).onfinish=()=>{el.textContent=txt;el.animate([{opacity:0,filter:'blur(10px)'},{opacity:1,filter:'blur(0)'}],{duration:520,easing:'cubic-bezier(.2,.9,.1,1)'})}};
// ---------- gravity: a wave through the stars + a shove for every body
function pulseAt(x,y,k=1){const sr=stage.getBoundingClientRect();sats.forEach(s=>{const dx=s.cx+sr.left-x,dy=s.cy+sr.top-y,d=Math.hypot(dx,dy)+30;s.vx+=dx/d*k*700/(1+d/70);s.vy+=dy/d*k*700/(1+d/70)})}
function layout(s){const i=s.i;if(oi<0){const r=REST[i];return{cx:r[0]*state.W,cy:r[1]+(r[4]?ex+(isMob?0:10*em):0),w:r[2],h:r[3]}}if(oi==i)return{cx:state.W/2,cy:PTOP+PNH/2,w:state.W,h:PNH};const o=[0,1,2,3,4].filter(k=>k!=oi),n=o.indexOf(i);return{cx:state.W*(.14+.72*n/3),cy:H0-44,w:52,h:52}}
function openZ(i){if(oi==i)return;const prev=oi>=0?sats[oi].el:null;sats[i].el.classList.remove('closing');sats[i].fz=false;sats[i].bd.style.transform='';if(editOpen)setEdit(false);oi=i;stage.classList.add('has-open');sats.forEach(s=>{const on=s.i==i;s.el.classList.toggle('open',on);s.face.inert=on;s.bd.inert=!on;s.face.setAttribute('aria-expanded',on);if(on)s.bd.querySelector('.sc').scrollTop=0});
if(prev&&prev!==sats[i].el)fadeOut(prev);
const s=sats[i],sr=stage.getBoundingClientRect();setGlassLight(s.el,state.W*.35,86,isMob?NaN:0,state.W,PNH);wave(sr.left+s.cx,sr.top+s.cy);pulseAt(sr.left+s.cx,sr.top+s.cy,1);core.buzz(10);morphStart();if(i==1){state.ST=core.api.settings().data;state.settings.paintSettings(false)}}
function closeZ(){if(oi<0)return;const s=sats[oi],sr=stage.getBoundingClientRect();oi=-1;stage.classList.remove('has-open');sats.forEach(t=>{t.el.classList.remove('open');t.face.inert=false;t.bd.inert=true;t.face.setAttribute('aria-expanded',false)});pulseAt(sr.left+state.W/2,sr.top+state.avCY,.8);wave(sr.left+state.avCX,sr.top+state.avCY);fadeOut(s.el);morphStart()}
sats.forEach(s=>{s.face.onclick=()=>openZ(s.i);s.el.querySelector('.x').onclick=closeZ});
stage.addEventListener('click',e=>{if(e.target===stage||e.target.id=='pf')closeZ()});addEventListener('keydown',e=>{if(e.key=='Escape')state.dS?state.dialog.closeDlg():closeZ()});
// ---------- profile + avatar sigil
const hash=s=>{let h=7;for(const c of s)h=(h*31+c.charCodeAt(0))%100003;return h};
function setEdit(on){editOpen=on;flick(ebtn,on?t('ui.cancel'):t('you.edit'));if(isMob){clearTimeout(stHT);ed.classList.toggle('open',on);stage.classList.toggle('ed-on',on);if(on){stage.style.height=(H0+EXMAX)+'px';_stH=(H0+EXMAX)+'px'}else stHT=setTimeout(()=>{if(!editOpen){stage.style.height=H0+'px';_stH=H0+'px'}},320)}if(on){if(oi>=0)closeZ();nin.value=prof.name;count();preview();setTimeout(()=>{if(editOpen)nin.focus({preventScroll:true})},isMob?180:520)}else{try{nin.blur()}catch(_){}nin.value=prof.name;count();preview();state.avSeed=prof.name?hash(prof.name):0;avDef=!prof.name}}
ebtn.onclick=()=>setEdit(!editOpen);
const count=()=>{ncnt.textContent=`${nin.value.length} / 24`;ncnt.classList.toggle('hot',nin.value.length>=22)};
// [data-layer] the title always reflects the saved name (core.profile.name): typing only previews,
// and an emptied input still shows the saved nickname instead of losing it on screen.
function preview(){const typed=editOpen?nin.value.trim():'';flick(nm,typed||prof.name||t('you.noname'));nmDirty=true}
function reseed(){if(!avDef)state.avSeed=hash(nin.value);state.avForm=0}
nin.oninput=()=>{count();preview();avDef=!nin.value.trim();reseed()};
$('#rav').onclick=()=>{avDef=true;state.avSeed=0;state.avForm=0;const r=av.getBoundingClientRect();wave(r.left+r.width/2,r.top+r.height/2);core.buzz(8)};
// [data-layer] profile is an async auth write: await the Promise, consume r.message on failure.
// The API already emits 'profile' after updating core.profile.name; the page must not emit twice.
async function doSave(name){const r=await core.api.auth.profile({nickname:name});if(!r.ok){flick(ncnt,r.message);return}setEdit(false);const b=av.getBoundingClientRect();wave(b.left+b.width/2,b.top+b.height/2);pulseAt(b.left+b.width/2,b.top+b.height/2,1.2);core.buzz(12)}
$('#sav').onclick=async()=>{const name=nin.value.trim();if(!name&&prof.name){state.dialog.showDlg({origin:pos($('#sav')),step:'',title:t('you.confirmEmptyTitle'),text:t('you.confirmEmptyText'),ok:t('you.confirmEmptyOk'),no:t('ui.cancel'),K:{title:'you.confirmEmptyTitle',text:'you.confirmEmptyText',ok:'you.confirmEmptyOk',no:'ui.cancel'},onOk:()=>({ok:true,after:()=>doSave('')})});return}if(!name){flick(ncnt,t('you.nickPh'));return}await doSave(name)};
av.onclick=()=>{const r=av.getBoundingClientRect();wave(r.left+r.width/2,r.top+r.height/2);pulseAt(r.left+r.width/2,r.top+r.height/2,1)};
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
const needPw=r=>{if(r.status==422)return t('you.needPw');if(r.code=='WRONG_PASSWORD')return t('you.wrongPw2');return r.message||core.errors.text('HTTP_ERROR')};
al.onclick=async()=>{if(al.getAttribute('aria-checked')=='true'){const r=await core.api.auth.clearPersistence();if(!r.ok){say('#prs',r.message);return}setPersist(false);core.buzz(6);say('#prs',t('you.prsCleared'));return}
state.dialog.showDlg({origin:pos(al),step:t('you.dKeepStep'),title:t('you.dPwTitle'),text:t('you.dPwText'),secret:true,ok:t('you.dPwOk'),no:t('ui.cancel'),K:{step:'you.dKeepStep',title:'you.dPwTitle',text:'you.dPwText',ok:'you.dPwOk',no:'ui.cancel'},onOk:pw=>core.api.auth.persistence(pw).then(r=>r.ok?{ok:true,after:()=>{setPersist(true);say('#prs',t('you.prsOn'))}}:{ok:false,message:needPw(r)})})};
function changePw(el,msg){
const og=pos(el);let cur='';
state.dialog.showDlg({origin:og,step:t('you.cpStep1'),title:t('you.cpCur'),text:msg||t('you.cpCurText'),secret:true,ok:t('you.cpNext'),no:t('ui.cancel'),K:{step:'you.cpStep1',title:'you.cpCur',text:msg?null:'you.cpCurText',ok:'you.cpNext',no:'ui.cancel'},onOk:pw=>{
if(!pw)return{ok:false,message:t('you.needPw')};
cur=pw;
return{ok:true,next:()=>({step:t('you.cpStep2'),title:t('you.cpNew'),text:t('you.cpNewText'),secret:true,ok:t('you.cpOk'),no:t('ui.cancel'),K:{step:'you.cpStep2',title:'you.cpNew',text:'you.cpNewText',ok:'you.cpOk',no:'ui.cancel'},onOk:np=>core.api.auth.changePassword(cur,np).then(r=>{
if(r.ok){if(typeof boot_auth==='function'&&boot_auth.ctl&&boot_auth.ctl.notice)boot_auth.ctl.notice(t('auth.pwUpdated'));return{ok:true,after:()=>{setPersist(false);say('#prs',t('you.cpDone'))}}}
if(r.code=='WRONG_PASSWORD')return{ok:false,message:t('you.cpWrong'),then:()=>changePw(el,t('you.cpRetry'))};
return{ok:false,message:r.status==422?t('you.cpNeedNew'):(r.message||core.errors.text('HTTP_ERROR'))}
})})};
}});
}
$('#pwb').onclick=e=>changePw(e.currentTarget);
$('#lo').onclick=async()=>{const was=al.getAttribute('aria-checked')=='true';const r=await core.api.auth.logout();if(!r.ok){say('#prs',r.message);al.setAttribute('aria-checked',!!core.api.auth.state().persistent);return}if(was)setPersist(false);say('#prs',t('you.loDone')+(was?t('you.loOff'):''));const p=pos($('#lo'));wave(p.x,p.y);pulseAt(p.x,p.y,.9)};
$('#del').onclick=e=>state.dialog.showDlg({origin:pos(e.currentTarget),step:t('you.delStep1'),title:t('you.delTitle'),text:t('you.delText',{c:DB.records.length==1?t('you.delC1'):t('you.delCN',{n:DB.records.length})}),hold:true,no:t('you.delNo'),K:{step:'you.delStep1',title:'you.delTitle',text:'you.delText',tvars:{c:DB.records.length==1?t('you.delC1'):t('you.delCN',{n:DB.records.length})},no:'you.delNo'},onHold:()=>state.dialog.showDlg({step:t('you.delStep2'),title:t('you.delPwTitle'),text:t('you.delPwText'),secret:true,ok:t('you.delOk'),no:t('you.delNo'),K:{step:'you.delStep2',title:'you.delPwTitle',text:'you.delPwText',ok:'you.delOk',no:'you.delNo'},onOk:pw=>core.api.auth.deleteAccount(pw).then(r=>r.ok?{ok:true,keepOpen:true,after:wipe}:{ok:false,message:needPw(r)})},true)});
state.hb.addEventListener('pointerdown',e=>{state.holding=true;try{state.hb.setPointerCapture(e.pointerId)}catch(_){}core.buzz(6)});['pointerup','pointercancel'].forEach(k=>state.hb.addEventListener(k,()=>state.holding=false));
state.hb.addEventListener('keydown',e=>{if(e.key=='Enter'||e.key==' '){state.holding=true;e.preventDefault()}});state.hb.addEventListener('keyup',()=>state.holding=false);
function stamp(){sbt.textContent=core.m.CYC.length?t('you.since',{d:dfmt(core.m.CYC[0].s,{month:'long',year:'numeric'})}):t('you.none')}
function wipe(owner){syncDB();stamp();wiping=true;state.holding=false;state.wipeT=state.now;nin.value='';count();preview();avDef=true;state.avSeed=0;state.avForm=0;state.ST=core.api.settings().data;state.settings.paintSettings(false);al.setAttribute('aria-checked',false);
if(state.dS!==owner){wiping=false;return}
state.dialog.dstep.textContent=t('you.done');state.dialog.dh.textContent=t('you.erased');state.dialog.dpx.textContent=t('you.erasedText')+(core.api._mode==='real'?'':t('you.erasedDemo'));state.dialog.sec.classList.remove('on');state.dialog.demo.textContent='';state.dialog.dok.hidden=true;state.dialog.dno.hidden=true;state.hb.hidden=true;state.dialog.derr.textContent='';state.dS.secret=false;state.dS.hold=false;
const sr=stage.getBoundingClientRect();wave(sr.left+state.avCX,sr.top+state.avCY);pulseAt(sr.left+state.avCX,sr.top+state.avCY,-1.6);core.buzz([20,40,20]);setTimeout(function(){if(state.dS===owner){state.dialog.closeDlg();closeZ()}wiping=false},2000)}
addEventListener('pointermove',e=>{state.px=e.clientX/innerWidth;state.py=e.clientY/innerHeight;state.lastMove=state.now});
// lens refraction (Chromium)
dm=core.dm();
function drawFx(t,dt){if(oi==1)state.settings.dials.forEach(d=>d.draw(t,dt));if(oi==2)state.transfer.drawAir(t,dt);if(state.dS){state.dialog.drawDlg(t,dt);if(state.dS.secret)state.dialog.drawSec(t,dt)}}
function size(){const cw=stage.clientWidth;state.dpr=Math.min(devicePixelRatio||1,2);state.skyDpr=isMob?1:state.dpr;state.SW=innerWidth;state.SH=innerHeight;state.sky.width=state.SW*state.skyDpr;state.sky.height=state.SH*state.skyDpr;if(cw>0){state.W=cw;stage.style.setProperty('--pw',cw+'px');stage.style.setProperty('--ph',PNH+'px');stage.style.setProperty('--x-w',cw+'px');avc.width=avc.height=Math.round(104*state.dpr);state.dialog.fitCv()}srDirty=true;nmDirty=true;skyOnce=true}
const scene=YouScene(core,PG,state);state.scene=scene;
// ---------- one clock: springs for bodies, profile choreography, light on the glass
let last=0,lastPm=-1,lastEm=-1,_stH='',_avW='',_avTr='',_nmL='',_nmT='',_nmFs='',_nmTr='',_nmFw='',_sbL='',_sbOp='',_ebL='',_ebOp='',_ebPe='',_edH='',_edOp='',_edPe='';
av.style.left=av.style.top='0px';sbt.style.top='222px';sbt.style.transform='translateX(-50%)';ebtn.style.top='262px';ebtn.style.transform='translateX(-50%)';ed.style.left='0px';ed.style.right='0px';ed.style.top='326px';
function loop(ts){const t=ts/1000,rdt=Math.min(.25,t-last||.016),dt=Math.min(.033,rdt);last=t;state.now=t;state.intro=reduce?3:state.intro+dt*.9;
const animPm=Math.abs(state.pm-(oi>=0?1:0))>.002||Math.abs(state.pm-lastPm)>.002,animEm=Math.abs(em-(editOpen?1:0))>.002||Math.abs(em-lastEm)>.002,morphing=stage.classList.contains('morphing');
if(srDirty||animEm){state.sr=stage.getBoundingClientRect();otherRects=otherGlass.map(el=>({el,r:el.getBoundingClientRect()}));srDirty=false}
if(isMob&&!dyReady&&oi<0&&!PG.classList.contains('entering')&&sats.every(s=>s.m<.01)){let ok=true;sats.forEach(s=>{const fr=s.face.getBoundingClientRect(),sr2=s.face.querySelector('svg').getBoundingClientRect();if(fr.height>=50&&sr2.height>0)s.face.style.setProperty('--dy',((fr.top+fr.height/2)-(sr2.top+sr2.height/2)).toFixed(1)+'px');else ok=false});if(ok)dyReady=true}
if(nmDirty&&!PG.classList.contains('entering')&&nm.offsetWidth>0){nm.style.fontSize='52px';nmRefW=nm.offsetWidth;nmRefFs=52;nmDirty=false;_nmFs=''}
lastPm=state.pm;lastEm=em;
if(t-state.lastMove>2.5){state.px=.5+.3*Math.sin(t*.35);state.py=.4+.25*Math.cos(t*.27)}const pEase=t-state.lastMove>2.5?.07:.11;state.spx+=(state.px-state.spx)*pEase;state.spy+=(state.py-state.spy)*pEase;
const k1=1-Math.exp(-rdt*6);state.pm+=((oi>=0?1:0)-state.pm)*k1;em+=((editOpen?1:0)-em)*(1-Math.exp(-rdt*7));ex=em*EXMAX;
if(!isMob){const stH=(H0+ex).toFixed(1)+'px';if(_stH!==stH){_stH=stH;stage.style.height=stH}}
// profile lockup: hero -> compact
state.avS=104-56*state.pm;state.avCX=(state.W/2-52)*(1-state.pm)+state.avS/2;state.avCY=lerp(18,10,state.pm)+state.avS/2;const nl=lerp(state.W/2,62,state.pm),tx=-50*(1-state.pm);
if(isMob){const avTr=`translate3d(${((state.W/2-52)*(1-state.pm)).toFixed(1)}px,${lerp(18,10,state.pm).toFixed(1)}px,0) scale(${(state.avS/104).toFixed(4)})`;if(_avW!=='104px'){_avW='104px';av.style.width='104px';av.style.height='104px';av.style.transformOrigin='0 0'}if(_avTr!==avTr){_avTr=avTr;av.style.transform=avTr}}else{const avW=state.avS.toFixed(1)+'px',avTr=`translate(${((state.W/2-52)*(1-state.pm)).toFixed(1)}px,${lerp(18,10,state.pm).toFixed(1)}px)`;if(_avW!==avW){_avW=avW;av.style.width=avW;av.style.height=avW}if(_avTr!==avTr){_avTr=avTr;av.style.transform=avTr}}
// A 24-character nickname must stay fully readable: the title is nowrap, so shrink the font to the
// line it actually has (closed: centred with side margins; open: left-aligned after the avatar)
// instead of letting it run past the viewport edges. Short names keep the base size untouched.
const nmFs=lerp(52,24,state.pm),nmAvail=state.W-36-42*state.pm,estW=nmRefW*(nmFs/nmRefFs)*1.04;
if(isMob){const baseFs=nmRefW*1.04>state.W-36?52*(state.W-36)/(nmRefW*1.04):52,openMax=state.W-78,openFs=nmRefW*(24/52)*1.04>openMax?24*openMax/(nmRefW*(24/52)*1.04):24,sc=lerp(1,openFs/baseFs,state.pm),nmFsS=baseFs.toFixed(1)+'px',nmL=nl.toFixed(1)+'px',nmT=lerp(136,22,state.pm).toFixed(1)+'px',nmTr=`translateX(${tx.toFixed(2)}%) scale(${sc.toFixed(4)})`;if(_nmFs!==nmFsS){_nmFs=nmFsS;nm.style.fontSize=nmFsS}if(_nmFw!=='800'){_nmFw='800';nm.style.fontWeight='800'}if(_nmL!==nmL){_nmL=nmL;nm.style.left=nmL}if(_nmT!==nmT){_nmT=nmT;nm.style.top=nmT}if(_nmTr!==nmTr){_nmTr=nmTr;nm.style.transform=nmTr}}else{const nmL=nl.toFixed(1)+'px',nmT=lerp(136,22,state.pm).toFixed(1)+'px',nmFsS=(nmAvail>0&&estW>nmAvail?(nmFs*nmAvail/estW).toFixed(1):nmFs.toFixed(1))+'px',nmTr=`translateX(${tx.toFixed(2)}%)`,nmFw=(780+60*Math.sin(t*.8)).toFixed(0);
if(_nmL!==nmL){_nmL=nmL;nm.style.left=nmL}if(_nmT!==nmT){_nmT=nmT;nm.style.top=nmT}if(_nmFs!==nmFsS){_nmFs=nmFsS;nm.style.fontSize=nmFsS}if(_nmTr!==nmTr){_nmTr=nmTr;nm.style.transform=nmTr}if(_nmFw!==nmFw){_nmFw=nmFw;nm.style.fontWeight=nmFw}}
const fo=clamp(1-state.pm*2.4),wHalf=(state.W/2).toFixed(1)+'px',sbOp=(.6*fo).toFixed(3),ebOp=fo.toFixed(3),ebPe=fo>.5?'auto':'none';
if(_sbL!==wHalf){_sbL=wHalf;sbt.style.left=wHalf}if(_sbOp!==sbOp){_sbOp=sbOp;sbt.style.opacity=sbOp}
if(_ebL!==wHalf){_ebL=wHalf;ebtn.style.left=wHalf}if(_ebOp!==ebOp){_ebOp=ebOp;ebtn.style.opacity=ebOp}if(_ebPe!==ebPe){_ebPe=ebPe;ebtn.style.pointerEvents=ebPe}
if(!isMob){const edH=ex.toFixed(1)+'px',edOp=clamp(em*1.2).toFixed(3),edPe=em>.5?'auto':'none';if(_edH!==edH){_edH=edH;ed.style.height=edH}if(_edOp!==edOp){_edOp=edOp;ed.style.opacity=edOp}if(_edPe!==edPe){_edPe=edPe;ed.style.pointerEvents=edPe}}
// bodies
const sr=state.sr;
sats.forEach(s=>{const g=layout(s);if(!s.ready){s.cx=state.avCX;s.cy=state.avCY;s.w=s.h=10;s.ready=true;s.vx=(rnd(s.i,5)-.5)*400;s.vy=(rnd(s.i,6)-.5)*400}
const fl=1-state.pm,pdx=state.spx*state.SW-(sr.left+s.cx),pdy=state.spy*state.SH-(sr.top+s.cy),pd=Math.hypot(pdx,pdy)+1,pull=fl*clamp(1-pd/340)*16,fx=Math.sin(t*(.5+.1*s.i)+s.ph)*8*fl+(state.spx-.5)*44*fl+pdx/pd*pull,fy=Math.cos(t*(.42+.08*s.i)+s.ph)*8*fl+(state.spy-.4)*34*fl+pdy/pd*pull;
const hit=clamp(state.intro*1.6-s.i*.16);
if(reduce){s.cx=g.cx;s.cy=g.cy;s.w=g.w;s.h=g.h}else{for(const [p,v,q] of [['cx','vx',g.cx+fx],['cy','vy',g.cy+fy],['w','vw',g.w],['h','vh',g.h]]){const tg=hit<=0?(p=='cx'?state.avCX:p=='cy'?state.avCY:10):q;s[v]+=((tg-s[p])*170-s[v]*16)*dt;s[p]+=s[v]*dt}}
const w=Math.max(8,s.w),h=Math.max(8,s.h),e=clamp((w-REST[s.i][2])/(state.W-REST[s.i][2])),mini=(oi>=0&&oi!=s.i)?1:0;s.m+=(mini-s.m)*k1;s.e=e;
const q5=v=>Math.round(v*2)/2,st=s.el.style,eS=e.toFixed(3),mS=s.m.toFixed(3),zS=oi==s.i?'3':'1';
if(isMob&&oi>=0&&oi!==s.i&&Math.abs(w-52)<.6&&Math.abs(h-52)<.6){const wS='52px',hS='52px',brS='26px',trS=`translate3d(${(s.cx-26).toFixed(1)}px,${(s.cy-26).toFixed(1)}px,0)`;if(s._w!==wS){s._w=wS;st.width=wS}if(s._h!==hS){s._h=hS;st.height=hS}if(s._br!==brS){s._br=brS;st.borderRadius=brS}if(s._tr!==trS){s._tr=trS;st.transform=trS}}else if(isMob&&oi>=0&&oi!==s.i){
const wQ=q5(w),hQ=q5(h),wS=wQ.toFixed(1)+'px',hS=hQ.toFixed(1)+'px',trS=`translate3d(${(s.cx-wQ/2).toFixed(1)}px,${(s.cy-hQ/2).toFixed(1)}px,0)`,brS=q5(Math.min(wQ,hQ)/2).toFixed(1)+'px';if(s._w!==wS){s._w=wS;st.width=wS}if(s._h!==hS){s._h=hS;st.height=hS}if(s._tr!==trS){s._tr=trS;st.transform=trS}if(s._br!==brS){s._br=brS;st.borderRadius=brS}}else{
const base=lerp(Math.min(w,h)/2,44,Math.pow(e,.7)),wb=1-e,r=[0,1,2,3].map(c=>Math.max(2,base*(1+wb*.13*Math.sin(t*(.7+.2*c)+s.ph+c*1.7)))),bl=lerp(r[3],14,e);
const wQ=q5(w),hQ=q5(h),wS=wQ.toFixed(1)+'px',hS=hQ.toFixed(1)+'px',trS=`translate3d(${(s.cx-wQ/2).toFixed(1)}px,${(s.cy-hQ/2).toFixed(1)}px,0)`,brS=`${q5(r[0]).toFixed(1)}px ${q5(r[1]).toFixed(1)}px ${q5(r[2]).toFixed(1)}px ${q5(bl).toFixed(1)}px`;if(s._w!==wS){s._w=wS;st.width=wS}if(s._h!==hS){s._h=hS;st.height=hS}if(s._tr!==trS){s._tr=trS;st.transform=trS}if(s._br!==brS){s._br=brS;st.borderRadius=brS}}
if(s._e!==eS){s._e=eS;st.setProperty('--e',eS)}if(s._m!==mS){s._m=mS;st.setProperty('--m',mS)}if(s._z!==zS){s._z=zS;st.zIndex=zS}if(s.fz)s.bd.style.transform=`translate(${(s.fx-(s.cx-w/2)).toFixed(1)}px,${(s.fy-(s.cy-h/2)).toFixed(1)}px)`});
// light on the glass
// freeze the expanded card's light; a static highlight keeps the large glass layer cheap to composite
const scrolling=Math.abs(state.scrollY-lsy)>2;lsy=state.scrollY;
if(!scrolling){const gx=state.spx*state.SW,gy=state.spy*state.SH,openGlass=oi>=0?sats[oi].el:null,skipRim=isMob&&oi>=0;
for(let i=0;i<sats.length;i++){const s=sats[i];if(s.el===openGlass)continue;const l=sr.left+s.cx-s.w/2,tp=sr.top+s.cy-s.h/2;if(tp+s.h<0||tp>state.SH)continue;setGlassLight(s.el,gx-l,gy-tp,skipRim?NaN:Math.atan2(gy-tp-s.h/2,gx-l-s.w/2)*57.3+90,s.w,s.h)}
for(let i=0;i<otherRects.length;i++){const {el,r}=otherRects[i];if(r.bottom<0||r.top>state.SH)continue;setGlassLight(el,gx-r.left,gy-r.top,Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90,r.width,r.height)}}
if(dm)dm.setAttribute('scale',(30+12*(oi>=0?1:0)*state.pm+10*Math.min(1,Math.abs(state.imp)+state.waves.length*.3)).toFixed(1));
// hold-to-erase + implosion
if(state.holding||state.hp>0){state.hp=clamp(state.hp+(state.holding?rdt/1.4:-rdt*2.4));state.hb.style.setProperty('--p',state.hp.toFixed(3));if(state.hp>=1&&state.dS&&state.dS.hold&&!state.dS.held){state.dS.held=true;state.holding=false;state.dS.onHold&&state.dS.onHold()}}
const age=t-state.wipeT;state.imp=age>=0&&age<1.9?(age<.8?Math.pow(age/.8,2):Math.max(0,1-(age-.8)/1.1)):0;
const dlgOpen=!!state.dS;
if(skyOnce||(!dlgOpen&&((!isMob&&oi<0)||t-skyT>=.032))){state.scene.drawSky(t);skyT=t;skyOnce=false}
if(!dlgOpen&&(state.avForm<1||!isMob||t-avT>=.032)){state.scene.drawAv(t,dt);avT=t}drawFx(t,dt);requestAnimationFrame(loop)}
cacheInk();state.scene.LKB();size();count();preview();stamp();state.settings.paintSettings(false);paintVersion();requestAnimationFrame(()=>{size()});if('ResizeObserver' in window){let _rz,_rw=stage.clientWidth;new ResizeObserver(()=>{const cw=stage.clientWidth;if(cw<=0||cw===_rw)return;_rw=cw;clearTimeout(_rz);_rz=setTimeout(size,80)}).observe(stage)}requestAnimationFrame(loop);document.fonts&&document.fonts.ready.then(size);
core.on('lang',()=>{preview();stamp();paintVersion();ebtn.textContent=editOpen?t('ui.cancel'):t('you.edit');state.settings.paintSettings(false);state.setState(0,{light:t('you.light'),dark:t('you.dark'),system:t('you.system')}[state.appearance]||t('you.dark'));if(state.dS&&state.dialog.repaintDlg)state.dialog.repaintDlg();nmDirty=true;srDirty=true;dyReady=false});
core.on('tilt',e=>{if(!e||!core.isCur(PGID)||oi>=0||state.dS)return;state.px=clamp(e.x,.04,.96);state.py=clamp(e.y,.04,.96);state.lastMove=state.now});
function resetView(){if(state.dS)state.dialog.closeDlg();clearTimeout(morphT);clearTimeout(closeT);clearTimeout(stHT);stage.classList.remove('morphing','has-open','ed-on');ed.classList.remove('open');
const wasEdit=editOpen;oi=-1;state.pm=0;lastPm=-1;editOpen=false;em=0;ex=0;lastEm=-1;
if(wasEdit){try{nin.blur()}catch(_){}nin.value=prof.name;count();preview();state.avSeed=prof.name?hash(prof.name):0;avDef=!prof.name}
ebtn.textContent=t('you.edit');const wH=(state.W/2).toFixed(1)+'px';
_ebL=wH;_ebOp='1.000';_ebPe='auto';ebtn.style.left=wH;ebtn.style.opacity='1';ebtn.style.pointerEvents='auto';
_sbL=wH;_sbOp='0.600';sbt.style.left=wH;sbt.style.opacity='0.6';
state.avS=104;state.avCX=state.W/2;state.avCY=70;
if(isMob){_avW='104px';_avTr=`translate3d(${(state.W/2-52).toFixed(1)}px,18.0px,0) scale(1.0000)`;av.style.width='104px';av.style.height='104px';av.style.transformOrigin='0 0';av.style.transform=_avTr}
else{_avW='104.0px';_avTr=`translate(${(state.W/2-52).toFixed(1)}px,18.0px)`;av.style.width=_avW;av.style.height=_avW;av.style.transform=_avTr}
if(nmDirty&&nm.offsetWidth>0){nm.style.fontSize='52px';nmRefW=nm.offsetWidth;nmRefFs=52;nmDirty=false}
const baseFs=isMob&&nmRefW>0&&nmRefW*1.04>state.W-36?52*(state.W-36)/(nmRefW*1.04):52;
_nmL=wH;_nmT='136.0px';_nmFs=baseFs.toFixed(1)+'px';_nmFw='800';_nmTr='translateX(-50.00%)'+(isMob?' scale(1.0000)':'');
nm.style.left=_nmL;nm.style.top=_nmT;nm.style.fontSize=_nmFs;nm.style.fontWeight='800';nm.style.transform=_nmTr;
sats.forEach(s=>{s.el.classList.remove('open','closing');s.face.inert=false;s.bd.inert=true;s.face.setAttribute('aria-expanded','false');s.fz=false;s.bd.style.transform='';const sc=s.bd.querySelector('.sc');if(sc)sc.scrollTop=0;const g=layout(s),st=s.el.style;s.ready=true;s.cx=g.cx;s.cy=g.cy;s.w=g.w;s.h=g.h;s.vx=s.vy=s.vw=s.vh=0;s.e=0;s.m=0;s._w=g.w+'px';s._h=g.h+'px';s._br=(Math.min(g.w,g.h)/2).toFixed(1)+'px';s._z='1';s._e='0.000';s._m='0.000';s._tr=`translate3d(${(g.cx-g.w/2).toFixed(1)}px,${(g.cy-g.h/2).toFixed(1)}px,0)`;st.width=s._w;st.height=s._h;st.borderRadius=s._br;st.zIndex='1';st.setProperty('--e','0');st.setProperty('--m','0');st.transform=s._tr});
if(isMob){stage.style.height=H0+'px';_stH=H0+'px'}
state.scrollY=0;lsy=0;srDirty=true;state.sr=stage.getBoundingClientRect();state.scene.drawSky(state.now);state.scene.drawAv(state.now,0);skyT=state.now;skyOnce=false}

return {size,cacheInk,setSY:v=>{state.scrollY=v;srDirty=true},wave,resetView,refresh:()=>{syncDB();stamp();preview();state.ST=core.api.settings().data;state.settings.paintSettings(false);paintVersion();al.setAttribute('aria-checked',core.api.auth.state().persistent);srDirty=true}};}
