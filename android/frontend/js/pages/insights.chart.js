/* ------------------------------------------------------------------
   1 角色：Insights 页趋势图：坐标/曲线/星点/刻度/轨道指针与 tooltip
   2 依赖：core、PG、state（state.CH/state.cw/state.selI/state.T0/state.T1/state.reduce 等）。
   3 暴露：InsightsChart(core,PG,state) → {drawChart,selText,X}。
   4 不变量：空态守卫（<2 个点不画、不可交互）、拖拽命中与 tooltip 弹簧保留；在调用时读取 state。
     R1 变更：横轴 DOM/Today/日期标签、纵轴 17–39、典型带 21–35 全部由 state（实测数据）推导，不再有固定天数等硬编码；标签防重叠；键盘 ←/→/Home/End 选周期；reduced-motion 下无弹簧与装饰动画。
   5 契约来源：早期前端设计文档；早期记录 + DNA.md。
   6 禁止改动项：不改 id、不挂 window、无 core.api/t()/库/外链；本文件不引入新 class（只移除 #tip 上的 x-off，由 insights.js 添加）。
   迁自：demo@1cd5082 js/pages/insights.js 第 72–117 行
   ------------------------------------------------------------------ */
const InsightsChart = (core, PG, state) => {
const gauss=(d,s)=>Math.exp(-d*d/(2*s*s)),fin=Number.isFinite;
const fmt=(d,o={month:'short',day:'numeric'})=>core.m.fmt(state.B0+d,o); // day 0 = first record of the plotted window
// chart: a light curve with a barcode of days

const L=46,RR=20,T=70,BM=64,X=d=>L+(state.cw-L-RR)*d/state.DOM,Y=v=>T+(state.CHH-T-BM)*(1-(v-state.Y0)/(state.Y1-state.Y0)),YA=state.CHH-BM,dayOf=x=>state.clamp((x-L)/(state.cw-L-RR)*state.DOM,0,state.DOM);
const val=d=>{if(d<=state.CH[0].d)return state.CH[0].len;for(let i=1;i<state.CH.length;i++){if(d<=state.CH[i].d){const a=state.CH[i-1],b=state.CH[i],u=(d-a.d)/(b.d-a.d);return a.len+(b.len-a.len)*(1-Math.cos(u*Math.PI))/2}}return state.CH[state.CH.length-1].len};
const plw=(n,b)=>core.i18n.t(core.i18n.plural(n,b),{n});
const capText=p=>{const A=state.AV,d=p.len-A,ad=Math.abs(d);return core.i18n.t('ins.capBase',{n:p.n,d:fmt(p.d),len:p.len,days:plw(p.len,'ui.dayW')})+(fin(A)?(d==0?core.i18n.t('ins.capExact',{av:A}):d>0?core.i18n.t('ins.capLonger',{ad,d:plw(ad,'ui.dayW'),av:A}):core.i18n.t('ins.capShorter',{ad,d:plw(ad,'ui.dayW'),av:A})):'')+(p.len<state.T0||p.len>state.T1?core.i18n.t('ins.capOut',{a:state.T0,b:state.T1}):core.i18n.t('ins.capIn',{a:state.T0,b:state.T1}))};
let amp=0,av=0,snapT=-9,tv=0,tipY=12,blank=0,tipW=0,tipH=0,tipDirty=true;
const glowSp=document.createElement('canvas');glowSp.width=glowSp.height=64;let gInk='';
const stampGlow=(c,x,y,r,a)=>{if(a<=.002||r<=.01)return;const k=state.ink||'255,255,255';if(gInk!==k){gInk=k;const gx=glowSp.getContext('2d'),gr=gx.createRadialGradient(32,32,0,32,32,32);gx.clearRect(0,0,64,64);gr.addColorStop(0,`rgba(${k},1)`);gr.addColorStop(1,`rgba(${k},0)`);gx.fillStyle=gr;gx.fillRect(0,0,64,64)}c.globalAlpha=state.clamp(a);c.drawImage(glowSp,x-r,y-r,r*2,r*2);c.globalAlpha=1};
function selText(i,dir=1){const p=state.CH[i];if(!p)return;state.roll(state.$('#t1'),`${fmt(p.d)} · ${plw(p.len,'ui.day')}`,dir);state.roll(state.$('#t2'),core.i18n.t('ins.capN',{n:p.n,t:state.NC})+(fin(state.AV)?core.i18n.t('ins.capAvg',{av:state.AV}):''),dir);state.roll(state.$('#cap'),capText(p),dir);tipDirty=true}
function setSel(i){state.selI=i;state.selActive=true;snapT=state.now;const p=state.CH[i],r=state.cw$.getBoundingClientRect();state.wave(r.left+X(p.d),r.top+Y(p.len));core.buzz(6);selText(i)}
function mv(e){if(state.CH.length<2)return;/* [data-layer] no trend chart -> not interactive; never read an empty plot */const r=state.cv.getBoundingClientRect(),x=state.clamp(e.clientX-r.left,L,state.cw-RR);state.ttx=x;state.hold=true;let b=0,bd=1e9;state.CH.forEach((p,i)=>{const d=Math.abs(X(p.d)-x);if(d<bd){bd=d;b=i}});if(b!=state.selI)setSel(b)}
state.cv.addEventListener('pointerdown',mv);state.cv.addEventListener('pointermove',mv);
['pointerup','pointercancel'].forEach(k=>state.cv.addEventListener(k,e=>{if(e.pointerType!=='mouse')state.hold=false}));state.cv.addEventListener('pointerleave',()=>state.hold=false);
// keyboard: arrows / Home / End walk the closed cycles; the aria-live caption follows the selection
const KEY={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1};
state.cv.addEventListener('keydown',e=>{const n=state.CH.length;if(n<2)return;const k=e.key;let j=k in KEY?state.selI+KEY[k]:k=='Home'?0:k=='End'?n-1:null;if(j===null)return;e.preventDefault();j=state.clamp(j,0,n-1);state.hold=false;if(j!=state.selI)setSel(j)});
function drawChart(t,dt){if(state.CH.length<2){if(!blank){const k=state.cx2;k.setTransform(1,0,0,1,0,0);k.clearRect(0,0,state.cv.width,state.cv.height);blank=1}return}blank=0;/* [data-layer] 0/1 complete cycles -> no trend chart (no non-finite gradients) */const c=state.cx2,rd=state.reduce,tm=rd?0:t;c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,state.cw,state.CHH);c.lineCap='round';
const tgt=state.hold?state.ttx:X(state.CH[state.selI].d);if(rd){state.trx=tgt;amp=av=0}else{state.trx+=(tgt-state.trx)*(1-Math.exp(-dt*(state.hold?22:7)));av+=((state.hold?11:0)-amp)*160*dt-av*12*dt;amp+=av*dt}
for(let i=0;i<state.CH.length;i++){const g=Math.max(i==state.selI?1:0,state.hold?gauss(X(state.CH[i].d)-state.trx,70)*.85:0);state.lit[i]+=(Math.max(g,.1)-state.lit[i])*(rd?1:1-Math.exp(-dt*9))}
const dy=x=>-amp*gauss(x-state.trx,34)*(.7+.3*Math.cos((x-state.trx)/16-tm*9)),cy=x=>Y(val(dayOf(x)))+dy(x);
// band: typical range, edges and labels from state.T0/state.T1 (the same bounds that count abnormal records)
const y35=Y(state.T1),y21=Y(state.T0);c.fillStyle=state.ik(.035);c.fillRect(L,y35,state.cw-L-RR,y21-y35);c.lineWidth=.6;c.setLineDash([2,4]);c.strokeStyle=state.ik(.34);[y35,y21].forEach(y=>{c.beginPath();c.moveTo(L,y);c.lineTo(state.cw-RR,y);c.stroke()});c.setLineDash([]);
const hA=fin(state.AV),ya=hA?Y(state.AV):-99;c.font="600 11px Inter,'Noto Sans SC',system-ui,sans-serif";c.textAlign='right';c.textBaseline='middle';c.fillStyle=state.ik(.5);if(Math.abs(y35-ya)>=14)c.fillText(state.T1,L-10,y35);if(Math.abs(y21-ya)>=14)c.fillText(state.T0,L-10,y21);
if(hA){c.font="800 16px Inter,'Noto Sans SC',system-ui,sans-serif";c.fillStyle=state.ik(.95);c.fillText(state.AV,L-10,ya)}
c.font="600 9.5px Inter,'Noto Sans SC',system-ui,sans-serif";c.textAlign='left';c.fillStyle=state.ik(.4);try{c.letterSpacing='1.4px'}catch(_){}c.fillText(core.i18n.t('ins.typical'),L+8,y35+13);try{c.letterSpacing='0px'}catch(_){}
// barcode of days: one tick = one day, swelling under the finger
for(let d=0;d<=state.DOM;d++){const x=X(d),rec=state.RECD.includes(d),wk=d%7==0,g=gauss(x-state.trx,38)*(state.hold?1:.5),h=(rec?16:wk?9:4.5)+8*g;c.strokeStyle=state.ik((rec?.7:wk?.4:.22)+.5*g);c.lineWidth=rec?1.2:.7;c.beginPath();c.moveTo(x,YA+6);c.lineTo(x,YA+6+h);c.stroke()}
// date labels come from the records; "Today" sits at today's real day and wins any overlap
c.textBaseline='middle';c.font="700 10.5px Inter,'Noto Sans SC',system-ui,sans-serif";const ly=YA+36,todayLbl=core.i18n.t('ins.todayLbl'),tx=X(state.clamp(state.TD,0,state.DOM))+4,tw=c.measureText(todayLbl).width,taken=[[tx-tw,tx]];c.textAlign='right';c.fillStyle=state.ik(.55);c.fillText(todayLbl,tx,ly);
c.textAlign='left';for(let i=state.RECD.length-1;i>=0;i--){const d=state.RECD[i],s=fmt(d),w=c.measureText(s).width,x0=i==0?X(d)-2:X(d)-w/2;if(x0<2||x0+w>state.cw-2||taken.some(q=>x0<q[1]+4&&x0+w>q[0]-4))continue;taken.push([x0,x0+w]);c.fillStyle=state.ik(i==0?.35:.45+.55*(state.lit[i-1]||0));c.fillText(s,x0,ly)}
// light cone
const g1=c.createLinearGradient(state.trx-44,0,state.trx+44,0);g1.addColorStop(0,state.ik(0));g1.addColorStop(.5,state.ik(.09*(state.hold?1:.45)));g1.addColorStop(1,state.ik(0));c.fillStyle=g1;c.fillRect(state.trx-44,T-26,88,YA-T+26);
const g2=c.createLinearGradient(0,T-26,0,YA);g2.addColorStop(0,state.ik(0));g2.addColorStop(.35,state.ik(.7));g2.addColorStop(1,state.ik(.12));c.strokeStyle=g2;c.lineWidth=1;c.beginPath();c.moveTo(state.trx,T-26);c.lineTo(state.trx,YA);c.stroke();
// stems
state.CH.forEach((p,i)=>{const x=X(p.d);c.strokeStyle=state.ik(.15+.5*state.lit[i]);c.lineWidth=.8;c.setLineDash([1,3]);c.beginPath();c.moveTo(x,cy(x)+8);c.lineTo(x,YA+4);c.stroke();c.setLineDash([])});
// the curve (measured, solid) and the open cycle since the last close (dashed)
const xa=X(state.CH[0].d)-12,xl=X(state.CH[state.CH.length-1].d),path=(a,b)=>{c.beginPath();for(let x=a;x<=b;x+=3){const y=cy(x);x==a?c.moveTo(x,y):c.lineTo(x,y)}c.lineTo(b,cy(b));c.stroke()};
c.strokeStyle=state.ik(.09);c.lineWidth=7;path(xa,xl);c.strokeStyle=state.ik(.95);c.lineWidth=1.6;path(xa,xl);c.strokeStyle=state.ik(.45);c.lineWidth=1.1;c.setLineDash([2,5]);path(xl,state.cw-RR);c.setLineDash([]);
c.strokeStyle=state.ik(1);c.lineWidth=2.8;path(state.clamp(state.trx-42,xa,xl),state.clamp(state.trx+42,xa,xl));
for(let i=0;i<20;i++){const u=(tm*.05+i/20)%1,x=xa+(xl-xa)*u;c.fillStyle=state.ik(.55*(.3+gauss(x-state.trx,60)));c.beginPath();c.arc(x,cy(x),1.1+gauss(x-state.trx,50),0,7);c.fill()}
// stars
state.CH.forEach((p,i)=>{const x=X(p.d),y=cy(x),l=state.lit[i],fl=rd?0:Math.exp(-(t-snapT)*4)*(i==state.selI),r=6+7*l+5*fl;stampGlow(c,x,y,34*(.4+l),.55*l+.12);
c.strokeStyle=state.ik(.5+.5*l);c.lineWidth=.9;c.beginPath();c.arc(x,y,r+6,0,7);c.stroke();
for(let k=0;k<8;k++){const a=k*Math.PI/4+tm*.15,r1=r+9,r2=r+9+(k%2?5:12)*l;c.strokeStyle=state.ik(.6*l);c.beginPath();c.moveTo(x+Math.cos(a)*r1,y+Math.sin(a)*r1);c.lineTo(x+Math.cos(a)*r2,y+Math.sin(a)*r2);c.stroke()}
if(i==state.selI)for(let j=0;j<3;j++){const u=((tm*.6+j/3)%1);c.strokeStyle=state.ik(.5*(1-u)*l);c.beginPath();c.arc(x,y,r+8+26*u,0,7);c.stroke()}
c.fillStyle=state.ik(.7+.3*l);state.sp(c,x,y,r,1)});
// tracker head + ruler date
{const y=cy(state.trx);stampGlow(c,state.trx,y,20,.6);c.fillStyle=state.ik(1);c.beginPath();c.arc(state.trx,y,3.4,0,7);c.fill();
if(state.hold){c.font="700 10.5px Inter,'Noto Sans SC',system-ui,sans-serif";const s=fmt(Math.round(dayOf(state.trx))),w=c.measureText(s).width+18,bx=state.clamp(state.trx,L+w/2,state.cw-RR-w/2);c.textAlign='center';c.fillStyle=state.ik(1);c.beginPath();c.roundRect(bx-w/2,state.CHH-22,w,18,9);c.fill();c.fillStyle=`rgb(${state.root.dataset.theme=='dark'?'0,0,0':'255,255,255'})`;c.fillText(s,bx,state.CHH-13)}}
// tooltip: snaps to the star with a spring, squashes as it travels (no spring under reduced motion)
if(tipDirty||!tipW){tipW=state.tip.offsetWidth;tipH=state.tip.offsetHeight;if(tipW)tipDirty=false}
const w=tipW,tt=state.clamp(X(state.CH[state.selI].d),w/2+10,state.cw-w/2-10);
if(rd){tv=0;state.tipX=tt;tipY=state.hold?4:12}else{tv+=((tt-state.tipX)*220-tv*20)*dt;state.tipX+=tv*dt;tipY+=((state.hold?4:12)-tipY)*(1-Math.exp(-dt*10))}
state.tip.style.transform=`translate(${state.tipX-w/2}px,${tipY}px) scaleX(${1+Math.min(.18,Math.abs(tv)/2600)})`;state.tip.classList.remove('x-off');
const sx=X(state.CH[state.selI].d);c.strokeStyle=state.ik(.5);c.lineWidth=.8;c.setLineDash([1,3]);c.beginPath();c.moveTo(state.tipX,tipY+tipH);c.lineTo(sx,cy(sx)-r2(state.selI));c.stroke();c.setLineDash([])}
const r2=i=>20+7*state.lit[i];
return {drawChart,selText,X};
};
