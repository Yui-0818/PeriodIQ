"""PeriodIQ 导入异常门禁（R2-A 冻结契约，纯函数）。

门禁判据 G1-G5 单一来源，同时覆盖 JSON 备份 / CSV / 手动录入三条导入路径
（唯一写路径 POST /api/v1/import 的前置闸门）。

判据（用户 2026-09-18 冻结，不得放宽）：
  G1  cycle_length < 7 或 > 90 天
  G2  任一日期晚于今天
  G3  与**本次导入数据自身**的周期长度中位数偏离 > 14 天
  G4  相邻开始日间隔 > 90 天
  G5  单次经期 < 2 天或 > 10 天

基线语义（2026-10-31 修 #32，判据不变、只换基线来源）：
  导入是**全量替换**（清空重建），G3/G4 的基线必须来自**待导入数据自身**，
  不得再读库内旧 cycles——否则「合法异地备份 / 周期整体变化」（如从 28 天变
  45 天）会被旧库中位数误判为 DATA_ANOMALY。基线取值口径与 evaluate_gate
  内部完全一致（单一实现 [_effective_cycle_length]）：
  provided cycle_length 优先，否则按**日历序**相邻开始日派生；只收
  [GATE_CYCLE_MIN_DAYS, GATE_CYCLE_MAX_DAYS] 内的有限值（与库内
  get_all_valid_cycle_lengths 的合法长度同口径）。派生入口
  [import_baseline_lengths] 供路由层调用。
  无基线（空列表/None）时 G3/G4 一律不适用——不得误报。

本模块只判定与报告，不修改任何数据；allow_anomalies=true 时由调用方放行。
"""

from __future__ import annotations

import math
import statistics
from datetime import date
from typing import Any

from app import config

# 门禁码 → 展示用「常见范围」文案（就医指南卡第①条的数据来源）
_EXPECTED_TEXT = {
    "G1": f"{config.GATE_CYCLE_MIN_DAYS}–{config.GATE_CYCLE_MAX_DAYS} 天",
    "G2": "不晚于今天",
    "G3": f"偏离中位数不超过 {config.GATE_HISTORY_DEVIATION_DAYS} 天",
    "G4": f"相邻开始日间隔不超过 {config.GATE_GAP_MAX_DAYS} 天",
    "G5": f"{config.GATE_PERIOD_MIN_DAYS}–{config.GATE_PERIOD_MAX_DAYS} 天",
}

_FIELD_TEXT = {
    "G1": "cycle_length",
    "G2": "date",
    "G3": "cycle_length",
    "G4": "period_start_gap",
    "G5": "period_days",
}


def _parse_date(value: Any) -> date | None:
    """宽松解析 ISO 日期；解析失败返回 None（结构性非法由既有导入校验拦截）。"""
    if isinstance(value, date) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _as_number(value: Any) -> float | None:
    """取有限数值；bool/非数值/非有限（NaN、Infinity、超 float 范围整数）返回 None。

    2026-10-31 修 #24：旧实现直接 float(value)，period_days=10**400 抛 OverflowError
    → 导入 500。门禁只判定与报告，非有限值按「无值」处理（不产生 G1/G5 命中）；
    导入入口按字段口径处理：cycle_length/已知模型数值键非法 → 400 INVALID_IMPORT，
    period_days 非 int 按既有 strictInt 口径视为无值。
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            number = float(value)
        except OverflowError:
            return None
        return number if math.isfinite(number) else None
    return None


def _anomaly(
    code: str,
    value: Any,
    message: str,
    field: str | None = None,
) -> dict:
    return {
        "code": code,
        "field": field or _FIELD_TEXT[code],
        "value": value,
        "expected": _EXPECTED_TEXT[code],
        "message": message,
    }


def _build_entries(
    cycles: list[dict],
) -> list[tuple[int, dict | Any, date | None, date | None]]:
    """把待导入 cycles 逐条解析成 (输入序 idx, 原始项, 开始日, 结束日)。

    非 dict 项与非法日期不在这里报错（结构性非法由既有导入校验拦截），
    只把日期置 None——门禁只判定与报告。
    """
    entries: list[tuple[int, dict | Any, date | None, date | None]] = []
    for idx, c in enumerate(cycles):
        if not isinstance(c, dict):
            entries.append((idx, c, None, None))
            continue
        entries.append((idx, c, _parse_date(c.get("period_start")), _parse_date(c.get("period_end"))))
    return entries


def _derive_calendar(
    entries: list[tuple[int, dict | Any, date | None, date | None]],
) -> tuple[
    list[tuple[int, dict, date, date | None]],
    dict[int, float],
    dict[int, tuple[int, date]],
]:
    """按**日历序**派生周期长度与相邻开始日间隔（门禁与基线共用的单一实现）。

    返回 (chrono, derived_cl, chrono_gap)：
    - chrono：有合法开始日的 dict 项按开始日升序（同日保持输入序，稳定排序）；
    - derived_cl：输入序 idx → 与**时间上前一条**开始日的间隔（第一条无值）；
    - chrono_gap：输入序 idx → (间隔天数, 前一条开始日)，供 G4 报告。

    为什么必须按日历序：导入顺序任意（备份/CSV/手改），按列表下标做差会把
    行序当时间序，派生值与 G4 间隔双双失真。
    """
    chrono = sorted(
        [(i, c, s, e) for i, c, s, e in entries if isinstance(c, dict) and s is not None],
        key=lambda t: t[2],  # type: ignore[index]
    )
    derived_cl: dict[int, float] = {}
    chrono_gap: dict[int, tuple[int, date]] = {}
    for k in range(1, len(chrono)):
        _, _, s_prev, _ = chrono[k - 1]
        i_cur, _, s_cur, _ = chrono[k]
        gap = (s_cur - s_prev).days
        derived_cl[i_cur] = float(gap)
        chrono_gap[i_cur] = (gap, s_prev)
    return chrono, derived_cl, chrono_gap


def _effective_cycle_length(
    cycle: dict, orig_idx: int, derived_cl: dict[int, float]
) -> float | None:
    """单条记录的**生效周期长度**：provided cycle_length 优先，否则按日历序派生。

    这是门禁 G1/G3 与导入基线 [import_baseline_lengths] 的**唯一**取值口径
    （修 #32 要求基线取值与 evaluate_gate 内部一致，禁止在基线函数里重写）。
    provided 非有限/非数值（字符串、NaN、Infinity、超 float 范围整数）按「无值」处理。
    """
    provided_cl = _as_number(cycle.get("cycle_length"))
    return provided_cl if provided_cl is not None else derived_cl.get(orig_idx)


def import_baseline_lengths(cycles: list[dict]) -> list[float]:
    """修 #32：由**待导入数据自身**派生 G3/G4 基线（合法周期长度列表；按日历序派生、按输入序返回）。

    口径与 evaluate_gate 内部完全一致（共用 [_build_entries] / [_derive_calendar] /
    [_effective_cycle_length]）：provided cycle_length 优先，否则按日历序相邻开始日
    派生；只保留 [GATE_CYCLE_MIN_DAYS, GATE_CYCLE_MAX_DAYS] 内的**有限**值
    （与库内 get_all_valid_cycle_lengths 的合法长度同口径：越界值落库时本就置 NULL，
    不得参与中位数）。
    空列表 ⇒ 路由层传空基线 ⇒ G3/G4 不适用（单条记录没有中位数也无可比间隔）。
    纯函数：不读库、不碰时钟、不修改入参——可在 %TEMP% 脚本逐值验证。
    """
    entries = _build_entries(cycles)
    _, derived_cl, _ = _derive_calendar(entries)
    lengths: list[float] = []
    for idx, c, _start, _end in entries:
        if not isinstance(c, dict):
            continue
        cycle_length = _effective_cycle_length(c, idx, derived_cl)
        if cycle_length is None or not math.isfinite(cycle_length):
            continue
        if config.GATE_CYCLE_MIN_DAYS <= cycle_length <= config.GATE_CYCLE_MAX_DAYS:
            lengths.append(float(cycle_length))
    return lengths


def evaluate_gate(
    cycles: list[dict],
    baseline_cycle_lengths: list[float] | None,
    today: date,
) -> list[dict]:
    """评估导入周期数据的异常门禁 G1-G5。

    Args:
        cycles: 待导入周期列表；每项至少尝试读 period_start / period_end /
            cycle_length / period_days（缺失时按**时间升序相邻开始日**派生周期长度
            ——导入顺序任意（备份/CSV/手改），不得按列表下标直接做差；
            同日开始日按稳定排序保留输入序）。
        baseline_cycle_lengths: G3/G4 的基线——**待导入数据自身**的合法周期长度，
            修 #32 后由 [import_baseline_lengths] 派生（历史上曾传库内
            get_all_valid_cycle_lengths，已废止）。None 或空列表表示无基线 →
            G3/G4 不适用。
        today: 业务口径「今天」（本地时区，与 date.today() 同源）。

    Returns:
        异常项列表，每项含 code/field/value/expected/message；
        无命中时为空列表。顺序：按 cycles 输入序，同一记录内 G1→G5。
    """
    anomalies: list[dict] = []
    baseline = (
        [float(x) for x in baseline_cycle_lengths]
        if baseline_cycle_lengths
        else []
    )
    baseline_median = statistics.median(baseline) if baseline else None
    has_baseline = baseline_median is not None

    entries = _build_entries(cycles)
    _chrono, derived_cl, chrono_gap = _derive_calendar(entries)

    for idx, c, start, end in entries:
        if not isinstance(c, dict):
            continue
        provided_pd = _as_number(c.get("period_days"))
        cycle_length = _effective_cycle_length(c, idx, derived_cl)
        if provided_pd is not None:
            period_days = provided_pd
        elif start is not None and end is not None:
            period_days = float((end - start).days + 1)
        else:
            period_days = None

        label_start = start.isoformat() if start else f"#{idx + 1}"

        # ---- G1: cycle_length 越界 ----
        if cycle_length is not None:
            if (
                cycle_length < config.GATE_CYCLE_MIN_DAYS
                or cycle_length > config.GATE_CYCLE_MAX_DAYS
            ):
                anomalies.append(_anomaly(
                    "G1",
                    cycle_length,
                    f"记录 {label_start} 的周期长度 {cycle_length:.0f} 天超出常见范围"
                    f"（{config.GATE_CYCLE_MIN_DAYS}–{config.GATE_CYCLE_MAX_DAYS} 天）",
                    field="cycle_length",
                ))

        # ---- G2: 任一日期晚于今天 ----
        for date_label, d in (("开始日期", start), ("结束日期", end)):
            if d is not None and d > today:
                anomalies.append(_anomaly(
                    "G2",
                    d.isoformat(),
                    f"记录 {label_start} 的{date_label} {d.isoformat()} 晚于今天（{today.isoformat()}）",
                    field="period_start" if date_label == "开始日期" else "period_end",
                ))

        # ---- G3: 与本次导入数据自身中位数偏离 ----（无基线不适用）
        # 修 #32：文案改为真实口径（两端逐字一致）——基线是「本次导入数据的中位数」，
        # 不是「库内历史中位数」。
        if has_baseline and cycle_length is not None:
            deviation = abs(cycle_length - float(baseline_median))
            if deviation > config.GATE_HISTORY_DEVIATION_DAYS:
                anomalies.append(_anomaly(
                    "G3",
                    cycle_length,
                    f"记录 {label_start} 的周期长度 {cycle_length:.0f} 天与本次导入数据的中位数"
                    f" {float(baseline_median):.1f} 天偏离 {deviation:.1f} 天"
                    f"（阈值 {config.GATE_HISTORY_DEVIATION_DAYS} 天）",
                    field="cycle_length",
                ))

        # ---- G4: 相邻开始日间隔（时间序）----（无基线不适用）
        if has_baseline and idx in chrono_gap:
            gap, prev_start = chrono_gap[idx]
            if gap > config.GATE_GAP_MAX_DAYS:
                anomalies.append(_anomaly(
                    "G4",
                    gap,
                    f"记录 {label_start} 与上一条开始日 {prev_start.isoformat()} 间隔 {gap} 天"
                    f"（阈值 {config.GATE_GAP_MAX_DAYS} 天）",
                    field="period_start_gap",
                ))

        # ---- G5: 经期天数越界 ----
        if period_days is not None:
            if (
                period_days < config.GATE_PERIOD_MIN_DAYS
                or period_days > config.GATE_PERIOD_MAX_DAYS
            ):
                anomalies.append(_anomaly(
                    "G5",
                    period_days,
                    f"记录 {label_start} 的经期时长 {period_days:.0f} 天超出常见范围"
                    f"（{config.GATE_PERIOD_MIN_DAYS}–{config.GATE_PERIOD_MAX_DAYS} 天）",
                    field="period_days",
                ))

    return anomalies
