"""Windows Job Object 孤儿进程防护（早期记录 / C4）。

语义：把子进程（uvicorn）放进一个带 ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`` 的作业对象。
只要本启动器进程还持有作业句柄，子进程存活；一旦启动器 **正常退出 / Ctrl+C /
被 TerminateProcess 强杀**，操作系统关闭作业句柄 → 作业内所有进程随之结束，
不留孤儿（解决「只杀启动器 → uvicorn 存活并继续占端口 → 两个实例写同一 SQLite」）。

纯 ``ctypes`` 实现，**不新增第三方依赖**。非 Windows 平台降级为 no-op（返回 False），
降级行为在早期记录说明；本机为 Windows，正向路径即为交付路径。
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

IS_WINDOWS = sys.platform.startswith("win")

# 保存已创建的作业句柄，防止被 GC 关闭（进程存活期间不得释放）
_JOBS: list[object] = []

# --- Windows 结构体与常量（JobObjectExtendedLimitInformation） ------------------
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JobObjectExtendedLimitInformation = 9


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("UiReadBytes", ctypes.c_uint64),
        ("UiWriteBytes", ctypes.c_uint64),
        ("UiOtherBytes", ctypes.c_uint64),
        ("UiReadOperations", ctypes.c_uint64),
        ("UiWriteOperations", ctypes.c_uint64),
        ("UiOtherOperations", ctypes.c_uint64),
    ]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _create_kill_on_close_job() -> object:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = (
        wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = kernel32.SetInformationJobObject(
        handle,
        _JobObjectExtendedLimitInformation,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if not ok:
        kernel32.CloseHandle(handle)
        raise ctypes.WinError(ctypes.get_last_error())
    _JOBS.append(handle)  # 持有引用，进程结束前不释放
    return handle, kernel32


def _proc_handle(proc: object) -> object:
    """取子进程的 Windows 进程句柄。

    真实的 ``subprocess.Popen``（Windows）把进程句柄放在 **私有属性 ``_handle``**，
    并没有公开的 ``.handle``——因此优先读 ``_handle``，再回退到 ``handle``
    （兼容显式伪造/打桩对象）。取不到或为 0/None 视为伪进程，交由调用方降级。
    """
    handle = getattr(proc, "_handle", None)
    if handle in (None, 0):
        handle = getattr(proc, "handle", None)
    return handle


def assign_process(proc: object) -> bool:
    """把给定子进程对象加入作业（读取其 Windows 进程句柄 ``_handle``）。

    Args:
        proc: ``subprocess.Popen`` 实例（其 ``._handle`` 为进程句柄）。

    Returns:
        True 表示已成功纳入 Job Object 保护；False 表示降级/失败（平台不支持、
        对象无真实句柄、或 API 调用异常）——调用方据此不阻断正常启动。
    """
    if not IS_WINDOWS:
        return False
    handle = _proc_handle(proc)
    if handle in (None, 0):
        return False  # 打桩/伪进程：无真实句柄，安全跳过（不抛出，保持契约）
    try:
        job, kernel32 = _create_kill_on_close_job()
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        ok = kernel32.AssignProcessToJobObject(job, wintypes.HANDLE(handle))
        return bool(ok)
    except Exception:  # noqa: BLE001  防护失败绝不阻断启动（加固项，非前置条件）
        return False
