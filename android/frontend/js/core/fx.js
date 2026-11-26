/* ===== fx.js =====
 * 1 角色：lens 折射滤镜注入与 FX overlay（warp/ring/bloom/orb）渲染循环。
 * 2 依赖：state.js（root/reduce/clamp/rnd）、DOM 元素 #fx 与 #lens。
 * 3 暴露：dmEl,fxc,fxx,fxl,fxRun,ink,dpr,readInk,eo,fxSize,fxAdd,fxLoop（顶层，不挂 window）。
 * 4 不变量：reduce 开启时 fxAdd 直接返回；dpr 上限 2；同一时刻只有一个 rAF 循环；滤镜只注入一次。
 * 5 契约来源：无（纯装配/视觉基础设施）。
 * 6 禁止改动项：动画时长、颜色/线宽公式、选择器、SVG/filter 字符串、时序。
 */
// ================= lens (refraction) filter, injected once =================
let dmEl=null;
if(/Chrom(e|ium)\//.test(navigator.userAgent)&&!/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)){
const map='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" preserveAspectRatio="none"><defs><linearGradient id="r" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="rgb(0,0,0)"/><stop offset=".1" stop-color="rgb(128,0,0)"/><stop offset=".9" stop-color="rgb(128,0,0)"/><stop offset="1" stop-color="rgb(255,0,0)"/></linearGradient><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="rgb(0,0,0)"/><stop offset=".14" stop-color="rgb(0,128,0)"/><stop offset=".86" stop-color="rgb(0,128,0)"/><stop offset="1" stop-color="rgb(0,255,0)"/></linearGradient></defs><rect width="200" height="200" fill="#000"/><rect width="200" height="200" fill="url(#r)"/><rect width="200" height="200" fill="url(#g)" style="mix-blend-mode:screen"/></svg>';
document.body.insertAdjacentHTML('beforeend','<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="lens" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage href="data:image/svg+xml;charset=utf-8,'+encodeURIComponent(map)+'" preserveAspectRatio="none" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="30" xChannelSelector="R" yChannelSelector="G"/></filter></svg>');
dmEl=document.querySelector('#lens feDisplacementMap');root.classList.add('lens')}
// ================= FX overlay: warp streaks, shock rings, bloom, shared-element orb =================
const fxc=document.getElementById('fx'),fxx=fxc.getContext('2d');let fxl=[],fxRun=false,ink='255,255,255',dpr=1,spInk='';
const fxMob=()=>!document.body.classList.contains('piq-shell')||/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const bloomSp=document.createElement('canvas'),orbSp=document.createElement('canvas');bloomSp.width=bloomSp.height=orbSp.width=orbSp.height=128;
const syncFxSprites=()=>{if(spInk===ink)return;spInk=ink;
let c=bloomSp.getContext('2d'),g=c.createRadialGradient(64,64,0,64,64,64);c.clearRect(0,0,128,128);g.addColorStop(0,`rgba(${spInk},1)`);g.addColorStop(1,`rgba(${spInk},0)`);c.fillStyle=g;c.fillRect(0,0,128,128);
c=orbSp.getContext('2d');g=c.createRadialGradient(64,64,0,64,64,64);c.clearRect(0,0,128,128);g.addColorStop(0,`rgba(${spInk},.95)`);g.addColorStop(.3,`rgba(${spInk},.3)`);g.addColorStop(1,`rgba(${spInk},0)`);c.fillStyle=g;c.fillRect(0,0,128,128)};
const readInk=()=>ink=getComputedStyle(root).getPropertyValue('--ink').trim(),eo=u=>1-Math.pow(1-u,3);
// ================= GPU-composited liquid glass specular & rim light (mobile) =================
let glSpUrl='',glRmUrl='',glRmInk='';
const glMakeUrl=(fn)=>{const cv=document.createElement('canvas');cv.width=cv.height=128;fn(cv.getContext('2d'));return cv.toDataURL()};
const syncGlSprites=()=>{
if(!glSpUrl){const hl=getComputedStyle(root).getPropertyValue('--hl').trim()||'255,255,255';glSpUrl=glMakeUrl(c=>{const g=c.createRadialGradient(64,64,0,64,64,40);g.addColorStop(0,`rgba(${hl},.26)`);g.addColorStop(1,`rgba(${hl},0)`);c.fillStyle=g;c.fillRect(0,0,128,128)})}
if(glRmInk!==ink){glRmInk=ink;glRmUrl=glMakeUrl(c=>{const g=c.createConicGradient(-Math.PI/2,64,64);g.addColorStop(0,`rgba(${ink},.95)`);g.addColorStop(.2,`rgba(${ink},0)`);g.addColorStop(.5,`rgba(${ink},.34)`);g.addColorStop(.7,`rgba(${ink},0)`);g.addColorStop(1,`rgba(${ink},.95)`);c.fillStyle=g;c.fillRect(0,0,128,128)});document.querySelectorAll('img.gl-r').forEach(el=>{el.src=glRmUrl})}};
const fxSize = function fxSize(){dpr=fxMob()?1:Math.min(devicePixelRatio||1,2);fxc.width=innerWidth*dpr;fxc.height=innerHeight*dpr};
const fxAdd = function fxAdd(o){if(reduce)return;o.t0=performance.now();fxl.push(o);if(!fxRun){fxRun=true;fxSize();requestAnimationFrame(fxLoop)}};
const fxLoop = function fxLoop(){const c=fxx,W=innerWidth,H=innerHeight,t=performance.now(),mob=fxMob(),wn=mob?64:90;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,W,H);c.lineCap='round';
fxl=fxl.filter(o=>{const u=(t-o.t0)/o.dur;if(u>=1){o.done&&o.done();return false}if(u<0)return true;const e=eo(u),Rm=Math.hypot(W,H)*.7;
if(o.type=='warp'){for(let k=0;k<wn;k++){const a=rnd(k,1)*6.2832,r0=Rm*e*(.12+.5*rnd(k,2)),ln=Rm*(.04+.22*rnd(k,3))*Math.sin(Math.PI*Math.min(1,u*1.15));c.strokeStyle=`rgba(${ink},${(1-u)*(.18+.6*rnd(k,4))})`;c.lineWidth=.6+rnd(k,5)*1.1;c.beginPath();c.moveTo(o.x+Math.cos(a)*r0,o.y+Math.sin(a)*r0);c.lineTo(o.x+Math.cos(a)*(r0+ln),o.y+Math.sin(a)*(r0+ln));c.stroke()}}
else if(o.type=='ring'){for(let j=0;j<3;j++){const uj=clamp((u-j*.1)/.9);if(uj<=0)continue;c.strokeStyle=`rgba(${ink},${(1-uj)*.55})`;c.lineWidth=1.4*(1-uj)+.5;c.beginPath();c.arc(o.x,o.y,Rm*.9*eo(uj),0,7);c.stroke()}}
else if(o.type=='bloom'){const r=Rm*.5*e+40;syncFxSprites();c.globalAlpha=clamp((1-u)*.4);c.drawImage(bloomSp,o.x-r,o.y-r,r*2,r*2);c.globalAlpha=1}
else if(o.type=='orb'){const f=o.from,t2=o.to,cx=(f.x+t2.x)/2+(f.y-t2.y)*.25,cy=Math.min(f.y,t2.y)-60,at=q=>{const v=1-q;return[v*v*f.x+2*v*q*cx+q*q*t2.x,v*v*f.y+2*v*q*cy+q*q*t2.y]},uu=eo(u*1.0);
for(let j=14;j>=1;j--){const q=Math.max(0,uu-j*.022),p=at(q);c.fillStyle=`rgba(${ink},${(1-j/15)*.7})`;c.beginPath();c.arc(p[0],p[1],5*(1-j/16),0,7);c.fill()}
const p=at(uu);syncFxSprites();c.drawImage(orbSp,p[0]-34,p[1]-34,68,68);c.fillStyle=`rgba(${ink},1)`;c.beginPath();c.arc(p[0],p[1],5.5,0,7);c.fill()}
return true});
if(fxl.length)requestAnimationFrame(fxLoop);else{fxRun=false;c.clearRect(0,0,W,H)}};
const glMob=()=>!document.body.classList.contains('piq-shell');
const glassLight=function glassLight(el,px,py,ang,w,h){
if(!el)return;
if(!glMob()){el.style.setProperty('--px',px.toFixed(0)+'px');el.style.setProperty('--py',py.toFixed(0)+'px');el.style.setProperty('--ang',ang.toFixed(0)+'deg');return}
syncGlSprites();
let g=el._gl;
if(!g){const sw=document.createElement('i'),s=document.createElement('img'),rw=document.createElement('i'),r=document.createElement('img');sw.className='gl-sw';sw.setAttribute('aria-hidden','true');s.className='gl-s';s.alt='';s.decoding='sync';s.src=glSpUrl;sw.append(s);rw.className='gl-rw';rw.setAttribute('aria-hidden','true');r.className='gl-r';r.alt='';r.decoding='sync';r.src=glRmUrl;rw.append(r);el.append(sw,rw);el.classList.add('gl-gpu');g=el._gl={s,r,d:420,px:NaN,py:NaN,ang:NaN}}
let dChg=false;
if(w&&h){const need=Math.ceil(Math.hypot(w,h))+16;if(need>g.d){g.d=need;dChg=true}}
if(isFinite(px)&&isFinite(py)&&(Math.abs(px-g.px)>=.15||Math.abs(py-g.py)>=.15||isNaN(g.px))){g.px=px;g.py=py;g.s.style.transform=`translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) scale(4.0625)`}
if(isFinite(ang)&&(dChg||Math.abs(ang-g.ang)>=.15||isNaN(g.ang))){g.ang=ang;g.r.style.transform=`scale(${(g.d/128).toFixed(3)}) rotate(${ang.toFixed(1)}deg)`}};
const glassLightReset=function glassLightReset(el){
if(!el)return;
if(!glMob()){el.style.removeProperty('--px');el.style.removeProperty('--py');el.style.removeProperty('--ang');return}
const g=el._gl;if(!g)return;g.px=NaN;g.py=NaN;g.ang=NaN;g.s.style.transform='';g.r.style.transform=''};
