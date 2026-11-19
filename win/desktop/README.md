# desktop — Windows 桌面壳（Win 端）

| 文件 / 目录 | 说明 |
|---|---|
| `__init__.py` | 桌面包初始化（使 `python -m desktop.entry` 可用） |
| `entry.py` | 桌面入口：`--headless` 只起服务 / `--windowed` 启用 WebView2 宿主窗口 / `--port N` / `--print-data-dir` |
| `window.py` | 窗口逻辑；`resolve_native_host()` 按 显式参数 → `PERIODIQ_NATIVE_HOST` 环境变量 → 本目录（`native_host.exe` 或 `bin\`）定位宿主 |
| `native_host.cs` | WebView2 宿主（C#）源码；编译产物放本目录或 `bin\`，或用环境变量指定 |
| `build_native_host.ps1` | 原生宿主编译脚本：csc 由 `%WINDIR%` 推导，产物落 `bin\` |
| `process_guard.py` / `appdata.py` | 宿主配套：进程守护 / 数据目录解析 |
| `app.ico` / `dpi.manifest` | 图标与 DPI 清单；`app.ico` 2026-11-15 已由新品牌包重制（源 `photo/logos/periodiq-icon-1024-dark.png`，21,753 B、SHA256 `13e0f4f0…a2def`，16–256 共 7 尺寸 32bpp；P4 2026-11-14 由旧 `photo/logos/logo_new.png`（已删除）生成的 18,870 B 旧图标为历史口径）；三处同源机制（PyInstaller `--icon` / native_host 资源 / installer.iss `SetupIconFile={#MyIcon}`）不变（见 `photo/logos/README.md`、DECISIONS D6/D8） |
| `webview2_sdk\` | WebView2 运行库 DLL |

- 打包脚本已上提：`~\setup_out\Build\Win\installer.iss`（Inno Setup）。
- 编译工具链位置见根 `README.md` 的「本机构建环境」节；不在本目录写死任何绝对路径。

## 编译原生宿主

在 PowerShell 里进入本目录后执行：

```powershell
.\build_native_host.ps1
```

- 编译器：.NET Framework 4.x 自带的 `csc.exe`（C# 5），路径由 `%WINDIR%` 推导（`Microsoft.NET\Framework64\v4.0.30319\csc.exe`；缺失时回退 32 位 `Framework\` 并给出提示），脚本不写死任何机器绝对路径。
- 依赖：`webview2_sdk\` 内的 `Microsoft.Web.WebView2.Core.dll` / `Microsoft.Web.WebView2.WinForms.dll`（编译引用）与 `WebView2Loader.dll`（运行时）。
- 产物：`bin\native_host.exe`；`bin\WebView2Loader.dll` 及两个 WebView2 托管 DLL 由 `webview2_sdk\` 复制而来。
- 脚本自行创建 `bin\`；编译失败返回非零退出码并打印 csc 错误，成功返回 0。

## 宿主窗口规则（win_v1_16x9：严格 16:9）

口径统一为 **GetWindowRect 外框**（物理像素）；逻辑像素 = 物理 ÷ (dpi/96)，
dpi 取 `GetDpiForWindow`（PMv2 下与 `GetDpiForSystem` 一致）。

| 场景 | 规则 |
|---|---|
| 初始尺寸 | 逻辑 **1280×720**（严格 16:9）按 dpiScale 放大；句柄创建后按 rcWork 精确居中（误差 ≤2px） |
| 最小尺寸 | 逻辑 **960×540** 放大（`WM_GETMINMAXINFO.ptMinTrackSize` + `MinimumSize`） |
| 最大化 | 工作区内**最大的 16:9 矩形**并居中；`WM_NCCALCSIZE` 的 zoomed 分支用同一套矩形 |
| 自由缩放 | `WM_SIZING` 按 WMSZ_\* 以对角为锚改矩形；`WM_WINDOWPOSCHANGING` 兜底钳制（两者共用 `ClampRectTo169`） |
| 拖动 | 自实现，不走 Aero Snap：**移动阈值起拖**——按下只记锚点、不取鼠标捕获；光标位移超过 4px 才 `SetCapture` 并开始移动（`SetWindowPos(SWP_NOSIZE)` 只移不改尺寸） |
| 双击标题栏 | 前端 `dblclick → win_toggle_max` 为**主路径**（阈值内松手 ⇒ 从未取捕获 ⇒ 浏览器能收齐 click/dblclick）；宿主自判双击为**兜底**，且**推迟到松手之后**再切换（按住左键时系统会忽略 `SC_MAXIMIZE`） |

任何时刻外框都满足：严格 16:9（w×9 == h×16）、≥ 逻辑 960×540、整窗落在 rcWork 内。
旧口径（初始 1100×760 / 最小 720×520；P2-B 的 4:3：初始 1024×768 / 最小 800×600）作废
——P2-B 严格 4:3 规则（`ClampRectTo43` 等）：历史（4:3，已由 win_v1_16x9 取代）。

钳制核心 `ClampRectTo169`：档位网格 w=16k / h=9k，kMin = max(⌈minW/16⌉, ⌈minH/9⌉)
（按 dpiScale 覆盖逻辑最小档），配套 `Fit169ByWidth` / `Fit169ByHeight`、
`ComputeMax169` / `Max169Rect`（最大化矩形）。
最小档与工作区的冲突阈值：dpi ≤ 256 时最小档（960×540 × dpiScale）总放得进本机
2560×1440 工作区（2560/960×96 = 1440/540×96 = 256；240 DPI 最小档 2400×1350 放得下）；
dpi > 256 时 kMax < kMin，走回退——保最小档、位置让路（下沿可越出 rcWork）。

尺寸钳制的**可用空间**口径（2026-11-14 修复轮）：改尺寸时上限不是整块 rcWork，而是
**从当前位置起算的可用空间**（可用宽 = `work.Right - x`、可用高 = `work.Bottom - y`）；
纯移动（拖动）时尺寸一律不动，只把位置夹回 rcWork（拖到边缘贴边）。
程序化 resize 走两段式：先算出「含位置」的目标矩形，再用**带位置**的 `SetWindowPos` 一次性落位
（`SWP_NOMOVE` 下 Windows **不采纳**回写的 x/y，实测仅瞬时生效后被还原，故不用）。

### 控制口新增命令（仅探针/取证；生产桥协议不变）

既有命令（`ping` / `ready` / `rect` / `metrics` / `placement` / `hang_probe` / `dom_text` /
`click_btn` / `dblclick_drag` / `shell_state` / `dom_rects` / `eval_js` / `sc_*` / `quit`）
及其输出格式保持不变；下列为 P2-B 新增，涉及窗口 API 的一律经 `BeginInvoke` 封送到 UI 线程。

| 命令 | 说明 | 返回样例 |
|---|---|---|
| `resize <w> <h>` | 强制为指定**物理**尺寸：先按「当前位置起算的可用空间」算出含位置的目标矩形，再用**带位置**的 `SetWindowPos` 一次性落位（`SWP_NOZORDER\|SWP_NOACTIVATE`）；返回落位后的完整外框 | `resize 320,180,1760,990 w=1440 h=810 work=0,0,2560,1440 w=2560 h=1440 zoomed=0`（实测：请求 1000×540 < 最小档 → 抬到 1440×810） |
| `sizing_probe <w> <h> <edge>` | 用与 `WM_SIZING` 同一个钳制函数计算（edge ∈ left/right/top/bottom/topleft/topright/bottomleft/bottomright） | `sizing_probe 680,445,2120,1255 w=1440 h=810 edge=left anchor=bottom_right work=0,0,2560,1440 w=2560 h=1440` |
| `visibility` | 窗口可见性（托盘隐藏场景取证） | `visibility true` |
| `monitor` | rcWork / rcMonitor / 窗口 DPI / 系统 DPI | `monitor rcWork=0,0,2560,1440 rcMonitor=0,0,2560,1440 win_dpi=144 sys_dpi=144 scale=1.5000` |
| `geom` | 几何总读数：外框 / 客户区 / 逻辑尺寸 / 居中误差 | `geom outer=320,180,2240,1260 w=1920 h=1080 client=0,0 cw=1898 ch=1058 dpi=144 scale=1.5000 logical=1280.00x720.00 client_logical=1265.33x705.33 center_err=0,0 work=0,0,2560,1440 zoomed=0 iconic=0 visible=1` |

> `sizing_probe` 的锚点表：LEFT→右下、RIGHT→左下、TOP→左下、BOTTOM→左上；
> 四个角 → 抓角的对角角点。边拖动用被抓轴驱动尺寸，角拖动用「与提议矩形更接近」的一轴驱动。
