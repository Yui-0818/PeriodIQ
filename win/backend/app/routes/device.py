r"""device 路由（设备级偏好；2026-10-26 由 desktop.py 改名并扩展，对齐 Android 端点）。

端点（均需登录，未带 token → 401）：
- GET /device/settings: 读设备级偏好（theme / close_action / reminder_* 组）
- PUT /device/settings: 部分更新（仅更新传入字段；非法值 → 422 VALIDATION_ERROR）

键分两层：
- **两端共有键**：theme ∈ light|dark|system（默认 system；Android 同枚举同默认，
  落 SharedPreferences，见 ~\Android\...\PiqSettings.kt）；
- **Win 平台键**（Android 侧 /device/settings 不暴露）：close_action（关闭分流，
  desktop/window.py + native_host.cs 消费）与 reminder_*（提醒三件套开关 + 每晚填写
  开关 + 提前量 + 触发整点 reminder_trio_hour/reminder_fill_hour（0-23，默认 9/21），
  services/reminder.py 消费；五个开关默认全 false、days 默认 3，与 Android
  PiqSettings.NOTIFY_DEFAULTS 同值）。

存储：数据目录 ``desktop_settings.json``（与 app.db 同目录，路径派生自
config.DB_ABS_PATH.parent，桌面入口经 MENSTRUAL_DB_PATH 保证两端口径一致）。
该文件是运行时生成物，不是用户数据备份形态（不在 *.db/备份 JSON 之列），
随数据目录存在，不入库。⚠ 文件名沿用 desktop_settings.json 不改：
desktop/window.py 按同名镜像读、native_host.cs 按键名定位，两端不在本轮白名单。

为什么是**设备级**而非用户级：theme/close_action/reminder 开关描述的是「这台设备
怎么显示、怎么关窗、怎么提醒」，跟哪个账号登录无关；且 R1 已把 app_settings
用户级语义空壳化，不在其上重建用户级设置——新文件、新语义，绕开旧壳。

前端重建时由 UI 读取并应用（本轮后端只交付存储与读写契约）。

修 #34（2026-10-31）：PUT 写盘成功后调用 ``services.reminder.wake()``，提醒循环
立即重读并按新时点重排（时点修改即时生效）；局部 import 以避免
device ↔ reminder 循环导入。
"""

import json
import os
import threading

from fastapi import APIRouter, Depends

from app import config
from app.schemas.api import DeviceSettingsRequest, DeviceSettingsResponse
from app.security import require_user

router = APIRouter(prefix="/device", tags=["device"])

# 进程内串行化「读-改-写」（本地单用户单进程；文件本体另由 tmp+os.replace 原子替换）。
_write_lock = threading.Lock()

# 存储键 →（合法值集合，默认值）。reminder_daily_fill 与 reminder_* 同文件同族存取
# （GET/PUT 均读写本键）；本表是文件键集与校验的单一来源。
_FILE_KEYS: dict[str, tuple[tuple, object]] = {
    "theme": (config.DESKTOP_THEMES, config.DESKTOP_THEME_DEFAULT),
    "close_action": (config.DESKTOP_CLOSE_ACTIONS, config.DESKTOP_CLOSE_ACTION_DEFAULT),
    "reminder_master": ((True, False), config.REMINDER_MASTER_DEFAULT),
    "reminder_advance": ((True, False), config.REMINDER_ADVANCE_DEFAULT),
    "reminder_on_day": ((True, False), config.REMINDER_ON_DAY_DEFAULT),
    "reminder_overdue": ((True, False), config.REMINDER_OVERDUE_DEFAULT),
    "reminder_days": (tuple(config.REMINDER_VALID_DAYS), config.REMINDER_DAYS_DEFAULT),
    "reminder_trio_hour": (
        tuple(range(config.REMINDER_HOUR_MIN, config.REMINDER_HOUR_MAX + 1)),
        config.REMINDER_TRIGGER_HOUR,
    ),
    "reminder_fill_hour": (
        tuple(range(config.REMINDER_HOUR_MIN, config.REMINDER_HOUR_MAX + 1)),
        config.DAILY_NOTIFY_HOUR,
    ),
    "reminder_daily_fill": ((True, False), config.DAILY_NOTIFY_ENABLED),
}


def _settings_path():
    """desktop_settings.json 绝对路径（数据目录 = app.db 同目录）。"""
    return config.DB_ABS_PATH.parent / config.DESKTOP_SETTINGS_FILENAME


def _read_stored() -> dict:
    """读偏好（只回**存过且合法**的键）；文件缺失/损坏/字段非法时逐字段回落默认。

    GET 永不 500；「没存过」与「存了脏值」都按默认值处理，且**不改写**文件
    （与 Android PiqSettings.notifyValue 同一条纪律）。
    """
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
    except (OSError, ValueError):
        return {}
    out = {}
    for key, (valid, _default) in _FILE_KEYS.items():
        value = data.get(key)
        if isinstance(value, bool):  # 布尔键（bool 是 int 子类，先判 bool 再判 int）
            if True in valid:
                out[key] = value
        elif isinstance(value, int) and not isinstance(value, bool):
            if value in valid:  # reminder_days 白名单
                out[key] = value
        elif isinstance(value, str) and value in valid:
            out[key] = value
    return out


def read_effective_settings() -> dict:
    """全键**生效值**（存过且合法的值，其余回落默认）——services/reminder.py 的取数入口。

    提醒服务不直接碰文件路径/校验规则：本函数是「设备偏好怎么读」的单一来源。
    """
    stored = _read_stored()
    return {key: stored.get(key, default) for key, (_v, default) in _FILE_KEYS.items()}


def _write_settings(effective: dict) -> None:
    """原子写：先写同目录临时文件再 os.replace（同一卷上替换是原子操作，
    任何时刻崩溃/断电都不会留下半截 JSON；残缺 tmp 文件不影响下次读写）。"""
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(
        json.dumps(
            {key: effective[key] for key in _FILE_KEYS},
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _api_view(effective: dict) -> dict:
    """API 响应形态：十个生效键（与 DeviceSettingsResponse 同构）。"""
    return {
        "theme": effective["theme"],
        "close_action": effective["close_action"],
        "reminder_master": effective["reminder_master"],
        "reminder_advance": effective["reminder_advance"],
        "reminder_on_day": effective["reminder_on_day"],
        "reminder_overdue": effective["reminder_overdue"],
        "reminder_days": effective["reminder_days"],
        "reminder_trio_hour": effective["reminder_trio_hour"],
        "reminder_fill_hour": effective["reminder_fill_hour"],
        "reminder_daily_fill": effective["reminder_daily_fill"],
    }


@router.get("/settings", response_model=DeviceSettingsResponse)
async def get_device_settings(user: dict = Depends(require_user)) -> dict:
    """读设备级偏好（需登录）。"""
    return _api_view(read_effective_settings())


@router.put("/settings", response_model=DeviceSettingsResponse)
async def put_device_settings(
    body: DeviceSettingsRequest, user: dict = Depends(require_user)
) -> dict:
    """部分更新设备级偏好（需登录；非法值经 schema 校验 → 422）。

    仅更新传入字段（None = 不更新）；reminder_daily_fill 与其它 reminder_* 同经本端点
    写入并回显。
    2026-10-31 修 #34：写盘成功后唤醒提醒循环立即重排（reminder.wake()）——
    修改 reminder_trio_hour / reminder_fill_hour 后新时点下一轮即生效，不必等旧整点。
    """
    updates = {
        "theme": body.theme,
        "close_action": body.close_action,
        "reminder_master": body.reminder_master,
        "reminder_advance": body.reminder_advance,
        "reminder_on_day": body.reminder_on_day,
        "reminder_overdue": body.reminder_overdue,
        "reminder_daily_fill": body.reminder_daily_fill,
        "reminder_days": body.reminder_days,
        "reminder_trio_hour": body.reminder_trio_hour,
        "reminder_fill_hour": body.reminder_fill_hour,
    }
    with _write_lock:
        effective = read_effective_settings()
        for key, value in updates.items():
            if value is not None:
                effective[key] = value
        _write_settings(effective)
    # 修 #34：写盘后唤醒提醒循环重排（放在锁外：唤醒只需事件置位，不应占写锁）。
    # 局部 import 是刻意的——services/reminder.py 反向 import 本模块的
    # read_effective_settings，模块级 import 会构成 device ↔ reminder 循环导入。
    from app.services import reminder
    reminder.wake()
    return _api_view(effective)
