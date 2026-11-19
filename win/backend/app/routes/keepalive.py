"""keepalive 路由（v0.6.0：前端关闭时自动关闭后端）。

设计：
- GET /api/v1/keepalive：SSE 长连接流。前端页面打开期间保持连接，
  页面关闭 → 连接断开 → 生成器 finally 记录断开时间（closed_since）。
- GET /api/v1/keepalive/status：连接状态查询。start.py 轮询此端点，
  当活跃连接数为 0 且断开超过阈值时自动停止 uvicorn 进程。

边界设计（避免误杀）：
- 浏览器休眠：TCP 连接保持，不触发断开，不误杀
- 页面刷新：旧连接断开瞬间计数归零，但新页面立即重连清除 closed_since
- 多标签页：按连接计数，全部关闭才触发
- 纯 API 使用（从未打开页面）：active=0 且 closed_since=None，永不触发

约束：全部 GET 只读，不写数据库，不触发算法更新。
"""

import asyncio
import time
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from app import config

router = APIRouter(tags=["keepalive"])

# 模块级连接状态（uvicorn 单进程单 worker，asyncio 单线程，原子操作无需锁）
_active_connections: int = 0
_closed_since: float | None = None  # 最近一次"全部断开"的时间戳，None=有活跃连接或从未连接


@router.get("/keepalive")
async def keepalive_stream() -> StreamingResponse:
    """SSE 长连接：前端页面存活心跳。

    生成器**首次迭代**时活跃计数 +1 并清除断开标记；
    客户端断开（Tab 关闭/页面退出）时生成器 finally 中计数 -1，
    若归零则记录 closed_since 供 start.py 轮询检测。

    v0.13.1 修 G11：并发连接上限（config.KEEPALIVE_MAX_CONNECTIONS，超出 →
    503 KEEPALIVE_FULL）。本端点为登记豁免的无鉴权 SSE（EventSource 无法
    自定义请求头），上限收敛滥用面——防止任意本地进程大开长连接阻止
    自动关停/耗尽连接资源。浏览器 HTTP/1.1 每主机上限 6 个，32 足够
    多标签页正常使用。

    审计第二批 P3（计数泄漏）：计数 +1 与 `_closed_since = None` 重置原先在
    handler 内、生成器体外——客户端在计数后、生成器首次迭代前断开时，未启动的
    生成器被 close **不会触发 finally**（Python 语义：尚未运行到任何 yield 的
    生成器没有已进入的 try/finally 可执行），计数只增不减 → active 虚高、
    自动关停永不触发。修法：计数/重置全部移进 event_stream 生成器体内 try
    首段（首迭代即计数；从未启动的生成器既不计数、也无 finally 需要执行，
    泄漏消除）。/keepalive/status 只读两个模块级变量，读到的恒为「已真正开始
    流式的连接数」，语义不受影响。上限检查仍在 handler（拒绝的连接不进入
    流式，也就不计数）。
    """
    # 超限拒绝（在计数前判定，拒绝的连接不进入计数）
    if _active_connections >= config.KEEPALIVE_MAX_CONNECTIONS:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"detail": "心跳连接数已达上限", "code": "KEEPALIVE_FULL"},
        )

    async def event_stream() -> Any:
        global _active_connections, _closed_since
        try:
            # 计数与重置必须在生成器体内（见 handler docstring 的泄漏分析）：
            # 放在首个 yield 之前，首次迭代即计数；生成器从未启动则从未计数
            _active_connections += 1
            _closed_since = None
            while True:
                yield "data: ok\n\n"
                await asyncio.sleep(config.KEEPALIVE_HEARTBEAT_SECONDS)
        finally:
            # 客户端断开（http.disconnect / 连接关闭）→ 生成器被取消
            _active_connections -= 1
            if _active_connections <= 0:
                _active_connections = 0
                _closed_since = time.time()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/keepalive/status")
async def keepalive_status() -> dict:
    """连接状态查询（start.py 轮询用）。"""
    global _closed_since
    idle = round(time.time() - _closed_since, 1) if _closed_since is not None else 0.0
    return {
        "status": "ok",
        "active_connections": _active_connections,
        "closed_since": _closed_since,
        "idle_seconds": idle,
    }


def _reset_state() -> None:
    """重置连接状态（仅测试使用）。"""
    global _active_connections, _closed_since
    _active_connections = 0
    _closed_since = None
