# PeriodIQ

本地优先的经期记录与预测工具，支持 Windows 桌面与 Android。

PeriodIQ 把周期、经期、症状、心情和日记保存在本机 SQLite 中：没有账号服务器、没有云同步、没有统计上报。它只做统计推算，不是医疗器械，不能用于诊断、治疗或避孕。

## 功能

- **周期与经期记录**：记录开始/结束日、周期长度、经期长度与备注。
- **预测**：基于历史周期推算下次经期与排卵窗口，并显示预测误差。
- **日历**：月视图、每日详情、经期/排卵/易孕标记。
- **洞察**：周期统计、规律性、症状与心情趋势。
- **日记与心情**：仅当天可写，支持非经期日。
- **导入导出**：JSON/CSV 整包替换；导入前自动快照；日记与心情标签不随导入导出。
- **三语界面**：简体中文、English、Español，切换即时生效。
- **本地优先**：Windows 端只绑定 `127.0.0.1`，无出站请求；卸载不删除数据。

## 下载（Windows）

本次发布为 **PeriodIQ Win 3.0.8**，GitHub Releases 仅包含 Windows 安装包：

- `PeriodIQ-Setup-3.0.8.exe`

系统要求：Windows 10/11 x64，已安装 Microsoft Edge WebView2 Runtime。

Android 端源码位于 [`android/`](android/)，本次不提供预编译 APK。

## 隐私

- 所有数据保存在本机；没有服务器、云同步、遥测或第三方统计。
- Win 端后端只监听 `127.0.0.1`，前端资源全部本地打包。
- 用户数据、数据库、备份与日志均不入库；仓库只包含程序源码与文档。
- 卸载程序不会删除用户数据。

## 技术栈

- **Windows 后端**：Python 3.11、FastAPI、SQLite（aiosqlite）。
- **Windows 桌面壳**：C# WinForms + WebView2。
- **前端**：原生 HTML/CSS/JavaScript，无构建、无外链资源。
- **Android**：Kotlin + WebView + Chaquopy。

## 仓库结构

```text
PeriodIQ/
├─ README.md
├─ .gitignore
├─ win/
│  ├─ backend/      # FastAPI 后端与应用源码
│  ├─ frontend/     # Win 端静态前端
│  └─ desktop/      # WebView2 宿主、入口与窗口源码
└─ android/         # Kotlin + WebView + Chaquopy 工程
```

安装包、构建产物、用户数据、私有资产、构建/打包脚本与维护脚注不进入源码仓库；Windows 安装包只通过 Releases 分发。

## 从源码运行 Windows 端

需要 Python 3.11+。在仓库根目录执行：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r win\backend\requirements.txt
.venv\Scripts\python.exe win\desktop\entry.py --windowed
```

首次运行会在用户级默认目录创建空数据库；也可用 `MENSTRUAL_DB_PATH` 指定隔离数据库。开发调试可加 `--headless --port 8000` 只启动后端。

编译原生宿主：

```powershell
powershell -ExecutionPolicy Bypass -File win\desktop\build_native_host.ps1
```

## 版本

当前 Windows 版本：**3.0.8**。

## 免责声明

PeriodIQ 是统计推算工具，输出仅供参考，不构成医疗建议，也不能作为避孕依据。如有健康问题，请咨询专业医生。
