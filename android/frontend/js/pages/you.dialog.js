/* ------------------------------------------------------------------
   1 角色：You 页事件视界对话框：密码/按住擦除/两步确认与 canvas 动效，并向主文件提供 wipe 所需 DOM 引用
   2 依赖：core、PG、state（state.dS/state.hp/state.settings/state.transfer 等装配面）。
   3 暴露：YouDialog(core,PG,state) → {showDlg,closeDlg,drawDlg,drawSec,fitCv} + wipe 用 DOM 引用 dstep/dh/dpx/sec/demo/dok/dno/derr。
   4 不变量：dialog 的 aria/inert 恢复、焦点回送、两步确认与失败重试路径不变；绘制参数逐字保留。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/you.js 第 216–260、262 行为唯一基线（drawFx 留主文件）。
   6 禁止改动项：不得改选择器/文案/aria/时长/缓动/分支顺序；不得新增依赖或挂 window；不得合并/拆分函数体。
   迁自：demo@1cd5082 js/pages/you.js 第 216–260、262 行
   ------------------------------------------------------------------ */
const YouDialog = (core, PG, state) => {
// ---------- the event horizon: one dialog for everything irreversible or password-gated (import overwrite, keep signed in, change password, delete account)
const dlg=state.$('#dlg'),dgi=dlg.querySelector('.dgi'),dh=state.$('#dh'),dpx=state.$('#dmsg'),dstep=state.$('#dstep'),dano=state.$('#dano'),sec=state.$('#sec'),secin=state.$('#secin'),secc=state.$('#secc'),secx=secc.getContext('2d'),derr=state.$('#derr'),hb=state.$('#hold'),dok=state.$('#dok'),dno=state.$('#dno'),dgc=state.$('#dgc'),dgx=dgc.getContext('2d'),demo=state.$('#demo');
state.dS=null;let dO={x:.5,y:.5},SKs=[],ghosts=[],secErr=-9,secGo=-9,secW=300,dgW=394,dgH=660;
const DP=Array.from({length:72},(_,i)=>({a:state.rnd(i,1)*state.TAU,r:30+state.rnd(i,2)*330,w:(.2+state.rnd(i,3)*.6)*(i%2?1:-1),z:state.rnd(i,4)}));
const TT=(v,key,tvars)=>key?core.i18n.t(key,tvars):(v==null?'':v);
// [data-layer] auth.state() stays sync; real mode returns demo_password:'' so the demo password
// line is hidden, while the file:// mock keeps its demo1234 hint.
function demoHint(secret){const dp=core.api.auth.state().demo_password;return secret&&dp?core.i18n.t('you.demoPw',{pw:dp}):''}
function dlgTexts(o){const K=o.K||{};dstep.textContent=TT(o.step,K.step);dh.textContent=TT(o.title,K.title);dpx.textContent=TT(o.text,K.text,K.tvars);dok.textContent=TT(o.ok,K.ok)||core.i18n.t('ui.confirm');dno.textContent=TT(o.no,K.no)||core.i18n.t('ui.cancel');demo.textContent=demoHint(o.secret)}
function repaintDlg(){if(!state.dS)return;dlgTexts(state.dS)}
function paintDlg(o){dlgTexts(o);dano.innerHTML=(o.anomalies||[]).map(a=>`<div>${state.esc(a)}</div>`).join('');sec.classList.toggle('on',!!o.secret);derr.textContent='';hb.hidden=!o.hold;dok.hidden=!!o.hold;dno.hidden=false;secin.value='';SKs.length=0;ghosts.length=0;state.hp=0;hb.style.setProperty('--p',0)}
function showDlg(o,swap){swap=swap??dlg.classList.contains('on');const prev=state.dS;state.dS=o;o.held=false;o.busy=false;o.opener=o.opener||(prev&&prev.opener)||(o.origin&&o.origin.el);if(!o.origin)o.origin=prev&&prev.origin;
if(swap){if(state.reduce){paintDlg(o)}else dgi.animate([{opacity:1,filter:'blur(0)'},{opacity:0,filter:'blur(10px)'}],{duration:200}).onfinish=()=>{paintDlg(o);dgi.animate([{opacity:0,filter:'blur(10px)'},{opacity:1,filter:'blur(0)'}],{duration:520,easing:'cubic-bezier(.2,.9,.1,1)'});focusDlg()}}
else{paintDlg(o);const sr=state.stage.getBoundingClientRect(),og=o.origin||{x:sr.left+state.W/2,y:sr.top+300};dO={x:og.x-sr.left,y:og.y-sr.top};dlg.style.setProperty('--cx',dO.x+'px');dlg.style.setProperty('--cy',dO.y+'px');dgH=state.stage.clientHeight;fitCv();state.$$('.sat,#pf').forEach(e=>e.inert=true);dlg.inert=false;dlg.setAttribute('aria-hidden','false');dlg.classList.add('on');state.wave(og.x,og.y);state.pulseAt(og.x,og.y,1);core.buzz(12);setTimeout(focusDlg,state.reduce?0:620)}
if(swap&&state.reduce)focusDlg()}
function focusDlg(){if(!state.dS)return;try{(state.dS.secret?secin:state.dS.hold?hb:dok).focus({preventScroll:true})}catch(_){}}
function closeDlg(){if(!state.dS)return;const op=state.dS.opener;state.dS=null;state.holding=false;state.hp=0;dlg.classList.remove('on');dlg.inert=true;dlg.setAttribute('aria-hidden','true');state.$$('.sat,#pf').forEach(e=>e.inert=false);try{op&&op.focus&&op.focus({preventScroll:true})}catch(_){}}
// [data-layer] onOk may now return an auth write Promise. A legacy failure result ALSO has a
// `then` (the delayed retry callback), so the Promise test must require `ok` to be absent.
function runAfter(o,r){if(!r||typeof r.after!=='function')return;setTimeout(function(){try{r.after(o)}catch(_){/* a stale after must never escape as an uncaught error */}},state.reduce?0:o.secret?260:300)}
function failDlg(o,r){o.busy=false;if(state.dS!==o)return;const msg=r&&r.message?r.message:core.errors.text('HTTP_ERROR');secErr=state.now;derr.textContent=msg;derr.animate([{opacity:0,filter:'blur(6px)'},{opacity:1,filter:'blur(0)'}],{duration:420});SKs.forEach(s=>{s.vx+=(state.rnd(s.i,9)-.5)*900;s.vy+=(state.rnd(s.i,8)-.5)*600});const sr=state.stage.getBoundingClientRect();state.wave(sr.left+state.W/2,sr.top+dO.y);state.pulseAt(sr.left+state.W/2,sr.top+dO.y,-.8);core.buzz([30,50,30]);const retry=r&&r.then;if(typeof retry==='function')setTimeout(function(){if(state.dS===o)retry()},1100)}
function finishDlg(o,r){if(!r||typeof r!=='object')r={ok:false,message:core.errors.text('HTTP_ERROR')};
if(!r.ok){failDlg(o,r);return}
if(state.dS===o){if(r.next){showDlg(r.next(),true);return}o.busy=true;secGo=state.now;if(o.secret){const p=dO;state.wave(state.stage.getBoundingClientRect().left+p.x,state.stage.getBoundingClientRect().top+p.y)}core.buzz([8,24,8]);if(!r.keepOpen)setTimeout(function(){if(state.dS===o)closeDlg()},state.reduce?0:o.secret?700:250)}
runAfter(o,r)}
function submit(){const o=state.dS;if(!o||o.busy||o.hold)return;let r;
try{r=o.onOk(o.secret?secin.value:null)}catch(_){failDlg(o,{ok:false,message:core.errors.text('HTTP_ERROR')});return}
const isThenable=r&&typeof r.then==='function'&&typeof r.ok==='undefined';
if(isThenable){o.busy=true;Promise.resolve(r).then(function(v){finishDlg(o,v)},function(){finishDlg(o,{ok:false,message:core.errors.text('HTTP_ERROR')})});return}
finishDlg(o,r)}
dok.onclick=submit;dno.onclick=()=>{const o=state.dS;closeDlg();o&&o.onNo&&o.onNo()};
secin.oninput=()=>{const n=secin.value.length;derr.textContent='';while(SKs.length<n)SKs.push({i:SKs.length+state.rnd(state.now*9,3)*100,x:Math.min(secW-30,26+SKs.length*22),y:56,vx:(state.rnd(SKs.length,5)-.5)*140,vy:-90-state.rnd(SKs.length,6)*90,ph:state.rnd(SKs.length+state.now,1)*state.TAU});while(SKs.length>n){const s=SKs.pop();ghosts.push({x:s.x,y:s.y,vx:s.vx+(state.rnd(n,2)-.5)*80,vy:60,t0:state.now})}};
secin.onkeydown=e=>{if(e.key=='Enter'){e.preventDefault();submit()}};
function drawSec(t,dt){const w=secW,h=76,c=secx,n=SKs.length,pad=26,step=n>1?Math.min(24,(w-2*pad-16)/(n-1)):0,T=state.reduce?0:t,ok=state.now-secGo<.7,er=state.now-secErr<.9;c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,w,h);c.lineCap='round';
c.strokeStyle=state.ib(.4);c.lineWidth=.8;c.setLineDash([1,4]);c.beginPath();c.moveTo(pad,h-14);c.lineTo(w-pad,h-14);c.stroke();c.setLineDash([]);
SKs.forEach((s,i)=>{const tx=ok?w/2:pad+8+i*step,ty=ok?h/2:h/2-4+Math.sin(T*.9+s.ph)*(er?9:5);s.vx+=((tx-s.x)*(ok?60:120)-s.vx*(ok?7:12))*dt;s.vy+=((ty-s.y)*120-s.vy*12)*dt;s.x+=s.vx*dt;s.y+=s.vy*dt});
c.strokeStyle=state.ib(.4);c.lineWidth=.8;c.beginPath();SKs.forEach((s,i)=>i?c.lineTo(s.x,s.y):c.moveTo(s.x,s.y));c.stroke();
SKs.forEach((s,i)=>{const tw=.65+.35*Math.sin(T*2+i*1.7);c.fillStyle=state.ib(tw);if(state.rnd(i,7)>.55)state.sp(c,s.x,s.y,4.5+state.rnd(i,3)*2.5,1);else{c.beginPath();c.arc(s.x,s.y,2+state.rnd(i,4)*1.4,0,7);c.fill()}});
ghosts=ghosts.filter(g=>state.now-g.t0<1);for(const g of ghosts){const a=state.now-g.t0;g.vy+=260*dt;g.x+=g.vx*dt;g.y+=g.vy*dt;c.fillStyle=state.ib(1-a);c.beginPath();c.arc(g.x,g.y,1.6,0,7);c.fill()}
const cxp=n?pad+8+(n-1)*step+16:pad+8,pu=.5+.5*Math.sin(T*3);if(!ok){c.strokeStyle=state.ib(.5+.4*pu);c.lineWidth=1.2;c.beginPath();c.moveTo(cxp,h/2-12);c.lineTo(cxp,h/2+4);c.stroke()}
if(!n){c.fillStyle=state.ib(.45);c.font='600 13px Inter,system-ui,sans-serif';c.textAlign='left';c.textBaseline='middle';c.fillText(core.i18n.t('you.typePw'),cxp+10,h/2-4)}
if(er){const u=(state.now-secErr)/.9;c.strokeStyle=state.ib(.6*(1-u));c.lineWidth=1.2;c.beginPath();c.arc(w/2,h/2,10+u*w*.5,0,7);c.stroke()}
if(ok){const u=(state.now-secGo)/.7;c.strokeStyle=state.ib(.9*(1-u));c.lineWidth=1.4;c.beginPath();c.arc(w/2,h/2,4+u*60,0,7);c.stroke();const g=c.createRadialGradient(w/2,h/2,0,w/2,h/2,26);g.addColorStop(0,state.ib(.9*(1-u)));g.addColorStop(1,state.ib(0));c.fillStyle=g;c.fillRect(w/2-26,h/2-26,52,52)}}
// the singularity behind the dialog: dust spirals into the point you touched; holding to erase pulls it in harder
function drawDlg(t,dt){const w=dgW,h=dgH,c=dgx,ox=dO.x,oy=dO.y,pull=state.dS&&state.dS.hold?state.hp:0,T=state.reduce?0:t;c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,w,h);c.lineCap='round';
for(let k=0;k<3;k++){const r=(70+k*46)*(1-.55*pull)*(1+.04*Math.sin(T*1.1+k*2));c.strokeStyle=state.ib(.22-.05*k+.25*pull);c.lineWidth=.8;c.setLineDash(k?[2,6]:[]);c.beginPath();c.arc(ox,oy,r,0,7);c.stroke()}c.setLineDash([]);
for(const p of DP){if(!state.reduce){p.r-=dt*(5+pull*150)*(.3+p.z);p.a+=p.w*dt*(1+pull*5)*(60/Math.max(14,p.r))*.5;if(p.r<6){p.r=240+state.rnd(p.a*50,3)*160;p.a=state.rnd(p.a*40,5)*state.TAU}}const x=ox+Math.cos(p.a)*p.r,y=oy+Math.sin(p.a)*p.r*.82;c.fillStyle=state.ib((.15+.55*p.z)*state.clamp(p.r/50)*(.5+.5*pull));c.beginPath();c.arc(x,y,.6+p.z*1.3,0,7);c.fill()}
if(pull>.02){const g=c.createRadialGradient(ox,oy,0,ox,oy,60+80*pull);g.addColorStop(0,state.ib(.55*pull));g.addColorStop(1,state.ib(0));c.fillStyle=g;c.fillRect(ox-140,oy-140,280,280)}}
function fitCv(){state.settings.dials.forEach(d=>d.size());const aw=state.transfer.air.clientWidth||300;state.transfer.air.width=Math.round(aw*state.dpr);state.transfer.air.height=Math.round(58*state.dpr);secW=sec.clientWidth||300;secc.width=Math.round(secW*state.dpr);secc.height=Math.round(76*state.dpr);dgW=state.stage.clientWidth||394;dgH=state.stage.clientHeight||660;dgc.width=Math.round(dgW*state.dpr);dgc.height=Math.round(dgH*state.dpr);state.settings.selDays(state.ST.reminder_days,false)}
state.hb=hb;
return {showDlg,closeDlg,repaintDlg,drawDlg,drawSec,fitCv,dstep,dh,dpx,sec,demo,dok,dno,derr};
};
