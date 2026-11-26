# PeriodIQ Win 端源码

Windows 桌面端：Python FastAPI 后端 + C# WinForms/WebView2 宿主 + 原生静态前端。全部离线，只绑定 `127.0.0.1`，无出站请求。

## 结构

| 路径 | 内容 |
|---|---|
| `backend/app/` | FastAPI 应用、路由、数据库与预测逻辑。 |
| `backend/requirements.txt` | 运行依赖。 |
| `frontend/` | Win 端静态前端（原生 HTML/CSS/JS，无构建）。 |
| `desktop/entry.py` | 进程入口：起后端、开窗口或 headless。 |
| `desktop/native_host.cs` | WebView2 原生宿主与窗口源码。 |
| `desktop/build_native_host.ps1` | 用系统 `csc.exe` 编译原生宿主到 `desktop/bin/`。 |
| `desktop/webview2_sdk/` | 编译宿主所需的 WebView2 托管 DLL。 |

## 运行

需要 Python 3.11+。在仓库根目录：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r win\backend\requirements.txt
.venv\Scripts\python.exe win\desktop\entry.py --windowed
```

只启动后端调试：

```powershell
.venv\Scripts\python.exe win\desktop\entry.py --headless --port 8000
```

## 数据

- 默认数据目录在用户级位置；可用 `MENSTRUAL_DB_PATH` 指定隔离数据库。
- `win/backend/data/`、`*.db`、`*.bak` 均不入库。
- 卸载程序不删除用户数据。

## 原生宿主

```powershell
powershell -ExecutionPolicy Bypass -File win\desktop\build_native_host.ps1
```

产物在 `win/desktop/bin/`（gitignored）。安装包构建/打包脚本不在本仓库；预编译安装包见 GitHub Releases。

## 版本

当前 `3.0.8`。版本唯一来源：`backend/app/config.py` 的 `APP_VERSION`。
