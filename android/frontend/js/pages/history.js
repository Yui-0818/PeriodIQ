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
nf=n=>String(+n.toFixed(1)),esc=s=>String(s).replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';'),
scr=y=>scrollBy({top:y,behavior:reduce?'auto':'smooth'});
const t=(k,v)=>core.i18n.t(k,v),plw=(n,b)=>core.i18n.t(core.i18n.plural(n,b),{n}),
dfmt=(n,o)=>core.i18n.date(n,o),days=n=>dfmt(n,{month:'short',day:'numeric'});
const isMob=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||!document.body.classList.contains('piq-shell');
let ink='255,255,255',dpr=1,skyDpr=1,SW=0,SH=0,now=0,px=.5,py=.4,spx=.5,spy=.4,lastMove=-9,sv=0,lsy=0,waves=[],intro=0,openI=-1,oa=[],dm=null,pulse=null,sd=0,con=0,skyT=-9,skyOnce=true;
const glowSp=document.createElement('canvas');glowSp.width=glowSp.height=64;let gInk='';
const syncGlow=()=>{if(gInk===ink)return;gInk=ink;const c=glowSp.getContext('2d'),g=c.createRadialGradient(32,32,0,32,32,32);c.clearRect(0,0,64,64);g.addColorStop(0,`rgba(${ink},1)`);g.addColorStop(1,`rgba(${ink},0)`);c.fillStyle=g;c.fillRect(0,0,64,64)};
const stampGlow=(c,x,y,r,a)=>{if(a<=.002||r<=.01)return;syncGlow();c.globalAlpha=clamp(a);c.drawImage(glowSp,x-r,y-r,r*2,r*2);c.globalAlpha=1};
const cacheInk=()=>{ink=getComputedStyle(root).getPropertyValue('--ink').trim();syncGlow();skyOnce=true},ik=a=>`rgba(${ink},${clamp(a)})`,wave=(x,y)=>reduce||waves.push({x,y,t:now});
// lens refraction (Chromium)
dm=core.dm();
addEventListener('pointermove',e=>{px=e.clientX/innerWidth;py=e.clientY/innerHeight;lastMove=now});
// ---- the records: rebuilt from the shared model
const FL=core.m.FL||[],fn=v=>FL[v]?t('cal.tier'+v):t('hist.level',{n:v}),PX=7,MAXC=5;
let R=[],segs=[],ens=[],hds=[],glass=[],TD=0,AVP=NaN,NC=0,PMAX=5,OPEN=false,PRED=false,CAP=t('hist.rhythmNoRec'),PN=[],FM=[];const DUR=[],LAB=[],RIX=[],FLS=[],PAINS=[],COV=[];
const main=$('#main'),topEl=$('#top'),cyc=$('#cyc');
const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('in')),{threshold:.2});io.observe(cyc);io.observe(topEl);
const flv=o=>Array.from({length:Math.max(o.per||0,(o.fl||[]).length)},(_,k)=>fin((o.fl||[])[k])?o.fl[k]:null),logged=o=>(o.fl||[]).some(fin)||fin(o.pain);
const lab=(o,s)=>{if(s==0&&OPEN)return `<span>${t('hist.inProgress')}</span><span>${t('hist.dayN',{n:TD+1})}${PRED&&TD<o.segLen?t('hist.ofSeg',{n:o.segLen}):''}</span>`;
const n=fin(o.len)?o.len:COV[s],e=s?R[s-1].s:o.s+n,a=o.first?dfmt(o.s,{month:'short'}):days(o.s);return `${COV[s]*PX>=120?`<span>${a} → ${days(e)}</span>`:''}<span>${t('hist.nDayCycle',{n})}</span>`};
const seg=s=>{const o=R[s],top=s==0&&OPEN,fs=flv(o).some(v=>v!=null);
return `<div class="sg" data-s="${s}" style="height:${COV[s]*PX}px">${top&&PRED?`<span class="nx">${TD>=o.segLen?t('hist.expected'):t('hist.nextPeriod')} · ${days(o.s+o.segLen)}</span>`:''}${top?`<div class="td" style="bottom:${Math.max(32,Math.min((TD+.5)*PX-9,COV[s]*PX-56)).toFixed(1)}px">${t('ui.today')}<small>${t('hist.todaySub',{d:days(core.m.TODAY),n:TD+1})}</small></div>`:''}${PN[s]?`<div class="pr"><span>${plw(PN[s],'hist.periodN')}</span><span>${fs?t('hist.flowDay'):t('hist.flowNone')}</span></div>`:''}<div class="cy${top?' d':''}"></div><div class="cl">${lab(o,s)}</div></div>`};
const mv=(n,base,lk)=>`<span class="ms"><span class="mv"><b>${n}</b> ${plw(n,base)}</span><span class="ml">${t(lk)}</span></span>`;
const ent=(o,i)=>{const F=PN[i]||logged(o)?flv(o):[],lg=F.filter(v=>v!=null),mx=lg.length?Math.max(...lg):null,pk=F.map((v,k)=>mx!=null&&v==mx?k+1:0).filter(Boolean),LV=Math.min(10,FM[i]),
rng=pk.length>1?(pk[pk.length-1]-pk[0]==pk.length-1?pk[0]+'–'+pk[pk.length-1]:pk.join(', ')):pk[0],nil=s=>`<div class="mut x-nil">${s}</div>`,n=fin(o.len)?o.len:COV[i],end=i?R[i-1].s:OPEN?null:o.s+n;let k=0;const ln=h=>`<div class="ln" style="--k:${k++}">${h}</div>`;
const bars=F.length?`<div class="bars" role="img" aria-label="${esc(t('hist.barsAria',{list:F.map((v,j)=>`${t('hist.barDay',{n:j+1})} ${v==null?t('hist.barNone'):esc(fn(v))}`).join(', ')}))}" style="--n:${F.length}">${F.map((v,j)=>`<div class="b${v==null?' x-gap':''}${pk.includes(j+1)?' x-pk':''}" style="--k:${j}"><i${v==null?'':` style="height:${Math.max(2,v/LV*44)|0}px"`}></i><small>${j+1}</small></div>`).join('')}</div>`:'';
const head=o.first?ln(`<div class="eb">${t('hist.firstRec')}</div><div class="md">${t('hist.whereBegins')}</div><div class="mut">${end==null?t('hist.stillOpen'):t('hist.closedOn',{d:days(end),n:plw(n,'ui.day')})}</div>`):'',
fb=ln(mx==null?`<div class="eb">${t('hist.flow')}</div>${nil(t('hist.notRecorded'))}${bars}`:`<div class="eb">${t('hist.peakOn',{s:pk.length>1?'s':'',rng})}${lg.length<F.length?t('hist.daysLogged',{a:lg.length,b:F.length}):''}</div><span class="fv">${esc(fn(mx))}</span><span class="dr">${Array.from({length:LV},(_,j)=>`<i${j<mx?' class="f"':''}></i>`).join('')}</span>${bars}`),
pn=fin(o.pain)?clamp(Math.round(o.pain),0,10):null,
pb=ln(`<div class="eb">${t('hist.painLvl')}</div>${pn==null?nil(t('hist.notRecorded')):`<div class="pn"><b>${pn}</b><small> / 10</small></div><div class="t10">${Array.from({length:10},(_,j)=>`<i style="--k:${j}"${j<pn?' class="f"':''}></i>`).join('')}</div>`}`),
mb=ln(`<div class="eb">${t('hist.mood')}</div>${o.mood?`<div class="md">${esc(o.mood)}</div>`:nil(t('hist.notRecorded'))}`),
sy=ln(`<div class="eb">${t('hist.symptoms')}</div>${(o.sym||[]).length?`<div class="sy">${o.sym.map((w,j)=>`${j?'<i>·</i>':''}<span class="w" style="--k:${j}">${esc(w)}</span>`).join('')}</div>`:nil(t('hist.noneLogged'))}`);
const ms=[PN[i]?mv(PN[i],'ui.dayW','hist.wPeriod'):'',i==0&&OPEN?mv(TD+1,'ui.dayW','hist.wSoFar'):fin(o.len)?mv(o.len,'ui.dayW','hist.wCycLen'):''].join('')||mv(1,'ui.recordW','hist.wLogged');
return `<article class="en" data-i="${i}"><button class="hd" aria-expanded="false" aria-controls="d${i}"><span class="eb">${esc(o.eb)}</span><span class="dn" role="img" aria-label="${esc(o.eb)}">${[...String(o.dn)].map((c,j)=>`<i style="--k:${j}">${esc(c)}</i>`).join('')}</span>
<span class="row">${ms}<span class="pl"></span></span><span class="ul"></span></button>
<div class="dt" id="d${i}"><div class="gp glass"><div class="gi">${head}${fb}${pb}${mb}${sy}</div></div></div></article>`};
const emptyHTML=()=>`<div class="x-empty"><div class="eb">${t('hist.eb1')}</div><b>0</b><h2>${t('hist.eh2')}</h2><p>${t('hist.ep')}</p></div>`;
function buildList(){const prev=new Set(R.map(o=>o.s));R=core.hist()||[];
R.forEach(o=>{o.eb=o.first?dfmt(o.s,{month:'short',year:'numeric'}):dfmt(o.s,{month:'short',day:'numeric',year:'numeric'})+' · '+dfmt(o.s,{weekday:'short'});o.dn=o.first?dfmt(o.s,{month:'short'}):String(core.m.dOf(o.s).getUTCDate())});
if(!R.length){segs=[];ens=[];hds=[];glass=[];oa=[];NC=0;PMAX=5;AVP=NaN;CAP=t('hist.rhythmNoRec');DUR.length=LAB.length=RIX.length=FLS.length=PAINS.length=0;openI=-1;$('#list').innerHTML=emptyHTML();io.observe(PG.querySelector('.x-empty'));$('.cv').textContent=CAP;$('.end').textContent=t('hist.end0rec');$('#hsubt').textContent=t('hist.sub0');$('#cs').setAttribute('aria-label',CAP);cycUI();return prev}
const st=core.stats()||{},sg=core.m.seg;OPEN=R[0].len==null;TD=Math.max(0,core.m.TODAY-R[0].s);
PRED=OPEN&&!!sg&&Array.isArray(sg.pred)&&sg.pred.length>0;
COV.length=0;R.forEach((o,i)=>COV.push(Math.max(1,Math.round(i==0&&OPEN?(PRED?Math.max(o.segLen,TD+1):TD+1):fin(o.segLen)&&o.segLen>0?o.segLen:fin(o.len)?o.len:1))));
PN=R.map(o=>o.first&&!logged(o)?0:Math.max(0,Math.round(o.per)||0));FM=R.map(o=>Math.max(4,...(o.fl||[]).filter(fin)));
const DAILY=core.m.DAILY||{},LVOF=core.m.lvOf||[0,1,3,6,9];
DUR.length=LAB.length=RIX.length=FLS.length=PAINS.length=0;
R.forEach((o,i)=>{if(PN[i]>0&&DUR.length<MAXC){const dur=PN[i],fl=[],pa=[];for(let k=0;k<dur;k++){const g=DAILY[o.s+k];fl.push(g&&fin(g.flow_level)?clamp(g.flow_level,1,10):fin((o.fl||[])[k])?clamp(LVOF[o.fl[k]]||o.fl[k]*2.2,1,10):null);pa.push(g&&g.pain_present?(fin(g.pain_level)&&g.pain_level>0?clamp(g.pain_level,1,10):1):0)}DUR.push(dur);LAB.push(days(o.s));RIX.push(i);FLS.push(fl);PAINS.push(pa)}});
NC=DUR.length;PMAX=NC?Math.max(5,...DUR):5;AVP=fin(st.avgPer)&&st.avgPer>0?st.avgPer:(NC?DUR.reduce((a,b)=>a+b,0)/NC:NaN);oa=R.map(()=>0);
$('#list').innerHTML=R.map((o,i)=>seg(i)+ent(o,i)).join('');segs=$$('.sg');ens=$$('.en');segs.forEach((e,s)=>e.style.setProperty('--x-r',s*2+1));ens.forEach((e,s)=>e.style.setProperty('--x-r',s*2+1));hds=$$('.hd');glass=$$('.glass');hds.forEach((h,i)=>h.onclick=()=>toggle(i));ens.forEach(e=>io.observe(e));
const mn=NC?Math.min(...DUR):0,mx=NC?Math.max(...DUR):0;CAP=NC?t('hist.rhythmCap',{p:plw(NC,'hist.wPeriodCnt'),r:mn==mx?plw(mn,'ui.day')+(NC>1?t('hist.each'):''):t('hist.daysRange',{a:mn,b:mx})}):t('hist.rhythmNoRec');$('.cv').textContent=CAP;
$('#cs').setAttribute('aria-label',NC?t('hist.rhythmAria',{n:NC,list:DUR.map((n,r)=>`${LAB[r]}, ${plw(n,'ui.day')}`).join('; ')}):CAP);
const since=dfmt(R[R.length-1].s,{month:'long',year:'numeric'});$('.end').textContent=t('hist.end',{r:plw(R.length,'ui.record'),d:since});
$('#hsubt').textContent=t('hist.sub',{r:plw(R.length,'ui.record'),d:since});cycUI();return prev}
function toggle(i){const open=openI!=i;openI=open?i:-1;rectDirty=true;rectUntil=now+1.25;ens.forEach((e,k)=>{const on=open&&k==i;e.classList.toggle('open',on);hds[k].setAttribute('aria-expanded',on);segs[k].classList.toggle('flow',on&&PN[k]>0)});
const r=ens[i].getBoundingClientRect(),mr=main.getBoundingClientRect();wave(mr.left+26,r.top+8);core.buzz(open?12:6);
if(open)setTimeout(()=>{const b=ens[i].getBoundingClientRect().bottom;if(b>innerHeight-120)scr(b-innerHeight+140)},reduce?0:650)}

// ---- canvas: starfield + the ruler of days
const sky=$('#sky'),sc=sky.getContext('2d'),S=Array.from({length:230},(_,i)=>({x:rnd(i,1),y:rnd(i,2),z:.15+rnd(i,3)*.85,p:rnd(i,4)*6.28,k:rnd(i,5)>.93}));
let rectDirty=true,rectUntil=0,mainRect=null,segRects=[],enRects=[],glassRects=[],ciRect=null,csRect=null;
function syncRects(){mainRect=main.getBoundingClientRect();segRects=segs.map(el=>el.getBoundingClientRect());enRects=ens.map(el=>el.getBoundingClientRect());glassRects=glass.map(el=>({el,r:el.getBoundingClientRect()}));ciRect=ci.getBoundingClientRect();csRect=cs.getBoundingClientRect();rectDirty=false}
const size=()=>{dpr=Math.min(devicePixelRatio||1,2);skyDpr=isMob?1:dpr;SW=innerWidth;SH=innerHeight;sky.width=SW*skyDpr;sky.height=SH*skyDpr;sizeC();rectDirty=true;skyOnce=true};
function drawSky(t){sc.setTransform(skyDpr,0,0,skyDpr,0,0);sc.clearRect(0,0,SW,SH);sc.lineCap='round';const sl=reduce?0:clamp(Math.abs(sv)*.04,0,80),tw=reduce?0:t,sy=reduce?0:scrollY;
for(const s of S){const x=s.x*SW-(spx-.5)*26*s.z,y=((s.y*SH-sy*(.05+.22*s.z))%SH+SH)%SH-(spy-.5)*26*s.z;let a=(.2+.7*s.z)*(.55+.45*Math.sin(tw*(.6+s.z)+s.p)),b=0;
for(const w of waves){const age=t-w.t,f=Math.max(0,1-Math.abs(Math.hypot(x-w.x,y-w.y)-age*430)/50)*Math.max(0,1-age/1.5);a+=f*.9;b+=f*2}
sc.fillStyle=sc.strokeStyle=ik(a);const l=sl*s.z;
if(l>1.5){sc.lineWidth=.6+s.z;sc.beginPath();sc.moveTo(x,y);sc.lineTo(x,y+Math.sign(sv)*l);sc.stroke()}else if(s.k)sp(sc,x,y,2.4+3.6*s.z+b,1);else{sc.beginPath();sc.arc(x,y,.4+s.z*1.1+b*.5,0,7);sc.fill()}}
for(const w of waves){const age=t-w.t;sc.strokeStyle=ik(.22*(1-age/1.5));sc.lineWidth=1;sc.beginPath();sc.arc(w.x,w.y,age*430,0,7);sc.stroke()}waves=waves.filter(w=>t-w.t<1.5)}
function drawRuler(t){if(!segs.length||!mainRect)return;/* [data-layer] 0 records: nothing to draw (data-side guard, not visual design) */if(document.body.classList.contains('piq-shell')&&innerWidth>=720)return;/* W1-3A: desktop draws its own ruler; keep the canvas for stars only */const X0=Math.round(mainRect.left+26),fy=SH*.42,H=PX,snap=v=>Math.round(v*skyDpr)/skyDpr+.5/skyDpr;
// rail
const a=segRects[0].top,e3=enRects[enRects.length-1].top+8,g=sc.createLinearGradient(0,a,0,e3);g.addColorStop(0,ik(.05));g.addColorStop(.15,ik(.3));g.addColorStop(.85,ik(.3));g.addColorStop(1,ik(.05));
sc.strokeStyle=g;sc.lineWidth=.8;sc.beginPath();sc.moveTo(snap(X0),Math.max(a,-10));sc.lineTo(snap(X0),Math.min(e3,SH+10));sc.stroke();
// reading line: the tick nearest to it is "read"
const bm=sc.createLinearGradient(X0-12,0,X0+170,0);bm.addColorStop(0,ik(.45));bm.addColorStop(1,ik(0));sc.fillStyle=bm;sc.fillRect(X0-12,snap(fy),182,1);
sc.font="600 9.5px Inter,'Noto Sans SC',system-ui,sans-serif";sc.textBaseline='middle';sc.textAlign='left';
segs.forEach((el,s)=>{const r=segRects[s];if(!r||r.bottom<-20||r.top>SH+20)return;
const o=R[s],F=o.fl||[],SLs=COV[s];for(let j=0;j<SLs;j++){const y0=r.bottom-(j+.5)*H;if(y0<-14||y0>SH+14)continue;
const e=clamp(intro*2.4-j/SLs-s*.1),gs=gauss(y0-fy,120),future=s==0&&OPEN&&j>TD,per=j<PN[s],wk=j%7==0&&j>0,fv=per&&fin(F[j]),gap=per&&!fv;
let pb=0;if(pulse&&pulse.s==s){pb=gauss(j-(t-pulse.t)*20,2.2)}if(con>.02)pb=Math.max(pb,con*gauss(j-(sd-1),1));let len=per?20+(fv?oa[s]*F[j]/FM[s]*34:0):wk?14:8;len=(len+11*gs+17*pb)*e;const y=snap(y0);
if(future){sc.fillStyle=ik(.25*e+.3*gs);sc.fillRect(X0+2,y,3,1);continue}
sc.strokeStyle=ik(((per?(gap?.45:.8):wk?.4:.22)+.55*Math.max(gs,pb)+.2*oa[s]*per)*e);sc.lineWidth=per?1.8:.8;if(gap)sc.setLineDash([2,3]);sc.beginPath();sc.moveTo(X0,y);sc.lineTo(X0+len,y);sc.stroke();if(gap)sc.setLineDash([]);
if(wk&&!o.first&&e>.9){sc.fillStyle=ik(.34+.6*gs);sc.fillText(days(o.s+j),X0+len+7,y)}
if(s==0&&OPEN&&j==TD){const p=reduce?.5:.5+.5*Math.sin(t*2.6);stampGlow(sc,X0,y,34,.7);sc.fillStyle=ik(1);sp(sc,X0,y,8+2*p,1);sc.strokeStyle=ik(.5);sc.lineWidth=.8;sc.beginPath();sc.arc(X0,y,13+3*p,0,7);sc.stroke()}}});
// nodes: one star per record
ens.forEach((en,i)=>{const er=enRects[i];if(!er)return;const y=er.top+8;if(y<-40||y>SH+40)return;const gs=gauss(y+80-fy,160),o=oa[i],r=5+4*gs+5*o;stampGlow(sc,X0,y,26+22*o,.45*gs+.4*o+.1);
sc.fillStyle=ik(.55+.45*Math.max(gs,o));sp(sc,X0,y,r,1);if(o>.02){sc.strokeStyle=ik(.6*o);sc.lineWidth=.9;sc.beginPath();sc.arc(X0,y,r+7+4*o,0,7);sc.stroke()}})}
// ---- period rhythm: daily flow waveform & pain markers across up to 5 recent periods
const ch=$('.ch'),ci=$('#ci'),cs=$('#cs'),cic=ci.getContext('2d'),csc=cs.getContext('2d'),PITCH=46,RY=r=>40+r*PITCH;
let cOpen=0,coa=0,sdT=1,hold=false,curD=-1,iin=0,CW=0,CHH=120,BB=70,CX0=46,dg=null;
const home=()=>fin(AVP)?clamp(Math.round(AVP),1,PMAX):1;
const rhythmNote=d=>{const act=[];for(let r=0;r<NC;r++)if(d<=DUR[r])act.push(r);if(!act.length)return t('hist.rhythmFlowNone');
const fls=act.map(r=>FLS[r][d-1]).filter(fin),flAvg=fls.length?nf(fls.reduce((a,b)=>a+b,0)/fls.length):null,pnCnt=act.filter(r=>PAINS[r][d-1]>0).length,out=[];
if(NC>1)out.push(t('hist.rhythmActive',{a:act.length,b:NC}));out.push(flAvg!=null?t('hist.rhythmFlowAvg',{fl:flAvg}):t('hist.rhythmFlowNone'));
out.push(pnCnt>0?t('hist.rhythmPain',{a:pnCnt,b:act.length}):t('hist.rhythmNoPain'));return out.join(' · ')};
function sizeC(){CW=cs.clientWidth;BB=NC?RY(NC-1)+26:70;CHH=BB+36;cs.style.height=CHH+'px';cs.width=CW*dpr;cs.height=CHH*dpr;ci.width=56*dpr;ci.height=56*dpr;
csc.font="700 11px Inter,'Noto Sans SC',system-ui,sans-serif";CX0=clamp(Math.ceil(Math.max(0,...LAB.map(l=>csc.measureText(l+' ›').width)))+10,46,76)}
function setD(d){if(d==curD)return;curD=d;$('#cd').textContent=NC?t('hist.rhythmDay',{n:d}):t('hist.dayNone');$('#cp').textContent=NC?rhythmNote(d):t('hist.rhythmNoRec');if(hold&&fin(AVP)&&d==Math.round(AVP))core.buzz(8)}
function cycUI(){$('.cyc .mut').textContent=NC?(NC==1?t('hist.rhythmDrag1'):t('hist.rhythmDragN',{n:NC})):t('hist.rhythmNone');
curD=-1;sdT=home();sizeC();setD(sdT)}
function setCyc(on){cOpen=on?1:0;rectDirty=true;rectUntil=now+1.25;cyc.classList.toggle('open',on);ch.setAttribute('aria-expanded',on);
if(on){sd=0;sdT=home();hold=false;sizeC();const r=ci.getBoundingClientRect();wave(r.left+28,r.top+28);core.buzz(10);setTimeout(()=>{const b=cyc.getBoundingClientRect().bottom;if(b>SH-120)scr(b-SH+140)},reduce?0:650)}}
ch.onclick=()=>setCyc(!cOpen);
function goto(i){setCyc(false);const r=ens[i].getBoundingClientRect();scr(r.top-SH*.3);pulse={s:i,t:now+.6};setTimeout(()=>{if(openI!=i)toggle(i)},reduce?0:700)}
const cday=e=>clamp(Math.round((e.clientX-cs.getBoundingClientRect().left-CX0)/((CW-CX0-10)/PMAX)+.5),1,PMAX);
cs.tabIndex=0;
cs.addEventListener('pointerdown',e=>{if(!NC)return;const r=cs.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,l=Math.round((y-RY(0))/PITCH);dg={x:e.clientX,y:e.clientY,lab:x<CX0&&l>=0&&l<NC&&Math.abs(y-RY(l))<=PITCH/2?l:-1};if(dg.lab<0){hold=true;sdT=cday(e);try{cs.setPointerCapture(e.pointerId)}catch(_){}}});
cs.addEventListener('pointermove',e=>{if(hold)sdT=cday(e)});
['pointerup','pointercancel'].forEach(k=>cs.addEventListener(k,e=>{hold=false;if(k=='pointerup'&&dg&&dg.lab>=0&&Math.hypot(e.clientX-dg.x,e.clientY-dg.y)<8)goto(RIX[dg.lab]);dg=null}));
cs.addEventListener('keydown',e=>{const k=e.key,s={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[k];if(!NC||(!s&&k!='Home'&&k!='End'))return;e.preventDefault();sdT=k=='Home'?1:k=='End'?PMAX:clamp(Math.round(sdT)+s,1,PMAX)});
function drawIcon(t){const c=cic,Dm=PMAX,b=reduce?Dm:((t*.48)%1.45)*Dm,X=d=>4+(d-.5)*46/Dm;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,56,56);c.lineCap='round';
if(!NC){c.strokeStyle=ik(.35*iin);c.lineWidth=1;c.setLineDash([2,3]);c.beginPath();c.moveTo(4,28);c.lineTo(44,28);c.stroke();c.setLineDash([]);c.strokeStyle=ik(.7*iin);sp(c,49,28,5,0);return}
for(let r=0;r<NC;r++){const y=(r+1)*56/(NC+1),D=DUR[r],dim=openI>=0&&openI!=RIX[r]?.5:1;
for(let d=1;d<=D;d++){if(d/Dm>iin*1.25)break;const fv=FLS[r][d-1],g=gauss(d-b,1.8),h=(fin(fv)?4+(fv/10)*7:3.5)+3*g;c.strokeStyle=ik(((d<=b?.88:.32)+.14*g)*dim);c.lineWidth=Math.min(1.6,46/Dm*.52);c.beginPath();c.moveTo(X(d),y-h/2);c.lineTo(X(d),y+h/2);c.stroke()}
if(D/Dm<=iin*1.25){c.fillStyle=ik(.9*dim*Math.min(1,iin*1.4));sp(c,X(D)+1.5,y,2.8+1.2*gauss(D-b,1.8),1)}}}
function drawChart(){const c=csc,w=CW,Dm=PMAX,p=(w-CX0-10)/Dm,X=d=>CX0+(d-.5)*p,bb=BB,mn=NC?Math.min(...DUR):0,mx=NC?Math.max(...DUR):0;c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,CHH);c.lineCap='round';c.globalAlpha=clamp(coa*1.5);c.textBaseline='middle';c.font="600 9.5px Inter,'Noto Sans SC',system-ui,sans-serif";
if(!NC){c.strokeStyle=ik(.3);c.lineWidth=1;c.setLineDash([2,4]);c.beginPath();c.moveTo(CX0,30);c.lineTo(w-8,30);c.stroke();c.setLineDash([]);c.textAlign='left';c.fillStyle=ik(.45);try{c.letterSpacing='1.2px'}catch(_){}c.fillText(t('hist.rhythmNone'),CX0,50);try{c.letterSpacing='0px'}catch(_){}c.globalAlpha=1;return}
if(NC>1&&mn!=mx){c.fillStyle=ik(.035);c.fillRect(X(mn)-p/2,18,X(mx)-X(mn)+p,bb-18)}
c.textAlign='right';c.fillStyle=ik(.42);try{c.letterSpacing='1.2px'}catch(_){}c.fillText(CAP.toUpperCase(),w-8,bb+18);try{c.letterSpacing='0px'}catch(_){}
let avgX=-999,aw=0;
if(fin(AVP)&&AVP>=.5&&AVP<=Dm+.5){const ax=X(clamp(AVP,1,Dm)),avgText=t('hist.rhythmAvgTag',{n:nf(AVP)});c.strokeStyle=ik(.28);c.lineWidth=.8;c.setLineDash([2,4]);c.beginPath();c.moveTo(ax,20);c.lineTo(ax,bb);c.stroke();c.setLineDash([]);
c.textAlign='center';c.font="800 10.5px Inter,'Noto Sans SC',system-ui,sans-serif";aw=c.measureText(avgText).width;avgX=clamp(ax,CX0+aw/2+4,w-aw/2-4);c.fillStyle=ik(.55+.45*gauss(AVP-sd,2.2));c.fillText(avgText,avgX,8)}
for(let r=0;r<NC;r++){const y=RY(r),D=DUR[r],sel=openI==RIX[r],dim=openI>=0&&!sel?.55:1,flArr=FLS[r].filter(fin),pkFl=flArr.length?Math.max(...flArr):-1;
c.textAlign='left';c.font="700 11px Inter,'Noto Sans SC',system-ui,sans-serif";c.fillStyle=ik((sel?1:.55)*dim);c.fillText(LAB[r]+' ›',2,y);
for(let d=1;d<=Dm;d++){const x=X(d),g=gauss(d-sd,2);
if(d>D){c.fillStyle=ik((.14+.22*g)*dim);c.beginPath();c.arc(x,y,1.4+.5*g,0,7);c.fill();continue}
const fv=FLS[r][d-1],hasFl=fin(fv),pv=PAINS[r][d-1]||0,isPk=hasFl&&fv==pkFl,pw=Math.min(hasFl?6:3,p*.46);
let barTop=y-7-2*g;
if(hasFl){const h=(8+(fv-1)/9*22)+5*g;barTop=y-h/2;if(isPk&&(d<=sd||g>.4))stampGlow(c,x,y,pw*2.2,(.18+.16*g)*dim);c.strokeStyle=ik(((d<=sd?.82:.34)+.18*g+(isPk?.1:0))*dim);c.lineWidth=pw;c.beginPath();c.moveTo(x,y-(h-pw)/2);c.lineTo(x,y+(h-pw)/2);c.stroke()}
else{c.save();c.setLineDash([2,3]);c.strokeStyle=ik((.28+.24*g)*dim);c.lineWidth=Math.min(1.6,p*.28);c.beginPath();c.moveTo(x,y-7-2*g);c.lineTo(x,y+7+2*g);c.stroke();c.restore()}
if(pv>0){c.fillStyle=c.strokeStyle=ik((.65+.35*Math.max(g,d<=sd?.5:0))*dim);c.lineWidth=1;sp(c,x,barTop-5,pv>=5?3.4+.8*g:2.8+.6*g,pv>=4?1:0)}
if(d==D){const ex=x+pw/2+4.5;c.fillStyle=ik((.48+.42*g)*dim);sp(c,ex,y,2.2+.8*g,1)}}}
// scan beam
const bx=X(sd),mid=(14+bb)/2;c.save();c.translate(bx,mid);c.scale(30,(bb-14)/2);const gr=c.createRadialGradient(0,0,0,0,0,1);gr.addColorStop(0,ik(.16+.1*con));gr.addColorStop(1,ik(0));c.fillStyle=gr;c.fillRect(-1,-1,2,2);c.restore();
const g2=c.createLinearGradient(0,14,0,bb);g2.addColorStop(0,ik(0));g2.addColorStop(.3,ik(.8));g2.addColorStop(1,ik(.2));c.strokeStyle=g2;c.lineWidth=1;c.beginPath();c.moveTo(bx,14);c.lineTo(bx,bb);c.stroke();
const dTag='D'+Math.round(sd);c.textAlign='center';c.font="800 10.5px Inter,'Noto Sans SC',system-ui,sans-serif";const bw=c.measureText(dTag).width,dx=clamp(bx,CX0+bw/2+2,w-bw/2-2);
if(!fin(AVP)||Math.abs(dx-avgX)>(bw+aw)/2+8){c.fillStyle=ik(1);c.fillText(dTag,dx,8)}
c.globalAlpha=1}
function drawCyc(t,dt){coa+=(cOpen-coa)*(1-Math.exp(-dt*5));iin+=((cyc.classList.contains('in')?1:0)-iin)*(1-Math.exp(-dt*1.1));con+=((hold?1:0)-con)*(1-Math.exp(-dt*10));
sd=reduce?sdT:sd+(sdT-sd)*(1-Math.exp(-dt*(hold?18:3.2)));if(cOpen)setD(clamp(Math.round(sd),1,PMAX));if(pulse&&t-pulse.t>3.5)pulse=null;
const vis=r=>!!r&&r.bottom>0&&r.top<SH;
if(vis(ciRect))drawIcon(t);
if(coa<.01||!vis(csRect)||!CW)return;drawChart()}
// ---- one clock: scroll depth, weights, ruler, glass light
let last=0;
function loop(ts){const t=ts/1000,dt=Math.min(.05,t-last||.016);last=t;now=t;intro=reduce?3:intro+dt*.8;
if(rectDirty||t<rectUntil)syncRects();
const sy=scrollY;sv+=((sy-lsy)/dt-sv)*.15;lsy=sy;
if(t-lastMove>2.5&&!reduce){px=.5+.3*Math.sin(t*.35);py=.4+.25*Math.cos(t*.27)}spx+=(px-spx)*.08;spy+=(py-spy)*.08;
const gx=spx*SW,gy=spy*SH;for(let i=0;i<glassRects.length;i++){const {el,r}=glassRects[i];if(r.bottom<0||r.top>SH)continue;core.glassLight(el,gx-r.left,gy-r.top,Math.atan2(gy-r.top-r.height/2,gx-r.left-r.width/2)*57.3+90,r.width,r.height)}
if(dm)dm.setAttribute('scale',(30+12*Math.min(1,Math.abs(sv)/900)+8*oa.reduce((m,v)=>Math.max(m,v),0)).toFixed(1));
const h=clamp(sy/320),tTr=reduce?'none':`translate3d(0,${(sy*.38).toFixed(1)}px,0) scale(${(1-.14*h).toFixed(3)})`,tOp=(1-1.1*h).toFixed(3),tFl=h>.02&&!reduce&&!isMob?`blur(${(h*9).toFixed(1)}px)`:'';if(topEl._tr!==tTr){topEl._tr=tTr;topEl.style.transform=tTr}if(topEl._op!==tOp){topEl._op=tOp;topEl.style.opacity=tOp}if(topEl._fl!==tFl){topEl._fl=tFl;topEl.style.filter=tFl}
// memory tunnel: older records recede into depth, newer ones fly past the camera and dissolve
const fy=SH*.42;ens.forEach((en,i)=>{oa[i]+=((openI==i?1:0)-oa[i])*(1-Math.exp(-dt*5));const r=enRects[i];if(!r||r.bottom<-200||r.top>SH+300)return;const u=(r.top+r.height*(openI==i?.2:.5)-fy)/(SH*.55);
const a=Math.abs(u),m=Math.min(a,1.3);let s,o,bl,ty;
if(u>0){s=1-.14*m;o=1-.62*m;bl=4.5*m;ty=0}else{s=1+.08*a;o=1-.85*Math.pow(Math.min(a,1.1),1.3);bl=3*a;ty=-34*a}
if(reduce||isMob){bl=0}if(reduce){ty=0}if(openI==i){o=Math.max(o,.9);bl=0}
const f=Math.max(gauss(u,.5),oa[i]).toFixed(3),hd=hds[i],hTr=`translate3d(0,${ty.toFixed(1)}px,0) scale(${s.toFixed(3)})`,hOp=clamp(o).toFixed(3),hFl=bl>.3?`blur(${bl.toFixed(1)}px)`:'';if(en._f!==f){en._f=f;en.style.setProperty('--f',f)}if(hd._tr!==hTr){hd._tr=hTr;hd.style.transform=hTr}if(hd._op!==hOp){hd._op=hOp;hd.style.opacity=hOp}if(hd._fl!==hFl){hd._fl=hFl;hd.style.filter=hFl}});
const histActive=Math.abs(sv)>=2||rectDirty||t<rectUntil||waves.length||pulse||hold;
if(skyOnce||!isMob||histActive||t-skyT>=.032){drawSky(t);drawRuler(t);skyT=t;skyOnce=false}drawCyc(t,dt);requestAnimationFrame(loop)}
cacheInk();buildList();size();requestAnimationFrame(loop);
core.on('lang',()=>{const oi=openI;buildList();rectDirty=true;if(oi>=0&&ens[oi]){openI=oi;ens[oi].classList.add('open');hds[oi]&&hds[oi].setAttribute('aria-expanded','true');segs[oi]&&segs[oi].classList.add('flow')}});
core.on('tilt',e=>{if(!e||!core.isCur(PGID)||openI>=0||cOpen)return;px=clamp(e.x,.04,.96);py=clamp(e.y,.04,.96);lastMove=now});
function resetView(){if(openI>=0){openI=-1;oa.fill(0);ens.forEach((e,k)=>{e.classList.remove('open');hds[k]&&hds[k].setAttribute('aria-expanded','false');segs[k]&&segs[k].classList.remove('flow')})}
if(cOpen){cOpen=0;coa=0;cyc.classList.remove('open');ch.setAttribute('aria-expanded','false')}
scrollY=0;lsy=0;sv=0;topEl.style.transform='';topEl.style.opacity='';topEl.style.filter='';topEl._tr='';topEl._op='';topEl._fl='';rectDirty=true;skyOnce=true}

return {size,cacheInk,setSY:v=>{scrollY=v;rectDirty=true},wave,resetView,refresh:()=>{const prev=buildList();openI=-1;oa.fill(0);rectDirty=true;const n=R.findIndex(o=>!prev.has(o.s));if(n>=0){pulse={s:n,t:now+.35};wave(innerWidth/2,innerHeight*.4);core.buzz(10)}}};}
