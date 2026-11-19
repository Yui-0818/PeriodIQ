/* ------------------------------------------------------------------
   1 Role: B9 auth gate controller. Shows #pg-auth when core.api.auth.state().authed is false, keeps
     #app inert and #dock hidden meanwhile, runs the sign-in / create-account form, and paints the
     threshold (starfield canvas + a glass lens holding an iris that opens as the form fills).
   2 Depends on: core (on, api.auth.state/login/register, optional buzz); the #pg-auth shell,
     base.css .glass and auth.css. main.js emits core.emit('auth', state) after bootstrap.
   3 Exposes: boot_auth(core?) -> {sync,show,hide,setMode,mode}; called once at load. show/hide
     are test hooks only (they do not change auth state). No other global.
   4 Invariants: the gate follows auth.state().authed only; login/register ok is never trusted
     alone (authed is verified, then location.reload()); no token read, no storage, no new API,
     no data-layer write; only one of #app / #pg-auth is interactive at any time.
   5 Contract source: 早期记录 (auth gate); api.auth.js state machine; api.domain.js
     completeLogin; main.js startup order; you.js signOut flows.
   6 Forbidden: no edits to AUTH, api.* internals or the shell DOM; no storage, no t(), no import
     or export, no new dependency, no new dock tab or page.
   ------------------------------------------------------------------ */
function boot_auth(c){
if(boot_auth.ctl)return boot_auth.ctl;
const K=c||(typeof core!=='undefined'?core:null),doc=document,root=doc.documentElement,pg=doc.getElementById('pg-auth');
if(!K||typeof K.on!=='function'||!pg)return null;
const $=s=>pg.querySelector(s),app=doc.getElementById('app'),cv=$('#asky'),wrap=$('.auth-wrap'),hd=$('.auth-hd'),card=$('#auth-card'),ttl=$('#auth-title'),sub=$('#auth-sub'),host=$('#auth-form'),msg=$('#auth-msg');
if(!cv||!wrap||!card||!ttl||!sub||!host||!msg||!cv.getContext)return null;
const g=cv.getContext('2d'),TAU=Math.PI*2,clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),lerp=(a,b,t)=>a+(b-a)*t,f=v=>Math.round(v*100)/100,perf=()=>performance.now()/1000;
const rnd=(i,k)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)};
const rmq=matchMedia('(prefers-reduced-motion:reduce)');let reduce=rmq.matches;
const COPY={login:{t:'Welcome back',s:'Use your username and password to open your sky.',go:'Enter',sw:'Create account'},register:{t:'Begin your sky',s:'Choose how you sign in. Your nickname is how the app greets you.',go:'Create and enter',sw:'Back to sign in'}};

// ---------- build: hero lens (iris) before the card, form inside #auth-form
const hero=doc.createElement('div');hero.className='x-hero';hero.setAttribute('aria-hidden','true');
hero.innerHTML='<div class="x-lens glass"><svg class="x-iris" viewBox="-100 -100 200 200" focusable="false"><defs><radialGradient id="x-iris-g"><stop class="x-s0" offset="0"/><stop class="x-s1" offset="1"/></radialGradient></defs><circle class="x-flare" r="60"/><circle class="x-ring" r="92"/><circle class="x-tgt" r="56"/><path class="x-bl2"/><path class="x-bl"/><circle class="x-hole" r="6"/><path class="x-orb"/><path class="x-ldr" d="M39.6 -39.6L62 -64L104 -64"/><path class="x-core"/></svg><span class="x-note">closed</span></div>';
wrap.insertBefore(hero,card);
host.innerHTML='<form class="x-form" id="x-form" novalidate aria-labelledby="auth-title">'+
'<div class="x-row" style="--i:0"><label class="x-fl" for="x-u">Username</label><input class="x-in" id="x-u" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" aria-describedby="auth-msg"></div>'+
'<div class="x-row" id="x-nr" style="--i:1" hidden><label class="x-fl" for="x-n">Nickname<span class="x-opt">optional</span></label><input class="x-in" id="x-n" name="nickname" type="text" autocomplete="nickname" maxlength="24" enterkeyhint="next" aria-describedby="auth-msg"></div>'+
'<div class="x-row" style="--i:2"><label class="x-fl" for="x-p">Password</label><input class="x-in" id="x-p" name="password" type="password" autocomplete="current-password" autocapitalize="none" enterkeyhint="go" aria-describedby="auth-msg"><button class="x-rv" id="x-rv" type="button" aria-controls="x-p" aria-pressed="false" aria-label="Show password">Show</button></div>'+
'<label class="x-keep" id="x-kr" for="x-k"><input class="x-ck" id="x-k" name="keep" type="checkbox"><span class="x-box" aria-hidden="true"></span><span class="x-kt">Keep me signed in</span><span class="x-hint">this device only</span></label>'+
'<button class="x-go glass" id="x-go" type="submit"><span class="x-gl">Enter</span></button>'+
'<button class="x-sw" id="x-sw" type="button">Create account</button></form>';
const lens=hero.firstChild,note=$('.x-note'),bl=$('.x-bl'),bl2=$('.x-bl2'),hole=$('.x-hole'),orb=$('.x-orb'),core_=$('.x-core'),flare=$('.x-flare'),
form=$('#x-form'),u=$('#x-u'),nk=$('#x-n'),pw=$('#x-p'),kp=$('#x-k'),rv=$('#x-rv'),nr=$('#x-nr'),kr=$('#x-kr'),go=$('#x-go'),gl=$('.x-gl'),sw=$('#x-sw');

// ---------- state
let popT=0,mode='login',shown=false,busy=false,leaving=false,errUntil=0,outT=0,errT=0,shownAt=0,prevFocus=null,raf=0,last=0,q=1,slow=0,ema=.016;
let op=.04,opv=0,opT=.1,rot=0,spin=.05,intro=0,px=.5,py=.4,spx=.5,spy=.4,lastMove=-9,rx=0,ry=0,rg=0,ink='255,255,255',sty=[];
let W=0,H=0,dpr=1,N=0,sx,sy,sz,sph;const waves=[];
let LR={left:0,top:0,width:1,height:1},GR={left:0,top:0,width:1,height:1},CR={left:0,right:0,top:0,bottom:0};

// ---------- small helpers
const authed=d=>{try{const s=K.api.auth.state();return !!(s&&s.authed)}catch(_){return d}};
function cacheInk(){const cs=getComputedStyle(root);ink=cs.getPropertyValue('--ink').trim()||'255,255,255';sty=[];for(let i=0;i<16;i++)sty.push('rgba('+ink+','+(i/15).toFixed(3)+')');dirty()}
function flick(el,txt,instant){if(el.textContent===txt)return;if(reduce||instant||!shown){el.textContent=txt;return}el.animate([{opacity:1,filter:'blur(0)'},{opacity:0,filter:'blur(10px)'}],{duration:200}).onfinish=()=>{el.textContent=txt;el.animate([{opacity:0,filter:'blur(10px)'},{opacity:1,filter:'blur(0)'}],{duration:520,easing:'cubic-bezier(.2,.9,.1,1)'})}}
function setMsg(t){msg.textContent=t||'';if(t&&!reduce)msg.animate([{opacity:0,filter:'blur(6px)'},{opacity:1,filter:'blur(0)'}],{duration:520,easing:'cubic-bezier(.2,.9,.1,1)'})}
function clearBad(){form.querySelectorAll('.x-bad').forEach(r=>r.classList.remove('x-bad'));[u,nk,pw].forEach(i=>i.removeAttribute('aria-invalid'))}
function buzz(p){try{K.buzz&&K.buzz(p)}catch(_){}}
function wave(x,y,k){if(reduce||!shown)return;waves.push({x,y,t:perf(),k:k||1});if(waves.length>8)waves.shift();schedule()}
function rects(){LR=lens.getBoundingClientRect();GR=go.getBoundingClientRect();CR=card.getBoundingClientRect()}
const lc=()=>({x:LR.left+LR.width/2,y:LR.top+LR.height/2});

// ---------- the gate opens as the form fills; target openness + state word
function target(){
  const n=(u.value.trim()?1:0)+(pw.value?1:0);let t=.1+.26*n,w=n===2?'ready':n?'aligning':'closed';
  if(leaving){t=1;w='open'}else if(busy){t=.62;w='entering'}else if(errUntil>perf()){t=.14;w='closed'}
  opT=t;if(note.textContent!==w)note.textContent=w;dirty();
}

// ---------- sky: stars react to the pointer and to gravity waves from touches and actions
function size(){
  dpr=Math.min(devicePixelRatio||1,2)*(q<1?.75:1);W=pg.clientWidth;H=pg.clientHeight;if(!W||!H)return;
  cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
  N=Math.round(clamp(W*H/2600,70,220)*q);sx=new Float32Array(N);sy=new Float32Array(N);sz=new Float32Array(N);sph=new Float32Array(N);
  for(let i=0;i<N;i++){sx[i]=rnd(i,1);sy[i]=rnd(i,2);sz[i]=Math.pow(rnd(i,3),1.6);sph[i]=rnd(i,4)}
  dirty();
}
function ripple(x,y,t){rx=ry=rg=0;for(let i=0;i<waves.length;i++){const w=waves[i],age=t-w.t;if(age<0||age>3.4)continue;const dx=x-w.x,dy=y-w.y,d=Math.hypot(dx,dy)+.001,u2=d-age*430,a=w.k*Math.exp(-u2*u2/1568)*Math.exp(-age*1.15)/(1+d/300);rx+=dx/d*a*15;ry+=dy/d*a*15;rg+=Math.abs(a)}}
function sky(t){
  g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);
  const c0=lc(),ei=1-Math.pow(1-intro,3),warp=1+(1-ei)*.45,po=(spx-.5)*-16,qo=(spy-.5)*-16,cl=CR.left-14,cr=CR.right+14,ct=CR.top-6,cb=CR.bottom+6;
  for(let i=0;i<N;i++){
    let x=sx[i]*W+po*sz[i],y=sy[i]*H+qo*sz[i];x=c0.x+(x-c0.x)*warp;y=c0.y+(y-c0.y)*warp;
    ripple(x,y,t);x+=rx;y+=ry;
    let a=(.2+.62*sz[i])*(.72+.28*Math.sin(t*(.5+sph[i]*.4)+sph[i]*6.28))+rg*.55;
    if(x>cl&&x<cr&&y>ct&&y<cb)a*=.22;
    a*=ei;if(a<.03)continue;
    g.fillStyle=sty[Math.min(15,a*16|0)];const r=.45+sz[i]*.95;
    if(r>.95){g.beginPath();g.arc(x,y,r,0,TAU);g.fill()}else g.fillRect(x-r,y-r,r*2,r*2);
  }
}

// ---------- the iris: tangent blades around an opening, a dashed ring where it will open, one star core
function iris(t){
  const o=op,rho=clamp(4+52*o,3,66),R=92,s=Math.sqrt(R*R-rho*rho);let d='',d2='',dd='';
  for(let i=0;i<8;i++){const a=rot+i*TAU/8,cs=Math.cos(a),sn=Math.sin(a),tx=rho*cs,ty=rho*sn;d+='M'+f(tx)+' '+f(ty)+'L'+f(tx-s*sn)+' '+f(ty+s*cs)}
  const R2=R*.8,r2=Math.min(rho*.62+8,R2-4),s2=Math.sqrt(R2*R2-r2*r2);
  for(let i=0;i<8;i++){const a=-rot*.7+(i+.5)*TAU/8,cs=Math.cos(a),sn=Math.sin(a),tx=r2*cs,ty=r2*sn;d2+='M'+f(tx)+' '+f(ty)+'L'+f(tx-s2*sn)+' '+f(ty+s2*cs)}
  for(let j=0;j<12;j++){const b=-rot*.4+j*TAU/12;dd+='M'+f(92*Math.cos(b))+' '+f(92*Math.sin(b))+'l.001 0'}
  const cr=2.5+14*clamp(o,0,1.1)+(reduce?0:Math.sin(t*2.2)*.9);
  bl.setAttribute('d',d);bl2.setAttribute('d',d2);orb.setAttribute('d',dd);hole.setAttribute('r',f(rho));
  core_.setAttribute('d','M0 '+f(-cr)+'Q0 0 '+f(cr)+' 0Q0 0 0 '+f(cr)+'Q0 0 '+f(-cr)+' 0Q0 0 0 '+f(-cr)+'Z');
  flare.setAttribute('r',f(rho*1.25+8));flare.style.opacity=(.14+.6*clamp(o,0,1)).toFixed(3);
}

// ---------- one clock: springs for the gate, gravity for the lens, light on the glass
function frame(ts){
  raf=0;if(!shown||doc.hidden||!W)return;
  const t=ts/1000,rdt=Math.min(.25,last?t-last:.016),dt=Math.min(.033,rdt);last=t;
  if(reduce){op=opT;opv=0;intro=1}else{
    ema+=(rdt-ema)*.08;if(ema>.026&&q>.45&&++slow>45){q*=.7;slow=0;size()}
    intro=Math.min(1,intro+dt*.7);opv+=((opT-op)*170-opv*16)*dt;op+=opv*dt;
    spin+=((busy?1.7:.05+.06*op)-spin)*(1-Math.exp(-dt*4));rot+=spin*dt;
    if(t-lastMove>2.5){px=.5+.3*Math.sin(t*.35);py=.4+.25*Math.cos(t*.27)}spx+=(px-spx)*.07;spy+=(py-spy)*.07;
  }
  sky(reduce?0:t);iris(reduce?0:t);
  const c0=lc();ripple(c0.x,c0.y,t);
  lens.style.transform=reduce?'':'translate('+(rx*.4).toFixed(2)+'px,'+(ry*.4).toFixed(2)+'px) scale('+(1+rg*.045).toFixed(4)+')';
  const gx=spx*W,gy=spy*H;
  light(lens,LR,gx,gy,t);light(go,GR,gx,gy,t);
  if(!reduce||Math.abs(opT-op)>.001)raf=requestAnimationFrame(frame);
}
function light(el,r,gx,gy,t){el.style.setProperty('--px',(gx-r.left).toFixed(0)+'px');el.style.setProperty('--py',(gy-r.top).toFixed(0)+'px');el.style.setProperty('--ang',(busy&&el===go?(t*220)%360:Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90).toFixed(0)+'deg')}
function schedule(){if(shown&&!raf&&!doc.hidden)raf=requestAnimationFrame(frame)}
function dirty(){schedule()}

// ---------- layout: the lens takes whatever height the card leaves free
function measure(){
  if(!shown)return;const hh=hero.clientHeight,hw=wrap.clientWidth;
  pg.style.setProperty('--x-d',Math.round(clamp(Math.min(hh-28,hw*.58,268),112,268))+'px');rects();
}

// ---------- gate visibility: exactly one of #app / #pg-auth is interactive
function sync(){apply(!authed(true)||busy||leaving)}
function apply(vis){if(vis===shown)return;shown=vis;vis?open():close()}
function open(){
  clearTimeout(outT);const ae=doc.activeElement;prevFocus=ae&&ae!==doc.body&&!pg.contains(ae)?ae:prevFocus;
  if(mode!=='login')setMode('login',false);
  root.classList.add('x-gated');
  if(app){app.setAttribute('inert','');app.setAttribute('aria-hidden','true')}
  pg.removeAttribute('inert');pg.setAttribute('aria-hidden','false');pg.classList.remove('x-out');pg.classList.add('x-on');
  shownAt=perf();intro=0;op=.04;opv=0;last=0;waves.length=0;cacheInk();size();measure();target();schedule();clearTimeout(popT);popT=setTimeout(rects,1600);
  try{u.focus({preventScroll:true})}catch(_){}
}
function close(){
  root.classList.remove('x-gated');
  if(app){app.removeAttribute('inert');app.removeAttribute('aria-hidden')}
  pg.setAttribute('aria-hidden','true');pg.setAttribute('inert','');
  pw.value='';nk.value='';hidePw();setMsg('');clearBad();setMode('login',false);
  if(reduce||perf()-shownAt<.32){pg.classList.remove('x-on','x-out');cancelAnimationFrame(raf);raf=0}
  else{pg.classList.add('x-out');outT=setTimeout(()=>{pg.classList.remove('x-on','x-out');cancelAnimationFrame(raf);raf=0},440)}
  const p=prevFocus;prevFocus=null;if(p&&doc.contains(p)&&!pg.contains(p)){try{p.focus({preventScroll:true})}catch(_){}}
}

// ---------- modes: same threshold, another inscription
function setMode(m,user){
  const reg=m==='register',C=COPY[m];if(m===mode&&!user&&form.dataset.x)return;form.dataset.x='1';mode=m;
  pg.classList.toggle('x-reg',reg);nr.hidden=!reg;kr.hidden=reg;pw.setAttribute('autocomplete',reg?'new-password':'current-password');
  flick(ttl,C.t);flick(sub,C.s);flick(sw,C.sw);if(!busy)flick(gl,C.go);
  pw.value='';nk.value='';hidePw();setMsg('');clearBad();target();
  if(shown){measure();if(user){const r=sw.getBoundingClientRect();wave(r.left+r.width/2,r.top+r.height/2,1.1);buzz(8);(u.value.trim()?(reg?nk:pw):u).focus({preventScroll:true})}}
}
function hidePw(){pw.type='password';rv.textContent='Show';rv.setAttribute('aria-pressed','false');rv.setAttribute('aria-label','Show password')}
rv.onclick=()=>{const on=pw.type==='password',a=pw.selectionStart,b=pw.selectionEnd;pw.type=on?'text':'password';rv.textContent=on?'Hide':'Show';rv.setAttribute('aria-pressed',on);rv.setAttribute('aria-label',on?'Hide password':'Show password');pw.focus({preventScroll:true});try{pw.setSelectionRange(a,b)}catch(_){}};
sw.onclick=()=>setMode(mode==='login'?'register':'login',true);

// ---------- submit: login/register, then verify authed before reloading (never trust ok alone)
function setBusy(b){busy=b;form.setAttribute('aria-busy',b);[go,sw,rv,kp].forEach(e=>e.disabled=b);[u,nk,pw].forEach(i=>i.readOnly=b);pg.classList.toggle('x-busy',b);flick(gl,b?'Entering…':COPY[mode].go,true);target()}
function fail(){errUntil=perf()+.9;target();clearTimeout(errT);errT=setTimeout(target,950);if(!reduce){card.animate([{transform:'translateX(0)'},{transform:'translateX(-9px)'},{transform:'translateX(7px)'},{transform:'translateX(-4px)'},{transform:'translateX(0)'}],{duration:420,easing:'cubic-bezier(.2,.9,.1,1)'});const c0=lc();wave(c0.x,c0.y,-1.3)}buzz([12,40,12])}
function bad(el,text){clearBad();const row=el.closest('.x-row');if(row)row.classList.add('x-bad');el.setAttribute('aria-invalid','true');setMsg(text);fail();el.focus()}
async function submit(e){
  e.preventDefault();if(busy||leaving)return;
  const reg=mode==='register',user=u.value.trim(),pass=pw.value,nick=nk.value.trim();clearBad();
  if(!user)return bad(u,reg?'Choose a username.':'Enter your username.');
  if(!pass)return bad(pw,reg?'Choose a password.':'Enter your password.');
  setMsg('');setBusy(true);let r=null;
  try{r=reg?await K.api.auth.register(user,pass,nick||undefined):await K.api.auth.login(user,pass,kp.checked)}catch(_){r=null}
  setBusy(false);
  if(!r||!r.ok){setMsg((r&&r.message)||'Something went wrong. Check your connection and try again.');fail();pw.focus();return}
  if(!authed(false)){setMsg('Your session could not be kept. Please try again.');fail();pw.focus();return}
  leaving=true;target();setMsg('');const c0=lc();wave(c0.x,c0.y,2.4);buzz(14);
  setTimeout(()=>location.reload(),reduce?0:620);
}
form.addEventListener('submit',submit);
[u,nk].forEach(i=>i.addEventListener('keydown',e=>{if(e.key!=='Enter'||busy)return;const nx=i===u&&mode==='register'?nk:pw;if(nx===pw&&pw.value)return;e.preventDefault();nx.focus()}));
form.addEventListener('input',e=>{if(e.target.removeAttribute)e.target.removeAttribute('aria-invalid');const r=e.target.closest&&e.target.closest('.x-row');if(r)r.classList.remove('x-bad');if(msg.textContent&&!busy)setMsg('');target()});
form.addEventListener('focusin',e=>{if(!shown||!e.target.closest('.x-row'))return;const r=e.target.getBoundingClientRect();wave(r.left+r.width/2,r.top+r.height/2,.55)});
kp.addEventListener('change',()=>{const r=kp.parentNode.getBoundingClientRect();wave(r.left+22,r.top+r.height/2,.8);buzz(6)});

// ---------- pointer light + gravity waves from the touch origin
pg.addEventListener('pointerdown',e=>{if(shown)wave(e.clientX,e.clientY,1)},{passive:true});
pg.addEventListener('pointermove',e=>{if(!W)return;px=e.clientX/W;py=e.clientY/H;lastMove=perf()},{passive:true});
wrap.addEventListener('scroll',()=>{rects();dirty()},{passive:true});

// ---------- environment: resize, keyboard, theme, reduced motion, tab visibility
function onResize(){if(!shown)return;size();measure()}
addEventListener('resize',onResize);
if('ResizeObserver' in window){new ResizeObserver(()=>{if(shown){measure();dirty()}}).observe(hero)}
if(window.visualViewport){const vv=visualViewport,kb=()=>pg.style.setProperty('--x-kb',Math.max(0,Math.round(innerHeight-vv.height-vv.offsetTop))+'px');vv.addEventListener('resize',()=>{kb();if(shown)measure()});vv.addEventListener('scroll',kb)}
if('MutationObserver' in window)new MutationObserver(cacheInk).observe(root,{attributes:true,attributeFilter:['data-theme']});
const dq=matchMedia('(prefers-color-scheme:dark)'),onScheme=()=>cacheInk();dq.addEventListener?dq.addEventListener('change',onScheme):dq.addListener(onScheme);
const onRm=()=>{reduce=rmq.matches;if(reduce){lens.style.transform='';waves.length=0}dirty()};rmq.addEventListener?rmq.addEventListener('change',onRm):rmq.addListener(onRm);
doc.addEventListener('visibilitychange',()=>{if(shown&&!doc.hidden){last=0;schedule()}});

// ---------- start: bind to the auth event, then sync once
const ctl={sync,show:()=>apply(true),hide:()=>apply(false),setMode:m=>setMode(m==='register'?'register':'login',false),mode:()=>mode};
boot_auth.ctl=ctl;setMode('login',false);K.on('auth',sync);sync();
return ctl;
}
(function(){const go=()=>{if(typeof core!=='undefined')boot_auth(core)};document.readyState==='loading'?document.addEventListener('DOMContentLoaded',go,{once:true}):go()})();
