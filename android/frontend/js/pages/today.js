/* ------------------------------------------------------------------
   1 角色：Today 页装配与主循环（旧 today.js 的主体）
   2 依赖：core（core.m/core.fx/core.raf 等）、PG 页容器、TodayRing（today.ring.js）。
   3 暴露：boot_today(core,PG)，返回 {size,cacheInk,setSY,wave,refresh}（签名与成员不变）。
   4 不变量：页面 DOM 契约、动画时长/缓动、面包屑与卡片文案、事件绑定顺序保持不变；共享状态经 state 传给 helper。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/today.js 行为为唯一基线。
     契约引用：frontend/CONTEXT.md §4 状态/API（只读 core.m，零 core.api 调用，hsub 的 [data-layer] 行原样保留，TodayRing 调用签名不变）。
     改动摘要（B1）：无预测窗口时首卡整体隐藏（折叠后 display:none）；预测日=今日时状态保留（Period expected today + x-now）；
     环顶标题/副标题/卡片副标题/ARIA 文本全部取自数据；日期片段加 x-nb 防孤行。
     打磨：切换按钮与 chip 选择在触点处触发引力涟漪（reduced-motion 下不触发）。
   6 禁止改动项：不得改选择器/class/文案/aria/时长/缓动/分支顺序；不得新增依赖或挂 window；不得合并/拆分函数体。
   迁自：demo@1cd5082 js/pages/today.js 第 1–178 行
   ------------------------------------------------------------------ */

function boot_today(core,PG){const PGID='today';
const $=s=>PG.querySelector(s)||core.dummy(),$$=s=>[...PG.querySelectorAll(s)],root=document.documentElement;
const requestAnimationFrame=f=>core.raf(PGID,f);
const addEventListener=(t,f,o)=>{window.addEventListener(t,e=>{if(core.isCur(PGID))f(e)},o)};

const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,
rnd=(i,k=1)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)},
dt=(d,o={weekday:'short',month:'short',day:'numeric'})=>core.m.fmt(CS+d-1,o);
// nb keeps a date token on one line; plain strips markup for ARIA; nextWin = first predicted window that starts today or later (never the cycle already running)
const nb=s=>`<span class="x-nb">${s}</span>`,plain=h=>String(h).replace(/<[^>]*>/g,''),
nextWin=T=>{const c=T.CYC.filter(q=>q.s<=T.TODAY).pop()||null;return T.seg.pred.find(w=>w.s>=T.TODAY&&(!c||w.s>c.s))||null};
let PER=5,CS=0,HAS=false,ONG=false,NW=null,first=true,pCS=null,pCL=null,tt=0;let mode=0,v=0,focus=null,px=.5,py=.35,lastMove=-9,last=0;
const state={TODAY:14,CL:28,NEXT:false,rips:[],sparks:[],m:0,sel:14,cur:14,warp:0,wdir:1,pulse:0,intro:0,spx:.5,spy:.35,dustP:0,ink:'255,255,255',G:{},dpr:1,W:0,H:0,SW:0,SH:0,scrollY:0};
// segments the service can provide; each one lights up / goes out on the orbit on its own. a,b = animated day range, ta,tb = targets, W = ranges for the multi-window one
const KEYS=['period','fert','ov','pred','lc'],CD={period:['Period','m0'],fert:['Fertile','m2'],ov:['Ovulation','m4'],pred:['Predicted','m3'],lc:['Less certain','m1']},SG={},fxS={},fxq=[],cw=$('#chips');
KEYS.forEach(k=>{SG[k]={on:false,lit:0,kick:0,a:1,b:1,ta:1,tb:1,W:[]};fxS[k]=1});
const cacheInk=()=>state.ink=getComputedStyle(root).getPropertyValue('--ink').trim();
function roll(el,html,dir=1){if(el._h===html)return;el._h=html;
const now=performance.now(),had=el.children.length>0,n=document.createElement('span');n.className='r';n.innerHTML=html;n._t=now;
// every previous child leaves the layout flow at once (position:absolute) and is guaranteed to be removed
[...el.children].forEach(o=>{
if(o.classList.contains('out')||reduce){o.remove();return}
const young=now-(o._t||0)<260;o.classList.add('out');o.setAttribute('aria-hidden','true');o.getAnimations().forEach(a=>a.cancel());
let done=0;const kill=()=>{if(!done){done=1;o.remove()}},du=young?140:520;
o.animate([{transform:'none',opacity:1,filter:'blur(0)'},{transform:`translateY(${-dir*38}%) scale(.9)`,opacity:0,filter:'blur(9px)'}],{duration:du,easing:'cubic-bezier(.5,0,.2,1)',fill:'forwards'}).onfinish=kill;
setTimeout(kill,du+120)});
el.append(n);
if(had&&!reduce)n.animate([{transform:`translateY(${dir*38}%) scale(1.1)`,opacity:0,filter:'blur(12px)'},{transform:'none',opacity:1,filter:'blur(0)'}],{duration:760,easing:'cubic-bezier(.2,.9,.1,1)'})}
const fmtR=(s,e)=>core.m.fmt(s,{month:'short',day:'numeric'})+(e>s?'–'+core.m.fmt(e,{day:'numeric'}):''),inT=(k,d)=>{const g=SG[k];return g.on&&(k=='lc'?g.W.some(w=>d>=w[0]&&d<=w[1]):d>=g.ta&&d<=g.tb)};
function info(){const d=state.sel,n=state.CL+1-d,pre=d==state.TODAY?'':nb(dt(d))+' · ',pw=NW,win=pw?nb(fmtR(pw.s,pw.e)):'';
if(mode){if(!state.NEXT)return['No prediction yet','The service has no upcoming period window to show'];return[n<1?(d==state.TODAY?'Period expected today':'Predicted period start'):n==1?'Period tomorrow':`Period in ${n} days`,`Estimated window ${win} · it may drift`]}
if(!HAS)return['Your sky is quiet','Mark a period start in Calendar to begin an orbit'];
if(state.NEXT&&d>state.CL)return[d==state.TODAY?'Period expected today':'Predicted period start',pre+`Estimated window ${win} · it may drift`];
if(inT('period',d))return[`Period, day ${d}`,pre+(d==state.TODAY&&ONG?'Ongoing · recorded in Calendar':'Recorded in Calendar')];
if(inT('ov',d))return[d==state.TODAY?'Peak fertility today':'Peak fertility',pre+'Ovulation day'];
if(inT('fert',d)){const o=SG.ov.on?SG.ov.ta:null,l=SG.fert.tb-d;return[d==state.TODAY?'Fertile window is open':'Fertile window',pre+(o&&o>d?`Ovulation in ${o-d} day${o-d>1?'s':''}`:l?`Window closes in ${l} day${l>1?'s':''}`:'Last day of the window')]}
if(inT('lc',d))return['Less certain days',pre+'The estimate is softer here'];
return[`Cycle day ${d}`,pre+(state.NEXT?`Next period estimated ${nb(fmtR(pw.s,pw.s))}`:'No prediction available yet')]}
// ARIA follows the same data as the visible label: title, subtitle, shown quantity, selected day
function aria(t,s){const q=mode?(state.NEXT?state.CL+1-state.sel:'unavailable'):state.sel,tp=$('#tap');
tp.setAttribute('aria-label',`${plain(t)}. ${plain(s)}. Showing ${mode?'days until next period':'cycle day'}: ${q}. Tap to switch.`);
[tp,$('#sw')].forEach(b=>b.setAttribute('aria-pressed',mode?'true':'false'));
stage.setAttribute('role','group');stage.setAttribute('aria-label',`Cycle ring, ${state.CL} days${state.NEXT?', next period '+fmtR(NW.s,NW.s):''}; day ${state.sel} selected`);
$('#home').setAttribute('aria-label',`Back to today, cycle day ${state.TODAY}`)}
function render(dir=1){const[t,s]=info();roll($('#ttl'),t,dir);roll($('#sub'),s,dir);roll($('#nw'),String(mode?(state.NEXT?state.CL+1-state.sel:'—'):state.sel),dir);$('#home').classList.toggle('on',state.sel!=state.TODAY);aria(t,s)}
function ticks(){$$('#tk .t:not(.z)').forEach((t,i)=>{t.style.transitionDelay=(mode?i*24:(13-i)*14)+'ms';t.classList.toggle('on',!!mode)})}
function toggle(){mode^=1;if(!reduce){state.warp=1;state.wdir=mode?1:-1}state.pulse=1;const b=$('#tap').getBoundingClientRect();ripple(b.left+b.width/2,b.top+b.height/2);render(mode?1:-1);ticks();core.buzz(10)}
$('#tap').onclick=toggle;$('#sw').onclick=toggle;$('#tap').onpointerdown=e=>e.stopPropagation();
$('#home').onclick=()=>{state.sel=state.TODAY;render(-1)};
// ---- phase chips: one per segment the service actually provided. FLIP layout so the row re-flows smoothly when the count changes.
function chipSync(){const want=KEYS.filter(k=>SG[k].on),have=[...cw.querySelectorAll('.chip:not(.gone)')],was=new Map(have.map(b=>[b.dataset.k,b.getBoundingClientRect().left])),Tm=reduce?1:760,EZ='cubic-bezier(.2,.9,.1,1)';
if(focus!=null&&!want.includes(focus))focus=null;
have.forEach(b=>{if(want.includes(b.dataset.k))return;b.classList.add('gone');b.style.left=b.offsetLeft+'px';b.style.top=b.offsetTop+'px';b.setAttribute('aria-hidden','true');b.tabIndex=-1;b.animate([{opacity:1,transform:'none',filter:'blur(0)'},{opacity:0,transform:'scale(.55)',filter:'blur(9px)'}],{duration:reduce?1:520,easing:EZ,fill:'forwards'}).onfinish=()=>b.remove();setTimeout(()=>b.remove(),800)});
const fresh=[];want.forEach(k=>{let b=cw.querySelector(`.chip[data-k="${k}"]:not(.gone)`);if(!b){b=document.createElement('button');b.className='chip glass';b.dataset.k=k;b.innerHTML=`<i class="mk ${CD[k][1]}"></i>${CD[k][0]}`;b.onclick=()=>{focus=focus==k?null:k;state.pulse=1;const r=b.getBoundingClientRect();ripple(r.left+r.width/2,r.top+r.height/2);$$('.chip:not(.gone)').forEach(x=>x.setAttribute('aria-pressed',focus==x.dataset.k))};fresh.push(b)}cw.append(b)});
$$('.chip:not(.gone)').forEach(b=>b.setAttribute('aria-pressed',focus==b.dataset.k));
if(reduce)return;have.forEach(b=>{if(b.classList.contains('gone'))return;const dx=was.get(b.dataset.k)-b.getBoundingClientRect().left;if(Math.abs(dx)>.5)b.animate([{transform:`translateX(${dx}px)`},{transform:'none'}],{duration:Tm,easing:EZ})});
fresh.forEach(b=>b.animate([{opacity:0,transform:'scale(.5)',filter:'blur(10px)'},{opacity:1,transform:'none',filter:'blur(0)'}],{duration:Tm,easing:EZ}))}
// ---- a segment appearing / vanishing is an event: ring + bloom on the arc, ripples through the starfield, embers when it goes out
const ripple=(x,y)=>reduce||state.rips.push({x,y,t:tt});
function fire(e){const g=SG[e.k],r=stage.getBoundingClientRect(),[a,b]=e.k=='lc'?(g.W[0]||[1,1]):[Math.round(g.ta),Math.round(g.tb)],q=state.G.pts&&(state.G.pts[Math.round((a+b)/2)]||state.G.pts[1]);if(!q)return;const x=r.left+q[0],y=r.top+q[1];ripple(x,y);core.fx({type:'ring',x,y,dur:e.re?800:1200});if(e.on&&!e.re)core.fx({type:'bloom',x,y,dur:900});
if(!e.on&&!reduce)for(let d=a;d<=b;d++){const p=state.G.pts[d];if(!p)continue;for(let j=0;j<3;j++)state.sparks.push({x:r.left+p[0],y:r.top+p[1],vx:(rnd(d*3+j,1)-.5)*30,vy:-14-rnd(d*3+j,2)*34,t:tt})}}
const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('in')),{threshold:.15});$$('.card').forEach(c=>io.observe(c));
// pointer
addEventListener('pointermove',e=>{px=e.clientX/innerWidth;py=e.clientY/innerHeight;lastMove=last});
// scrub the ring
let drag=false;const stage=$('#stage');
function scrub(e){const r=stage.getBoundingClientRect(),dx=e.clientX-r.left-state.G.cx,dy=e.clientY-r.top-state.G.cy,x=dx*state.G.cR+dy*state.G.sR,y=(-dx*state.G.sR+dy*state.G.cR)/state.G.cT,rr=Math.hypot(x,y)/state.G.R;
if(!drag){if(rr<.5||rr>1.55)return;drag=true;stage.setPointerCapture(e.pointerId)}
let d=Math.round(((Math.atan2(y,x)+Math.PI/2)/(2*Math.PI)+1)%1*state.CL+1);if(d>state.CL)d=1;if(d!=state.sel){state.sel=d;render(1);core.buzz(4)}}
let tp=null;
stage.onpointerdown=e=>{tp={x:e.clientX,y:e.clientY,t:performance.now(),mv:false};scrub(e)};
stage.onpointermove=e=>{if(tp&&Math.hypot(e.clientX-tp.x,e.clientY-tp.y)>9)tp.mv=true;drag&&scrub(e)};
stage.onpointerup=e=>{const was=drag;drag=false;if(tp&&was&&!tp.mv&&performance.now()-tp.t<450)warpDay(state.sel);tp=null};
stage.onpointercancel=()=>{drag=false;tp=null};
function warpDay(d){const r=stage.getBoundingClientRect(),q=state.G.pts&&state.G.pts[d];state.pulse=1;core.warpToDate(CS+d-1,{x:q?r.left+q[0]:r.left+r.width/2,y:q?r.top+q[1]:r.top+r.height/2})}
// canvases
const sky=$('#sky'),sc=sky.getContext('2d'),B=$('#back'),F=$('#front'),bc=B.getContext('2d'),fc=F.getContext('2d');
state.stage=stage;state.sc=sc;state.bc=bc;state.fc=fc;state.SG=SG;state.fxS=fxS;state.reduce=reduce;state.rnd=rnd;state.dt=dt;
const ring=TodayRing(core,PG,state);
function size(){state.dpr=Math.min(devicePixelRatio||1,2);state.SW=innerWidth;state.SH=innerHeight;sky.width=state.SW*state.dpr;sky.height=state.SH*state.dpr;const r=stage.getBoundingClientRect();state.W=r.width;state.H=r.height;for(const c of[B,F]){c.width=state.W*state.dpr;c.height=state.H*state.dpr}}
// main loop: one spring drives type, ring, sky and glass together
function loop(ts){const t=ts/1000,dt_=Math.min(.05,t-last||.016);last=t;
if(reduce){state.m=mode;v=0}else{v+=((mode-state.m)*130-v*14)*dt_;state.m+=v*dt_}
state.warp=Math.max(0,state.warp-dt_*1.7);state.pulse=Math.max(0,state.pulse-dt_*1.4);state.intro=reduce?1:state.intro+dt_*.55;
if(t-lastMove>2.5){px=.5+.3*Math.sin(t*.35);py=.4+.25*Math.cos(t*.27)}
state.spx+=(px-state.spx)*.07;state.spy+=(py-state.spy)*.07;state.cur+=(state.sel-state.cur)*(1-Math.exp(-dt_*10));
for(const k of KEYS)fxS[k]+=((focus==null?1:k==focus?1.6:.28)-fxS[k])*(1-Math.exp(-dt_*8));
tt=t;for(const k of KEYS){const g=SG[k],tgt=g.on?1:0;g.lit=reduce?tgt:g.lit+(tgt-g.lit)*(1-Math.exp(-dt_*(g.on?3.6:2.8)));g.kick=Math.max(0,g.kick-dt_*1.1);const e=1-Math.exp(-dt_*(reduce?60:7));g.a+=(g.ta-g.a)*e;g.b+=(g.tb-g.b)*e}
for(let i=fxq.length-1;i>=0;i--){fxq[i].w-=dt_;if(fxq[i].w<=0)fire(fxq.splice(i,1)[0])}
const mc=Math.min(1,Math.max(0,state.m));root.style.setProperty('--m',mc.toFixed(3));root.style.setProperty('--mo',state.m.toFixed(3));root.style.setProperty('--sq',(1+Math.min(.4,Math.abs(v)*.1)).toFixed(3));
$$('[data-u]').forEach(e=>e.style.setProperty('--k',mc.toFixed(3)));$$('[data-d]').forEach(e=>e.style.setProperty('--k',(1-mc).toFixed(3)));
const gx=state.spx*innerWidth,gy=state.spy*innerHeight;$$('.glass').forEach(e=>{const r=e.getBoundingClientRect();e.style.setProperty('--px',(gx-r.left).toFixed(0)+'px');e.style.setProperty('--py',(gy-r.top).toFixed(0)+'px');e.style.setProperty('--ang',(Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90).toFixed(0)+'deg')});
if(dm)dm.setAttribute('scale',(30+14*mc+16*state.warp).toFixed(1));
ring.drawSky(t);ring.drawRing(t,dt_);requestAnimationFrame(loop)}
// refractive lens: displacement map bends the starfield at the glass edges (Chromium; others keep blur + bevel)
let dm=core.dm();
cacheInk();size();bindModel();state.sel=state.cur=state.TODAY;render();bindCards();hsub();ticks();core.on('profile',hsub);core.on('model',e=>{if(e&&e.src==='api'&&core.isCur(PGID)){bindModel();state.sel=state.TODAY;render(1);bindCards();ticks()}});requestAnimationFrame(loop);
document.fonts&&document.fonts.ready.then(size);


function bindModel(){const T=core.m,S=T.seg,c=T.CYC.filter(q=>q.s<=T.TODAY).pop()||null,pw=nextWin(T);
HAS=!!c;CS=c?c.s:T.TODAY;state.TODAY=T.TODAY-CS+1;PER=c?T.endOf(c)-CS+1:0;ONG=!!c&&c.e==null;NW=pw;state.NEXT=!!pw&&HAS;state.CL=state.NEXT?pw.s-CS:Math.max(28,state.TODAY);
if(!first&&(pCS!==CS||pCL!==state.CL))state.intro=Math.min(state.intro,.3);pCS=CS;pCL=state.CL;
const clip=(s,e)=>{const a=Math.max(1,s-CS+1),b=Math.min(state.CL,e-CS+1);return a<=b?[a,b]:null},
nx={period:HAS?[1,PER]:null,fert:HAS&&S.fert?clip(S.fert.s,S.fert.e):null,ov:HAS&&S.ov!=null?clip(S.ov,S.ov):null,pred:state.NEXT?[state.CL+1,state.CL+1]:null,lc:HAS?S.lc.map(w=>clip(w.s,w.e)).filter(Boolean):[]};
KEYS.forEach(k=>{const g=SG[k],geo=nx[k],isOn=k=='lc'?geo.length>0:!!geo,was=g.on;
if(k=='lc'){if(isOn)g.W=geo}else if(isOn){if(!was){g.a=g.ta=geo[0];g.b=g.tb=geo[1]}else if(g.ta!==geo[0]||g.tb!==geo[1]){g.kick=1;if(!first)fxq.push({k,on:true,re:true,w:.35})}g.ta=geo[0];g.tb=geo[1]}
g.on=isOn;if(first)g.lit=isOn?1:0;else if(isOn!==was){g.kick=1;fxq.push({k,on:isOn,w:.38})}});
first=false;chipSync()}
function hsub(){const t=core.m.dOf(core.m.TODAY),w=t.toLocaleDateString('en-GB',{timeZone:'UTC',weekday:'short'}),md=t.toLocaleDateString('en-GB',{timeZone:'UTC',day:'numeric',month:'short'});$('#hsub').textContent=w+', '+md+(core.profile.name?' · '+core.profile.name:'')} // [data-layer] header date derives from TODAY
// a card with nothing to show collapses, then leaves the layout entirely (no empty shell, no gap); a card that has data comes back at full size
function bindCards(){const T=core.m,S=T.seg,tn=T.TODAY,md={month:'short',day:'numeric'},pw=nextWin(T),f=S.fert,o=S.ov,setCard=(el,on)=>{clearTimeout(el._z);el.classList.toggle('off',!on);on?el.removeAttribute('inert'):el.setAttribute('inert','');
if(on)el.style.display='';else if(!el._s||reduce)el.style.display='none';else el._z=setTimeout(()=>{el.style.display='none'},1000);el._s=1};
setCard($('#k1'),!!pw);$('#k1').classList.toggle('x-now',!!pw&&pw.s<=tn);
if(pw){const u=pw.s-tn,nT=Math.max(1,u),due=u<1,lbl=due?'Period expected today':`${u} day${u==1?'':'s'} until the next period`;$('#c1t').innerHTML=due?'Period expected today':'Next period lands '+nb(T.fmt(pw.s,{weekday:'long',month:'short',day:'numeric'}));$('#c1s').innerHTML=`Estimated window ${nb(fmtR(pw.s,pw.e))} · ${due?'due today':`${u} day${u==1?'':'s'} away`}`;$('#c1e').textContent=T.fmt(pw.s,md);$('#tk').innerHTML=Array.from({length:nT},(_,i)=>`<i class="t${i==nT-1?' z':''}"></i>`).join('');$('#tk').setAttribute('role','img');$('#tk').setAttribute('aria-label',lbl)}
setCard($('#k2'),!!f);
if(f){const n=f.e-f.s+1,ttl=tn<f.s?`Fertile window opens in ${f.s-tn} day${f.s-tn>1?'s':''}`:tn>f.e?'Fertile window has closed':o!=null&&tn==o?'Peak fertility today':tn==f.e?'Fertile window closes today':tn==f.e-1?'Fertile window closes tomorrow':'Fertile window is open';
$('#c2t').textContent=ttl;$('#c2s').innerHTML=nb(fmtR(f.s,f.e))+(o!=null?' · ovulation '+nb(T.fmt(o,md)):'')+(o!=null&&tn==o?' · chance is highest':'');
$('#fw').setAttribute('role','group');$('#fw').setAttribute('aria-label',ttl+'. '+$('#c2s').textContent);
$('#fw').style.setProperty('--n',n);$('#fw').innerHTML=Array.from({length:n},(_,i)=>{const d=f.s+i,cl=(d==tn?'ov':d<tn?'pa':'fu')+(d==o?' ovd':'');return `<div class="${cl}"><small>${T.fmt(d,{weekday:'narrow'})}</small><i>${T.dOf(d).getUTCDate()}</i></div>`}).join('')}
const st=T.M.starts,c=T.CYC.filter(q=>q.s<=tn).pop()||null;setCard($('#k3'),!!c);
if(c){const cd=tn-c.s+1,len=pw?pw.s-c.s:null,rows=[];for(let k=1;k<st.length;k++)rows.push([st[k-1],st[k]-st[k-1],0]);rows.splice(0,Math.max(0,rows.length-6));rows.push([c.s,len==null?cd:len,1]);
const ls=rows.filter(r=>!r[2]).map(r=>r[1]),all=ls.concat(len==null?[]:[len]);let av=28;
if(!all.length){$('#c3t').textContent='Your first cycle is still open';$('#c3s').textContent='One bar = one cycle · more appear as you record them'}
else{const mn=Math.min(...all),mx=Math.max(...all);av=Math.round(all.reduce((a,b)=>a+b,0)/all.length);$('#c3t').textContent=mx-mn<=2?`Your cycles hold steady near ${av} days`:`Your cycles vary from ${mn} to ${mx} days`;$('#c3s').textContent=`One bar = one cycle · dashed line = ${av}-day average`}
$('#hist').setAttribute('role','group');$('#hist').setAttribute('aria-label',$('#c3t').textContent+'. '+$('#c3s').textContent);
$('#hist').style.setProperty('--avg',all.length?(av/35*100).toFixed(1)+'%':'-10%');
$('#hist').innerHTML=rows.map(([s,n,cu],i)=>`<div class="row" style="--i:${i}"><span>${T.fmt(s,md)}</span><div class="trk"><div class="bar">${cu?(pw?`<u style="width:${n/35*100}%"></u>`:'')+`<i style="width:${cd/35*100}%"></i>`:`<i style="width:${n/35*100}%"></i>`}</div></div><b>${n}${cu?(pw?'*':'+'):''}</b></div>`).join('')}}

return {size,cacheInk,setSY:v=>{state.scrollY=v},wave:()=>{state.warp=Math.max(state.warp,.7);state.pulse=1},refresh:()=>{bindModel();state.sel=state.TODAY;render(1);bindCards();hsub();ticks();state.pulse=1;state.warp=.6;state.wdir=1}};}
