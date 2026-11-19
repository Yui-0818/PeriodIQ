/* ============================================================================
 * history.js — History page · boot_hist(core,PG)
 * 1 · Role      The archive: records newest first, each a tall segment (1 day = 7px). Scroll = memory
 *               tunnel; tap = flow / pain / mood / symptoms; the "Cycle lengths" drawer = same-day
 *               comparison chart with a draggable scan line.
 * 2 · 迁自      index.html 内联 History 脚本 → js/pages/history.js
 * 3 · Contract  Reads only core.hist(), core.stats().avg, core.m.{fmt,TODAY,FL,seg}. No core.api, no t(),
 *               no libs / URLs / fonts, English copy. Frozen: boot_hist(core,PG) → {size,cacheInk,setSY,
 *               wave,refresh}; every id in #pg-hist; the four data-layer paths.
 * 4 · x- classes  x-empty (0-record block) · x-nil ("not recorded" line) · x-gap (period day without a
 *               flow entry) · x-pk (peak flow day)
 * 5 · Geometry  Nothing is pinned to 28/35 days: LMAX = longest closed cycle drawn; icon pitch 47/LMAX;
 *               chart plot width (w-CX0-8)/LMAX, CX0 measured from the labels, height from the row
 *               count; segment height = COV*PX. Phase words use the average and OV (ovulation sits OV
 *               days before the cycle ends); unknown values stay neutral.
 * 6 · Changes   Round 1: data-derived geometry and copy; "Next period"/"In progress" only when the data
 *               supports them; real 0-record state; null flow/pain, empty mood/sym read as absence; the
 *               oldest record shows real values; focus rings, keyboard scrubber, reduced motion.
 * ========================================================================== */
function boot_hist(core,PG){const PGID='hist';
const $=s=>PG.querySelector(s)||core.dummy(),$$=s=>[...PG.querySelectorAll(s)],root=document.documentElement;
let scrollY=0;const scrollBy=(...a)=>core.isCur(PGID)&&window.scrollBy(...a);
const requestAnimationFrame=f=>core.raf(PGID,f);
const addEventListener=(t,f,o)=>{window.addEventListener(t,e=>{if(core.isCur(PGID))f(e)},o)};
const mq=matchMedia('(prefers-reduced-motion:reduce)');let reduce=mq.matches;mq.addEventListener&&mq.addEventListener('change',e=>{reduce=e.matches});
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),fin=v=>typeof v=='number'&&isFinite(v),
rnd=(i,k=1)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)},gauss=(d,s)=>Math.exp(-d*d/(2*s*s)),
sp=(c,x,y,r,f)=>{c.beginPath();c.moveTo(x,y-r);c.quadraticCurveTo(x,y,x+r,y);c.quadraticCurveTo(x,y,x,y+r);c.quadraticCurveTo(x,y,x-r,y);c.quadraticCurveTo(x,y,x,y-r);f?c.fill():c.stroke()},
pl=(n,w)=>`${n} ${w}${n==1?'':'s'}`,un=(n,w)=>n==1?w:w+'s',nf=n=>String(+n.toFixed(1)),esc=s=>String(s).replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';'),
scr=y=>scrollBy({top:y,behavior:reduce?'auto':'smooth'});
let ink='255,255,255',dpr=1,SW=0,SH=0,now=0,px=.5,py=.4,spx=.5,spy=.4,lastMove=-9,sv=0,lsy=0,waves=[],intro=0,openI=-1,oa=[],dm=null,pulse=null,sd=0,con=0;
const cacheInk=()=>ink=getComputedStyle(root).getPropertyValue('--ink').trim(),ik=a=>`rgba(${ink},${clamp(a)})`,wave=(x,y)=>reduce||waves.push({x,y,t:now});
// lens refraction (Chromium)
dm=core.dm();
addEventListener('pointermove',e=>{px=e.clientX/innerWidth;py=e.clientY/innerHeight;lastMove=now});
// ---- the records: rebuilt from the shared model
const FL=core.m.FL||[],days=n=>core.m.fmt(n,{month:'short',day:'numeric'}),fn=v=>FL[v]||'Level '+v,PX=7,MAXC=3,OV=14;
let R=[],segs=[],ens=[],hds=[],glass=[],TD=0,AV=NaN,NC=0,LMAX=1,OPEN=false,PRED=false,CAP='No complete cycle yet',PN=[],FM=[];const LEN=[],LAB=[],PER=[],RIX=[],COV=[];
const main=$('#main'),topEl=$('#top'),cyc=$('#cyc');
const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('in')),{threshold:.2});io.observe(cyc);io.observe(topEl);
const flv=o=>Array.from({length:Math.max(o.per||0,(o.fl||[]).length)},(_,k)=>fin((o.fl||[])[k])?o.fl[k]:null),logged=o=>(o.fl||[]).some(fin)||fin(o.pain);
const lab=(o,s)=>{if(s==0&&OPEN)return `<span>In progress</span><span>Day ${TD+1}${PRED&&TD<o.segLen?' of '+o.segLen:''}</span>`;
const n=fin(o.len)?o.len:COV[s],e=s?R[s-1].s:o.s+n,a=o.first?core.m.fmt(o.s,{month:'short'}):days(o.s);return `${COV[s]*PX>=120?`<span>${a} → ${days(e)}</span>`:''}<span>${n}-day cycle</span>`};
const seg=s=>{const o=R[s],top=s==0&&OPEN,fs=flv(o).some(v=>v!=null);
return `<div class="sg" data-s="${s}" style="height:${COV[s]*PX}px">${top&&PRED?`<span class="nx">${TD>=o.segLen?'Expected':'Next period'} · ${days(o.s+o.segLen)}</span>`:''}${top?`<div class="td" style="bottom:${Math.max(32,Math.min((TD+.5)*PX-9,COV[s]*PX-56)).toFixed(1)}px">Today<small>${days(core.m.TODAY)} · day ${TD+1}</small></div>`:''}${PN[s]?`<div class="pr"><span>${PN[s]}-day period</span><span>${fs?'Flow, day by day':'Flow not recorded'}</span></div>`:''}<div class="cy${top?' d':''}"></div><div class="cl">${lab(o,s)}</div></div>`};
const mv=(n,w,l)=>`<span class="ms"><span class="mv"><b>${n}</b> ${un(n,w)}</span><span class="ml">${l}</span></span>`;
const ent=(o,i)=>{const F=PN[i]?flv(o):[],lg=F.filter(v=>v!=null),mx=lg.length?Math.max(...lg):null,pk=F.map((v,k)=>mx!=null&&v==mx?k+1:0).filter(Boolean),LV=Math.min(10,FM[i]),
rng=pk.length>1?(pk[pk.length-1]-pk[0]==pk.length-1?pk[0]+'–'+pk[pk.length-1]:pk.join(', ')):pk[0],nil=t=>`<div class="mut x-nil">${t}</div>`,n=fin(o.len)?o.len:COV[i],end=i?R[i-1].s:OPEN?null:o.s+n;let k=0;const ln=h=>`<div class="ln" style="--k:${k++}">${h}</div>`;
const bars=F.length?`<div class="bars" role="img" aria-label="Flow by day: ${F.map((v,j)=>`day ${j+1} ${v==null?'not recorded':esc(fn(v))}`).join(', ')}" style="--n:${F.length}">${F.map((v,j)=>`<div class="b${v==null?' x-gap':''}${pk.includes(j+1)?' x-pk':''}" style="--k:${j}"><i${v==null?'':` style="height:${Math.max(2,v/LV*44)|0}px"`}></i><small>${j+1}</small></div>`).join('')}</div>`:'';
const head=o.first?ln(`<div class="eb">First record</div><div class="md">Where the sky begins.</div><div class="mut">${end==null?'It is still in progress.':`It closed on ${days(end)} after ${pl(n,'day')}.`}</div>`):'',
fb=ln(mx==null?`<div class="eb">Flow</div>${nil('Not recorded')}${bars}`:`<div class="eb">Flow · peak on day${pk.length>1?'s':''} ${rng}${lg.length<F.length?` · ${lg.length} of ${F.length} days logged`:''}</div><span class="fv">${esc(fn(mx))}</span><span class="dr">${Array.from({length:LV},(_,j)=>`<i${j<mx?' class="f"':''}></i>`).join('')}</span>${bars}`),
pn=fin(o.pain)?clamp(Math.round(o.pain),0,10):null,
pb=ln(`<div class="eb">Pain level</div>${pn==null?nil('Not recorded'):`<div class="pn"><b>${pn}</b><small> / 10</small></div><div class="t10">${Array.from({length:10},(_,j)=>`<i style="--k:${j}"${j<pn?' class="f"':''}></i>`).join('')}</div>`}`),
mb=ln(`<div class="eb">Mood</div>${o.mood?`<div class="md">${esc(o.mood)}</div>`:nil('Not recorded')}`),
sy=ln(`<div class="eb">Symptoms</div>${(o.sym||[]).length?`<div class="sy">${o.sym.map((w,j)=>`${j?'<i>·</i>':''}<span class="w" style="--k:${j}">${esc(w)}</span>`).join('')}</div>`:nil('None logged')}`);
const ms=[PN[i]?mv(PN[i],'day','Period'):'',i==0&&OPEN?mv(TD+1,'day','So far'):fin(o.len)?mv(o.len,'day','Cycle length'):''].join('')||mv(1,'record','Logged');
return `<article class="en" data-i="${i}"><button class="hd" aria-expanded="false" aria-controls="d${i}"><span class="eb">${esc(o.eb)}</span><span class="dn" role="img" aria-label="${esc(o.eb)}">${[...String(o.dn)].map((c,j)=>`<i style="--k:${j}">${esc(c)}</i>`).join('')}</span>
<span class="row">${ms}<span class="pl"></span></span><span class="ul"></span></button>
<div class="dt" id="d${i}"><div class="gp glass"><div class="gi">${head}${fb}${pb}${mb}${sy}</div></div></div></article>`};
const emptyHTML=`<div class="x-empty"><div class="eb">No records yet</div><b>0</b><h2>Nothing archived</h2><p>Mark a period start in Calendar and it lands here as a tall segment, one tick for every day it covers.</p></div>`;
function buildList(){const prev=new Set(R.map(o=>o.s));R=core.hist()||[];
// [data-layer] 0 records -> derived empty state only (data-side guard; B4 owns the visuals)
// [data-layer] #cs aria mirrors .cv and the bars actually drawn below (LEN/NC), never static copy
if(!R.length){segs=[];ens=[];hds=[];glass=[];oa=[];NC=0;LMAX=1;CAP='No complete cycle yet';LEN.length=LAB.length=PER.length=RIX.length=0;openI=-1;$('#list').innerHTML=emptyHTML;io.observe(PG.querySelector('.x-empty'));$('.cv').textContent='No complete cycle yet';$('.end').textContent='PeriodIQ · 0 records';$('#hsubt').textContent='0 records';$('#cs').setAttribute('aria-label','No complete cycle yet');cycUI();return prev}
const st=core.stats()||{},sg=core.m.seg;OPEN=R[0].len==null;TD=Math.max(0,core.m.TODAY-R[0].s);AV=fin(st.avg)&&st.avg>0?st.avg:NaN;
PRED=OPEN&&!!sg&&Array.isArray(sg.pred)&&sg.pred.length>0;
COV.length=0;R.forEach((o,i)=>COV.push(Math.max(1,Math.round(i==0&&OPEN?(PRED?Math.max(o.segLen,TD+1):TD+1):fin(o.segLen)&&o.segLen>0?o.segLen:fin(o.len)?o.len:1))));
PN=R.map(o=>o.first&&!logged(o)?0:Math.max(0,Math.round(o.per)||0));FM=R.map(o=>Math.max(4,...(o.fl||[]).filter(fin)));
LEN.length=LAB.length=PER.length=RIX.length=0;R.forEach((o,i)=>{if(fin(o.len)&&LEN.length<MAXC){LEN.push(o.len);LAB.push(days(o.s));PER.push(PN[i]);RIX.push(i)}});NC=LEN.length;LMAX=NC?Math.max(...LEN):1;oa=R.map(()=>0);
$('#list').innerHTML=R.map((o,i)=>seg(i)+ent(o,i)).join('');segs=$$('.sg');ens=$$('.en');segs.forEach((e,s)=>e.style.setProperty('--x-r',s*2+1));ens.forEach((e,s)=>e.style.setProperty('--x-r',s*2+1));hds=$$('.hd');glass=$$('.glass');hds.forEach((h,i)=>h.onclick=()=>toggle(i));ens.forEach(e=>io.observe(e));
const mn=NC?Math.min(...LEN):0;CAP=NC?`${pl(NC,'cycle')} · ${mn==LMAX?pl(mn,'day')+(NC>1?' each':''):mn+'–'+LMAX+' days'}`:'No complete cycle yet';$('.cv').textContent=CAP;
$('#cs').setAttribute('aria-label',NC?(NC==1?`Cycle length of the last closed cycle: ${LAB[0]}, ${pl(LEN[0],'day')}`:`Cycle lengths across the last ${NC} closed cycles: ${LEN.map((n,r)=>`${LAB[r]}, ${pl(n,'day')}`).join('; ')}`):'No complete cycle yet');/* [data-layer] aria mirrors .cv and the drawn bars (LEN/NC) */
const since=core.m.fmt(R[R.length-1].s,{month:'long',year:'numeric'});$('.end').textContent=`PeriodIQ · ${pl(R.length,'record')} · since ${since} · one tick = one day`;
$('#hsubt').textContent=`${pl(R.length,'record')} · Started ${since}`;cycUI();return prev}
function toggle(i){const open=openI!=i;openI=open?i:-1;ens.forEach((e,k)=>{const on=open&&k==i;e.classList.toggle('open',on);hds[k].setAttribute('aria-expanded',on);segs[k].classList.toggle('flow',on&&PN[k]>0)});
const r=ens[i].getBoundingClientRect(),mr=main.getBoundingClientRect();wave(mr.left+26,r.top+8);core.buzz(open?12:6);
if(open)setTimeout(()=>{const b=ens[i].getBoundingClientRect().bottom;if(b>innerHeight-120)scr(b-innerHeight+140)},reduce?0:650)}

// ---- canvas: starfield + the ruler of days
const sky=$('#sky'),sc=sky.getContext('2d'),S=Array.from({length:230},(_,i)=>({x:rnd(i,1),y:rnd(i,2),z:.15+rnd(i,3)*.85,p:rnd(i,4)*6.28,k:rnd(i,5)>.93}));
const size=()=>{dpr=Math.min(devicePixelRatio||1,2);SW=innerWidth;SH=innerHeight;sky.width=SW*dpr;sky.height=SH*dpr;sizeC()};
function drawSky(t){sc.setTransform(dpr,0,0,dpr,0,0);sc.clearRect(0,0,SW,SH);sc.lineCap='round';const sl=reduce?0:clamp(Math.abs(sv)*.04,0,80),tw=reduce?0:t,sy=reduce?0:scrollY;
for(const s of S){const x=s.x*SW-(spx-.5)*26*s.z,y=((s.y*SH-sy*(.05+.22*s.z))%SH+SH)%SH-(spy-.5)*26*s.z;let a=(.2+.7*s.z)*(.55+.45*Math.sin(tw*(.6+s.z)+s.p)),b=0;
for(const w of waves){const age=t-w.t,f=Math.max(0,1-Math.abs(Math.hypot(x-w.x,y-w.y)-age*430)/50)*Math.max(0,1-age/1.5);a+=f*.9;b+=f*2}
sc.fillStyle=sc.strokeStyle=ik(a);const l=sl*s.z;
if(l>1.5){sc.lineWidth=.6+s.z;sc.beginPath();sc.moveTo(x,y);sc.lineTo(x,y+Math.sign(sv)*l);sc.stroke()}else if(s.k)sp(sc,x,y,2.4+3.6*s.z+b,1);else{sc.beginPath();sc.arc(x,y,.4+s.z*1.1+b*.5,0,7);sc.fill()}}
for(const w of waves){const age=t-w.t;sc.strokeStyle=ik(.22*(1-age/1.5));sc.lineWidth=1;sc.beginPath();sc.arc(w.x,w.y,age*430,0,7);sc.stroke()}waves=waves.filter(w=>t-w.t<1.5)}
function drawRuler(t){if(!segs.length)return;/* [data-layer] 0 records: nothing to draw (data-side guard, not visual design) */if(document.body.classList.contains('piq-shell')&&innerWidth>=720)return;/* W1-3A: desktop draws its own ruler; keep the canvas for stars only */const X0=Math.round(main.getBoundingClientRect().left+26),fy=SH*.42,H=PX,snap=v=>Math.round(v*dpr)/dpr+.5/dpr;
// rail
const a=segs[0].getBoundingClientRect().top,e3=ens[ens.length-1].getBoundingClientRect().top+8,g=sc.createLinearGradient(0,a,0,e3);g.addColorStop(0,ik(.05));g.addColorStop(.15,ik(.3));g.addColorStop(.85,ik(.3));g.addColorStop(1,ik(.05));
sc.strokeStyle=g;sc.lineWidth=.8;sc.beginPath();sc.moveTo(snap(X0),Math.max(a,-10));sc.lineTo(snap(X0),Math.min(e3,SH+10));sc.stroke();
// reading line: the tick nearest to it is "read"
const bm=sc.createLinearGradient(X0-12,0,X0+170,0);bm.addColorStop(0,ik(.45));bm.addColorStop(1,ik(0));sc.fillStyle=bm;sc.fillRect(X0-12,snap(fy),182,1);
sc.font='600 9.5px Inter,system-ui,sans-serif';sc.textBaseline='middle';sc.textAlign='left';
segs.forEach((el,s)=>{const r=el.getBoundingClientRect();if(r.bottom<-20||r.top>SH+20)return;
const o=R[s],F=o.fl||[],SLs=COV[s];for(let j=0;j<SLs;j++){const y0=r.bottom-(j+.5)*H;if(y0<-14||y0>SH+14)continue;
const e=clamp(intro*2.4-j/SLs-s*.1),gs=gauss(y0-fy,120),future=s==0&&OPEN&&j>TD,per=j<PN[s],wk=j%7==0&&j>0,fv=per&&fin(F[j]),gap=per&&!fv;
let pb=0;if(pulse&&pulse.s==s){pb=gauss(j-(t-pulse.t)*20,2.2)}if(con>.02)pb=Math.max(pb,con*gauss(j-(sd-1),1));let len=per?20+(fv?oa[s]*F[j]/FM[s]*34:0):wk?14:8;len=(len+11*gs+17*pb)*e;const y=snap(y0);
if(future){sc.fillStyle=ik(.25*e+.3*gs);sc.fillRect(X0+2,y,3,1);continue}
sc.strokeStyle=ik(((per?(gap?.45:.8):wk?.4:.22)+.55*Math.max(gs,pb)+.2*oa[s]*per)*e);sc.lineWidth=per?1.8:.8;if(gap)sc.setLineDash([2,3]);sc.beginPath();sc.moveTo(X0,y);sc.lineTo(X0+len,y);sc.stroke();if(gap)sc.setLineDash([]);
if(wk&&!o.first&&e>.9){sc.fillStyle=ik(.34+.6*gs);sc.fillText(days(o.s+j),X0+len+7,y)}
if(s==0&&OPEN&&j==TD){const p=reduce?.5:.5+.5*Math.sin(t*2.6),gr=sc.createRadialGradient(X0,y,0,X0,y,34);gr.addColorStop(0,ik(.7));gr.addColorStop(1,ik(0));sc.fillStyle=gr;sc.fillRect(X0-34,y-34,68,68);sc.fillStyle=ik(1);sp(sc,X0,y,8+2*p,1);sc.strokeStyle=ik(.5);sc.lineWidth=.8;sc.beginPath();sc.arc(X0,y,13+3*p,0,7);sc.stroke()}}});
// nodes: one star per record
ens.forEach((en,i)=>{const y=en.getBoundingClientRect().top+8;if(y<-40||y>SH+40)return;const gs=gauss(y+80-fy,160),o=oa[i],r=5+4*gs+5*o,gr=sc.createRadialGradient(X0,y,0,X0,y,26+22*o);gr.addColorStop(0,ik(.45*gs+.4*o+.1));gr.addColorStop(1,ik(0));sc.fillStyle=gr;sc.fillRect(X0-50,y-50,100,100);
sc.fillStyle=ik(.55+.45*Math.max(gs,o));sp(sc,X0,y,r,1);if(o>.02){sc.strokeStyle=ik(.6*o);sc.lineWidth=.9;sc.beginPath();sc.arc(X0,y,r+7+4*o,0,7);sc.stroke()}})}
// ---- cycle lengths: an icon that opens into a same-day comparison scrubber
const ch=$('.ch'),ci=$('#ci'),cs=$('#cs'),cic=ci.getContext('2d'),csc=cs.getContext('2d'),PITCH=46,RY=r=>40+r*PITCH;
let cOpen=0,coa=0,sdT=1,hold=false,curD=-1,iin=0,CW=0,CHH=120,BB=70,CX0=46,dg=null;
const OVD=()=>Math.round(AV-OV),home=()=>fin(AV)?clamp(Math.round(AV),1,LMAX):LMAX;
// phase words follow the average cycle length and the ovulation offset OV; unknown values stay neutral
const phase=d=>{const k=PER.filter(p=>p>0),n=k.filter(p=>d<=p).length;if(n)return n==k.length?'Period':`Period · ${n} of ${k.length} cycles`;
if(!fin(AV))return 'Cycle day';if(d>AV+.5)return 'Past the average';if(d>AV-.5)return 'Average cycle ends here';
const ov=OVD();if(ov<=Math.max(0,...PER)+1)return 'Mid-cycle';return d<ov-5?'Follicular':d==ov?'Ovulation':d<=ov+1?'Fertile window':'Luteal'};
function sizeC(){CW=cs.clientWidth;BB=NC?RY(NC-1)+26:70;CHH=BB+36;cs.style.height=CHH+'px';cs.width=CW*dpr;cs.height=CHH*dpr;ci.width=56*dpr;ci.height=56*dpr;
csc.font='700 11px Inter,system-ui,sans-serif';CX0=clamp(Math.ceil(Math.max(0,...LAB.map(l=>csc.measureText(l+' ›').width)))+10,46,76)}
function setD(d){if(d==curD)return;curD=d;$('#cd').textContent=NC?'Day '+d:'Day —';$('#cp').textContent=NC?phase(d):'Nothing closed to compare';if(hold&&fin(AV)&&d==Math.round(AV))core.buzz(8)}
function cycUI(){$('.cyc .mut').textContent=NC?`Drag across to ${NC==1?'read each day of this cycle':NC==2?'compare one day in both cycles':'compare one day in all '+NC+' cycles'}. Tap a date to jump to that record.`:'A cycle closes when the next period begins. Closed cycles are compared here.';
curD=-1;sdT=home();sizeC();setD(sdT)}
function setCyc(on){cOpen=on?1:0;cyc.classList.toggle('open',on);ch.setAttribute('aria-expanded',on);
if(on){sd=0;sdT=home();hold=false;sizeC();const r=ci.getBoundingClientRect();wave(r.left+28,r.top+28);core.buzz(10);setTimeout(()=>{const b=cyc.getBoundingClientRect().bottom;if(b>SH-120)scr(b-SH+140)},reduce?0:650)}}
ch.onclick=()=>setCyc(!cOpen);
function goto(i){setCyc(false);const r=ens[i].getBoundingClientRect();scr(r.top-SH*.3);pulse={s:i,t:now+.6};setTimeout(()=>{if(openI!=i)toggle(i)},reduce?0:700)}
const cday=e=>clamp(Math.round((e.clientX-cs.getBoundingClientRect().left-CX0)/((CW-CX0-8)/LMAX)+.5),1,LMAX);
cs.tabIndex=0;
cs.addEventListener('pointerdown',e=>{if(!NC)return;const r=cs.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,l=Math.round((y-RY(0))/PITCH);dg={x:e.clientX,y:e.clientY,lab:x<CX0&&l>=0&&l<NC&&Math.abs(y-RY(l))<=PITCH/2?l:-1};if(dg.lab<0){hold=true;sdT=cday(e);try{cs.setPointerCapture(e.pointerId)}catch(_){}}});
cs.addEventListener('pointermove',e=>{if(hold)sdT=cday(e)});
['pointerup','pointercancel'].forEach(k=>cs.addEventListener(k,e=>{hold=false;if(k=='pointerup'&&dg&&dg.lab>=0&&Math.hypot(e.clientX-dg.x,e.clientY-dg.y)<8)goto(RIX[dg.lab]);dg=null}));
cs.addEventListener('keydown',e=>{const k=e.key,s={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[k];if(!NC||(!s&&k!='Home'&&k!='End'))return;e.preventDefault();sdT=k=='Home'?1:k=='End'?LMAX:clamp(Math.round(sdT)+s,1,LMAX)});
function drawIcon(t){const c=cic,Lm=LMAX,b=reduce?Lm:((t*.5)%1.5)*Lm,X=d=>3+(d-.5)*47/Lm;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,56,56);c.lineCap='round';
if(!NC){c.strokeStyle=ik(.35*iin);c.lineWidth=1;c.setLineDash([2,3]);c.beginPath();c.moveTo(4,28);c.lineTo(44,28);c.stroke();c.setLineDash([]);c.strokeStyle=ik(.7*iin);sp(c,49,28,5,0);return}
for(let r=0;r<NC;r++){const y=(r+1)*56/(NC+1),L=LEN[r],dim=openI>=0&&openI!=RIX[r]?.5:1;
for(let d=1;d<L;d++){if(d/Lm>iin*1.25)break;const g=gauss(d-b,2.2),h=(d<=PER[r]?9:6)+4*g;c.strokeStyle=ik(((d<=b?.85:.32)+.15*g)*dim);c.lineWidth=Math.min(1.1,.62*47/Lm);c.beginPath();c.moveTo(X(d),y-h/2);c.lineTo(X(d),y+h/2);c.stroke()}
if(L/Lm<=iin*1.25){c.fillStyle=ik(.9*dim*Math.min(1,iin*1.4));sp(c,X(L),y,4.2+2*gauss(L-b,2),1)}}}
function drawChart(){const c=csc,w=CW,p=(w-CX0-8)/LMAX,X=d=>CX0+(d-.5)*p,bb=BB,mn=NC?Math.min(...LEN):0;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,CHH);c.lineCap='round';c.globalAlpha=clamp(coa*1.5);c.textBaseline='middle';c.font='600 9.5px Inter,system-ui,sans-serif';
if(!NC){c.strokeStyle=ik(.3);c.lineWidth=1;c.setLineDash([2,4]);c.beginPath();c.moveTo(CX0,30);c.lineTo(w-8,30);c.stroke();c.setLineDash([]);c.textAlign='left';c.fillStyle=ik(.45);try{c.letterSpacing='1.2px'}catch(_){}c.fillText('NO CLOSED CYCLE YET',CX0,50);try{c.letterSpacing='0px'}catch(_){}c.globalAlpha=1;return}
if(NC>1&&mn!=LMAX){c.fillStyle=ik(.04);c.fillRect(X(mn)-p/2,10,X(LMAX)-X(mn)+p,bb-10)}
c.textAlign='right';c.fillStyle=ik(.42);try{c.letterSpacing='1.2px'}catch(_){}c.fillText(CAP.toUpperCase(),w-8,bb+18);try{c.letterSpacing='0px'}catch(_){}
if(fin(AV)&&AV>=.5&&AV<=LMAX+.5){const ax=X(clamp(AV,1,LMAX));c.strokeStyle=ik(.28);c.lineWidth=.8;c.setLineDash([2,4]);c.beginPath();c.moveTo(ax,22);c.lineTo(ax,bb);c.stroke();c.setLineDash([]);
c.textAlign='center';c.font='800 10.5px Inter,system-ui,sans-serif';c.fillStyle=ik(.55+.45*gauss(AV-sd,2.5));c.fillText(nf(AV)+' days avg',clamp(ax,CX0+30,w-38),8)}
for(let r=0;r<NC;r++){const y=RY(r),L=LEN[r],sel=openI==RIX[r],dim=openI>=0&&!sel?.55:1;
c.textAlign='left';c.font='700 11px Inter,system-ui,sans-serif';c.fillStyle=ik((sel?1:.55)*dim);c.fillText(LAB[r]+' ›',2,y);
for(let d=1;d<=LMAX;d++){const x=X(d),g=gauss(d-sd,2.4),inL=d<=L,per=d<=PER[r];
if(inL&&d==L){const gl=Math.max(g,sd>=L-.3?1:0);c.fillStyle=ik((.6+.4*gl)*dim);sp(c,x,y,7+6*gl,1);continue}
if(!inL){c.strokeStyle=ik(.13+.25*g);c.lineWidth=1;c.beginPath();c.moveTo(x,y-1.5);c.lineTo(x,y+1.5);c.stroke();continue}
const h=(per?22:14)+11*g;c.strokeStyle=ik(((d<=sd?.92:.3)+.1*g)*dim);c.lineWidth=Math.min(per?3.2:2,p*.62);c.beginPath();c.moveTo(x,y-h/2);c.lineTo(x,y+h/2);c.stroke()}}
// scan beam
const bx=X(sd),mid=(12+bb)/2;c.save();c.translate(bx,mid);c.scale(30,(bb-12)/2);const gr=c.createRadialGradient(0,0,0,0,0,1);gr.addColorStop(0,ik(.16+.1*con));gr.addColorStop(1,ik(0));c.fillStyle=gr;c.fillRect(-1,-1,2,2);c.restore();
const g2=c.createLinearGradient(0,12,0,bb);g2.addColorStop(0,ik(0));g2.addColorStop(.3,ik(.8));g2.addColorStop(1,ik(.2));c.strokeStyle=g2;c.lineWidth=1;c.beginPath();c.moveTo(bx,12);c.lineTo(bx,bb);c.stroke();
if(!fin(AV)||Math.abs(sd-AV)>3.5){c.textAlign='center';c.font='800 10.5px Inter,system-ui,sans-serif';c.fillStyle=ik(1);c.fillText('D'+Math.round(sd),bx,8)}
c.globalAlpha=1}
function drawCyc(t,dt){coa+=(cOpen-coa)*(1-Math.exp(-dt*5));iin+=((cyc.classList.contains('in')?1:0)-iin)*(1-Math.exp(-dt*1.1));con+=((hold?1:0)-con)*(1-Math.exp(-dt*10));
sd=reduce?sdT:sd+(sdT-sd)*(1-Math.exp(-dt*(hold?18:3.2)));if(cOpen)setD(clamp(Math.round(sd),1,LMAX));if(pulse&&t-pulse.t>3.5)pulse=null;
const vis=r=>r.bottom>0&&r.top<SH;
if(vis(ci.getBoundingClientRect()))drawIcon(t);
if(coa<.01||!vis(cs.getBoundingClientRect())||!CW)return;drawChart()}
// ---- one clock: scroll depth, weights, ruler, glass light
let last=0;
function loop(ts){const t=ts/1000,dt=Math.min(.05,t-last||.016);last=t;now=t;intro=reduce?3:intro+dt*.8;
const sy=scrollY;sv+=((sy-lsy)/dt-sv)*.15;lsy=sy;
if(t-lastMove>2.5&&!reduce){px=.5+.3*Math.sin(t*.35);py=.4+.25*Math.cos(t*.27)}spx+=(px-spx)*.07;spy+=(py-spy)*.07;
const gx=spx*SW,gy=spy*SH;glass.forEach(e=>{const r=e.getBoundingClientRect();if(r.bottom<0||r.top>SH)return;e.style.setProperty('--px',(gx-r.left).toFixed(0)+'px');e.style.setProperty('--py',(gy-r.top).toFixed(0)+'px');e.style.setProperty('--ang',(Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90).toFixed(0)+'deg')});
if(dm)dm.setAttribute('scale',(30+12*Math.min(1,Math.abs(sv)/900)+8*oa.reduce((m,v)=>Math.max(m,v),0)).toFixed(1));
const h=clamp(sy/320);topEl.style.transform=reduce?'none':`translateY(${sy*.38}px) scale(${1-.14*h})`;topEl.style.opacity=1-1.1*h;topEl.style.filter=h>.02&&!reduce?`blur(${(h*9).toFixed(1)}px)`:'none';
// memory tunnel: older records recede into depth, newer ones fly past the camera and dissolve
const fy=SH*.42;ens.forEach((en,i)=>{oa[i]+=((openI==i?1:0)-oa[i])*(1-Math.exp(-dt*5));const r=en.getBoundingClientRect(),u=(r.top+r.height*(openI==i?.2:.5)-fy)/(SH*.55);
if(r.bottom<-200||r.top>SH+300)return;const a=Math.abs(u),m=Math.min(a,1.3);let s,o,bl,ty;
if(u>0){s=1-.14*m;o=1-.62*m;bl=4.5*m;ty=0}else{s=1+.08*a;o=1-.85*Math.pow(Math.min(a,1.1),1.3);bl=3*a;ty=-34*a}
if(reduce){bl=0;ty=0}if(openI==i){o=Math.max(o,.9);bl=0}
const f=Math.max(gauss(u,.5),oa[i]);en.style.setProperty('--f',f.toFixed(3));const hd=hds[i];hd.style.transform=`translate3d(0,${ty.toFixed(1)}px,0) scale(${s.toFixed(3)})`;hd.style.opacity=clamp(o).toFixed(3);hd.style.filter=bl>.3?`blur(${bl.toFixed(1)}px)`:'none'});
drawSky(t);drawRuler(t);drawCyc(t,dt);requestAnimationFrame(loop)}
cacheInk();buildList();size();requestAnimationFrame(loop);

return {size,cacheInk,setSY:v=>{scrollY=v},wave,refresh:()=>{const prev=buildList();openI=-1;oa.fill(0);const n=R.findIndex(o=>!prev.has(o.s));if(n>=0){pulse={s:n,t:now+.35};wave(innerWidth/2,innerHeight*.4);core.buzz(10)}}};}
