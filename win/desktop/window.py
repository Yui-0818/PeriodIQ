# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""桌面窗口宿主封装（R25-W2）——Win32 顶层窗 + WebView2 客户区（**非 pywebview**）。

架构（早期记录；产品化落地）::

    [Python entry 进程]
      ├─ 单实例互斥体 / Job Object / app.log / 进程内 uvicorn
      └─ [native_host.exe 子进程]          ← FormBorderStyle.Sizable 顶层窗
           └─ [WebView2 子窗口 / msedgewebview2]

启动时序（每一步都有可观测证据）：
1. **单实例**命名互斥体（``CreateMutexW``）。已存在 → 提示后 exit 0。
2. 数据目录按 :mod:`desktop.appdata` 优先级解析；``MENSTRUAL_DB_PATH`` 最优先。
3. 备份库（失败只告警）。
4. 进程内 uvicorn（后台线程）。
5. **就绪门**：轮询 ``/api/v1/health`` 直到 200，超时 → 不建窗、中文报错、exit 4。
6. 解析并启动 ``native_host.exe``（指向 ``http://127.0.0.1:<port>/``）。
7. 等待 ``host_info.json`` 出现 ``ready=true``（导航完成）。
8. 退出：宿主进程结束 → 停 uvicorn → 端口释放 → Job 收束 → 进程退出。

**禁止**：pywebview、``frameless=True``、UI 线程同步 ``evaluate_js``、AnimateWindow。
前端桥已统一（R25-W5）：``win_minimize`` / ``win_toggle_max`` / ``win_close`` /
``win_start_drag`` 经 ``chrome.webview.postMessage`` 进 native_host.cs 桥处理（SC_* 系统路径）；
Python 侧就绪判定只走 ``host_info.json`` 轮询（``wait_host_ready``）。
"""

from __future__ import annotations

import ctypes
import json
import logging
import logging.handlers
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

IS_WINDOWS = sys.platform.startswith("win")

_EDGE_TOKEN = "Edg/"
_IE_TOKENS = ("Trident/", "MSIE ")

_MUTEX_NAME = "Local\\PeriodIQ.SingleInstance.Mutex"
_ERROR_ALREADY_EXISTS = 183

# 壳类注入 / pywebview 桥探针已随 R25-W2 迁出；壳桥已随 R25-W5 统一为
# Win/frontend/js/shell/desktop.js 的 win_* → chrome.webview.postMessage。桌面壳在页面挂 piq-shell：
# 由 native_host 导航完成后注入（见 native_host.cs OnNavCompleted 的 ExecuteScriptAsync）。

_HOST_INFO_NAME = "host_info.json"
_HOST_READY_TIMEOUT_S = 20.0
_HOST_POLL_INTERVAL_S = 0.2

# 2026-10-26 设备级偏好文件名（close_action 关闭分流用）。单一来源是后端
# ``backend/app/config.py::DESKTOP_SETTINGS_FILENAME``；桌面层不反向 import
# 后端包，此处按同名镜像（同轮改动两处须一起动）。
_DESKTOP_SETTINGS_NAME = "desktop_settings.json"

# run_windowed 退出码（与历史语义对齐，便于哨兵复用）
_RC_REJECT_ENV = 3
_RC_NOT_READY = 4
_RC_HOST_MISSING = 5
_RC_HOST_START_FAIL = 6


def _format_host_info(data: dict[str, Any]) -> str:
    """把 host_info.json 拼成可读一行，供日志核账。"""
    parts = []
    for key in ("hwnd", "pid", "control_port", "ready", "url"):
        parts.append(f"{key}={data.get(key)}")
    return " ".join(parts)


class SingleInstance:
    """Windows 命名互斥体；``acquire()`` 返回 True 表示本进程是首个实例。

    非 Windows 或 API 不可用时降级为「总是首个实例」。句柄随对象持有，进程结束由 OS 释放。
    """

    def __init__(self, name: str = _MUTEX_NAME) -> None:
        self.name = name
        self._handle: Any = None
        self.first = False

    def acquire(self) -> bool:
        if not IS_WINDOWS:
            self.first = True
            return True
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateMutexW.restype = ctypes.c_void_p
            kernel32.CreateMutexW.argtypes = (
                ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
            handle = kernel32.CreateMutexW(None, False, self.name)
            if not handle:
                self.first = True
                return True
            self._handle = handle
            already = ctypes.get_last_error() == _ERROR_ALREADY_EXISTS
            self.first = not already
            return self.first
        except Exception:  # noqa: BLE001
            self.first = True
            return True


def gui_should_reject(env_gui: str | None) -> bool:
    """``PYWEBVIEW_GUI`` 显式指向 IE/mshtml → 拒绝（防旧路径/环境残留把渲染器拖回 IE）。"""
    if not env_gui:
        return False
    g = env_gui.strip().lower()
    return g in ("mshtml", "ie", "trident", "winforms-mshtml")


def validate_renderer_ua(user_agent: str | None) -> tuple[bool, str]:
    """判定 UA 是否为 Edge(Chromium)。返回 ``(ok, reason)``。"""
    if not user_agent:
        return False, "UA 为空，无法确认渲染器"
    for tok in _IE_TOKENS:
        if tok in user_agent:
            return False, f"检测到 IE/Trident 渲染器（含 {tok!r}），已禁止静默退回 IE11"
    if _EDGE_TOKEN in user_agent:
        return True, f"确认 Edge(Chromium) 渲染器（含 {_EDGE_TOKEN!r}）"
    return False, f"未知渲染器，UA 未含 {_EDGE_TOKEN!r}：{user_agent[:80]}"


def wait_for_health(url: str, timeout: float = 30.0,
                    interval: float = 0.3) -> tuple[bool, str]:
    """轮询 ``url`` 直到返回 200。超时返回 ``(False, reason)``，绝不抛。"""
    deadline = time.monotonic() + timeout
    attempts = 0
    while time.monotonic() < deadline:
        attempts += 1
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:  # noqa: S310
                if resp.status == 200:
                    return True, f"就绪（第 {attempts} 次轮询，200）"
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(interval)
    return False, f"健康检查超时 {timeout:.0f}s（轮询 {attempts} 次仍非 200）：{url}"


def pick_free_port() -> int:
    """绑 0 取一个真实空闲端口。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


_MB_OK = 0x00000000
_MB_ICONWARNING = 0x00000030
_MB_TOPMOST = 0x00040000


def show_user_message(message: str, title: str = "PeriodIQ") -> None:
    """Windows 原生 ``MessageBoxW`` 用户可见提示；失败静默 no-op。"""
    if not IS_WINDOWS:
        return
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        user32.MessageBoxW(
            None, str(message), str(title),
            _MB_OK | _MB_ICONWARNING | _MB_TOPMOST)
    except Exception:  # noqa: BLE001
        pass


def setup_logging(log_dir: Path, *, to_stdout: bool = False) -> logging.Logger:
    """在 ``log_dir`` 建 ``app.log`` 滚动日志（1 MB × 5 份），返回命名 logger。"""
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("periodiq.desktop")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    fh = logging.handlers.RotatingFileHandler(
        log_dir / "app.log", maxBytes=1_000_000, backupCount=5, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    if to_stdout:
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        logger.addHandler(sh)
    logger.propagate = False
    return logger


def resolve_native_host(explicit: str | os.PathLike[str] | None = None) -> Path | None:
    """定位 ``native_host.exe``。

    顺序：显式参数 → 环境变量 ``PERIODIQ_NATIVE_HOST`` → frozen 时 exe 同目录
    （P4-A：build_desktop.py 把宿主组装在 PeriodIQ.exe 旁，优先于历史回退链）→
    与本模块同目录（``native_host.exe`` 或 ``bin/native_host.exe``）。
    找不到返回 None。源码模式不进入 frozen 分支，顺序与历史完全一致。
    """
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None
    env = os.environ.get("PERIODIQ_NATIVE_HOST")
    if env:
        p = Path(env)
        if p.is_file():
            return p
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        # P4-A frozen 分支：优先产物实际组装位置（exe 同目录）。
        candidates.append(Path(sys.executable).resolve().parent / "native_host.exe")
    here = Path(__file__).resolve().parent
    candidates.extend((
        here / "native_host.exe",
        here / "bin" / "native_host.exe",
    ))
    for cand in candidates:
        if cand.is_file():
            return cand
    return None


def parse_host_info(path: Path) -> dict[str, Any] | None:
    """读 host_info.json；不存在或非法返回 None。"""
    try:
        raw = Path(path).read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def wait_host_ready(info_path: Path, timeout: float = _HOST_READY_TIMEOUT_S,
                    interval: float = _HOST_POLL_INTERVAL_S) -> tuple[bool, str]:
    """轮询 host_info.json 直到 ``ready`` 为 true。超时 ``(False, reason)``。"""
    deadline = time.monotonic() + timeout
    last: dict[str, Any] | None = None
    attempts = 0
    while time.monotonic() < deadline:
        attempts += 1
        last = parse_host_info(info_path)
        if last and last.get("ready") is True:
            return True, f"宿主就绪（第 {attempts} 次） {_format_host_info(last)}"
        time.sleep(interval)
    detail = _format_host_info(last) if last else "host_info 未出现"
    return False, f"宿主就绪超时 {timeout:.0f}s（{detail}）"


def launch_native_host(
    base_url: str,
    *,
    data_dir: Path,
    host_exe: Path | None = None,
    logger: logging.Logger | None = None,
) -> tuple[subprocess.Popen[str] | None, Path, str]:
    """启动 native_host.exe。返回 ``(proc, info_path, reason)``；失败 proc=None。"""
    log = logger or logging.getLogger("periodiq.desktop")
    exe = host_exe or resolve_native_host()
    if exe is None:
        return None, data_dir / _HOST_INFO_NAME, "未找到 native_host.exe（请先编译 desktop/native_host.cs）"

    data_dir = Path(data_dir)
    profile = data_dir / "webview2_profile"
    info_path = data_dir / _HOST_INFO_NAME
    host_log = data_dir / "logs" / "native_host.log"
    host_log.parent.mkdir(parents=True, exist_ok=True)
    profile.mkdir(parents=True, exist_ok=True)
    if info_path.exists():
        try:
            info_path.unlink()
        except OSError:
            pass

    cmd = [
        str(exe),
        "--url", base_url,
        "--profile", str(profile),
        "--info", str(info_path),
        "--log", str(host_log),
        # 2026-10-26：把数据目录里的设备级偏好文件传给宿主（close_action 关闭
        # 分流）。路径经参数传递（路径纪律：C# 侧不写死路径）；与后端
        # GET/PUT /device/settings 读写的是同一个文件（entry.py 窗口模式下
        # data_dir == MENSTRUAL_DB_PATH 的父目录，两端解析一致）。
        "--settings", str(data_dir / _DESKTOP_SETTINGS_NAME),
    ]
    log.info("launch_native_host: %s", " ".join(cmd))
    try:
        proc = subprocess.Popen(  # noqa: S603
            cmd,
            cwd=str(exe.parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        return None, info_path, f"启动 native_host 失败: {e!r}"

    # Job Object：杀 launcher → host 与其 WebView2 子进程一并收束
    try:
        from desktop import process_guard  # noqa: PLC0415
        if process_guard.assign_process(proc):
            log.info("Job Object 已挂住 native_host pid=%s", proc.pid)
        else:
            log.warning("Job Object 挂接失败（降级继续）pid=%s", proc.pid)
    except Exception as e:  # noqa: BLE001
        log.warning("Job Object 异常（降级继续）: %r", e)

    return proc, info_path, "ok"


def run_windowed(base_url: str, data_dir: Path, *,
                 timeout: float = 30.0,
                 host_exe: Path | None = None) -> int:
    """窗口模式编排：就绪门 → 启宿主 → 等 ready → 等宿主退出。

    退出码：0 正常关窗；3 环境拒绝；4 就绪门失败；5 宿主缺失；6 宿主启动失败。
    """
    logger = setup_logging(Path(data_dir) / "logs", to_stdout=False)
    logger.info("run_windowed base_url=%s data_dir=%s", base_url, data_dir)

    if gui_should_reject(os.environ.get("PYWEBVIEW_GUI")):
        msg = "错误：检测到 PYWEBVIEW_GUI 指向 IE/mshtml，禁止以 IE11 渲染器启动（已拒绝）。"
        print(msg)
        logger.error(msg)
        return _RC_REJECT_ENV

    health_url = base_url.rstrip("/") + "/api/v1/health"
    ok, why = wait_for_health(health_url, timeout=timeout)
    logger.info("健康就绪门: ok=%s %s", ok, why)
    if not ok:
        msg = f"服务未就绪，不建窗：{why}"
        print(msg)
        logger.error(msg)
        show_user_message(msg, "PeriodIQ 未就绪")
        return _RC_NOT_READY

    proc, info_path, reason = launch_native_host(
        base_url, data_dir=data_dir, host_exe=host_exe, logger=logger)
    if proc is None:
        msg = f"无法启动窗口宿主：{reason}"
        print(msg)
        logger.error(msg)
        show_user_message(msg, "PeriodIQ 启动失败")
        return _RC_HOST_MISSING if "未找到" in reason else _RC_HOST_START_FAIL

    ready, ready_why = wait_host_ready(info_path, timeout=min(timeout, _HOST_READY_TIMEOUT_S))
    logger.info("宿主就绪门: ok=%s %s", ready, ready_why)
    if not ready:
        # 宿主可能已崩；仍等其退出，避免留下半死进程
        try:
            proc.wait(timeout=3)
        except Exception:  # noqa: BLE001
            pass
        if proc.poll() is None:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
        msg = f"窗口宿主未就绪：{ready_why}"
        print(msg)
        logger.error(msg)
        show_user_message(msg, "PeriodIQ 启动失败")
        return _RC_HOST_START_FAIL

    logger.info("宿主已就绪，等待关窗：%s", _format_host_info(parse_host_info(info_path) or {}))
    # 2026-10-26 托盘边界：close_action=tray（或 ask 对话框选「最小化到托盘」）时
    # native_host 只隐藏窗口、进程不退出 ⇒ 下面的 proc.wait() 继续等待，本进程与
    # 线程内 uvicorn、进程内每日提醒任务（21:00 填写提醒）全部存活，提醒仍可触发；
    # 应用完全退出（exit / 托盘「退出应用」/ TCP quit）后宿主进程结束，提醒不再生效
    # （reminder 仅应用运行时有效，不注册系统计划任务）。
    try:
        rc = proc.wait()
    except KeyboardInterrupt:
        try:
            proc.terminate()
            rc = proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            rc = 0
    logger.info("宿主退出 code=%s", rc)
    # 关窗语义视为成功；宿主非 0 退出码已写入日志供核账
    return 0
