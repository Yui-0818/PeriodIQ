/* ===== app.js =====
 * 1 角色：事件总线与 commit、页面注册/懒启动/运行暂停、dock/tab、过渡动画 nav、主题切换。
 * 2 依赖：state.js（CYC/JOURNAL/profile/recompute/adopt/TODAY）、fx.js（fxAdd/readInk）；加载时读取 #dock/.tb/.pill（脚本位于 body 末尾）。
 * 3 暴露：pages,byId,cur,trans,ev,on,emit,dock,tabs,pill,badge,commit,resetData,register,boot,runFrame,raf,setRun,isCur,setDock,nav,wave,warpToDate,setTheme（顶层，不挂 window）。
 * 4 不变量：commit 是模型重建唯一入口；nav 同时只允许一个 trans；页面懒启动（boot 只一次）；badge/aria-current 规则不变。
 * 5 契约来源：无（页面生命周期/过渡基础设施）；对外键集由 core.js 的 const core 定义。
 * 6 禁止改动项：1050/60/1150/1300/900/1000/1500/1250 等任何时长、缓动串、选择器、DOM 查询、事件名、aria 语义。
 * 迁自：前端demo/app拆解版@1cd5082 js/core.js 第 129–135、157–195 行
 */
// ================= tiny event bus + commit =================
const pages=[],byId={};let cur=0,trans=null;const ev={};
const on=(n,f)=>(ev[n]||(ev[n]=[])).push(f),emit=(n,a)=>(ev[n]||[]).forEach(f=>f(a));
const dock=document.getElementById('dock'),tabs=[...dock.querySelectorAll('.tb')],pill=dock.querySelector('.pill');
const badge=(i,v)=>tabs[i]&&(v?tabs[i].setAttribute('data-new',''):tabs[i].removeAttribute('data-new'));
const commit = function commit(src){if(src!=='cal'&&src!=='today'&&src!=='api')adopt();recompute();pages.forEach((p,i)=>{if(p.id!==src){p.dirty=true;if(i!==cur&&p.id!=='you'&&p.id!=='cal')badge(i,true)}});emit('model',{src})};
const resetData = function resetData(){if(resetHook)resetHook();for(const k in JOURNAL)delete JOURNAL[k];juid=1;profile.name='';recompute();pages.forEach(p=>{if(p.id!=='you')p.dirty=true});[0,2,3].forEach(i=>badge(i,true));emit('profile')};
// ================= pages: lazy boot, run/pause, scrolling =================
const register = function register(defs){defs.forEach((d,i)=>{const el=document.getElementById('pg-'+d.id),p={id:d.id,el,pgi:el.querySelector('.pgi'),factory:d.factory,scroll:0,run:false,pend:[],booted:false,dirty:false,api:null};pages.push(p);byId[d.id]=p});
pages[0].el.classList.add('cur');boot(pages[0]);tabs.forEach((b,i)=>b.addEventListener('click',()=>{const r=b.getBoundingClientRect();nav(i,{origin:{x:r.left+r.width/2,y:r.top+r.height/2}})}));
addEventListener('scroll',()=>{const p=pages[cur];if(p&&p.api&&!trans)p.api.setSY(window.scrollY)},{passive:true});addEventListener('resize',()=>{const p=pages[cur];p&&p.api&&p.api.size&&p.api.size()})};
const boot = function boot(p){p.run=true;p.api=p.factory(core,p.el);p.booted=true};
const runFrame=(p,f)=>requestAnimationFrame(ts=>{if(p.run)f(ts);else p.pend.push(f)}),
raf=(id,f)=>{const p=byId[id];if(!p)return;if(p.run)runFrame(p,f);else p.pend.push(f)},
setRun=(p,on)=>{p.run=on;if(on&&p.pend.length){const q=p.pend.splice(0);q.forEach(f=>runFrame(p,f))}},isCur=id=>pages[cur]&&pages[cur].id===id;
const setDock = function setDock(to){dock.style.setProperty('--i',to);tabs.forEach((b,i)=>i===to?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current'));pill.classList.remove('mv');void pill.offsetWidth;pill.classList.add('mv')};
// ================= the transition: a liquid bloom from the touched point, the old world recedes =================
const nav = function nav(to,opt={}){if(trans)trans.finish();
if(to===cur){window.scrollTo({top:0,behavior:reduce?'auto':'smooth'});const r=tabs[to].getBoundingClientRect();wave(r.left+r.width/2,r.top+10);buzz(5);return}
const out=pages[cur],inn=pages[to],o=opt.origin||(()=>{const r=tabs[to].getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})();
out.scroll=window.scrollY;if(opt.date!=null)inn.scroll=0;
out.api.setSY(out.scroll);out.pgi.style.transform=`translate3d(0,${-out.scroll}px,0)`;out.el.classList.remove('cur');out.el.classList.add('leaving');
inn.el.classList.add('entering');inn.pgi.style.transform=`translate3d(0,${-inn.scroll}px,0)`;
if(!inn.booted)boot(inn);else setRun(inn,true);
inn.api.size();inn.api.setSY(inn.scroll);if(inn.dirty){inn.dirty=false;inn.api.refresh()}
let tg=null;if(opt.date!=null&&inn.api.focusDate){inn.api.focusDate(opt.date);tg=inn.api.cellCenter&&inn.api.cellCenter(opt.date)}
cur=to;setDock(to);badge(to,false);document.body.classList.add('busy');
const D=reduce?1:1050,EASE='cubic-bezier(.2,.8,.15,1)',R=Math.hypot(Math.max(o.x,innerWidth-o.x),Math.max(o.y,innerHeight-o.y))+80,S1=-inn.scroll,S0=-out.scroll;
const a1=inn.el.animate([{clipPath:`circle(0px at ${o.x}px ${o.y}px)`},{clipPath:`circle(${R}px at ${o.x}px ${o.y}px)`}],{duration:D,easing:EASE,fill:'both'}),
a2=inn.pgi.animate([{transform:`translate3d(8%,${S1}px,0) scale(1.08)`,opacity:0,filter:'blur(14px)'},{transform:`translate3d(0,${S1}px,0) scale(1)`,opacity:1,filter:'blur(0px)'}],{duration:D*.92,easing:EASE,fill:'both'}),
a3=out.pgi.animate([{transform:`translate3d(0,${S0}px,0) scale(1)`,opacity:1,filter:'blur(0px)'},{transform:`translate3d(-10%,${S0}px,0) scale(.9)`,opacity:0,filter:'blur(16px)'}],{duration:D*.78,easing:'cubic-bezier(.5,0,.3,1)',fill:'both'});
fxAdd({type:'warp',x:o.x,y:o.y,dur:1150});fxAdd({type:'ring',x:o.x,y:o.y,dur:1300});fxAdd({type:'bloom',x:o.x,y:o.y,dur:900});wave(o.x,o.y);buzz(8);
if(tg)fxAdd({type:'orb',from:o,to:tg,dur:1000,done:()=>{inn.api.selectDay&&inn.api.selectDay(opt.date);fxAdd({type:'ring',x:tg.x,y:tg.y,dur:900});wave(tg.x,tg.y)}});
let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(tm);[a1,a2,a3].forEach(a=>{try{a.cancel()}catch(_){}});setRun(out,false);out.pgi.style.transform='';out.el.classList.remove('leaving');
inn.el.classList.remove('entering');inn.el.classList.add('cur');inn.pgi.style.transform='';window.scrollTo(0,inn.scroll);inn.api.setSY(window.scrollY);document.body.classList.remove('busy');trans=null};
const tm=setTimeout(finish,D+60);trans={finish}};
const wave=(x,y)=>pages.forEach(p=>p.booted&&p.api&&p.api.wave&&p.api.wave(x,y));
// shared element: a day star on Today becomes that day on Calendar
const warpToDate=(n,origin)=>nav(1,{origin,date:n});
// ================= theme: one switch for the whole universe =================
const setTheme = function setTheme(dark,x,y){const t=dark?'dark':'light';if(root.dataset.theme===t)return;
const ap=()=>{root.dataset.theme=t;readInk();pages.forEach(p=>p.booted&&p.api.cacheInk&&p.api.cacheInk())};
fxAdd({type:'ring',x,y,dur:1500});fxAdd({type:'warp',x,y,dur:1100});wave(x,y);
if(!document.startViewTransition||reduce){ap();return}
const R=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y))+60,vt=document.startViewTransition(ap);
vt.ready.then(()=>root.animate({clipPath:[`circle(0px at ${x}px ${y}px)`,`circle(${R}px at ${x}px ${y}px)`]},{duration:1250,easing:'cubic-bezier(.2,.8,.15,1)',pseudoElement:'::view-transition-new(root)'}))};
