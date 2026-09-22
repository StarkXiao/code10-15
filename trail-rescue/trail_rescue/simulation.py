"""赛事仿真：构造一条高海拔越野赛道与 5 名选手的剧本化数据。

剧本：
  101 张岚 —— 正常完赛
  102 李彻 —— 进入「落石峡谷」危险路段，自动派单后自行走出
  103 王屿 —— 在「断崖刃脊」critical 危险路段受伤停滞 5 分钟，
              首派救护点确认超时 -> 升级 critical 并呼叫备援点（带 AED）
  104 赵菁 —— 配速异常偏慢（疑似抽筋/失温）
  105 周沐 —— 偏离赛道 + 漏打卡 CP3（设备故障）
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .engine import Engine, Event
from .geo import EARTH_R
from .models import (AidStation, Checkpoint, Course, DangerZone, PaceBand,
                     Rider, RoutePoint)

LAT0, LON0 = 31.1000, 103.3000
_M_PER_DEG_LAT = EARTH_R * math.radians(1)
_M_PER_DEG_LON = EARTH_R * math.radians(1) * math.cos(math.radians(LAT0))


def xy_to_latlon(x: float, y: float) -> tuple[float, float]:
    return (LAT0 + y / _M_PER_DEG_LAT, LON0 + x / _M_PER_DEG_LON)


# (东向米, 北向米, 海拔米) —— 约 8 公里、累计爬升约 1100 米的环形山地赛道
_XY_POINTS: list[tuple[float, float, float]] = [
    (0, 0, 2400),        # 0  起点/终点
    (250, 150, 2440),    # 1
    (520, 280, 2500),    # 2
    (700, 500, 2560),    # 3  CP2 峡谷入口
    (850, 780, 2620),    # 4  ┐ 危险路段 Z1
    (980, 1050, 2680),   # 5  │ 落石峡谷
    (1150, 1300, 2760),  # 6  │
    (1400, 1500, 2820),  # 7  ┘
    (1650, 1650, 2900),  # 8  （救护点 AS2 旁）
    (1850, 1900, 3050),  # 9  CP3 鹰嘴岩
    (2000, 2200, 3150),  # 10
    (2200, 2450, 3250),  # 11
    (2150, 2750, 3350),  # 12
    (2050, 3050, 3450),  # 13 垭口（AS3 旁）
    (2250, 3350, 3400),  # 14
    (2500, 3600, 3300),  # 15
    (2600, 3900, 3200),  # 16 CP4 乱石岗 ┐ 危险路段 Z2
    (2750, 4150, 3100),  # 17           │
    (3000, 4350, 3000),  # 18           │ 断崖刃脊（critical）
    (3150, 4650, 2900),  # 19           │
    (3050, 4950, 2850),  # 20          ┘ （AS4 旁）
    (3150, 5250, 2800),  # 21 CP5 海子边
    (3400, 5450, 2750),  # 22
    (3550, 5750, 2700),  # 23
    (3450, 6050, 2650),  # 24
    (3200, 6300, 2600),  # 25
    (3250, 6600, 2500),  # 26
    (3350, 6900, 2400),  # 27 终点
]

# 检查点所在路点索引（CP1 起终点 / CP2..CP6）
_CP_INDICES = [0, 3, 9, 16, 21, 27]
_CP_NAMES = ["起点大本营", "峡谷入口", "鹰嘴岩", "乱石岗", "海子边", "终点"]
_CP_CUTOFFS = [None, 1800, 3600, 5700, 7200, 9000]

# (东向米, 北向米)
_STATIONS: list[tuple[str, str, float, float, list[str], int]] = [
    ("AS1", "大本营救护点", -150, 60,
     ["AED", "担架", "救护车", "通信"], 10),
    ("AS2", "鹰嘴岩救护点", 1600, 1720,
     ["AED", "担架", "通信"], 15),
    ("AS3", "垭口救护点", 2690, 3840,
     ["担架", "通信"], 20),          # 无 AED，用于演示升级备援
    ("AS4", "海子边救护点", 2980, 4960,
     ["AED", "担架", "通信"], 15),
    ("AS5", "终点收容站", 3220, 6980,
     ["AED", "担架", "救护车", "通信"], 10),
]


def build_course() -> Course:
    pts = []
    for x, y, ele in _XY_POINTS:
        lat, lon = xy_to_latlon(x, y)
        pts.append(RoutePoint(lat=lat, lon=lon, ele=ele))

    danger = [
        DangerZone("Z1", "落石峡谷", start_idx=4, end_idx=7,
                   buffer_m=100, severity="warning",
                   note="窄路临崖、午后有落石风险"),
        DangerZone("Z2", "断崖刃脊", start_idx=16, end_idx=20,
                   buffer_m=100, severity="critical",
                   note="单侧断崖伴横风，禁止偏离赛道绕行"),
    ]

    checkpoints: list[Checkpoint] = []
    # 先建赛道拿真实累计里程
    tmp = Course(pts)
    for i, (idx, name, cutoff) in enumerate(
            zip(_CP_INDICES, _CP_NAMES, _CP_CUTOFFS)):
        checkpoints.append(Checkpoint(
            id=f"CP{i + 1}", name=name, route_idx=idx,
            km=tmp.cum[idx] / 1000.0, cutoff=cutoff))

    bands = [
        PaceBand(0.0, 2.0, 4.5, 12.0),
        PaceBand(2.0, 4.5, 5.5, 14.0),
        PaceBand(4.5, 7.0, 5.0, 13.0),
        PaceBand(7.0, 99.0, 4.5, 12.0),
    ]
    return Course(pts, danger_zones=danger, checkpoints=checkpoints,
                  pace_bands=bands)


def build_stations() -> list[AidStation]:
    stations = []
    for sid, name, x, y, caps, resp in _STATIONS:
        lat, lon = xy_to_latlon(x, y)
        stations.append(AidStation(id=sid, name=name, lat=lat, lon=lon,
                                   capabilities=caps, response_min=resp))
    return stations


def build_riders() -> list[Rider]:
    return [
        Rider("101", "张岚", category="30K"),
        Rider("102", "李彻", category="30K"),
        Rider("103", "王屿", category="30K"),
        Rider("104", "赵菁", category="30K"),
        Rider("105", "周沐", category="30K"),
    ]


# ---------------------------------------------------------------- 剧本

@dataclass
class _Plan:
    speed: float                      # 正常行进速度（米/秒）
    slow: tuple[float, float, float] | None = None  # 减速区间 (起, 止, 速度)
    stop: tuple[float, float] | None = None      # 停滞区间 (起, 止)（仿真秒）
    lateral: tuple[float, float, float] | None = None  # 偏航 (起, 止, 横向米)
    skip_cp: set[str] = field(default_factory=set)


_PLANS = {
    "101": _Plan(speed=2.30),                       # 约 7.2 分/公里
    "102": _Plan(speed=2.50,
                 slow=(420, 780, 0.90)),            # 进落石峡谷后减速
                                                   # -> 危险路段内异常，自动派单
    "103": _Plan(speed=2.30, stop=(2200, 2520)),    # Z2 内停滞 320 秒
    "104": _Plan(speed=1.00),                       # 16.7 分/公里 -> 配速过慢
    "105": _Plan(speed=2.40,
                 lateral=(900, 1100, 260),          # 偏出赛道 260 米
                 skip_cp={"CP3"}),                  # 漏打卡鹰嘴岩
}

# 告警处置剧本（相对告警生成秒）：[(动作, 延迟秒, 参数)]
# 102 减速后进落石峡谷：首个 pace_slow 无人接单（首派 AS1 超时升级 AS2），
# 由升级后的 AS2 完成处置
_LIFECYCLE = {
    ("104", "pace_slow"): [
        ("ack", 60, ""), ("onscene", 240, ""),
        ("resolve", 390, "轻微抽筋，补给与拉伸后持续观察")],
    ("105", "off_course"): [
        ("ack", 60, ""), ("onscene", 260, ""),
        ("resolve", 460, "引导返回赛道")],
    ("105", "missed_cp"): [
        ("ack", 120, ""), ("onscene", 420, ""),
        ("resolve", 660, "定位设备故障漏打卡，轨迹有效，补录成绩")],
}
# 103 王屿：首派无 AED 的垭口救护点 5 分钟未确认 -> 升级改派海子边救护点
# （带 AED），备援接单后到场，停滞告警并入同一处置
_ESCALATE_LIFECYCLE = {
    ("102", "pace_slow"): [
        ("ack", 90, ""), ("onscene", 300, ""),
        ("resolve", 480, "减速观察后恢复，选手自行走出峡谷")],
    ("103", "danger_zone"): [
        ("ack", 100, ""), ("onscene", 340, ""),
        ("resolve", 560, "踝关节扭伤，固定后担架下撤")],
    ("104", "danger_zone"): [
        ("ack", 120, ""), ("onscene", 420, ""),
        ("resolve", 700, "失温前兆，强制收容下撤")],
}

TICK_SEC = 15


class SimRunner:
    """时钟可由外部推进的仿真器：headless 直接跑完，Web 模式按倍速推进。"""

    def __init__(self, log: bool = True):
        self.course = build_course()
        self.stations = build_stations()
        self.riders = build_riders()
        self.sim_time = 0.0
        self.end_time = 3800.0
        self.engine = Engine(self.course, self.riders, self.stations,
                             start_ts=0.0, now_fn=lambda: self.sim_time)
        self._dist: dict[str, float] = {r.bib: 0.0 for r in self.riders}
        self._next_cp: dict[str, int] = {r.bib: 0 for r in self.riders}
        self._actions: list[tuple[float, callable]] = []
        self.events_log: list[Event] = []
        self._log = log
        self._wire_lifecycle()
        # 开赛打卡 CP1
        for r in self.riders:
            r.start_ts = 0.0
            self.engine.ingest_checkin(r.bib, "CP1", 0.0)

    # ---- 处置剧本调度
    def _wire_lifecycle(self) -> None:
        def on_event(ev: Event):
            self.events_log.append(ev)
            if self._log:
                self._print(ev)
            if ev.kind == "alert_new":
                a = ev.data["alert"]
                key = (a["bib"], a["type"])
                for action, delay, arg in _LIFECYCLE.get(key, []):
                    self._schedule(ev.ts + delay,
                                   lambda aid=a["id"], act=action, x=arg:
                                   self._do_action(aid, act, x))
            if ev.kind == "alert_escalate":
                aid = ev.data["alert_id"]
                alert = next(a for a in self.engine.alerts if a.id == aid)
                for action, delay, arg in _ESCALATE_LIFECYCLE.get(
                        (alert.bib, alert.type), []):
                    self._schedule(ev.ts + delay,
                                   lambda i=aid, act=action, x=arg:
                                   self._do_action(i, act, x))

        self.engine.listen(on_event)

    def _do_action(self, alert_id: int, action: str, arg: str) -> None:
        if action == "ack":
            self.engine.ack_alert(alert_id, self.sim_time)
        elif action == "onscene":
            self.engine.onscene(alert_id, self.sim_time)
        elif action == "resolve":
            self.engine.resolve_alert(alert_id, arg or "处置完成", self.sim_time)

    def _schedule(self, ts: float, fn: callable) -> None:
        self._actions.append((ts, fn))
        self._actions.sort(key=lambda x: x[0])

    # ---- 推进
    def step(self, dt: float = TICK_SEC) -> bool:
        """推进 dt 仿真秒，返回是否已到结束时间。"""
        if self.sim_time >= self.end_time:
            return True
        self.sim_time = min(self.end_time, self.sim_time + dt)
        now = self.sim_time
        self._advance_riders(now)
        self.engine.tick(now)
        while self._actions and self._actions[0][0] <= now:
            _, fn = self._actions.pop(0)
            fn()
        return self.sim_time >= self.end_time

    def run(self) -> None:
        while not self.step():
            pass

    def reset(self) -> None:
        self.__init__(log=self._log)

    def _advance_riders(self, now: float) -> None:
        cum = self.course.cum
        total = self.course.total_m
        for rider in self.riders:
            if rider.status in ("finished", "dnf"):
                continue
            plan = _PLANS[rider.bib]
            moving = not (plan.stop and plan.stop[0] <= now < plan.stop[1])
            speed = plan.speed
            if plan.slow and plan.slow[0] <= now < plan.slow[1]:
                speed = plan.slow[2]
            if moving:
                self._dist[rider.bib] += speed * TICK_SEC
            d = min(self._dist[rider.bib], total)

            seg = 0
            for i in range(len(cum) - 1):
                if cum[i] <= d <= cum[i + 1]:
                    seg = i
                    break
            else:
                seg = len(cum) - 2
            seg_len = cum[seg + 1] - cum[seg] or 1.0
            t = (d - cum[seg]) / seg_len

            a = self.course.xy[seg]
            b = self.course.xy[seg + 1]
            dx, dy = b.x - a.x, b.y - a.y
            length = math.hypot(dx, dy) or 1.0
            px, py = a.x + dx * t, a.y + dy * t

            lateral = 0.0
            if plan.lateral and plan.lateral[0] <= now < plan.lateral[1]:
                lateral = plan.lateral[2]
            if lateral:
                px += -dy / length * lateral
                py += dx / length * lateral

            lat, lon = xy_to_latlon(px, py)
            ele = (self.course.points[seg].ele
                   + (self.course.points[seg + 1].ele
                      - self.course.points[seg].ele) * t)
            self.engine.ingest_track(
                rider.bib, now, lat, lon, ele=ele,
                speed_ms=speed if moving else 0.0)

            # 检录：越过检查点路点时打卡
            cp_ord = self._next_cp[rider.bib]
            while (cp_ord < len(self.course.checkpoints)
                   and self.course.checkpoints[cp_ord].route_idx <= seg + 1):
                cp = self.course.checkpoints[cp_ord]
                if cp.id not in plan.skip_cp:
                    self.engine.ingest_checkin(rider.bib, cp.id, now)
                cp_ord += 1
            self._next_cp[rider.bib] = cp_ord

            if d >= total - 1.0 and rider.status != "finished":
                self.engine.mark_finish(rider.bib, now)

    # ---- 打印
    def _print(self, ev: Event) -> None:
        t = f"{ev.ts / 60:6.1f}分"
        if ev.kind == "track":
            return
        if ev.kind == "checkin":
            d = ev.data
            extra = (f" 本段 {d['split_pace']:.1f} 分/公里"
                     if d["split_pace"] else "")
            print(f"{t}  🎫 {d['bib']} {d['name']} 检录"
                  f"（{d['km']:.1f}km）{extra}")
        elif ev.kind == "alert_new":
            a = ev.data["alert"]
            mark = "🔴" if a["level"] == "critical" else "🟡"
            print(f"{t}  {mark} 告警#{a['id']} [{a['bib']} {_name(a['bib'])}] "
                  f"{a['title']} —— {a['detail']}")
        elif ev.kind == "alert_dispatch":
            d = ev.data
            if d.get("reason") == "ack_timeout":
                print(f"{t}  ⏫ 告警#{d['alert_id']} 确认超时升级，"
                      f"改派 {d['dispatch']['station_name']}（带 AED）")
            else:
                print(f"{t}  🚑 {d['call']}")
        elif ev.kind == "alert_escalate":
            print(f"{t}  ⏫ 告警#{ev.data['alert_id']} 5 分钟未确认，升级为危急")
        elif ev.kind == "alert_ack":
            print(f"{t}  ✅ 告警#{ev.data['alert_id']} 救护点已接单")
        elif ev.kind == "alert_onscene":
            print(f"{t}  📍 告警#{ev.data['alert_id']} 到达现场")
        elif ev.kind == "alert_resolve":
            print(f"{t}  🟢 告警#{ev.data['alert_id']} 解除：{ev.data['resolution']}")
        elif ev.kind == "finish":
            print(f"{t}  🏁 {ev.data['bib']} {_name(ev.data['bib'])} 完赛")


_NAMES = {r.bib: r.name for r in build_riders()}


def _name(bib: str) -> str:
    return _NAMES.get(bib, "")
