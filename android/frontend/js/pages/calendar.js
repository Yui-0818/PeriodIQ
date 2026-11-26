/* ------------------------------------------------------------------
   1 角色：Calendar 页装配、翻月手势、图例/地平线、天空、gate 绘制与主循环
   2 依赖：core、PG、CalendarGrid（calendar.grid.js）、CalendarDetail（calendar.detail.js）。
   3 暴露：boot_cal(core,PG) → {size,cacheInk,setSY,wave,refresh,focusDate,cellCenter,selectDay}。
   4 不变量：月视图动画、手势、图例与 gate 文案/形状不变；跨模块状态经 state 读写。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/calendar.js。
   6 禁止改动项：不改选择器/class/文案/aria/时长/缓动/分支顺序；不加依赖；不挂 window。
   迁自：demo@1cd5082 js/pages/calendar.js 第 1–267 行
   ------------------------------------------------------------------ */
function boot_cal(core,PG){const PGID='cal';
const $=s=>PG.querySelector(s)||core.dummy(),$$=s=>[...PG.querySelectorAll(s)],root=document.documentElement;
let scrollY=0;const scrollBy=(...a)=>core.isCur(PGID)&&window.scrollBy(...a);
const requestAnimationFrame=f=>core.raf(PGID,f);
const addEventListener=(t,f,o)=>{window.addEventListener(t,e=>{if(core.isCur(PGID))f(e)},o)};

const 
reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),lerp=(a,b,t)=>a+(b-a)*t,
rnd=(i,k=1)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)},gauss=(d,s)=>Math.exp(-d*d/(2*s*s)),
sp=(c,x,y,r,f)=>{c.beginPath();c.moveTo(x,y-r);c.quadraticCurveTo(x,y,x+r,y);c.quadraticCurveTo(x,y,x,y+r);c.quadraticCurveTo(x,y,x-r,y);c.quadraticCurveTo(x,y,x,y-r);f?c.fill():c.stroke()};
const isMob=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||!document.body.classList.contains('piq-shell');
let dm,skyT=-9,skyOnce=true;
const state={ink:'255,255,255',dpr:1,skyDpr:1,SW:0,SH:0,now:0,px:.5,py:.4,spx:.5,spy:.4,lastMove:-9,waves:[],motes:[],W:394,cw:56,off:0,offV:0,tgt:0,drift:0,warpV:0,dragging:false,suppress:false,L3:[],view:{y:0,m:0},sel:null,pOpen:false,edgeFade:0,edgeSet:-1,gateR:'notperiod',cutDay:null,cal:null,TDY:0,TDM:0,T0:null};
const buzz=p=>{try{navigator.userActivation&&navigator.userActivation.hasBeenActive&&navigator.vibrate&&navigator.vibrate(p)}catch(_){}},cacheInk=()=>{state.ink=getComputedStyle(root).getPropertyValue('--ink').trim();skyOnce=true},ik=a=>`rgba(${state.ink},${clamp(a)})`,wave=(x,y,d=0)=>reduce||state.waves.push({x,y,t:state.now+d});
function roll(el,html,dir=1){if(el._h===html)return;el._h=html;const t0=performance.now(),had=el.children.length>0,n=document.createElement('span');n.className='r';n.innerHTML=html;n._t=t0;
[...el.children].forEach(o=>{if(o.classList.contains('out')||reduce){o.remove();return}const young=t0-(o._t||0)<260;o.classList.add('out');o.setAttribute('aria-hidden','true');o.getAnimations().forEach(a=>a.cancel());let done=0;const kill=()=>{if(!done){done=1;o.remove()}},du=young?140:480;
o.animate([{transform:'none',opacity:1,filter:'blur(0)'},{transform:`translateY(${-dir*34}%) scale(.94)`,opacity:0,filter:'blur(9px)'}],{duration:du,easing:'cubic-bezier(.5,0,.2,1)',fill:'forwards'}).onfinish=kill;setTimeout(kill,du+120)});
el.append(n);if(had&&!reduce)n.animate([{transform:`translateY(${dir*34}%) scale(1.06)`,opacity:0,filter:'blur(12px)'},{transform:'none',opacity:1,filter:'blur(0)'}],{duration:700,easing:'cubic-bezier(.2,.9,.1,1)'})}
const {toN,dOf,fmt,TODAY,MN,FL,PW,typeOf,softOf,info,endOf,cycAt,tierOf}=core.m,api=core.api;const eio=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
// ---------- sky: starfield that drifts and warps with the months
const sky=$('#sky'),sc=sky.getContext('2d'),S=Array.from({length:230},(_,i)=>({x:rnd(i,1),y:rnd(i,2),z:.15+rnd(i,3)*.85,p:rnd(i,4)*6.28,k:rnd(i,5)>.93,bt:null}));
function drawSky(t){const sdpr=state.skyDpr||state.dpr;sc.setTransform(sdpr,0,0,sdpr,0,0);sc.clearRect(0,0,state.SW,state.SH);sc.lineCap='round';const lt=root.dataset.theme=='light',lb=lt?1.3:1,sl=clamp(Math.abs(state.warpV)*.03,0,110),sg=Math.sign(state.warpV);
for(let i=0;i<S.length;i++){const s=S[i],x=(((s.x*state.SW+state.drift*s.z*.35-(state.spx-.5)*24*s.z)%state.SW)+state.SW)%state.SW,y=((s.y*state.SH-scrollY*(.05+.22*s.z))%state.SH+state.SH)%state.SH-(state.spy-.5)*24*s.z;SP[i]=[x,y];let a=(.2+.7*s.z)*(.55+.45*Math.sin(t*(.6+s.z)+s.p))*lb,b=0;
for(const w of state.waves){const age=t-w.t;if(age<0)continue;const f=Math.max(0,1-Math.abs(Math.hypot(x-w.x,y-w.y)-age*430)/50)*Math.max(0,1-age/1.5);a+=f*.9;b+=f*2}
if(s.bt!=null){const g=Math.max(0,1-(t-s.bt)/1.3);a+=g;b+=g*3}
sc.fillStyle=sc.strokeStyle=ik(a);const l=sl*s.z;
if(l>2){sc.lineWidth=.6+s.z;sc.beginPath();sc.moveTo(x,y);sc.lineTo(x-sg*l,y);sc.stroke()}else if(s.k)sp(sc,x,y,(2.4+3.6*s.z)*(lt?1.3:1)+b,1);else{sc.beginPath();sc.arc(x,y,(.4+s.z*1.1)*(lt?1.35:1)+b*.5,0,7);sc.fill()}}
for(const w of state.waves){const age=t-w.t;if(age<0)continue;sc.strokeStyle=ik(.22*(1-age/1.5));sc.lineWidth=1;sc.beginPath();sc.arc(w.x,w.y,age*430,0,7);sc.stroke()}state.waves=state.waves.filter(w=>t-w.t<1.5);
// recycled dust: motes from an extinguished star curve up into a background star and ignite it
for(const q of state.motes){if(t<q.t0)continue;const u=clamp((t-q.t0)/q.dur),tg=SP[q.ti]||[q.x,q.y];
for(let j=5;j>=0;j--){const e2=eio(clamp(u-j*.035)),px_=lerp(q.x,tg[0],e2)+Math.sin(e2*Math.PI)*q.cx,py_=lerp(q.y,tg[1],e2)-Math.sin(e2*Math.PI)*34;sc.fillStyle=ik((1-j/6)*.8*(1-u*.4));sc.beginPath();sc.arc(px_,py_,1.8*(1-j/8),0,7);sc.fill()}
if(u>=1){S[q.ti].bt=t;q.done=1}}state.motes=state.motes.filter(q=>!q.done);
const u=(t%9)/1.2;if(u<1){const mi=Math.floor(t/9),ma=(152+(rnd(mi,31)-.5)*14)*(Math.PI/180),vx=Math.cos(ma),vy=Math.sin(ma),span=Math.min(state.SW*.84,Math.hypot(state.SW,state.SH)*.48),tail=Math.max(68,Math.min(132,span*.34)),x0=state.SW*(.84+rnd(mi,32)*.14),y0=state.SH*(.05+rnd(mi,33)*.11),eu=1-Math.pow(1-u,1.5),x=x0+vx*span*eu,y=y0+vy*span*eu,tx=x-vx*tail,ty=y-vy*tail,al=Math.sin(Math.PI*u)*.92,g=sc.createLinearGradient(x,y,tx,ty);g.addColorStop(0,ik(al));g.addColorStop(1,ik(0));sc.strokeStyle=g;sc.lineWidth=1.2;sc.beginPath();sc.moveTo(x,y);sc.lineTo(tx,ty);sc.stroke();sc.fillStyle=ik(al);sc.beginPath();sc.arc(x,y,1.35,0,7);sc.fill()}}
const SP=[];
const T0=dOf(TODAY),TDY=T0.getUTCFullYear(),TDM=T0.getUTCMonth(),cal=$('#cal');state.cal=cal;state.T0=T0;state.TDY=TDY;state.TDM=TDM;state.view={y:TDY,m:TDM};
state.reduce=reduce;state.ik=ik;state.sp=sp;state.clamp=clamp;state.lerp=lerp;state.gauss=gauss;state.eio=eio;state.rnd=rnd;state.buzz=buzz;state.wave=wave;state.roll=roll;state.gsize=gsize;state.legend=legend;state.unm=unm;state.scrollBy=scrollBy;state.addEventListener=addEventListener;state.S=S;state.$=$;state.$$=$$;
const grid=CalendarGrid(core,PG,state);state.grid=grid;
// swipe: horizontal drags month, vertical stays native scroll
let pd=null,lx0=0,lt0=0,vx=0;
state.cal.addEventListener('pointerdown',e=>{pd={x:e.clientX,y:e.clientY,o:state.off,id:e.pointerId};lx0=e.clientX;lt0=e.timeStamp;vx=0});
state.cal.addEventListener('pointermove',e=>{if(!pd)return;const dx=e.clientX-pd.x,dy=e.clientY-pd.y;if(!state.dragging){if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.2){state.dragging=true;state.tgt=0;try{state.cal.setPointerCapture(pd.id)}catch(_){}}else return}
let o=pd.o+dx;if((o>0&&!state.grid.canGo(-1))||(o<0&&!state.grid.canGo(1)))o*=.28;state.off=o;const dtm=Math.max(1,e.timeStamp-lt0);vx=lerp(vx,(e.clientX-lx0)/dtm*1000,.5);lx0=e.clientX;lt0=e.timeStamp;state.offV=vx});
const endDrag=()=>{if(!pd)return;if(state.dragging){state.dragging=false;state.suppress=true;setTimeout(()=>state.suppress=false,80);if((state.off<-state.W*.22||(vx<-450&&state.off<0))&&state.grid.canGo(1))state.tgt=-state.W;else if((state.off>state.W*.22||(vx>450&&state.off>0))&&state.grid.canGo(-1))state.tgt=state.W;else state.tgt=0}pd=null};
['pointerup','pointercancel'].forEach(k=>state.cal.addEventListener(k,endDrag));
const detail=CalendarDetail(core,PG,state);state.detail=detail;
let gw=0;
// legend + horizon note follow what the service actually provided
function legend(){const S=core.m.seg,has={p:core.m.CYC.length>0,d:S.pred.length>0,o:S.ov!=null,f:!!S.fert,l:S.lc.length>0};$$('#lgd span[data-k]').forEach(e=>e.classList.toggle('off',!has[e.dataset.k]))}
function unm(){const S=core.m.seg,hz=Math.max(-1,...[S.ov,S.fert&&S.fert.e,...S.pred.map(w=>w.e),...S.lc.map(w=>w.e)].filter(x=>x!=null)),t=hz<0?core.i18n.t('cal.unmNoModel'):toN(state.view.y,state.view.m,1)>hz?core.i18n.t('cal.unmBeyond'):'',el=$('#unm');if(el._h!==t){el._h=t;if(t)el.textContent=t;el.classList.toggle('on',!!t)}}
// ---------- the three read-only metaphors (drawn, not greyed out): light in transit · settled light · a quiet sky
const gt=$('#gt');function gsize(){gw=gt.clientWidth;gt.width=Math.round(gw*state.dpr);gt.height=Math.round(112*state.dpr)}
function drawGate(t){if(!gw||!$('#gate').classList.contains('on'))return;const c=gt.getContext('2d'),w=gw,h=112,T=reduce?1.5:t,br=.5+.5*Math.sin(T*1.7);c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,w,h);c.lineCap='round';
if(state.gateR=='future'){const sx=w*.84,sy=30,ex=w*.16,ey=80,bz=u=>{const v=1-u;return[v*v*(sx-14)+2*v*u*w*.5+u*u*(ex+10),v*v*(sy+6)+2*v*u*(sy+46)+u*u*ey]};
c.strokeStyle=ik(.4+.2*br);c.lineWidth=1;sp(c,sx+Math.sin(T*.7)*1.5,sy+Math.cos(T*.6)*1.5,9+2*br,0);
c.strokeStyle=ik(.2);c.setLineDash([1.5,5]);c.beginPath();for(let i=0;i<=30;i++){const q=bz(i/30);i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1])}c.stroke();c.setLineDash([]);
for(let i=0;i<6;i++){const u=(T*.1+i/6)%1,q=bz(u);c.fillStyle=ik(.12+.8*u);c.beginPath();c.arc(q[0],q[1],1+1.7*u,0,7);c.fill()}
c.strokeStyle=ik(.55);c.setLineDash([2,3]);c.beginPath();c.arc(ex,ey,10+2*br,0,7);c.stroke();c.setLineDash([])}
else if(state.gateR=='old'){const cx=w/2,cy=56;c.strokeStyle=ik(.28);c.lineWidth=.8;c.beginPath();c.arc(cx,cy,34,0,7);c.stroke();c.strokeStyle=ik(.14);c.beginPath();c.arc(cx,cy,22,0,7);c.stroke();
for(let i=0;i<36;i++){const a=i/36*6.2832,r2=i%3==0?46:42;c.strokeStyle=ik(i%3==0?.6:.35);c.lineWidth=i%3==0?1.2:.8;c.beginPath();c.moveTo(cx+Math.cos(a)*38,cy+Math.sin(a)*38);c.lineTo(cx+Math.cos(a)*r2,cy+Math.sin(a)*r2);c.stroke()}
const ga=(T%12)/12*6.2832;c.strokeStyle=ik(.85);c.lineWidth=1.6;c.beginPath();c.arc(cx,cy,34,ga,ga+.3);c.stroke();
const g=c.createRadialGradient(cx,cy,0,cx,cy,20);g.addColorStop(0,ik(.5));g.addColorStop(1,ik(0));c.fillStyle=g;c.fillRect(cx-20,cy-20,40,40);c.fillStyle=ik(.95);sp(c,cx,cy,8,1)}
else{const cx=w/2,cy=56,gp=28;c.setLineDash([2,6]);c.strokeStyle=ik(.25);c.lineWidth=1;c.beginPath();c.moveTo(w*.1,cy+10);c.lineTo(cx-gp,cy);c.moveTo(cx+gp,cy);c.lineTo(w*.9,cy+10);c.stroke();c.setLineDash([]);
const g=c.createRadialGradient(cx,cy,0,cx,cy,30);g.addColorStop(0,ik(.08+.14*br));g.addColorStop(1,ik(0));c.fillStyle=g;c.fillRect(cx-30,cy-30,60,60);c.strokeStyle=ik(.5);c.lineWidth=1;c.beginPath();c.arc(cx,cy,3.4,0,7);c.stroke();
for(const sd of[-1,1]){const u=(T*.18+(sd>0?.5:0))%1,x=sd<0?lerp(w*.1,cx-gp,u):lerp(w*.9,cx+gp,u),y=lerp(cy+10,cy,u);c.fillStyle=ik(.12+.5*u);c.beginPath();c.arc(x,y,1.4,0,7);c.fill()}}}
// ---------- lens refraction
dm=core.dm();
addEventListener('pointermove',e=>{state.px=e.clientX/innerWidth;state.py=e.clientY/innerHeight;state.lastMove=state.now});
// ---------- one clock
let rectDirty=true,rectUntil=0,glassRects=[],lastPOpen=false;
core.on('tilt',({x,y})=>{if(core.isCur(PGID)){state.px=x;state.py=y;state.lastMove=state.now}});
function size(){state.dpr=Math.min(devicePixelRatio||1,2);state.skyDpr=isMob?1:state.dpr;state.SW=innerWidth;state.SH=innerHeight;sky.width=state.SW*state.skyDpr;sky.height=state.SH*state.skyDpr;const cw_=state.cal.clientWidth||state.cal.getBoundingClientRect().width;if(cw_>0){state.W=cw_;state.cw=(state.W-36)/7;state.L3.forEach(state.grid.sizeLayer)}state.detail.RF.size();state.detail.RP.size();state.detail.RM.size();gsize();state.detail.nsize();rectDirty=true;skyOnce=true}
let last=0;
function loop(ts){const t=ts/1000,rdt=Math.min(.25,t-last||.016),dt=Math.min(.033,rdt);last=t;state.now=t;
if(!reduce&&t-state.lastMove>2.5){state.px=.5+.3*Math.sin(t*.35);state.py=.4+.25*Math.cos(t*.27)}state.spx+=(state.px-state.spx)*.07;state.spy+=(state.py-state.spy)*.07;
if(!state.dragging){state.offV+=((state.tgt-state.off)*150-state.offV*19)*dt;state.off+=state.offV*dt;if(Math.abs(state.off-state.tgt)<.6&&Math.abs(state.offV)<10){state.off=state.tgt;state.offV=0;if(state.tgt!==0)state.grid.commit(state.tgt<0?1:-1)}}
const edgeTgt=clamp(Math.abs(state.offV)/800+(state.dragging?.55:0),0,1)*32;state.edgeFade+=(edgeTgt-state.edgeFade)*(1-Math.exp(-dt*13));
if(Math.abs(state.edgeFade-state.edgeSet)>.2){state.edgeSet=state.edgeFade;state.cal.style.setProperty('--cf',state.edgeFade.toFixed(1)+'px')}
state.warpV+=(state.offV-state.warpV)*.2;state.drift+=-state.warpV*dt*1;state.grid.layout();
const gx=state.spx*state.SW,gy=state.spy*state.SH;if(state.pOpen!==lastPOpen){lastPOpen=state.pOpen;rectDirty=true;rectUntil=t+1.2}if(rectDirty||t<rectUntil||state.dragging||Math.abs(state.offV)>1){glassRects=$$('.glass').map(el=>({el,r:el.getBoundingClientRect()}));rectDirty=false}
for(let i=0;i<glassRects.length;i++){const {el,r}=glassRects[i];if(r.bottom<0||r.top>state.SH)continue;core.glassLight(el,gx-r.left,gy-r.top,Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90,r.width,r.height)}
if(dm)dm.setAttribute('scale',(30+14*Math.min(1,Math.abs(state.warpV)/900)).toFixed(1));
state.L3.forEach(L=>{if(L.el.style.visibility!=='hidden'){if(Math.abs(L.x)<state.W*1.05)state.grid.drawLayer(L,t);state.grid.lens(L,dt)}});
if(state.pOpen){state.detail.RF.draw(t,dt);state.detail.RP.draw(t,dt);state.detail.RM.draw(t,dt);drawGate(t);state.detail.drawNote(t,dt)}
if(skyOnce||!isMob||state.dragging||Math.abs(state.offV)>1||state.waves.length||t-skyT>=.032){drawSky(t);skyT=t;skyOnce=false}requestAnimationFrame(loop)}
cacheInk();size();state.grid.mount();size();state.grid.setMonthTitle(1);legend();requestAnimationFrame(loop);
// [data-layer] #36: no auto-open on entry; existing tap/deep-link paths (cell, #ql, Today star) unchanged
document.fonts&&document.fonts.ready.then(size);

const syncAll=()=>{state.L3.forEach(L=>state.grid.refresh(L));legend();unm();if(state.pOpen)state.detail.fill(0)};core.on('model',e=>{if(e&&e.src==='api'&&core.isCur(PGID))syncAll()});
core.on('lang',()=>{state.grid.setMonthTitle(0);state.L3.forEach(L=>state.grid.refresh(L));unm();if(state.detail&&state.detail.retxt)state.detail.retxt()});
function resetView(){if(state.pOpen)state.detail.closeP();const cf=$('#cf');if(cf&&!cf.hidden){cf.hidden=true;cf.setAttribute('aria-hidden','true')}state.off=0;state.offV=0;state.tgt=0;state.dragging=false;state.edgeFade=0;if(state.edgeSet!==0){state.edgeSet=0;state.cal.style.setProperty('--cf','0px')}if(state.view.y!==TDY||state.view.m!==TDM){state.view={y:TDY,m:TDM};state.grid.mount();state.grid.setMonthTitle(0)}else state.grid.layout();scrollY=0;rectDirty=true;skyOnce=true}
return {size,cacheInk,setSY:v=>{scrollY=v;rectDirty=true},wave,refresh:syncAll,resetView,
focusDate:n=>{const d=dOf(n);state.view={y:d.getUTCFullYear(),m:d.getUTCMonth()};if(state.pOpen)state.detail.closeP();state.grid.mount();state.off=0;state.offV=0;state.tgt=0;size();state.grid.setMonthTitle(1)},
cellCenter:n=>{const b=state.L3[1].el.querySelector('.c[data-n="'+n+'"]');if(!b)return null;const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}},
selectDay:n=>{if(!(state.pOpen&&state.sel===n))state.detail.selectDay(n)}};}
