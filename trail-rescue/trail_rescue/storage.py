"""持久化：事件日志（JSONL 追加）+ 引擎快照（原子写）。

无外部数据库依赖。Web 服务每次告警状态变化落快照，
崩溃重启用 `--resume` 恢复最近快照后重放不丢关键状态。
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .engine import Event


class Store:
    def __init__(self, data_dir: str):
        self.dir = Path(data_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.events_path = self.dir / "events.jsonl"
        self.snapshot_path = self.dir / "snapshot.json"

    def append_event(self, ev: Event) -> None:
        line = json.dumps({"ts": ev.ts, "kind": ev.kind, "data": ev.data},
                          ensure_ascii=False)
        with open(self.events_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def read_events(self) -> list[dict]:
        if not self.events_path.exists():
            return []
        with open(self.events_path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def save_snapshot(self, snap: dict) -> None:
        fd, tmp = tempfile.mkstemp(dir=str(self.dir), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(snap, f, ensure_ascii=False)
            os.replace(tmp, self.snapshot_path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def load_snapshot(self) -> dict | None:
        if not self.snapshot_path.exists():
            return None
        with open(self.snapshot_path, encoding="utf-8") as f:
            return json.load(f)
