"""地理计算：经纬度距离、点到线段投影、轨迹匹配。

为避免引入第三方依赖，在局部范围内采用「等距圆柱投影」把经纬度换算为米：
  x = R * cos(lat0) * Δlon(rad)
  y = R * Δlat(rad)
在几十公里内的赛事尺度上误差可忽略（远小于 GPS 漂移本身）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_R = 6_371_000.0  # 地球平均半径（米）


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """两点大圆距离（米）。"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


@dataclass
class XY:
    x: float
    y: float


def to_xy(lat: float, lon: float, lat0: float, lon0: float) -> XY:
    """经纬度 -> 以 (lat0, lon0) 为原点的局部平面坐标（米）。"""
    return XY(
        x=EARTH_R * math.radians(lon - lon0) * math.cos(math.radians(lat0)),
        y=EARTH_R * math.radians(lat - lat0),
    )


@dataclass
class Projection:
    """点到折线某一段的投影结果。

    t      —— 投影在线段上的比例 [0,1]
    dist   —— 点到线段最短距离（米）
    seg    —— 段索引
    along  —— 沿赛道方向距该段起点的距离（米）
    point  —— 投影点（局部坐标）
    """

    t: float
    dist: float
    seg: int
    along: float
    point: XY


def project_onto_segment(px: float, py: float, ax: float, ay: float,
                         bx: float, by: float) -> tuple[float, float, XY]:
    """返回 (t, dist, 投影点)。"""
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return 0.0, math.hypot(px - ax, py - ay), XY(ax, ay)
    t = ((px - ax) * dx + (py - ay) * dy) / length2
    t = max(0.0, min(1.0, t))
    qx, qy = ax + t * dx, ay + t * dy
    return t, math.hypot(px - qx, py - qy), XY(qx, qy)
