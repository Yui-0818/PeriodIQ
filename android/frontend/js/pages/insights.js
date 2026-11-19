/* ------------------------------------------------------------------
   1 角色：Insights 页装配、六读数、hero 轨道、spine 与主循环（旧 insights.js 主体）
   2 依赖：core、PG、InsightsChart（insights.chart.js）。
   3 暴露：boot_ins(core,PG) → {size,cacheInk,setSY,wave,refresh}。
   4 不变量：six/hero/spine/DOM id 与事件顺序不变；趋势图数据经 state 交给 chart。
     R1 变更：去掉固定天数硬编码（色带/轨道/大数字均由 stats 实测值推导）；0/1 记录与 null 统计一律中性（—、0 或真句）；<2 个完整周期 → 趋势区空态；reduced-motion 全程尊重。
   5 契约来源：早期前端设计文档；早期记录 + DNA.md。
   6 禁止改动项：不改 id、不挂 window、无 core.api/t()/库/外链；新 class 仅 x- 前缀：x-nil(.nd 无测量值) x-empty(#cw 空态层) x-off(#tip 隐藏) x-idle(#ns 无进行中周期) x-w3(#big 三位数) x-dash(#big 无实测均值时的细破折号)。
   迁自：demo@1cd5082 js/pages/insights.js 第 1–152 行
   ------------------------------------------------------------------ */
function boot_ins(core,PG){const PGID='ins';
const $=s=>PG.querySelector(s)||core.dummy(),$$=s=>[...PG.querySelectorAll(s)],root=document.documentElement;
let scrollY=0;
const requestAnimationFrame=f=>core.raf(PGID,f);
const addEventListener=(t,f,o)=>{window.addEventListener(t,e=>{if(core.isCur(PGID))f(e)},o)};

const D=Math.PI/180,mq=matchMedia('(prefers-reduced-motion:reduce)'),clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),
fin=Number.isFinite,nz=v=>fin(v)?v:null,pl=(n,a,b=a+'s')=>n==1?a:b,T0=21,T1=35,
rnd=(i,k=1)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)},
sp=(c,x,y,r,f)=>{c.beginPath();c.moveTo(x,y-r);c.quadraticCurveTo(x,y,x+r,y);c.quadraticCurveTo(x,y,x,y+r);c.quadraticCurveTo(x,y,x-r,y);c.quadraticCurveTo(x,y,x,y-r);f?c.fill():c.stroke()};
let reduce=mq.matches,ink='255,255,255',SW=0,SH=0,px=.5,py=.4,spx=.5,spy=.4,lastMove=-9,sv=0,HP=0,res=0,waves=[];
const state={CH:[],DOM:1,TD:0,AV:null,NC:0,T0,T1,Y0:T0-4,Y1:T1+4,RECD:[],B0:0,selI:0,lit:[],trx:0,tipX:0,ttx:0,hold:false,cw:0,dpr:1,now:0,selActive:false,CHH:330,reduce,pl};
mq.addEventListener&&mq.addEventListener('change',()=>{state.reduce=reduce=mq.matches});
const cacheInk=()=>ink=getComputedStyle(root).getPropertyValue('--ink').trim(),ik=a=>`rgba(${ink},${clamp(a)})`;
const wave=(x,y)=>reduce||waves.push({x,y,t:state.now});
// a date, or an em dash when the stat is null/undefined/out of range
const fd=(n,o={month:'short',day:'numeric'})=>{if(!fin(n))return'—';const s=core.m.fmt(n,o);return s&&s!=='Invalid Date'?s:'—'};
// stats() made safe: null/NaN fields -> null, 0 records / 0 complete cycles -> no fallback "measurements"
function read(){const S=core.stats()||{},ok=a=>Array.isArray(a)?a.filter(fin):[],iv=ok(S.iv),st=ok(S.starts),
tot=Math.max(0,nz(S.total)??st.length),cn=Math.max(0,nz(S.complete)??iv.length),has=cn>0,mn=iv.length?Math.min(...iv):null,mx=iv.length?Math.max(...iv):null;
return{iv,starts:st,total:tot,complete:cn,ni:Math.min(iv.length,Math.max(0,st.length-1)),
avg:has?nz(S.avg)??(iv.length?Math.round(iv.reduce((a,b)=>a+b,0)/iv.length):null):null,avgPer:tot?nz(S.avgPer):null,
shortest:has?nz(S.shortest)??mn:null,longest:has?nz(S.longest)??mx:null,abn:has?nz(S.abn)??iv.filter(x=>x<T0||x>T1).length:0,
first:tot?nz(S.first)??(st.length?st[0]:null):null,last:tot?nz(S.last)??(st.length?st[st.length-1]:null):null}}
function roll(el,html,dir=1){if(el._h===html)return;el._h=html;const t0=performance.now(),had=el.children.length>0,n=document.createElement('span');n.className='r';n.innerHTML=html;n._t=t0;
[...el.children].forEach(o=>{if(o.classList.contains('out')||reduce){o.remove();return}const young=t0-(o._t||0)<260;o.classList.add('out');o.setAttribute('aria-hidden','true');o.getAnimations().forEach(a=>a.cancel());
let done=0;const kill=()=>{if(!done){done=1;o.remove()}},du=young?140:520;o.animate([{transform:'none',opacity:1,filter:'blur(0)'},{transform:`translateY(${-dir*38}%) scale(.92)`,opacity:0,filter:'blur(9px)'}],{duration:du,easing:'cubic-bezier(.5,0,.2,1)',fill:'forwards'}).onfinish=kill;setTimeout(kill,du+120)});
el.append(n);if(had&&!reduce)n.animate([{transform:`translateY(${dir*38}%) scale(1.08)`,opacity:0,filter:'blur(12px)'},{transform:'none',opacity:1,filter:'blur(0)'}],{duration:760,easing:'cubic-bezier(.2,.9,.1,1)'})}
function count(el,v,ms=1000){const k=el._k=performance.now();if(!fin(v)){el.textContent='—';return}if(reduce){el.textContent=v;return}const t0=k;(function f(n){if(el._k!==k)return;const u=clamp((n-t0)/ms);el.textContent=Math.round(v*(1-Math.pow(1-u,4)));u<1&&requestAnimationFrame(f)})(t0)}
// lens refraction (Chromium)
let dm=core.dm();
// reveal
const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('in')),{threshold:.2});$$('.rv,#cw').forEach(c=>io.observe(c));
addEventListener('pointermove',e=>{px=e.clientX/innerWidth;py=e.clientY/innerHeight;lastMove=state.now});
// ---- six readings: a constellation spine that draws itself as you scroll. One tick = one day, never a fixed 28.
const SV='<svg viewBox="0 0 132 14" width="132" height="14">',nil=SV+'<line x1="1" x2="131" y1="7" y2="7" stroke="currentColor" stroke-width="1.2" stroke-dasharray="1.5 4.5" stroke-linecap="round" opacity=".55"/></svg>';
const strip=(v,m)=>{if(!fin(v)||v<1)return nil;v=Math.min(Math.round(v),60);m=Math.min(60,Math.max(v,Math.round(m)||0));return`<div class="tk" style="--n:${m};--g:${m>36?1:1.5}px">${Array.from({length:m},(_,i)=>`<i${i<v?' class="f"':''}></i>`).join('')}</div>`};
const dots=(p,c,s)=>{if(!p)return SV+`<circle cx="${s=='L'?126:6}" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2.2"/></svg>`;const g=p>1?Math.min(20,120/(p-1)):0,x=i=>s=='L'?126-(p-1-i)*g:6+i*g;let o=SV;
if(c)for(let i=0;i<p-1;i++)o+=`<line x1="${x(i)+6}" x2="${x(i+1)-6}" y1="7" y2="7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`;
for(let i=0;i<p;i++)o+=`<circle cx="${x(i)}" cy="7" r="4" ${c?'fill="none" stroke="currentColor" stroke-width="1.4"':'fill="currentColor"'}/>`;return o+'</svg>'};
const mkSix=Q=>{const n=Q.complete,t=Q.total,has=n>0,sd=has&&Q.longest!=null&&Q.shortest!=null?Math.max(0,Q.longest-Q.shortest):0,nm=has?'Not measured yet':'Needs one complete cycle',dy=v=>`${v} ${pl(v,'day','days')}`;
return[{v:t,k:pl(t,'Total record','Total records'),g:s=>dots(Math.min(t,7),0,s),n:!t?'No period starts logged yet':t==1?`One period start logged, ${fd(Q.first)}`:`Period starts logged, ${fd(Q.first)} – ${fd(Q.last)}`},
{v:n,k:pl(n,'Complete cycle','Complete cycles'),g:s=>dots(n?Math.min(n,6)+1:0,1,s),n:n?'The intervals between those records':t?'A cycle closes when the next period starts':'A cycle needs two period starts'},
{v:Q.avgPer,u:1,k:'Average period',g:()=>strip(Q.avgPer,has?Q.avg:Q.avgPer),n:Q.avgPer==null?(t?'Not measured yet':'Waiting for a logged period'):has&&Q.avg!=null?`${Q.avgPer} of ${dy(Q.avg)} ${Q.avgPer==1?'is a flow day':'are flow days'}`:`Measured from ${t} logged period${t==1?'':'s'}`},
{v:Q.shortest,u:1,k:'Shortest cycle',g:()=>strip(Q.shortest,Q.longest),n:Q.shortest==null?nm:n==1?'Your only complete cycle so far':Q.shortest==Q.longest?'Tied with the longest':'Your quickest cycle'},
{v:Q.longest,u:1,k:'Longest cycle',g:()=>strip(Q.longest,Q.longest),n:Q.longest==null?nm:n==1?'No spread with a single cycle':sd==0?'No spread: every cycle is the same length':`Spread between them: ${dy(sd)}`},
{v:Q.abn,k:pl(Q.abn,'Abnormal record','Abnormal records'),g:s=>SV+`<circle cx="${s=='L'?126:6}" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.2 2.4"/></svg>`,n:!has?'No closed cycles to compare yet':Q.abn?`${Q.abn} outside the typical ${T0}–${T1}`:n==1?`Your only cycle sits in the typical ${T0}–${T1}`:`Every cycle sits in the typical ${T0}–${T1}`}]};
let six=mkSix(read());
const SP='M0-11Q0 0 11 0Q0 0 0 11Q0 0-11 0Q0 0 0-11Z',star=`<svg viewBox="-12 -12 24 24" width="22" height="22"><path d="${SP}" fill="currentColor"/></svg>`,ring='<svg viewBox="-12 -12 24 24" width="22" height="22"><circle r="7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 2.6"/></svg>',
emSvg=`<svg viewBox="0 0 220 44" width="220" height="44" aria-hidden="true"><line x1="62" x2="158" y1="22" y2="22" stroke="currentColor" stroke-width=".9" stroke-dasharray="1.5 4.5" stroke-linecap="round"/><g fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2.4 2.6"><path d="${SP}" transform="translate(40 22) scale(1.5)"/><path d="${SP}" transform="translate(180 22) scale(1.5)"/></g></svg>`;
const sixBox=$('#six'),nodes=six.map((o,i)=>{const L=i%2==0,d=document.createElement('div');d.className='nd '+(L?'L':'R');d.style.top=(92+150*i)+'px';d.style.setProperty('--dx',(L?-16:16)+'px');
d.innerHTML='<i class="st"></i><div class="tx"><div class="num"><span>0</span><small></small></div><div class="k"></div><div class="gl"></div><div class="nt"></div></div>';sixBox.append(d);return d});
let SL=1,pg=0;
function buildSpine(){const w=sixBox.clientWidth,h=sixBox.clientHeight,p=[[w/2,0],...six.map((_,i)=>[w/2+(i%2?16:-16),92+150*i]),[w/2,h]];let d=`M${p[0]}`;
for(let i=0;i<p.length-1;i++){const a=p[Math.max(0,i-1)],b=p[i],c=p[i+1],e=p[Math.min(p.length-1,i+2)];d+=`C${b[0]+(c[0]-a[0])/6},${b[1]+(c[1]-a[1])/6} ${c[0]-(e[0]-b[0])/6},${c[1]-(e[1]-b[1])/6} ${c[0]},${c[1]}`}
$('#p0').setAttribute('d',d);$('#p1').setAttribute('d',d);SL=$('#p1').getTotalLength();$('#p1').style.strokeDasharray=SL}
function spine(){const r=sixBox.getBoundingClientRect();if(!r.height)return;const t=clamp((innerHeight*.66-r.top)/r.height);pg=reduce?t:pg+(t-pg)*.14;
$('#p1').style.strokeDashoffset=SL*(1-pg);const q=$('#p1').getPointAtLength(SL*pg);$('#hd').setAttribute('cx',q.x);$('#hd').setAttribute('cy',q.y);
nodes.forEach((n,i)=>{const on=pg*r.height>=92+150*i-16;if(on!=n.classList.contains('lit')){n.classList.toggle('lit',on);if(on&&!n._c){n._c=1;count(n.querySelector('.num span'),six[i].v,900);wave(innerWidth/2,innerHeight*.5)}}})}
// ---- canvases
const sky=$('#sky'),sc=sky.getContext('2d'),hb=$('#hb'),hf=$('#hf'),hbc=hb.getContext('2d'),hfc=hf.getContext('2d'),cv=$('#chart'),cx2=cv.getContext('2d'),orbit=$('#orbit'),orb=$('#orb'),cw$=$('#cw'),tip=$('#tip');
const xe=document.createElement('div');xe.className='x-empty';xe.setAttribute('aria-hidden','true');xe.hidden=true;cw$.append(xe);
const S=Array.from({length:240},(_,i)=>({x:rnd(i,1),y:rnd(i,2),z:.15+rnd(i,3)*.85,p:rnd(i,4)*6.28,k:rnd(i,5)>.93}));
state.roll=roll;state.wave=wave;state.ik=ik;state.sp=sp;state.clamp=clamp;state.root=root;state.cv=cv;state.cx2=cx2;state.cw$=cw$;state.tip=tip;state.$=$;state.$$=$$;
let hw=0,hh=0,RG=[];
function size(){state.dpr=Math.min(devicePixelRatio||1,2);SW=innerWidth;SH=innerHeight;sky.width=SW*state.dpr;sky.height=SH*state.dpr;hw=orbit.clientWidth;hh=orbit.clientHeight;for(const c of[hb,hf]){c.width=hw*state.dpr;c.height=hh*state.dpr}state.cw=cw$.clientWidth;cv.width=state.cw*state.dpr;cv.height=state.CHH*state.dpr;buildSpine()}
function drawSky(t){sc.setTransform(state.dpr,0,0,state.dpr,0,0);sc.clearRect(0,0,SW,SH);sc.lineCap='round';const sy=scrollY*.08,sl=reduce?0:clamp(Math.abs(sv)*.035,0,70),tt=reduce?0:t;
for(const s of S){const x=s.x*SW-(spx-.5)*26*s.z,y=((s.y*SH-sy*s.z)%SH+SH)%SH-(spy-.5)*26*s.z;let a=(.2+.7*s.z)*(.55+.45*Math.sin(tt*(.6+s.z)+s.p)),b=0;
for(const w of waves){const age=t-w.t,f=Math.max(0,1-Math.abs(Math.hypot(x-w.x,y-w.y)-age*430)/50)*Math.max(0,1-age/1.5);a+=f*.9;b+=f*2}
sc.fillStyle=sc.strokeStyle=ik(a);const l=sl*s.z;
if(l>1.5){sc.lineWidth=.6+s.z;sc.beginPath();sc.moveTo(x,y);sc.lineTo(x,y-Math.sign(sv)*l);sc.stroke()}else if(s.k)sp(sc,x,y,2.4+3.6*s.z+b,1);else{sc.beginPath();sc.arc(x,y,.4+s.z*1.1+b*.5,0,7);sc.fill()}}
for(const w of waves){const age=t-w.t;sc.strokeStyle=ik(.22*(1-age/1.5));sc.lineWidth=1;sc.beginPath();sc.arc(w.x,w.y,age*430,0,7);sc.stroke()}waves=waves.filter(w=>t-w.t<1.5)}
// hero: four orbits, one dot per day
let rot=0,hl=[1,1,1],ox=0,oy=0,oh=false,orx=-1,ory=0;
const setO=e=>{const r=orbit.getBoundingClientRect();ox=e.clientX-r.left;oy=e.clientY-r.top};
const pulse=(x,y)=>{res=1;wave(x,y);fin(state.AV)&&count($('#big'),state.AV,1100);core.buzz(8)};
orbit.tabIndex=0;orbit.setAttribute('role','group');orbit.setAttribute('aria-label','Cycle orbit. Press Enter to pulse it.');
orbit.addEventListener('pointerdown',e=>{setO(e);oh=true;pulse(e.clientX,e.clientY)});
orbit.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();const r=orbit.getBoundingClientRect();pulse(r.left+r.width/2,r.top+r.height/2)}});
orbit.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'||oh){setO(e);oh=true}});
['pointerup','pointercancel','pointerleave'].forEach(k=>orbit.addEventListener(k,()=>oh=false));
const chart=InsightsChart(core,PG,state);state.chart=chart;
function drawHero(t,dt){const NR=RG.length,R=Math.min(hw*.46,182),cx=hw/2,cy=hh*.48,tilt=(62-24*HP)*D+(spy-.5)*.05,rl=-11*D+(spx-.5)*.05,cT=Math.cos(tilt),sT=Math.sin(tilt),cR=Math.cos(rl),sR=Math.sin(rl);
rot+=reduce?0:dt*(.05+clamp(sv*.0004,-3,3));res=Math.max(0,res-dt*.9);const rs=reduce?0:res;
for(const c of[hbc,hfc]){c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,hw,hh);c.lineCap='round'}
const P=(a,k)=>{const r=R*k*(1+.035*rs*Math.sin(t*9-k*8)),y0=r*Math.sin(a),z=y0*sT,s=1/(1-z/(R*4.2)),X=r*Math.cos(a)*s,Y=y0*cT*s;return[cx+X*cR-Y*sR,cy+X*sR+Y*cR,z/R,s]},dep=z=>.55+.45*(z+1)/2;
const arc=(c,k,a,b)=>{c.beginPath();for(let i=0;i<=60;i++){const q=P(a+(b-a)*i/60,k);i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1])}c.stroke()};
for(let i=0;i<3;i++)hl[i]+=((state.selActive?(i==state.selI?1.5:.3):1)-hl[i])*(1-Math.exp(-dt*8));
const a0=-Math.PI/2+rot;hbc.strokeStyle=ik(.28);hbc.lineWidth=.7;{const q1=P(a0,NR?.5:1),q2=P(a0,1);hbc.beginPath();hbc.moveTo(q1[0],q1[1]);hbc.lineTo(q2[0],q2[1]);hbc.stroke()}
for(let r=0;r<=NR;r++){const k=NR?.5+.5*r/NR:1,live=r==NR,h=live?1:hl[r],DL=live?RG.cur:RG[r].len,PD=live?RG.curPer:RG[r].per;hbc.lineWidth=hfc.lineWidth=.6;hbc.strokeStyle=hfc.strokeStyle=ik(.13*Math.min(1.4,h)*(live?1.4:1));hbc.setLineDash(live?[2,4]:[]);hfc.setLineDash(live?[2,4]:[]);arc(hbc,k,-Math.PI,0);arc(hfc,k,0,Math.PI);hbc.setLineDash([]);hfc.setLineDash([]);
for(let i=0;i<DL;i++){if(live&&RG.open&&i>=RG.cd)break;const q=P(a0+i/DL*6.2832,k),c=q[2]>0?hfc:hbc,pd=i<PD,on=live?i<RG.cd:true,A=dep(q[2])*Math.min(1,h)*(on?1:.85),sz=(pd?3.5:1.6)*q[3]*(h>1?1.25:1)*(1+.6*rs*Math.max(0,Math.sin(t*9-i*.5)));
c.fillStyle=c.strokeStyle=ik(A);c.lineWidth=1;c.beginPath();c.arc(q[0],q[1],sz,0,7);on?c.fill():c.stroke();
if(live&&i==RG.cd-1){const g=c.createRadialGradient(q[0],q[1],0,q[0],q[1],24);g.addColorStop(0,ik(.8));g.addColorStop(1,ik(0));c.fillStyle=g;c.fillRect(q[0]-24,q[1]-24,48,48);c.fillStyle=ik(1);c.beginPath();c.arc(q[0],q[1],4.2,0,7);c.fill()}}}
orx<0&&(orx=hw/2,ory=hh/2);const tx=oh?ox:reduce?hw/2:hw/2+Math.sin(t*.55)*hw*.26,ty=oh?oy:reduce?hh*.5:hh*.5+Math.cos(t*.4)*hh*.16,f=reduce?1:1-Math.exp(-dt*(oh?14:2.2));orx+=(tx-orx)*f;ory+=(ty-ory)*f;
orb.style.transform=`translate(${orx-66}px,${ory-66}px) scale(${1+.1*(oh?1:0)+.06*rs})`}
// loop: one clock drives sky, hero, spine, chart and glass highlights
let last=0,lsy=0,vis=(e)=>{const r=e.getBoundingClientRect();return r.bottom>-60&&r.top<innerHeight+60};
function loop(ts){const t=ts/1000,dt=Math.min(.05,t-last||.016);last=t;state.now=t;
const sy=scrollY;sv+=((sy-lsy)/dt-sv)*.15;lsy=sy;const oh=orbit.offsetHeight;HP=oh?clamp(sy/(oh*.9)):0;root.style.setProperty('--hp',HP.toFixed(3));
if(t-lastMove>2.5){px=reduce?.5:.5+.3*Math.sin(t*.35);py=reduce?.4:.4+.25*Math.cos(t*.27)}spx+=(px-spx)*.07;spy+=(py-spy)*.07;
const gx=spx*innerWidth,gy=spy*innerHeight;$$('.glass').forEach(e=>{const r=e.getBoundingClientRect();e.style.setProperty('--px',(gx-r.left).toFixed(0)+'px');e.style.setProperty('--py',(gy-r.top).toFixed(0)+'px');e.style.setProperty('--ang',(Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90).toFixed(0)+'deg')});
if(dm)dm.setAttribute('scale',(30+(reduce?0:10*Math.min(1,Math.abs(sv)/900)+(state.hold?12:0))).toFixed(1));
drawSky(t);if(vis(orbit))drawHero(t,dt);spine();if(vis(cw$))state.chart.drawChart(t,dt);requestAnimationFrame(loop)}
cacheInk();size();bindData(true);fillNodes();fillForecast();requestAnimationFrame(loop);document.fonts&&document.fonts.ready.then(size);

function bindData(first){const Q=read(),m=core.m,c=core.cycleNow()||{},n=Q.complete,t=Q.total,ni=Q.ni,iv=Q.iv,st=Q.starts,f=fd,AV=Q.avg,
cd=fin(c.cd)&&c.cd>0?c.cd:0,cs=nz(c.cs),ns=nz(c.ns),ln=fin(c.len)&&c.len>0?c.len:(cs!=null&&ns!=null&&ns>cs?ns-cs:0),
k0=Math.max(0,ni-3),base=ni?st[k0]:0,runs=(m.M&&m.M.runs)||[],plot=n>1&&ni>1,pn=pl(n,'cycle','cycles'),
spd=Q.shortest!=null&&Q.longest!=null?Math.max(0,Q.longest-Q.shortest):0,big=$('#big'),mo0=f(Q.first,{month:'short'}),mo1=f(Q.last,{month:'short'}),
nx=$('#ns'),tk=$('#ntk'),mk=$('#ns .mkr'),live=cs!=null&&cd>0,
mark=p=>{mk.style.left=(clamp(p)*100).toFixed(1)+'%';mk.dataset.a=p<.16?'l':p>.84?'r':''},
ticks=(len,d)=>Array.from({length:Math.min(len,120)},(_,i)=>`<i${i<d?' class="f"':''}></i>`).join('');
state.B0=base;state.AV=AV;state.NC=n;
// hero rings: the last (up to) three closed cycles, then the cycle in progress; its length is the projected one, else an open ring
RG=[];for(let k=k0+1;k<=ni;k++)RG.push({len:iv[k-1],per:runs[k-1]||Q.avgPer||0});
RG.cd=cd;RG.open=!ln;RG.cur=cd?Math.max(cd,ln||AV||state.T1):0;RG.curPer=fin(c.per)&&c.per>0?c.per:0;
// hero copy: every line is true for 0, 1 and N records
$('#capt').textContent=n?`Average cycle · based on ${n} complete ${pn}`:'Average cycle · no complete cycle yet';$('.cap b').textContent=pl(AV,'day','days');
$('#obs').textContent=t&&Q.first!=null?'Observation log · '+(mo0===mo1?mo0:mo0+' – '+mo1):'Observation log';
$('#h1t').textContent=!t?'Nothing is logged yet.':!n?'Your first cycle is taking shape.':n<2?'Your first cycle has closed.':(spd<=2&&!Q.abn)?'Your rhythm is remarkably steady.':Q.abn?'Your rhythm shifted recently.':'Your rhythm varies a little.';
let h=!t?'Log a period start to begin the archive':!n?'Log one more period to complete a cycle':n>1&&AV!=null&&spd==0?`${n} of ${n} cycles closed on day ${AV}`:n>1&&Q.shortest!=null?`${n} complete cycles · ${Q.shortest}–${Q.longest} days`:AV!=null?`${n} complete ${pn} · ${AV} ${pl(AV,'day','days')}`:`${n} complete ${pn}`;
if(n)h+=` · ${Q.abn} abnormal record${Q.abn==1?'':'s'}`;$('#h1s').textContent=h;
$('#h1k').textContent=!live?(t?'The outer ring waits for a cycle in progress. Touch the sky.':'The dashed ring waits for your first logged period. Touch the sky.'):n?`The inner ${n>3?'rings are your last three complete cycles':n>1?'rings are complete cycles':'ring is a complete cycle'}, one dot per day. The outer ring is the cycle in progress, day ${cd}. Touch the sky.`:`The ring is the cycle in progress, day ${cd}, one dot per day. Touch the sky.`;
// next observation: projected date, running cycle without a date, or idle
nx.classList.toggle('x-idle',!live);
if(live&&ln&&ns!=null){const un=fin(c.until)?c.until:ns-m.TODAY,sy=n>1&&!Q.abn;$('#nxt').textContent='Period expected '+f(ns);
$('#nxl').textContent=[un>0?`In ${un} ${pl(un,'day','days')}`:un==0?'Today':'',n&&AV!=null?`projected from ${sy?'a steady orbit of':'your average of'} ${AV} ${pl(AV,'day','days')}`:''].filter(Boolean).join(' · ');
$('#mkt').textContent=`Today · day ${cd}`;$('#nl1').textContent=`${f(cs)} · day 1`;$('#nl2').textContent=f(ns);tk.style.setProperty('--n',Math.min(ln,120));tk.innerHTML=ticks(ln,cd);mark((cd-.5)/ln)}
else if(live){$('#nxt').textContent='No projected date yet';$('#nxl').textContent=`Day ${cd} of this cycle · a projected date appears here once there is one.`;
$('#mkt').textContent=`Today · day ${cd}`;$('#nl1').textContent=`${f(cs)} · day 1`;$('#nl2').textContent='';tk.style.setProperty('--n',Math.min(cd,120));tk.innerHTML=ticks(cd,cd);mark((cd-.5)/cd)}
else{$('#nxt').textContent='Nothing to project yet';$('#nxl').textContent=t?'Waiting for a cycle in progress.':'Log a period start to begin the projection.';$('#mkt').textContent='Today';$('#nl1').textContent='';$('#nl2').textContent='';tk.innerHTML='';mark(0)}
$('#srct').textContent=!t?'PeriodIQ · 0 records':t==1?`PeriodIQ · 1 record · ${f(Q.first)}`:`PeriodIQ · ${t} records · ${f(Q.first)} – ${f(Q.last)} · typical range ${T0}–${T1} days · one tick = one day`;
// the big numeral is the measured average; with no complete cycle it is an em dash
big._k=0;big.classList.toggle('x-w3',AV!=null&&String(AV).length>2);big.classList.toggle('x-dash',AV==null);
if(AV==null)big.textContent='—';else{big.textContent=first?'0':String(AV);count(big,AV,first?1400:900)}
// [data-layer] 0/1 complete cycles -> empty trend state (data-side guard; B5 owns the visuals)
if(!plot){state.CH=[];state.DOM=1;state.TD=0;state.RECD=[];state.selI=0;state.lit=[];state.selActive=false;state.trx=state.tipX=state.ttx=state.chart.X(0);
const em=!t?['No trend yet','Log a period start to begin the archive.']:!n?['No trend yet','Log one more period start to close your first cycle.']:n==1&&iv.length?['One cycle is not a trend',`Your first cycle closed after ${iv[0]} ${pl(iv[0],'day','days')}. One more period start gives the line a second point.`]:['No trend yet','The line appears once two cycles have closed.'];
xe.innerHTML=emSvg+`<b>${em[0]}</b>`;xe.hidden=false;tip.classList.add('x-off');cv.removeAttribute('tabindex');
$('#cet').textContent=`Cycle length trend · ${Math.min(n,2)} of 2 complete cycles`;$('#cht').textContent=n==1?'One cycle, no trend yet':'No complete cycle yet';$('#cht+.lede').textContent='The line appears once two cycles have closed.';
state.roll($('#t1'),'');state.roll($('#t2'),'');state.roll($('#cap'),em[1]);
$('#chart').setAttribute('aria-label',n==1?'Cycle length trend, one complete cycle, not enough for a trend yet':'Cycle length trend, no complete cycles yet');/* [data-layer] months/aria from core.stats(); no complete cycles -> neutral */return}
state.CH=[];for(let k=k0+1;k<=ni;k++)state.CH.push({d:st[k]-base,n:k,len:iv[k-1]});
state.TD=fin(m.TODAY)?m.TODAY-base:0;state.DOM=Math.max(1,state.CH[state.CH.length-1].d,state.TD);state.RECD=[0,...state.CH.map(p=>p.d)].filter((v,i,a)=>a.indexOf(v)==i);
const ls=state.CH.map(p=>p.len),lo=Math.min(...ls),hi=Math.max(...ls),cl=state.CH.length;state.Y0=Math.min(state.T0-4,lo-3);state.Y1=Math.max(state.T1+4,hi+4);
state.selI=cl-1;state.selActive=false;state.lit=state.CH.map((_,i)=>i==state.selI?1:0);state.trx=state.tipX=state.ttx=state.chart.X(state.CH[state.selI].d);
xe.hidden=true;tip.classList.add('x-off');cv.tabIndex=0;state.chart.selText(state.selI,1);
$('#cet').textContent=`Cycle length trend · last ${cl} cycles`;$('#cht').textContent=hi-lo<=1?`${cl} cycles. One rhythm.`:`${cl} cycles, ${lo} to ${hi} days`;$('#cht+.lede').textContent='Drag across the sky to observe each cycle close.';
$('#chart').setAttribute('aria-label',`Cycle length trend, ${cl} closed cycles, ${lo===hi?lo+' '+pl(lo,'day','days'):lo+'–'+hi+' days'}`);/* [data-layer] months/aria from core.stats()+plotted CH/ls */}
function fillNodes(){six=mkSix(read());nodes.forEach((d,i)=>{const o=six[i],L=i%2==0,ok=fin(o.v),sn=d.querySelector('.num span');d.querySelector('.k').textContent=o.k;d.querySelector('.gl').innerHTML=o.g(L?'L':'R');d.querySelector('.nt').textContent=o.n;d.querySelector('.num small').textContent=ok&&o.u?pl(o.v,'day','days'):'';d.querySelector('.st').innerHTML=o.v?star:ring;d.classList.toggle('x-nil',!ok);
if(d.classList.contains('lit'))count(sn,o.v,900);else sn.textContent=ok?'0':'—'})}

function fillForecast(){const root=$('#x-forecast');if(!root)return;const st=core.stats()||{},starts=(st.starts||[]).slice().sort((a,b)=>a-b),errors=[];for(let i=2;i<starts.length;i++){const prior=starts.slice(0,i),iv=prior.slice(1).map((s,j)=>s-prior[j]);if(!iv.length)continue;const avg=Math.round(iv.reduce((a,b)=>a+b,0)/iv.length),pred=starts[i-1]+avg;errors.push(pred-starts[i])}
const scored=errors.length,abs=errors.map(Math.abs).sort((a,b)=>a-b),median=scored?(abs.length%2?abs[(abs.length-1)/2]:Math.round((abs[abs.length/2-1]+abs[abs.length/2])/2)):null,status=scored>=10?'stable':scored>=5?'provisional':'collecting',spread=st.iv&&st.iv.length?Math.max(...st.iv)-Math.min(...st.iv):0,c=core.cycleNow()||{},ns=c.ns,W=(core.m.seg.pred||[]).find(w=>w.s>core.m.TODAY),nextDate=fin(ns)?fd(ns,{month:'short',day:'numeric'}):'',nextWindow=W?fd(W.s,{month:'short',day:'numeric'})+'–'+fd(W.e,{month:'short',day:'numeric'}):'',conf=nextDate?(scored<5?'Consistent, small sample':spread<=2?'Steady rhythm':'Variable rhythm'):'',set=(sel,val)=>{root.querySelectorAll(sel).forEach(e=>{e.textContent=val})};
root.dataset.fcStatus=status;set('[data-fc=mode]','Backtest');set('[data-fc=next-date]',nextDate);set('[data-fc=next-window]',nextWindow);set('[data-fc=confidence]',conf);set('[data-fc=confidence-reason]',conf?`${st.complete||0} complete cycles · spread ${spread} days`:'');set('[data-fc=scored]',String(scored));set('[data-fc=median-error]',median==null?'—':String(median));
root.querySelectorAll('[data-fc=horizon]').forEach(row=>{const d=+row.dataset.days,hit=errors.filter(e=>Math.abs(e)<=d).length;row.querySelector('[data-fc=hit]').textContent=String(hit);row.querySelector('[data-fc=scored]').textContent=String(scored);row.querySelector('[data-fc=status]').textContent=scored<5?'Collecting':Math.round(hit/scored*100)+'%'});
const empty=root.querySelector('[data-fc=empty]');empty.hidden=scored>0;const box=root.querySelector('[data-fc=errors]');box.textContent='';errors.forEach(e=>{const i=document.createElement('i');i.className='x-fc-err';i.dataset.err=String(Math.max(-7,Math.min(7,e)));box.append(i)})}

return {size,cacheInk,setSY:v=>{scrollY=v},wave,refresh:()=>{bindData(false);fillNodes();fillForecast();res=1}};}
