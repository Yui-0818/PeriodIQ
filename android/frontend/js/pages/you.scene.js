/* ------------------------------------------------------------------
   1 角色：You 页星空与头像绘制（星点/引力透镜/tether + 头像 sigil）
   2 依赖：core、PG、state（state.sats/state.stage/state.avc 等）。
   3 暴露：YouScene(core,PG,state) → {drawSky,drawAv,LKB}。
   4 不变量：星空/头像绘制顺序、引力偏移、颜色与帧时序逐字保留；LKB 仍在原初始化点由主文件调用。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/you.js 第 307–326 行为唯一基线。
   6 禁止改动项：不得改常量/阈值/绘制顺序/时长；不得新增依赖或挂 window。
   迁自：demo@1cd5082 js/pages/you.js 第 307–326 行
   ------------------------------------------------------------------ */
const YouScene = (core, PG, state) => {
function drawAv(t,dt){const c=state.avx,S=104;c.setTransform(state.avc.width/S,0,0,state.avc.width/S,0,0);c.clearRect(0,0,S,S);state.avForm=Math.min(1,state.avForm+dt*(state.reduce?9:.9));const f=1-Math.pow(1-state.avForm,3),cx=52,cy=52,R=36,pts=[];
for(let i=0;i<9;i++){const a=(i/9+.3*state.rnd(i,state.avSeed+3))*6.2832+t*.05,r=.3+.7*state.rnd(i,state.avSeed+7),a0=state.rnd(i,91)*6.2832,fx=cx+Math.cos(a)*r*R,fy=cy+Math.sin(a)*r*R,sx=cx+Math.cos(a0)*52*1.5,sy=cy+Math.sin(a0)*52*1.5;pts.push([state.lerp(sx,fx,f),state.lerp(sy,fy,f),state.rnd(i,state.avSeed+11)])}
c.strokeStyle=state.ik(.5*f);c.lineWidth=.8;c.beginPath();pts.forEach((p,i)=>{i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1])});c.stroke();c.beginPath();[[0,4],[2,6],[1,7]].forEach(([a,b])=>{c.moveTo(pts[a][0],pts[a][1]);c.lineTo(pts[b][0],pts[b][1])});c.globalAlpha=.4*f;c.stroke();c.globalAlpha=1;
pts.forEach((p,i)=>{const tw=.6+.4*Math.sin(t*2+i*1.7);c.fillStyle=state.ik(tw);if(p[2]>.62)state.sp(c,p[0],p[1],4+3*p[2],1);else{c.beginPath();c.arc(p[0],p[1],1.4+p[2]*1.6,0,7);c.fill()}});
c.strokeStyle=state.ik(.18);c.lineWidth=.7;c.setLineDash([1,3]);c.beginPath();c.arc(cx,cy,47,0,7);c.stroke();c.setLineDash([])}
// ---------- sky: stars bend around every mass
const sky=state.$('#sky'),sc=sky.getContext('2d'),S=Array.from({length:230},(_,i)=>({x:state.rnd(i,1),y:state.rnd(i,2),z:.15+state.rnd(i,3)*.85,p:state.rnd(i,4)*6.28,k:state.rnd(i,5)>.93}));
const LK=[];function LKB(){S.forEach((a,i)=>S.forEach((b,j)=>{if(j>i&&a.z>.5&&b.z>.5&&Math.hypot(a.x-b.x,(a.y-b.y)*1.9)<.1&&LK.length<46)LK.push([a,b])}))}
const nebSp=document.createElement('canvas'),corSp=document.createElement('canvas');nebSp.width=nebSp.height=corSp.width=corSp.height=128;let spInk='';
function syncSprites(){if(spInk===state.ink)return;spInk=state.ink;
let c=nebSp.getContext('2d'),g=c.createRadialGradient(64,64,0,64,64,64);c.clearRect(0,0,128,128);g.addColorStop(0,`rgba(${spInk},1)`);g.addColorStop(1,`rgba(${spInk},0)`);c.fillStyle=g;c.fillRect(0,0,128,128);
c=corSp.getContext('2d');g=c.createRadialGradient(64,64,11.3,64,64,64);c.clearRect(0,0,128,128);g.addColorStop(0,`rgba(${spInk},1)`);g.addColorStop(1,`rgba(${spInk},0)`);c.fillStyle=g;c.fillRect(0,0,128,128)}
function drawSky(t){syncSprites();const sr=state.sr||state.stage.getBoundingClientRect(),ms=[{x:sr.left+state.avCX,y:sr.top+state.avCY,r:state.avS/2*1.1}];state.sats.forEach(s=>ms.push({x:sr.left+s.cx,y:sr.top+s.cy,r:Math.min(s.w,s.h)/2}));
const sdpr=state.skyDpr||state.dpr;sc.setTransform(sdpr,0,0,sdpr,0,0);sc.clearRect(0,0,state.SW,state.SH);sc.lineCap='round';const ic=ms[0],lt=state.root.dataset.theme=='light',lb=lt?1.3:1,fo=1-state.pm;
for(let n=0;n<3;n++){const nx=state.SW*(.2+.3*n)+Math.sin(t*.05+n*2)*40-(state.spx-.5)*85,ny=state.SH*(.22+.28*n)-state.scrollY*.06+Math.cos(t*.04+n)*30-(state.spy-.4)*55,nr=state.SW*(.75+.1*n);sc.globalAlpha=.075+.025*n;sc.drawImage(nebSp,nx-nr,ny-nr,nr*2,nr*2)}
{const cR=state.avS*(1.7+.25*Math.sin(t*.7));sc.globalAlpha=.34*(.35+.65*fo);sc.drawImage(corSp,ic.x-cR,ic.y-cR,cR*2,cR*2);sc.globalAlpha=1;sc.lineWidth=.8;
for(let k=0;k<12;k++){const a=k*.5236+t*.05,r1=state.avS*.62,r2=state.avS*(.95+.55*(.5+.5*Math.sin(t*.8+k*1.9)))*(.5+.5*fo);sc.strokeStyle=state.ik(.3*fo);sc.beginPath();sc.moveTo(ic.x+Math.cos(a)*r1,ic.y+Math.sin(a)*r1);sc.lineTo(ic.x+Math.cos(a)*r2,ic.y+Math.sin(a)*r2);sc.stroke()}}
for(const s of S){let x=s.x*state.SW-(state.spx-.5)*48*s.z,y=((s.y*state.SH-state.scrollY*(.04+.2*s.z))%state.SH+state.SH)%state.SH-(state.spy-.5)*48*s.z,a=(.2+.7*s.z)*(.55+.45*Math.sin(t*(.6+s.z)+s.p))*lb,b=0;
for(const m of ms){const dx=x-m.x,dy=y-m.y,R=m.r,rLim=R*3.4;if(Math.abs(dx)<rLim&&Math.abs(dy)<rLim){const d2=dx*dx+dy*dy;if(d2<rLim*rLim){const d=Math.sqrt(d2)+1,o=Math.min(R*.95,R*R*.55/d);x+=dx/d*o;y+=dy/d*o;a+=.5*state.gauss(d-R*1.12,R*.22)}}}
for(const w of state.waves){const age=t-w.t,dx=x-w.x,dy=y-w.y,d=Math.hypot(dx,dy)+1,f=Math.max(0,1-Math.abs(d-age*430)/50)*Math.max(0,1-age/1.5);x+=dx/d*16*f;y+=dy/d*16*f;a+=f*.9;b+=f*2}
if(state.imp>0){x=state.lerp(x,ic.x,state.imp*s.z*.9);y=state.lerp(y,ic.y,state.imp*s.z*.9)}
s.X=x;s.Y=y;sc.fillStyle=state.ik(a);if(s.k)state.sp(sc,x,y,(2.4+3.6*s.z)*(lt?1.3:1)+b,1);else{sc.beginPath();sc.arc(x,y,(.4+s.z*1.1)*(lt?1.35:1)+b*.5,0,7);sc.fill()}}
sc.lineWidth=.6;for(const [a,b] of LK){sc.strokeStyle=state.ik(.15*lb*(.6+.4*Math.sin(t*.8+a.p)));sc.beginPath();sc.moveTo(a.X,a.Y);sc.lineTo(b.X,b.Y);sc.stroke()}
for(const w of state.waves){const age=t-w.t;sc.strokeStyle=state.ik(.22*(1-age/1.5));sc.lineWidth=1;sc.beginPath();sc.arc(w.x,w.y,age*430,0,7);sc.stroke()}state.waves=state.waves.filter(w=>t-w.t<1.5);
state.sats.forEach((s,i)=>{if(s.m>.6)return;const x=sr.left+s.cx,y=sr.top+s.cy,rx=s.w/2,ry=s.h/2,k=(1-s.m)*(1-s.e),a0=t*(.25+.05*i)+s.ph;if(k<.02)return;sc.strokeStyle=state.ik(.34*k);sc.lineWidth=.8;sc.beginPath();sc.ellipse(x,y,rx*1.14,ry*1.14,0,a0,a0+1.1);sc.stroke();sc.beginPath();sc.ellipse(x,y,rx*1.14,ry*1.14,0,a0+Math.PI,a0+Math.PI+.6);sc.stroke();
const ga=t*(.6+.13*i)+s.ph;for(let q=0;q<7;q++){const aa=ga-q*.07;sc.fillStyle=state.ik((.95-q*.13)*k);sc.beginPath();sc.arc(x+Math.cos(aa)*rx*1.04,y+Math.sin(aa)*ry*1.04,2.3-q*.22,0,7);sc.fill()}});
// tethers: hairlines of gravity from the profile to each body
const al=(1-state.pm)*.46*state.clamp(state.intro-.3);if(al>.01){sc.lineWidth=.8;sc.setLineDash([1.5,5]);sc.lineDashOffset=-t*14;state.sats.forEach((s,i)=>{const x=sr.left+s.cx,y=sr.top+s.cy,mx=(ic.x+x)/2,my=(ic.y+y)/2,dx=x-ic.x,dy=y-ic.y,L=Math.hypot(dx,dy)||1,bow=18*Math.sin(t*.6+i*1.3);sc.strokeStyle=state.ik(al);sc.beginPath();sc.moveTo(ic.x,ic.y);sc.quadraticCurveTo(mx-dy/L*bow,my+dx/L*bow,x,y);sc.stroke();sc.fillStyle=state.ik(al*2.4);const qx=mx-dy/L*bow,qy=my+dx/L*bow;for(let k=0;k<3;k++){const u=(t*.2+i*.27+k/3)%1,v=1-u;sc.beginPath();sc.arc(v*v*ic.x+2*v*u*qx+u*u*x,v*v*ic.y+2*v*u*qy+u*u*y,1.6,0,7);sc.fill()}});sc.setLineDash([])}}
state.sky=sky;
return {drawSky,drawAv,LKB};
};
