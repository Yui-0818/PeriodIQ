# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""FastAPI 应用入口（早期设计文档）。

- CORS 中间件
- 注册所有 /api/v1 路由
- 启动时初始化数据库（DDL 建表）
- 挂载前端静态（P2：目录存在时挂载，不存在时根路径占位）
"""

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import config
from app.db.database import close_read_pool, init_db
from app.routes import analysis, auth, backups, cycles, daily, debug, device, journal, keepalive, predictions, settings, twa
from app.services import reminder

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# 提醒任务句柄（2026-10-26 每晚填写 → 同日扩展四类；仅应用运行时有效，
# 见 services/reminder.py 注释）
_reminder_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化数据库；关闭时取消提醒任务并释放读连接池。"""
    await init_db()
    # 2026-10-26：提醒任务（09:00 经期三件套 + 21:00 每晚填写，进程内 asyncio 任务；
    # 应用关闭即失效，边界见模块注释）
    _reminder_start()
    logger.info("应用启动完成，API 前缀: %s", config.API_PREFIX)
    yield
    await _reminder_stop()
    # v0.13.1 修 G15：显式关闭读连接池（不留悬挂句柄，利于测试清理与进程重启）
    await close_read_pool()
    logger.info("应用关闭")


def _reminder_start() -> None:
    """启动提醒任务（已在运行则不重复启动）。"""
    global _reminder_task
    if _reminder_task is not None and not _reminder_task.done():
        return
    _reminder_task = asyncio.create_task(reminder.run(), name="reminder")


async def _reminder_stop() -> None:
    """取消提醒任务并等待其退出（未运行则空操作）。"""
    global _reminder_task
    task = _reminder_task
    _reminder_task = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="PeriodIQ",
    description="PeriodIQ 个人级月经周期预测应用 API",
    # v0.9.0 修 P5：版本号单一来源 config.APP_VERSION（旧硬编码 "0.5.0" 长期失修）
    version=config.APP_VERSION,
    lifespan=lifespan,
    # v0.13.1 修 G9：关闭交互式文档——/docs、/redoc、/openapi.json 无鉴权
    # 暴露全部端点契约，与本地安全收紧基调不符；契约以早期设计文档为
    # 唯一权威（API 表），调试用 HTTP 直连（curl/前端 devtools）。
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# ============================================================
# 导入体积闸门
# 只作用于 POST /api/v1/import：在 FastAPI 读取/解析请求体与 pydantic 校验之前，
# 按**原始请求体字节数**拒绝超过 config.MAX_IMPORT_BYTES（8 MiB）的请求，
# 返回 400 + code IMPORT_TOO_LARGE（与 Android 同值同码）。
# 注册顺序：本中间件先注册、CORS 后注册 ⇒ CORS 位于最外层，拒绝响应同样带 CORS 头。
# ============================================================
@app.middleware("http")
async def import_body_size_gate(request: Request, call_next):
    """POST /import 的 8 MiB 体积闸门（严格大于上限才拒，等于放行）。"""
    if request.method == "POST" and request.url.path == f"{config.API_PREFIX}/import":
        # await request.body() 读完即缓存（Starlette _CachedRequest 行为），
        # 下游 FastAPI 仍能正常读取/解析同一份请求体。
        body = await request.body()
        size = len(body)
        if size > config.MAX_IMPORT_BYTES:
            mb = size / 1048576
            limit_mb = config.MAX_IMPORT_BYTES / 1048576
            return JSONResponse(
                status_code=400,
                content={
                    "detail": (
                        f"这份备份太大了（约 {mb:.1f} MB，本机导入上限 {limit_mb:.0f} MB）。"
                        "下一步：备份体积主要由每条记录的备注文字决定，先清理超长备注或删掉"
                        "最早的记录，再重新「导出备份」；正常使用的备份不会到这个量级"
                        "（实测最大合法形态约 6.5 MB）。"
                    ),
                    "code": "IMPORT_TOO_LARGE",
                },
            )
    return await call_next(request)


# CORS（早期设计文档；v0.13.0 修 F3：allow_origin_regex 仅放行本地源，
# 请求头白名单收紧为 Authorization/Content-Type，正则统一由 config.py 管理）
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=config.CORS_ALLOW_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)


# ============================================================
# 全局异常处理器（M5 新Bug A 修复：扁平错误契约 错误响应格式统一）
# ============================================================
# 问题：routes 层用 raise HTTPException(detail={"detail": msg, "code": CODE})，
# FastAPI 默认会再包一层 detail → {"detail": {"detail": msg, "code": CODE}}，
# 导致前端 api 模块解析 errorData.code 得到 undefined。
# 修复：全局 handler 检测 detail 为 dict 时展平为契约要求的扁平结构。
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """统一错误响应格式为扁平错误契约：{"detail": "message", "code": "ERROR_NAME"}。

    routes 层约定用 raise HTTPException(
        status_code=400, detail={"detail": "消息", "code": "ERROR_NAME"}
    ) 抛业务异常；handler 自动展平。
    若 detail 为字符串（FastAPI 内置异常如 422 校验），补充通用 code。
    """
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        # 业务异常：展平为契约格式（v0.13.0 修 F2：透传 Retry-After 头）
        # 透传契约附加字段（如 DATA_ANOMALY.anomalies 列表）
        content: dict = {"detail": detail.get("detail", ""), "code": detail["code"]}
        for k, v in detail.items():
            if k not in ("detail", "code"):
                content[k] = v
        return JSONResponse(
            status_code=exc.status_code,
            content=content,
            headers=exc.headers,
        )
    # 普通异常（detail 为字符串，如 Starlette 内置）
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": detail if isinstance(detail, str) else str(detail), "code": "HTTP_ERROR"},
        headers=exc.headers,
    )


# v0.12.0 修 E9：Pydantic 请求校验失败（422）此前走 FastAPI 默认格式
# （{"detail": [{loc, msg, type}, ...]}），与扁平错误契约 的扁平 {detail, code}
# 结构不一致——前端 errorData.code 得到 undefined。统一为扁平契约。
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """请求体校验失败 → 422 扁平错误契约（含首条错误的可读摘要）。"""
    first = exc.errors()[0] if exc.errors() else {}
    loc = ".".join(str(x) for x in first.get("loc", []) if x != "body")
    msg = first.get("msg", "请求参数不合法")
    summary = f"{loc}: {msg}" if loc else msg
    return JSONResponse(
        status_code=422,
        content={"detail": f"请求参数校验失败（{summary}）", "code": "VALIDATION_ERROR"},
    )


# 注册所有 /api/v1 路由
api_prefix = config.API_PREFIX
app.include_router(auth.router, prefix=api_prefix)
app.include_router(cycles.router, prefix=api_prefix)
app.include_router(predictions.router, prefix=api_prefix)
app.include_router(analysis.router, prefix=api_prefix)
app.include_router(settings.router, prefix=api_prefix)
# 2026-10-26：经期每日详情记录（PUT/GET /daily-records）
app.include_router(daily.router, prefix=api_prefix)
# 2026-10-31 #14：每日日记（独立渠道，GET/PUT /daily-journal）
app.include_router(journal.router, prefix=api_prefix)
# 2026-10-26：设备级偏好 theme/close_action/reminder_*（GET/PUT /device/settings，需登录；
# 同日端点改名并对齐 Android，旧 desktop 路径已下线）
app.include_router(device.router, prefix=api_prefix)
# PeriodIQ：备份列表（只读）
app.include_router(backups.router, prefix=api_prefix)
# v0.5.0 算法透视镜路由（全部 GET 只读）
app.include_router(debug.router, prefix=api_prefix)
# v0.6.0 前端存活心跳路由（SSE 连接状态，GET 只读）
app.include_router(keepalive.router, prefix=api_prefix)

# 注册 TWA assetlinks 路由（无 API 前缀，路径为 /.well-known/assetlinks.json）
# 关键：必须在 app.mount("/", StaticFiles(...)) 之前注册，否则会被静态文件拦截返回 404
app.include_router(twa.router)


@app.get(f"{config.API_PREFIX}/health", tags=["health"])
async def health_check() -> dict:
    """健康检查端点（v0.12.0 死代码清理：路径复用 API_PREFIX，不再硬编码）。"""
    return {"status": "ok", "version": config.APP_VERSION}


# 挂载前端静态（目录存在时挂载，不存在时根路径占位）
# Win\frontend 现为 3.0.0 冻结副本（来源 tag demo_over_2，已入库），本就不含老三镜像
# app.js / sw.js 与 index.html ?v=；启动版本核对与版本同步脚本已于 2026-11-14 P4-B
# 退役（见 docs/DECISIONS.md D3），运行时版本以 GET /api/v1/health 的 data.version 为准。
# 早期设计文档中的静态挂载写法：
# app.mount("/", StaticFiles(directory="../../frontend", html=True))
# 静态挂载已实现：Win\frontend 存在则挂载；缺失时启动不阻断，GET / 返回占位 JSON
# P4-A frozen 路径适配（只动目录解析，不动业务逻辑）：冻结产物中前端副本由
# build_desktop.py 组装在 PeriodIQ.exe 同级的 frontend/；源码模式保持原
# Win/frontend（Path(__file__) 向上三级）解析不变。
if getattr(sys, "frozen", False):
    _frontend_dir = Path(sys.executable).resolve().parent / "frontend"
else:
    _frontend_dir = Path(__file__).resolve().parent.parent.parent / "frontend"
if _frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_dir), html=True), name="frontend")
else:
    # 兜底分支：仅当 Win\frontend 缺失时触发；冻结副本已入库后正常不会走到，
    # 保留为占位（2026-11-14 P4-B 退役启动版本核对时确认保留）。
    @app.get("/", include_in_schema=False)
    async def root() -> dict:
        """根路径占位（前端未部署）。"""
        # v0.14.0 修 M8：删除 {"docs": "/docs"} 死链接——v0.13.1 修 G9 已关闭
        # /docs、/redoc、/openapi.json（docs_url=None），该字段会指向 404。
        return {
            "message": f"{config.PRODUCT_NAME} API",
            "version": config.APP_VERSION,
            "frontend": "前端尚未部署，请在 P2 阶段部署",
        }
