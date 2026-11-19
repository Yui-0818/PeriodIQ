"""PeriodIQ 桌面端封装（R25-W2 起：Win32 顶层窗 + WebView2 宿主）。

- :mod:`desktop.appdata`        应用数据目录解析（%LOCALAPPDATA%\\PeriodIQ）+ 首启迁移
- :mod:`desktop.process_guard`  Windows Job Object 孤儿进程防护（纯 ctypes）
- :mod:`desktop.entry`          桌面入口（进程内 uvicorn + 新宿主编排）
- :mod:`desktop.window`         宿主封装（单实例 / 就绪门 / launch native_host）
- :mod:`desktop.native_host`    C# 源（FormBorderStyle.Sizable + WebView2）

**禁止** pywebview / frameless=True 路径复活为顶层窗（R25-W1 架构结论）。
对外契约（``start.py``）与既有开发路径保持解耦。
"""
