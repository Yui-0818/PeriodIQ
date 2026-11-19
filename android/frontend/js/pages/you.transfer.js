/* ------------------------------------------------------------------
   1 角色：You 页导入导出：CSV 编解码、JSON 校验、字节闸门与 air 引力透镜画布；B7R-2：Data 卫星内部重构（双体导出 / 轨道插入式导入 / 星图式格式说明），仅 UI
   2 依赖：core、PG、state（dialog.showDlg/pos/syncDB/stamp 等装配面；you.css 先于 you.data.css 加载）。
   3 暴露：YouTransfer(core,PG,state) → {drawAir,air}（air 现为透镜画布，drawAir 签名不变）。
   4 不变量：数据层标记注释所保护的解析/导入体与原有字节闸门逐字保留；导出文件字节内容不变；Data 全部 id 与流程不变。
   5 契约来源：早期前端设计文档；demo@1cd5082 pages/you.js 第 87–215 行为唯一基线；早期跨端契约（D4 格式事实，数据层逐字不变）；早期任务书。
   6 禁止改动项：不得重写解析与导入体；不得改列名/文案/阈值/分支顺序；不得新增依赖或挂 window；新增类一律 x- 前缀（x-fmt-pair/-sig/-n/-cap/-key/-f/-lg/-hdr、x-o、x-f、x-nil、x-go），见 you.data.css 头注。
   迁自：demo@1cd5082 js/pages/you.js 第 87–215 行
   ------------------------------------------------------------------ */
const YouTransfer = (core, PG, state) => {
// ---------- data: export (GET /export, never carries mood notes; CSV is built here) and import (POST /import, a full overwrite)
const dl=(name,txt,type)=>{try{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type}));a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000)}catch(_){}};
// CSV export: fixed seven-column header, one row per period day, cycles in the order /export
// returned (period_start ASC already); an ongoing cycle runs through core.m.TODAY with an empty
// period_end column. Daily details come from the export payload, so a truncated daily list just
// leaves those columns empty instead of inventing values. UTF-8 BOM + CRLF, no trailing newline.
function csvOut(d){const rows=[CSVH],D={};(d.daily_records||[]).forEach(r=>{const n=core._data.un(r.record_date);if(n!=null)D[n]=r});
(d.cycles||[]).forEach(c=>{const s=core._data.un(c.period_start);if(s==null)return;const e=c.period_end==null?null:core._data.un(c.period_end),last=e==null?core.m.TODAY:e;
for(let n=s;n<=last;n++){const g=D[n];rows.push([core._data.iso(n),n===s?'1':'0',e!=null&&n===e?'1':'0',g?(g.pain_present?'1':'0'):'',g&&g.pain_present&&g.pain_level!=null?g.pain_level:'',g&&g.flow_level!=null?g.flow_level:'',g&&g.mood_level!=null?g.mood_level:''].join(','))}});
return '\uFEFF'+rows.join('\r\n')}
function runExport(kind,btn){const bar=state.$('#exr'),p=state.pos(btn);bar.classList.remove('x-go');void bar.offsetWidth;bar.classList.add('x-go');state.say('#exs','Packing your data…');
setTimeout(async()=>{
// [data-layer] async write — keep await/Promise; do not revert to synchronous
const r=await core.api.export();if(!r.ok){state.say('#exs',r.message);return}const d=r.data,
// partial-export note: only the export self-description (*_total / *_truncated) is read, never an
// error-body total. CSV never lists predictions because it does not carry any.
cut=[];if(d.cycles_truncated)cut.push(`cycles ${d.cycles.length} of ${d.cycles_total}`);if(kind=='json'&&d.predictions_truncated)cut.push(`predictions ${d.predictions.length} of ${d.predictions_total}`);if(d.daily_records_truncated)cut.push(`daily records ${d.daily_records.length} of ${d.daily_records_total}`);
const tail=cut.length?` · partial export: ${cut.join(' · ')}`:'';
if(kind=='json'){dl('periodiq-backup.json',JSON.stringify(d,null,2),'application/json');state.say('#exs',`Saved periodiq-backup.json · ${state.pl(d.cycles.length,'cycle')} · ${state.pl(d.daily_records.length,'daily record')} · no mood notes${tail}`)}
else{dl('periodiq-cycles.csv',csvOut(d),'text/csv;charset=utf-8');state.say('#exs',`Saved periodiq-cycles.csv · ${state.pl(d.cycles.length,'cycle')}${tail}`)}
core.fx({type:'orb',from:{x:p.x,y:p.y},to:{x:innerWidth*.86,y:64},dur:1100});state.wave(p.x,p.y);state.pulseAt(p.x,p.y,.8)},1150)}
state.$('#ex-json').onclick=e=>runExport('json',e.currentTarget);state.$('#ex-csv').onclick=e=>runExport('csv',e.currentTarget);
let imK='json',imTxt='',imName='',imSz=0,imSt=0,imAny=false,airP=0;
// [data-layer] P0.4 owns this parser and the import body; B7 only restyles the format-help UI —
// do not rewrite these branches. Contract: 早期前端设计文档 (fixed seven-column header,
// one row = one period day, whole-cell quote strip, extra columns ignored, any row order, and
// no local end<start check — the backend gate decides). Line numbers are original file lines.
const CSVH='record_date,period_start,period_end,pain_present,pain_level,flow_level,mood_level',
csvCell=v=>String(v==null?'':v).trim().replace(/^"(.*)"$/,'$1');
// a real calendar day only: core.m.toN + core._data.iso round-trip (UTC day numbers, no local TZ logic)
function csvDate(v){const m=/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);if(!m)return null;const n=core.m.toN(+m[1],+m[2]-1,+m[3]),t=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;return Number.isFinite(n)&&core._data.iso(n)===t?t:null}
function csvBit(v,label,ln){if(v==='1')return 1;if(v==='0')return 0;throw new Error(`Line ${ln}: ${label} must be 0 or 1.`)}
function csvLevel(v,label,ln){if(v==='')return null;if(!/^\d+$/.test(v)||+v<1||+v>10)throw new Error(`Line ${ln}: ${label} must be a whole number from 1 to 10 or empty.`);return +v}
// Seven-column rows -> cycles + daily details, deterministic and never guessing: rows sorted by
// date (duplicates rejected), a cycle opens on period_start=1 and closes on the first following
// period_end=1 (same row = one-day cycle), days must be consecutive, and the file's last open
// cycle stays ongoing (period_end=null). Daily details need BOTH flow_level and mood_level.
function csvCycles(rows){rows.sort((a,b)=>a.n-b.n);const cycles=[],daily=[],iso=core._data.iso;let cur=null,prev=null;
for(const r of rows){if(prev!=null&&r.n===prev)throw new Error(`Line ${r.line}: the date ${iso(r.n)} appears more than once.`);
if(cur==null){if(r.ps!==1)throw new Error(`Line ${r.line}: ${iso(r.n)} is not inside a period (no period_start=1 opens one here).`);cur=r.n}
else{if(r.ps===1)throw new Error(`Line ${r.line}: a new period starts before the one from ${iso(cur)} ended (no period_end=1 row).`);
if(r.n!==prev+1)throw new Error(`Line ${r.line}: ${iso(r.n)} does not follow ${iso(prev)}; every day of a period needs its own row.`)}
if(r.daily)daily.push(r.daily);if(r.pe===1){cycles.push({period_start:iso(cur),period_end:iso(r.n)});cur=null}prev=r.n}
if(cur!=null)cycles.push({period_start:iso(cur),period_end:null});
if(!cycles.length)throw new Error('No usable rows found: a CSV needs at least one period day.');
return{cycles,daily}}
// CSV text -> {cycles,daily}. Header-driven seven-column format first: the first non-empty row
// is a new-format header when ANY of its cells (case-insensitive) is record_date (columns may be
// reordered or extra); otherwise the legacy two-column path (开始日期,结束日期 -> cycles only,
// daily empty) runs, skipping that row as the old header when its first cell is not a date. A
// headerless >=6-column row whose first cell is a date is rejected before the legacy branch.
function parseCsv(t){const lines=t.replace(/^\uFEFF/,'').split(/\r?\n/),cells=l=>l.trim().split(',').map(csvCell);
let h=-1;for(let i=0;i<lines.length;i++)if(lines[i].trim()){h=i;break}
if(h<0)throw new Error('No usable rows found: the file is empty.');
const hc=cells(lines[h]);
// header detected by the record_date column, wherever it sits (columns may be reordered); a
// headerless legacy row never contains that literal, so the fallback below stays unambiguous.
if(hc.some(c=>c.toLowerCase()==='record_date')){const col={};hc.forEach((c,i)=>{const k=c.toLowerCase();if(k&&!(k in col))col[k]=i});
for(const k of ['record_date','period_start','period_end'])if(!(k in col))throw new Error(`Line ${h+1}: the header needs record_date, period_start and period_end columns.`);
const rows=[];
for(let i=h+1;i<lines.length;i++){if(!lines[i].trim())continue;const c=cells(lines[i]),ln=i+1,date=csvDate(c[col.record_date]||'');
if(!date)throw new Error(`Line ${ln}: the date “${c[col.record_date]||'(empty)'}” could not be read as a date.`);
const ps=csvBit(c[col.period_start]||'','period_start',ln),pe=csvBit(c[col.period_end]||'','period_end',ln),
ppr=col.pain_present==null?'':(c[col.pain_present]||''),pp=ppr===''?null:csvBit(ppr,'pain_present',ln),
plv=csvLevel(col.pain_level==null?'':(c[col.pain_level]||''),'pain_level',ln),
fw=csvLevel(col.flow_level==null?'':(c[col.flow_level]||''),'flow_level',ln),md=csvLevel(col.mood_level==null?'':(c[col.mood_level]||''),'mood_level',ln);
if(pp===1&&plv==null)throw new Error(`Line ${ln}: pain_present is 1 but pain_level is empty.`);
if(pp===0&&plv!=null)throw new Error(`Line ${ln}: pain_present is 0 but pain_level is set.`);
const pain=pp==null?(plv==null?0:1):pp;
rows.push({n:core._data.un(date),ps,pe,line:ln,daily:fw!=null&&md!=null?{record_date:date,pain_present:pain,pain_level:pain?plv:null,flow_level:fw,mood_level:md}:null})}
return csvCycles(rows)}
// headerless seven-column input is not a legacy two-column file: reject it clearly instead of
// reading period_start as an end date or silently opening an "ongoing" cycle on an empty cell.
if(hc.length>=6&&csvDate(hc[0]||''))throw new Error('Line ' + (h + 1) + ': a seven-column CSV needs the record_date header row.');
const out=[];
for(let i=h;i<lines.length;i++){if(!lines[i].trim())continue;const c=cells(lines[i]),ln=i+1,s=csvDate(c[0]||'');
if(!s){if(i===h)continue;throw new Error(`Line ${ln}: the start date “${c[0]||'(empty)'}” could not be read as a date.`)}
const raw=c[1]||'',e=raw?csvDate(raw):null;
if(raw&&!e)throw new Error(`Line ${ln}: the end date “${raw}” could not be read as a date.`);
out.push({period_start:s,period_end:e})}
if(!out.length)throw new Error('No usable rows found: a CSV needs at least one period start date.');
return{cycles:out,daily:[]}}
let csvCache={txt:null,rows:null,daily:null,err:null},jsCache={txt:null,doc:null,err:null};
const csvParse=t=>{if(csvCache.txt===t)return csvCache;let rows=null,daily=null,err=null;try{const p=parseCsv(t);rows=p.cycles;daily=p.daily}catch(e){err=e&&e.message?e.message:'That CSV could not be read.'}return csvCache={txt:t,rows,daily,err}},
// JSON backup: keep the parsed object, the three lists must be arrays when the key is present
// (missing -> []); the body later keeps only the five contract keys.
jsonParse=t=>{if(jsCache.txt===t)return jsCache;let doc=null,err=null;try{const j=JSON.parse(t);
if(!j||typeof j!='object'||Array.isArray(j))err='That file is not a PeriodIQ backup.';
else for(const k of ['cycles','predictions','daily_records'])if(k in j&&!Array.isArray(j[k]))err=`That file has a “${k}” that is not a list.`;
if(!err)doc=j}catch(_){err='That file is not valid JSON.'}return jsCache={txt:t,doc,err}},
readFile=()=>{if(imK=='csv'){const c=csvParse(imTxt);return c.err?{err:c.err}:{cycles:c.rows,daily:c.daily}}
const j=jsonParse(imTxt);if(j.err)return{err:j.err};const d=j.doc;return{doc:d,cycles:Array.isArray(d.cycles)?d.cycles:[],daily:Array.isArray(d.daily_records)?d.daily_records:[]}},
// JSON import body: only the five contract keys survive (app_settings / exported_at / *_total are
// dropped); all three lists are always sent so the backend full-replace path runs (D4).
jsonBody=(doc,allow)=>{const b={cycles:Array.isArray(doc.cycles)?doc.cycles:[],predictions:Array.isArray(doc.predictions)?doc.predictions:[],daily_records:Array.isArray(doc.daily_records)?doc.daily_records:[],allow_anomalies:!!allow};if('model_params' in doc)b.model_params=doc.model_params;return b};
function fileLine(){let txt='No file chosen';if(imName){const f=readFile(),sz=imSz<1024?imSz+' B':(imSz/1024).toFixed(1)+' KB';
txt=f.err?`${imName} · ${sz} · could not be read as ${imK.toUpperCase()}`:`${imName} · ${sz} · ${state.pl(f.cycles.length,'cycle')} · ${state.pl(f.daily.length,'daily record')} found`}
state.$('#fline').textContent=txt;state.$('#imp-ok').setAttribute('aria-disabled',!imName)}
function imStep(n){imSt=n;state.$('#imp').dataset.st=n;['#ip0','#ip1','#ip2'].forEach((s,i)=>state.$(s).classList.toggle('on',i==n));state.$('#ipa').classList.remove('on')}
state.$('#imp-go').onclick=()=>{imStep(1);state.$('#ipr').classList.remove('on');state.say('#ims','');const p=state.pos(state.$('#imp-go'));state.wave(p.x,p.y);core.buzz(6)};
state.$$('.fmt').forEach(b=>b.onclick=()=>{imK=b.dataset.fmt;imTxt='';imName='';imAny=false;state.$('#fi').accept=imK=='json'?'.json,application/json':'.csv,text/csv';state.$('#imp-file').textContent=`Choose ${imK.toUpperCase()} file`;fileLine();imStep(2);const p=state.pos(b);state.wave(p.x,p.y);state.pulseAt(p.x,p.y,.6);core.buzz(6)});
state.$('#imp-x1').onclick=()=>imStep(0);state.$('#imp-back').onclick=()=>imStep(1);state.$('#imp-x2').onclick=()=>{state.$('#ipa').classList.remove('on')};state.$('#imp-file').onclick=()=>state.$('#fi').click();
state.$('#fi').onchange=e=>{const f=e.target.files[0];e.target.value='';if(!f)return;imName='';imTxt='';imAny=false;
// raw-byte pre-screen: File.size is checked before any read or request, so an oversized file is
// never parsed nor sent. The backend's 8 MiB middleware measures request-body bytes instead (CSV
// usually shrinks after conversion, JSON may grow with the envelope) and rejects strictly greater
// sizes with 400 IMPORT_TOO_LARGE, which still maps to the same user-facing text below.
if(f.size>core.api.importBytes){fileLine();state.say('#ims',core.errors.text('IMPORT_TOO_LARGE'));return}
const rd=new FileReader();rd.onload=()=>{imTxt=String(rd.result||'');imName=f.name;imSz=f.size;imAny=false;fileLine();state.$('#ipa').classList.remove('on');state.say('#ims','');const p=state.pos(state.$('#imp-ok'));state.wave(p.x,p.y);core.buzz(6)};rd.onerror=()=>state.say('#ims','That file could not be read.');rd.readAsText(f)};
state.$('#imp-ok').onclick=e=>{if(!imName){state.say('#ims','Choose a file first.');state.$('#imp-ok').animate([{transform:'translateX(0)'},{transform:'translateX(-6px)'},{transform:'translateX(6px)'},{transform:'translateX(0)'}],{duration:260});return}askOverwrite(e.currentTarget,false)};
state.$('#imp-any').onclick=e=>askOverwrite(e.currentTarget,true);
function askOverwrite(el,anom){const f=readFile();if(f.err){state.say('#ims',f.err);return}
const mine=core.m.CYC.length,mineD=Object.keys(core.m.DAILY).length,
text=`Importing rebuilds this device from the file. It first clears all cycles, predictions and daily details here (this device: ${state.pl(mine,'cycle')} · ${state.pl(mineD,'daily record')}), then rebuilds everything from the file (file: ${state.pl(f.cycles.length,'cycle')} · ${state.pl(f.daily.length,'daily record')}).`+(f.daily.length?'':' The file has no daily details, so daily details will be empty after the import.')+(anom?' The unusual entries will be imported as they are.':'')+' This cannot be undone.';
state.dialog.showDlg({origin:state.pos(el),step:`Import · ${imK.toUpperCase()}`,title:'Overwrite everything?',text,ok:'Overwrite and import',no:'Cancel',onOk:()=>({ok:true,after:()=>doImport(anom)})})}
async function doImport(allow){const f=readFile();if(f.err){state.say('#ims',f.err);return}
// [data-layer] async write — keep await/Promise; do not revert to synchronous
const body=imK=='csv'?{cycles:f.cycles,predictions:[],daily_records:f.daily,allow_anomalies:!!allow}:jsonBody(f.doc,allow),
r=await core.api.import(body,{allow_anomalies:!!allow});
if(r.ok){const d=r.data;state.syncDB();state.stamp();imName='';imTxt='';fileLine();imStep(0);state.$('#ipr').classList.add('on');countUp('#e1',d.imported_cycles);countUp('#e2',d.imported_predictions);countUp('#e3',d.imported_daily_records);state.say('#ims',`Imported · ${state.pl(d.imported_cycles,'cycle')} · ${state.pl(d.imported_predictions,'prediction')} · ${state.pl(d.imported_daily_records,'daily record')}`);state.wipeT=state.now;state.wave(innerWidth/2,innerHeight*.4);core.fx({type:'bloom',x:innerWidth/2,y:innerHeight*.4,dur:1100});core.buzz([10,30,10]);return}
// only DATA_ANOMALY still has a page interaction (the server counts anomalies; there is no total)
if(r.code=='DATA_ANOMALY'){const an=Array.isArray(r.anomalies)?r.anomalies:[];state.$('#imano').innerHTML=an.slice(0,3).map(a=>`<div>${state.esc(a&&a.message?a.message:String(a))}</div>`).join('')+(an.length>3?`<div>and ${an.length-3} more</div>`:'');state.$('#ipa').classList.add('on');state.say('#ims',r.message);return}
state.say('#ims',r.message)}
function countUp(sel,to){const el=state.$(sel);el.parentNode.classList.toggle('x-nil',!to);if(state.reduce){el.textContent=to;return}const t0=state.now;(function f(ts){const u=state.clamp((ts/1000-t0)/.9);el.textContent=Math.round(to*(1-Math.pow(1-u,3)));if(u<1)state.requestAnimationFrame(f)})(state.now*1000)}
// ---------- B7R-2 Data sheet UI (touches nothing in the data layer above): export ignition, copy that matches D4, the codex (two channel plates, a chart per channel) and jump links
try{
const sc=state.$('#imp').closest('.sc'),K=['json','csv'],
nt=(l,h)=>`<p class="x-fmt-n"><i>${l}</i>${h}</p>`,
kf=(n,h,o)=>`<div class="x-fmt-f${o?' x-fmt-opt':''}"><b>${n}</b><span>${h}</span></div>`,
gT=(k,n,s,on)=>`<button class="x-fmt-o" role="tab" id="x-fmt-t-${k}" aria-controls="x-fmt-p-${k}" aria-selected="${on}" tabindex="${on?0:-1}"><b>${n}</b><small>${s}</small></button>`,
gP=(k,on,lead,h)=>`<div class="x-fmt-pane${on?' on':''}" role="tabpanel" id="x-fmt-p-${k}" aria-labelledby="x-fmt-t-${k}"><p class="x-fmt-lead">${lead}</p>${h}</div>`,
sv=(vb,h)=>`<svg class="x-fmt-sig" viewBox="${vb}" aria-hidden="true">${h}</svg>`,
tx=(x,y,s,a)=>`<text x="${x}" y="${y}"${a?` text-anchor="${a}"`:''}>${s}</text>`,
mo=(x,y,o)=>`<circle${o?' class="x-o"':''} cx="${x}" cy="${y}" r="3.6"/>`,
// JSON chart: a planet with its carried bodies on one ring; what the file holds but import ignores drifts outside it
sgJ=sv('0 0 300 116','<ellipse cx="150" cy="68" rx="88" ry="34"/><circle cx="150" cy="68" r="8"/><circle class="x-f" cx="150" cy="68" r="15"/>'+mo(67,56)+tx(59,60,'cycles','end')+mo(230,54)+tx(238,58,'predictions')+mo(106,97)+tx(98,101,'daily records','end')+mo(194,97,1)+tx(202,101,'model')+'<circle class="x-f" cx="58" cy="14" r="3"/>'+tx(58,30,'settings','middle')+'<circle class="x-f" cx="150" cy="8" r="3"/>'+tx(150,24,'export time','middle')+'<circle class="x-f" cx="242" cy="14" r="3"/>'+tx(242,30,'totals','middle')),
// CSV chart: the seven fields as one constellation, numbered in export order; solid = required, hollow = optional
sgC=sv('0 0 300 100','<path d="M30 70L68 56L108 42L150 34L236 24L250 74L166 80L150 34"/>'+[[30,70],[68,56],[108,42],[150,34],[236,24],[250,74],[166,80]].map((p,i)=>mo(p[0],p[1],i>2)+tx(p[0]+7,p[1]-6,i+1)).join('')),
G=document.createElement('div');
state.$('#ex-csv span').textContent='Cycles and daily details, one row per period day';
state.$('.fmt[data-fmt=csv] small').textContent='Cycles + daily details';
state.$('#ip0 .hint').textContent='Replaces everything on this device. No merge, no undo.';
['#ex-json','#ex-csv'].forEach(q=>{const b=state.$(q);b.addEventListener('click',()=>{b.classList.add('x-run');setTimeout(()=>b.classList.remove('x-run'),1500)})});
G.className='blk x-fmt rvl';G.style.setProperty('--k',3);
G.innerHTML=`<div class="eb">Formats</div>
<p class="x-fmt-sum">Two channels carry your data, a JSON backup and a CSV of cycles. Nothing is entered by hand. Every import <b>replaces this whole device</b>: cycles, predictions and daily details are cleared, then rebuilt from the file. Nothing is merged, it cannot be undone, and journal entries are never carried. Files can be up to 8&nbsp;MiB.</p>
<div class="x-fmt-pair" role="tablist" aria-label="File format">${gT('json','JSON','Backup',true)}${gT('csv','CSV','Cycles',false)}</div>`+
gP('json',1,'The full backup.',sgJ+'<p class="x-fmt-cap">Inside the ring is imported, the hollow model only when present. Outside it, settings, export time and totals stay in the file.</p>'+
nt('Carries','Cycles, predictions, daily details and the prediction model. No mood notes.')+
nt('Daily','Each daily detail holds a date, pain (yes or no, and its level), flow and mood.')+
nt('Import','Reads cycles, predictions and daily details, plus the model when present. A <b>missing list counts as empty</b>.')+
nt('Ignored','App settings, export time and totals are never imported.')+
nt('Unusual','If entries look unusual you see them first and can import anyway.'))+
gP('csv',0,'Cycles, one row per period day.',
nt('Carries','Cycles and daily details. No predictions, no mood notes.')+sgC+
'<div class="x-fmt-key">'+kf('record_date','A date, 2026-03-05')+kf('period_start','1 on the first day, else 0')+kf('period_end','1 on the last day, else 0')+kf('pain_present','1 or 0; empty reads from pain_level',1)+kf('pain_level','Whole number 1–10 with pain; empty without',1)+kf('flow_level','Whole number 1–10, or empty',1)+kf('mood_level','Whole number 1–10, or empty',1)+'<p class="hint x-fmt-lg">Solid is required, hollow optional. Start the file with this header row.</p></div>'+
'<p class="x-fmt-hdr">record_date,period_start,period_end,pain_present,pain_level,flow_level,mood_level</p>'+
nt('Rows','<b>One row per period day.</b> Days outside a period are left out. Any row order; each date once.')+
nt('Cycles','<b>period_start 1</b> opens a cycle and the next <b>period_end 1</b> closes it. A last cycle with no end row imports as ongoing.')+
nt('Days','Days inside a period must be consecutive. A gap, an overlap or a new start before the last end is rejected with its line number.')+
nt('Details','Flow and mood are saved only when <b>flow_level</b> and <b>mood_level</b> both have a value.')+
nt('Pain','<b>pain_present 1</b> needs a pain_level from 1 to 10; <b>0</b> must have none.')+
nt('Columns','Columns can be reordered; optional ones can be left out, and extra columns are ignored. Dates may also read 2026/3/5. A UTF-8 byte-order mark and any line ending are fine.')+
nt('Older','Two-column files (start date, end date) still import cycles only. An end before its start is not checked here; the import decides.')+
nt('Export','Saved as UTF-8 with a byte-order mark and CRLF line breaks, columns in this fixed order. An ongoing period runs through today with period_end empty; missing details stay empty.'))+
'<p class="hint"><b>Partial exports.</b> A very large history may export only in part. The line under the export buttons then names each list that was cut, for example “cycles 40 of 52”.</p>';
sc.append(G);
const tabs=[...G.querySelectorAll('.x-fmt-o')],panes=[...G.querySelectorAll('.x-fmt-pane')],pair=G.querySelector('.x-fmt-pair'),
setFmt=(k,f)=>{const i=K.indexOf(k);tabs.forEach((t,j)=>{t.setAttribute('aria-selected',i==j);t.tabIndex=i==j?0:-1});panes.forEach((p,j)=>p.classList.toggle('on',i==j));pair.style.setProperty('--i',i);if(f)tabs[i].focus()},
jump=k=>{setFmt(k);sc.scrollTo({top:G.getBoundingClientRect().top-sc.getBoundingClientRect().top+sc.scrollTop-6,behavior:state.reduce?'auto':'smooth'})};
tabs.forEach((t,i)=>{t.onclick=()=>{if(t.getAttribute('aria-selected')=='true')return;setFmt(K[i]);const p=state.pos(t);state.wave(p.x,p.y);state.pulseAt(p.x,p.y,.5);core.buzz(6)};t.onkeydown=e=>{const d=e.key=='ArrowRight'?1:e.key=='ArrowLeft'?-1:0;if(d){e.preventDefault();setFmt(K[(i+d+2)%2],true)}}});
state.$$('.fmt').forEach(b=>b.addEventListener('click',()=>setFmt(b.dataset.fmt)));
['#ip0','#ip1','#ip2'].forEach((q,i)=>{const b=document.createElement('button');b.className='gh x-fmt-go';b.textContent='Format guide';b.onclick=()=>jump(i==2?imK:K[+(tabs[1].tabIndex==0)]);state.$(q+' .gxi').append(b)});
}catch(_){}
// ---------- import lens (canvas #air): three dashed orbits (Format, File, Confirm) around the device star; the file body spirals inward as the steps advance and a lensing arc brightens with it. DATA_ANOMALY perturbs the orbit, success flares a ring.
const air=state.$('#air'),airx=air.getContext('2d'),iprE=state.$('#ipr'),ipaE=state.$('#ipa');
let airA=.9,airAn=0,airC=0,airF=9,airOk=false;
function drawAir(t,dt){const w=air.clientWidth,h=air.clientHeight;if(!w||!h)return;const c=airx,rd=state.reduce;dt=Math.min(dt||0,.1);
const W=Math.round(w*state.dpr),H=Math.round(h*state.dpr);if(Math.abs(air.width-W)>1||Math.abs(air.height-H)>1){air.width=W;air.height=H}
airP+=(Math.min(imSt,2)-airP)*(1-Math.exp(-dt*(rd?60:5)));airAn+=((ipaE.classList.contains('on')?1:0)-airAn)*(1-Math.exp(-dt*(rd?60:6)));
const ok=iprE.classList.contains('on');if(ok&&!airOk)airF=rd?9:0;airOk=ok;if(!rd){airC+=dt;airF+=dt}
const T=airC,cx=w/2,cy=h*.46,R=[.43,.29,.16].map(k=>k*w),Y=.34,s=Math.min(airP,2),i0=Math.min(s|0,1),rx=R[i0]+(R[i0+1]-R[i0])*(s-i0),e=s/2;
if(!rd)airA+=dt*.8*Math.pow(R[0]/rx,1.4);
const wob=a=>1+.2*airAn*Math.sin(3*a+T*2.4),px=cx+rx*wob(airA)*Math.cos(airA),py=cy+rx*Y*wob(airA)*Math.sin(airA),
dot=(x,y,a,r)=>{c.fillStyle=state.ik(a);c.beginPath();c.arc(x,y,r,0,7);c.fill()},
body=k=>{for(let n=14;n>0;n--){const a=airA-n*.07,f=1-n/15,q=wob(a);dot(cx+rx*q*Math.cos(a),cy+rx*Y*q*Math.sin(a),.5*f*f*k,.5+1.5*f)}c.fillStyle=state.ik(.95*k);state.sp(c,px,py,4.4+(rd?0:.8*Math.sin(T*6)),1)};
c.setTransform(state.dpr,0,0,state.dpr,0,0);c.clearRect(0,0,w,h);c.lineCap='round';c.lineWidth=1;
R.forEach((r,i)=>{c.setLineDash([2,5]);c.strokeStyle=state.ik(.14+.42*(1-state.clamp(Math.abs(s-i))));c.beginPath();c.ellipse(cx,cy,r,r*Y,0,0,7);c.stroke()});
if(airAn>.02){c.strokeStyle=state.ik(.5*airAn);c.setLineDash([1,4]);c.beginPath();c.ellipse(cx+5*Math.sin(T*1.7),cy,rx*1.06,rx*Y*1.18,.1*Math.sin(T*1.3),0,7);c.stroke()}
c.setLineDash([]);
c.font='700 8px Inter,system-ui,sans-serif';c.textAlign='center';c.textBaseline='alphabetic';
['Format','File','Confirm'].forEach((l,i)=>{c.fillStyle=state.ik(.3+.6*(1-state.clamp(Math.abs(s-i))));c.fillText(l.toUpperCase().split('').join(String.fromCharCode(8202)),cx,cy+R[i]*Y+9)});
const front=Math.sin(airA)>=0;if(!front)body(.5);
const g=c.createRadialGradient(cx,cy,0,cx,cy,36);g.addColorStop(0,state.ik(.34+.3*e));g.addColorStop(1,state.ik(0));c.fillStyle=g;c.beginPath();c.arc(cx,cy,36,0,7);c.fill();
c.strokeStyle=state.ik(.2+.55*e);for(let k=0;k<2;k++){c.beginPath();c.arc(cx,cy,15+3*e,T*.5+k*Math.PI,T*.5+k*Math.PI+1.3);c.stroke()}
c.fillStyle=state.ik(.95);state.sp(c,cx,cy,5+3.5*e+(rd?0:.6*Math.sin(T*2.4)),1);
if(front)body(1);
if(airF<1.8){const u=airF/1.8;c.lineWidth=1.5;c.strokeStyle=state.ik(.8*(1-u)*(1-u));c.beginPath();c.arc(cx,cy,10+w*.46*(1-Math.pow(1-u,3)),0,7);c.stroke()}}
return {drawAir,air};
};
