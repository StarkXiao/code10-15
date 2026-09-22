"""运动学分析：配速、停滞、异常速度。"""

from __future__ import annotations

from dataclasses import dataclass

# 判定参数（可按赛事调整）
STATIONARY_SPEED_MS = 0.55      # 低于该速度视为「几乎不动」（约 18 分/公里）
STATIONARY_SECONDS = 180        # 持续秒数达到该值判定停滞
SPEED_SPIKE_MS = 8.3            # 瞬时速度超过该值（约 3:20/公里）视为异常跳点
SPEED_SPIKE_PACE = 2.0          # 窗口配速快于该值（分/公里）视为配速异常
PACE_WINDOW_SEC = 240           # 配速滑动窗口（秒）
MIN_MOVE_SAMPLES = 2            # 配速窗口内最少有效样本数


@dataclass
class Motion:
    pace_min_per_km: float   # 最近窗口配速（分/公里），0 表示无法计算
    stationary_for: float    # 已持续低速的秒数
    speed_spike: bool        # 瞬时速度异常
    pace_fast: bool          # 配速过快
    pace_slow: bool          # 配速过慢（需结合赛道配速带，由引擎判定）


def ms_to_pace(v_ms: float) -> float:
    """米/秒 -> 分/公里。"""
    if v_ms <= 0:
        return 0.0
    return 1000.0 / v_ms / 60.0


def analyze(track_ts: list[float], track_km: list[float],
            instant_speed_ms: float, now: float,
            last_move_ts: float, last_move_km: float) -> Motion:
    """根据轨迹历史计算运动状态。

    track_ts / track_km : 等长的历史轨迹（时间, 累计赛道里程）
    last_move_ts/_km    : 引擎维护的「最后一次有效移动」锚点
    """
    # ---- 1. 滑动窗口配速：窗口内沿赛道位移 / 时间
    win_start = now - PACE_WINDOW_SEC
    win_idx = 0
    for i, ts in enumerate(track_ts):
        if ts >= win_start:
            win_idx = i
            break
    else:
        win_idx = len(track_ts) - 1

    pace = 0.0
    if len(track_ts) - win_idx >= MIN_MOVE_SAMPLES:
        dt = track_ts[-1] - track_ts[win_idx]
        dkm = track_km[-1] - track_km[win_idx]
        if dt > 0 and dkm > 0:
            pace = (dt / 60.0) / dkm   # 分/公里

    # ---- 2. 停滞：基于「最后有效移动锚点」
    stationary_for = 0.0
    if last_move_ts > 0:
        # 若窗口内有可观位移，调用方会推进锚点；这里只算静止持续时长
        stationary_for = max(0.0, now - last_move_ts)

    # ---- 3. 异常跳点
    speed_spike = instant_speed_ms > SPEED_SPIKE_MS
    pace_fast = 0 < pace < SPEED_SPIKE_PACE

    return Motion(
        pace_min_per_km=pace,
        stationary_for=stationary_for,
        speed_spike=speed_spike,
        pace_fast=pace_fast,
        pace_slow=False,
    )
