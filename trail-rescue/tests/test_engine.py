"""核心保障逻辑测试。直接运行：python -m unittest discover -s tests"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from trail_rescue.geo import haversine  # noqa: E402
from trail_rescue.engine import Engine  # noqa: E402
from trail_rescue.models import (AidStation, Checkpoint, Course, DangerZone,  # noqa: E402
                                 PaceBand, Rider, RoutePoint)
from trail_rescue.simulation import SimRunner, build_course, build_stations  # noqa: E402
from trail_rescue.storage import Store  # noqa: E402


def point_along(course, seg, t=0.5, dlat=0.0, dlon=0.0):
    lat, lon, ele = course.position_at(seg, t)
    return lat + dlat, lon + dlon, ele


class GeoTests(unittest.TestCase):
    def test_haversine_known_distance(self):
        # 赤道上 1 度经度 ≈ 111.195 km
        d = haversine(0, 0, 0, 1)
        self.assertAlmostEqual(d, 111_195, delta=200)

    def test_projection_along_course(self):
        course = build_course()
        # 赛道上的点投影距离应接近 0
        lat, lon, _ = point_along(course, 10, 0.5)
        proj = course.project(lat, lon)
        self.assertLess(proj.dist, 1.0)
        self.assertEqual(proj.seg, 10)

    def test_zone_detection(self):
        course = build_course()
        z1 = next(z for z in course.danger_zones if z.id == "Z1")
        lat, lon, _ = point_along(course, 5, 0.5)
        proj = course.project(lat, lon)
        self.assertEqual(course.zone_at(proj, proj.dist).id, "Z1")
        self.assertTrue(z1.contains_projection(5))


class EngineAlertTests(unittest.TestCase):
    def setUp(self):
        self.course = build_course()
        self.riders = [Rider("A1", "测试选手甲")]
        self.stations = build_stations()
        self.engine = Engine(self.course, self.riders, self.stations,
                             start_ts=0.0, now_fn=lambda: self.ts)
        self.ts = 0.0
        self.engine.ingest_checkin("A1", "CP1", 0.0)

    def _walk_to(self, end_seg, seconds, dt=15.0, speed=2.4):
        """沿赛道以固定速度喂轨迹点。"""
        target = self.course.cum[end_seg]
        dist = 0.0
        while self.ts < seconds and dist < target:
            self.ts += dt
            dist = min(target, dist + speed * dt)
            # 找到对应段
            seg = max(i for i in range(len(self.course.cum) - 1)
                      if self.course.cum[i] <= dist)
            t = (dist - self.course.cum[seg]) / (
                self.course.cum[seg + 1] - self.course.cum[seg])
            lat, lon, ele = self.course.position_at(seg, t)
            self.engine.ingest_track("A1", self.ts, lat, lon,
                                     ele=ele, speed_ms=speed)
            # 经过的检查点打卡
            for cp in self.course.checkpoints:
                if cp.route_idx <= seg and cp.id != "CP1" and not any(
                        c.checkpoint_id == cp.id
                        for c in self.engine.riders["A1"].checkins):
                    self.engine.ingest_checkin("A1", cp.id, self.ts)

    def test_danger_zone_auto_dispatch_nearest_station(self):
        # Z1 落石峡谷（warning）：正常配速穿越只监视不派单；
        # 减速到 1.0m/s（16.7 分/公里）超过赛段配速上限 -> 自动派最近点
        zone_alerts = []
        dist, dt = 0.0, 15.0
        while dist < self.course.cum[7]:
            self.ts += dt
            speed = 2.4 if self.ts < 450 else 1.0
            dist += speed * dt
            seg = max(i for i in range(len(self.course.cum) - 1)
                      if self.course.cum[i] <= dist)
            seg = min(seg, len(self.course.cum) - 2)
            t = (dist - self.course.cum[seg]) / (
                self.course.cum[seg + 1] - self.course.cum[seg])
            lat, lon, ele = self.course.position_at(seg, t)
            alert = self.engine.ingest_track("A1", self.ts, lat, lon,
                                             ele=ele, speed_ms=speed)
            if alert and alert.type == "danger_zone":
                zone_alerts.append(alert)
        self.assertTrue(zone_alerts, "危险路段内配速异常应产生告警")
        alert = zone_alerts[0]
        self.assertEqual(alert.status, "dispatched")
        # Z1（段 5 附近）最近救护点应是 AS2 鹰嘴岩救护点
        self.assertEqual(alert.dispatch.station_id, "AS2")

    def test_warning_zone_normal_pass_no_alert(self):
        # 正常配速（2.4m/s ≈ 6.9 分/公里）穿过 warning 路段不应告警派单
        dist, dt, speed = 0.0, 15.0, 2.4
        while dist < self.course.cum[7]:
            self.ts += dt
            dist += speed * dt
            seg = min(max(i for i in range(len(self.course.cum) - 1)
                          if self.course.cum[i] <= dist),
                      len(self.course.cum) - 2)
            t = (dist - self.course.cum[seg]) / (
                self.course.cum[seg + 1] - self.course.cum[seg])
            lat, lon, ele = self.course.position_at(seg, t)
            self.engine.ingest_track("A1", self.ts, lat, lon,
                                     ele=ele, speed_ms=speed)
        self.assertFalse(any(a.type == "danger_zone"
                             for a in self.engine.alerts))

    def test_stationary_in_critical_zone_triggers_critical_and_escalation(self):
        # 走到 Z2 入口（段 16 内，与 103 剧本停滞位置接近）后原地不动
        self._walk_to(end_seg=16, seconds=2400)
        rider = self.engine.riders["A1"]
        lat, lon, ele = self.course.position_at(16, 0.2)
        # 清掉之前危险路段告警的派单干扰，单独考察停滞告警
        for a in list(self.engine.alerts):
            self.engine.resolve_alert(a.id, "测试清理", self.ts)
        self.engine.ingest_track("A1", self.ts, lat, lon, ele=ele, speed_ms=0)
        self.assertEqual(rider.in_zone, "Z2")
        for _ in range(20):
            self.ts += 15
            self.engine.ingest_track("A1", self.ts, lat, lon, ele=ele, speed_ms=0)
        # 103 场景：危险路段内异常自动呼叫首派点；停滞并入同一处置；
        # 首派 5 分钟不确认 -> 升级并改派带 AED 的备援点
        zone_alert = next(a for a in self.engine.alerts
                          if a.type == "danger_zone")
        stationary = [a for a in self.engine.alerts if a.type == "stationary"]
        self.assertTrue(stationary, "应产生停滞告警")
        self.assertEqual(stationary[0].level, "critical")
        first_station = zone_alert.dispatch.station_id
        self.engine.tick(self.ts + 301)
        self.assertTrue(zone_alert.escalated)
        # 升级后改派另一个救护点（带 AED 备援）
        self.assertNotEqual(zone_alert.dispatch.station_id, first_station)
        self.assertEqual(zone_alert.dispatch.capability, "AED")

    def test_off_course_alert(self):
        # 起步后横向偏移 300 米
        lat, lon, ele = self.course.position_at(2, 0.5)
        alert = None
        for _ in range(3):
            self.ts += 15
            # 向垂直方向偏移：直接改纬度制造偏离
            alert = self.engine.ingest_track(
                "A1", self.ts, lat + 0.0035, lon, ele=ele, speed_ms=2.4)
        types = [a.type for a in self.engine.alerts]
        self.assertIn("off_course", types)

    def test_stationary_alert_on_normal_course(self):
        # 先移动到赛道 2km 处，再原地不动：180 秒内不告警，超过后告警
        self._walk_to(end_seg=8, seconds=900, speed=3.0)
        rider = self.engine.riders["A1"]
        lat, lon, ele = rider.last_point.lat, rider.last_point.lon, rider.elev
        moved_km = rider.distance_km
        self.assertGreater(moved_km, 1.0)
        base_ts = self.ts
        for _ in range(11):  # 11 * 15 = 165 秒，未到 180 阈值
            self.ts += 15
            self.engine.ingest_track("A1", self.ts, lat, lon, ele=ele)
        self.assertFalse(any(a.type == "stationary"
                             for a in self.engine.alerts))
        for _ in range(4):   # 到 225 秒，超过 180 阈值
            self.ts += 15
            self.engine.ingest_track("A1", self.ts, lat, lon, ele=ele)
        self.assertTrue(any(a.type == "stationary"
                            for a in self.engine.alerts))

    def test_missed_checkpoint_detection(self):
        # 直接打 CP3（绕过 CP2）
        alert = self.engine.ingest_checkin("A1", "CP3", 1200)
        self.assertIsNotNone(alert)
        self.assertEqual(alert.type, "missed_cp")
        self.assertIn("峡谷入口", alert.detail)
        self.assertEqual(alert.status, "dispatched")

    def test_duplicate_checkin_ignored(self):
        self.assertIsNone(self.engine.ingest_checkin("A1", "CP1", 10))

    def test_pace_band_slow(self):
        # 1.0 m/s = 16.7 分/公里，超过 0-2km 赛段 12 上限
        lat0, lon0, ele0 = self.course.position_at(0, 0.0)
        dist = 0.0
        found = False
        while dist < 1500:
            self.ts += 15
            dist += 15.0
            seg = max(i for i in range(len(self.course.cum) - 1)
                      if self.course.cum[i] <= dist)
            seg = min(seg, len(self.course.cum) - 2)
            t = (dist - self.course.cum[seg]) / (
                self.course.cum[seg + 1] - self.course.cum[seg])
            lat, lon, ele = self.course.position_at(seg, t)
            self.engine.ingest_track("A1", self.ts, lat, lon,
                                     ele=ele, speed_ms=1.0)
            found = found or any(a.type == "pace_slow"
                                 for a in self.engine.alerts)
        self.assertTrue(found, "慢于赛段配速带应触发 pace_slow")

    def test_alert_lifecycle_resolve(self):
        a = self.engine._make_alert(
            self.riders[0], "stationary", "critical", 100,
            "t", "d", *self.course.position_at(2, 0.5)[:2])
        self.engine._auto_dispatch(a, 100)
        self.assertTrue(self.engine.ack_alert(a.id, 120))
        self.assertTrue(self.engine.onscene(a.id, 300))
        self.assertTrue(self.engine.resolve_alert(a.id, "测试解除", 400))
        self.assertEqual(a.status, "resolved")

    def test_gps_stale_creates_alert(self):
        # 有过定位后静默 300 秒以上
        lat, lon, ele = self.course.position_at(1, 0.5)
        self.engine.ingest_track("A1", 100, lat, lon, ele=ele, speed_ms=2.4)
        new = self.engine.tick(450)
        self.assertTrue(any(a.type == "stale_gps" for a in new))


class SimulationScenarioTests(unittest.TestCase):
    def test_full_scenario_outcomes(self):
        sim = SimRunner(log=False)
        sim.run()
        e = sim.engine
        types = [a.type for a in e.alerts]

        self.assertIn("danger_zone", types)       # 102 落石峡谷
        self.assertIn("stationary", types)        # 103 停滞
        self.assertIn("pace_slow", types)         # 104 配速慢
        self.assertIn("off_course", types)        # 105 偏航
        self.assertIn("missed_cp", types)         # 105 漏打卡

        # 103 首派确认超时 -> 升级 + 备援 AED（危险路段异常单升级）
        dz = next(a for a in e.alerts
                  if a.bib == "103" and a.type == "danger_zone")
        self.assertTrue(dz.escalated)
        self.assertEqual(dz.dispatch.capability, "AED")

        # 所有派单都带合理距离
        for a in e.alerts:
            if a.dispatch:
                self.assertGreater(a.dispatch.distance_m, 0)
                self.assertGreater(a.dispatch.eta_sec, 0)

        # 正常选手完赛；退赛/慢选手不强制
        self.assertEqual(e.riders["101"].status, "finished")
        # 处置剧本全部执行
        self.assertGreaterEqual(
            sum(1 for a in e.alerts if a.status == "resolved"), 4)


class StorageTests(unittest.TestCase):
    def test_snapshot_roundtrip(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            store = Store(d)
            sim = SimRunner(log=False)
            sim.step(600)
            snap = sim.engine.snapshot()
            store.save_snapshot(snap)
            loaded = store.load_snapshot()
            self.assertEqual(len(loaded["riders"]), 5)

            sim2 = SimRunner(log=False)
            sim2.engine.restore(loaded)
            self.assertEqual(len(sim2.engine.alerts), len(sim.engine.alerts))


if __name__ == "__main__":
    unittest.main()
