/* ===== edit.js =====
 * 1 角色：边界编辑：op→step 计划、mock 快照回滚、real 写后重取与单次 commit。
 * 2 依赖：state.js（CYC/api/commit/days/TODAY/iso/cycAt/endOf）、transport（api._mode）。
 * 3 暴露：FUTURE_EDIT,editNoop,editPlan,editMock,editSig,editNote,editApplied,editHydrate,editReal,edit（顶层，不挂 window）。
 * 4 不变量：op 到 step 的计划两份 provider 共用；real 不先改 CYC；成功路径恰好一次 commit；失败返回 editNoop 且本地状态不变。
 * 5 契约来源：数据层契约（原 core.js 63–64 行注释随段原样保留）；Win\backend cycles 边界契约。
 * 6 禁止改动项：分支/条件/阈值（7 天、n+1/n-1）、错误与提示文案、step 顺序、commit 时机、事件名。
 * 迁自：前端demo/app拆解版@1cd5082 js/core.js 第 60–117 行
 */
// ---- boundary editing. ops: start | end | clear | remove. Returns a diff the pages turn into VFX.
// The op -> step plan below is shared by both providers so the boundary rules cannot drift.
// Mock applies the steps to the in-memory intervals with a snapshot/rollback and one commit.
// [data-layer] Real sends the same steps, re-hydrates the whole model, then diffs days() before/after;
// it never patches CYC first. A split re-hydrates in finally to correct a possibly half-applied write.
const FUTURE_EDIT='Future days can’t be marked yet.';
const editNoop=(op,n,msg)=>({ok:false,op,n,msg,added:[],removed:[],merged:[]});
const editPlan = function editPlan(op,n){const c=cycAt(n);
if(op=='start'){
if(c){if(n==c.s)return{noop:'This day already starts the period.'};return{kind:'trim-head',steps:[{m:'update',id:c.id,body:{period_start:iso(n)}}]}}
const nx=CYC.filter(q=>q.s>n&&q.s-n<=7).sort((a,b)=>a.s-b.s)[0];
if(nx)return{kind:'pull-start',steps:[{m:'update',id:nx.id,body:{period_start:iso(n)}}]};
return{kind:'create',steps:[{m:'create',body:{period_start:iso(n),period_end:n==TODAY?null:iso(n)}}]}}
if(op=='end'){
if(c){if(c.e===n)return{noop:'This day already ends the period.'};return{kind:c.e==null?'close':'trim-tail',steps:[{m:'update',id:c.id,body:{period_end:iso(n)}}]}}
const pv=CYC.filter(q=>endOf(q)<n).sort((a,b)=>a.s-b.s).pop();
if(!pv)return{noop:'Mark a start first.'};
return{kind:'extend',steps:[{m:'update',id:pv.id,body:{period_end:iso(n)}}]}}
if(op=='clear'||op=='remove'){
if(!c)return{noop:'No period covers this day.'};
const e=endOf(c);
if(op=='remove'||c.s==e)return{kind:'delete',steps:[{m:'remove',id:c.id}]};
if(n==c.s)return{kind:'trim-head',steps:[{m:'update',id:c.id,body:{period_start:iso(n+1)}}]};
if(n==e)return{kind:'trim-tail',steps:[{m:'update',id:c.id,body:{period_end:iso(n-1)}}]};
const oldEnd=c.e;
return{kind:'split',steps:[{m:'update',id:c.id,body:{period_end:iso(n-1)}},{m:'create',body:{period_start:iso(n+1),period_end:oldEnd==null?null:iso(oldEnd)}}]}}
return{noop:'Unknown action.'}};
const editMock = function editMock(op,n){if(n>TODAY)return editNoop(op,n,FUTURE_EDIT);const p=editPlan(op,n);if(p.noop)return editNoop(op,n,p.noop);
const before=days(),snap=CYC.map(q=>({id:q.id,s:q.s,e:q.e,note:q.note||''})),uid0=uid,C=api.cycles;
const drop=msg=>{CYC.length=0;snap.forEach(q=>CYC.push({id:q.id,s:q.s,e:q.e,note:q.note}));uid=uid0;return editNoop(op,n,msg)};
for(const st of p.steps){const r=st.m=='create'?C.create(st.body):st.m=='update'?C.update(st.id,st.body):C.remove(st.id);if(!r||!r.ok)return drop(r?r.message:'The edit was rejected.')}
commit('cal');const after=days();
return{ok:true,op,kind:p.kind,n,merged:[],added:[...after].filter(d=>!before.has(d)).sort((a,b)=>a-b),removed:[...before].filter(d=>!after.has(d)).sort((a,b)=>a-b),msg:''}};
const editSig=()=>CYC.map(c=>[c.id,c.s,c.e,c.note||''].join(':')).sort().join('|');
const editNote=m=>{api._hydrateNote=api._hydrateNote?api._hydrateNote+'; '+m:m};
const editApplied=h=>!!(h&&h.ok&&!(h.data&&h.data.stale));
const editHydrate = async function editHydrate(){try{return await api.hydrate()}catch(e){return{ok:false,status:0,code:'ADAPTER_ERROR',message:e&&e.message?e.message:String(e)}}};
const editReal = async function editReal(op,n){
if(n>TODAY)return editNoop(op,n,FUTURE_EDIT);
const p=editPlan(op,n);if(p.noop)return editNoop(op,n,p.noop);
const before=days();let fail=null;
try{
for(let i=0;i<p.steps.length;i++){const st=p.steps[i];
const r=st.m=='create'?await api.cycles.create(st.body):st.m=='update'?await api.cycles.update(st.id,st.body):await api.cycles.remove(st.id);
if(!r||!r.ok){fail={step:i+1,res:r};break}}
}catch(e){fail={step:0,res:{message:'The edit was rejected.'}}}
finally{
if(fail&&p.steps.length>1){const sig0=editSig(),h=await editHydrate();
if(editApplied(h)){if(editSig()!==sig0)commit('api')}
else editNote(h&&h.ok?'edit re-hydrate superseded; split state may be stale':'edit re-hydrate after failed split: '+(h&&h.code?h.code:'unknown'))}}
if(fail)return editNoop(op,n,fail.res&&fail.res.message?fail.res.message:'The edit was rejected.');
const h=await editHydrate();let stale=false;
if(!editApplied(h)){stale=true;editNote(h&&h.ok?'edit hydrate superseded; local state may be stale':'edit hydrate after write failed: '+(h&&h.code?h.code:'unknown'))}
commit('cal');const after=days();
const out={ok:true,op,kind:p.kind,n,merged:[],added:[...after].filter(d=>!before.has(d)).sort((a,b)=>a-b),removed:[...before].filter(d=>!after.has(d)).sort((a,b)=>a-b),msg:''};
if(stale)out.stale=true;
return out};
const edit = function edit(op,n){if(api._mode!=='mock')return editReal(op,n);if(n>TODAY)return editNoop(op,n,FUTURE_EDIT);return editMock(op,n)};
