/* ------------------------------------------------------------------
   1 角色：Calendar 页月网格：三层建层、刷新、绘制、透镜、布局与翻月装配
   2 依赖：core、PG、state（state.L3/state.view/state.off 等）。
   3 暴露：CalendarGrid(core,PG,state) → {mount,commit,go,jump,setMonthTitle,sizeLayer,refresh,drawLayer,lens,layout,canGo}。
   4 不变量：网格绘制顺序、配色、动画与月份范围（TODAY ±18）不变；cell 点击仍走 state.detail.selectDay。
   5 契约来源：早期任务记录（月网格 + calendar.css）；早期前端设计文档；demo@1cd5082 pages/calendar.js 第 36–100 行。
   6 禁止改动项：不改常量/阈值/选择器/时长/缓动/分支顺序；不加依赖；不挂 window。
   迁自：demo@1cd5082 js/pages/calendar.js 第 36–100 行
   改动摘要（Calendar 视觉回退）：保留 B2 的 MG 车道常量；删除 B2 的 x-sel 选中角标与 .x-mr 月尺；排卵日恢复原版四角星+四条射线与图例星；彗星最后一段恢复原版 lift()，头部融回格子中心；其余逻辑、数据层标记与返回面不变。
   ------------------------------------------------------------------ */
const CalendarGrid = (core, PG, state) => {
const {toN,dOf,fmt,TODAY,MN,FL,PW,typeOf,softOf,info,endOf,cycAt,tierOf}=core.m,api=core.api;
const back=t=>{const c=1.70158;return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2)};
const fxc=document.createElement('canvas'),ef=fxc.getContext('2d');
const FIRED=new Set(),ptC=(c,L)=>{const r=state.cal.getBoundingClientRect();return[r.left+18+c.x+L.x,r.top+c.y]};
// marker geometry, px from a cell centre: numerals own r<=13.3 (two digits, 17px/700); the cell half-width at 360 is 23.1, so markers live in 14..22
const MG={RY:17.9,RT:21,RO:19,LN:15};
// ---------- months as layers: prev | current | next
const RH=56,CH=336; // [data-layer] month view derives from TODAY
// [data-layer] navigable range derives from TODAY (±18 months inclusive), not fixed years
const mIdx=v=>v.y*12+v.m,shift=(v,d)=>{const i=mIdx(v)+d;return{y:Math.floor(i/12),m:((i%12)+12)%12}},canGo=d=>{const b=state.TDY*12+state.TDM,i=mIdx(shift(state.view,d));return i>=b-18&&i<=b+18};
function build(v){const el=document.createElement('div');el.className='mo';el.innerHTML='<canvas></canvas><i class="ln glass"></i><div class="cells"></div>';const cv=el.firstChild,ln=el.querySelector('.ln'),cells=el.lastChild,dow=new Date(Date.UTC(v.y,v.m,1)).getUTCDay(),dim=new Date(Date.UTC(v.y,v.m+1,0)).getUTCDate(),L={v,el,cv,c:cv.getContext('2d'),ln,cells:[],byN:{},x:0,lx:0,ly:0,lvx:0,lvy:0,ls:0};el.style.setProperty('--x-r',Math.ceil((dow+dim)/7));
for(let i=0;i<dow;i++)cells.append(document.createElement('i'));
for(let d=1;d<=dim;d++){const idx=dow+d-1,col=idx%7,row=Math.floor(idx/7),n=toN(v.y,v.m,d),b=document.createElement('button');b.className='c';b.textContent=d;b.dataset.n=n;const c={n,d,col,row,el:b,type:undefined,t0:0,inv:false,p:0,delay:.05*col+.07*row};b.onclick=()=>{if(!state.suppress)state.detail.selectDay(n)};cells.append(b);L.cells.push(c);L.byN[n]=c}
for(let i=dow+dim;i<42;i++)cells.append(document.createElement('i'));state.cal.append(el);sizeLayer(L);refresh(L,true);return L}
function sizeLayer(L){L.cv.width=Math.round(state.cw*7*state.dpr);L.cv.height=Math.round(CH*state.dpr);fxc.width=Math.round(state.cw*7*state.dpr);fxc.height=Math.round(CH*state.dpr);L.cells.forEach(c=>{c.x=(c.col+.5)*state.cw;c.y=c.row*RH+RH/2})}
let batch=0;
function refresh(L,first){batch=0;L.cells.forEach(c=>{const ty=typeOf(c.n)||'',sf=softOf(c.n)?1:0;
if(ty!==c.type||sf!==c.sf){if(c.type!==undefined&&!first&&!state.reduce){const dl=.055*Math.min(batch++,16);c.t0=state.now+dl;if(c.type&&!ty)c.gh={t0:state.now+dl,kind:c.type=='period'?(c.n===state.cutDay?'cut':'out'):'fade'};if(Math.abs(L.x)<state.W*.5)state.wave(...ptC(c,L),dl)}c.type=ty;c.sf=sf}
c.el.classList.toggle('td',c.n==TODAY);c.el.classList.toggle('past',c.n<TODAY);c.el.setAttribute('aria-label',fmt(c.n,{month:'long',day:'numeric'})+(c.n==TODAY?', today':'')+({period:', period day',pred:', predicted period',ov:', ovulation',fert:', fertile window'}[ty]||(c.sf?', less certain':'')))})}
function drawLayer(L,t){const c=L.c,A=1.65*state.clamp(1-Math.abs(L.x)/state.W),sh=L.x*.12,R=17;c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,state.cw*7,CH);c.lineCap='round';c.save();c.translate(sh,0);
ef.setTransform(state.dpr,0,0,state.dpr,0,0);ef.clearRect(0,0,state.cw*7,CH);ef.save();ef.translate(sh,0);ef.lineCap='round';let fxUsed=false;
for(const k of L.cells){const pop=k.t0>0?back(state.clamp((t-k.t0)/.85)):1;k.p=state.clamp((A-k.delay)/.5)*pop}
for(const k of L.cells){const nx=L.byN[k.n+1];if(!nx||!k.type||k.type!=nx.type||k.row!=nx.row||(k.type!='period'&&k.type!='pred'))continue;const pl=state.clamp(Math.min(k.p,nx.p));if(pl<=.01)continue;c.strokeStyle=state.ik(k.type=='period'?.85:.55);c.lineWidth=1;c.setLineDash(k.type=='pred'?[3,4]:[]);
let ax,ay,bx,by;if(k.row==nx.row){ax=k.x+R+3;ay=k.y;bx=nx.x-R-3;by=nx.y}else{ax=k.x+state.cw*.32;ay=k.y+R+1;bx=nx.x-state.cw*.32;by=nx.y-R-1}c.beginPath();c.moveTo(ax,ay);c.lineTo(state.lerp(ax,bx,pl),state.lerp(ay,by,pl));c.stroke();c.setLineDash([])}
const n0=L.cells[0].n,n1=L.cells[L.cells.length-1].n,T=7.8,TR=5.2,PL=[];
for(const cy of core.m.M.cyc){if(cy.ov<n0-1||cy.pe>n1+1)continue;const o=(cy.s%5)*.7,ph=(t+o)%T,run=ph<TR&&!state.reduce,u=run?state.eio(ph/TR):1;PL.push({cy,run,u,dp:cy.pe+u*(cy.ov-cy.pe),age:state.reduce?99:ph-TR,key:cy.s+':'+Math.floor((t+o)/T)})}
for(const k of L.cells){const p=k.p,x=k.x,y=k.y,inv=(k.type=='period'&&p>.55)||!!(k.gh&&k.gh.kind!='fade'&&t>k.gh.t0&&(t-k.gh.t0)/1.15<.45);if(inv!==k.inv){k.inv=inv;k.el.classList.toggle('inv',inv)}
if(p>.01){if(k.type=='period'){c.fillStyle=state.ik(1);c.beginPath();c.arc(x,y,R*p,0,7);c.fill();if(k.n==TODAY){const cc=cycAt(k.n);if(cc&&cc.e==null){c.strokeStyle=state.ik(.7);c.lineWidth=1;c.setLineDash([2,3]);c.lineDashOffset=-t*8;c.beginPath();c.arc(x,y,(MG.RO+.4*Math.sin(t*2))*p,0,7);c.stroke();c.setLineDash([])}}}
else if(k.type=='pred'){const br=.5+.5*Math.sin(t*1.6+k.n*.9),dx=Math.sin(t*.7+k.n*1.7)*.7,dy=Math.cos(t*.6+k.n*2.3)*.7;c.strokeStyle=state.ik(.5+.25*br);c.lineWidth=1;c.setLineDash([3,3.68]);c.lineDashOffset=-t*3;c.beginPath();c.arc(x+dx,y+dy,R*p,0,7);c.stroke();c.setLineDash([])}
else if(k.type=='ov'){const q=PL.find(z=>z.cy.ov==k.n),pop=q&&!q.run&&q.age<2.6?Math.exp(-q.age*3):0,ant=q&&q.run?Math.pow(q.u,3):0,gl=.5+.5*Math.sin(t*2.4),gR=24*p*(1+.35*pop+.2*ant),g=c.createRadialGradient(x,y,Math.min(10,gR*.4),x,y,gR);g.addColorStop(0,state.ik(0));g.addColorStop(.24,state.ik(.3+.12*gl+.3*ant+.32*pop));g.addColorStop(1,state.ik(0));c.fillStyle=g;c.fillRect(x-40,y-40,80,80);c.strokeStyle=state.ik(.95);c.lineWidth=1.1+.8*pop;state.sp(c,x,y,(13.5+1.5*gl)*p*(1+.22*pop),0);c.lineWidth=.8;for(let q=0;q<4;q++){const a=q*Math.PI/2+Math.PI/4+t*.3,r1=14*p,r2=(17.5+3*gl)*p*(1+.18*pop);c.beginPath();c.moveTo(x+Math.cos(a)*r1,y+Math.sin(a)*r1);c.lineTo(x+Math.cos(a)*r2,y+Math.sin(a)*r2);c.stroke()}}
else if(k.type=='fert'){let bo=0;for(const q of PL)if(q.run)bo=Math.max(bo,state.gauss(k.n-q.dp,.85));const hw=(6.5+2.5*bo)*p;c.strokeStyle=state.ik(.8+.2*bo);c.lineWidth=1.4+1.1*bo;c.beginPath();c.moveTo(x-hw,y+MG.LN);c.lineTo(x+hw,y+MG.LN);c.stroke();c.fillStyle=state.ik(.8+.2*bo);[-1,1].forEach(o=>{c.beginPath();c.arc(x+o*hw,y+MG.LN,1.3+.7*bo,0,7);c.fill()})}if(k.sf&&!k.type){const br=.5+.5*Math.sin(t*1.9+k.n);c.fillStyle=state.ik((.2+.22*br)*p);for(let q=0;q<3;q++){const a=t*.45+q*2.1+k.n,r=15.2+1.4*q+Math.sin(t+q)*.6;c.beginPath();c.arc(x+Math.cos(a)*r,y+Math.sin(a)*r,1.1,0,7);c.fill()}}}
if(k.gh){const a=(t-k.gh.t0)/1.15;if(a>=1)k.gh=null;else if(a>=0){const e=1-Math.pow(1-a,3),kd=k.gh.kind;if(!k.gh.sp){k.gh.sp=1;if(kd!='fade'&&Math.abs(L.x)<state.W*.5){const pt=ptC(k,L);dust(pt[0],pt[1],kd=='cut'?4:5)}}
if(kd!='fade'){c.fillStyle=state.ik(.95*(1-e));c.beginPath();c.arc(x,y,R*(1-e),0,7);c.fill()}
c.strokeStyle=state.ik(.8*(1-a));c.lineWidth=1.3*(1-a)+.4;c.beginPath();c.arc(x,y,R*(kd=='fade'?1+.6*e:.25+1.5*e),0,7);c.stroke();
if(kd=='cut'){c.lineWidth=1.2;c.strokeStyle=state.ik(.9*(1-a));c.beginPath();c.moveTo(x-9-9*e,y+9+9*e);c.lineTo(x+9+9*e,y-9-9*e);c.stroke()}
if(kd=='out'){c.lineWidth=.8;c.strokeStyle=state.ik(.7*(1-a));for(let q=0;q<8;q++){const an=q*Math.PI/4,r1=R*(1-e)+3,r2=r1+10*(1-e);c.beginPath();c.moveTo(x+Math.cos(an)*r1,y+Math.sin(an)*r1);c.lineTo(x+Math.cos(an)*r2,y+Math.sin(an)*r2);c.stroke()}}}}if(k.n==TODAY){c.strokeStyle=state.ik(.95);c.lineWidth=1;c.beginPath();c.arc(x,y,MG.RT,0,7);c.stroke();const a=t*1.3;c.fillStyle=state.ik(1);c.beginPath();c.arc(x+Math.cos(a)*MG.RT,y+Math.sin(a)*MG.RT,1.8,0,7);c.fill()}}

const at=dd=>{const i=Math.floor(dd+1e-9),f=dd-i,a=L.byN[i],b=L.byN[i+1];let x,y,al=1;
if(a&&b){if(a.row==b.row){x=state.lerp(a.x,b.x,f);y=a.y}else if(f<.5){x=a.x+state.cw*.7*f*2;y=a.y;al=1-f*2}else{x=b.x-state.cw*.7*(1-(f-.5)*2);y=b.y;al=(f-.5)*2}}else if(a){x=a.x+f*state.cw;y=a.y;al=1-f}else if(b){x=b.x-(1-f)*state.cw;y=b.y;al=f}else return null;return{x,y:y+MG.LN,al:state.clamp(al)}};
// less-certain dots come only from the service's follicular windows (phase kept by core.parse); luteal stays merged into the legend
for(const w of core.m.seg.lc)if(w.phase=='follicular')for(let n=w.s;n<=w.e;n++){const k=L.byN[n];if(!k||k.type)continue;c.fillStyle=state.ik(.28*state.clamp(k.p));c.beginPath();c.arc(k.x,k.y+MG.LN,1.1,0,7);c.fill()}
// M.cyc draws the ovulation comet's path only — an animation, not a data segment; it docks on the ring's lower edge instead of lifting into the numeral
for(const q of PL){const cy=q.cy;const lift=dd=>{const z=state.clamp(dd-(cy.ov-1));return z*z*(3-2*z)};
if(q.run){const fi=state.clamp(q.u/.05),h=at(q.dp);if(h){for(let j=10;j>=1;j--){const dd=q.dp-j*.14;if(dd<cy.pe)continue;const z=at(dd);if(!z)continue;c.fillStyle=state.ik((1-j/11)*z.al*.85*fi);c.beginPath();c.arc(z.x,z.y-MG.LN*lift(dd),3.8*(1-j/13),0,7);c.fill()}
const hy=h.y-MG.LN*lift(q.dp),g=c.createRadialGradient(h.x,hy,0,h.x,hy,22);g.addColorStop(0,state.ik(.8*h.al*fi));g.addColorStop(.35,state.ik(.22*h.al*fi));g.addColorStop(1,state.ik(0));c.fillStyle=g;c.fillRect(h.x-22,hy-22,44,44);c.fillStyle=state.ik(h.al*fi);c.beginPath();c.arc(h.x,hy,4.3,0,7);c.fill();c.strokeStyle=state.ik(.55*h.al*fi);c.lineWidth=.8;c.beginPath();c.arc(h.x,hy,7.5+1.5*Math.sin(t*9),0,7);c.stroke()}}
else if(q.age<2.6){const k=L.byN[cy.ov];if(!k)continue;const age=q.age,a=state.clamp(age/2.4),e=1-Math.pow(1-a,3),x=k.x,y=k.y;
if(age<.5&&Math.abs(L.x)<state.W*.4&&!FIRED.has(q.key)){FIRED.add(q.key);if(FIRED.size>40)FIRED.clear();state.wave(...ptC(k,L))}
const R=26+42*e,g=ef.createRadialGradient(x,y,Math.min(14,R*.54),x,y,R);g.addColorStop(0,state.ik(0));g.addColorStop(.2,state.ik(.62*(1-a)));g.addColorStop(1,state.ik(0));ef.fillStyle=g;ef.fillRect(x-R,y-R,R*2,R*2);fxUsed=true;
for(let j=0;j<3;j++){const aj=state.clamp((age-j*.24)/1.5);if(aj<=0||aj>=1)continue;ef.strokeStyle=state.ik(.75*(1-aj));ef.lineWidth=1.3*(1-aj)+.4;ef.beginPath();ef.arc(x,y,20+48*(1-Math.pow(1-aj,3)),0,7);ef.stroke()}
for(let m=0;m<16;m++){const ang=m*Math.PI/8+age*.35,lg=m%2==0,r1=20+(lg?34:24)*e,r2=r1+(lg?14:9)*(1-a);ef.strokeStyle=state.ik((1-a)*(lg?.95:.6));ef.lineWidth=lg?1.3:.8;ef.beginPath();ef.moveTo(x+Math.cos(ang)*r1,y+Math.sin(ang)*r1);ef.lineTo(x+Math.cos(ang)*r2,y+Math.sin(ang)*r2);ef.stroke()}}}
c.restore();ef.restore();
// the burst keeps its full radius; a soft rim fade replaces the hard canvas cut
if(fxUsed){ef.setTransform(state.dpr,0,0,state.dpr,0,0);ef.globalCompositeOperation='destination-in';
const F=22;let fg=ef.createLinearGradient(0,0,0,F);fg.addColorStop(0,'rgba(0,0,0,0)');fg.addColorStop(1,'rgba(0,0,0,1)');ef.fillStyle=fg;ef.fillRect(0,0,state.cw*7,CH);
fg=ef.createLinearGradient(0,CH-F,0,CH);fg.addColorStop(0,'rgba(0,0,0,1)');fg.addColorStop(1,'rgba(0,0,0,0)');ef.fillStyle=fg;ef.fillRect(0,0,state.cw*7,CH);
fg=ef.createLinearGradient(0,0,F,0);fg.addColorStop(0,'rgba(0,0,0,0)');fg.addColorStop(1,'rgba(0,0,0,1)');ef.fillStyle=fg;ef.fillRect(0,0,state.cw*7,CH);
fg=ef.createLinearGradient(state.cw*7-F,0,state.cw*7,0);fg.addColorStop(0,'rgba(0,0,0,1)');fg.addColorStop(1,'rgba(0,0,0,0)');ef.fillStyle=fg;ef.fillRect(0,0,state.cw*7,CH);
ef.globalCompositeOperation='source-over';c.drawImage(fxc,0,0,state.cw*7,CH)}}
// the glass lens that melts from date to date
function lens(L,dt){const k=state.sel!=null&&L.byN[state.sel],on=k&&state.pOpen&&!state.dragging&&Math.abs(L.x)<state.W*.5;if(k&&L.ls<.03){L.lx=k.x;L.ly=k.y;L.lvx=L.lvy=0}
if(k){L.lvx+=((k.x-L.lx)*260-L.lvx*22)*dt;L.lvy+=((k.y-L.ly)*260-L.lvy*22)*dt;L.lx+=L.lvx*dt;L.ly+=L.lvy*dt}
L.ls+=((on?1:0)-L.ls)*(1-Math.exp(-dt*(on?11:14)));const sx=1+state.clamp(Math.hypot(L.lvx,L.lvy)/1500,0,.22),s=Math.max(0,L.ls),ang=Math.atan2(L.lvy,L.lvx)*57.3;
L.ln.style.visibility=s>.02?'visible':'hidden';L.ln.style.transform=`translate3d(${(L.lx-23).toFixed(1)}px,${(L.ly-23).toFixed(1)}px,0) rotate(${ang.toFixed(0)}deg) scale(${(s*sx).toFixed(3)},${(s/sx).toFixed(3)}) rotate(${(-ang).toFixed(0)}deg)`}
function layout(){state.L3.forEach((L,i)=>{L.x=state.off+(i-1)*state.W;L.el.style.transform=`translate3d(${L.x.toFixed(1)}px,0,0)`;const v=Math.abs(state.offV);L.el.style.filter=v>260?`blur(${state.clamp((v-260)*.0016,0,2.2).toFixed(2)}px)`:'none'})}
function setMonthTitle(dir){state.roll(state.$('#mt'),`${MN[state.view.m]}<small>${state.view.y}</small>`,dir);state.$('#tdy').classList.toggle('hide',state.view.y==state.TDY&&state.view.m==state.TDM);/* [data-layer] derived from TODAY */state.$('#pv').disabled=!canGo(-1);state.$('#nx').disabled=!canGo(1);state.$('#pv').style.opacity=canGo(-1)?1:.35;state.$('#nx').style.opacity=canGo(1)?1:.35;state.unm()}
function mount(){state.L3.forEach(L=>L.el.remove());state.L3=[build(shift(state.view,-1)),build(state.view),build(shift(state.view,1))]}
function commit(dir){state.view=shift(state.view,dir);if(dir>0){state.L3[0].el.remove();state.L3=[state.L3[1],state.L3[2],build(shift(state.view,1))]}else{state.L3[2].el.remove();state.L3=[build(shift(state.view,-1)),state.L3[0],state.L3[1]]}state.off=0;state.offV=0;state.tgt=0;setMonthTitle(dir);const r=state.cal.getBoundingClientRect();state.wave(innerWidth/2,r.top+CH/2);state.buzz(7)}
function go(dir){if(!canGo(dir)){state.offV=-dir*-300;return}state.tgt=-dir*state.W}
function jump(v){const d=mIdx(v)-mIdx(state.view);if(!d)return;const old=state.L3[1];if(d>0){state.L3[0].el.remove();state.L3[2].el.remove();state.view=v;state.L3=[old,build(state.view),build(shift(state.view,1))];state.off=state.W}else{state.L3[0].el.remove();state.L3[2].el.remove();state.view=v;state.L3=[build(shift(state.view,-1)),build(state.view),old];state.off=-state.W}state.offV=0;state.tgt=0;setMonthTitle(d>0?1:-1)}
state.$('#pv').onclick=()=>go(-1);state.$('#nx').onclick=()=>go(1);state.$('#tdy').onclick=()=>jump({y:state.TDY,m:state.TDM});/* [data-layer] derived from TODAY */state.addEventListener('keydown',e=>{if(/^(TEXTAREA|INPUT)$/.test(e.target.tagName))return;if(e.key=='ArrowLeft')go(-1);if(e.key=='ArrowRight')go(1);if(e.key=='Escape')state.detail.closeP()});
const dust=(x,y,n=5)=>{if(state.reduce)return;for(let i=0;i<n;i++)state.motes.push({x,y,t0:state.now+.1+state.rnd(i,7)*.35,dur:1.3+state.rnd(i,8)*.9,ti:Math.floor(state.rnd(i+state.now*7,9)*state.S.length)%state.S.length,cx:(state.rnd(i,3)-.5)*90})};
return {mount,commit,go,jump,setMonthTitle,sizeLayer,refresh,drawLayer,lens,layout,canGo};
};
