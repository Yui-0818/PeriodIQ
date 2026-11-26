/* ------------------------------------------------------------------
   1 角色：You 页设备设置、主题与外观：提醒总开关、分项、天数行星、时间拨盘与 applyTheme/setAppearance；Appearance 面板内的语言说明（English-only）
   2 依赖：core、PG、state（state.ST/state.now/state.appearance/state.mq/state.TAU/state.fmtH/state.reduce 等共享值）。
   3 暴露：YouSettings(core,PG,state) → {paintSettings,selDays,dials}。
   4 不变量：开关/拨盘读写 api.settings 的顺序、aria 更新与触感反馈不变；主题块（applyTheme/setAppearance/[data-ap]/mq change）参数与顺序不变；拨盘绘制参数逐字保留。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/you.js 第 51–55（主题块）、56–86 行为唯一基线。
   6 禁止改动项：不得改选择器/aria/文案/几何常量/时长/缓动/分支顺序（语言块除外）；不得调翻译函数、不得直写本地存储、不得加字典；不得新增依赖或挂 window；无 import/export/新增全局。
   迁自：demo@1cd5082 js/pages/you.js 第 51–55、56–86 行
   3.1.3 变更：语言轨道（zh-CN/en/es 三选一）实际从未翻译页面，已替换为 English-only 静态说明，避免无效切换；其余逐字保留
   ------------------------------------------------------------------ */
const YouSettings = (core, PG, state) => {
// ---------- appearance: theme spreads from the touched body
// 设备级主题（Android 收尾轮）：选择落盘到**已存在的原生键** app_settings.theme（与 GET/PUT
// /device/settings 同一存储）；宿主在文档起始处把它注入 window.__piqThemeMode ⇒ 冷启动首帧即恢复
// 上次选择。提醒八键经 core.platform.settingsBridge 走原生桥（映射集中在 platform.js），
// api.domain.js 在 Android 上逐键写入并以原生返回值为准；Win/mock 行为不变。
// 无原生键（web/win 开发环境）时保持原有的内存切换。
const t=(k,v)=>core.i18n.t(k,v);
const apLabel=m=>({light:t('you.light'),dark:t('you.dark'),system:t('you.system')}[m]||t('you.dark'));
// System 的"当前系统明暗"：宿主在 uiMode 变化时经 piq-system-theme 事件同步（见 app.js）——
// 自行消化配置变化的 Activity 不会让 WebView 重算 prefers-color-scheme，matchMedia 会停在旧值。
const sysDark=()=>typeof window.__piqSystemDark==='boolean'?window.__piqSystemDark:state.mq.matches;
function persistTheme(m){
try{const b=window.PIQNative;if(!b||typeof b.setSetting!=='function')return null;
const raw=b.setSetting('app_settings.theme',m);const r=raw?JSON.parse(raw):null;return !!(r&&r.ok)}catch(_){return false}}
function applyTheme(dark,x,y){try{window.PIQNative&&window.PIQNative.setTheme&&window.PIQNative.setTheme(!!dark)}catch(_){}core.setTheme(dark,x,y)}
function setAppearance(m,x,y){
// 原生写失败 ⇒ 不应用、不改 aria（不留"看着切换了其实没存"）；宿主侧已用 Toast 说明。
if(core.platform&&core.platform.kind()==='android'&&persistTheme(m)===false){console.warn('[piq-theme] persist-failed|mode='+m);return}
window.__piqThemeMode=m;state.appearance=m;applyTheme(m=='dark'||(m=='system'&&sysDark()),x,y);
state.$$('[data-ap]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.ap==m));state.setState(0,apLabel(m));state.wave(x,y);state.pulseAt(x,y,1.2);core.buzz(8)}
state.$$('[data-ap]').forEach(b=>b.onclick=()=>{const r=b.getBoundingClientRect();setAppearance(b.dataset.ap,r.left+r.width/2,r.top+r.height/2)});
// 恢复上次选择：标签/aria 与首帧主题对齐（未选过时 appearance='dark'，与既有暗色首屏一致）
state.$$('[data-ap]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.ap==state.appearance));state.setState(0,apLabel(state.appearance));
{const dark=state.appearance=='dark'||(state.appearance=='system'&&sysDark());if((state.root.dataset.theme=='dark')!==dark)applyTheme(dark,innerWidth/2,innerHeight/2)}
state.mq.addEventListener&&state.mq.addEventListener('change',()=>{if(state.appearance=='system')applyTheme(sysDark(),innerWidth/2,innerHeight/2)});
// System 模式在回到前台时再对一次（后台期间系统深色开关可能已经变了）
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.appearance=='system')applyTheme(sysDark(),innerWidth/2,innerHeight/2)});
// ---------- device settings: every control reads and writes core.api.settings() (GET / PUT /device/settings)
state.ST=core.api.settings().data;
const nmain=state.$('#nmain'),swRows=state.$$('.orow[data-k]'),orb=state.$('#orb5'),pl2=orb.querySelector('.pl2'),dbtn=[...orb.querySelectorAll('button')];
async function putSet(patch){const r=await core.api.settings(patch);if(r.ok){state.ST=r.data;state.say('#nstat','')}else{state.say('#nstat',r.message||t('you.saveSetFail'));state.say('#nsay',r.message||'')}return r.ok}
function selDays(d,anim){dbtn.forEach(b=>b.setAttribute('aria-checked',+b.dataset.d==d));const b=dbtn.find(x=>+x.dataset.d==d);if(!b)return;pl2.style.transition=anim===false||state.reduce?'none':'';pl2.style.transform=`translateX(${b.offsetLeft}px)`}
function paintSettings(anim){const on=!!state.ST.reminder_master,lbl=on?t('you.remindOn'):t('you.remindOff');nmain.setAttribute('aria-checked',on);state.$('#nz').classList.toggle('off',!on);state.$('#nlab').textContent=lbl;state.setState(1,lbl);
swRows.forEach(b=>b.setAttribute('aria-checked',!!state.ST[b.dataset.k]));state.$('#dgx').classList.toggle('on',!!state.ST.reminder_advance);selDays(state.ST.reminder_days,anim);
dials[0].set(state.ST.reminder_trio_hour,true);dials[1].set(state.ST.reminder_fill_hour,true);dials[0].dimT=(state.ST.reminder_advance||state.ST.reminder_on_day||state.ST.reminder_overdue)?1:.38;dials[1].dimT=state.ST.reminder_daily_fill?1:.38}
// 权限框是异步的：授予后开关保持 true；拒绝时原生回滚为 false。开启后轮询重读落盘值，
// 让页面在拒绝那一刻就把开关画回关闭并给出可见提示（不依赖用户自己滚动到 #nsay）。
// 用户可能在系统弹窗上停留任意久：前 10 秒每 500ms 复查（保留原有快速拒绝表现），
// 之后放慢到 1s / 2s，最长约 5 分钟；页面重新可见时也强制重同步一次。
let permWatch=0;
function stopPermWatch(){clearTimeout(permWatch);permWatch=0}
function syncPerm(announce){const cur=core.api.settings().data,was=!!state.ST.reminder_master;state.ST=cur;paintSettings();if(announce&&was&&!cur.reminder_master)state.say('#nstat',t('you.permDenied'));return !cur.reminder_master}
function watchPermission(){stopPermWatch();let n=0;
const step=()=>{permWatch=0;const cur=core.api.settings().data;
// 原生回滚（拒绝）⇒ 立刻把 UI 画回 Off 并给可见提示；授予则继续等用户关掉弹窗
if(!cur.reminder_master){state.ST=cur;paintSettings();state.say('#nstat',t('you.permDenied'));return}
if(++n>=330)return;const wait=n<=20?500:n<=80?1000:2000;permWatch=setTimeout(step,wait)};
permWatch=setTimeout(step,500)}
document.addEventListener('visibilitychange',()=>{if(document.hidden)return;stopPermWatch();syncPerm(true)});
nmain.onclick=async()=>{if(!await putSet({reminder_master:!state.ST.reminder_master}))return;paintSettings();const p=state.pos(nmain);state.wave(p.x-60,p.y);state.pulseAt(p.x-60,p.y,.9);core.buzz(state.ST.reminder_master?[8,30,8]:6);if(state.ST.reminder_master)watchPermission();else stopPermWatch()};
swRows.forEach(b=>b.onclick=async()=>{const k=b.dataset.k;if(!await putSet({[k]:!state.ST[k]}))return;paintSettings();const p=state.pos(b.querySelector('.tk2'));state.wave(p.x,p.y);state.pulseAt(p.x,p.y,.6);core.buzz(6)});
dbtn.forEach(b=>b.onclick=async()=>{const d=+b.dataset.d;if(d==state.ST.reminder_days)return;if(!await putSet({reminder_days:d}))return;selDays(d);const p=state.pos(b);state.wave(p.x,p.y);state.pulseAt(p.x,p.y,.6);core.buzz(6)});
// the two time controls are orbits: drag the planet round its ring (hour 0-23). Noon sits at the top, midnight at the bottom.
function Dial(cv,cfg){const d={cv,c:cv.getContext('2d'),v:cfg.v,ang:0,vel:0,hold:false,s:0,dim:1,dimT:1,rings:[],req:0},th=h=>-Math.PI/2+(h-12)/24*state.TAU,wr=a=>((a+Math.PI)%state.TAU+state.TAU)%state.TAU-Math.PI;d.ang=th(cfg.v);
d.size=()=>{d.s=cv.clientWidth;cv.width=Math.round(d.s*state.dpr);cv.height=Math.round(d.s*state.dpr)};
d.set=(h,silent)=>{h=((Math.round(h)%24)+24)%24;const ch=h!==d.v;d.v=h;cv.setAttribute('aria-valuenow',h);cv.setAttribute('aria-valuetext',state.fmtH(h));cfg.label.textContent=state.fmtH(h);if(ch&&!silent){d.rings.push({t:state.now,a:th(h)});core.buzz(4);const token=++d.req,p=cfg.on(h);if(p&&typeof p.then==='function'){const revert=()=>{if(token!==d.req)return;const v=state.ST[cfg.key];if(typeof v==='number')d.set(v,true)};p.then(ok=>{if(!ok)revert()},revert)}}};
const at=e=>{const b=cv.getBoundingClientRect();return Math.atan2(e.clientY-(b.top+b.height/2),e.clientX-(b.left+b.width/2))},hr=a=>(a+Math.PI/2)/state.TAU*24+12;
cv.addEventListener('pointerdown',e=>{d.hold=true;try{cv.setPointerCapture(e.pointerId)}catch(_){}d.set(hr(at(e)));try{cv.focus({preventScroll:true})}catch(_){}});
cv.addEventListener('pointermove',e=>{if(d.hold)d.set(hr(at(e)))});['pointerup','pointercancel'].forEach(k=>cv.addEventListener(k,()=>d.hold=false));
cv.addEventListener('keydown',e=>{const k=e.key,m={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1,PageUp:3,PageDown:-3}[k];if(m){d.set(d.v+m);e.preventDefault()}else if(k=='Home'){d.set(0);e.preventDefault()}else if(k=='End'){d.set(23);e.preventDefault()}});
d.draw=(t,dt)=>{const cw=cv.clientWidth;if(cw&&Math.abs(cw-d.s)>.5)d.size();const s=d.s;if(!s)return;const c=d.c,cx=s/2,R=s*.32;d.vel+=(wr(th(d.v)-d.ang)*(state.reduce?900:170)-d.vel*(state.reduce?60:15))*dt;d.ang+=d.vel*dt;d.dim+=(d.dimT-d.dim)*(1-Math.exp(-dt*6));const A=d.dim,T=state.reduce?0:t;
c.globalCompositeOperation='source-over';c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,cv.width,cv.height);c.setTransform(state.dpr,0,0,state.dpr,0,0);c.lineCap='round';c.lineWidth=1;c.strokeStyle=state.ik(.55*A);c.beginPath();c.arc(cx,cx,R,-Math.PI,0);c.stroke();c.strokeStyle=state.ik(.2*A);c.beginPath();c.arc(cx,cx,R,0,Math.PI);c.stroke();
c.setLineDash([1,4]);c.strokeStyle=state.ik(.28*A);c.beginPath();c.arc(cx,cx,R*.62,0,7);c.stroke();c.setLineDash([]);for(let i=0;i<3;i++){const a=T*(.25+.08*i)+i*2.1;c.fillStyle=state.ik(.5*A);c.beginPath();c.arc(cx+Math.cos(a)*R*.62,cx+Math.sin(a)*R*.62,1.6,0,7);c.fill()}
for(let h=0;h<24;h++){const a=th(h),g=state.gauss(wr(a-d.ang),.28),maj=h%6==0,l=(maj?9:5)+8*g;c.strokeStyle=state.ik((.34+.6*g+(maj?.2:0))*A);c.lineWidth=maj?1.4:.8;c.beginPath();c.moveTo(cx+Math.cos(a)*(R+3),cx+Math.sin(a)*(R+3));c.lineTo(cx+Math.cos(a)*(R+3+l),cx+Math.sin(a)*(R+3+l));c.stroke()}
const tl=.8+Math.min(1.2,Math.abs(d.vel)*.3);for(let q=0;q<18;q++){const u=1-q/18;c.strokeStyle=state.ik(.8*u*A);c.lineWidth=2.4*u+.4;c.beginPath();c.arc(cx,cx,R,d.ang-(q+1)/18*tl,d.ang-q/18*tl);c.stroke()}
const x=cx+Math.cos(d.ang)*R,y=cx+Math.sin(d.ang)*R,gr=c.createRadialGradient(x,y,0,x,y,26);gr.addColorStop(0,state.ik(.55*A));gr.addColorStop(1,state.ik(0));c.fillStyle=gr;c.fillRect(x-26,y-26,52,52);
for(let i=0;i<5;i++){const a=T*3+i*1.257;c.fillStyle=state.ik(.7*A);c.beginPath();c.arc(x+Math.cos(a)*14,y+Math.sin(a)*14,1.1,0,7);c.fill()}
c.fillStyle=state.ik(A);state.sp(c,x,y,d.hold?11:8.5,1);d.rings=d.rings.filter(r=>t-r.t<.9);for(const r of d.rings){const a=t-r.t;c.strokeStyle=state.ik(.6*(1-a/.9)*A);c.lineWidth=1;c.beginPath();c.arc(cx+Math.cos(r.a)*R,cx+Math.sin(r.a)*R,8+a*60,0,7);c.stroke()}
const h=d.v,gy=cx-R*.36;c.fillStyle=state.ik(.85*A);if(h>=6&&h<18)state.sp(c,cx,gy,6,1);else{c.beginPath();c.arc(cx,gy,5,0,state.TAU);c.fill();c.globalCompositeOperation='destination-out';c.beginPath();c.arc(cx+2.6,gy-1.6,4.4,0,state.TAU);c.fill();c.globalCompositeOperation='source-over'}
c.fillStyle=state.ik(A);c.font=`800 ${(s*.19).toFixed(1)}px Inter,'Noto Sans SC',system-ui,sans-serif`;c.textAlign='center';c.textBaseline='middle';
const en=core.i18n.locale()==='en';
if(en){c.fillText(String(h%12||12),cx,cx+s*.02);c.fillStyle=state.ik(.6*A);c.font=`700 ${(s*.07).toFixed(1)}px Inter,'Noto Sans SC',system-ui,sans-serif`;c.fillText(h<12?'AM':'PM',cx,cx+s*.15)}
else{c.fillText(String(h).padStart(2,'0'),cx,cx+s*.02);c.fillStyle=state.ik(.6*A);c.font=`700 ${(s*.07).toFixed(1)}px Inter,'Noto Sans SC',system-ui,sans-serif`;c.fillText(':00',cx,cx+s*.15)}};return d}
const dials=[Dial(state.$('#dl1'),{v:state.ST.reminder_trio_hour,label:state.$('#dv1'),key:'reminder_trio_hour',on:h=>putSet({reminder_trio_hour:h})}),Dial(state.$('#dl2'),{v:state.ST.reminder_fill_hour,label:state.$('#dv2'),key:'reminder_fill_hour',on:h=>putSet({reminder_fill_hour:h})})];
// ---------- B7R-1 language: three language bodies orbit the person-star inside the Appearance sheet (.sc, after .hint).
const LANGS=[['zh-CN','简体中文'],['en','English'],['es','Español']],I=core.i18n,lsc=state.$$('.sat[data-i="0"] .sc')[0],RX=96,RY=38,CY=60,G=state.TAU/3,FRONT=Math.PI/2;
let lg=null,shown='en',th=FRONT,tg=FRONT,vel=0,raf=0,lt=0,inited=false;
if(I&&lsc){lg=lsc.querySelector('.x-lang');if(!lg){lg=document.createElement('div');lg.className='blk x-lang rvl';lg.style.setProperty('--k',2);
lg.innerHTML='<div class="eb" data-i18n="you.lang">Language</div><div class="x-orbit" role="radiogroup" data-i18n-attr="aria-label:you.langAria" aria-label="Language"><i class="x-trk" aria-hidden="true"></i><i class="x-sun" aria-hidden="true"></i>'+LANGS.map(l=>`<button type="button" class="x-moon" role="radio" aria-checked="false" tabindex="-1" data-lang="${l[0]}" lang="${l[0]}"><i class="x-dot"></i><b>${l[1]}</b><small class="x-code" aria-hidden="true">${l[0]}</small></button>`).join('')+'</div><p class="hint" data-i18n="you.langHint">Saved on this device. Your choice applies across the app right away and survives restarts.</p>';lsc.appendChild(lg);try{I.applyDom(lg)}catch(_){}}}
const opts=()=>[...lg.querySelectorAll('.x-moon')];
function lay(){if(!lg)return;opts().forEach((b,i)=>{const p=th+i*G,d=(Math.sin(p)+1)/2,st=b.style;st.left=`calc(50% + ${(Math.cos(p)*RX).toFixed(1)}px)`;st.top=(CY+Math.sin(p)*RY).toFixed(1)+'px';st.transform=`translate(-50%,-12px) scale(${(.7+.3*d).toFixed(3)})`;st.opacity=(.42+.58*d).toFixed(2);st.zIndex=Math.round(d*10)})}
function step(ts){const t=ts/1000,dt=Math.min(.033,lt?t-lt:.016);lt=t;vel+=((tg-th)*190-vel*18)*dt;th+=vel*dt;lay();if(Math.abs(tg-th)<4e-4&&Math.abs(vel)<4e-3){th=tg;vel=0;raf=0;lay();return}raf=requestAnimationFrame(step)}
function turn(i,snap){const to=FRONT-i*G,d=to-tg;tg+=d-state.TAU*Math.round(d/state.TAU);if(snap||state.reduce){th=tg;vel=0;lay();return}if(!raf){lt=0;raf=requestAnimationFrame(step)}}
function paintLang(code,fx){if(!lg)return;const i=Math.max(0,LANGS.findIndex(l=>l[0]==code)),o=opts();o.forEach((b,k)=>{b.setAttribute('aria-checked',k==i);b.tabIndex=k==i?0:-1});turn(i,!inited);inited=true;
if(fx&&!state.reduce){const sun=lg.querySelector('.x-sun'),dot=o[i].querySelector('.x-dot');if(sun.animate)sun.animate([{transform:'scale(1)'},{transform:'scale(1.8)',offset:.3},{transform:'scale(.92)',offset:.65},{transform:'scale(1)'}],{duration:820,easing:'ease-out'});if(dot.animate)dot.animate([{transform:'scale(1)'},{transform:'scale(1.9,.6)',offset:.28},{transform:'scale(.9,1.14)',offset:.62},{transform:'scale(1)'}],{duration:820,easing:'ease-out'})}}
function pickLang(code,btn){const was=shown;shown=I.setLocale(code);paintLang(shown,shown!=was);if(shown!=was){const p=state.pos(btn);state.wave(p.x,p.y);state.pulseAt(p.x,p.y,.7);core.buzz(8)}}
const syncLang=()=>{if(lg){shown=I.locale();paintLang(shown)}};
if(lg){opts().forEach(b=>b.onclick=()=>pickLang(b.dataset.lang,b));
lg.querySelector('.x-orbit').onkeydown=e=>{const o=opts(),m={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key],f=o.indexOf(e.target.closest('.x-moon'));let k=f<0?0:f;if(m)k=(k+m+o.length)%o.length;else if(e.key=='Home')k=0;else if(e.key=='End')k=o.length-1;else return;e.preventDefault();pickLang(o[k].dataset.lang,o[k]);o[k].focus()};
try{core.on('lang',syncLang)}catch(_){}
syncLang()}
return {paintSettings:a=>{paintSettings(a);syncLang()},selDays,dials};
};
