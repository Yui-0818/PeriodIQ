# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""桌面入口骨架（早期记录 / C4 前置）——**本轮不引入 pywebview**。

与 ``start.py``（开发/测试路径，仍走子进程）解耦：本入口以 **进程内** 方式起服务
（``uvicorn.Server`` + asyncio），**不再** 用 ``sys.executable -m uvicorn`` 子进程，
从根本上消除冻结产物里「子进程把自己再当 exe 跑一遍」的坏路径。窗口将在后续轮次
（S4）跑在主线程、本服务跑在后台线程。

支持的参数（本轮全部可用、可测）：

==================  =======================================================
``--headless``      只起服务，不开窗口（S9 产物验收靠它）
``--no-window``     等价 ``--headless``；两者同时给出不报错
``--port N``        显式端口；被占用则 **报错退出，绝不顺延**
``--print-data-dir``打印解析出的数据目录与库绝对路径后退出 0（不起服务）
``--no-browser``    保留（纯 API；本无窗口，等价 no-op）
==================  =======================================================

数据目录优先级见 :mod:`desktop.appdata`：``MENSTRUAL_DB_PATH`` > 显式参数 >
``%LOCALAPPDATA%\\PeriodIQ\\app.db``。
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import socket
import sys
import threading
import time
from pathlib import Path

# 允许以 `python -m desktop.entry` 或 `python desktop/entry.py` 两种方式运行
_HERE = Path(__file__).resolve().parent
_APP_ROOT = _HERE.parent
_BACKEND = _APP_ROOT / "backend"
for _p in (str(_APP_ROOT), str(_BACKEND)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from desktop import appdata  # noqa: E402


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PeriodIQ 桌面入口（无窗口骨架）")
    p.add_argument("--headless", action="store_true", help="只起服务，不开窗口")
    p.add_argument("--no-window", dest="headless", action="store_true",
                   help="等价 --headless（兼容别名）")
    p.add_argument("--no-browser", action="store_true",
                   help="不打开浏览器（本无窗口，占位保留）")
    p.add_argument("--port", type=int, default=None, metavar="N",
                   help="显式端口（1-65535）；被占用则报错退出，绝不顺延")
    p.add_argument("--print-data-dir", action="store_true",
                   help="打印数据目录与库绝对路径后退出 0（不起服务）")
    p.add_argument("--windowed", action="store_true",
                   help="启用新宿主窗口（R25-W2）：单实例 + 就绪门 + native_host WebView2")
    p.add_argument("--ready-timeout", type=float, default=30.0, metavar="SEC",
                   help="窗口模式下健康就绪门超时秒（默认 30）")
    return p


def _resolve_and_print_data_dir() -> int:
    try:
        db = appdata.resolve_db_path()
    except appdata.AppDataDirError as e:
        print(f"错误：{e}")
        return 2
    print(f"DATA_DIR={db.parent}")
    print(f"DB_PATH={db}")
    return 0


def _prepare_db_env() -> None:
    """未显式设置 MENSTRUAL_DB_PATH 时，把数据目录里的库路径写入环境变量，
    使 ``config.DB_PATH`` 在首次 import 时读到它（不改动 config 的默认口径）。"""
    import os
    if os.environ.get("MENSTRUAL_DB_PATH"):
        return  # 环境变量最优先，交给调用方（测试红线依赖）
    try:
        db = appdata.ensure_data_dir()
    except appdata.AppDataDirError as e:
        print(f"错误：{e}")
        raise SystemExit(2)
    legacy = appdata.find_legacy_db()
    if legacy is not None:
        appdata.migrate_from_legacy(db, legacy)  # 首启复制；目标已存在/无旧库则静默跳过
    os.environ["MENSTRUAL_DB_PATH"] = str(db)


def _ensure_std_streams() -> None:
    """noconsole（--windowed）冻结产物可能没有有效的 stdout/stderr 句柄。

    若为 ``None`` 则替换为写入 ``os.devnull`` 的流，保证 ``print()`` 与
    logging 的 StreamHandler 不会因空句柄报错（桌面产物鲁棒性，S5）。
    """
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            try:
                setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
            except Exception:  # noqa: BLE001
                class _Null:
                    def write(self, *_a, **_k):
                        return 0

                    def flush(self):
                        pass
                setattr(sys, name, _Null())


def _setup_root_file_logging(log_dir: Path) -> Path:
    """给 root logger 挂 RotatingFileHandler（1MB×5），使 uvicorn/app 日志落盘。

    返回日志文件路径。S5 批次产物 noconsole 无控制台，早期记录的判据 6 需回读启动日志。
    失败静默降级（不阻断启动）。
    """
    import logging.handlers

    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    logfile = log_dir / "app.log"
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for h in list(root.handlers):
        if isinstance(h, logging.handlers.RotatingFileHandler) \
                and Path(getattr(h, "baseFilename", "")) == logfile.resolve():
            return logfile  # 幂等：已挂同文件则不重复
    try:
        fh = logging.handlers.RotatingFileHandler(
            logfile, maxBytes=1_000_000, backupCount=5, encoding="utf-8")
        fh.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
        root.addHandler(fh)
    except Exception:  # noqa: BLE001
        pass
    return logfile


def _run_server(port: int) -> int:
    import asyncio

    import uvicorn

    from app import config
    from app.main import app

    try:
        log_file = _setup_root_file_logging(appdata.resolve_db_path().parent / "logs")
    except Exception:  # noqa: BLE001
        log_file = None

    uv_cfg = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="info",
        access_log=False, lifespan="on", log_config=None,
    )
    server = uvicorn.Server(uv_cfg)
    print(f"LISTENING http://127.0.0.1:{port} version={config.APP_VERSION}", flush=True)
    if log_file is not None:
        logging.getLogger().info(
            "LISTENING http://127.0.0.1:%s version=%s db=%s",
            port, config.APP_VERSION, os.environ.get("MENSTRUAL_DB_PATH"))
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    return 0


def _serve_in_thread(port: int):
    """后台线程内起进程内 uvicorn（早期记录步骤 4，禁子进程）。返回 (server, thread)。"""
    import asyncio

    import uvicorn

    from app.main import app

    uv_cfg = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning",
        access_log=False, lifespan="on",
    )
    server = uvicorn.Server(uv_cfg)

    def _runner() -> None:
        asyncio.run(server.serve())

    t = threading.Thread(target=_runner, name="periodiq-uvicorn", daemon=True)
    t.start()
    return server, t


# 安装版用户裁定 2026-09-29：backups/ 滚动保留 **15** 份。
# 与开发启动器 start.py 的 BACKUP_KEEP=5 **故意不同**——安装版用户明确要求 15
# （可接受「最多回滚到最近 15 次启动」；活库 app.db 历史不受清理影响）。
DESKTOP_BACKUP_KEEP: int = 15

# 备份文件名内嵌时间戳（%Y%m%d-%H%M%S）：标准名 app-<stamp>.db 与
# app-<stamp>-N.db 均含之；取第一个匹配（同秒后缀 -1/-2 排在其后）。
_BACKUP_STAMP_RE = re.compile(r"\d{8}-\d{6}")


def _backup_sort_key(path: Path) -> tuple[float, float, str]:
    """备份文件的真实时间序键（与 start.py::_backup_sort_key 同族，本地副本以免依赖 start.py）。

    三级取值：
    1. 文件名内嵌时间戳（strptime 校验合法后按本地时区 mktime 成 epoch 秒）——
       不受复制/恢复改写 mtime 影响；
    2. 文件名无（合法）时间戳 → 回退 mtime；
    3. 同秒对与 mtime 全等者以 mtime、再以文件名定稳，保证次序确定可复现。
    """
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0  # stat 不可得又无文件名时间戳：排最旧（最先滚动淘汰）
    m = _BACKUP_STAMP_RE.search(path.name)
    if m:
        try:
            stamp = time.mktime(time.strptime(m.group(), "%Y%m%d-%H%M%S"))
            return (stamp, mtime, path.name)
        except ValueError:
            pass  # 形似而非法（如 99999999-999999）→ 按 mtime 处理
    return (mtime, mtime, path.name)


def _prune_local_backups(backup_dir: Path, keep: int = DESKTOP_BACKUP_KEEP) -> None:
    """滚动保留最近 keep 份备份（真实时间序，键见 _backup_sort_key）。

    候选集恒为 glob("app-*.db")：活库本体 ``app.db``、``*.bak`` 档案、
    子目录、文本文件从不进入滚动集合。删除多出的最旧备份；
    单个文件删除失败不影响启动。
    """
    backups = sorted(backup_dir.glob("app-*.db"), key=_backup_sort_key)
    excess = len(backups) - keep
    for old in backups[:excess] if excess > 0 else []:
        try:
            old.unlink()
        except OSError:
            pass  # 单个旧备份删除失败不影响启动


def _backup_db_local(db_path: Path) -> None:
    """首启/每次启动前的滚动备份（复用 start.py 的 VACUUM INTO 口径，失败只告警）。

    本地实现以免窗口分支反向依赖开发启动器 ``start.py``（后者顶层 import requests）。
    备份目录由 app.backup_path.resolve_backup_dir 解析（env > custom > default），
    与 GET /backups 共用同一来源。备份成功后滚动清理至 DESKTOP_BACKUP_KEEP 份；
    prune 失败只告警、不阻塞启动。
    """
    import sqlite3
    from datetime import datetime

    if not db_path.exists():
        return
    # 落点跟随可配置备份目录（与 API 列表同源，不再写死 db旁/backups）
    from app.backup_path import resolve_backup_dir
    backup_dir = resolve_backup_dir(db_path)
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backup_dir / f"app-{stamp}.db"
    i = 0
    while target.exists() and i < 5:
        target = backup_dir / f"app-{stamp}-{i}.db"
        i += 1
    con = sqlite3.connect(str(db_path))
    try:
        con.execute("VACUUM INTO ?", (str(target),))
    finally:
        con.close()
    try:
        _prune_local_backups(backup_dir, keep=DESKTOP_BACKUP_KEEP)
    except OSError as e:
        logging.getLogger().warning("备份滚动清理失败（不阻塞启动）: %s", e)


def _run_windowed_mode(port: int, ready_timeout: float) -> int:
    """窗口模式编排：单实例 → 数据目录 → 备份 → 线程内服务 → 就绪门 → native_host。"""
    from desktop import window as window_mod
    from desktop.appdata import resolve_db_path
    import os

    data_dir = resolve_db_path().parent
    logger = window_mod.setup_logging(data_dir / "logs", to_stdout=False)

    # 渲染器门（最优先）：PYWEBVIEW_GUI 指向 IE/mshtml → 直接拒绝启动，
    # 连服务都不起（非静默退化），绝不占端口、绝不建 IE 窗。
    if window_mod.gui_should_reject(os.environ.get("PYWEBVIEW_GUI")):
        msg = "错误：检测到 PYWEBVIEW_GUI 指向 IE/mshtml，禁止以 IE11 渲染器启动（已拒绝）。"
        print(msg)
        logger.error(msg)
        return 3

    inst = window_mod.SingleInstance()
    if not inst.acquire():
        # D2（早期记录，步骤 1）：单实例命中——用户可见用 MessageBoxW（noconsole 下
        #   print 不可见），**同时**保留 stdout 一行供 --headless 机器读；随后 exit 0。
        msg = "已有一个 PeriodIQ 实例在运行，本进程直接退出（单实例）。"
        window_mod.show_user_message(msg, "PeriodIQ 已在运行")
        print(msg, flush=True)
        logger.info(msg)
        return 0

    try:
        from app.backup_path import resolve_backup_dir as _rbd
        _backup_db_local(resolve_db_path())
        logger.info("备份完成: %s", _rbd(resolve_db_path()))
    except Exception as e:  # noqa: BLE001
        logger.warning("备份失败（不阻塞启动）: %s", e)

    base_url = f"http://127.0.0.1:{port}"
    server, thread = _serve_in_thread(port)
    logger.info("LISTENING %s (windowed, 线程内 uvicorn)", base_url)
    try:
        rc = window_mod.run_windowed(base_url, data_dir, timeout=ready_timeout)
    finally:
        server.should_exit = True
        thread.join(timeout=6)
        logger.info("服务线程已停止，端口 %s 释放", port)
    return rc


def _should_run_windowed(windowed: bool, headless: bool, frozen: bool | None = None) -> bool:
    """R21-C 裸启动默认判定（纯函数，可单测四种组合）。

    - 显式 --headless/--no-window → False（权威）
    - 显式 --windowed → True（权威）
    - 冻结产物且两者皆未给 → True（绿色版双击必须开窗）
    - 源码直跑且未给 --windowed → False（保持旧「只起服务」行为）
    """
    if headless:
        return False
    if windowed:
        return True
    if frozen is None:
        frozen = bool(getattr(sys, "frozen", False))
    return bool(frozen)


def main(argv: list[str] | None = None) -> int:
    _ensure_std_streams()
    args = _build_parser().parse_args(argv)

    if args.print_data_dir:
        return _resolve_and_print_data_dir()

    if args.port is not None:
        if not (1 <= args.port <= 65535):
            print(f"错误：端口必须在 1-65535 之间，收到：{args.port}")
            return 2
        if _port_in_use(args.port):
            print(f"错误：端口 {args.port} 已被占用。桌面入口绝不顺延端口"
                  f"（静默漂移会偏离指定地址）。请结束占用进程或改用其他端口。")
            return 1
        port = args.port
    else:
        port = _pick_free_port()

    # 冻结产物默认 windowed（见 _should_run_windowed）；显式参数权威。
    # 修「裸启动 PeriodIQ.exe 静默 headless」：entry.py 仅 windowed 分支曾开窗。
    want_windowed = _should_run_windowed(bool(args.windowed), bool(args.headless))

    if want_windowed:
        _prepare_db_env()
        return _run_windowed_mode(port, args.ready_timeout)

    _prepare_db_env()
    return _run_server(port)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 — 桌面产物无控制台，崩溃需落盘可查
        import traceback
        try:
            _lp = appdata.resolve_db_path().parent / "logs"
            _lp.mkdir(parents=True, exist_ok=True)
            (_lp / "startup_error.log").write_text(
                traceback.format_exc(), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
        raise
