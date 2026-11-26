/* ------------------------------------------------------------------
   1 角色：Today 页星空、环与星点绘制（轨道系统）；桌面（body.piq-shell）把环画成一条被引力塑形的轨道：轨道面光带、恒星冠、周期物质带、随半径缩放的星与尘。
   2 依赖：仅依赖 core、PG 与页面主文件传入的 state；加载期零副作用。桌面分支只读 document.body.classList 与 #nw 的几何，不调用 core.api，不发请求。
   3 暴露：TodayRing(core,PG,state) → {drawSky,drawRing}；不对外暴露其他成员。state.G 结构（R,cx,cy,cT,cR,sR,pts）与取值方式不变，today.js 的命中与拖动仍按同一投影。
   4 不变量：无 piq-shell 时（移动端）每一帧的绘制与原版数值一致：新增的缩放因子 K/ks/kl 在该情形恒为 1，桌面专属块全部由 DK 门控；state 字段在调用时读取，不在工厂顶层缓存。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/today.js 第 73–132 行为移动端基线。
     契约引用：frontend/CONTEXT.md §4 状态/API（TodayRing 方法名与参数不变，零 core.api 调用，仅读 state / core.fx 既有面）。
     改动摘要（W1-1R）：桌面半径改为 min(W*.355,H*.62)（原 min(W*.42,175)）；星/尘/彗星/预测星按 ks=K^.62 放大，线宽按 kl=K^.4；新增轨道面光带与恒星冠（只画在 back 画布）、内外两条淡轨道、周期段的物质带（确定性微粒，随 lit/kick/fxS）、标签字号微增；半径变化时在 stage 上写一次 CSS 变量 --x-R，供 today.css 让中心数字随轨道缩放。
     沿用（B1）：环顶 Next 标签独立带并以虚线发线引到预测星；Today/日期标签避让数字框、Next 标签与舞台边缘；星数/尘数随帧耗时分级（质量梯度）。
   6 禁止改动项：不得改 TodayRing 签名与返回值、state 读取字段、state.G 结构；不得改选择器/阈值/时长/缓动/分支顺序；不得新增依赖或挂 window；唯一的 DOM 副作用是 stage.style.--x-R（仅桌面、仅半径变化时）。
   迁自：demo@1cd5082 js/pages/today.js 第 8–12、71、73–132 行
   ------------------------------------------------------------------ */
const TodayRing = (core, PG, state) => {
const sp=(c,x,y,r,f)=>{c.beginPath();c.moveTo(x,y-r);c.quadraticCurveTo(x,y,x+r,y);c.quadraticCurveTo(x,y,x,y+r);c.quadraticCurveTo(x,y,x-r,y);c.quadraticCurveTo(x,y,x,y-r);f?c.fill():c.stroke()};
const D=Math.PI/180,eoo=u=>1-Math.pow(1-Math.min(1,Math.max(0,u)),3);
const S=Array.from({length:230},(_,i)=>({x:state.rnd(i,1),y:state.rnd(i,2),z:.15+state.rnd(i,3)*.85,p:state.rnd(i,4)*6.28,k:state.rnd(i,5)>.93}));
// quality ladder: qs shrinks only the tail of the star / dust lists when frames run long (ema > 26ms), and recovers when they are short; colour, glass and geometry are never touched
let qs=1,ema=.0167,lastR=0;const nwEl=PG.querySelector('#nw');
function drawSky(t){const r=state.stage.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,sy=state.scrollY*.08;
state.sc.setTransform(state.dpr,0,0,state.dpr,0,0);state.sc.clearRect(0,0,state.SW,state.SH);state.sc.lineCap='round';
for(let si=0,sn=Math.round(S.length*qs);si<sn;si++){const s=S[si],x=s.x*state.SW-(state.spx-.5)*26*s.z,y=((s.y*state.SH-sy*s.z)%state.SH+state.SH)%state.SH-(state.spy-.5)*26*s.z,tw=.55+.45*Math.sin(t*(.6+s.z)+s.p);let a=(.2+.7*s.z)*tw*(.8+.2*state.m),b=0;
for(const w of state.rips){const age=t-w.t;if(age<0)continue;const f=Math.max(0,1-Math.abs(Math.hypot(x-w.x,y-w.y)-age*430)/50)*Math.max(0,1-age/1.5);a+=f*.9;b+=f*2}
if(state.warp>.02){const dx=x-cx,dy=y-cy,L=Math.hypot(dx,dy)||1,len=state.warp*(30+170*s.z)*state.wdir;state.sc.strokeStyle=`rgba(${state.ink},${a})`;state.sc.lineWidth=.6+s.z;state.sc.beginPath();state.sc.moveTo(x,y);state.sc.lineTo(x+dx/L*len,y+dy/L*len);state.sc.stroke();continue}
state.sc.fillStyle=`rgba(${state.ink},${a})`;if(s.k)sp(state.sc,x,y,2.5+4*s.z*tw+b,1);else{state.sc.beginPath();state.sc.arc(x,y,.4+s.z*1.1+b*.5,0,7);state.sc.fill()}}
for(const w of state.rips){const age=t-w.t;if(age<0)continue;state.sc.strokeStyle=`rgba(${state.ink},${.22*(1-age/1.5)})`;state.sc.lineWidth=1;state.sc.beginPath();state.sc.arc(w.x,w.y,age*430,0,7);state.sc.stroke()}state.rips=state.rips.filter(w=>t-w.t<1.5);
for(const p of state.sparks){const age=t-p.t;if(age<0||age>2.2)continue;const u=age/2.2;state.sc.fillStyle=`rgba(${state.ink},${.9*(1-u)})`;state.sc.beginPath();state.sc.arc(p.x+p.vx*age,p.y+p.vy*age+8*age*age,1.1+1.3*(1-u),0,7);state.sc.fill()}state.sparks=state.sparks.filter(p=>t-p.t<2.2);
const u=(t%8)/1.2;if(u<1){const x=state.SW*(.9-.7*u),y=state.SH*(.08+.22*u),g=state.sc.createLinearGradient(x,y,x+90,y-35);g.addColorStop(0,`rgba(${state.ink},${.9*(1-u)})`);g.addColorStop(1,`rgba(${state.ink},0)`);state.sc.strokeStyle=g;state.sc.lineWidth=1.2;state.sc.beginPath();state.sc.moveTo(x,y);state.sc.lineTo(x+90,y-35);state.sc.stroke()}}
function drawRing(t,dt_){
ema+=(dt_-ema)*.04;qs=Math.max(.55,Math.min(1,qs+(ema>.026?-.008:ema<.02?.002:0)));
const DK=document.body.classList.contains('piq-shell'),ie=1-Math.pow(1-Math.min(1,state.intro),4),R=DK?Math.max(110,Math.min(state.W*.355,state.H*.62)):Math.min(state.W*.42,175),K=Math.max(1,R/164),ks=Math.pow(K,.62),kl=Math.pow(K,.4),cx=state.W/2,cy=state.H/2-6,mm=state.m,
tilt=(70-9*mm)*D+(state.spy-.5)*.06,roll_=(-13-5*mm)*D+(state.spx-.5)*.06,cT=Math.cos(tilt),sT=Math.sin(tilt),cR=Math.cos(roll_),sR=Math.sin(roll_),rs=(1-.04*mm)*(.8+.2*ie);
state.G={R:R*rs,cx,cy,cT,cR,sR,pts:{}};if(DK&&lastR!==Math.round(R)){lastR=Math.round(R);state.stage.style.setProperty('--x-R',lastR+'px')}
const P=(a,k=1)=>{const r=R*k*rs,y0=r*Math.sin(a),z=y0*sT,s=1/(1-z/(R*4.2)),X=r*Math.cos(a)*s,Y=y0*cT*s;return[cx+X*cR-Y*sR,cy+X*sR+Y*cR,z/R,s]};
for(const c of[state.bc,state.fc]){c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,state.W,state.H);c.lineCap='round';c.setLineDash([])}
const th=d=>-Math.PI/2+(d-1)/state.CL*2*Math.PI,cv=z=>z>0?state.fc:state.bc,dep=z=>.6+.4*(z+1)/2,ik=a=>`rgba(${state.ink},${Math.max(0,Math.min(1,a))})`;
const both=fn=>[[state.bc,0],[state.fc,1]].forEach(([c,f])=>{c.save();c.translate(cx,cy);c.rotate(roll_);c.beginPath();c.rect(-state.W,f?0:-state.H,2*state.W,state.H);c.clip();c.rotate(-roll_);c.translate(-cx,-cy);fn(c,f);c.restore()});
const path=(c,k,a,b,n=90)=>{c.beginPath();for(let i=0;i<=n;i++){const q=P(a+(b-a)*i/n,k);i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1])}c.stroke()};
const a0=th(1),a1=th(state.cur),a2=th(state.CL+1),cd=Math.round(state.cur);
// label layout: occ holds boxes (stage px) that text must not cover. the big number is read from the DOM so it stays true at every width
const SR=state.stage.getBoundingClientRect(),nr=nwEl?nwEl.getBoundingClientRect():null,occ=[];
if(nr&&nr.width)occ.push([nr.left-SR.left-6,nr.top-SR.top+nr.height*.12,nr.right-SR.left+6,nr.bottom-SR.top-nr.height*.12]);
const hit=b=>occ.some(o=>b[0]<o[2]&&b[2]>o[0]&&b[1]<o[3]&&b[3]>o[1]),fit=b=>b[0]>=4&&b[2]<=state.W-4&&b[1]>=4&&b[3]<=state.H-4;
// desktop: orbital plane (a luminous band that peaks on the orbit and fades both ways, tilted like the ring) and the star body's corona behind the day number
if(DK){const c=state.bc,br=.5+.5*Math.sin(t*.9);c.save();c.translate(cx,cy);c.rotate(roll_);c.scale(1,Math.max(.25,cT));let g=c.createRadialGradient(0,0,R*.3,0,0,R*1.42);g.addColorStop(0,ik(0));g.addColorStop(.35,ik(.02*ie));g.addColorStop(.62,ik((.08+.03*mm)*ie));g.addColorStop(.75,ik(.06*ie));g.addColorStop(.9,ik(.02*ie));g.addColorStop(1,ik(0));c.fillStyle=g;c.beginPath();c.arc(0,0,R*1.42,0,7);c.fill();c.restore();
g=c.createRadialGradient(cx,cy,0,cx,cy,R*(.58+.12*mm));g.addColorStop(0,ik((.2+.06*br)*ie));g.addColorStop(.35,ik((.07+.02*br)*ie));g.addColorStop(1,ik(0));c.fillStyle=g;c.fillRect(cx-R,cy-R,2*R,2*R)}
// furniture: guides + phase rim
both((c,f)=>{const A=(f?1:.6)*ie;c.lineWidth=.6;c.strokeStyle=ik(.16*A);path(c,1.1,0,6.2832);c.setLineDash([1.5,5]);c.strokeStyle=ik(.3*A);path(c,.72,0,6.2832);c.setLineDash([]);c.strokeStyle=ik(.08*A);path(c,.5,0,6.2832);if(DK){c.strokeStyle=ik(.05*A);path(c,.9,0,6.2832);path(c,.3,0,6.2832)}});
// segment arcs on the rim: only what the service gave us. lit = reveal progress (sweeps along the arc), kick = flash on change
for(const[k,rad,al,lw,ds]of[['period',1.14,.9,2.6,[]],['fert',1.14,.8,2,[7,5]]]){const g=state.SG[k];if(g.lit<.004)continue;const w=state.fxS[k],p=Math.min(1,g.lit),sw=eoo(p),e0=th(g.a-.5),e1=e0+(th(g.b+.5)-e0)*sw;
both((c,f)=>{const A=(f?1:.6)*Math.min(1,al*w*Math.min(1,p*1.6))*ie;c.strokeStyle=ik(A);c.lineWidth=(DK&&k=='period'?1.5:lw*kl)*(w>1?1.7:1)*(1+.9*g.kick);c.setLineDash(ds);c.lineDashOffset=w>1?-t*18:k=='fert'?-t*6:0;path(c,rad,e0,e1,60);if(DK&&k=='period'){const n=Math.round((e1-e0)*28*kl)+14;for(let i=0;i<n;i++){const a=e0+(e1-e0)*state.rnd(i,21),q=P(a+Math.sin(t*.5+i)*.004,1.095+state.rnd(i,22)*.09);c.fillStyle=ik(A*(.3+.55*state.rnd(i,23)));c.beginPath();c.arc(q[0],q[1],(.5+state.rnd(i,24)*1.1)*ks,0,7);c.fill()}}
if(k=='fert'){c.setLineDash([]);c.lineWidth=.7;path(c,1.19,e0,e1,60)}
if(sw<.999||g.kick>.05){const q=P(e1,rad);c.setLineDash([]);const gr=c.createRadialGradient(q[0],q[1],0,q[0],q[1],18);gr.addColorStop(0,ik(.9*A*Math.max(.4,1-sw*.5)));gr.addColorStop(1,ik(0));c.fillStyle=gr;c.fillRect(q[0]-18,q[1]-18,36,36)}
c.setLineDash([])})}
if(state.SG.lc.lit>.004){const g=state.SG.lc,w=state.fxS.lc,p=Math.min(1,g.lit);both((c,f)=>{c.lineWidth=1.1*(w>1?1.7:1)*(1+.9*g.kick);c.setLineDash([1,3.5]);c.lineDashOffset=t*5;for(const[a,b]of g.W){const e0=th(a-.5);c.strokeStyle=ik((f?1:.6)*Math.min(1,.5*w*p*(.7+.3*Math.sin(t*2.2+a)))*ie);path(c,1.075+.012*Math.sin(t*1.3+a),e0,e0+(th(b+.5)-e0)*eoo(p),40)}c.setLineDash([])})}
// trails: elapsed (bright) vs approach (dashed, flowing)
both((c,f)=>{const e=(1-.78*mm)*ie,N=64;c.setLineDash([]);for(let i=0;i<N;i++){const u=i/N,q1=P(a0+(a1-a0)*u),q2=P(a0+(a1-a0)*(u+1/N));c.strokeStyle=ik(Math.pow(u,1.7)*.95*e*(f?1:.65));c.lineWidth=(.8+2.6*u)*kl;c.beginPath();c.moveTo(q1[0],q1[1]);c.lineTo(q2[0],q2[1]);c.stroke()}
c.strokeStyle=ik((.22+.6*mm)*(f?1:.65)*ie);c.lineWidth=.9+1.1*mm;c.setLineDash([1.5,5.5]);c.lineDashOffset=-t*10*(.3+mm);if(state.NEXT)path(c,1,a1,a2,80);c.setLineDash([])});
for(let i=0;state.NEXT&&i<14;i++){const u=(t*(.05+.1*mm)+i/14)%1,q=P(a1+(a2-a1)*u),c=cv(q[2]);c.fillStyle=ik((.15+.85*mm)*(.2+.8*u)*dep(q[2]));c.beginPath();c.arc(q[0],q[1],(1+1.6*u)*q[3]*ks,0,7);c.fill()}
// dust
state.dustP+=dt_*(state.reduce?0:.05+.07*mm+state.warp*.9);
for(let i=0,dn=Math.round(150*Math.max(1,Math.min(2.4,K*K*.8))*qs);i<dn;i++){const q=P(state.rnd(i,7)*6.2832+state.dustP*(.5+state.rnd(i,8)),.78+state.rnd(i,9)*.46),c=cv(q[2]),s=(.6+state.rnd(i,4)*1)*q[3]*ks;c.fillStyle=ik((.12+.4*state.rnd(i,3))*dep(q[2])*(.8+.4*Math.sin(t*2+i))*ie);c.fillRect(q[0]-s/2,q[1]-s/2,s,s)}
// day ticks + week labels
for(let d=1;d<=state.CL;d++){const wk=(d-1)%7==0,q1=P(th(d),1.2),q2=P(th(d),wk?1.28:1.24),c=cv(q1[2]);c.strokeStyle=ik(.38*dep(q1[2])*ie);c.lineWidth=wk?1:.6;c.beginPath();c.moveTo(q1[0],q1[1]);c.lineTo(q2[0],q2[1]);c.stroke();
if(wk&&d>1&&Math.abs(d-state.cur)>2.6){const q=P(th(d),1.38);c.fillStyle=ik(.55*dep(q[2])*ie);c.font=`700 ${DK?11.5:10.5}px Inter,system-ui,sans-serif`;c.textAlign='center';c.textBaseline='middle';if(!DK||(q[0]>18&&q[0]<state.W-18))c.fillText('D'+d,q[0],q[1])}}
// stars: one per day. filled = passed, hollow = ahead. A star's style comes only from the live segments (it relaxes back to a plain dot when its segment goes out)
const inW=(k,d)=>{const g=state.SG[k];return k=='lc'?g.W.some(w=>d>=w[0]&&d<=w[1]):d>=Math.round(g.a)&&d<=Math.round(g.b)};
for(let d=1;d<=state.CL;d++){const q=P(th(d)),c=(state.G.pts[d]=q,cv(q[2])),on=d<=cd,vis=Math.max(0,Math.min(1,ie*(state.CL+8)-d)),
isPer=state.SG.period.lit>.01&&inW('period',d),isOv=state.SG.ov.lit>.01&&inW('ov',d),isF=state.SG.fert.lit>.01&&inW('fert',d),isL=state.SG.lc.lit>.01&&inW('lc',d),
key=isPer?'period':isOv?'ov':isF?'fert':isL?'lc':null,w=key?state.fxS[key]:1,lit=key?state.SG[key].lit:1,A=Math.min(1,dep(q[2])*Math.min(1,w)*(on?1:.85))*vis,s=q[3]*(w>1?1.3:1)*(.4+.6*vis)*ks;
c.fillStyle=ik(A);c.strokeStyle=ik(A);c.lineWidth=1;
if(isPer){c.beginPath();c.arc(q[0],q[1],3.6*s*(.5+.5*lit),0,7);on?c.fill():c.stroke()}
else if(isOv||isF){const ov=isOv,r=(ov?9:5.4)*s*lit;
if(on||ov){const g=c.createRadialGradient(q[0],q[1],0,q[0],q[1],r*3.2+.01);g.addColorStop(0,ik(.5*A*(1+.3*Math.sin(t*3+d))));g.addColorStop(1,ik(0));c.fillStyle=g;c.fillRect(q[0]-r*3.2,q[1]-r*3.2,r*6.4,r*6.4);c.fillStyle=ik(A)}
sp(c,q[0],q[1],r,on);if(ov){c.lineWidth=.8;c.beginPath();c.arc(q[0],q[1],r*1.7,0,7);c.stroke();c.setLineDash([2,3]);c.beginPath();c.arc(q[0],q[1],r*2.3,0,7);c.stroke();c.setLineDash([])}}
else if(isL){const dx=Math.sin(t*.9+d)*1.3,dy=Math.cos(t*1.1+d*1.7)*1.3,br=.55+.45*Math.sin(t*2.1+d);c.strokeStyle=ik(A*.75*br*lit);c.beginPath();c.arc(q[0]+dx,q[1]+dy,2*s,0,7);c.stroke()}
else{c.beginPath();c.arc(q[0],q[1],2*s,0,7);on?c.fill():c.stroke()}}
if(state.NEXT)state.G.pts[state.CL+1]=P(a2);
// next-period destination: only when the service predicts one. Drawn as an uncertain star: darker, hollow, drifting, breathing
if(state.SG.pred.lit>.004){const g=state.SG.pred,L=Math.min(1,g.lit),q=P(th(1)),c=state.bc,pr=(t*.45)%1,dx=Math.sin(t*.8)*1.4,dy=Math.cos(t*.65)*1.2,br=.5+.5*Math.sin(t*1.7);
for(let j=0;j<3;j++){const u=(pr+j/3)%1;c.strokeStyle=ik(mm*(1-u)*.7*dep(q[2])*ie*L);c.lineWidth=1;c.beginPath();c.arc(q[0]+dx,q[1]+dy,(5+26*u)*ks,0,7);c.stroke()}
c.strokeStyle=ik((.25+.5*mm)*(.75+.25*br)*ie*L*Math.min(1,state.fxS.pred));c.lineWidth=1;c.setLineDash([2,2.5]);c.beginPath();c.arc(q[0]+dx,q[1]+dy,(7.5+1.2*br)*(1+.6*g.kick)*ks,0,7);c.stroke();c.setLineDash([]);c.lineWidth=.9;sp(c,q[0]+dx,q[1]+dy,(3.6+1.1*br)*L*ks,0);
// label sits in its own band above both the outermost tick of the ring and the big number, joined to the star's radial by a dashed hairline (predicted = dashed)
const tx=state.TODAY>state.CL?core.i18n.t('today.ringDue'):core.i18n.t('today.ringNext',{d:state.dt(state.CL+1,{month:'short',day:'numeric'})}),fs=DK?12:11;c.font=`${mm>.5?800:700} ${fs}px Inter,system-ui,sans-serif`;c.textAlign='center';c.textBaseline='alphabetic';
const tw_=c.measureText(tx).width,lx=Math.max(tw_/2+8,Math.min(state.W-tw_/2-8,q[0])),o=P(th(1),1.3);let top=1e9;for(let i=0;i<24;i++)top=Math.min(top,P(i*.2618,1.3)[1]);
const by=Math.max(fs+8,Math.min(top-10,(occ[0]?occ[0][1]:cy)-12));
c.strokeStyle=ik((.3+.3*mm)*ie*L);c.lineWidth=.6;c.setLineDash([2,2.5]);c.beginPath();c.moveTo(lx,by+5);c.lineTo(o[0],o[1]);c.stroke();c.setLineDash([]);
c.fillStyle=ik((.4+.4*mm)*ie*L);c.beginPath();c.arc(o[0],o[1],1.3,0,7);c.fill();
c.fillStyle=ik((.45+.5*mm)*ie*L);c.fillText(tx,lx,by);occ.push([lx-tw_/2-3,by-fs,lx+tw_/2+3,by+5])}
// comet head (current / scrubbed day)
{const q=P(a1),c=cv(q[2]),pl=.5+.5*Math.sin(t*3),g=c.createRadialGradient(q[0],q[1],0,q[0],q[1],28*ks);g.addColorStop(0,ik(.8*ie));g.addColorStop(.35,ik((.18+.12*pl+.35*state.pulse)*ie));g.addColorStop(1,ik(0));c.fillStyle=g;c.fillRect(q[0]-28*ks,q[1]-28*ks,56*ks,56*ks);
c.fillStyle=ik(ie);c.beginPath();c.arc(q[0],q[1],(4.6+2.4*state.pulse)*ks,0,7);c.fill();
const l1=P(a1,1.1),l2=P(a1,1.4),l3=P(a1,1.66),side=l2[0]>cx+4?1:l2[0]<cx-4?-1:0,fs=DK?12.5:11.5,tx=state.sel==state.TODAY?core.i18n.t('today.todayMark'):state.dt(state.sel,{month:'short',day:'numeric'}),up=l2[1]>cy?11:-4;
// on the predicted star the "Next" label already names the day, so the comet label steps aside; elsewhere the first spot that clears the number, the "Next" label and the stage edge wins
if(!(state.NEXT&&state.sel>state.CL)){c.font=`800 ${fs}px Inter,system-ui,sans-serif`;c.textBaseline='alphabetic';const w=c.measureText(tx).width,
cs=[[l2,up],[l2,up>0?-4:11],[l3,up],[l3,up>0?-4:11],[l2,-18],[l3,-18]].map(([p,o])=>{const x=p[0]+side*4,y=p[1]+o,x0=side>0?x:side<0?x-w:x-w/2;return{p,x,y,b:[x0-3,y-fs,x0+w+3,y+4]}}),
pick=cs.find(k=>fit(k.b)&&!hit(k.b))||cs[0];
c.strokeStyle=ik(.7*ie);c.lineWidth=.8;c.beginPath();c.moveTo(l1[0],l1[1]);c.lineTo(pick.p[0],pick.p[1]);c.stroke();
c.fillStyle=ik(ie);c.textAlign=side>0?'left':side<0?'right':'center';c.fillText(tx,pick.x,pick.y)}}}
return {drawSky,drawRing};
};
