# 🏔 Trail Guard · 越野赛事保障系统

绑定选手的**定位设备与检录数据**，实时监测赛道态势。当选手

- **进入危险路段**（崖壁 / 滚石 / 溪谷等划定区域），或
- **配速异常**（长时间静止、显著掉速、关门风险、错过关门、偏航）

系统**自动呼叫距选手最近的救护点**，生成带完整处置链的告警；救护点超时未接单自动升级。调度员在一块指挥台上完成态势监视、接单、出动、到场、收口的闭环。

零外部依赖：Node.js 原生 `http` + Canvas 前端，无需数据库 / 构建步骤。

---

## 快速开始

要求 Node.js ≥ 20.11。

```bash
npm start            # 启动：http://localhost:3700
npm test             # 26 项单元/集成测试（纯逻辑，不起服务）
node scripts/smoke.mjs   # 18 项真实 HTTP 冒烟（先 npm start）
```

打开指挥台 → **▶ 发枪开赛**，默认以 **180× 虚拟赛钟**推演（1 秒真实时间 = 3 分钟赛钟）。8 名选手中预置了 3 段异常剧情：

| 选手 | 剧情 | 触发的告警 |
| --- | --- | --- |
| A004 许岩 | 鹰嘴崖临崖路段摔倒，贴线爬行 | `danger_entry`（critical）→ 自动呼叫 CP2 石脊救护点 |
| A005 王蔓 | 约 8′40″ 处抽筋静止 5 分钟 | `stall` → 恢复移动后自动解除 |
| A006 孙迟 | 全程掉速至计划 55% | `pace_anomaly` / `cutoff_risk` / `missed_cutoff` |

可切换 1× / 60× / 180× / 480× 倍速；随时「↺ 重置演练」。

---

## 保障链路

```
GPS/北斗设备 ──HTTP──┐
                     ├─→ 定位投影（赛道折线里程、偏离距离）
检录/RFID 打卡 ──────┘            │
                                 ├─ 危险区多边形命中（射线法）
                                 ├─ 静止：近 180s 均速 < 0.45 m/s
                                 ├─ 配速：240s 平滑速度 < 计划 × 1/1.6
                                 ├─ 关门：下一未打卡 CP 的 ETA 预测
                                 └─ 偏航：偏离赛道 > 120m
                                              │
                              满足任一条件 → raiseAlert
                                              │
                    selectStation：直线最近 + 站点容量（每站 2 任务）
                                              │
                    自动派单（dispatched）→ SSE/声光推送到指挥台
                                              │
            45s 未接单 → escalated（全员响铃，改呼次近站）
                                              │
            接单 → 出动 → 到场 → 处置完成（状态机，不可跳步）
```

**自动解除**：危险区离开 60s 宽限、恢复移动、配速回到区间、已通过 CP、完赛 / 退赛——
但一旦救护队已接单/出动/到场，告警**只能人工收口**，系统不替救护队做决定。

**防骚扰**：同一选手同类告警关闭后 600s 冷却；CP 打卡后 90s 配速宽限（补水降速不误报）；
起点 120s 内不判静止、300s 内不判配速。错过关门属于事实状态，不受冷却抑制。

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量态势快照（赛道/危险区/救护点/选手/告警/事件） |
| GET | `/api/events` | SSE：状态变化时推送 `{v, reason}` |
| POST | `/api/race/start` · `/api/race/reset` | 发枪 / 重置演练 |
| POST | `/api/clock/speed` | `{speed: 1\|60\|180\|480}` 虚拟赛钟倍速 |
| POST | `/api/ping` | **真实设备上报** `{deviceId, lng, lat}` |
| POST | `/api/bind` | 设备与选手绑定 `{bib, deviceId}` |
| POST | `/api/checkin` | 检录打卡 `{bib, cpIndex, method}`，可带定位 |
| POST | `/api/alert/action` | `{alertId, action: ack\|enroute\|arrived\|resolve}` |
| POST | `/api/runner/dnf` | 标记退赛并收口其在途告警 |

设备直接打这个即可接入：

```bash
curl -X POST http://localhost:3700/api/ping \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"GT-1004","lng":120.061,"lat":30.244}'
```

---

## 目录结构

```text
trail-guard/
├─ src/
│  ├─ shared/
│  │  ├─ geo.js          # Haversine、折线投影里程、点在多边形、法向偏移（前后端共用）
│  │  └─ rules.js        # 全部阈值、告警类型/状态枚举与中文元数据
│  └─ server/
│     ├─ engine.js       # 判定引擎：定位→告警→派单→升级→解除（纯函数式，时间外部注入）
│     ├─ simulator.js    # 赛钟模拟器：分段积分 + 精确 CP 跨越时刻 + 异常剧情
│     ├─ seed.js         # 21.2km 赛道：6 CP / 3 危险区 / 4 救护点 / 8 选手
│     ├─ store.js        # JSON 落盘（防抖，Set 兼容）
│     └─ index.js        # HTTP + SSE + 赛钟循环
├─ web/                  # 指挥台：index.html / styles.css / app.js（Canvas 战术图）
├─ scripts/smoke.mjs     # 真实 HTTP 冒烟（18 项断言）
└─ test/                 # node:test — geo 6 项、engine 14 项、联调 6 项
```

## 关键设计取舍

1. **里程口径唯一**：赛道手工坐标在种子阶段归一化到标称 21.2km（经纬度增量等比缩放），CP、危险区、模拟器全部以「折线上的米数」为唯一口径，避免标称公里与折线长度错位。
2. **判定引擎与时间解耦**：所有规则函数由参数接收赛钟时刻，模拟器与真实设备走同一条 `applyPing` 链路；测试可任意跳转时间。
3. **投影用局部米制平面 + 球面复核**：高纬度长折线段平面投影参数有偏差，段内插值再用 Haversine 距离比复核。
4. **「下一个未打卡 CP」只由检录记录决定**：物理经过不代打卡——定位漂移到 CP 附近不会让关门判定跳点。
5. **容量即过滤、满载即兜底**：选站时跳过在制任务达容量的站点；全网满载时退回物理最近站并标 `overload`，保证任何告警都有承接方。
6. **持久化**：状态变更防抖写 `data/state.json`；`/api/race/reset` 清空回到种子。
