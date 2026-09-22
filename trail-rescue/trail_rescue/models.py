"""领域模型：赛道、危险路段、检查点、救护点、选手、告警与派单。"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field, asdict
from typing import Optional

from .geo import XY, Projection, haversine, project_onto_segment, to_xy

# ---------------------------------------------------------------- 赛道元素


@dataclass
class RoutePoint:
    lat: float
    lon: float
    ele: float = 0.0  # 海拔（米）


@dataclass
class PaceBand:
    """某赛道区间的合理配速带（分钟/公里），用于配速异常检测。"""
    start_km: float
    end_km: float
    min_pace: float   # 过快阈值：低于该配速视为冲太快/异常
    max_pace: float   # 过慢阈值：高于该配速视为明显掉队


@dataclass
class DangerZone:
    """危险路段：赛道折线 [start_idx, end_idx] 对应的区段 + 横向缓冲半径。"""
    id: str
    name: str
    start_idx: int
    end_idx: int
    buffer_m: float = 120.0
    severity: str = "warning"   # warning | critical（critical 直接高级告警）
    note: str = ""

    def contains_projection(self, seg: int) -> bool:
        return self.start_idx <= seg <= self.end_idx - 1


@dataclass
class Checkpoint:
    """检录点（打卡点）。"""
    id: str
    name: str
    route_idx: int
    km: float
    cutoff: Optional[float] = None  # 关门时间（出发后秒），None 表示不关门


@dataclass
class AidStation:
    """救护点。"""
    id: str
    name: str
    lat: float
    lon: float
    capabilities: list[str] = field(default_factory=list)  # AED / 担架 / 救护车 / 通信
    response_min: int = 15        # 预计响应时间（分钟），用于派单参考
    status: str = "open"          # open | closed | busy


# ---------------------------------------------------------------- 动态事件


@dataclass
class TrackPoint:
    ts: float
    lat: float
    lon: float
    ele: float = 0.0
    speed_ms: float = 0.0  # 设备自报瞬时速度（米/秒），0 表示未知


@dataclass
class Checkin:
    checkpoint_id: str
    ts: float
    name: str = ""
    km: float = 0.0
    split_pace: float = 0.0  # 本段平均配速（分/公里），0 表示无


@dataclass
class Dispatch:
    station_id: str
    station_name: str
    distance_m: float
    eta_sec: float
    capability: str = ""      # 携带的关键能力，如 AED
    ts: float = 0.0           # 当前派单时间（改派后会变）
    first_ts: float = 0.0     # 该选手本轮事件首次呼叫时间（用于超时判断）
    ack_ts: float = 0.0
    onscene_ts: float = 0.0


@dataclass
class Alert:
    id: int
    type: str                 # danger_zone / stationary / pace_slow / pace_fast /
    #                         # off_course / missed_cp / late_cp / stale_gps / no_start
    level: str                # warning | critical
    bib: str
    ts: float
    title: str
    detail: str = ""
    lat: float = 0.0
    lon: float = 0.0
    zone_id: str = ""
    status: str = "open"      # open -> dispatched -> acked -> onscene -> resolved
    #                                            └ 超时升级为 critical
    dispatch: Optional[Dispatch] = None
    escalated: bool = False
    escalate_ts: float = 0.0
    resolve_ts: float = 0.0
    resolution: str = ""
    dispatch_owner: int = 0   # >0 表示派单合并自该告警（从属单，不独立升级）

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


# ---------------------------------------------------------------- 选手


@dataclass
class Rider:
    bib: str
    name: str
    category: str = "50K"
    start_ts: float = 0.0
    status: str = "registered"   # registered | oncourse | finished | dnf | dns
    track: list[TrackPoint] = field(default_factory=list)
    checkins: list[Checkin] = field(default_factory=list)

    # 赛道匹配结果（每次 ingest 更新）
    seg: int = -1
    t: float = 0.0
    distance_km: float = 0.0     # 累计赛道里程
    lateral_m: float = 0.0       # 偏离赛道距离
    elev: float = 0.0
    in_zone: str = ""

    # 运动分析
    last_move_ts: float = 0.0
    last_move_km: float = 0.0
    cur_pace: float = 0.0        # 最近窗口配速（分/公里）
    last_cp_idx: int = -1

    @property
    def last_point(self) -> Optional[TrackPoint]:
        return self.track[-1] if self.track else None


# ---------------------------------------------------------------- 赛道


class Course:
    """由有序路点构成的赛道折线，提供里程、投影、危险路段匹配。"""

    def __init__(self, points: list[RoutePoint],
                 danger_zones: Optional[list[DangerZone]] = None,
                 checkpoints: Optional[list[Checkpoint]] = None,
                 pace_bands: Optional[list[PaceBand]] = None):
        self.points = points
        self.danger_zones = danger_zones or []
        self.checkpoints = checkpoints or []
        self.pace_bands = pace_bands or []

        self.lat0 = points[0].lat
        self.lon0 = points[0].lon
        self.xy: list[XY] = [to_xy(p.lat, p.lon, self.lat0, self.lon0)
                             for p in points]
        self.seg_len: list[float] = []
        self.cum: list[float] = [0.0]
        for a, b in zip(self.xy, self.xy[1:]):
            length = math_hypot(b.x - a.x, b.y - a.y)
            self.seg_len.append(length)
            self.cum.append(self.cum[-1] + length)
        self.total_m = self.cum[-1]

    # ---- 投影
    def project(self, lat: float, lon: float) -> Projection:
        p = to_xy(lat, lon, self.lat0, self.lon0)
        best: Optional[Projection] = None
        for i, (a, b) in enumerate(zip(self.xy, self.xy[1:])):
            t, dist, q = project_onto_segment(p.x, p.y, a.x, a.y, b.x, b.y)
            if best is None or dist < best.dist:
                best = Projection(t=t, dist=dist, seg=i,
                                  along=t * self.seg_len[i], point=q)
        assert best is not None
        return best

    def distance_along(self, proj: Projection) -> float:
        """沿赛道累计里程（米）。"""
        return self.cum[proj.seg] + proj.along

    def position_at(self, seg: int, t: float) -> tuple[float, float, float]:
        """段内插值，返回 (lat, lon, ele)。"""
        a, b = self.points[seg], self.points[seg + 1]
        return (
            a.lat + (b.lat - a.lat) * t,
            a.lon + (b.lon - a.lon) * t,
            a.ele + (b.ele - a.ele) * t,
        )

    def xy_at(self, seg: int, t: float) -> XY:
        a, b = self.xy[seg], self.xy[seg + 1]
        return XY(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)

    # ---- 危险路段
    def zone_at(self, proj: Projection, lateral_m: float) -> Optional[DangerZone]:
        """选手若处在某危险路段的缓冲带内，返回该路段。"""
        for z in self.danger_zones:
            if z.contains_projection(proj.seg) and lateral_m <= z.buffer_m:
                return z
        return None

    def zones_overlapping_segment(self, seg: int) -> list[DangerZone]:
        return [z for z in self.danger_zones if z.contains_projection(seg)]

    # ---- 配速带
    def pace_band_at(self, km: float) -> Optional[PaceBand]:
        for band in self.pace_bands:
            if band.start_km <= km < band.end_km:
                return band
        return self.pace_bands[-1] if self.pace_bands else None

    def haversine_to(self, lat: float, lon: float, seg: int, t: float) -> float:
        rlat, rlon, _ = self.position_at(seg, t)
        return haversine(lat, lon, rlat, rlon)


def math_hypot(dx: float, dy: float) -> float:
    return (dx * dx + dy * dy) ** 0.5
