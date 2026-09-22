"""命令行入口。

  python -m trail_rescue sim                 离线跑完赛事剧本，打印事件流
  python -m trail_rescue serve --port 8080   启动指挥大屏（含仿真控制）
  python -m trail_rescue test                运行全部单元测试（或 python -m unittest discover -s tests）
"""

from __future__ import annotations

import argparse
import sys
import unittest

from .simulation import SimRunner


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="trail_rescue", description="越野赛事保障系统")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("sim", help="离线运行赛事仿真剧本")

    p_serve = sub.add_parser("serve", help="启动指挥 Web 服务")
    p_serve.add_argument("--host", default="0.0.0.0")
    p_serve.add_argument("--port", type=int, default=8080)
    p_serve.add_argument("--data", default="data", help="数据目录")
    p_serve.add_argument("--speed", type=int, default=60,
                         help="仿真倍速（1 仿真秒对应 1/倍速 真实秒）")

    p_test = sub.add_parser("test", help="运行单元测试")
    p_test.add_argument("pattern", nargs="?", default="test_*.py")

    args = parser.parse_args(argv)

    if args.cmd == "sim":
        runner = SimRunner(log=True)
        course = runner.course
        print("=" * 78)
        print(f"  云山越野 30K 保障仿真  赛道 {course.total_m / 1000:.1f}km  "
              f"爬升 {course.points[-1].ele - course.points[0].ele:.0f}m（净）")
        print(f"  危险路段：" + "、".join(
            f"{z.name}({'危急' if z.severity == 'critical' else '警戒'})"
            for z in course.danger_zones))
        print(f"  救护点：" + "、".join(s.name for s in runner.stations))
        print("=" * 78)
        runner.run()
        _summary(runner)
        return 0

    if args.cmd == "serve":
        from .server import RescueServer
        server = RescueServer(host=args.host, port=args.port,
                              data_dir=args.data, speed=args.speed)
        print(f"赛事指挥大屏：http://{args.host if args.host != '0.0.0.0' else 'localhost'}:{args.port}")
        try:
            server.serve()
        except KeyboardInterrupt:
            server.pause_sim()
        return 0

    if args.cmd == "test":
        loader = unittest.TestLoader()
        suite = loader.discover("tests", pattern=args.pattern)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1

    return 1


def _summary(runner: SimRunner) -> None:
    e = runner.engine
    print("\n" + "=" * 78)
    print("赛事总结")
    print("-" * 78)
    finished = [r for r in e.riders.values() if r.status == "finished"]
    print(f"  完赛：{len(finished)}/{len(e.riders)}  "
          + "、".join(f"{r.bib} {r.name}" for r in finished))
    levels = {}
    for a in e.alerts:
        levels.setdefault(a.level, 0)
        levels[a.level] += 1
    print(f"  告警：共 {len(e.alerts)} 起"
          f"（危急 {levels.get('critical', 0)}、警戒 {levels.get('warning', 0)}）")
    print(f"  自动派单：{sum(1 for a in e.alerts if a.dispatch)} 起；"
          f"超时升级：{sum(1 for a in e.alerts if a.escalated)} 起；"
          f"已解除：{sum(1 for a in e.alerts if a.status == 'resolved')} 起")
    for a in e.alerts:
        if not a.dispatch:
            continue
        d = a.dispatch
        print(f"   #{a.id} [{a.bib}] {a.title} -> {d.station_name} "
              f"({d.distance_m / 1000:.1f}km, ETA {d.eta_sec / 60:.0f} 分)"
              + ("  ⏫升级备援" if a.escalated else ""))


if __name__ == "__main__":
    sys.exit(main())
