/* ===== core.js =====
 * 1 角色：唯一对外命名空间装配点：执行 readInk/resize 绑定，并把 28 个成员汇总为顶层 const core。
 * 2 依赖：state.js、fx.js、edit.js、app.js（均已按序加载）；DOM（#fx）。
 * 3 暴露：const core={m,P,LOG,PRED,profile,hist,stats,cycleNow,commit,resetData,on,emit,register,raf,isCur,nav,wave,warpToDate,setTheme,buzz,dm:()=>dmEl,dummy:()=>document.createElement("div"),badge,fx:fxAdd,api,edit,_data,_providers:providers}（28 键，与 demo 198 行 return 完全一致）。
 * 4 不变量：键集合/类型/arity 与 demo 完全一致；不新增/删除属性；不挂 window；readInk 与 resize 绑定在同一次脚本执行中完成。
 * 5 契约来源：原 core.js 198 行 return 的键集即契约；无新增契约。
 * 6 禁止改动项：任何键的增删改名、任何函数体改动、在 core 之外再暴露新全局。
 */
readInk();addEventListener('resize',fxSize);
const core={m,P,LOG,PRED,profile,hist,stats,cycleNow,commit,resetData,on,emit,register,raf,isCur,nav,wave,warpToDate,setTheme,buzz,dm:()=>dmEl,dummy:()=>document.createElement('div'),badge,fx:fxAdd,glassLight,glassLightReset,api,edit,_data,_providers:providers};
