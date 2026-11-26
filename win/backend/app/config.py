# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""全局配置参数（早期设计文档）。

所有可调参数集中在此文件，禁止在算法代码中使用魔法数字。
参数值严格按早期设计文档，不得自行修改。
"""

import os
from pathlib import Path


# ============================================================
# 关键参数表 - 原样执行，不得修改
# ============================================================

# 先验参数
PRIOR_MEAN: float = 28.0          # 先验周期均值（天）
PRIOR_STD: float = 7.0            # 先验标准差

# 统计窗口
STATS_WINDOW_N: int = 12          # 统计取最近 N 次
WEIGHT_DECAY: float = 0.85        # 加权平均衰减率

# EMA 参数
EMA_ALPHA: float = 0.3            # EMA 学习率
EMA_FUSION_WEIGHT: float = 0.4    # EMA 在最终预测中权重

# 预测区间
INTERVAL_STD_MULT: float = 1.5    # 区间 = mean ± std * mult

# 贝叶斯先验权重衰减
PRIOR_DECAY_K: float = 5.0        # 先验权重衰减常数

# 周期合法性
MIN_CYCLE_DAYS: int = 7           # 最小合法周期
MAX_CYCLE_DAYS: int = 90          # 最大合法周期

# 异常检测
# v0.14.2 修 AN-6（注释与实现对齐）：偏离基准是**中位数**不是均值
# （bayesian.py::on_new_cycle_added 与 crud.py 重推派生字段均用 statistics.median）。
# 用中位数是为了抗污染：均值本身会被那个离群周期拽走，导致离群值"自证正常"。
ANOMALY_DEVIATION_THRESHOLD: int = 14     # 偏离**中位数**超此值即标记为异常（仍参与计算，仅降权）
ANOMALY_CONSECUTIVE_THRESHOLD: int = 3    # 连续异常触发 ALERT

# 标准差下限
MIN_STD: float = 2.0              # 标准差下限（防止 std=0 导致区间为 0 天）

# 冷启动阈值
# 语义注意：判据是**合法周期数 n**（= 记录数 − 1 − 硬无效条数），不是记录数。
# 常量名沿用历史命名 `COLD_START_THRESHOLD`，取值 3 表示"至少 3 个有效周期
# （即约 4 条记录）才启用贝叶斯分支"；n=2 时 model_version 已显示 bayesian_v1
# 但 bayes_applied=False，两者不得互相推断（见 stats.predict_core 口径登记）。
COLD_START_THRESHOLD: int = 3     # 启用贝叶斯分支所需的最小**合法周期数**

# 通知（通知功能暂不实现，仅保留参数）
NOTIFY_DAYS_DEFAULT: int = 3      # 默认提前通知天数

# 置信度范围
CONFIDENCE_MIN: float = 0.3       # 置信度下限
CONFIDENCE_MAX: float = 0.95      # 置信度上限

# 数据库
# v0.10.0：支持 MENSTRUAL_DB_PATH 环境变量覆盖（早期前端测试脚本；用隔离库跑
# 浏览器验收，绝不触碰真实数据；默认行为不变）。绝对路径时 DB_ABS_PATH 派生仍正确
# （pathlib 对绝对路径的 / 运算返回绝对路径本身）。
DB_PATH: str = os.environ.get("MENSTRUAL_DB_PATH", "data/app.db")  # SQLite 路径（相对 backend 工作目录）

# v0.13.0 修 F1：迁移默认用户口令——只允许来自环境变量（源码不得出现任何明文默认口令；
# 未设置且迁移确需建户时，由 database.py 用 secrets 生成一次性初始口令并在启动日志打印一次）
MIGRATION_PASSWORD: str | None = os.environ.get("MENSTRUAL_MIGRATION_PASSWORD") or None

# v1→v2 迁移建默认用户所用的用户名。中性化（原为个人昵称），
# 与 MIGRATION_PASSWORD 同族——口令在 v0.13.0 修 F1 时已外置化，用户名这一半当时漏了。
MIGRATION_DEFAULT_USERNAME: str = "default"

# API
API_PREFIX: str = "/api/v1"       # API 前缀

# v0.13.0 修 F3：CORS 允许源正则（仅放行本地开发源；正则统一在此管理，main.py 引用）
CORS_ALLOW_ORIGIN_REGEX: str = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"


# ============================================================
# 派生常量（非参数表参数，但用于代码统一）
# ============================================================

# 后端版本号（main.py 的 FastAPI version 与 /health 均引用本值）
APP_VERSION: str = "3.0.8"

# 后端根目录（用于定位 data 目录）
BACKEND_ROOT: Path = Path(__file__).resolve().parent.parent
# 数据库绝对路径
DB_ABS_PATH: Path = BACKEND_ROOT / DB_PATH

# 冷启动置信度（早期设计文档）
CONFIDENCE_COLD_0: float = 0.3    # 0 条记录
CONFIDENCE_COLD_1: float = 0.4    # 1 条记录
CONFIDENCE_COLD_2: float = 0.5    # 2 条记录

# v0.13.0 修 F26：置信度映射参考标准差（stats.py 置信度 = 1 - std/SCALE，clamp 后输出）。
# 注意：数值恰与 ANOMALY_DEVIATION_THRESHOLD=14 相同，但语义无关（一个是
# std→置信度的刻度参考，一个是周期偏离异常阈值），不得混用。
CONFIDENCE_STD_SCALE: float = 14.0

# 模型版本标识
MODEL_VERSION_NONE: str = "none"
MODEL_VERSION_COLD_1: str = "cold_start_1"
MODEL_VERSION_COLD_2: str = "cold_start_2"
MODEL_VERSION_BAYESIAN: str = "bayesian_v1"


# ============================================================
# v0.5.0 桌面测试版参数（早期设计文档；新增3个，仅桌面UI使用，不影响算法）
# ============================================================

DESKTOP_BREAKPOINT_PX: int = 1024      # 桌面断点像素值：≥1024px 显示桌面布局（侧边栏+debug面板）
# v0.14.0 登记值对齐（审计：config 写 200、CSS 实际 240，属长期漂移的登记项）：
# 图表高度**由 CSS 决定**（这两个常量全库无读取处，纯登记），实际生效值见
# style.css `.chart-container`：默认 240px（v0.11.4 从 200 提到 240，为末点直标与
# 参考带留呼吸空间，早期记录已入库）、`@media (min-width:1024px)` 为 300px。
# 此处按 CSS 实况登记为 240，消除"文档说 200、界面是 240"的漂移。
CHART_HEIGHT_MOBILE_PX: int = 240      # 移动端 Chart.js 图表高度（px，与 CSS .chart-container 一致）
CHART_HEIGHT_DESKTOP_PX: int = 300     # 桌面端 Chart.js 图表高度（px，CSS 桌面断点覆盖值）

# v0.6.0 前端自动关闭（早期设计文档）：SSE 心跳间隔（秒）
KEEPALIVE_HEARTBEAT_SECONDS: float = 5.0   # keepalive SSE 心跳间隔，前端断开检测粒度


# ============================================================
# v0.8.0 预测优化 P1 参数（早期设计文档；用户 2026-09-06 授权）
# 授权范围：仅 P1（口径一致性 + 鲁棒降权 + trace 真实化 + F7 落库）。
# P2 增量贝叶斯 / P3 CRN 与多算法对比 **未获授权**，本文件不含其参数。
# ============================================================

# F1 修复：统计窗口与文档基线对齐（原 12 与预测方案声明的 window=6 失配）
STATS_WINDOW_N_V080: int = 6      # 生效窗口：取最近 6 个周期（原 STATS_WINDOW_N=12 保留供历史审计）

# F5 修复：异常周期「鲁棒降权」而非一刀切剔除
# 硬剔除边界复用 MIN_CYCLE_DAYS=7 / MAX_CYCLE_DAYS=90（用户明确要求：<7 天直接抛弃）
ROBUST_MAD_SCALE: float = 1.4826  # MAD→σ 一致性换算系数（统计学标准值）
ROBUST_MIN_SCALE: float = 2.0     # 离散度下限（天）：周期差 2 天内视为正常波动，避免 MAD≈0 时过度降权
ROBUST_SOFT_Z: float = 1.5        # 降权起点：稳健 z 分数 ≤1.5 的周期不降权（权重=1.0）
ROBUST_MIN_WEIGHT: float = 0.15   # 降权下限：越异常降权越大，但绝不降到 0（不丢信号）

# F7 修复：过期预测就地刷新的判定（v0.14.0 注释如实化：0 表示无宽限——
# predicted_date + 0 < today 即「预测日已过」当天就判过期，不额外留缓冲）
PREDICTION_STALE_GRACE_DAYS: int = 0    # 宽限天数：predicted_date + grace < today 即视为过期

# 排卵/安全期推算（仅用已有月经周期数据，不新增任何输入）
LUTEAL_PHASE_DAYS: int = 14             # 黄体期恒定假设：排卵日 = 预测下次月经前 14 天
FERTILE_PRE_OVULATION_DAYS: int = 5     # 易孕期起点：排卵前 5 天（精子存活上限）
FERTILE_POST_OVULATION_DAYS: int = 1    # 易孕期终点：排卵后 1 天（卵子存活上限）


# ============================================================
# v0.8.1 动态二次收缩参数（早期设计文档；用户 2026-09-06 授权改写规则）
# ============================================================

# 动态化：附加先验收缩强度由周期离散度连续决定，而非二值开关。
# 规律度指标 = 预测窗口加权 std（cycle_std 输出，下限 MIN_STD）：
# std <= REGULAR → 完全规律，仅共轭后验单次收缩（v0.8.0 行为，规律用户不被拉向 28）；
# std >= IRREGULAR → 高度不规律，附加收缩达满强度（等效 v0.7.x 的
# (1-pw)*mu_post + pw*PRIOR_MEAN 线性混合）；两者之间线性插值。
# 取 7.0=PRIOR_STD 作不规律端点：std 达到先验量级意味着数据几乎不提供
# 超越人群先验的信息，此时加强先验收缩是稳定性的来源而非偏置。
ADAPTIVE_SHRINK_REGULAR_STD: float = 3.0    # 规律端点（天）：窗口 std 不超过此值视为规律
ADAPTIVE_SHRINK_IRREGULAR_STD: float = 7.0  # 不规律端点（天）：窗口 std 达到此值收缩满强度


# ============================================================
# v0.9.0 临床观察提示参数（早期设计文档，仅用于派生「建议关注」类提示，
# 不参与任何预测计算；措辞遵循诚实性纪律，不构成诊断）
# ============================================================

CLINICAL_CYCLE_MIN_DAYS: int = 21   # 典型周期下限（Amenorrhoea/多囊等评估常用 21-35 参考带）
CLINICAL_CYCLE_MAX_DAYS: int = 35   # 典型周期上限
CLINICAL_PERIOD_MAX_DAYS: int = 8   # 典型经期上限（>8 天提示经期延长，建议关注）
OVERDUE_NOTICE_DAYS: int = 7        # 预测日逾期达此天数且未来潮时提示（验孕/就医建议）
CLINICAL_WINDOW: int = 6            # 临床提示观察窗口（最近 N 条记录，与预测窗口一致）


# ============================================================
# v0.10.0 区间校准参数（早期设计文档；用户授权「修好遗留问题」= F4 置信度校准；
# 只影响预测区间半宽，不影响点预测值）
# ============================================================

# F4 校准（v0.10.0 回测实证，场景套件 9 组 180 步）：
# - 预测误差方差修正：区间 std 乘 sqrt(1 + 1/n_eff)（「预测新观测」的误差方差 =
#   σ² + σ²/n_eff，均值估计不确定度随有效样本量收敛；n_eff < 1 时不放大，冷启动契约不变）
# - 不规律附加展宽：irr=1 时乘 (1 + 本参数/INTERVAL_STD_MULT) —— 近窗 σ 系统性
#   低估长期波动（uniform 场景实测覆盖 0.73 vs 名义 0.87），展宽是诚实性的修复。
# 实测效果：normal_28_4 覆盖 0.77→0.82、irregular 0.73→0.77、聚合 0.92→0.93；
# 规律场景（irr=0、n_eff≥4）区间宽 7.0→7.5 天，覆盖保持 1.00。
INTERVAL_IRREGULAR_EXTRA: float = 0.5   # irr=1 时的附加乘数（天）：mult_eff = 1.5 + irr·0.5


# ============================================================
# v0.13.0 修 F13：model_params 派生缓存自愈的全字段漂移容差
# （predictions/current 与 analysis/fertile-window 共用，见 app/prediction_service.py）
# ============================================================

MODEL_PARAMS_DRIFT_EPS: float = 0.01            # mean/std/ema/prior_mean/prior_std 漂移容差（天）
MODEL_PARAMS_DRIFT_EPS_PRIOR_WEIGHT: float = 0.001  # prior_weight 漂移容差（权重更敏感）

# ============================================================
# v0.13.1 修 G4/G6/G11：全域深审 G 批新参数（会话治理 / 导入上限 / 心跳连接上限）
# G17 时间口径登记：会话有效期一律用 UTC（与 SQLite datetime('now') 同源）；
# 业务日期（period_start/predicted_date 与 date.today() 判过期）用本地时区——
# 本地单机应用，用户的「今天」即业务口径，两者不得混用。
# ============================================================

SESSION_TTL_DAYS: int = 30             # 会话令牌有效期（天）：登录/注册创建的会话过期时间
# 2026-10-26 登录持久化（两端同轮对齐 Android）：「保持登录」开启 ⇒ 会话
# expires_at 写 NULL（永不登出），不再用固定长 TTL——旧 SESSION_TTL_LONG_DAYS
# （365 天）口径废止；「降级」= expires_at 置回此刻 + SESSION_TTL_DAYS。
SESSION_MAX_PER_USER: int = 10         # 每用户并存会话上限（登录时治理：过期清除 + 保留最新 N 个）
MAX_IMPORT_CYCLES: int = 1000          # 导入 cycles 条数上限（防超大导入单事务长持写锁）
# 2026-10-31 修 #35：导出 cycles 上限（取 period_start ASC, id ASC 末尾「最新」N 条）。
# **不变量**：MAX_EXPORT_CYCLES <= MAX_IMPORT_CYCLES——否则导出的备份文件自己会被
# ImportRequest 的条数校验 422 拒收（导出文件必须可回灌）。调整任一侧须同查。
# 注意 /export/preview 是数据预览通道、不截断：>1000 条 cycles 的预览/CSV 导入
# 会被 MAX_IMPORT_CYCLES 422，前端重建轮须提示或截断（见 routes/settings.py 模块头）。
MAX_EXPORT_CYCLES: int = 1000
MAX_IMPORT_PREDICTIONS: int = 2000     # 导入 predictions 条数上限（≥ 导出上限 1000，往返兼容）
# 导入请求体的**原始字节**上限（2026-10-29 对齐 Android PiqConfig.MAX_IMPORT_BYTES，
# 同值同码）：main.py 的 /import 前置闸门在 JSON 解析/pydantic 校验之前按实际请求体
# 字节数判定，严格大于本值即 400 IMPORT_TOO_LARGE。定值依据：合法备份最大
# 形态约 6,834,114 B = 6.52 MiB，实测最大合法备份约 6.5–6.8 MB，8 MiB 留约 23% 余量。
MAX_IMPORT_BYTES: int = 8 * 1024 * 1024
KEEPALIVE_MAX_CONNECTIONS: int = 32    # keepalive SSE 并发连接上限（无鉴权端点的滥用面收敛）


# ============================================================
# v0.14.0 全面审计修复批次参数（H1-H6 / M1-M8 / L1）
# 审计报告条目与参数的对应关系在各自注释中登记；参数值集中在此，
# 业务代码禁止魔法数字。
# ============================================================

# M5：注册端点限流（与 /auth/login 的 _LOGIN_* 同款内存滑动窗口；
# 注册免鉴权且会写 users 表，属可被本地进程刷量写入的入口）。
# 阈值口径说明：早期审计工具**每次运行**都会
# 用同一客户端 IP 注册一次 s7user，且运行前后不会重启后端进程，因此限流状态跨运行
# 累积。阈值必须留足审计重复运行余量：10 分钟内最多 20 次注册失败才锁定，
# 锁定时长 5 分钟（远小于 1 小时计数窗口，正常用户/审计不会撞上）。
REGISTER_MAX_FAILURES: int = 20         # 注册失败（含用户名占用）计数阈值
REGISTER_WINDOW_SECONDS: float = 600.0  # 注册失败计数窗口（秒）：10 分钟
REGISTER_LOCK_SECONDS: float = 300.0    # 触发阈值后的锁定时长（秒）：5 分钟

# H6：未来日期录入上限（允许的时区/跨日边界 + 少量提前录入余量）
MAX_FUTURE_CYCLE_DAYS: int = 0          # period_start 允许超前的天数（0 = 不允许晚于今天）

# L-export：导出 predictions 上限收敛为 config 常量（原为 settings.py 内字面量 1000，
# 与 MAX_IMPORT_PREDICTIONS 的「≥ 导出上限」关系登记在此）
# 2026-10-31 修 #33：截断方向统一为「取最新」——取规范序末尾 N 条（不再取最早），
# 超出部分明示截断（*_total/*_truncated 字段），保证备份留下的是最近的记录。
MAX_EXPORT_PREDICTIONS: int = 1000      # 导出 predictions 上限（取规范序最新 1000 条，超出明示截断）


# ============================================================
# PeriodIQ 导入异常门禁阈值（用户 2026-09-18 冻结契约，G1-G5）
# 唯一实现：app/services/gate.py::evaluate_gate。本表为阈值单一来源。
# 判据不得放宽；JSON 备份/CSV/手动录入三条路径共用 POST /import 前置闸门。
# ============================================================

PRODUCT_NAME: str = "PeriodIQ"          # 产品定名（用户 2026-09-18）；目录名本轮不改

GATE_CYCLE_MIN_DAYS: int = 7            # G1：周期长度下限（天）
GATE_CYCLE_MAX_DAYS: int = 90           # G1：周期长度上限（天）
GATE_PERIOD_MIN_DAYS: int = 2           # G5：单次经期下限（天）
GATE_PERIOD_MAX_DAYS: int = 10          # G5：单次经期上限（天）
GATE_HISTORY_DEVIATION_DAYS: int = 14   # G3：与**本次导入数据自身**中位数偏离阈值（天）；无基线不适用
GATE_GAP_MAX_DAYS: int = 90             # G4：相邻开始日间隔上限（天）；无基线不适用
# 导入门禁命中时的业务错误码
DATA_ANOMALY_CODE: str = "DATA_ANOMALY"

# ============================================================
# 经期每日详情记录（2026-10-26 用户立项；Android 侧同值镜像在
# ~\Android\...\PiqConfig.kt，改动必须两端同轮）
# ============================================================

# 补填窗口：仅「今天 + 昨天」共 DAILY_BACKFILL_WINDOW_DAYS 天（本地时区自然日），
# 更早一律拒绝——失真的数据比没有数据更危险（用户裁定）。
DAILY_BACKFILL_WINDOW_DAYS: int = 2

# 每日详情 JSON 备份条数上限（「导出 ≤ 导入」不变量与 predictions 同款：
# MAX_EXPORT_DAILY_RECORDS <= MAX_IMPORT_DAILY_RECORDS，调整任一侧须同查）
# 2026-10-31 修 #33：截断方向统一为「取最新」——取 record_date 升序末尾 N 条
# （不再取最早），超出部分以 *_total/*_truncated 明示截断。
MAX_EXPORT_DAILY_RECORDS: int = 2000
MAX_IMPORT_DAILY_RECORDS: int = 4000

# 每日日记文本上限（#14：daily_journal.note，按 Unicode 码点计；仅本地存储，绝不导出）。
# 同值用作 DDL CHECK 与 schema/路由校验的单一来源。
DAILY_NOTE_MAX_CHARS: int = 300

# 心情/身体标签（#15：daily_records.mood_tags，存 ID 的 JSON 数组；仅今天+昨天可写，与四件套同窗口）。
# 受控词表分「心情」「身体」两组（分组仅供前端展示，后端只校验并集）；
# Android 同值镜像在 PiqConfig.kt，改动必须两端同轮（并同步 demo 词典）。
MOOD_TAG_IDS_MOOD: tuple[str, ...] = (
    "calm", "happy", "energetic", "steady", "irritable", "anxious", "sad", "sensitive",
)
MOOD_TAG_IDS_BODY: tuple[str, ...] = (
    "cramps", "headache", "bloating", "back_ache", "tender_breasts",
    "fatigue", "nausea", "cravings", "acne", "insomnia",
)
MOOD_TAG_IDS: frozenset[str] = frozenset(MOOD_TAG_IDS_MOOD + MOOD_TAG_IDS_BODY)
MOOD_TAGS_MAX_COUNT: int = 8        # 单日最多 8 个（不允许重复）
MOOD_TAG_ID_MAX_CHARS: int = 24     # 每个 ID 最长 24 字符（格式闸门，先于词表校验）

# 每晚填写提醒：默认 DAILY_NOTIFY_HOUR 点触发（可经设备偏好 reminder_fill_hour 调整）；
# 每天检查，今日 daily_journal 日记未填即提醒，已填当晚免扰（不再要求当天是来潮日）。
DAILY_NOTIFY_HOUR: int = 21
# 开关默认值来源（2026-10-26 归并进 device settings 文件存储的 reminder_daily_fill 键，
# 运行值以文件为准、缺省回落本常量；默认 false 与 Android notify_daily_fill 默认一致）。
DAILY_NOTIFY_ENABLED: bool = False

# daily-records 端点业务错误码（扁平契约；Android 同名镜像）
DAILY_WINDOW_CODE: str = "DAILY_WINDOW"        # 日期超出补填窗口（今天+昨天）
NOT_PERIOD_DAY_CODE: str = "NOT_PERIOD_DAY"    # 该日不是来潮日
INVALID_DAILY_CODE: str = "INVALID_DAILY"      # daily_records 数据结构非法（导入）
# daily-journal 端点：仅当天可写（#14/#16）；过去日只读
JOURNAL_READONLY_CODE: str = "JOURNAL_READONLY"

# ============================================================
# 设备级偏好（2026-10-26 Win 端补齐：主题 + 关闭行为；同日双端对齐改端点）
# 存储为数据目录 desktop_settings.json（与 app.db 同目录；运行时生成物，
# 不是用户数据备份形态）；读写经 GET/PUT /api/v1/device/settings（需登录，
# 2026-10-26 端点改名，与 Android 统一）。
# ⚠ 文件名保持 desktop_settings.json 不改：desktop/window.py 按同名镜像读
# （close_action 关闭分流）、native_host.cs 按键名定位——两端不在本轮白名单，
# 改名即断链；文件名与端点名解耦是刻意的。
# ============================================================

DESKTOP_SETTINGS_FILENAME: str = "desktop_settings.json"  # 文件名单一来源（见上方 ⚠）
DESKTOP_THEMES: tuple[str, ...] = ("light", "dark", "system")      # theme 合法值（Android PiqConfig.DEVICE_THEMES 同值）
DESKTOP_THEME_DEFAULT: str = "system"                              # theme 默认（Android 同值）
DESKTOP_CLOSE_ACTIONS: tuple[str, ...] = ("ask", "exit", "tray")   # close_action 合法值（Win 平台键）
DESKTOP_CLOSE_ACTION_DEFAULT: str = "ask"                          # close_action 默认（Win 平台键）

# ============================================================
# 经期提醒三件套（2026-10-26 Win 端镜像 Android 设计，语义单一来源
# ~\Android\...\PiqReminderPlan.kt；提醒服务 services/reminder.py 消费）：
# 每天 REMINDER_TRIGGER_HOUR 点对已登录用户判定「提前 N 天 / 当天 / 逾期 +1 / +3」
# 四条腿（每晚填写见 DAILY_NOTIFY_HOUR）。
# ============================================================

REMINDER_TRIGGER_HOUR: int = 9                    # 三件套默认触发点（可经设备偏好 reminder_trio_hour 调整；PiqReminderPlan.TRIGGER_HOUR_OF_DAY 同值）
REMINDER_HOUR_MIN: int = 0                        # 提醒触发整点合法下界（含；reminder_trio_hour/reminder_fill_hour 共用）
REMINDER_HOUR_MAX: int = 23                       # 提醒触发整点合法上界（含）
REMINDER_VALID_DAYS: tuple[int, ...] = (1, 2, 3, 5, 7)   # 提前量合法值（PiqReminderPlan.VALID_DAYS 同值）
REMINDER_DAYS_DEFAULT: int = 3                    # 提前量默认（PiqReminderPlan.DEFAULT_DAYS 同值）
REMINDER_OVERDUE_DAY_OFFSETS: tuple[int, ...] = (1, 3)   # 逾期腿：预测日 +1/+3 各一次（PiqReminderPlan.OVERDUE_DAY_OFFSETS 同值）

# 五个提醒开关默认——**对齐 Android**（PiqSettings.NOTIFY_DEFAULTS 同值，
# 2026-10-26 用户裁定：Win 原先没有这组键，跟随 Android 而非自造；五个开关出厂全关，
# 每晚填写开关默认值见 DAILY_NOTIFY_ENABLED）。
REMINDER_MASTER_DEFAULT: bool = False             # 总开关默认关（Android KEY_NOTIFY_ENABLED 默认 "false"）
REMINDER_ADVANCE_DEFAULT: bool = False            # 提前腿默认关（Android KEY_NOTIFY_ADVANCE 默认 "false"）
REMINDER_ON_DAY_DEFAULT: bool = False             # 当天腿默认关（Android KEY_NOTIFY_ON_DAY 默认 "false"）
REMINDER_OVERDUE_DEFAULT: bool = False            # 逾期腿默认关（Android KEY_NOTIFY_OVERDUE 默认 "false"）
