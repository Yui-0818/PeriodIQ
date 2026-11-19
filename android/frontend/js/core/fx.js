/* ===== fx.js =====
 * 1 角色：lens 折射滤镜注入与 FX overlay（warp/ring/bloom/orb）渲染循环。
 * 2 依赖：state.js（root/reduce/clamp/rnd）、DOM 元素 #fx 与 #lens。
 * 3 暴露：dmEl,fxc,fxx,fxl,fxRun,ink,dpr,readInk,eo,fxSize,fxAdd,fxLoop（顶层，不挂 window）。
 * 4 不变量：reduce 开启时 fxAdd 直接返回；dpr 上限 2；同一时刻只有一个 rAF 循环；滤镜只注入一次。
 * 5 契约来源：无（纯装配/视觉基础设施）。
 * 6 禁止改动项：动画时长、颜色/线宽公式、选择器、SVG/filter 字符串、时序。
 * 迁自：前端demo/app拆解版@1cd5082 js/core.js 第 136–156 行
 */
// ================= lens (refraction) filter, injected once =================
let dmEl=null;
if(/Chrom(e|ium)\//.test(navigator.userAgent)&&!/iPhone|iPad|iPod/.test(navigator.userAgent)){
const map='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" preserveAspectRatio="none"><defs><linearGradient id="r" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="rgb(0,0,0)"/><stop offset=".1" stop-color="rgb(128,0,0)"/><stop offset=".9" stop-color="rgb(128,0,0)"/><stop offset="1" stop-color="rgb(255,0,0)"/></linearGradient><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="rgb(0,0,0)"/><stop offset=".14" stop-color="rgb(0,128,0)"/><stop offset=".86" stop-color="rgb(0,128,0)"/><stop offset="1" stop-color="rgb(0,255,0)"/></linearGradient></defs><rect width="200" height="200" fill="#000"/><rect width="200" height="200" fill="url(#r)"/><rect width="200" height="200" fill="url(#g)" style="mix-blend-mode:screen"/></svg>';
document.body.insertAdjacentHTML('beforeend','<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="lens" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage href="data:image/svg+xml;charset=utf-8,'+encodeURIComponent(map)+'" preserveAspectRatio="none" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="30" xChannelSelector="R" yChannelSelector="G"/></filter></svg>');
dmEl=document.querySelector('#lens feDisplacementMap');root.classList.add('lens')}
// ================= FX overlay: warp streaks, shock rings, bloom, shared-element orb =================
const fxc=document.getElementById('fx'),fxx=fxc.getContext('2d');let fxl=[],fxRun=false,ink='255,255,255',dpr=1;
const readInk=()=>ink=getComputedStyle(root).getPropertyValue('--ink').trim(),eo=u=>1-Math.pow(1-u,3);
const fxSize = function fxSize(){dpr=Math.min(devicePixelRatio||1,2);fxc.width=innerWidth*dpr;fxc.height=innerHeight*dpr};
const fxAdd = function fxAdd(o){if(reduce)return;o.t0=performance.now();fxl.push(o);if(!fxRun){fxRun=true;fxSize();requestAnimationFrame(fxLoop)}};
const fxLoop = function fxLoop(){const c=fxx,W=innerWidth,H=innerHeight,t=performance.now();c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,W,H);c.lineCap='round';
fxl=fxl.filter(o=>{const u=(t-o.t0)/o.dur;if(u>=1){o.done&&o.done();return false}if(u<0)return true;const e=eo(u),Rm=Math.hypot(W,H)*.7;
if(o.type=='warp'){for(let k=0;k<90;k++){const a=rnd(k,1)*6.2832,r0=Rm*e*(.12+.5*rnd(k,2)),ln=Rm*(.04+.22*rnd(k,3))*Math.sin(Math.PI*Math.min(1,u*1.15));c.strokeStyle=`rgba(${ink},${(1-u)*(.18+.6*rnd(k,4))})`;c.lineWidth=.6+rnd(k,5)*1.1;c.beginPath();c.moveTo(o.x+Math.cos(a)*r0,o.y+Math.sin(a)*r0);c.lineTo(o.x+Math.cos(a)*(r0+ln),o.y+Math.sin(a)*(r0+ln));c.stroke()}}
else if(o.type=='ring'){for(let j=0;j<3;j++){const uj=clamp((u-j*.1)/.9);if(uj<=0)continue;c.strokeStyle=`rgba(${ink},${(1-uj)*.55})`;c.lineWidth=1.4*(1-uj)+.5;c.beginPath();c.arc(o.x,o.y,Rm*.9*eo(uj),0,7);c.stroke()}}
else if(o.type=='bloom'){const r=Rm*.5*e+40,g=c.createRadialGradient(o.x,o.y,0,o.x,o.y,r);g.addColorStop(0,`rgba(${ink},${(1-u)*.4})`);g.addColorStop(1,`rgba(${ink},0)`);c.fillStyle=g;c.fillRect(o.x-r,o.y-r,r*2,r*2)}
else if(o.type=='orb'){const f=o.from,t2=o.to,cx=(f.x+t2.x)/2+(f.y-t2.y)*.25,cy=Math.min(f.y,t2.y)-60,at=q=>{const v=1-q;return[v*v*f.x+2*v*q*cx+q*q*t2.x,v*v*f.y+2*v*q*cy+q*q*t2.y]},uu=eo(u*1.0);
for(let j=14;j>=1;j--){const q=Math.max(0,uu-j*.022),p=at(q);c.fillStyle=`rgba(${ink},${(1-j/15)*.7})`;c.beginPath();c.arc(p[0],p[1],5*(1-j/16),0,7);c.fill()}
const p=at(uu),g=c.createRadialGradient(p[0],p[1],0,p[0],p[1],34);g.addColorStop(0,`rgba(${ink},.95)`);g.addColorStop(.3,`rgba(${ink},.3)`);g.addColorStop(1,`rgba(${ink},0)`);c.fillStyle=g;c.fillRect(p[0]-34,p[1]-34,68,68);c.fillStyle=`rgba(${ink},1)`;c.beginPath();c.arc(p[0],p[1],5.5,0,7);c.fill()}
return true});
if(fxl.length)requestAnimationFrame(fxLoop);else{fxRun=false;c.clearRect(0,0,W,H)}};
