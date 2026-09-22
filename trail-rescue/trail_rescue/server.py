"""赛事指挥 Web 服务（仅标准库）。

REST：
  GET  /api/state              赛道/选手/告警/救护点完整态势
  POST /api/track              上报定位（设备网关用）
  POST /api/checkin            上报检录
  POST /api/alerts/<id>/ack
  POST /api/alerts/<id>/onscene
  POST /api/alerts/<id>/resolve
  POST /api/sim                仿真控制 {action: start|pause|reset, speed}
  GET  /api/events             SSE 实时事件流
"""

from __future__ import annotations

import json
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .engine import Event
from .simulation import SimRunner
from .storage import Store

WEB_DIR = Path(__file__).parent / "web"

# 触发快照落盘的事件类型
_SNAPSHOT_KINDS = {"alert_new", "alert_dispatch", "alert_ack",
                   "alert_onscene", "alert_resolve", "alert_escalate",
                   "finish", "dnf"}


class RescueServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 8080,
                 data_dir: str = "data", speed: int = 60):
        self.host, self.port = host, port
        self.store = Store(data_dir)
        self.sim = SimRunner(log=False)
        self.eng = self.sim.engine
        self.eng.listen(self._on_event)
        self._sse: list[queue.Queue] = []
        self._running = False
        self._speed = speed
        self._sim_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self.httpd: ThreadingHTTPServer | None = None

        if self.store.snapshot_path.exists():
            # 启动不强制恢复：仿真 reset 会重建；真实模式用 --resume
            pass

    # ---------------------------------------------------------------- 事件
    def _on_event(self, ev: Event) -> None:
        try:
            self.store.append_event(ev)
        except OSError:
            pass
        if ev.kind in _SNAPSHOT_KINDS:
            try:
                self.store.save_snapshot(self.eng.snapshot())
            except OSError:
                pass
        dead = []
        for q in self._sse:
            try:
                q.put_nowait(ev)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in self._sse:
                self._sse.remove(q)

    # ---------------------------------------------------------------- 仿真
    def start_sim(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._sim_thread = threading.Thread(target=self._sim_loop,
                                                daemon=True)
            self._sim_thread.start()

    def pause_sim(self) -> None:
        self._running = False

    def reset_sim(self) -> None:
        self.pause_sim()
        time.sleep(0.05)
        self.sim = SimRunner(log=False)
        self.eng = self.sim.engine
        self.eng.listen(self._on_event)

    def _sim_loop(self) -> None:
        last = time.monotonic()
        while self._running:
            time.sleep(0.5)
            wall = time.monotonic() - last
            last = time.monotonic()
            done = self.sim.step(max(1.0, wall * self._speed))
            if done:
                self._running = False
                break

    # ---------------------------------------------------------------- 态势
    def state(self) -> dict:
        c, e = self.sim.course, self.eng
        return {
            "now": self.sim.sim_time,
            "start_ts": e.start_ts,
            "sim_running": self._running,
            "sim_end": self.sim.end_time,
            "course": {
                "points": [{"lat": p.lat, "lon": p.lon, "ele": p.ele}
                           for p in c.points],
                "cum_m": c.cum,
                "zones": [{"id": z.id, "name": z.name,
                           "start_idx": z.start_idx, "end_idx": z.end_idx,
                           "buffer_m": z.buffer_m, "severity": z.severity,
                           "note": z.note} for z in c.danger_zones],
                "checkpoints": [{"id": k.id, "name": k.name,
                                 "route_idx": k.route_idx, "km": k.km,
                                 "cutoff": k.cutoff}
                                for k in c.checkpoints],
                "total_km": c.total_m / 1000.0,
            },
            "stations": [s.__dict__ for s in self.sim.stations],
            "riders": [{
                "bib": r.bib, "name": r.name, "category": r.category,
                "status": r.status, "km": r.distance_km,
                "lateral_m": r.lateral_m, "elev": r.elev,
                "pace": r.cur_pace, "in_zone": r.in_zone,
                "lat": r.last_point.lat if r.last_point else c.points[0].lat,
                "lon": r.last_point.lon if r.last_point else c.points[0].lon,
                "last_ts": r.last_point.ts if r.last_point else None,
                "checkins": [{"id": x.checkpoint_id, "name": x.name,
                              "ts": x.ts, "km": x.km,
                              "split_pace": x.split_pace}
                             for x in r.checkins],
            } for r in e.riders.values()],
            "alerts": [a.to_dict() for a in e.alerts],
        }

    # ---------------------------------------------------------------- HTTP
    def serve(self) -> None:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _send(self, code: int, body: bytes,
                      ctype: str = "application/json; charset=utf-8"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _json(self, obj, code: int = 200):
                self._send(code, json.dumps(obj, ensure_ascii=False).encode())

            def do_GET(self):
                path = urlparse(self.path).path
                if path == "/api/state":
                    self._json(parent.state())
                elif path == "/api/events":
                    self._sse_stream()
                elif path == "/":
                    self._static("index.html", "text/html; charset=utf-8")
                elif path in ("/index.html", "/app.js", "/style.css"):
                    ctype = ("text/html; charset=utf-8" if path.endswith("html")
                             else "application/javascript; charset=utf-8"
                             if path.endswith("js")
                             else "text/css; charset=utf-8")
                    self._static(path.lstrip("/"), ctype)
                else:
                    self._json({"error": "not found"}, 404)

            def do_POST(self):
                path = urlparse(self.path).path.rstrip("/")
                try:
                    length = int(self.headers.get("Content-Length", 0))
                    payload = (json.loads(self.rfile.read(length) or b"{}")
                               if length else {})
                except json.JSONDecodeError:
                    self._json({"error": "invalid json"}, 400)
                    return
                try:
                    self._route_post(path, payload)
                except KeyError as exc:
                    self._json({"error": str(exc)}, 404)
                except ValueError as exc:
                    self._json({"error": str(exc)}, 400)

            def _route_post(self, path: str, p: dict):
                now = parent.sim.sim_time
                if path == "/api/track":
                    alert = parent.eng.ingest_track(
                        p["bib"], p.get("ts", now), p["lat"], p["lon"],
                        ele=p.get("ele", 0.0), speed_ms=p.get("speed", 0.0))
                    self._json({"ok": True,
                                "alert_id": alert.id if alert else None})
                elif path == "/api/checkin":
                    alert = parent.eng.ingest_checkin(
                        p["bib"], p["checkpoint_id"], p.get("ts", now))
                    self._json({"ok": True,
                                "alert_id": alert.id if alert else None})
                elif path.startswith("/api/alerts/"):
                    parts = path.split("/")
                    aid, action = int(parts[3]), parts[4]
                    if action == "ack":
                        ok = parent.eng.ack_alert(aid, now)
                    elif action == "onscene":
                        ok = parent.eng.onscene(aid, now)
                    elif action == "resolve":
                        ok = parent.eng.resolve_alert(
                            aid, p.get("resolution", "现场处置完成"), now)
                    else:
                        self._json({"error": "unknown action"}, 400)
                        return
                    self._json({"ok": ok})
                elif path == "/api/sim":
                    if p.get("speed"):
                        parent._speed = int(p["speed"])
                    if p.get("action") == "start":
                        parent.start_sim()
                    elif p.get("action") == "pause":
                        parent.pause_sim()
                    elif p.get("action") == "reset":
                        parent.reset_sim()
                    self._json({"ok": True, "running": parent._running})
                else:
                    self._json({"error": "not found"}, 404)

            def _static(self, name: str, ctype: str):
                f = WEB_DIR / name
                if not f.exists():
                    self._json({"error": "not found"}, 404)
                    return
                self._send(200, f.read_bytes(), ctype)

            def _sse_stream(self):
                q: queue.Queue = queue.Queue(maxsize=200)
                parent._sse.append(q)
                self.send_response(200)
                self.send_header("Content-Type",
                                 "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    self.wfile.write(b": connected\n\n")
                    self.wfile.flush()
                    while True:
                        try:
                            ev = q.get(timeout=15)
                        except queue.Empty:
                            self.wfile.write(b": ping\n\n")
                        else:
                            data = json.dumps(
                                {"kind": ev.kind, "ts": ev.ts,
                                 "data": ev.data}, ensure_ascii=False)
                            self.wfile.write(
                                f"event: {ev.kind}\ndata: {data}\n\n"
                                .encode("utf-8"))
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    if q in parent._sse:
                        parent._sse.remove(q)

        self.httpd = ThreadingHTTPServer((self.host, self.port), Handler)
        self.httpd.serve_forever()
