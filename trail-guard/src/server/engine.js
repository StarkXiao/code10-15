// 赛事保障判定引擎：纯领域逻辑，时间一律由外部传入（便于模拟与测试）
import { haversine, projectOnPolyline, pointInPolygon, polylineLength } from '../shared/geo.js';
import { RULES, ALERT_TYPES, ALERT_STATUS, RUNNER_STATUS } from '../shared/rules.js';

const AUTO_CLEAR = new Set([
  ALERT_TYPES.DANGER_ENTRY,
  ALERT_TYPES.STALL,
  ALERT_TYPES.PACE_ANOMALY,
  ALERT_TYPES.CUTOFF_RISK,
  ALERT_TYPES.OFFTRACK,
]);

const IN_FLIGHT = new Set([
  ALERT_STATUS.OPEN,
  ALERT_STATUS.DISPATCHED,
  ALERT_STATUS.ACK,
  ALERT_STATUS.ESCALATED,
]);

export function courseLengthM(course) {
  return course.lengthM ?? polylineLength(course.points);
}

export function ensureRuntime(state, bib) {
  state.runtime ??= {};
  state.runtime[bib] ??= {
    active: {}, // type -> alertId（仍在处置链上游、可自动解除的告警）
    zoneUntil: {}, // zoneId -> 离开宽限截止时刻
    insideZones: new Set(),
    paceGraceUntil: 0,
    nextCpIndex: 0,
    lastSpeed: null,
  };
  return state.runtime[bib];
}

const logEvent = (state, t, kind, bib, detail = {}) => {
  state.events.push({ id: state.seq.event++, t, kind, bib, ...detail });
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
};

/** 最近窗口内的平均移动速度 m/s（逐点路程求和，避免投影里程抖动） */
function windowSpeed(runner, t, windowS) {
  const pings = runner.pings;
  if (pings.length < 2) return null;
  const from = t - windowS;
  let dist = 0;
  let start = pings.length - 1;
  for (let i = pings.length - 1; i > 0; i--) {
    if (pings[i].t < from) break;
    dist += haversine(pings[i - 1].pos, pings[i].pos);
    start = i - 1;
  }
  const dt = t - pings[start].t;
  if (dt < 10) return null; // 样本太少不下结论
  return dist / dt;
}

/**
 * 选择最近救护点：
 * 1) 按直线距离排序；
 * 2) 在制任务数达到容量的站点跳过，全部满载时退回最近站并标注过载。
 */
export function selectStation(state, pos) {
  const busy = new Map();
  for (const a of state.alerts) {
    if (a.stationId && ![ALERT_STATUS.RESOLVED].includes(a.status)) {
      busy.set(a.stationId, (busy.get(a.stationId) ?? 0) + 1);
    }
  }
  const ranked = [...state.stations]
    .map((s) => ({ s, d: haversine(pos, s.pos) }))
    .sort((a, b) => a.d - b.d);
  const free = ranked.find(({ s }) => (busy.get(s.id) ?? 0) < RULES.STATION_CAPACITY);
  const pick = free ?? ranked[0];
  return {
    station: pick.s,
    distance: Math.round(pick.d),
    overload: !free,
  };
}

/**
 * 建立告警并自动呼叫最近救护点（核心需求）。
 * 返回 {alert, dispatched}；若在冷却/已有同类在途，则不重复呼叫。
 */
export function raiseAlert(state, t, bib, type, reason, pos) {
  const runner = state.runners.find((r) => r.bib === bib);
  const rt = ensureRuntime(state, bib);
  if (rt.active[type]) return { alert: null, reason: 'active' };

  // critical 的关门超时属于事实状态，不受冷却抑制（风险预警已关闭也必须再报）
  const bypassCooldown = type === ALERT_TYPES.MISSED_CUTOFF;
  if (!bypassCooldown) {
    const last = [...state.alerts]
      .reverse()
      .find((a) => a.bib === bib && a.type === type && a.closedAt != null);
    if (last && t - last.closedAt < RULES.ALERT_COOLDOWN_S) {
      return { alert: null, reason: 'cooldown' };
    }
  }

  const id = `A${String(state.seq.alert++).padStart(3, '0')}`;
  const alert = {
    id,
    bib,
    runnerName: runner?.name ?? bib,
    type,
    pos,
    km: rt.lastProjection ? Math.round((rt.lastProjection.traveled / 1000) * 100) / 100 : null,
    reason,
    openedAt: t,
    updatedAt: t,
    closedAt: null,
    status: ALERT_STATUS.OPEN,
    stationId: null,
    stationName: null,
    dispatchLog: [{ t, action: 'detected', detail: reason }],
  };

  const { station, distance, overload } = selectStation(state, pos);
  alert.stationId = station.id;
  alert.stationName = station.name;
  alert.status = ALERT_STATUS.DISPATCHED;
  alert.dispatchLog.push({
    t,
    action: 'auto_dispatch',
    detail: `自动呼叫最近救护点「${station.name}」，直线 ${distance}m${overload ? '（该站任务已满载，需增援）' : ''}`,
  });
  alert.overload = overload;

  state.alerts.push(alert);
  rt.active[type] = id;
  logEvent(state, t, 'alert_opened', bib, { alertId: id, type, station: station.name, distance });
  return { alert, dispatched: { station, distance, overload } };
}

function autoResolve(state, t, type, bib, detail) {
  const rt = ensureRuntime(state, bib);
  const id = rt.active[type];
  if (!id) return;
  const alert = state.alerts.find((a) => a.id === id);
  delete rt.active[type];
  if (!alert || !IN_FLIGHT.has(alert.status)) return; // 救护已出动/到场，人工收口
  alert.status = ALERT_STATUS.RESOLVED;
  alert.closedAt = t;
  alert.updatedAt = t;
  alert.dispatchLog.push({ t, action: 'auto_resolve', detail });
  logEvent(state, t, 'alert_auto_resolved', bib, { alertId: id, type, detail });
}

/** 处理一条定位上报（真实设备/模拟器走同一条链路） */
export function applyPing(state, t, bib, pos, opts = {}) {
  const runner = state.runners.find((r) => r.bib === bib);
  if (!runner) throw new Error(`未知选手 ${bib}`);
  if (runner.status === RUNNER_STATUS.FINISHED || runner.status === RUNNER_STATUS.DNF) return {};
  runner.status = RUNNER_STATUS.RACING;

  const rt = ensureRuntime(state, bib);
  const proj = projectOnPolyline(pos, state.course.points);
  rt.lastProjection = proj;

  const ping = {
    t,
    pos,
    km: Math.round((proj.traveled / 1000) * 1000) / 1000,
    offtrack: Math.round(proj.dist),
  };
  runner.pings.push(ping);
  if (runner.pings.length > 200) runner.pings.splice(0, runner.pings.length - 200);
  runner.lastPing = ping;

  const elapsed = runner.startOffsetS ? t - runner.startOffsetS : t;

  // 1) 危险路段：进入即呼叫；离开后给宽限再自动解除
  for (const zone of state.dangerZones) {
    const inside = pointInPolygon(pos, zone.polygon);
    if (inside) {
      rt.insideZones.add(zone.id);
      rt.zoneUntil[zone.id] = t + RULES.DANGER_GRACE_S;
      raiseAlert(
        state, t, bib, ALERT_TYPES.DANGER_ENTRY,
        `选手进入危险路段「${zone.name}」（${zone.level}），里程 ${ping.km}km`,
        pos,
      );
    } else if (rt.zoneUntil[zone.id] != null && t > rt.zoneUntil[zone.id]) {
      rt.insideZones.delete(zone.id);
      delete rt.zoneUntil[zone.id];
    }
  }
  if (![...rt.insideZones].some((zid) => (rt.zoneUntil[zid] ?? 0) > t)) {
    autoResolve(state, t, ALERT_TYPES.DANGER_ENTRY, bib, '选手已离开危险路段');
  }

  // 2) 偏航
  if (proj.dist > RULES.GPS_MAX_OFFTRACK_M) {
    raiseAlert(
      state, t, bib, ALERT_TYPES.OFFTRACK,
      `偏离赛道 ${Math.round(proj.dist)}m（阈值 ${RULES.GPS_MAX_OFFTRACK_M}m）`,
      pos,
    );
  } else {
    autoResolve(state, t, ALERT_TYPES.OFFTRACK, bib, '已回到赛道');
  }

  const inPaceGrace = t < rt.paceGraceUntil;

  // 3) 长时间静止
  const stallSpeed = windowSpeed(runner, t, RULES.STALL_WINDOW_S);
  if (stallSpeed != null && elapsed > RULES.STALL_MIN_ELAPSED_S && !inPaceGrace) {
    if (stallSpeed < RULES.STALL_SPEED_MS) {
      raiseAlert(
        state, t, bib, ALERT_TYPES.STALL,
        `近 ${RULES.STALL_WINDOW_S}s 均速 ${stallSpeed.toFixed(2)}m/s，疑似停滞/受伤`,
        pos,
      );
    } else {
      autoResolve(state, t, ALERT_TYPES.STALL, bib, '选手恢复移动');
    }
  }

  // 4) 配速异常（相对本人计划配速）
  const speed = windowSpeed(runner, t, RULES.PACE_WINDOW_S);
  rt.lastSpeed = speed;
  if (speed != null && elapsed > RULES.PACE_MIN_ELAPSED_S && !inPaceGrace) {
    const floor = runner.planPaceMs / RULES.PACE_SLOW_RATIO;
    if (speed < floor) {
      const plan = Math.round(1000 / runner.planPaceMs);
      const actual = Math.round(1000 / speed);
      raiseAlert(
        state, t, bib, ALERT_TYPES.PACE_ANOMALY,
        `当前配速 ${Math.floor(actual / 60)}′${String(actual % 60).padStart(2, '0')}″，计划 ${Math.floor(plan / 60)}′${String(plan % 60).padStart(2, '0')}″，偏差超阈值`,
        pos,
      );
    } else {
      autoResolve(state, t, ALERT_TYPES.PACE_ANOMALY, bib, '配速恢复至计划区间');
    }
  }

  // 5) 关门判定：下一个未打卡 CP（只由检录记录决定，物理投影不能代打卡）
  const checkpoints = state.checkpoints;
  rt.nextCpIndex = 0;
  while (
    rt.nextCpIndex < checkpoints.length &&
    runner.checkins.some((c) => c.cpIndex === rt.nextCpIndex)
  ) {
    rt.nextCpIndex += 1;
  }

  const nextCp = checkpoints[rt.nextCpIndex];
  if (nextCp) {
    if (t > nextCp.cutoffS && runner.status === RUNNER_STATUS.RACING) {
      raiseAlert(
        state, t, bib, ALERT_TYPES.MISSED_CUTOFF,
        `已超过「${nextCp.name}」关门时间（${nextCp.cutoffS / 60} 分钟）`,
        pos,
      );
    } else {
      const v = speed && speed > 0.3 ? speed : runner.planPaceMs;
      const eta = t + Math.max(0, nextCp.km * 1000 - proj.traveled) / v;
      if (
        t > RULES.CUTOFF_GRACE_S &&
        eta > nextCp.cutoffS - RULES.CUTOFF_LEAD_S &&
        t < nextCp.cutoffS
      ) {
        const lateMin = Math.round((eta - nextCp.cutoffS) / 60);
        raiseAlert(
          state, t, bib, ALERT_TYPES.CUTOFF_RISK,
          `按当前配速预计 ${lateMin >= 0 ? '晚到' : '压线'} ${Math.abs(lateMin)} 分钟通过「${nextCp.name}」`,
          pos,
        );
      } else if (t < nextCp.cutoffS) {
        autoResolve(state, t, ALERT_TYPES.CUTOFF_RISK, bib, '配速恢复，预计可按时通过');
      }
    }
  }

  return { projection: proj };
}

/** 检录/打卡：与定位绑定（打卡位置、打卡时刻同时落档） */
export function applyCheckin(state, t, bib, cpIndex, method = 'manual', pos = null) {
  const runner = state.runners.find((r) => r.bib === bib);
  if (!runner) throw new Error(`未知选手 ${bib}`);
  const cp = state.checkpoints[cpIndex];
  if (!cp) throw new Error('未知检查点');
  if (runner.checkins.some((c) => c.cpIndex === cpIndex)) {
    throw new Error(`${runner.name} 已在「${cp.name}」检录`);
  }
  const late = t > cp.cutoffS;
  runner.checkins.push({ cpIndex, t, method, pos, late });
  if (cpIndex === 0 && runner.status === RUNNER_STATUS.DNS) {
    runner.status = RUNNER_STATUS.RACING; // 起点检录即视为已发枪出发
    runner.startOffsetS = t;
  }
  const rt = ensureRuntime(state, bib);
  rt.paceGraceUntil = t + RULES.PACE_GRACE_S;
  rt.nextCpIndex = Math.max(rt.nextCpIndex, cpIndex + 1);
  logEvent(state, t, 'checkin', bib, { cp: cp.name, method, late });

  autoResolve(state, t, ALERT_TYPES.CUTOFF_RISK, bib, `已通过${cp.name}`);

  const isFinish = cpIndex === state.checkpoints.length - 1;
  if (isFinish) {
    runner.status = RUNNER_STATUS.FINISHED;
    runner.finishedAt = t;
    logEvent(state, t, 'finish', bib, {});
    // 完赛即收口其全部可自动关闭告警
    for (const [type, id] of Object.entries(rt.active)) {
      const alert = state.alerts.find((a) => a.id === id);
      delete rt.active[type];
      if (alert && IN_FLIGHT.has(alert.status)) {
        alert.status = ALERT_STATUS.RESOLVED;
        alert.closedAt = t;
        alert.updatedAt = t;
        alert.dispatchLog.push({ t, action: 'auto_resolve', detail: '选手已完赛' });
      }
    }
  } else if (late) {
    raiseAlert(
      state, t, bib, ALERT_TYPES.MISSED_CUTOFF,
      `在「${cp.name}」超时检录（关门 ${cp.cutoffS / 60} 分钟，实际 ${Math.round(t / 60)} 分钟）`,
      pos ?? runner.lastPing?.pos ?? state.stations[0].pos,
    );
  }
  return { late, isFinish };
}

/** 救护点接单/出动/到场/关闭 */
export function updateAlert(state, t, alertId, action, operator = '调度员') {
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!alert) throw new Error('告警不存在');
  const flow = {
    ack: [ALERT_STATUS.DISPATCHED, ALERT_STATUS.ESCALATED, ALERT_STATUS.ACK],
    enroute: [ALERT_STATUS.ACK, ALERT_STATUS.ENROUTE],
    arrived: [ALERT_STATUS.ENROUTE, ALERT_STATUS.ARRIVED],
    resolve: [
      ALERT_STATUS.OPEN,
      ALERT_STATUS.DISPATCHED,
      ALERT_STATUS.ACK,
      ALERT_STATUS.ESCALATED,
      ALERT_STATUS.ENROUTE,
      ALERT_STATUS.ARRIVED,
    ],
  };
  const next = {
    ack: ALERT_STATUS.ACK,
    enroute: ALERT_STATUS.ENROUTE,
    arrived: ALERT_STATUS.ARRIVED,
    resolve: ALERT_STATUS.RESOLVED,
  }[action];
  if (!flow[action].includes(alert.status)) throw new Error(`当前状态 ${alert.status} 不能执行 ${action}`);
  alert.status = next;
  alert.updatedAt = t;
  const labels = { ack: '救护点已接单', enroute: '救护队已出动', arrived: '救护队到达选手位置', resolve: '处置完成，关闭告警' };
  alert.dispatchLog.push({ t, action, detail: `${labels[action]}（${operator}）` });
  if (action === 'resolve') {
    alert.closedAt = t;
    const rt = state.runtime?.[alert.bib];
    for (const [type, id] of Object.entries(rt?.active ?? {})) {
      if (id === alertId) delete rt.active[type];
    }
  }
  logEvent(state, t, `alert_${action}`, alert.bib, { alertId });
  return alert;
}

/** 周期扫描：派单超时自动升级（呼叫次近站点 + 全员响铃） */
export function tickDispatch(state, t) {
  const escalated = [];
  for (const alert of state.alerts) {
    if (alert.status !== ALERT_STATUS.DISPATCHED) continue;
    const lastDispatch = [...alert.dispatchLog].reverse().find((l) => l.action === 'auto_dispatch');
    if (t - (lastDispatch?.t ?? alert.openedAt) < RULES.ACK_TIMEOUT_S) continue;
    alert.status = ALERT_STATUS.ESCALATED;
    alert.updatedAt = t;
    const backup = selectStation(state, alert.pos);
    if (backup.station.id !== alert.stationId) {
      alert.dispatchLog.push({
        t,
        action: 'escalate',
        detail: `超时 ${RULES.ACK_TIMEOUT_S}s 无人接单：升级全员响应，并改呼次近救护点「${backup.station.name}」（${backup.distance}m）`,
      });
    } else {
      alert.dispatchLog.push({
        t,
        action: 'escalate',
        detail: `超时 ${RULES.ACK_TIMEOUT_S}s 无人接单：升级全员响应`,
      });
    }
    escalated.push(alert);
    logEvent(state, t, 'alert_escalated', alert.bib, { alertId: alert.id });
  }
  return escalated;
}

export function markDnf(state, t, bib, reason = '') {
  const runner = state.runners.find((r) => r.bib === bib);
  if (!runner) throw new Error(`未知选手 ${bib}`);
  runner.status = RUNNER_STATUS.DNF;
  runner.dnfAt = t;
  runner.dnfReason = reason;
  logEvent(state, t, 'dnf', bib, { reason });
  const rt = state.runtime?.[bib];
  for (const [type, id] of Object.entries(rt?.active ?? {})) {
    const alert = state.alerts.find((a) => a.id === id);
    delete rt.active[type];
    if (alert && IN_FLIGHT.has(alert.status)) {
      alert.status = ALERT_STATUS.RESOLVED;
      alert.closedAt = t;
      alert.dispatchLog.push({ t, action: 'auto_resolve', detail: '选手退赛' });
    }
  }
}
