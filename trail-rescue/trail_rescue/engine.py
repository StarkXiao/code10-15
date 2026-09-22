"""赛事保障引擎：绑定定位 + 检录，检测异常并自动呼叫最近救护点。

引擎是纯内存、可注入时钟的，方便仿真与测试：
    engine = Engine(course, riders, stations, now_fn=...)
    engine.ingest_track(...) / engine.ingest_checkin(...) / engine.tick(now)
所有状态变化以 Event 形式投递给订阅者（存储、SSE、仿真打印）。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable, Optional

from .geo import haversine
from .models import (AidStation, Alert, Checkin, Course, DangerZone, Dispatch,
                     Rider, TrackPoint)
from .motion import STATIONARY_SECONDS, analyze

# ---- 告警冷却（秒）：同类告警在冷却内不重复派单
COOLDOWN = {
    "danger_zone": 300,
    "stationary": 240,
    "pace_slow": 600,
    "pace_fast": 300,
    "off_course": 300,
    "late_cp": 0,
    "no_start": 0,
}
OFF_COURSE_M = 200.0            # 偏离赛道超过该距离告警
STALE_GPS_SEC = 300             # 超过该时长无定位视为失联
NO_START_GRACE_SEC = 900        # 发枪后宽限（分钟）
MOVE_EPS_M = 5.0                # 位移超过该值视为「发生过移动」（过滤投影微噪声）
ACK_TIMEOUT_SEC = 300           # critical 派单后确认超时 -> 升级并改派备援
TRACK_TTL_SEC = 3600            # 内存中轨迹保留时长
ZONE_NORMAL_SPEED = 3.6         # 危险路段内快于该速度（>16.6km/h）视为车辆/异常


@dataclass
class Event:
    ts: float
    kind: str          # track | checkin | alert_new | alert_dispatch |
    #                  # alert_ack | alert_onscene | alert_resolve |
    #                  # alert_escalate | finish | dnf | notice
    data: dict


EventListener = Callable[[Event], None]


def band_pace_max(course: Course, km: float) -> float:
    """该里程所在赛段的配速带上限（分/公里）。"""
    band = course.pace_band_at(km)
    return band.max_pace if band else 999.0


class Engine:
    def __init__(self, course: Course, riders: list[Rider],
                 stations: list[AidStation],
                 start_ts: float = 0.0,
                 now_fn: Optional[Callable[[], float]] = None):
        self.course = course
        self.riders: dict[str, Rider] = {r.bib: r for r in riders}
        self.stations = stations
        self.start_ts = start_ts
        self.now_fn = now_fn

        self.alerts: list[Alert] = []
        self._alert_seq = 0
        self._cooldown: dict[tuple[str, str], float] = {}
        self._listeners: list[EventListener] = []
        self._started = False
        self._lock = threading.RLock()

    # ---------------------------------------------------------------- 订阅
    def listen(self, fn: EventListener) -> None:
        self._listeners.append(fn)

    def _emit(self, kind: str, data: dict, ts: Optional[float] = None) -> Event:
        ev = Event(ts if ts is not None else self.now(), kind, data)
        for fn in self._listeners:
            fn(ev)
        return ev

    def now(self) -> float:
        return self.now_fn() if self.now_fn else 0.0

    # ---------------------------------------------------------------- 录入
    def ingest_track(self, bib: str, ts: float, lat: float, lon: float,
                     ele: float = 0.0, speed_ms: float = 0.0) -> Optional[Alert]:
        """处理一个定位点，返回新建的最高优先级告警（可能为 None）。"""
        with self._lock:
            rider = self.riders.get(bib)
            if rider is None:
                raise KeyError(f"未知选手: {bib}")
            if rider.status in ("finished", "dnf", "dns"):
                return None

            if not self._started and ts >= self.start_ts:
                self._started = True

            pt = TrackPoint(ts=ts, lat=lat, lon=lon, ele=ele, speed_ms=speed_ms)
            rider.track.append(pt)
            self._prune_track(rider, ts)

            # ---- 赛道匹配
            proj = self.course.project(lat, lon)
            along_m = self.course.distance_along(proj)
            rider.seg, rider.t = proj.seg, proj.t
            rider.distance_km = along_m / 1000.0
            rider.lateral_m = proj.dist
            rider.elev = ele or self.course.points[proj.seg].ele
            if rider.status == "registered":
                rider.status = "oncourse"
                if rider.start_ts == 0:
                    rider.start_ts = self.start_ts

            # ---- 停滞锚点：取「最近一次有位移的历史点」，
            # 避免把刚出发静止的选手误判为停滞
            ref_ts, ref_km = self._last_moving_ref(rider, ts)
            if ref_ts > 0:
                rider.last_move_ts, rider.last_move_km = ref_ts, ref_km
            else:
                rider.last_move_ts, rider.last_move_km = ts, rider.distance_km

            # ---- 运动分析
            track_ts = [p.ts for p in rider.track]
            track_km = []
            for p in rider.track:
                pr = self.course.project(p.lat, p.lon)
                track_km.append(self.course.distance_along(pr) / 1000.0)
            motion = analyze(track_ts, track_km, speed_ms, ts,
                             rider.last_move_ts, rider.last_move_km)
            rider.cur_pace = motion.pace_min_per_km

            self._emit("track", {"bib": bib, "ts": ts, "lat": lat, "lon": lon,
                                 "ele": rider.elev, "km": rider.distance_km,
                                 "lateral_m": rider.lateral_m,
                                 "pace": rider.cur_pace}, ts)

            new_alerts: list[Alert] = []

            # 告警合并：同一选手已有未结风险告警（尤其已派单）时，
            # 不重复建单，避免一个抽筋事件派出 4 次救护车
            def merged_with(existing_types: tuple[str, ...],
                            level: str = "warning") -> bool:
                for ex in self.alerts:
                    if (ex.bib == rider.bib and ex.status != "resolved"
                            and ex.type in existing_types):
                        if (level == "critical" or ex.level == "critical"
                                or ex.level == level):
                            return True
                return False

            def has_open_dispatch(exclude: int = -1) -> bool:
                return any(a.bib == rider.bib and a.id != exclude
                           and a.status != "resolved" and a.dispatch
                           for a in self.alerts)

            def recently_resolved(types: tuple[str, ...],
                                  within: float = 900.0) -> bool:
                # 同类问题刚由救护点处置解除（如下撤途中再次报配速慢），
                # 短时内不再重复派车
                return any(a.bib == rider.bib and a.type in types
                           and a.status == "resolved" and a.resolve_ts
                           and ts - a.resolve_ts < within
                           for a in self.alerts)

            # ---- 1) 危险路段（最高优先）
            zone = self.course.zone_at(proj, proj.dist)
            rider.in_zone = zone.id if zone else ""
            # 已离开危险路段：仅当选手已恢复正常移动，才自动关闭
            # 「仅因进入路段」产生的告警；异常呼叫单（配速/停滞）
            # 无论是否在路段内都保留，由救护点处置
            if not zone:
                normal_now = (0 < rider.cur_pace <= band_pace_max(
                    self.course, rider.distance_km))
                if normal_now:
                    for ex in self.alerts:
                        if (ex.bib == rider.bib and ex.status != "resolved"
                                and ex.type == "danger_zone"
                                and "异常" not in ex.title):
                            self.resolve_alert(
                                ex.id, "选手已正常通过该危险路段", ts)
            if zone and not self._has_open_alert(rider.bib, "danger_zone",
                                                 zone_id=zone.id):
                # 规则（避免对正常选手全员误报）：
                #  - 进入危险路段先记录/预警；
                #  - 只有「危险路段内出现停滞/配速异常/偏航」时才自动呼叫救护点；
                #  - critical 路段的呼叫级别为 critical；
                #  - 同一选手已有未结风险告警时合并，不重复派单。
                moving_normally = (0 < rider.cur_pace <= band_pace_max(
                    self.course, rider.distance_km))
                blocked = self._has_open_alert(rider.bib, "stationary") or \
                    self._has_open_alert(rider.bib, "off_course")
                abnormal = (not moving_normally) or blocked
                if not abnormal:
                    self._emit("notice", {
                        "bib": bib, "zone_id": zone.id,
                        "text": f"{rider.name} 进入{zone.name}，配速正常，监视中"},
                        ts)
                elif not merged_with(
                        ("stationary", "pace_slow", "off_course",
                         "danger_zone", "missed_cp", "stale_gps"),
                        level="warning") and not has_open_dispatch() \
                        and not recently_resolved(
                            ("danger_zone", "stationary")):
                    level = "critical" if zone.severity == "critical" else "warning"
                    if zone.severity == "warning":
                        level = "warning"
                    alert = self._maybe_alert(
                        rider, ("danger_zone", zone.id), ts,
                        level=level,
                        type_="danger_zone",
                        title=f"危险路段内异常：{zone.name}",
                        detail=(f"{zone.note or '注意落石、断崖、天气突变'}。"
                                f"当前里程 {rider.distance_km:.2f}km，"
                                f"配速 {rider.cur_pace or 0:.1f} 分/公里。"),
                        lat=lat, lon=lon, zone_id=zone.id)
                    if alert:
                        new_alerts.append(alert)

            # ---- 2) 偏离赛道
            if (proj.dist > OFF_COURSE_M and not merged_with(
                    ("stationary", "danger_zone", "missed_cp"))
                    and not has_open_dispatch()
                    and not recently_resolved(("off_course",))):
                alert = self._maybe_alert(
                    rider, ("off_course", ""), ts, level="warning",
                    type_="off_course",
                    title="偏离赛道",
                    detail=f"距赛道最近 {proj.dist:.0f} 米，已超过 "
                           f"{OFF_COURSE_M:.0f} 米警戒值，请核对导航。",
                    lat=lat, lon=lon)
                if alert:
                    new_alerts.append(alert)

            # ---- 3) 停滞
            stationary_for = max(0.0, ts - rider.last_move_ts)
            if (stationary_for >= STATIONARY_SECONDS
                    and not self._has_open_alert(
                        rider.bib, "stationary", zone_id=rider.in_zone)):
                alert = self._maybe_alert(
                    rider, ("stationary", rider.in_zone or "course"), ts,
                    level="critical" if rider.in_zone else "warning",
                    type_="stationary",
                    title=("危险路段内停滞" if rider.in_zone else "长时间停滞"),
                    detail=f"已约 {stationary_for / 60:.0f} 分钟无有效移动，"
                           f"当前配速 {rider.cur_pace or 0:.1f} 分/公里，"
                           f"里程 {rider.distance_km:.2f}km。",
                    lat=lat, lon=lon, zone_id=rider.in_zone)
                if alert:
                    new_alerts.append(alert)

            # ---- 4) 配速异常（过快 / 过慢）
            if motion.speed_spike:
                alert = self._maybe_alert(
                    rider, ("pace_fast", "spike"), ts, level="warning",
                    type_="pace_fast",
                    title="瞬时速度异常",
                    detail=f"设备上报速度 {speed_ms:.1f} 米/秒，疑似 GPS 漂移"
                           f"或搭乘交通工具。",
                    lat=lat, lon=lon)
                if alert:
                    new_alerts.append(alert)
            elif motion.pace_fast:
                band = self.course.pace_band_at(rider.distance_km)
                if band and rider.cur_pace < band.min_pace:
                    alert = self._maybe_alert(
                        rider, ("pace_fast", ""), ts, level="warning",
                        type_="pace_fast",
                        title="配速异常偏快",
                        detail=f"当前 {rider.cur_pace:.1f} 分/公里，低于该赛段 "
                               f"安全下限 {band.min_pace:.1f} 分/公里。",
                        lat=lat, lon=lon)
                    if alert:
                        new_alerts.append(alert)
            else:
                band = self.course.pace_band_at(rider.distance_km)
                if (band and rider.cur_pace > band.max_pace
                        and rider.cur_pace > 0 and not rider.in_zone
                        and stationary_for < STATIONARY_SECONDS
                        and not merged_with(
                            ("danger_zone", "stationary", "off_course"))
                        and not has_open_dispatch()
                        and not recently_resolved(
                            ("pace_slow", "danger_zone", "stationary"))):
                    alert = self._maybe_alert(
                        rider, ("pace_slow", f"{band.start_km}-{band.end_km}"),
                        ts, level="warning", type_="pace_slow",
                        title="配速异常偏慢",
                        detail=f"当前 {rider.cur_pace:.1f} 分/公里，超出该赛段 "
                               f"参考上限 {band.max_pace:.1f} 分/公里，"
                               f"存在失温/受伤/退赛风险。",
                        lat=lat, lon=lon)
                    if alert:
                        new_alerts.append(alert)

            # ---- 自动派单
            for alert in new_alerts:
                self._auto_dispatch(alert, ts)
            return next((a for a in new_alerts
                         if a.level == "critical"), new_alerts[0] if new_alerts else None)

    def ingest_checkin(self, bib: str, checkpoint_id: str,
                       ts: float, lat: float = 0.0, lon: float = 0.0) -> Optional[Alert]:
        """绑定检录数据：校验顺序/漏检/关门，计算赛段配速。"""
        with self._lock:
            rider = self.riders.get(bib)
            if rider is None:
                raise KeyError(f"未知选手: {bib}")
            cp = next((c for c in self.course.checkpoints
                       if c.id == checkpoint_id), None)
            if cp is None:
                raise KeyError(f"未知检查点: {checkpoint_id}")

            # 重复打卡忽略
            if any(c.checkpoint_id == checkpoint_id for c in rider.checkins):
                return None

            # 顺序校验：中间漏掉检查点 -> 漏检告警（立即派单核实）
            cp_ord = self.course.checkpoints.index(cp)
            expected = rider.last_cp_idx + 1
            missed: list[str] = []
            if cp_ord > expected:
                for mcp in self.course.checkpoints[expected:cp_ord]:
                    missed.append(mcp.name)

            prev_cp = (self.course.checkpoints[rider.last_cp_idx]
                       if rider.last_cp_idx >= 0 else None)
            split_pace = 0.0
            if prev_cp:
                dt = ts - rider.checkins[-1].ts
                dkm = cp.km - prev_cp.km
                if dt > 0 and dkm > 0:
                    split_pace = (dt / 60.0) / dkm

            checkin = Checkin(checkpoint_id=cp.id, ts=ts, name=cp.name,
                              km=cp.km, split_pace=split_pace)
            rider.checkins.append(checkin)
            rider.last_cp_idx = self.course.checkpoints.index(cp)
            if not lat:
                idx = cp.route_idx
                lat = self.course.points[idx].lat
                lon = self.course.points[idx].lon
            self._emit("checkin", {"bib": bib, "checkpoint_id": cp.id,
                                   "name": cp.name, "ts": ts, "km": cp.km,
                                   "split_pace": split_pace,
                                   "missed": missed}, ts)

            alert: Optional[Alert] = None
            if missed:
                alert = self._make_alert(
                    rider, "missed_cp", "critical", ts,
                    title=f"漏检 {len(missed)} 个检查点",
                    detail=f"在 {cp.name} 打卡，但未经过：{'、'.join(missed)}。"
                           f"可能抄近道、受伤弃赛或设备异常，立即无线电核实。",
                    lat=lat, lon=lon)
                self._auto_dispatch(alert, ts)

            # 关门判定
            elif cp.cutoff is not None:
                elapsed = ts - rider.start_ts
                if elapsed > cp.cutoff:
                    late_min = (elapsed - cp.cutoff) / 60.0
                    notice = self._make_alert(
                        rider, "late_cp", "warning", ts,
                        title=f"超过 {cp.name} 关门时间 {late_min:.0f} 分钟",
                        detail=f"应于 {cp.cutoff / 60:.0f} 分钟内到达，"
                               f"实际 {elapsed / 60:.0f} 分钟，按规则收容退赛。",
                        lat=lat, lon=lon, cooldown_key=("late_cp", cp.id))
                    self._emit("alert_new", {"alert": notice.to_dict()}, ts)
                    return notice
            return alert

    # ---------------------------------------------------------------- 周期
    def tick(self, now: float) -> list[Alert]:
        """周期扫描：失联检测、派单确认超时升级。"""
        with self._lock:
            changed: list[Alert] = []

            # 1) GPS 失联
            if self._started:
                elapsed = now - self.start_ts
                for rider in self.riders.values():
                    if rider.status != "oncourse":
                        continue
                    last = rider.last_point
                    if last is None:
                        if elapsed > NO_START_GRACE_SEC:
                            alert = self._maybe_alert(
                                rider, ("no_start", ""), now, level="critical",
                                type_="no_start",
                                title="发枪后未出现定位",
                                detail=f"发枪已 {elapsed / 60:.0f} 分钟，"
                                       f"仍无任何定位上报。",
                                lat=self.course.points[0].lat,
                                lon=self.course.points[0].lon)
                            if alert:
                                self._auto_dispatch(alert, now)
                                changed.append(alert)
                        continue
                    if now - last.ts > STALE_GPS_SEC:
                        alert = self._maybe_alert(
                            rider, ("stale_gps", ""), now, level="critical",
                            type_="stale_gps",
                            title="定位信号丢失",
                            detail=f"已 {(now - last.ts) / 60:.0f} 分钟无定位，"
                                   f"最后位置 {rider.distance_km:.2f}km，"
                                   f"海拔 {rider.elev:.0f}m。",
                            lat=last.lat, lon=last.lon)
                        if alert:
                            self._auto_dispatch(alert, now)
                            changed.append(alert)

            # 2) 派单确认超时升级（合并进来的从属单不独立升级）
            for alert in self.alerts:
                if (alert.status == "dispatched" and alert.dispatch
                        and not alert.escalated
                        and alert.dispatch_owner == 0
                        and now - alert.dispatch.first_ts >= ACK_TIMEOUT_SEC):
                    alert.escalated = True
                    alert.escalate_ts = now
                    # 升级危急；已确认的只是记录升级，不再重复呼叫
                    alert.level = "critical"
                    self._emit("alert_escalate",
                               {"alert_id": alert.id,
                                "station_id": alert.dispatch.station_id,
                                "bib": alert.bib}, now)
                    # critical 告警未被接单：自动呼叫下一个最近的备援救护点
                    current_station = alert.dispatch.station_id
                    backup = self._nearest_station(
                        alert.lat, alert.lon, exclude={current_station})
                    if backup:
                        station = backup[0][0]
                        d = self._build_dispatch(station, alert, now)
                        # 保留首次呼叫时间，避免改派后超时计时被重置
                        d.first_ts = alert.dispatch.first_ts
                        # 同步共享旧派单的从属单
                        followers = [a for a in self.alerts
                                     if a is not alert
                                     and a.dispatch is alert.dispatch]
                        self._emit("alert_dispatch",
                                   {"alert_id": alert.id,
                                    "dispatch": d.__dict__,
                                    "reason": "ack_timeout"}, now)
                        alert.dispatch = d
                        alert.status = "dispatched"
                        for f in followers:
                            f.dispatch = d
                    changed.append(alert)
            return changed

    # ---------------------------------------------------------------- 派单
    def _nearest_station(self, lat: float, lon: float,
                         exclude: Optional[set[str]] = None
                         ) -> list[tuple[AidStation, float]]:
        exclude = exclude or set()
        ranked = []
        for s in self.stations:
            if s.status == "closed" or s.id in exclude:
                continue
            d = haversine(lat, lon, s.lat, s.lon)
            ranked.append((s, d))
        ranked.sort(key=lambda x: x[1])
        return ranked

    def _build_dispatch(self, station: AidStation, alert: Alert,
                        ts: float) -> Dispatch:
        dist = haversine(alert.lat, alert.lon, station.lat, station.lon)
        # 山地越野按约 250 米/分钟估算行进，至少取站点标称响应时间
        eta = max(station.response_min * 60, dist / 250.0 * 60)
        need_aed = alert.level == "critical"
        capability = "AED" if need_aed and "AED" in station.capabilities else ""
        return Dispatch(station_id=station.id, station_name=station.name,
                        distance_m=dist, eta_sec=eta, capability=capability,
                        ts=ts, first_ts=ts)

    def _auto_dispatch(self, alert: Alert, ts: float) -> None:
        """自动呼叫最近救护点；同选手已有未结派单时合并到该单，不重复呼叫。"""
        existing = next((a for a in self.alerts
                         if a.bib == alert.bib and a.id != alert.id
                         and a.dispatch and a.status != "resolved"), None)
        if existing:
            # 沿用既有派单与处置状态；从属单仅发合并通知，不独立升级/重复呼叫
            alert.dispatch = existing.dispatch
            alert.status = existing.status
            alert.dispatch_owner = existing.id
            self._emit("notice", {
                "bib": alert.bib,
                "text": f"新告警 #{alert.id} 与未结告警 #{existing.id}"
                        f"（{existing.dispatch.station_name} 处置中）合并跟进"}, ts)
            return
        ranked = self._nearest_station(alert.lat, alert.lon)
        if not ranked:
            self._emit("notice", {"bib": alert.bib,
                                   "text": "无可用救护点，已转指挥部人工调度"}, ts)
            return
        station, _ = ranked[0]
        d = self._build_dispatch(station, alert, ts)
        alert.dispatch = d
        alert.status = "dispatched"
        self._emit("alert_dispatch",
                   {"alert_id": alert.id, "dispatch": d.__dict__,
                    "reason": "auto",
                    "call": (f"【自动呼叫】{station.name}：{alert.bib} 号 "
                             f"{self.riders[alert.bib].name}，{alert.title}，"
                             f"直线 {d.distance_m / 1000:.1f}km，"
                             f"预计 {d.eta_sec / 60:.0f} 分钟抵达"
                             + ("，请携带 AED" if d.capability else ""))}, ts)

    # ---------------------------------------------------------------- 告警
    def _make_alert(self, rider: Rider, type_: str, level: str, ts: float,
                    title: str, detail: str, lat: float, lon: float,
                    zone_id: str = "", cooldown_key: tuple[str, str] = ("", "")
                    ) -> Alert:
        self._alert_seq += 1
        alert = Alert(id=self._alert_seq, type=type_, level=level,
                      bib=rider.bib, ts=ts, title=title, detail=detail,
                      lat=lat, lon=lon, zone_id=zone_id)
        self.alerts.append(alert)
        key = cooldown_key if cooldown_key[0] else (type_, zone_id)
        if key[0]:
            self._cooldown[(rider.bib, key[0], key[1])] = ts
        self._emit("alert_new", {"alert": alert.to_dict()}, ts)
        return alert

    def _maybe_alert(self, rider: Rider, key: tuple[str, str], ts: float,
                     level: str, type_: str, title: str, detail: str,
                     lat: float, lon: float, zone_id: str = ""
                     ) -> Optional[Alert]:
        cd = COOLDOWN.get(type_, 0)
        last = self._cooldown.get((rider.bib, key[0], key[1]))
        if last is not None and cd > 0 and ts - last < cd:
            return None
        return self._make_alert(rider, type_, level, ts, title, detail,
                                lat, lon, zone_id, cooldown_key=key)

    # ---------------------------------------------------------------- 处置
    def ack_alert(self, alert_id: int, ts: Optional[float] = None) -> bool:
        with self._lock:
            ts = ts if ts is not None else self.now()
            alert = self._find_alert(alert_id)
            if not alert or alert.status not in ("dispatched",):
                return False
            for a in self._dispatch_group(alert):
                a.status = "acked"
                if a.dispatch:
                    a.dispatch.ack_ts = ts
            self._emit("alert_ack", {"alert_id": alert_id, "ts": ts}, ts)
            return True

    def onscene(self, alert_id: int, ts: Optional[float] = None) -> bool:
        with self._lock:
            ts = ts if ts is not None else self.now()
            alert = self._find_alert(alert_id)
            if not alert or alert.status not in ("dispatched", "acked"):
                return False
            for a in self._dispatch_group(alert):
                a.status = "onscene"
                if a.dispatch:
                    a.dispatch.onscene_ts = ts
            self._emit("alert_onscene", {"alert_id": alert_id, "ts": ts}, ts)
            return True

    def resolve_alert(self, alert_id: int, resolution: str = "现场处置完成",
                      ts: Optional[float] = None) -> bool:
        with self._lock:
            ts = ts if ts is not None else self.now()
            alert = self._find_alert(alert_id)
            if not alert or alert.status == "resolved":
                return False
            for a in self._dispatch_group(alert):
                a.status = "resolved"
                a.resolve_ts = ts
                a.resolution = resolution
            self._emit("alert_resolve",
                       {"alert_id": alert_id, "resolution": resolution,
                        "ts": ts}, ts)
            return True

    def _dispatch_group(self, alert: Alert) -> list[Alert]:
        """同一派单组：本告警 + 共享同一 Dispatch 的其他告警。"""
        if not alert.dispatch:
            return [alert]
        return [a for a in self.alerts
                if a.dispatch is alert.dispatch] or [alert]

    def mark_finish(self, bib: str, ts: float) -> None:
        with self._lock:
            rider = self.riders[bib]
            rider.status = "finished"
            self._emit("finish", {"bib": bib, "ts": ts}, ts)

    def mark_dnf(self, bib: str, ts: float, reason: str = "") -> None:
        with self._lock:
            rider = self.riders[bib]
            rider.status = "dnf"
            self._emit("dnf", {"bib": bib, "ts": ts, "reason": reason}, ts)

    def _find_alert(self, alert_id: int) -> Optional[Alert]:
        return next((a for a in self.alerts if a.id == alert_id), None)

    def _has_open_alert(self, bib: str, type_: str,
                        zone_id: str = "") -> bool:
        return any(a.bib == bib and a.type == type_
                   and a.status != "resolved"
                   and (not zone_id or a.zone_id == zone_id)
                   for a in self.alerts)

    def _last_moving_ref(self, rider: Rider, ts: float
                         ) -> tuple[float, float]:
        """返回「最后一次有效移动」的参考点 (ts, km)。

        只有当样本相对*上一被采纳的参考点*累计位移达到阈值才推进锚点；
        停下后每个样本都挤在锚点附近，锚点自然冻结在刚停下的时刻。
        全程没移动过（如开赛集结）返回 (0,0)，由调用方初始化为当前时刻。
        """
        ref_ts = ref_km = 0.0
        first_km = 0.0
        have = False
        for p in rider.track:
            pr = self.course.project(p.lat, p.lon)
            km = self.course.distance_along(pr) / 1000.0
            if not have:
                ref_ts, first_km = p.ts, km
                ref_km = km
                have = True
                continue
            # 相对「上一个被采纳的移动点」位移达阈值才推进锚点；
            # 停下后所有样本都在锚点阈值内，锚点冻结在刚停下那一刻
            if abs(km - ref_km) * 1000.0 >= MOVE_EPS_M:
                ref_ts, ref_km = p.ts, km
        # 相对首个点累计位移不足阈值 => 从未真正移动（开赛集结），不计时
        if not have or abs(ref_km - first_km) * 1000.0 < MOVE_EPS_M:
            return 0.0, 0.0
        return ref_ts, ref_km

    def _prune_track(self, rider: Rider, ts: float) -> None:
        cutoff = ts - TRACK_TTL_SEC
        while rider.track and rider.track[0].ts < cutoff:
            rider.track.pop(0)

    # ---------------------------------------------------------------- 快照
    def snapshot(self) -> dict:
        with self._lock:
            return {
                "start_ts": self.start_ts,
                "now": self.now(),
                "riders": [
                    {"bib": r.bib, "name": r.name, "category": r.category,
                     "start_ts": r.start_ts, "status": r.status,
                     "seg": r.seg, "t": r.t, "distance_km": r.distance_km,
                     "lateral_m": r.lateral_m, "elev": r.elev,
                     "in_zone": r.in_zone, "cur_pace": r.cur_pace,
                     "last_move_ts": r.last_move_ts,
                     "checkins": [c.__dict__ for c in r.checkins],
                     "track": [p.__dict__ for p in r.track[-100:]]}
                    for r in self.riders.values()
                ],
                "alerts": [a.to_dict() for a in self.alerts],
                "cooldown": [{"k": list(k), "ts": v}
                             for k, v in self._cooldown.items()],
                "alert_seq": self._alert_seq,
            }

    def restore(self, snap: dict) -> None:
        with self._lock:
            self.start_ts = snap.get("start_ts", self.start_ts)
            self._alert_seq = snap.get("alert_seq", 0)
            for rd in snap.get("riders", []):
                rider = self.riders.get(rd["bib"])
                if not rider:
                    continue
                rider.status = rd["status"]
                rider.start_ts = rd.get("start_ts", 0.0)
                rider.seg = rd.get("seg", -1)
                rider.t = rd.get("t", 0.0)
                rider.distance_km = rd.get("distance_km", 0.0)
                rider.lateral_m = rd.get("lateral_m", 0.0)
                rider.elev = rd.get("elev", 0.0)
                rider.in_zone = rd.get("in_zone", "")
                rider.cur_pace = rd.get("cur_pace", 0.0)
                rider.last_move_ts = rd.get("last_move_ts", 0.0)
                rider.last_move_km = rd.get("distance_km", 0.0)
                rider.last_cp_idx = len(rd.get("checkins", [])) - 1
                rider.checkins = [Checkin(**c) for c in rd.get("checkins", [])]
                rider.track = [TrackPoint(**p) for p in rd.get("track", [])]
            self.alerts = []
            for ad in snap.get("alerts", []):
                dispatch = None
                if ad.get("dispatch"):
                    dispatch = Dispatch(**ad["dispatch"])
                ad = {**ad, "dispatch": dispatch}
                self.alerts.append(Alert(**ad))
            self._cooldown = {tuple(c["k"]): c["ts"]
                              for c in snap.get("cooldown", [])}
