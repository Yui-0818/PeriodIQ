/* ===== app.js =====
 * 1 角色：事件总线与 commit、页面注册/懒启动/运行暂停、dock/tab、过渡动画 nav、主题切换。
 * 2 依赖：state.js（CYC/JOURNAL/profile/recompute/adopt/TODAY）、fx.js（fxAdd/readInk）；加载时读取 #dock/.tb/.pill（脚本位于 body 末尾）。
 * 3 暴露：pages,byId,cur,trans,ev,on,emit,dock,tabs,pill,badge,commit,resetData,register,boot,runFrame,raf,setRun,isCur,setDock,nav,wave,warpToDate,setTheme（顶层，不挂 window）。
 * 4 不变量：commit 是模型重建唯一入口；nav 同时只允许一个 trans；页面懒启动（boot 只一次）；badge/aria-current 规则不变。
 * 5 契约来源：无（页面生命周期/过渡基础设施）；对外键集由 core.js 的 const core 定义。
 * 6 禁止改动项：1050/60/1150/1300/900/1000/1500/1250 等任何时长、缓动串、选择器、DOM 查询、事件名、aria 语义。
 */
// ================= tiny event bus + commit =================
const pages=[],byId={};let cur=0,trans=null;const ev={};
const on=(n,f)=>(ev[n]||(ev[n]=[])).push(f),emit=(n,a)=>(ev[n]||[]).forEach(f=>f(a));
const dock=document.getElementById('dock'),tabs=[...dock.querySelectorAll('.tb')],pill=dock.querySelector('.pill');
const badge=(i,v)=>tabs[i]&&(v?tabs[i].setAttribute('data-new',''):tabs[i].removeAttribute('data-new'));
const commit = function commit(src){if(src!=='cal'&&src!=='today'&&src!=='api')adopt();recompute();pages.forEach((p,i)=>{if(p.id!==src){p.dirty=true;if(i!==cur&&p.id!=='you'&&p.id!=='cal')badge(i,true)}});emit('model',{src})};
const resetData = function resetData(){if(resetHook)resetHook();for(const k in JOURNAL)delete JOURNAL[k];juid=1;profile.name='';recompute();pages.forEach(p=>{if(p.id!=='you')p.dirty=true});[0,2,3].forEach(i=>badge(i,true));emit('profile')};
// ================= pages: lazy boot, run/pause, scrolling, staggered prewarm =================
let pwTm=0,lastW=innerWidth,imeHost=false,imeFocus=false,imeNative=false;
const syncIme=()=>document.body.classList.toggle('piq-ime',imeNative?imeHost:(imeHost||imeFocus));
window.__piqIme=on=>{const was=imeHost;imeNative=true;imeHost=!!on;
if(was&&!imeHost){imeFocus=false;if(isTxt(document.activeElement))try{document.activeElement.blur()}catch(_){}
requestAnimationFrame(()=>requestAnimationFrame(()=>{const maxY=Math.max(0,document.documentElement.scrollHeight-innerHeight);if(window.scrollY>maxY)window.scrollTo(0,maxY)}))}
syncIme()};
const isTxt=el=>!!el&&(el.tagName==='TEXTAREA'||el.isContentEditable||(el.tagName==='INPUT'&&!/^(button|checkbox|radio|submit|reset|file|range|color|image|hidden)$/i.test(el.type)));
document.addEventListener('focusin',e=>{if(isTxt(e.target)){imeFocus=true;syncIme()}});
document.addEventListener('focusout',()=>setTimeout(()=>{imeFocus=isTxt(document.activeElement);syncIme()},60));
const canPrewarm=()=>{if(document.hidden||trans||document.documentElement.classList.contains('piq-boot'))return false;const g=document.getElementById('pg-auth');return!(g&&g.classList.contains('x-on'))};
const schedulePrewarm=(delay=400)=>{clearTimeout(pwTm);pwTm=setTimeout(()=>{const idle=window.requestIdleCallback?cb=>requestIdleCallback(cb,{timeout:300}):cb=>setTimeout(cb,16);
const step=()=>{if(!canPrewarm()){if(pages.some(p=>!p.booted))schedulePrewarm(450);return}
const p=pages.find(q=>!q.booted);if(!p)return;
const prev={disp:p.el.style.display,vis:p.el.style.position,pe:p.el.style.pointerEvents,z:p.el.style.zIndex,v:p.el.style.visibility};
p.el.style.visibility='hidden';p.el.style.position='fixed';p.el.style.inset='0';p.el.style.pointerEvents='none';p.el.style.zIndex='-1';p.el.style.display='block';
try{boot(p);p.api&&p.api.size&&p.api.size();p._visSized=false;p._sw=0;p._sh=0}finally{setRun(p,false);p.el.style.display=prev.disp;p.el.style.visibility=prev.v;p.el.style.position=prev.vis;p.el.style.inset='';p.el.style.pointerEvents=prev.pe;p.el.style.zIndex=prev.z}
if(pages.some(q=>!q.booted))pwTm=setTimeout(()=>idle(step),180)};
idle(step)},delay)};
on('auth',a=>{if(a&&a.authed)schedulePrewarm(400)});on('model',()=>schedulePrewarm(400));
window.__piqTilt=function(x,y){if(!reduce&&!document.hidden)emit('tilt',{x,y})};
const register = function register(defs){defs.forEach((d,i)=>{const el=document.getElementById('pg-'+d.id),p={id:d.id,el,pgi:el.querySelector('.pgi'),factory:d.factory,scroll:0,run:false,pend:[],booted:false,dirty:false,_needsReset:false,api:null,_visSized:false,_sw:0,_sh:0};pages.push(p);byId[d.id]=p});
pages[0].el.classList.add('cur');boot(pages[0]);pages[0]._needsReset=true;pages[0]._sw=innerWidth;pages[0]._sh=innerHeight;pages[0]._visSized=pages[0].el.offsetWidth>0&&pages[0].el.offsetHeight>0;tabs.forEach((b,i)=>b.addEventListener('click',()=>{const r=b.getBoundingClientRect();nav(i,{origin:{x:r.left+r.width/2,y:r.top+r.height/2}})}));
addEventListener('scroll',()=>{const p=pages[cur];if(p&&p.api&&!trans)p.api.setSY(window.scrollY)},{passive:true});addEventListener('resize',()=>{if((imeHost||imeFocus)&&innerWidth===lastW)return;lastW=innerWidth;pages.forEach(p=>{p._visSized=false;p._sw=0;p._sh=0});const p=pages[cur];if(p&&p.api&&p.api.size){p.api.size();p._sw=innerWidth;p._sh=innerHeight;p._visSized=p.el.offsetWidth>0&&p.el.offsetHeight>0}});
schedulePrewarm(400)};
const boot = function boot(p){p.run=true;p.api=p.factory(core,p.el);p.booted=true};
const runFrame=(p,f)=>requestAnimationFrame(ts=>{if(p.run&&!document.hidden)f(ts);else p.pend.push(f)}),
raf=(id,f)=>{const p=byId[id];if(!p)return;if(p.run&&!document.hidden)runFrame(p,f);else p.pend.push(f)},
setRun=(p,on)=>{p.run=on;if(on&&!document.hidden&&p.pend.length){const q=p.pend.splice(0);q.forEach(f=>runFrame(p,f))}},isCur=id=>pages[cur]&&pages[cur].id===id;
document.addEventListener('visibilitychange',()=>{const p=pages[cur];if(!p||!p.booted)return;if(document.hidden){if(trans)trans.finish();setRun(p,false)}else setRun(p,true)});
const setDock = function setDock(to){dock.style.setProperty('--i',to);tabs.forEach((b,i)=>i===to?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current'));pill.classList.remove('mv');if(!reduce)requestAnimationFrame(()=>pill.classList.add('mv'))};
// ================= the transition: a liquid bloom from the touched point, the old world recedes =================
const nav = function nav(to,opt={}){if(trans)trans.finish();
if(to===cur){window.scrollTo({top:0,behavior:reduce?'auto':'smooth'});const r=tabs[to].getBoundingClientRect();wave(r.left+r.width/2,r.top+10);buzz(5);return}
if(isTxt(document.activeElement))try{document.activeElement.blur()}catch(_){}
const out=pages[cur],inn=pages[to],mob=!document.body.classList.contains('piq-shell'),o=opt.origin||(()=>{const r=tabs[to].getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})();
out.scroll=window.scrollY;inn.scroll=0;
setRun(out,false);
out.api.setSY(out.scroll);out.pgi.style.transform=`translate3d(0,${-out.scroll}px,0)`;out.el.classList.remove('cur');out.el.classList.add('leaving');
inn.el.classList.add('entering');inn.pgi.style.transform='';if(mob&&!reduce)inn.el.style.opacity='0';
if(!inn.booted){boot(inn);inn._visSized=false}else setRun(inn,true);
if(opt.date==null&&inn._needsReset&&inn.api&&inn.api.resetView){inn.api.resetView();inn._needsReset=false}
if(!inn._visSized||inn._sw!==innerWidth||inn._sh!==innerHeight){inn.api.size();if(inn.el.offsetWidth>0&&inn.el.offsetHeight>0){inn._visSized=true;inn._sw=innerWidth;inn._sh=innerHeight}}inn.api.setSY(0);if(inn.dirty){inn.dirty=false;inn.api.refresh()}
let tg=null;if(opt.date!=null&&inn.api.focusDate){inn.api.focusDate(opt.date);tg=inn.api.cellCenter&&inn.api.cellCenter(opt.date)}
cur=to;setDock(to);badge(to,false);document.body.classList.add('busy');
const D=reduce?1:(mob?440:560),S1=-inn.scroll,S0=-out.scroll;let done=false,rafId=0,anims=[];
const startAnims=()=>{if(done)return;
if(mob){setRun(inn,false);const E_IN='cubic-bezier(.22,1,.36,1)',E_OUT='cubic-bezier(.4,0,.2,1)';
anims=[inn.el.animate([{opacity:0},{opacity:1}],{duration:D,easing:E_IN,fill:'both'}),
inn.pgi.animate([{transform:`translate3d(6%,${S1}px,0) scale(1.03)`},{transform:`translate3d(0,${S1}px,0) scale(1)`}],{duration:D,easing:E_IN,fill:'both'}),
out.pgi.animate([{transform:`translate3d(0,${S0}px,0) scale(1)`,opacity:1},{transform:`translate3d(-6%,${S0}px,0) scale(.97)`,opacity:0}],{duration:reduce?1:360,easing:E_OUT,fill:'both'})];
anims[0].onfinish=finish;
inn.el.style.opacity='';
fxAdd({type:'warp',x:o.x,y:o.y,dur:680});fxAdd({type:'ring',x:o.x,y:o.y,dur:760});fxAdd({type:'bloom',x:o.x,y:o.y,dur:620});
if(tg)fxAdd({type:'orb',from:o,to:tg,dur:680,done:()=>{inn.api.selectDay&&inn.api.selectDay(opt.date);fxAdd({type:'ring',x:tg.x,y:tg.y,dur:620});wave(tg.x,tg.y)}})}
else{const EASE='cubic-bezier(.2,.8,.15,1)',R=Math.hypot(Math.max(o.x,innerWidth-o.x),Math.max(o.y,innerHeight-o.y))+80;
anims=[inn.el.animate([{clipPath:`circle(0px at ${o.x}px ${o.y}px)`},{clipPath:`circle(${R}px at ${o.x}px ${o.y}px)`}],{duration:D,easing:EASE,fill:'both'}),
inn.pgi.animate([{transform:`translate3d(8%,${S1}px,0) scale(1.08)`,opacity:0},{transform:`translate3d(0,${S1}px,0) scale(1)`,opacity:1}],{duration:D*.92,easing:EASE,fill:'both'}),
out.pgi.animate([{transform:`translate3d(0,${S0}px,0) scale(1)`,opacity:1},{transform:`translate3d(-10%,${S0}px,0) scale(.9)`,opacity:0}],{duration:D*.78,easing:'cubic-bezier(.5,0,.3,1)',fill:'both'})];
fxAdd({type:'warp',x:o.x,y:o.y,dur:650});fxAdd({type:'ring',x:o.x,y:o.y,dur:720});fxAdd({type:'bloom',x:o.x,y:o.y,dur:600});
if(tg)fxAdd({type:'orb',from:o,to:tg,dur:650,done:()=>{inn.api.selectDay&&inn.api.selectDay(opt.date);fxAdd({type:'ring',x:tg.x,y:tg.y,dur:600});wave(tg.x,tg.y)}})}
wave(o.x,o.y);buzz(8)};
if(mob&&!reduce)rafId=requestAnimationFrame(()=>{rafId=0;startAnims()});else startAnims();
const finish=()=>{if(done)return;done=true;clearTimeout(tm);if(rafId)cancelAnimationFrame(rafId);anims.forEach(a=>{try{a.onfinish=null;a.cancel()}catch(_){}});setRun(out,false);out.pgi.style.transform='';out.el.classList.remove('leaving');out.scroll=0;
inn.el.classList.remove('entering');inn.el.classList.add('cur');inn.el.style.opacity='';inn.pgi.style.transform='';inn._needsReset=true;window.scrollTo(0,inn.scroll);setRun(inn,true);inn.api.setSY(window.scrollY);document.body.classList.remove('busy');trans=null;
setTimeout(()=>{if(!isCur(out.id)&&out._needsReset&&out.api&&out.api.resetView){out.api.resetView();out._needsReset=false}},180)};
const tm=setTimeout(finish,D+80);trans={finish}};
const wave=(x,y)=>pages.forEach(p=>p.booted&&p.api&&p.api.wave&&p.api.wave(x,y));
// shared element: a day star on Today becomes that day on Calendar
const warpToDate=(n,origin)=>nav(1,{origin,date:n});
// ================= theme: one switch for the whole universe =================
const setTheme = function setTheme(dark,x,y){const t=dark?'dark':'light';if(root.dataset.theme===t)return;
const mob=!document.body.classList.contains('piq-shell');
const ap=()=>{root.dataset.theme=t;readInk();pages.forEach(p=>p.booted&&p.api.cacheInk&&p.api.cacheInk())};
fxAdd({type:'ring',x,y,dur:mob?1050:1500});fxAdd({type:'warp',x,y,dur:mob?860:1100});wave(x,y);
if(!document.startViewTransition||reduce){ap();return}
const R=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y))+60,vt=document.startViewTransition(ap);
vt.ready.then(()=>root.animate({clipPath:[`circle(0px at ${x}px ${y}px)`,`circle(${R}px at ${x}px ${y}px)`]},{duration:mob?920:1250,easing:'cubic-bezier(.2,.8,.15,1)',pseudoElement:'::view-transition-new(root)'}))};
// ================= hardware back: close the topmost layer, never quit under an open sheet =================
// The Android host (MainActivity.onBackPressed) evaluates window.__piqHandleBack() before it falls
// back to WebView history / Activity exit: `true` = a layer was closed and the app stays, `false` =
// nothing is open (the host may then exit). Layers are read from the DOM so every page keeps its
// existing ownership of state; no page-level history routing is introduced.
(function(){
const click=el=>{if(!el)return false;el.click();return true};
function topLayer(){
// 0) Auth gate: while Create account is open, BACK returns to Sign in instead of leaving the app
const gate=document.getElementById('pg-auth');
if(gate&&gate.classList.contains('x-on')&&gate.classList.contains('x-reg')){
if(typeof boot_auth==='function'&&boot_auth.ctl){boot_auth.ctl.setMode('login');return true}
return click(document.getElementById('x-sw'))}
// 1) event-horizon dialog (keep signed in / change password / delete account / import overwrite)
const dlg=document.querySelector('#pg-you.cur #dlg.on');
if(dlg)return click(document.getElementById('dno'));
// 2) Calendar period-delete confirmation (Cancel keeps the data)
const cf=document.querySelector('#pg-cal.cur #cf:not([hidden])');
if(cf)return click(document.getElementById('cfno'));
// 3) Journal is the sixth page: back returns to Calendar (same as its #jback button)
if(document.querySelector('#pg-journal.cur'))return click(document.getElementById('jback'));
// 4) Calendar day sheet
if(document.querySelector('#pg-cal.cur #dpw.open'))return click(document.getElementById('dx'));
// 5) You zone sheets (Appearance / Notifications / Data / Privacy / About)
const zone=document.querySelector('#pg-you.cur .sat.open');
if(zone){
// 5a) Data import owns Format -> File -> Confirm steps: step back before closing the sheet
const imp=document.getElementById('imp'),ipa=document.getElementById('ipa');
if(imp&&ipa&&ipa.classList.contains('on'))return click(document.getElementById('imp-x2'));
if(imp&&imp.dataset.st==='2')return click(document.getElementById('imp-back'));
if(imp&&imp.dataset.st==='1')return click(document.getElementById('imp-x1'));
return click(zone.querySelector('.bh .x'));
}
// 6) Edit Profile panel (Cancel keeps the saved nickname; the app is never exited from here)
const ebtn=document.getElementById('ebtn');
if(ebtn&&ebtn.textContent.trim()==='Cancel')return click(ebtn);
return false;
}
window.__piqHandleBack=function(){try{return topLayer()}catch(_){return false}};
})();
// System 模式跟随系统明暗：Activity 自己消化 uiMode 配置变化（AndroidManifest configChanges），
// WebView 不会重算 prefers-color-scheme，故由宿主 onConfigurationChanged 派发该事件。
// 异步到达也无妨：只有当前选择是 System 时才换主题，其它模式不受系统切换影响。
document.addEventListener('piq-system-theme',e=>{const d=!!(e.detail&&e.detail.dark);window.__piqSystemDark=d;
if(window.__piqThemeMode==='system')setTheme(d,innerWidth/2,innerHeight/2)});
