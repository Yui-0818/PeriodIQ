// R25-W2/W3/W4 产品化宿主：独立 Win32 顶层窗 + WebView2 客户区。
// 编译器 = .NET Framework 4.8 csc（C# 5），故不用字符串插值 / ?. 等新语法。
// 禁止 pywebview / frameless=True。动画主体是顶层窗；WebView2 只是客户区。
//
// W3 自绘标题栏：FormBorderStyle.None + CreateParams 补 WS_CAPTION|WS_THICKFRAME
// （DWM 推拉动画依赖该样式位；只加 THICKFRAME 会塌缩 0–33ms），
// 用 WM_NCCALCSIZE 从客户区计算中去掉系统 caption，仅保留可缩放边框（≥6px）。
// W4 几何：PinNormalRect 在 zoomed 态预减 SM_CYCAPTION，抵消 SC_RESTORE
// 按 WS_CAPTION 加回 caption 高度，使 restored==anchor（详见 PinNormalRect 注释）。
// R26-A DPI：manifest(dpi.manifest) 声明 PerMonitorV2 为单一权威；Main 内
// SetProcessDpiAwarenessContext 仅作 manifest 未嵌入时的运行时兜底。
// WM_DPICHANGED 按系统建议矩形调整窗口（唯一允许的 SetWindowPos 用法）。
//
// P2-B 宿主窗口规则（严格 16:9；历史：严格 4:3，已由 win_v1_16x9 取代）：
//   口径 = GetWindowRect **外框**（物理像素）；逻辑像素 = 物理 /(dpi/96)。
//   初始 = 逻辑 1280×720（严格 16:9）按 dpiScale 放大，句柄创建后按 rcWork 精确居中
//   （FormStartPosition.CenterScreen 在 DPI 放大后不精确 → 改 Manual 自行计算）。
//   最小 = 逻辑 960×540（WM_GETMINMAXINFO.ptMinTrackSize，此前**只写了最大尺寸**）。
//   最大化 = 工作区内**最大的 16:9 矩形**并居中；WM_NCCALCSIZE 的 zoomed 分支用同一套
//   矩形（此前客户区是整个 rcWork，与窗口本体对不上）。
//   自由缩放 = WM_SIZING 按 WMSZ_* 以对角为锚改矩形 + WM_WINDOWPOSCHANGING 兜底钳制，
//   两者**共用** ClampRectTo169（唯一权威：严格 16:9 / 在 rcWork 内 / ≥ 逻辑 960×540）。
//   拖动 = 自实现（SetCapture + 光标位移 + SetWindowPos(SWP_NOSIZE)），
//   替掉 ReleaseCapture + WM_NCLBUTTONDOWN(HTCAPTION)（那条会触发 Aero Snap → 非 16:9）。
//   双击最大化由宿主自己判定（SetCapture 后浏览器的第二次点击不再进 DOM，
//   前端 dblclick → win_toggle_max 会失效）；宿主切换后开抑制窗口，前端同名字段忽略。
//
// 用法:
//   native_host.exe --url <http://127.0.0.1:port/> --profile <dir> --info <host_info.json> --log <app_host.log>
//                    --settings <desktop_settings.json>
//   --settings 由 Python 启动时传入数据目录里的设备级偏好文件（theme/close_action，
//   后端 GET/PUT /api/v1/device/settings 写）；本文件不写死任何路径。
//
// 桥（chrome.webview.postMessage，R25-W5 统一单名协议；R32 起五个名字；迭代5 增 win_lang）:
//   win_minimize / win_toggle_max / win_close / win_start_drag / export_pdf / win_lang:<zh-CN|en|es>
//   —— 四个窗控消息与 Win/frontend/js/shell/desktop.js 一一对应；export_pdf 属早期壳桥；
//   win_lang 让宿主原生关闭确认/托盘文案随应用语言（迭代5，3.0.5）；
//   浏览器（无 chrome.webview）由 core.platform.hasShellBridge() 判定为 false 时 no-op，宿主收不到任何消息。
// 下行（R31-C/R32）: ExecuteScriptAsync 调 window.__piqShell.onDownloadDone(status)
//   （下载终态）与 window.__piqShell.onExportDone(status, name)（导出终态三态）。
// 导出 PDF（R32）: 宿主直出——原生「另存为」选路径后 PrintToPdfAsync 静默写盘；
//   禁止 ShowPrintUI/打印预览（浏览器页眉页脚会把本机 URL 泄进 PDF，且带下载气泡）。
// 控制口（TCP 127.0.0.1，仅探针/取证）: ping / ready / rect / hang_probe / dom_text / sc_* / quit。
// 线程规则: CoreWebView2.* 与 ExecuteScriptAsync 仅 UI 线程；TCP 工作线程一律 BeginInvoke 封送。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PeriodIQ.NativeHost
{
    internal static class Native
    {
        public const int WM_SYSCOMMAND = 0x0112;
        public const int WM_NULL = 0x0000;
        public const int WM_NCCALCSIZE = 0x0083;
        // WM_NCLBUTTONDOWN / HTCAPTION：旧拖动路径（ReleaseCapture + WM_NCLBUTTONDOWN
        // (HTCAPTION)）已随 P2-B 自实现拖动整体删除，这两个常量随之无引用，一并删除
        // （留着会让人以为还能走 Aero Snap 那条路）。
        // 同理删除 WM_NCHITTEST 与 9 个 HT* 命中测试常量：它们同样零引用——宿主
        // **不自定义** WM_NCHITTEST，WS_THICKFRAME 的默认边框 hit-test 已提供 ≥6px
        // 可缩放边框（见 WndProc 里的注释），留着同样会误导。
        public const int WM_GETMINMAXINFO = 0x0024;
        public const int WM_WINDOWPOSCHANGING = 0x0046;
        public const int WM_DPICHANGED = 0x02E0;
        // P2-B：16:9 自由缩放 + 自实现拖动所需消息
        public const int WM_SIZING = 0x0214;
        public const int WM_MOUSEMOVE = 0x0200;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        public const int WM_CAPTURECHANGED = 0x0215;
        public const int WM_ACTIVATE = 0x0006;

        // P2-B：WM_SIZING 的 WMSZ_*（抓哪条边/角 → 决定 16:9 的锚点）
        public const int WMSZ_LEFT = 1;
        public const int WMSZ_RIGHT = 2;
        public const int WMSZ_TOP = 3;
        public const int WMSZ_TOPLEFT = 4;
        public const int WMSZ_TOPRIGHT = 5;
        public const int WMSZ_BOTTOM = 6;
        public const int WMSZ_BOTTOMLEFT = 7;
        public const int WMSZ_BOTTOMRIGHT = 8;

        [DllImport("user32.dll")]
        public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPLACEMENT
        {
            public int length;
            public int flags;
            public int showCmd;
            public POINTAPI ptMinPosition;
            public POINTAPI ptMaxPosition;
            public RECT rcNormalPosition;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPOS
        {
            public IntPtr hwnd;
            public IntPtr hwndInsertAfter;
            public int x, y, cx, cy, flags;
        }
        public const int SC_MAXIMIZE = 0xF030;
        public const int SC_RESTORE = 0xF120;
        public const int SC_MINIMIZE = 0xF020;
        public const uint SMTO_ABORTIFHUNG = 0x0002;

        // 窗口样式位（动画依赖 WS_CAPTION|WS_THICKFRAME；只加 THICKFRAME 会塌缩）
        public const int WS_CAPTION = 0x00C00000;
        public const int WS_THICKFRAME = 0x00040000;
        public const int WS_MINIMIZEBOX = 0x00020000;
        public const int WS_MAXIMIZEBOX = 0x00010000;
        public const int WS_SYSMENU = 0x00080000;

        public const int SM_CXSIZEFRAME = 32;
        public const int SM_CYSIZEFRAME = 33;
        public const int SM_CYCAPTION = 4;
        public const int SM_CXPADDEDBORDER = 92;
        public const uint MONITOR_DEFAULTTONEAREST = 2;

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessageTimeoutW(
            IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam,
            uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

        [DllImport("user32.dll")]
        public static extern bool IsHungAppWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        // R26-A：仅 WM_DPICHANGED 建议矩形应用使用；禁止其它路径事后补几何（旧线闪帧教训）。
        // P2-B：追加「窗口定位/尺寸」用途——句柄创建后的精确居中、自实现拖动的移动、
        // 控制口 resize 探针；这三条都是**一次性设置目标几何**，不是事后补几何。
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        // P2-B：WM_WINDOWPOSCHANGING 里判「本次只移动 / 只改尺寸」
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;

        // P2-B：自实现拖动所需（SetCapture + 全局光标 + 双击判定）
        [DllImport("user32.dll")]
        public static extern IntPtr SetCapture(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetCapture();

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINTAPI lpPoint);

        [DllImport("user32.dll")]
        public static extern uint GetDoubleClickTime();

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        public const int VK_LBUTTON = 0x01;

        // P2-B：控制口取证读数（可见性 / 客户区）
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

        // P2-B：把客户区坐标换算成屏幕坐标（双击位移判定用同一坐标系）
        [DllImport("user32.dll")]
        public static extern bool ClientToScreen(IntPtr hWnd, ref POINTAPI lpPoint);

        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4（Win10 1703+）
        public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForSystem();

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct NCCALCSIZE_PARAMS
        {
            public RECT rgrc0; // 新窗口矩形（入）→ 新客户区矩形（出）
            public RECT rgrc1;
            public RECT rgrc2;
            public IntPtr lppos;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINTAPI
        {
            public int x, y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MINMAXINFO
        {
            public POINTAPI ptReserved;
            public POINTAPI ptMaxSize;
            public POINTAPI ptMaxPosition;
            public POINTAPI ptMinTrackSize;
            public POINTAPI ptMaxTrackSize;
        }
    }

    internal sealed class HostForm : Form
    {
        private readonly WebView2 _webView = new WebView2();
        private readonly string _targetUrl;
        private readonly string _profileDir;
        private readonly string _infoPath;
        private readonly string _logPath;
        private readonly string _settingsPath;
        private readonly object _logLock = new object();
        private TcpListener _listener;
        private volatile bool _running = true;
        private volatile bool _ready;
        // 2026-10-26 关闭分流：TCP quit / 托盘「退出应用」置 true，FormClosing
        // 绕过 ask/tray 分流真退出（否则 tray 模式下 quit 命令只会把窗口藏起来，
        // 探针/启动器永远等不到宿主进程结束）。
        private bool _forceClose;
        // 托盘（close_action=tray / ask 对话框选「最小化到托盘」时使用）。
        private NotifyIcon _trayIcon;
        private ContextMenuStrip _trayMenu;
        // 迭代5（3.0.5）：宿主原生文案（关闭确认 / 托盘菜单）随应用语言。前端在桥就绪与
        // 'lang' 事件时发 win_lang:<code>；默认 zh-CN（与旧硬编码一致）。
        private string _uiLang = "zh-CN";

        // 原始 normal 矩形：每次 SC_* 前用 SetWindowPlacement 钉回，防 NCCALCSIZE 尺寸漂移。
        private Native.RECT _normalRect;
        private bool _normalRectSet;

        // ===== P2-B：宿主窗口 16:9 规则 =====
        // 逻辑基准档（外框 GetWindowRect 口径）：默认 1280×720（严格 16:9），最小 960×540。
        // 两档都是精确 16:9（1280*9 == 720*16、960*9 == 540*16），且都是 16/9 的整数倍，
        // 任何 dpiScale 下最小档都落在档位 k 网格上（见 ClampRectTo169）。
        private const int LogicalDefaultW = 1280;
        private const int LogicalDefaultH = 720;
        private const int LogicalMinW = 960;
        private const int LogicalMinH = 540;
        // 当前 DPI 比例（96 DPI = 1.0）。初值取 GetDpiForSystem，WM_DPICHANGED 时更新。
        private double _dpiScale = 1.0;

        // ===== P2-B：自实现拖动（禁用 Aero Snap）状态 =====
        // F2/F3 重构后的状态机（2026-11-14 修复轮）：
        //   _pressTracked —— 宿主跟踪到一次「尚未结束」的按下（按下沿去重靠它：
        //                    桥 / 轮询 / 边框消息三条来源可能同时看到同一次按下）；
        //   _dragArmed    —— 已按下但**未越过移动阈值**：此时**从不取鼠标捕获**，
        //                    所以浏览器能收齐完整的 click/dblclick 序列（前端双击路径得以恢复）；
        //   _dragActive   —— 已越过阈值并取到捕获：真正的「按住移动」；
        //   _dragKeyDown  —— 上一采样点的左键物理状态（按键跳变检测）；
        //   _dblPending   —— 已判定为双击，但**推迟到松手之后**才切换最大化
        //                    （按住左键时 Windows 会忽略 SC_MAXIMIZE）。
        private bool _pressTracked;
        private bool _dragArmed;
        private bool _dragActive;
        private bool _dragKeyDown;             // 上一采样点左键是否按下（跳变检测）
        private bool _captureHeld;             // 拖动期间是否真的拿到了鼠标捕获
        private bool _endingDrag;              // EndDrag 防重入（ReleaseCapture 会发 WM_CAPTURECHANGED）
        private int _upSamples;                // 连续「松手」采样数（防抖）
        private Native.RECT _dragStartRect;    // 拖动起手时的窗口外框
        private Native.POINTAPI _dragStartCursor; // 拖动起手时的光标位置
        private DateTime _dragPressTime;       // 双击基准：第一次按下时间
        private Native.POINTAPI _dragPressPoint; // 双击基准：第一次按下位置
        private bool _dblBaselineValid;        // 双击基准是否有效
        private bool _dblPending;              // 双击已判定、等待松手后切换
        private DateTime _dragLastMoveTime;    // 最后一次窗口移动（硬超时兜底）
        private DateTime _dblWatchUntil;       // 松手后仍监视第二次按下（双击判定窗口）
        private DateTime _lastToggleTime;      // 上次最大化切换时刻（防双重切换）
        private DateTime _toggleSuppressUntil; // 宿主自切换后的抑制窗口（前端消息忽略）
        private System.Windows.Forms.Timer _dragTimer;
        private DateTime _clampSuspendUntil;   // 最小化过渡期间暂停兜底钳制（保动画）

        // ===== F2：SC_* 未生效时的有限重试 =====
        private System.Windows.Forms.Timer _scRetryTimer;
        private int _scRetryCount;
        private int _scRetrySc;
        private DateTime _scRetryStamp;        // 排重试时的切换时刻（期间有别的切换就不重试）

        // ===== P2-B：拖动 / 双击判定参数 =====
        // F2：移动阈值（物理像素）——位移超过它才算「按住移动」，否则按「点击」处理。
        private const int DragMoveThreshold = 4;
        // F2：双击判定允许的最大位移（物理像素；比移动阈值宽，容忍采样与消息延迟）。
        private const int DblClickMaxDistance = 6;
        // F3：轮询防抖——连续 N 拍采样为「松手」才确认抬起（避免合成输入的一帧抖动）。
        private const int DragReleaseDebounce = 2;
        // F3：硬超时——拖动期间超过该时长无任何位移即强制收尾（防捕获泄漏 / 残留拖动态）。
        private const int DragIdleTimeoutMs = 5000;

        /// <summary>
        /// FormBorderStyle.None：WinForms 不管边框/caption。
        /// WS_CAPTION 保留（DWM 推拉动画依赖它）+ NCCALCSIZE 去可见 caption（HTML 自绘栏）。
        /// 尺寸漂移用 WINDOWPLACEMENT.rcNormalPosition 钉回（系统 rcNormal 路径，非 SetWindowPos 补钉）。
        /// </summary>
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.Style |= Native.WS_CAPTION | Native.WS_THICKFRAME
                    | Native.WS_MINIMIZEBOX | Native.WS_MAXIMIZEBOX | Native.WS_SYSMENU;
                return cp;
            }
        }

        /// <summary>
        /// 记录/钉回 normal 矩形。SC_MAXIMIZE/SC_RESTORE 前调用，保证 rcNormalPosition 不漂。
        /// zoomed 态下 SetWindowPlacement 只改恢复目标；此时预减 SM_CYCAPTION，
        /// 抵消 SC_RESTORE 按 WS_CAPTION 加回 caption 高度的系统行为（W4：restored==anchor）。
        /// </summary>
        private void PinNormalRect()
        {
            try
            {
                // 只在首次进入 normal 态时捕获一次：最小化时 GetWindowRect 返回 -32000 不得存；
                // 之后永不覆写——否则 NCCALCSIZE 的一次性高度修正会被当成新基准继续漂移。
                if (!_normalRectSet && !Native.IsIconic(Handle) && !Native.IsZoomed(Handle))
                {
                    Native.GetWindowRect(Handle, out _normalRect);
                    _normalRectSet = true;
                }
                if (!_normalRectSet)
                {
                    return;
                }
                var wp = new Native.WINDOWPLACEMENT();
                wp.length = Marshal.SizeOf(typeof(Native.WINDOWPLACEMENT));
                if (Native.GetWindowPlacement(Handle, ref wp))
                {
                    wp.rcNormalPosition = _normalRect;
                    // 仅从 maximized 还原时 SC_RESTORE 按 WS_CAPTION 把 SM_CYCAPTION
                    // 加回外框高度（实测 +23）。当前 zoomed 时 placement 只写恢复目标，
                    // 不改可见窗；预减 caption 使动画终点外框 == anchor。
                    // 从 minimized 还原不加 caption（实测），故 IsIconic 不得预减。
                    if (Native.IsZoomed(Handle))
                    {
                        wp.rcNormalPosition.Bottom -= Native.GetSystemMetrics(Native.SM_CYCAPTION);
                    }
                    Native.SetWindowPlacement(Handle, ref wp);
                }
            }
            catch (Exception ex)
            {
                Log("pin_normal_err", ex.Message);
            }
        }

        public HostForm(string targetUrl, string profileDir, string infoPath, string logPath,
            string settingsPath)
        {
            _targetUrl = targetUrl;
            _profileDir = profileDir;
            _infoPath = infoPath;
            _logPath = logPath;
            _settingsPath = settingsPath ?? "";

            Text = "PeriodIQ";
            // R39-fix1：任务栏/Alt-Tab 认的是**窗口图标**（WM_SETICON → GCLP_HICON），
            // 不是 exe 文件图标（csc /win32icon 那条链只服务资源管理器/快捷方式/安装包）。
            // 两条链路来源不同：本窗体是 FormBorderStyle.None 的自建窗，Icon 未赋值时
            // WinForms 不发 WM_SETICON ⇒ 任务栏回落到系统通用「应用程序」图标。
            // 图标以**托管资源**嵌入（build_native_host.ps1 的 csc /resource:...app.ico,app.ico），
            // 保留 16–256 共 7 帧，高 DPI 下任务栏取 48 也清晰（ExtractAssociatedIcon 只有 32 单帧）。
            // 按**裸资源名**取流：csc 嵌入的名字就是 "app.ico"，而 Icon(Type, string)
            // 走的是按类型限定名查找（实测拿 "app.ico" 抛 Resource cannot be found），故不用它。
            Icon = new Icon(typeof(HostForm).Assembly.GetManifestResourceStream("app.ico"));
            // None：WinForms 不管边框/caption（几何稳定）；样式位由 CreateParams 补齐（动画）。
            // 系统 caption 由 WM_NCCALCSIZE 从客户区去掉；可见标题栏 = 前端 #app-titlebar。
            FormBorderStyle = FormBorderStyle.None;
            // P2-B：不再用 CenterScreen——DPI 放大后它按 WinForms 自己的逻辑居中，
            // 与「按 rcWork 精确居中（误差 ≤2px）」的验收口径不一致；改为 Manual，
            // 由 OnHandleCreated 里按 rcWork 自己算。
            StartPosition = FormStartPosition.Manual;
            // R26-A：PMv2 下 Width/Height 以物理像素解释。按系统 DPI 放大初始尺寸，
            // 使视觉尺寸与 DPI-unaware 时代一致——否则清晰度修好后窗体会肉眼可见地变小。
            // P2-B：初始档 = **逻辑 1280×720（严格 16:9）**按 dpiScale 放大；
            // 旧口径 1100×760 / 最小 720×520 作废（不再是验收基准）。
            // 历史（4:3，已由 win_v1_16x9 取代）：初始档曾为逻辑 1024×768。
            double dpiScale = 1.0;
            try
            {
                uint sysDpi = Native.GetDpiForSystem();
                if (sysDpi >= 96)
                {
                    dpiScale = sysDpi / 96.0;
                }
            }
            catch (Exception)
            {
            }
            _dpiScale = dpiScale;
            Width = (int)Math.Round(LogicalDefaultW * dpiScale);
            Height = (int)Math.Round(LogicalDefaultH * dpiScale);
            // P2-B：最小尺寸 = 逻辑 960×540 放大（与 WM_GETMINMAXINFO.ptMinTrackSize 同值）。
            MinimumSize = new Size(
                (int)Math.Round(LogicalMinW * dpiScale), (int)Math.Round(LogicalMinH * dpiScale));
            BackColor = Color.FromArgb(0xF6, 0xF1, 0xE8);

            Controls.Add(_webView);
            _webView.Dock = DockStyle.Fill;

            Load += OnFormLoad;
            FormClosing += OnFormClosing;
        }

        /// <summary>
        /// W3：WM_NCCALCSIZE 去掉系统标题栏；**不自定义** WM_NCHITTEST，WS_THICKFRAME 默认边框 hit-test 保住 ≥6px 可缩放边框。
        /// 仍走 SC_* 系统命令做 max/restore/min（动画不走 CSS / SetWindowPos）。
        /// NCCALCSIZE 先让 DefWindowProc 算标准 NC，再只补回 caption 高度 —— 保持系统
        /// 尺寸跟踪一致（直接重算会导致 max↔rest 每轮 +SM_CYCAPTION 漂移）。
        ///
        /// P2-B（严格 16:9 宿主窗口）新增：
        ///   WM_SIZING        → 用户拖边/角：按 WMSZ_* 以对角为锚改矩形，保持 16:9；
        ///   WM_WINDOWPOSCHANGING → 兜底钳制（程序化 SetWindowPos / 贴靠 / DPI 的共同必经路径）；
        ///   WM_GETMINMAXINFO → 最小尺寸（逻辑 960×540）+ 最大化（工作区内最大 16:9 矩形）；
        ///   WM_NCCALCSIZE(zoomed) → 客户区用同一套最大化 16:9 矩形（与窗口本体一致）；
        ///   WM_LBUTTONDOWN/UP/MOUSEMOVE/CAPTURECHANGED → 自实现拖动（禁 Aero Snap）。
        /// </summary>
        protected override void WndProc(ref Message m)
        {
            // P2-B：自实现拖动的鼠标消息（宿主自己判双击，见 ToggleMaxByHost 注释）。
            if (m.Msg == Native.WM_LBUTTONDOWN)
            {
                if (HandleDragMouseDown(ref m))
                {
                    m.Result = IntPtr.Zero;
                    return;
                }
            }
            else if (m.Msg == Native.WM_LBUTTONUP)
            {
                if (_dragActive || _dragArmed)
                {
                    // 宿主拿到了捕获 → mouseup 直接到这里：立即收尾（不等轮询防抖）。
                    _dragKeyDown = false;
                    _upSamples = 0;
                    OnReleaseDetected();
                    m.Result = IntPtr.Zero;
                    return;
                }
            }
            else if (m.Msg == Native.WM_CAPTURECHANGED)
            {
                // 捕获被系统/别的窗口抢走 → 结束拖动（否则会粘住光标）。
                if (_dragActive)
                {
                    EndDrag(false);
                    _pressTracked = false;
                    _dragKeyDown = false;
                }
            }
            else if (m.Msg == Native.WM_ACTIVATE)
            {
                // 失活兜底：拿到捕获时拖动由 WM_LBUTTONUP 结束；若窗口失活而
                // 鼠标抬起没送达（焦点被抢），这里收尾，避免拖动态卡死。
                if ((_dragActive || _dragArmed) && (m.WParam.ToInt32() & 0xFFFF) == 0)
                {
                    EndDrag(false);
                    _pressTracked = false;
                    _dragKeyDown = false;
                }
            }
            else if (m.Msg == Native.WM_MOUSEMOVE)
            {
                if (_dragActive)
                {
                    Native.POINTAPI cur;
                    // F3：只有左键确实按着才跟随光标——松手后窗口绝不再跟鼠标走。
                    if (Native.GetCursorPos(out cur)
                        && (Native.GetAsyncKeyState(Native.VK_LBUTTON) & 0x8000) != 0)
                    {
                        MoveDragTo(cur);
                    }
                }
            }
            // P2-B：用户拖边/角缩放 → 对角锚 + 16:9（与兜底钳制共用同一函数）。
            if (m.Msg == Native.WM_SIZING)
            {
                HandleWmSizing(ref m);
                return;
            }
            // 系统 restore（任务栏/系统菜单）不经过 PinNormalRect：SC_RESTORE 会把
            // SM_CYCAPTION 加回高度。此处只在「非 max/min 且高度恰好=anchor+caption」
            // 时把高度收回 anchor——匹配缺陷形态，不干预用户拖拽缩放。
            if (m.Msg == Native.WM_WINDOWPOSCHANGING)
            {
                if (_normalRectSet
                    && !Native.IsZoomed(Handle) && !Native.IsIconic(Handle))
                {
                    var wp = (Native.WINDOWPOS)Marshal.PtrToStructure(
                        m.LParam, typeof(Native.WINDOWPOS));
                    int aw = _normalRect.Right - _normalRect.Left;
                    int ah = _normalRect.Bottom - _normalRect.Top;
                    int cap = Native.GetSystemMetrics(Native.SM_CYCAPTION);
                    if (wp.cx == aw && wp.cy == ah + cap)
                    {
                        wp.cy = ah;
                        Marshal.StructureToPtr(wp, m.LParam, false);
                        Log("windowpos_clamp", "caption_growth_removed");
                    }
                }
                // P2-B：兜底钳制（放在 caption 修正之后：先修 caption，再过 16:9 钳制）。
                HandleWindowPosChanging(ref m);
            }
            if (m.Msg == Native.WM_GETMINMAXINFO)
            {
                // P2-B：钉住「工作区内最大 16:9 矩形」为最大化几何（居中），
                // 同时补上此前缺失的最小尺寸（ptMinTrackSize = 逻辑 960×540 放大）——
                // 这是程序化 resize 的真实强制点。
                var mmi = (Native.MINMAXINFO)Marshal.PtrToStructure(
                    m.LParam, typeof(Native.MINMAXINFO));
                Native.RECT mon;
                var work = GetMonitorRects(out mon);
                var maxRect = Max169Rect(work);
                int maxW = maxRect.Right - maxRect.Left;
                int maxH = maxRect.Bottom - maxRect.Top;
                // ptMaxPosition 相对**显示器原点**（rcMonitor 左上角），系统据此摆放最大化窗。
                mmi.ptMaxPosition.x = maxRect.Left - mon.Left;
                mmi.ptMaxPosition.y = maxRect.Top - mon.Top;
                mmi.ptMaxSize.x = maxW;
                mmi.ptMaxSize.y = maxH;
                mmi.ptMinTrackSize.x = MinTrackW();
                mmi.ptMinTrackSize.y = MinTrackH();
                Marshal.StructureToPtr(mmi, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == Native.WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                var p = (Native.NCCALCSIZE_PARAMS)Marshal.PtrToStructure(
                    m.LParam, typeof(Native.NCCALCSIZE_PARAMS));
                if (Native.IsZoomed(Handle))
                {
                    // P2-B：最大化态客户区 = 同一套「工作区内最大 16:9 矩形」，
                    // 与 WM_GETMINMAXINFO 给系统的最大化几何完全一致（否则窗口本体是
                    // 16:9 居中、客户区却是整个工作区，两者对不上）。
                    var work = WorkAreaRect();
                    var maxRect = Max169Rect(work);
                    p.rgrc0 = maxRect;
                }
                else
                {
                    // 去掉可见 caption：客户区上移到窗口顶（HTML 栏贴顶）；保留 ≥6px 缩放边框。
                    var frame = Native.GetSystemMetrics(Native.SM_CXSIZEFRAME)
                        + Native.GetSystemMetrics(Native.SM_CXPADDEDBORDER);
                    if (frame < 6)
                    {
                        frame = 6;
                    }
                    p.rgrc0.Left += frame;
                    p.rgrc0.Top += frame;
                    p.rgrc0.Right -= frame;
                    p.rgrc0.Bottom -= frame;
                }
                Marshal.StructureToPtr(p, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }
            // R26-A：缩放切换时按系统建议矩形调整窗口。不在此调用 evaluate_js（早期记录）。
            if (m.Msg == Native.WM_DPICHANGED)
            {
                var suggested = (Native.RECT)Marshal.PtrToStructure(
                    m.LParam, typeof(Native.RECT));
                // P2-B：DPI 变了 ⇒ 逻辑尺寸仍按 16:9 保持（默认档 1280×720、最小档 960×540），
                // 故先更新比例再钳制建议矩形（ApplyDpiSuggestedRect 内已过钳制）。
                int newDpi = (int)(m.WParam.ToInt64() & 0xFFFF);
                if (newDpi >= 96)
                {
                    _dpiScale = newDpi / 96.0;
                }
                ApplyDpiSuggestedRect(suggested.Left, suggested.Top,
                    suggested.Right, suggested.Bottom);
                Log("dpi_changed",
                    "dpi=" + (m.WParam.ToInt64() & 0xFFFF)
                    + " rect=" + suggested.Left + "," + suggested.Top
                    + "," + suggested.Right + "," + suggested.Bottom);
                m.Result = IntPtr.Zero;
                return;
            }
            // WM_NCHITTEST 不自定义：WS_THICKFRAME 的默认边框 hit-test 即可（≥6px）。
            base.WndProc(ref m);
        }

        // =====================================================================
        // P2-B：严格 16:9 宿主窗口 —— 几何核心
        // 口径统一为 **GetWindowRect 外框**（物理像素）；逻辑像素 = 物理 /(dpi/96)。
        // 三条不变量，任何时刻都必须成立：
        //   ① 外框严格 16:9（w*9 == h*16）；
        //   ② 外框 ≥ 逻辑 960×540 的物理值；
        //   ③ 外框整窗落在所在显示器工作区 rcWork 内。
        // 强制点：WM_SIZING（用户拖边/角）与 WM_WINDOWPOSCHANGING（程序化 resize、
        // 系统贴靠、DPI 变化的共同必经路径）**共用同一个钳制函数**，避免两套口径漂移。
        // =====================================================================

        /// <summary>最小尺寸（物理）：逻辑 960×540 × dpiScale。</summary>
        private int MinTrackW()
        {
            return (int)Math.Round(LogicalMinW * _dpiScale);
        }

        private int MinTrackH()
        {
            return (int)Math.Round(LogicalMinH * _dpiScale);
        }

        /// <summary>所在显示器的工作区 rcWork（取不到时回落到系统主屏尺寸）。</summary>
        private Native.RECT WorkAreaRect()
        {
            Native.RECT mon;
            return GetMonitorRects(out mon);
        }

        /// <summary>所在显示器的 rcWork 与 rcMonitor（一次取齐，避免两次查询不一致）。</summary>
        private Native.RECT GetMonitorRects(out Native.RECT monitor)
        {
            monitor = new Native.RECT();
            var mi = new Native.MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
            var hmon = Native.MonitorFromWindow(Handle, Native.MONITOR_DEFAULTTONEAREST);
            if (hmon != IntPtr.Zero && Native.GetMonitorInfo(hmon, ref mi))
            {
                monitor = mi.rcMonitor;
                return mi.rcWork;
            }
            int sw = Native.GetSystemMetrics(0);
            int sh = Native.GetSystemMetrics(1);
            monitor.Left = 0;
            monitor.Top = 0;
            monitor.Right = sw;
            monitor.Bottom = sh;
            var fallback = new Native.RECT();
            fallback.Left = 0;
            fallback.Top = 0;
            fallback.Right = sw;
            fallback.Bottom = sh;
            return fallback;
        }

        /// <summary>
        /// 严格 16:9 拟合（以宽定高）：w 吸附到 16 的倍数后 h = w/16*9，
        /// 保证 w*9 == h*16 精确成立（不引入 ±0.5px 的近似比例）。
        /// </summary>
        private static void Fit169ByWidth(ref int w, ref int h)
        {
            int w16 = (int)Math.Round(w / 16.0) * 16;
            if (w16 < 16)
            {
                w16 = 16;
            }
            w = w16;
            h = w16 / 16 * 9;
        }

        /// <summary>严格 16:9 拟合（以高定宽）：h 吸附到 9 的倍数后 w = h/9*16。</summary>
        private static void Fit169ByHeight(ref int w, ref int h)
        {
            int h9 = (int)Math.Round(h / 9.0) * 9;
            if (h9 < 9)
            {
                h9 = 9;
            }
            h = h9;
            w = h9 / 9 * 16;
        }

        /// <summary>
        /// 工作区内**最大的 16:9 矩形**（最大化用）。
        /// 先按宽取高 w=workW,h=round(workW*9/16)；h>workH 时改按高取宽
        /// h=workH,w=round(workH*16/9)；最后 min 保证不超工作区；再吸附到 16/9 的倍数
        /// 使比例严格成立。
        /// </summary>
        private static void ComputeMax169(int workW, int workH, out int w, out int h)
        {
            w = workW;
            h = (int)Math.Round(workW * 9.0 / 16.0);
            if (h > workH)
            {
                h = workH;
                w = (int)Math.Round(workH * 16.0 / 9.0);
            }
            if (w > workW)
            {
                w = workW;
            }
            if (h > workH)
            {
                h = workH;
            }
            // 吸附到 16 的倍数（宽）或 9 的倍数（高），保证 w*9 == h*16 严格成立。
            int w16 = w / 16 * 16;
            if (w16 > 0 && w16 / 16 * 9 <= workH)
            {
                w = w16;
                h = w16 / 16 * 9;
                return;
            }
            int h9 = h / 9 * 9;
            if (h9 > 0 && h9 / 9 * 16 <= workW)
            {
                h = h9;
                w = h9 / 9 * 16;
            }
        }

        /// <summary>工作区内最大的 16:9 矩形（屏幕坐标，已居中）。</summary>
        private static Native.RECT Max169Rect(Native.RECT work)
        {
            int workW = work.Right - work.Left;
            int workH = work.Bottom - work.Top;
            int w, h;
            ComputeMax169(workW, workH, out w, out h);
            var res = new Native.RECT();
            res.Left = work.Left + (workW - w) / 2;
            res.Top = work.Top + (workH - h) / 2;
            res.Right = res.Left + w;
            res.Bottom = res.Top + h;
            return res;
        }

        /// <summary>
        /// P2-B 单一权威钳制函数：WM_SIZING 与 WM_WINDOWPOSCHANGING 都调它。
        /// 保证 ① 严格 16:9 ② ≥ 逻辑 960×540（物理） ③ 整窗在 rcWork 内。
        /// 每次发生改动都记日志（clamp_min / clamp_work / clamp_169 …），便于取证。
        ///
        /// F1（2026-11-14 修复轮）：尺寸上限不再是「整块 rcWork」，而是
        /// **从当前位置起算的可用空间**（可用宽 = work.Right - x、可用高 = work.Bottom - y）。
        /// 旧算法在窗口偏下/偏右时按整块工作区放行高度（如 1440），高度必然越过工作区
        /// 下沿（实测 top=144 时越界 144px、top=288 时越界 288px）。
        ///
        /// resizeMode=true（改尺寸）：尺寸按可用空间收敛，位置随后在 rcWork 内让路。
        /// resizeMode=false（纯移动，如拖动）：**尺寸一律不动**，只把位置夹回 rcWork
        ///   （窗口拖到边缘时贴边，而不是被"挤瘦"——拖动不得改尺寸）。
        ///
        /// 16:9 用「档位 k」表达（w = 16k、h = 9k）：一条式同时满足
        /// 「严格 16:9 / ≥ 最小档 / ≤ 可用空间」，避免先夹宽再夹高的两段式互相打架。
        /// </summary>
        private Native.RECT ClampRectTo169(Native.RECT r, Native.RECT work, string tag,
            bool resizeMode)
        {
            int workW = work.Right - work.Left;
            int workH = work.Bottom - work.Top;
            int minW = MinTrackW();
            int minH = MinTrackH();
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            bool changed = false;

            int nw = w;
            int nh = h;
            if (resizeMode)
            {
                // ---- 可用空间：以提议矩形的左上角为原点，到工作区右下角 ----
                int availLeft = r.Left < work.Left ? work.Left : r.Left;
                int availTop = r.Top < work.Top ? work.Top : r.Top;
                int availW = work.Right - availLeft;
                int availH = work.Bottom - availTop;
                if (availW < 0)
                {
                    availW = 0;
                }
                if (availH < 0)
                {
                    availH = 0;
                }
                int capW = workW < availW ? workW : availW;
                int capH = workH < availH ? workH : availH;

                // ---- 16:9 档位 k（w = 16k、h = 9k）----
                // kMin = 覆盖逻辑最小档（960×540 × dpiScale）所需的最小 k：
                // w ≥ minW ⇒ k ≥ ⌈minW/16⌉、h ≥ minH ⇒ k ≥ ⌈minH/9⌉（整数向上取整）。
                int kMin = (minW + 15) / 16;
                int kMinH = (minH + 8) / 9;
                if (kMinH > kMin)
                {
                    kMin = kMinH;
                }
                int kMax = capW / 16;
                int kMaxH = capH / 9;
                if (kMaxH < kMax)
                {
                    kMax = kMaxH;
                }
                if (kMax < kMin)
                {
                    // 可用空间连最小档都放不下 → 尺寸保底取最小档，位置随后让路（挪进工作区）。
                    Log(tag + "_min", "k=" + kMin + " avail=" + availW + "x" + availH);
                    kMax = kMin;
                }
                int k = (int)Math.Round(w / 16.0);
                if (k < kMin)
                {
                    Log(tag + "_min", "k=" + k + "->" + kMin);
                    k = kMin;
                }
                if (k > kMax)
                {
                    Log(tag + "_work", "k=" + k + "->" + kMax
                        + " avail=" + availW + "x" + availH);
                    k = kMax;
                }
                nw = 16 * k;
                nh = 9 * k;
                if (nw != w || nh != h)
                {
                    changed = true;
                    Log(tag + "_169", "w=" + nw + " h=" + nh + " (was " + w + "x" + h + ")");
                }
            }

            // 位置：整窗必须落在工作区内（拖动到边缘时贴住工作区边界）。
            int left = r.Left;
            int top = r.Top;
            if (left + nw > work.Right)
            {
                left = work.Right - nw;
                changed = true;
                Log(tag + "_work", "x=" + left);
            }
            if (left < work.Left)
            {
                left = work.Left;
                changed = true;
                Log(tag + "_work", "x=" + left);
            }
            if (top + nh > work.Bottom)
            {
                top = work.Bottom - nh;
                changed = true;
                Log(tag + "_work", "y=" + top);
            }
            if (top < work.Top)
            {
                top = work.Top;
                changed = true;
                Log(tag + "_work", "y=" + top);
            }

            var res = new Native.RECT();
            res.Left = left;
            res.Top = top;
            res.Right = left + nw;
            res.Bottom = top + nh;
            if (changed)
            {
                Log(tag, RectStr(res));
            }
            return res;
        }

        /// <summary>
        /// 把「系统提议的矩形」换算成「对角锚 + 16:9」的矩形（WM_SIZING 与
        /// 控制口 sizing_probe 共用，保证两条路径口径一致）。
        /// 锚点表（抓边 → 固定的对角角点）：
        ///   LEFT→右下、RIGHT→左下、TOP→左下、BOTTOM→左上；
        ///   四个角 → 抓角的对角角点（TOPLEFT→右下、TOPRIGHT→左下、
        ///   BOTTOMLEFT→右上、BOTTOMRIGHT→左上）。
        /// 尺寸驱动：边拖动用被抓轴驱动（LEFT/RIGHT 用宽、TOP/BOTTOM 用高），
        /// 角拖动用「与提议矩形更接近」的一轴驱动。
        /// </summary>
        private static Native.RECT ApplyEdgeAnchor(Native.RECT p, int edge)
        {
            int pw = p.Right - p.Left;
            int ph = p.Bottom - p.Top;
            int w;
            int h;
            if (edge == Native.WMSZ_TOP || edge == Native.WMSZ_BOTTOM)
            {
                w = 0;
                h = ph;
                Fit169ByHeight(ref w, ref h);
            }
            else if (edge == Native.WMSZ_LEFT || edge == Native.WMSZ_RIGHT)
            {
                w = pw;
                h = 0;
                Fit169ByWidth(ref w, ref h);
            }
            else
            {
                int w1 = pw;
                int h1 = 0;
                Fit169ByWidth(ref w1, ref h1);
                int w2 = 0;
                int h2 = ph;
                Fit169ByHeight(ref w2, ref h2);
                if (Math.Abs(w2 - pw) + Math.Abs(h2 - ph)
                    < Math.Abs(w1 - pw) + Math.Abs(h1 - ph))
                {
                    w = w2;
                    h = h2;
                }
                else
                {
                    w = w1;
                    h = h1;
                }
            }
            int left;
            int top;
            switch (edge)
            {
                case Native.WMSZ_LEFT:
                case Native.WMSZ_TOPLEFT:
                    left = p.Right - w;
                    top = p.Bottom - h;
                    break;
                case Native.WMSZ_RIGHT:
                case Native.WMSZ_TOPRIGHT:
                case Native.WMSZ_TOP:
                    left = p.Left;
                    top = p.Bottom - h;
                    break;
                case Native.WMSZ_BOTTOM:
                case Native.WMSZ_BOTTOMRIGHT:
                    left = p.Left;
                    top = p.Top;
                    break;
                case Native.WMSZ_BOTTOMLEFT:
                default:
                    left = p.Right - w;
                    top = p.Top;
                    break;
            }
            var res = new Native.RECT();
            res.Left = left;
            res.Top = top;
            res.Right = left + w;
            res.Bottom = top + h;
            return res;
        }

        /// <summary>矩形 → "l,t,r,b w=W h=H"（控制口读数用）。</summary>
        private static string RectStr(Native.RECT r)
        {
            return string.Format("{0},{1},{2},{3} w={4} h={5}",
                r.Left, r.Top, r.Right, r.Bottom, r.Right - r.Left, r.Bottom - r.Top);
        }

        /// <summary>WMSZ_* 编号 → 锚点名（控制口 sizing_probe 回读用）。</summary>
        private static string AnchorDesc(int edge)
        {
            switch (edge)
            {
                case Native.WMSZ_LEFT:
                    return "bottom_right";
                case Native.WMSZ_RIGHT:
                    return "bottom_left";
                case Native.WMSZ_TOP:
                    return "bottom_left";
                case Native.WMSZ_BOTTOM:
                    return "top_left";
                case Native.WMSZ_TOPLEFT:
                    return "bottom_right";
                case Native.WMSZ_TOPRIGHT:
                    return "bottom_left";
                case Native.WMSZ_BOTTOMLEFT:
                    return "top_right";
                case Native.WMSZ_BOTTOMRIGHT:
                    return "top_left";
                default:
                    return "unknown";
            }
        }

        /// <summary>边名 → WMSZ_* 编号（0 = 非法）。</summary>
        private static int EdgeCode(string edge)
        {
            switch (edge)
            {
                case "left":
                    return Native.WMSZ_LEFT;
                case "right":
                    return Native.WMSZ_RIGHT;
                case "top":
                    return Native.WMSZ_TOP;
                case "bottom":
                    return Native.WMSZ_BOTTOM;
                case "topleft":
                    return Native.WMSZ_TOPLEFT;
                case "topright":
                    return Native.WMSZ_TOPRIGHT;
                case "bottomleft":
                    return Native.WMSZ_BOTTOMLEFT;
                case "bottomright":
                    return Native.WMSZ_BOTTOMRIGHT;
                default:
                    return 0;
            }
        }

        /// <summary>
        /// R26-A：把 WM_DPICHANGED 的建议矩形应用为窗口新几何。
        /// P2-B：建议矩形先过 16:9 / 最小尺寸 / 工作区钳制，再**一次性**应用——
        /// 不新增「事后补几何」的 SetWindowPos 路径（WM_WINDOWPOSCHANGING 的兜底
        /// 钳制是同一套函数，故两条路径口径一致）。
        /// </summary>
        private void ApplyDpiSuggestedRect(int left, int top, int right, int bottom)
        {
            var work = WorkAreaRect();
            var suggested = new Native.RECT();
            suggested.Left = left;
            suggested.Top = top;
            suggested.Right = right;
            suggested.Bottom = bottom;
            var final = ClampRectTo169(suggested, work, "dpi", true);
            Native.SetWindowPos(Handle, IntPtr.Zero,
                final.Left, final.Top, final.Right - final.Left, final.Bottom - final.Top,
                Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
        }

        // =====================================================================
        // P2-B：WM_SIZING（用户拖边/角）与 WM_WINDOWPOSCHANGING（兜底钳制）
        // =====================================================================

        /// <summary>
        /// P2-B：用户拖边/角缩放。系统先把「提议矩形」放在 lParam 里，
        /// 我们按 WMSZ_* 以对角为锚换算成 16:9 矩形，再过同一套钳制
        /// （最小尺寸 + 工作区），最后写回 lParam。
        /// </summary>
        private void HandleWmSizing(ref Message m)
        {
            int edge = m.WParam.ToInt32();
            try
            {
                var proposed = (Native.RECT)Marshal.PtrToStructure(
                    m.LParam, typeof(Native.RECT));
                if (Native.IsIconic(Handle) || Native.IsZoomed(Handle))
                {
                    // 最小化/最大化态不参与自由缩放（最大化几何由 WM_GETMINMAXINFO 定）。
                    return;
                }
                var work = WorkAreaRect();
                var adjusted = ApplyEdgeAnchor(proposed, edge);
                var final = ClampRectTo169(adjusted, work, "sizing", true);
                Marshal.StructureToPtr(final, m.LParam, false);
                Log("sizing", "edge=" + edge + " anchor=" + AnchorDesc(edge)
                    + " -> " + RectStr(final));
            }
            catch (Exception ex)
            {
                Log("sizing_err", ex.Message);
            }
        }

        /// <summary>
        /// P2-B 兜底钳制：程序化 SetWindowPos、系统贴靠（Win+方向键）、DPI 变化的
        /// 共同必经路径。保证任何时刻矩形同时满足：严格 16:9、在 rcWork 内、
        /// ≥ 逻辑 960×540。
        /// 边界：最小化（IsIconic）跳过；最大化（IsZoomed）只按「工作区内最大 16:9
        /// 矩形」校验并记日志，不改动（改了会与系统最大化态打架）。
        /// </summary>
        private void HandleWindowPosChanging(ref Message m)
        {
            try
            {
                if (Native.IsIconic(Handle))
                {
                    return;
                }
                var wp = (Native.WINDOWPOS)Marshal.PtrToStructure(
                    m.LParam, typeof(Native.WINDOWPOS));
                var work = WorkAreaRect();
                bool noSize = (wp.flags & Native.SWP_NOSIZE) != 0;
                bool noMove = (wp.flags & Native.SWP_NOMOVE) != 0;
                if (Native.IsZoomed(Handle))
                {
                    var maxRect = Max169Rect(work);
                    int mw = maxRect.Right - maxRect.Left;
                    int mh = maxRect.Bottom - maxRect.Top;
                    // F5：过渡态（SWP_NOSIZE）时 WINDOWPOS 的 cx/cy 恒为 0，拿它比较只会
                    // 打出误导性的 "zoomed_mismatch want=1920x1440 got=0x0"。改用窗口的
                    // **真实当前矩形**比较，并降级为调试日志（snap_dbg），不再冒充值异常。
                    Native.RECT cur0;
                    Native.GetWindowRect(Handle, out cur0);
                    int cx = noSize ? cur0.Right - cur0.Left : wp.cx;
                    int cy = noSize ? cur0.Bottom - cur0.Top : wp.cy;
                    if (cx != mw || cy != mh)
                    {
                        Log("snap_dbg", "zoomed_mismatch want=" + mw + "x" + mh
                            + " got=" + cx + "x" + cy);
                    }
                    return;
                }
                if (DateTime.Now < _clampSuspendUntil)
                {
                    // 最小化过渡动画期间暂停钳制（否则窗口会被强行拉回最小档 960×540，
                    // 破坏系统的缩到任务栏动画）。
                    return;
                }
                // SWP_NOSIZE / SWP_NOMOVE 时 WINDOWPOS 的 cx/cy（x/y）无意义（常为 0），
                // 直接拿来算会得到假的矩形；改用当前窗口的真实值参与钳制。
                Native.RECT cur;
                Native.GetWindowRect(Handle, out cur);
                int cx2 = noSize ? cur.Right - cur.Left : wp.cx;
                int cy2 = noSize ? cur.Bottom - cur.Top : wp.cy;
                int x = noMove ? cur.Left : wp.x;
                int y = noMove ? cur.Top : wp.y;
                var r = new Native.RECT();
                r.Left = x;
                r.Top = y;
                r.Right = x + cx2;
                r.Bottom = y + cy2;
                // F1：改尺寸时按**可用空间**收敛（否则窗口偏下/偏右时整窗越出工作区）；
                // 纯移动（SWP_NOSIZE）时尺寸一律不动，只夹位置（拖到边缘贴边）。
                var clamped = ClampRectTo169(r, work, "clamp", !noSize);
                bool dirty = false;
                if (!noMove
                    && (clamped.Left != wp.x || clamped.Top != wp.y))
                {
                    wp.x = clamped.Left;
                    wp.y = clamped.Top;
                    dirty = true;
                }
                if (!noSize
                    && (clamped.Right - clamped.Left != wp.cx
                        || clamped.Bottom - clamped.Top != wp.cy))
                {
                    wp.cx = clamped.Right - clamped.Left;
                    wp.cy = clamped.Bottom - clamped.Top;
                    dirty = true;
                }
                if (dirty)
                {
                    Marshal.StructureToPtr(wp, m.LParam, false);
                }
            }
            catch (Exception ex)
            {
                Log("windowpos_clamp_err", ex.Message);
            }
        }

        // =====================================================================
        // P2-B：自实现拖动（替换 ReleaseCapture + WM_NCLBUTTONDOWN(HTCAPTION)）
        // 旧路径会触发 Aero Snap（贴靠半屏 ⇒ 非 16:9），故改为宿主自绘拖动：
        //   光标位移驱动 SetWindowPos(SWP_NOSIZE) 只移动不改尺寸；
        //   尺寸/位置越界交给 WM_WINDOWPOSCHANGING 的 16:9 兜底钳制。
        //
        // F2/F3 重构（2026-11-14 修复轮）——三个叠加根因一并处理：
        //   ① **移动阈值起拖**：mousedown 只记锚点，**不取鼠标捕获**；轮询采样到光标
        //      位移超过阈值才 SetCapture 并开始移动。阈值内松手 ⇒ 从未取过捕获 ⇒
        //      浏览器能收齐完整的 click/dblclick 序列 ⇒ 前端 desktop.js 的
        //      dblclick → win_toggle_max 路径自然恢复（**前端不改动**）。
        //      （旧实现 mousedown 就 SetCapture → 浏览器收不到 mouseup → DOM 的
        //      click/dblclick 恒为 0。）
        //   ② **双击推迟到松手**：宿主自判双击后不立即 SC_MAXIMIZE——按住左键时
        //      Windows 会忽略该系统命令（实测按住 0/3 成功、未按住 3/3 成功），
        //      故等松手再切，并校验是否真的生效（未生效则重试）。
        //   ③ **松手必收尾**：轮询兜底改为「按键状态跳变」判定（上拍按下、这拍松开
        //      即收尾，连续 2 拍为 up 才确认），EndDrag 里 ReleaseCapture() **无条件**
        //      执行（旧实现的 `if (!_dragActive) return;` 会连带跳过释放 → 捕获泄漏
        //      → 快点击后窗口一直跟着光标走），另加硬超时兜底。
        // =====================================================================

        /// <summary>
        /// 自实现拖动起点（桥 win_start_drag → BeginInvoke 到 UI 线程）。
        /// F2：**不取捕获**——只登记「按下」（锚点 + 双击基准），是否真正开始移动
        /// 由轮询的移动阈值决定。
        /// </summary>
        private void BeginDrag()
        {
            try
            {
                Native.POINTAPI pt;
                if (!Native.GetCursorPos(out pt))
                {
                    return;
                }
                if (Native.IsZoomed(Handle))
                {
                    // 最大化态拖动：先还原（还原锚点 = 逻辑 1280×720 的 16:9 矩形），本次不拖。
                    Log("drag_skip", "zoomed");
                    PostSysCommand(Native.SC_RESTORE);
                    // F2：最大化态下「双击标题栏」的语义 = 还原。还原后紧接着的第二次
                    // 按下会触发前端 dblclick → win_toggle_max（那会把窗口又最大化回去，
                    // 一次双击等于没动）。故还原后开一个抑制窗，吞掉这次双击的前端请求。
                    _toggleSuppressUntil = DateTime.Now.AddMilliseconds(
                        Native.GetDoubleClickTime());
                    return;
                }
                if (_pressTracked)
                {
                    // 同一次按下的重复通知（桥与轮询/边框消息可能都看到这次按下）。
                    // 关键：**不得**在这里重置双击基准——第二次按下会把第一次的基准冲掉，
                    // 宿主自判路径的唯一存活窗口就被自己掐掉了。
                    return;
                }
                OnPressDetected(pt);
            }
            catch (Exception ex)
            {
                Log("drag_begin_err", ex.Message);
            }
        }

        /// <summary>
        /// 登记一次「按下」（来源：DOM 桥 win_start_drag / 宿主自己的 WM_LBUTTONDOWN /
        /// 轮询的按键跳变，三者走同一条路径）。
        /// 职责：双击判定（第二次按下**不重置基准**）+ 记录锚点 + 进入待命（**不取捕获**）。
        /// </summary>
        private void OnPressDetected(Native.POINTAPI pt)
        {
            int dbl = (int)Native.GetDoubleClickTime();
            int dx = pt.x - _dragPressPoint.x;
            int dy = pt.y - _dragPressPoint.y;
            bool isDouble = _dblBaselineValid
                && (DateTime.Now - _dragPressTime).TotalMilliseconds <= dbl
                && Math.Abs(dx) <= DblClickMaxDistance
                && Math.Abs(dy) <= DblClickMaxDistance;
            Native.RECT r;
            Native.GetWindowRect(Handle, out r);
            if (isDouble)
            {
                // 第二次按下 = 双击：**保留基准**，并把切换推迟到松手之后（F2 ②）。
                Log("dblclick_detected",
                    "ms=" + (int)(DateTime.Now - _dragPressTime).TotalMilliseconds
                    + " d=" + dx + "," + dy);
                _dblPending = true;
                _dblWatchUntil = DateTime.MinValue;
            }
            else
            {
                // 新的按下基准（后续再双击仍以此为基准）。
                _dragPressTime = DateTime.Now;
                _dragPressPoint = pt;
                _dblBaselineValid = true;
                _dblPending = false;
                _dblWatchUntil = DateTime.Now.AddMilliseconds(dbl);
            }
            // 锚点：光标 + 窗口矩形（移动时按位移平移，尺寸不变）。
            _dragStartRect = r;
            _dragStartCursor = pt;
            _dragArmed = true;
            _pressTracked = true;
            _dragKeyDown = true;
            _upSamples = 0;
            EnsureDragTimer();
            _dragTimer.Start();
            Log("drag_armed", "cursor=" + pt.x + "," + pt.y + " rect=" + RectStr(r));
        }

        private void EnsureDragTimer()
        {
            if (_dragTimer != null)
            {
                return;
            }
            _dragTimer = new System.Windows.Forms.Timer();
            // F2/F3：心跳周期 25ms → 10ms。25ms 的采样窗口对「快速双击」太宽
            // （两次按下可能被采样成一个连续按下沿，双击就丢了）；10ms 足以分开。
            _dragTimer.Interval = 10;
            _dragTimer.Tick += delegate { DragTick(); };
        }

        /// <summary>
        /// 拖动心跳（10ms）：① 按键状态跳变检测（按下沿 / 松手沿）
        /// ② 移动阈值判定（超过才取捕获并开始移动）③ 拖动中跟随光标 ④ 硬超时兜底。
        /// </summary>
        private void DragTick()
        {
            try
            {
                bool down = (Native.GetAsyncKeyState(Native.VK_LBUTTON) & 0x8000) != 0;
                Native.POINTAPI pt;
                Native.GetCursorPos(out pt);

                // ---- 按键状态跳变检测 ----
                if (down)
                {
                    _upSamples = 0;
                    if (!_dragKeyDown)
                    {
                        _dragKeyDown = true;
                        if (!_pressTracked)
                        {
                            // 桥没报这次按下（例如点在窗口边框上）→ 宿主自己起手。
                            OnPressDetected(pt);
                        }
                    }
                }
                else if (_dragKeyDown)
                {
                    // F3：松手沿 —— 连续 DragReleaseDebounce 拍为「松手」才确认，
                    // 避免合成输入的一帧抖动被误判成抬起（旧实现恰恰在这里
                    // 用 `!down && !_captureHeld` 把「已拿到捕获」这一最危险场景排除掉，
                    // 致 _dragActive 永远为真 → 快点击后窗口一直跟着光标走）。
                    _upSamples++;
                    if (_upSamples >= DragReleaseDebounce)
                    {
                        _dragKeyDown = false;
                        OnReleaseDetected();
                    }
                }

                if (_dragArmed && !_dragActive)
                {
                    // F2：移动阈值 —— 位移超过阈值才算「按住移动」，此前**从不取捕获**。
                    int dx = pt.x - _dragStartCursor.x;
                    int dy = pt.y - _dragStartCursor.y;
                    if (Math.Abs(dx) > DragMoveThreshold || Math.Abs(dy) > DragMoveThreshold)
                    {
                        StartDragging(pt);
                    }
                }
                else if (_dragActive)
                {
                    if (down)
                    {
                        MoveDragTo(pt);
                    }
                    // F3：硬超时 —— 拖动期间长时间无位移即强制收尾（防捕获泄漏 / 残留拖动态）。
                    if ((DateTime.Now - _dragLastMoveTime).TotalMilliseconds > DragIdleTimeoutMs)
                    {
                        Log("drag_timeout", "idle_ms=" + DragIdleTimeoutMs);
                        EndDrag(true);
                    }
                }

                // 定时器生命周期：没有拖动、没有待命、也不在双击监视窗内 → 停。
                if (!_dragActive && !_dragArmed && !_dblPending
                    && DateTime.Now > _dblWatchUntil)
                {
                    _dragTimer.Stop();
                }
            }
            catch (Exception ex)
            {
                Log("drag_tick_err", ex.Message);
            }
        }

        /// <summary>F2：越过移动阈值 → 此时才取鼠标捕获并开始移动窗口。</summary>
        private void StartDragging(Native.POINTAPI pt)
        {
            _dragArmed = false;
            _dragActive = true;
            // 这次按下已经变成「拖动」→ 双击基准作废（后续按下不能再当双击搭档）。
            _dblBaselineValid = false;
            _dblPending = false;
            Native.SetCapture(Handle);
            _captureHeld = Native.GetCapture() == Handle;
            _dragLastMoveTime = DateTime.Now;
            Log("drag_begin", "cursor=" + pt.x + "," + pt.y
                + " rect=" + RectStr(_dragStartRect)
                + " capture=" + _captureHeld);
        }

        /// <summary>光标位移 → 窗口平移（只移动，不改尺寸；越界由兜底钳制兜住）。</summary>
        private void MoveDragTo(Native.POINTAPI pt)
        {
            int dx = pt.x - _dragStartCursor.x;
            int dy = pt.y - _dragStartCursor.y;
            if (dx == 0 && dy == 0)
            {
                return;
            }
            int left = _dragStartRect.Left + dx;
            int top = _dragStartRect.Top + dy;
            Native.SetWindowPos(Handle, IntPtr.Zero, left, top, 0, 0,
                Native.SWP_NOSIZE | Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
            _dragLastMoveTime = DateTime.Now;
        }

        /// <summary>
        /// 确认松手：收尾拖动 / 解除待命 / 触发「推迟到松手后」的双击切换。
        /// </summary>
        private void OnReleaseDetected()
        {
            Native.POINTAPI pt;
            Native.GetCursorPos(out pt);
            _pressTracked = false;
            if (_dragActive)
            {
                EndDrag(true);
            }
            else if (_dragArmed)
            {
                // 阈值内松手 = 普通点击：**从未取过捕获** ⇒ DOM 能收齐 click/dblclick。
                _dragArmed = false;
                Log("drag_click", "no_move cursor=" + pt.x + "," + pt.y);
            }
            int dbl = (int)Native.GetDoubleClickTime();
            _dblWatchUntil = DateTime.Now.AddMilliseconds(dbl);
            if (_dblPending)
            {
                _dblPending = false;
                if (DateTime.Now > _toggleSuppressUntil
                    && (DateTime.Now - _lastToggleTime).TotalMilliseconds > dbl)
                {
                    // F2 ②：双击切换在**松手之后**执行（左键按住时 SC_MAXIMIZE 会被吞）。
                    ToggleMaxByHost();
                }
                else
                {
                    // 前端已经切换过（或刚还原过）→ 不重复切换，避免最大化↔还原抵消。
                    Log("dblclick_skipped", "already_toggled");
                }
            }
        }

        /// <summary>
        /// 结束拖动。F3：ReleaseCapture() **无条件执行**——旧实现的
        /// `if (!_dragActive) return;` 会连带跳过释放，捕获一旦泄漏，窗口就会
        /// 一直跟着光标走（快点击残留拖动态的根因之一）。
        /// </summary>
        private void EndDrag(bool armWatch)
        {
            if (_endingDrag)
            {
                return; // 防重入（ReleaseCapture 会触发 WM_CAPTURECHANGED）
            }
            _endingDrag = true;
            try
            {
                bool wasActive = _dragActive;
                _dragActive = false;
                _dragArmed = false;
                try
                {
                    Native.ReleaseCapture();
                }
                catch (Exception)
                {
                }
                _captureHeld = false;
                if (wasActive)
                {
                    Log("drag_end", "watch=" + armWatch);
                }
                if (armWatch)
                {
                    _dblWatchUntil = DateTime.Now.AddMilliseconds(
                        Native.GetDoubleClickTime());
                }
            }
            finally
            {
                _endingDrag = false;
            }
        }

        /// <summary>
        /// 宿主自己收到 WM_LBUTTONDOWN（点在窗口边框等桥覆盖不到的地方）：
        /// 走与轮询/桥同一条「按下」登记路径（去重由 _pressTracked 保证）。
        /// </summary>
        private bool HandleDragMouseDown(ref Message m)
        {
            Native.POINTAPI pt;
            if (!Native.GetCursorPos(out pt))
            {
                return false;
            }
            try
            {
                int lp = m.LParam.ToInt32();
                var msgPt = new Native.POINTAPI();
                msgPt.x = (short)(lp & 0xFFFF);
                msgPt.y = (short)((lp >> 16) & 0xFFFF);
                if (Native.ClientToScreen(Handle, ref msgPt))
                {
                    pt = msgPt;
                }
            }
            catch (Exception)
            {
                // lParam 解析失败时退回光标位置。
            }
            if (_pressTracked)
            {
                return true; // 同一次按下的重复通知
            }
            OnPressDetected(pt);
            return true;
        }

        /// <summary>
        /// 宿主自己切换最大化（双击标题栏兜底路径）。
        /// F2：调用点已保证「此刻左键已松开」（判定成立到执行之间隔着一次松手），
        /// 所以 SC_MAXIMIZE 不会被系统忽略；仍未生效则由 PostSysCommand 的重试兜底。
        /// 防双重切换：若前端消息已先切换过（_lastToggleTime 在双击时间窗内）则跳过；
        /// 宿主自己切换后开抑制窗口，期间前端发来的 win_toggle_max 一律忽略并记日志
        /// （toggle_suppressed），避免「一次双击 = 最大化↔还原 抵消」。
        /// </summary>
        private void ToggleMaxByHost()
        {
            int dbl = (int)Native.GetDoubleClickTime();
            if ((DateTime.Now - _lastToggleTime).TotalMilliseconds <= dbl)
            {
                Log("dblclick_skipped", "already_toggled");
                return;
            }
            Log("host_toggle", Native.IsZoomed(Handle) ? "restore" : "maximize");
            ApplyToggleMax();
        }

        /// <summary>
        /// 按当前最大化态决定目标态并投递系统命令（宿主兜底路径与前端 win_toggle_max
        /// 共用同一条链：生效校验 + 未生效重试 + 开抑制窗防双重切换）。
        /// </summary>
        private void ApplyToggleMax()
        {
            _lastToggleTime = DateTime.Now;
            _toggleSuppressUntil = DateTime.Now.AddMilliseconds(600);
            bool wantZoomed = !Native.IsZoomed(Handle);
            PostSysCommand(wantZoomed ? Native.SC_MAXIMIZE : Native.SC_RESTORE);
        }

        /// <summary>
        /// 2026-10-26 关闭分流：按设备级偏好 close_action ∈ {ask, exit, tray}（默认 ask）。
        /// - tray：隐藏窗口到托盘（e.Cancel，宿主进程不退出）；
        /// - exit：直接退出；
        /// - ask（含设置文件缺失/不可读）：原生三钮对话框（退出 / 最小化到托盘 / 取消）。
        ///   不做「记住选择」勾选——选择记忆走设置项本身（用户在设置里改 close_action），
        ///   保持对话框恰三钮，减少一步心智负担。
        /// 仅拦截用户发起的关闭（标题栏按钮 / win_close 桥）；系统关机、任务管理器
        /// 等 CloseReason != UserClosing 与 _forceClose（TCP quit / 托盘「退出应用」）
        /// 一律放行真退出，不拦系统关机。
        /// 托盘存活边界（用户点名说明）：窗口隐藏到托盘时宿主进程**不退出** ⇒
        /// Python 侧 proc.wait() 继续等待、uvicorn 与进程内每日提醒任务存活，
        /// 每晚 21:00 的填写提醒仍可触发；应用**完全退出后通知不生效**
        /// （提醒是进程内任务，见 services/reminder.py，无系统计划任务）。
        /// </summary>
        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!_forceClose && e.CloseReason == CloseReason.UserClosing)
            {
                var action = ReadCloseAction();
                if (action == "tray")
                {
                    HideToTray();
                    e.Cancel = true;
                    return;
                }
                if (action != "exit")
                {
                    // 迭代5（3.0.5）：原生确认框的标题/正文/按钮随应用语言（win_lang 桥），
                    // 不再走 MessageBox（它的「是/否/取消」跟随系统语言，无法随应用切换）。
                    var choice = AskCloseApp();
                    if (choice == DialogResult.No)
                    {
                        HideToTray();
                        e.Cancel = true;
                        return;
                    }
                    if (choice == DialogResult.Cancel)
                    {
                        e.Cancel = true;
                        return;
                    }
                    // Yes → 真退出，落入下方公共退出链。
                }
            }
            _running = false;
            try
            {
                if (_listener != null)
                {
                    _listener.Stop();
                }
            }
            catch (Exception)
            {
                // 监听器已停时忽略。
            }
            Log("form_closing", e.CloseReason.ToString());
        }

        /// <summary>
        /// 迭代5（3.0.5）：原生三钮确认框（是=退出 / 否=托盘 / 取消=返回），标题、正文与
        /// 按钮文案随 _uiLang。用最小 WinForms 模态窗体替代 MessageBox——MessageBox 的
        /// 按钮跟随系统语言，无法随应用语言切换。返回值仍是 DialogResult.Yes/No/Cancel，
        /// OnFormClosing 的分流逻辑不变。键盘：Tab 在 是→否→取消 之间移动，Esc/Enter
        /// 都落到「取消」（与旧 MessageBoxDefaultButton.Button3 的默认一致）。
        /// </summary>
        private DialogResult AskCloseApp()
        {
            var s = CloseDialogStrings();
            using (var dlg = new Form())
            {
                dlg.Text = s[0];
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.ShowInTaskbar = false;
                dlg.MinimizeBox = false;
                dlg.MaximizeBox = false;
                dlg.AutoScaleMode = AutoScaleMode.None;
                dlg.Font = SystemFonts.MessageBoxFont;

                // 按实际字体与 DPI 量出正文所需高度（Label 会按 \n 换行），避免西语长句被裁掉。
                float scale = 1f;
                using (var g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    scale = g.DpiX / 96f;
                }
                int padX = (int)Math.Round(18 * scale);
                int padTop = (int)Math.Round(16 * scale);
                int padBottom = (int)Math.Round(8 * scale);
                int rowH = (int)Math.Round(56 * scale);
                int textW = (int)Math.Round(460 * scale);
                int textH = 0;
                foreach (var line in s[1].Split('\n'))
                {
                    var m = TextRenderer.MeasureText(line.Length == 0 ? " " : line, dlg.Font,
                        new Size(textW, int.MaxValue), TextFormatFlags.WordBreak);
                    textH += m.Height;
                }
                dlg.ClientSize = new Size(textW + padX * 2, textH + padTop + padBottom + rowH + (int)Math.Round(6 * scale));

                var body = new Label();
                body.Text = s[1];
                body.Dock = DockStyle.Fill;
                body.Padding = new Padding(padX, padTop, padX, padBottom);
                body.UseMnemonic = false;

                var row = new FlowLayoutPanel();
                row.Dock = DockStyle.Bottom;
                row.Height = rowH;
                row.FlowDirection = FlowDirection.RightToLeft;
                row.Padding = new Padding((int)Math.Round(12 * scale), (int)Math.Round(10 * scale), (int)Math.Round(12 * scale), (int)Math.Round(10 * scale));

                // 右→左加入：视觉顺序 是 | 否 | 取消（与旧 MessageBox 的按钮顺序一致）。
                var btnMin = new Size((int)Math.Round(88 * scale), (int)Math.Round(30 * scale));
                var cancel = new Button { Text = s[4], DialogResult = DialogResult.Cancel, AutoSize = true, MinimumSize = btnMin };
                var no = new Button { Text = s[3], DialogResult = DialogResult.No, AutoSize = true, MinimumSize = btnMin };
                var yes = new Button { Text = s[2], DialogResult = DialogResult.Yes, AutoSize = true, MinimumSize = btnMin };
                row.Controls.Add(cancel);
                row.Controls.Add(no);
                row.Controls.Add(yes);

                dlg.Controls.Add(body);
                dlg.Controls.Add(row);
                dlg.AcceptButton = cancel;
                dlg.CancelButton = cancel;
                dlg.ActiveControl = cancel;
                return dlg.ShowDialog(this);
            }
        }

        /// <summary>关闭确认框三语文案：[标题, 正文, 是, 否, 取消]。</summary>
        private string[] CloseDialogStrings()
        {
            if (_uiLang == "en")
            {
                return new[]
                {
                    "Close PeriodIQ",
                    "Quit PeriodIQ?\n\n"
                    + "Yes = quit the app (the 21:00 daily reminder will no longer appear)\n"
                    + "No = minimize to tray (the app keeps running and reminders still work)\n"
                    + "Cancel = return to the app",
                    "Yes",
                    "No",
                    "Cancel"
                };
            }
            if (_uiLang == "es")
            {
                return new[]
                {
                    "Cerrar PeriodIQ",
                    "¿Salir de PeriodIQ?\n\n"
                    + "Sí = salir de la aplicación (el recordatorio diario de las 21:00 ya no aparecerá)\n"
                    + "No = minimizar a la bandeja (la aplicación sigue en segundo plano y los recordatorios siguen activos)\n"
                    + "Cancelar = volver a la aplicación",
                    "Sí",
                    "No",
                    "Cancelar"
                };
            }
            return new[]
            {
                "关闭 PeriodIQ",
                "要退出 PeriodIQ 吗？\n\n"
                + "选「是」= 退出应用（完全退出后，每晚 21:00 的填写提醒不再出现）\n"
                + "选「否」= 最小化到托盘（应用后台运行，填写提醒仍会触发）\n"
                + "选「取消」= 返回应用",
                "是",
                "否",
                "取消"
            };
        }

        /// <summary>托盘两项文案（显示窗口 / 退出应用），随 _uiLang。</summary>
        private string TrayShowText()
        {
            if (_uiLang == "en") return "Show window";
            if (_uiLang == "es") return "Mostrar ventana";
            return "显示窗口";
        }

        private string TrayQuitText()
        {
            if (_uiLang == "en") return "Quit app";
            if (_uiLang == "es") return "Salir de la aplicación";
            return "退出应用";
        }

        /// <summary>语言切换时刷新已存在的托盘菜单（未创建则等创建时取当前语言）。</summary>
        private void ApplyTrayText()
        {
            if (_trayMenu == null || _trayMenu.Items.Count < 2) return;
            _trayMenu.Items[0].Text = TrayShowText();
            _trayMenu.Items[1].Text = TrayQuitText();
        }

        /// <summary>仅接受 zh-CN / en / es（与前端 SUPPORTED 一致），其它值忽略。</summary>
        private void SetUiLang(string code)
        {
            if (code != "zh-CN" && code != "en" && code != "es") return;
            _uiLang = code;
            ApplyTrayText();
        }

        /// <summary>
        /// 读 desktop_settings.json 的 close_action（--settings 传入路径，不写死）。
        /// 每次关闭时现读——设置里改完立即生效，无需重启。文件缺失/不可读/字段
        /// 非法一律回落 "ask"。极简解析：宿主无 JSON 库（零新依赖），文件由后端
        /// desktop.py 单一写入（json.dumps 受控格式），定位 "close_action" 键后取
        /// 其后第一个引号串即可，无需通用解析器（host_info.json 同款手写字串思路）。
        /// </summary>
        private string ReadCloseAction()
        {
            if (_settingsPath.Length == 0)
            {
                return "ask";
            }
            try
            {
                if (!File.Exists(_settingsPath))
                {
                    return "ask";
                }
                var text = File.ReadAllText(_settingsPath);
                var key = text.IndexOf("\"close_action\"", StringComparison.Ordinal);
                if (key < 0)
                {
                    return "ask";
                }
                var colon = text.IndexOf(':', key);
                if (colon < 0)
                {
                    return "ask";
                }
                var q1 = text.IndexOf('"', colon);
                var q2 = q1 >= 0 ? text.IndexOf('"', q1 + 1) : -1;
                if (q1 < 0 || q2 < 0)
                {
                    return "ask";
                }
                var value = text.Substring(q1 + 1, q2 - q1 - 1);
                if (value == "exit" || value == "tray")
                {
                    return value;
                }
                return "ask";
            }
            catch (Exception ex)
            {
                Log("settings_read_err", ex.Message);
                return "ask";
            }
        }

        /// <summary>
        /// 托盘（WinForms 自带 NotifyIcon，零新依赖）：图标复用窗体 Icon（托管资源
        /// app.ico 多帧）；菜单**恰两项**「显示窗口」「退出应用」；双击托盘 = 显示窗口。
        /// 「退出应用」= 真正退出：_forceClose + Close() → 既有退出链
        /// （宿主进程结束 → Python 停 uvicorn → Job 收束）。
        /// </summary>
        private void EnsureTray()
        {
            if (_trayIcon != null)
            {
                return;
            }
            _trayMenu = new ContextMenuStrip();
            // 迭代5（3.0.5）：托盘两项取当前应用语言；语言切换后 ApplyTrayText 就地更新。
            _trayMenu.Items.Add(TrayShowText(), null, delegate { ShowFromTray(); });
            _trayMenu.Items.Add(TrayQuitText(), null, delegate { ExitForReal(); });
            _trayIcon = new NotifyIcon();
            _trayIcon.Icon = Icon;
            _trayIcon.Text = "PeriodIQ";
            _trayIcon.ContextMenuStrip = _trayMenu;
            _trayIcon.DoubleClick += delegate { ShowFromTray(); };
        }

        private void HideToTray()
        {
            // 隐藏≠退出：宿主进程存活 ⇒ Python/uvicorn/每日提醒任务存活（见 OnFormClosing 注释）。
            EnsureTray();
            _trayIcon.Visible = true;
            Hide();
            Log("hide_to_tray", "");
        }

        private void ShowFromTray()
        {
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
            }
            Show();
            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }
            Activate();
            Log("show_from_tray", "");
        }

        private void ExitForReal()
        {
            _forceClose = true;
            Close();
        }

        /// <summary>
        /// 退出前显式撤下托盘图标（不撤会残留ghost图标直到鼠标划过）并释放菜单。
        /// </summary>
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                    _trayIcon.Dispose();
                    _trayIcon = null;
                }
                if (_trayMenu != null)
                {
                    _trayMenu.Dispose();
                    _trayMenu = null;
                }
            }
            base.Dispose(disposing);
        }

        private void Log(string kind, string detail)
        {
            var line = string.Concat(
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"),
                " [HOST] ", kind, ": ", detail,
                " hwnd=", Handle.ToInt64(),
                " zoomed=", Native.IsZoomed(Handle) ? "1" : "0",
                " iconic=", Native.IsIconic(Handle) ? "1" : "0");
            lock (_logLock)
            {
                try
                {
                    File.AppendAllText(_logPath, line + Environment.NewLine);
                }
                catch (Exception)
                {
                    // 日志失败不得拖垮宿主。
                }
            }
        }

        private void WriteInfo(bool ready)
        {
            var port = 0;
            if (_listener != null)
            {
                try
                {
                    port = ((IPEndPoint)_listener.LocalEndpoint).Port;
                }
                catch (Exception)
                {
                    port = 0;
                }
            }
            var info = string.Concat(
                "{\"hwnd\":", Handle.ToInt64(),
                ",\"pid\":", Process.GetCurrentProcess().Id,
                ",\"title\":\"", Text.Replace("\"", "'"),
                "\",\"url\":\"", _targetUrl.Replace("\"", "'"),
                "\",\"control_port\":", port,
                ",\"ready\":", ready ? "true" : "false",
                ",\"profile\":\"", _profileDir.Replace("\\", "\\\\").Replace("\"", "'"),
                "\"}");
            try
            {
                File.WriteAllText(_infoPath, info, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                Log("info_write_err", ex.Message);
            }
        }

        private async void OnFormLoad(object sender, EventArgs e)
        {
            try
            {
                Directory.CreateDirectory(_profileDir);
                var env = await CoreWebView2Environment.CreateAsync(null, _profileDir);
                await _webView.EnsureCoreWebView2Async(env);

                // 壳内浏览器 UI 一律关；其中自动填充与密码保存不关的话，登录用户名框
                // 会弹系统「保存的信息」浮层（展示历史用户名，隐私泄露 + 非本产品 UI）。
                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _webView.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
                _webView.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;

                _webView.CoreWebView2.WebMessageReceived += OnWebMessage;
                _webView.CoreWebView2.NavigationCompleted += OnNavCompleted;
                _webView.CoreWebView2.DownloadStarting += OnDownloadStarting;

                Log("webview_ready", "url=" + _targetUrl);
                _webView.CoreWebView2.Navigate(_targetUrl);
                StartControlServer();
                WriteInfo(false);
            }
            catch (Exception ex)
            {
                Log("webview_init_error", ex.ToString());
                StartControlServer();
                WriteInfo(false);
                // R35-fix1：运行时缺失时不再静默白屏（早期记录；M3「模拟 FAIL」）——
                // 给一句用户能读懂的中文提示再退出，避免留下无自救线索的空白窗口。
                MessageBox.Show(
                    "未检测到 Microsoft Edge WebView2 运行时。\n"
                    + "请从微软官网安装 Evergreen WebView2 Runtime（安装完成后重新打开本程序）：\n"
                    + "https://developer.microsoft.com/microsoft-edge/webview2/",
                    "PeriodIQ",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Environment.Exit(3); // 3 = WebView2 运行时缺失（固定退出码，供启动器与排障判别）
            }
        }

        private void OnNavCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                _ready = true;
                Log("nav_ok", _targetUrl);
                // 宿主显式注入 piq-shell（唯一判据 = 宿主声明，不由前端探测）。
                // ExecuteScriptAsync 仅 UI 线程；本回调在 UI 线程。
                try
                {
                    if (_webView.CoreWebView2 != null)
                    {
                        _webView.CoreWebView2.ExecuteScriptAsync(
                            "document.documentElement.classList.add('piq-shell');"
                            + "document.body.classList.add('piq-shell');");
                    }
                }
                catch (Exception ex)
                {
                    Log("piq_shell_inject_err", ex.Message);
                }
                WriteInfo(true);
                // 页面无需就绪消息（desktop.js 无 message 监听器）；Python 就绪判定走
                // host_info.json 轮询（window.py wait_host_ready）。
            }
            else
            {
                Log("nav_fail", "status=" + e.WebErrorStatus.ToString());
                WriteInfo(false);
            }
        }

        /// <summary>
        /// R31-C 静默下载 + R32 用户选路径：e.Handled=true 表示宿主接管下载 UI
        /// （系统右上角气泡不再出现）；落点改由用户在原生「另存为」里决定——
        /// GetDeferral 撑住 DownloadStarting 事件再弹模态对话框。
        /// 用户取消 ⇒ e.Cancel=true（下载不发生，故不订阅终态）+ 前端 toast「已取消导出」；
        /// e.Cancel 只允许出现在取消分支（正常分支设它 = 文件永远存不下来）。
        /// 对话框自身异常不吞：记日志后退回 R31-C 行为（按默认路径静默落盘），
        /// 导出不因落点选择失败而丢。
        /// 终态经早期壳桥的 window.__piqShell.onDownloadDone 通知前端弹 toast；
        /// 日志只记文件名，不写完整路径（不落任何用户数据指纹）。
        /// </summary>
        private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            e.Handled = true;
            var op = e.DownloadOperation;
            if (op == null)
            {
                Log("download_suppressed", "name=unknown");
                return;
            }
            var deferral = e.GetDeferral();
            try
            {
                var suggested = Path.GetFileName(e.ResultFilePath ?? "");
                if (suggested.Length == 0)
                {
                    suggested = "export.csv";
                }
                using (var dlg = new SaveFileDialog())
                {
                    dlg.Filter = "CSV 文件 (*.csv)|*.csv|所有文件 (*.*)|*.*";
                    dlg.FileName = suggested;
                    dlg.OverwritePrompt = true;
                    var initial = DefaultExportDirectory();
                    if (initial.Length > 0)
                    {
                        dlg.InitialDirectory = initial;
                    }
                    if (dlg.ShowDialog(this) == DialogResult.OK)
                    {
                        e.ResultFilePath = dlg.FileName;
                        Log("download_save_chosen", "name=" + Path.GetFileName(dlg.FileName));
                    }
                    else
                    {
                        Log("download_save_cancelled", "name=" + suggested);
                        e.Cancel = true;
                        NotifyFrontendExportDone("cancel", "");
                        return;
                    }
                }
            }
            catch (Exception ex)
            {
                Log("download_save_err", ex.Message);
            }
            finally
            {
                deferral.Complete();
            }
            var name = Path.GetFileName(op.ResultFilePath ?? "");
            Log("download_suppressed", "name=" + (name.Length > 0 ? name : "unknown"));
            op.StateChanged += (s2, e2) =>
            {
                // 状态迁移到终态才通知；InProgress 是下载常态。
                if (op.State == CoreWebView2DownloadState.InProgress)
                {
                    return;
                }
                var ok = op.State == CoreWebView2DownloadState.Completed;
                Log(ok ? "download_done" : "download_interrupted", "state=" + op.State);
                NotifyFrontendDownloadDone(ok ? "ok" : "err");
            };
        }

        /// <summary>
        /// 下载终态 → 前端 toast。回调在 UI 线程（早期记录）：ExecuteScriptAsync
        /// 是异步发射，可调用；禁止任何阻塞等待/同步封送。脚本自容错：
        /// web/旧版前端无该入口时整式短路为 false，不抛异常打断宿主。
        /// </summary>
        private void NotifyFrontendDownloadDone(string status)
        {
            try
            {
                if (_webView != null && _webView.CoreWebView2 != null)
                {
                    _webView.CoreWebView2.ExecuteScriptAsync(
                        "window.__piqShell && window.__piqShell.onDownloadDone && "
                        + "window.__piqShell.onDownloadDone('" + status + "');");
                }
            }
            catch (Exception ex)
            {
                Log("download_notify_err", ex.Message);
            }
        }

        /// <summary>JS 单引号字符串转义：文件名可含反斜杠/单引号，直拼脚本会断串。</summary>
        private static string JsEscape(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return "";
            }
            return s.Replace("\\", "\\\\").Replace("'", "\\'");
        }

        /// <summary>
        /// 导出终态（PDF 直出 ok/err、CSV 取消 cancel）→ 前端 toast。
        /// 脚本自容错：web/旧前端无 onExportDone 入口时整式短路，不抛异常打断宿主
        /// （同 NotifyFrontendDownloadDone）。name 只含文件名（隐私口径同 R31-C）。
        /// </summary>
        private void NotifyFrontendExportDone(string status, string name)
        {
            try
            {
                if (_webView != null && _webView.CoreWebView2 != null)
                {
                    _webView.CoreWebView2.ExecuteScriptAsync(
                        "window.__piqShell && window.__piqShell.onExportDone && "
                        + "window.__piqShell.onExportDone('" + status + "','"
                        + JsEscape(name) + "');");
                }
            }
            catch (Exception ex)
            {
                Log("export_notify_err", ex.Message);
            }
        }

        /// <summary>「另存为」初始目录：我的文档 → 桌面 → 空（让系统自选；不写死用户路径）。</summary>
        private static string DefaultExportDirectory()
        {
            try
            {
                var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                if (!string.IsNullOrEmpty(docs) && Directory.Exists(docs))
                {
                    return docs;
                }
            }
            catch (Exception)
            {
                // GetFolderPath 对非常规配置可能抛错；退到下一候选目录。
            }
            try
            {
                var desk = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                if (!string.IsNullOrEmpty(desk) && Directory.Exists(desk))
                {
                    return desk;
                }
            }
            catch (Exception)
            {
                // 同上；两处都拿不到就让 SaveFileDialog 用系统默认。
            }
            return "";
        }

        /// <summary>
        /// R32 导出 PDF 宿主直出：UI 线程弹原生「另存为」→ PrintToPdfAsync 静默写盘。
        /// 禁止 ShowPrintUI/打印预览（浏览器页眉页脚会把本机 URL 泄进 PDF，且带下载气泡）；
        /// ShouldPrintHeaderAndFooter 显式赋 false（不依赖默认值）。
        /// await 续体经 WinFormsSynchronizationContext 回 UI 线程，全程无阻塞等待
        /// （早期记录：禁止 .Wait()/.Result）。日志只记文件名（隐私口径同 R31-C）。
        /// </summary>
        private async void HandleExportPdf()
        {
            string path;
            try
            {
                using (var dlg = new SaveFileDialog())
                {
                    dlg.Filter = "PDF 文件 (*.pdf)|*.pdf";
                    dlg.FileName = "PeriodIQ-周期-" + DateTime.Now.ToString("yyyyMMdd") + ".pdf";
                    dlg.OverwritePrompt = true;
                    var initial = DefaultExportDirectory();
                    if (initial.Length > 0)
                    {
                        dlg.InitialDirectory = initial;
                    }
                    if (dlg.ShowDialog(this) != DialogResult.OK)
                    {
                        Log("pdf_export_cancelled", "");
                        NotifyFrontendExportDone("cancel", "");
                        return;
                    }
                    path = dlg.FileName;
                }
            }
            catch (Exception ex)
            {
                Log("pdf_export_dialog_err", ex.Message);
                NotifyFrontendExportDone("err", "");
                return;
            }
            try
            {
                var settings = _webView.CoreWebView2.Environment.CreatePrintSettings();
                settings.ShouldPrintHeaderAndFooter = false;
                var ok = await _webView.CoreWebView2.PrintToPdfAsync(path, settings);
                if (ok)
                {
                    Log("pdf_export_saved", "name=" + Path.GetFileName(path));
                    NotifyFrontendExportDone("ok", Path.GetFileName(path));
                }
                else
                {
                    Log("pdf_export_failed", "PrintToPdfAsync=false");
                    NotifyFrontendExportDone("err", "");
                }
            }
            catch (Exception ex)
            {
                Log("pdf_export_failed", ex.Message);
                NotifyFrontendExportDone("err", "");
            }
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string cmd;
            try
            {
                cmd = e.WebMessageAsJson;
                if (cmd.StartsWith("\"") && cmd.EndsWith("\"") && cmd.Length >= 2)
                {
                    cmd = cmd.Substring(1, cmd.Length - 2);
                }
            }
            catch (Exception)
            {
                cmd = e.TryGetWebMessageAsString();
            }
            if (cmd == null)
            {
                return;
            }
            cmd = cmd.Trim();
            Log("web_message", cmd);
            // 统一单名协议（R25-W5；R32 起五个名字）：四个窗控由 desktop.js 发出；export_pdf 属早期壳桥；
            // 未知消息只记日志。
            if (cmd == "win_close")
            {
                BeginInvoke(new Action(Close));
            }
            else if (cmd == "win_minimize")
            {
                PostSysCommand(Native.SC_MINIMIZE);
            }
            else if (cmd == "win_toggle_max")
            {
                // P2-B：宿主自己判定「双击标题栏」并切换过最大化后，前端这条同名请求
                // 必须忽略（否则一次双击会被切换两次，最大↔还原互相抵消）。
                if (DateTime.Now <= _toggleSuppressUntil)
                {
                    Log("toggle_suppressed", "within_suppress_window");
                    return;
                }
                // F2：前端双击到达时左键已松开（DOM 的 dblclick 在第二次 mouseup 之后
                // 才触发），走与宿主兜底同一条链：生效校验 + 未生效重试 + 开抑制窗。
                ApplyToggleMax();
            }
            else if (cmd == "win_start_drag")
            {
                // P2-B：自实现拖动（不再用 ReleaseCapture + WM_NCLBUTTONDOWN(HTCAPTION)，
                // 那条路径会触发 Aero Snap → 贴靠半屏 → 非 16:9）。
                BeginInvoke(new Action(BeginDrag));
            }
            else if (cmd.StartsWith("win_lang:", StringComparison.Ordinal))
            {
                // 迭代5（3.0.5）：应用语言 → 宿主原生文案（关闭确认 / 托盘）。只接受三语。
                SetUiLang(cmd.Substring("win_lang:".Length).Trim());
            }
            else if (cmd == "export_pdf")
            {
                // R32 导出 PDF 宿主直出。BeginInvoke 让 WebMessageReceived 先返回；
                // 对话框模态循环与 StartNativeDrag 同为先例（不吞消息）。
                BeginInvoke(new Action(HandleExportPdf));
            }
        }

        /// <summary>
        /// 系统路径投递：WM_SYSCOMMAND SC_*。禁止 SetWindowPos 事后补几何。
        /// F2：**校验是否真的生效**（SendMessageTimeoutW 的返回值 + IsZoomed/IsIconic）。
        /// 没生效多半是「左键还按着」——此时 Windows 会直接忽略 SC_MAXIMIZE/SC_RESTORE
        /// （实测按住 0/3 成功、未按住 3/3 成功），故排一次有限重试。
        /// </summary>
        private void PostSysCommand(int sc)
        {
            var hwnd = Handle;
            if (sc == Native.SC_MAXIMIZE || sc == Native.SC_RESTORE)
            {
                PinNormalRect();
            }
            if (sc == Native.SC_MINIMIZE)
            {
                // P2-B：最小化过渡期间暂停兜底钳制（系统把窗口缩成任务栏缩略图，
                // 钳制会把它强行拉回最小档 960×540，破坏系统动画）。
                _clampSuspendUntil = DateTime.Now.AddMilliseconds(700);
            }
            Log("sc_post", string.Format("0x{0:X}", sc));
            bool sent = SendSc(sc);
            Log("sc_post_done",
                string.Format("0x{0:X} sent={1} zoomed={2} iconic={3}",
                    sc, sent ? "1" : "0", Native.IsZoomed(hwnd), Native.IsIconic(hwnd)));
            if (!sent || !ScStateOk(sc))
            {
                // F2：没生效 → 记 sc_failed 并排重试（松手后系统命令才会被接受）。
                Log("sc_failed", string.Format("0x{0:X} sent={1} zoomed={2} iconic={3}",
                    sc, sent ? "1" : "0", Native.IsZoomed(hwnd), Native.IsIconic(hwnd)));
                ScheduleScRetry(sc);
            }
        }

        /// <summary>投递一次 SC_*（不重试）。返回 SendMessageTimeoutW 是否成功。</summary>
        private bool SendSc(int sc)
        {
            IntPtr result;
            var ok = Native.SendMessageTimeoutW(
                Handle, Native.WM_SYSCOMMAND, new IntPtr(sc), IntPtr.Zero,
                Native.SMTO_ABORTIFHUNG, 200, out result);
            return ok != IntPtr.Zero;
        }

        /// <summary>SC_* 的目标状态是否已经达到。</summary>
        private bool ScStateOk(int sc)
        {
            if (sc == Native.SC_MAXIMIZE)
            {
                return Native.IsZoomed(Handle);
            }
            if (sc == Native.SC_RESTORE)
            {
                return !Native.IsZoomed(Handle) && !Native.IsIconic(Handle);
            }
            if (sc == Native.SC_MINIMIZE)
            {
                return Native.IsIconic(Handle);
            }
            return true;
        }

        /// <summary>
        /// SC_* 未生效 → 排一次有限重试（最多 3 次、每次隔 150ms）。
        /// 期间若发生了别的切换动作（_lastToggleTime 变化）就不再重试，
        /// 免得把用户刚做的还原又改成最大化。
        /// </summary>
        private void ScheduleScRetry(int sc)
        {
            _scRetrySc = sc;
            _scRetryCount = 0;
            _scRetryStamp = _lastToggleTime;
            if (_scRetryTimer == null)
            {
                _scRetryTimer = new System.Windows.Forms.Timer();
                _scRetryTimer.Interval = 150;
                _scRetryTimer.Tick += delegate { ScRetryTick(); };
            }
            _scRetryTimer.Stop();
            _scRetryTimer.Start();
        }

        private void ScRetryTick()
        {
            try
            {
                if (ScStateOk(_scRetrySc))
                {
                    _scRetryTimer.Stop();
                    Log("sc_retry_done", string.Format("0x{0:X} attempts={1}",
                        _scRetrySc, _scRetryCount + 1));
                    return;
                }
                if (_scRetrySc == Native.SC_MAXIMIZE || _scRetrySc == Native.SC_RESTORE)
                {
                    if (_lastToggleTime != _scRetryStamp)
                    {
                        // 期间有别的切换动作 → 不再重试（避免把用户的还原又最大化）。
                        _scRetryTimer.Stop();
                        Log("sc_retry_skip", "toggle_moved");
                        return;
                    }
                }
                _scRetryCount++;
                if (_scRetryCount > 3)
                {
                    _scRetryTimer.Stop();
                    Log("sc_retry_giveup", string.Format("0x{0:X}", _scRetrySc));
                    return;
                }
                SendSc(_scRetrySc);
                Log("sc_retry", string.Format("0x{0:X} attempt={1}", _scRetrySc, _scRetryCount));
            }
            catch (Exception ex)
            {
                Log("sc_retry_err", ex.Message);
                if (_scRetryTimer != null)
                {
                    _scRetryTimer.Stop();
                }
            }
        }

        private void StartControlServer()
        {
            if (_listener != null)
            {
                return;
            }
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            WriteInfo(_ready);
            Log("control_listen",
                string.Format("127.0.0.1:{0}", ((IPEndPoint)_listener.LocalEndpoint).Port));

            var t = new Thread(AcceptLoop);
            t.IsBackground = true;
            t.Start();
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client;
                try
                {
                    client = _listener.AcceptTcpClient();
                }
                catch (Exception)
                {
                    break;
                }
                var c = client;
                ThreadPool.QueueUserWorkItem(delegate
                {
                    // F4：工作线程整体兜底——任何未捕获异常都不得终结宿主进程
                    // （未处理异常会让整个 native_host.exe 退出，连带 Python 启动器）。
                    try
                    {
                        HandleClient(c);
                    }
                    catch (Exception ex)
                    {
                        Log("client_thread_err", ex.Message);
                    }
                });
            }
        }

        /// <summary>
        /// F4：控制口连接处理。**任何客户端异常都不得冒泡到线程池工作线程**
        /// ——旧实现 `writer.WriteLine(...)` 的 IOException/SocketException 会逃逸，
        /// 变成未处理异常直接终结宿主进程（实测退出码 0xE0434352）。
        /// 规则：写回失败/对端断开 → 记日志并 break（只断这一条连接）；
        /// 命令本身异常 → 回一句 err 文本，不影响连接与宿主。
        /// </summary>
        private void HandleClient(TcpClient client)
        {
            try
            {
                using (client)
                using (var stream = client.GetStream())
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                {
                    writer.AutoFlush = true;
                    while (_running)
                    {
                        string line;
                        try
                        {
                            line = reader.ReadLine();
                        }
                        catch (Exception ex)
                        {
                            Log("client_read_err", ex.Message);
                            break;
                        }
                        if (line == null)
                        {
                            break;
                        }
                        string resp;
                        try
                        {
                            resp = HandleCommand(line.Trim());
                        }
                        catch (Exception ex)
                        {
                            Log("cmd_err", ex.Message);
                            resp = "err cmd:" + ex.Message;
                        }
                        try
                        {
                            writer.WriteLine(resp);
                        }
                        catch (Exception ex)
                        {
                            // 对端已关闭/半关闭/缓冲区写满 → 断这条连接即可。
                            Log("client_write_err", ex.Message);
                            break;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log("client_err", ex.Message);
            }
        }

        private string HandleCommand(string cmd)
        {
            Log("cmd", cmd);
            if (cmd == "ping")
            {
                return "pong";
            }
            if (cmd == "ready")
            {
                return _ready ? "ready true" : "ready false";
            }
            if (cmd == "sc_maximize")
            {
                PostSysCommand(Native.SC_MAXIMIZE);
                return "ok sc_maximize";
            }
            if (cmd == "sc_restore")
            {
                PostSysCommand(Native.SC_RESTORE);
                return "ok sc_restore";
            }
            if (cmd == "sc_minimize")
            {
                PostSysCommand(Native.SC_MINIMIZE);
                return "ok sc_minimize";
            }
            if (cmd == "rect")
            {
                Native.RECT r;
                Native.GetWindowRect(Handle, out r);
                return string.Format("rect {0},{1},{2},{3} zoomed={4} iconic={5}",
                    r.Left, r.Top, r.Right, r.Bottom,
                    Native.IsZoomed(Handle), Native.IsIconic(Handle));
            }
            // ===== P2-B 新增（既有命令与其输出格式保持不变）=====
            if (cmd.StartsWith("resize "))
            {
                // resize <w> <h>：UI 线程用 SetWindowPos 强制为指定**物理**尺寸，
                // 让 WM_WINDOWPOSCHANGING 的 16:9 兜底钳制生效，返回钳制后的 rect 读数。
                var parts = cmd.Substring(7).Trim().Split(' ');
                int rw, rh;
                if (parts.Length < 2
                    || !int.TryParse(parts[0], out rw) || !int.TryParse(parts[1], out rh))
                {
                    return "err resize args";
                }
                return InvokeOnUiSync(delegate { return ResizeOnUi(rw, rh); });
            }
            if (cmd.StartsWith("sizing_probe "))
            {
                // sizing_probe <w> <h> <edge>：用与 WM_SIZING **同一个**钳制函数，
                // 对合成矩形按指定边计算并返回结果矩形（验证 WM_SIZING 分支逻辑）。
                var parts = cmd.Substring(13).Trim().Split(' ');
                int sw, sh;
                if (parts.Length < 3
                    || !int.TryParse(parts[0], out sw) || !int.TryParse(parts[1], out sh))
                {
                    return "err sizing_probe args";
                }
                var edge = parts[2].Trim().ToLowerInvariant();
                return InvokeOnUiSync(delegate { return SizingProbeOnUi(sw, sh, edge); });
            }
            if (cmd == "visibility")
            {
                // 托盘隐藏场景取证。
                return InvokeOnUiSync(delegate
                {
                    return "visibility " + (Native.IsWindowVisible(Handle) ? "true" : "false");
                });
            }
            if (cmd == "monitor")
            {
                // rcWork / rcMonitor / 窗口 DPI / 系统 DPI（供按 DPI 换算逻辑像素）。
                return InvokeOnUiSync(delegate
                {
                    Native.RECT mon;
                    var work = GetMonitorRects(out mon);
                    uint winDpi = Native.GetDpiForWindow(Handle);
                    uint sysDpi = Native.GetDpiForSystem();
                    return string.Format(
                        "monitor rcWork={0},{1},{2},{3} rcMonitor={4},{5},{6},{7}"
                        + " win_dpi={8} sys_dpi={9} scale={10:F4}",
                        work.Left, work.Top, work.Right, work.Bottom,
                        mon.Left, mon.Top, mon.Right, mon.Bottom,
                        winDpi, sysDpi, winDpi / 96.0);
                });
            }
            if (cmd == "geom")
            {
                // 几何总读数：外框 / 客户区 / 逻辑尺寸 / 居中误差。
                return InvokeOnUiSync(delegate { return GeomOnUi(); });
            }
            if (cmd == "metrics")
            {
                // 只读诊断：SM_CYCAPTION / 边框，供 W4 几何钉死取证。
                return string.Format(
                    "metrics caption={0} cxframe={1} cyframe={2} pad={3}",
                    Native.GetSystemMetrics(Native.SM_CYCAPTION),
                    Native.GetSystemMetrics(Native.SM_CXSIZEFRAME),
                    Native.GetSystemMetrics(Native.SM_CYSIZEFRAME),
                    Native.GetSystemMetrics(Native.SM_CXPADDEDBORDER));
            }
            if (cmd == "placement")
            {
                // 只读诊断：GetWindowPlacement（workspace 坐标 rcNormal）。
                var wp = new Native.WINDOWPLACEMENT();
                wp.length = Marshal.SizeOf(typeof(Native.WINDOWPLACEMENT));
                if (!Native.GetWindowPlacement(Handle, ref wp))
                {
                    return "placement err";
                }
                return string.Format(
                    "placement showCmd={0} flags={1} normal={2},{3},{4},{5} min={6},{7} max={8},{9}",
                    wp.showCmd, wp.flags,
                    wp.rcNormalPosition.Left, wp.rcNormalPosition.Top,
                    wp.rcNormalPosition.Right, wp.rcNormalPosition.Bottom,
                    wp.ptMinPosition.x, wp.ptMinPosition.y,
                    wp.ptMaxPosition.x, wp.ptMaxPosition.y);
            }
            if (cmd == "hang_probe")
            {
                IntPtr result;
                var ok = Native.SendMessageTimeoutW(
                    Handle, Native.WM_NULL, IntPtr.Zero, IntPtr.Zero,
                    Native.SMTO_ABORTIFHUNG, 200, out result);
                var hung = Native.IsHungAppWindow(Handle);
                return string.Format("hang_probe smto={0} hung={1}", ok != IntPtr.Zero, hung);
            }
            if (cmd == "dom_text")
            {
                // 取证用：同步等待 UI 线程 ExecuteScriptAsync 结果（短超时，不阻塞消息泵）。
                return DomTextSync();
            }
            if (cmd.StartsWith("click_btn "))
            {
                var kind = cmd.Substring(10).Trim();
                return ClickTitlebarBtn(kind);
            }
            if (cmd == "dblclick_drag")
            {
                return DblClickDragSync();
            }
            if (cmd == "shell_state")
            {
                return ShellStateSync();
            }
            if (cmd == "dom_rects")
            {
                return DomRectsSync();
            }
            if (cmd.StartsWith("eval_js "))
            {
                // 取证/注入用：仅探针调用，生产桥不用。
                return EvalOnUiSync(cmd.Substring(8), "eval_js");
            }
            if (cmd == "quit")
            {
                // quit 语义 = 真退出：置 _forceClose 绕过 ask/tray 分流
                // （否则 close_action=tray 时 quit 只会藏窗口，探针等不到进程结束）。
                _running = false;
                _forceClose = true;
                BeginInvoke(new Action(Close));
                return "ok quit";
            }
            return "err unknown:" + cmd;
        }

        /// <summary>
        /// P2-B：控制口命令的 UI 线程封送（TCP 工作线程不得直接碰窗口 API）。
        /// 与 EvalOnUiSync 同款：BeginInvoke + 短等待。
        /// </summary>
        private string InvokeOnUiSync(Func<string> fn)
        {
            var ev = new ManualResetEvent(false);
            string result = "err noresult";
            try
            {
                BeginInvoke(new Action(delegate
                {
                    try
                    {
                        result = fn();
                    }
                    catch (Exception ex)
                    {
                        result = "err ui:" + ex.Message;
                    }
                    ev.Set();
                }));
                ev.WaitOne(3000);
            }
            catch (Exception ex)
            {
                return "err begininvoke:" + ex.Message;
            }
            return result;
        }

        /// <summary>
        /// P2-B：resize 探针（UI 线程）。强制为指定**物理**尺寸。
        /// F1：改成两段式——① 先算出「含位置」的目标矩形（尺寸上限受**从当前位置起算的
        /// 可用空间**约束：可用宽 = work.Right - x、可用高 = work.Bottom - y），
        /// ② 再用**带位置**的 SetWindowPos 一次性落位。
        /// 旧实现用 SWP_NOMOVE 只改尺寸：位置修正确算了却被丢弃，而尺寸又按整块
        /// rcWork 放行 → 整窗必然越出工作区下沿（实测越界 144px / 288px）。
        /// </summary>
        private string ResizeOnUi(int w, int h)
        {
            Native.RECT cur;
            Native.GetWindowRect(Handle, out cur);
            var work = WorkAreaRect();
            var target = new Native.RECT();
            target.Left = cur.Left;
            target.Top = cur.Top;
            target.Right = cur.Left + w;
            target.Bottom = cur.Top + h;
            var final = ClampRectTo169(target, work, "resize", true);
            Native.SetWindowPos(Handle, IntPtr.Zero,
                final.Left, final.Top,
                final.Right - final.Left, final.Bottom - final.Top,
                Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
            Native.RECT r;
            Native.GetWindowRect(Handle, out r);
            return "resize " + RectStr(r) + " work=" + RectStr(work)
                + " zoomed=" + (Native.IsZoomed(Handle) ? "1" : "0");
        }

        /// <summary>
        /// P2-B：sizing_probe 探针（UI 线程）。用与 WM_SIZING 完全相同的
        /// ApplyEdgeAnchor + ClampRectTo169 计算结果矩形。
        /// 合成矩形摆在工作区中央，尺寸 = 给定的 w×h。
        /// </summary>
        private string SizingProbeOnUi(int w, int h, string edge)
        {
            int edgeCode = EdgeCode(edge);
            if (edgeCode == 0)
            {
                return "err edge=" + edge;
            }
            var work = WorkAreaRect();
            int left = work.Left + (work.Right - work.Left - w) / 2;
            int top = work.Top + (work.Bottom - work.Top - h) / 2;
            var proposed = new Native.RECT();
            proposed.Left = left;
            proposed.Top = top;
            proposed.Right = left + w;
            proposed.Bottom = top + h;
            var adjusted = ApplyEdgeAnchor(proposed, edgeCode);
            var final = ClampRectTo169(adjusted, work, "probe", true);
            return "sizing_probe " + RectStr(final) + " edge=" + edge
                + " anchor=" + AnchorDesc(edgeCode) + " work=" + RectStr(work);
        }

        /// <summary>
        /// P2-B：几何总读数（UI 线程）：外框（GetWindowRect）/ 客户区（GetClientRect）
        /// / 逻辑尺寸 / 相对 rcWork 的居中误差。
        /// </summary>
        private string GeomOnUi()
        {
            Native.RECT r;
            Native.GetWindowRect(Handle, out r);
            Native.RECT c;
            Native.GetClientRect(Handle, out c);
            Native.RECT mon;
            var work = GetMonitorRects(out mon);
            uint dpi = Native.GetDpiForWindow(Handle);
            double scale = dpi >= 96 ? dpi / 96.0 : 1.0;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            int cw = c.Right - c.Left;
            int ch = c.Bottom - c.Top;
            int wantLeft = work.Left + (work.Right - work.Left - w) / 2;
            int wantTop = work.Top + (work.Bottom - work.Top - h) / 2;
            return string.Format(
                "geom outer={0},{1},{2},{3} w={4} h={5} client={6},{7} cw={8} ch={9}"
                + " dpi={10} scale={11:F4} logical={12:F2}x{13:F2} client_logical={14:F2}x{15:F2}"
                + " center_err={16},{17} work={18},{19},{20},{21}"
                + " zoomed={22} iconic={23} visible={24}",
                r.Left, r.Top, r.Right, r.Bottom, w, h, c.Left, c.Top, cw, ch,
                dpi, scale, w / scale, h / scale, cw / scale, ch / scale,
                r.Left - wantLeft, r.Top - wantTop,
                work.Left, work.Top, work.Right, work.Bottom,
                Native.IsZoomed(Handle) ? "1" : "0",
                Native.IsIconic(Handle) ? "1" : "0",
                Native.IsWindowVisible(Handle) ? "1" : "0");
        }

        /// <summary>
        /// 在 UI 线程执行一段只读/点击脚本。TCP 工作线程调用；用 ManualResetEvent 短等待。
        /// 封送回调体内只 ExecuteScriptAsync，不碰同步 evaluate_js。
        /// </summary>
        private string EvalOnUiSync(string script, string prefix)        {
            var ev = new ManualResetEvent(false);
            string result = "err noresult";
            try
            {
                BeginInvoke(new Action(() =>
                {
                    try
                    {
                        if (_webView.CoreWebView2 == null)
                        {
                            result = "err webview_null";
                            ev.Set();
                            return;
                        }
                        var task = _webView.CoreWebView2.ExecuteScriptAsync(script);
                        task.ContinueWith(t =>
                        {
                            if (t.IsFaulted)
                            {
                                result = "err script:" + t.Exception.ToString();
                            }
                            else
                            {
                                var raw = t.Result;
                                if (raw != null && raw.Length >= 2 && raw[0] == '"')
                                {
                                    raw = raw.Substring(1, raw.Length - 2);
                                }
                                result = prefix + " " + (raw ?? "");
                            }
                            ev.Set();
                        });
                    }
                    catch (Exception ex)
                    {
                        result = "err invoke:" + ex.Message;
                        ev.Set();
                    }
                }));
                ev.WaitOne(3000);
            }
            catch (Exception ex)
            {
                return "err begininvoke:" + ex.Message;
            }
            return result;
        }

        private string DomTextSync()
        {
            return EvalOnUiSync("document.body ? document.body.innerText : ''", "dom_text");
        }

        /// <summary>真按钮路径：DOM click → desktop.js → postMessage → SC_*。</summary>
        private string ClickTitlebarBtn(string kind)
        {
            // 档位映射：探针入参 min|max|close → 前端 DOM 的 data-win 属性值
            // minimize|toggle|close（Win/frontend/js/shell/desktop.js 里三个窗控按钮
            // 的真实属性；早先这里直接拿 kind 当属性查，min/max 恒查不到 → missing）。
            // 同时接受 DOM 原值作入参，两套写法命中同一个按钮。
            var attr = "";
            if (kind == "min") attr = "minimize";
            else if (kind == "max") attr = "toggle";
            else if (kind == "close" || kind == "minimize" || kind == "toggle") attr = kind;
            else return "err click_btn kind=" + kind;
            Log("click_btn", kind + "->" + attr);
            var script = "document.querySelector('.titlebar-btn[data-win=\"" + attr + "\"]')"
                + " ? (document.querySelector('.titlebar-btn[data-win=\"" + attr + "\"]').click(), 'clicked')"
                + " : 'missing'";
            return EvalOnUiSync(script, "click_btn");
        }

        private string DblClickDragSync()
        {
            Log("dblclick_drag", "fire");
            var script = "document.querySelector('.titlebar-drag')"
                + " ? (document.querySelector('.titlebar-drag').dispatchEvent("
                + "new MouseEvent('dblclick',{bubbles:true})), 'fired')"
                + " : 'missing'";
            return EvalOnUiSync(script, "dblclick_drag");
        }

        /// <summary>回读 piq-shell 类与标题栏可见性（门控连通性）。</summary>
        private string ShellStateSync()
        {
            var script = "(function(){"
                + "var h=document.documentElement.classList.contains('piq-shell');"
                + "var b=document.body.classList.contains('piq-shell');"
                + "var bar=document.getElementById('app-titlebar');"
                + "var vis=bar?getComputedStyle(bar).display:'none';"
                + "return 'html='+h+' body='+b+' titlebar='+vis;"
                + "})()";
            return EvalOnUiSync(script, "shell_state");
        }

        /// <summary>回读关键元素视口矩形（截图采样点定位用）。</summary>
        private string DomRectsSync()
        {
            var script = "(function(){"
                + "function r(s){var e=document.querySelector(s);if(!e)return s+'=null';"
                + "var b=e.getBoundingClientRect();"
                + "return s+'='+Math.round(b.left)+','+Math.round(b.top)+','"
                + "+Math.round(b.right)+','+Math.round(b.bottom);}"
                + "return [r('.btn-primary'),r('.auth-field input'),r('.auth-card'),"
                + "r('.auth-screen'),r('body')].join(';');"
                + "})()";
            return EvalOnUiSync(script, "dom_rects");
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Log("hwnd_created", Handle.ToInt64().ToString());
            WriteInfo(false);
            // P2-B：句柄创建后按所在显示器的 rcWork **精确居中**
            // （left = rcWork.Left + (rcWork.Width - w)/2，top 同理）。
            // FormStartPosition.CenterScreen 在 DPI 放大后按 WinForms 自己的口径居中，
            // 与验收口径（误差 ≤2px）不一致，故改为宿主自己算一次。
            // 外框 = 逻辑 1280×720 × dpiScale（严格 16:9；1280*9 == 720*16）。
            try
            {
                var work = WorkAreaRect();
                int w = (int)Math.Round(LogicalDefaultW * _dpiScale);
                int h = (int)Math.Round(LogicalDefaultH * _dpiScale);
                int left = work.Left + (work.Right - work.Left - w) / 2;
                int top = work.Top + (work.Bottom - work.Top - h) / 2;
                Native.SetWindowPos(Handle, IntPtr.Zero, left, top, w, h,
                    Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
                // 锚点 = 初始 16:9 矩形（此后不再覆写：PinNormalRect 依赖它钉回 rcNormal）。
                Native.GetWindowRect(Handle, out _normalRect);
                _normalRectSet = true;
                Log("initial_place", RectStr(_normalRect) + " work=" + RectStr(work)
                    + " scale=" + _dpiScale.ToString("F4"));
            }
            catch (Exception ex)
            {
                Log("initial_place_err", ex.Message);
            }
        }
    }

    internal static class Program
    {
        private static string ArgValue(string[] args, string name, string fallback)
        {
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                {
                    return args[i + 1];
                }
            }
            return fallback;
        }

        /// <summary>
        /// R26-A：进程 DPI 感知运行时兜底。权威是 dpi.manifest（csc /win32manifest 嵌入）；
        /// manifest 已生效时本调用失败（awareness 不可再改）——预期内，只记日志不崩。
        /// </summary>
        private static void TrySetPerMonitorV2(string logPath)
        {
            try
            {
                if (Native.SetProcessDpiAwarenessContext(
                    Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
                {
                    File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
                        + " [dpi_runtime] PMv2 set via SetProcessDpiAwarenessContext\n");
                }
                else
                {
                    // manifest 已声明 PMv2 时这是正常路径
                    File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
                        + " [dpi_runtime] SetProcessDpiAwarenessContext false"
                        + "（manifest 优先或 API 不可用）\n");
                }
            }
            catch (Exception ex)
            {
                try
                {
                    File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
                        + " [dpi_runtime_err] " + ex.Message + "\n");
                }
                catch (Exception)
                {
                }
            }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            var url = ArgValue(args, "--url", "http://127.0.0.1:8000/");
            var profile = ArgValue(args, "--profile",
                Path.Combine(Path.GetTempPath(), "periodiq_webview2_profile"));
            var info = ArgValue(args, "--info",
                Path.Combine(Path.GetTempPath(), "periodiq_host_info.json"));
            var log = ArgValue(args, "--log",
                Path.Combine(Path.GetTempPath(), "periodiq_host.log"));
            // 2026-10-26：设备级偏好文件（close_action 分流用）。空串 = 未提供
            // （ReadCloseAction 回落 ask）；不在 C# 里写死路径，由 Python 启动时传入。
            var settings = ArgValue(args, "--settings", "");

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(info)) ?? ".");
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(log)) ?? ".");
                Directory.CreateDirectory(profile);
            }
            catch (Exception)
            {
            }

            // R26-A：必须在任何 Form 创建之前设 DPI 感知（Win32 约束）
            TrySetPerMonitorV2(log);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new HostForm(url, profile, info, log, settings));
        }
    }
}
