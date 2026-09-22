import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/server/seed.js';
import {
  applyCheckin,
  applyPing,
  ensureRuntime,
  markDnf,
  selectStation,
  tickDispatch,
  updateAlert,
} from '../src/server/engine.js';
import { lateralOffsetPoint, offsetMeters, pointAtKm, polylineLength } from '../src/shared/geo.js';
import { ALERT_STATUS, ALERT_TYPES, RULES } from '../src/shared/rules.js';

function freshState() {
  const s = buildSeed();
  s.race.status = 'running';
  for (const r of s.runners) ensureRuntime(s, r.bib);
  return s;
}
const atKm = (s, km, lateral = 0) => {
  const { index, t, point } = pointAtKm(s.course.points, km * 1000);
  return lateral === 0 ? point : lateralOffsetPoint(s.course.points, index, t, lateral);
};

test('种子数据：赛道约 21km、6 个检查点、3 危险区、4 救护点、8 选手', () => {
  const s = freshState();
  const km = polylineLength(s.course.points) / 1000;
  assert.ok(km > 18 && km < 25, `赛道长度 ${km}km`);
  assert.equal(s.checkpoints.length, 6);
  assert.equal(s.dangerZones.length, 3);
  assert.equal(s.stations.length, 4);
  assert.equal(s.runners.length, 8);
});

test('进入危险路段：自动呼叫最近救护点（dispatch 状态 + stationId）', () => {
  const s = freshState();
  const bib = 'A007'; // 无剧情选手
  // 直接在 D1 危险区多边形内部打点（走廊 ±45m，偏移 28m 必在内部）
  const zoneKm = 8.4;
  const { index, t } = pointAtKm(s.course.points, zoneKm * 1000);
  const pos = lateralOffsetPoint(s.course.points, index, t, 15);
  applyPing(s, 400, bib, pos);
  const alert = s.alerts.find((a) => a.bib === bib && a.type === ALERT_TYPES.DANGER_ENTRY);
  assert.ok(alert, '应产生危险区告警');
  assert.equal(alert.status, ALERT_STATUS.DISPATCHED);
  assert.ok(alert.stationId === 'S2', `应派给 CP2 石脊救护点，实际 ${alert.stationId}`);
  assert.ok(alert.dispatchLog.some((l) => l.action === 'auto_dispatch'));
});

test('离开危险路段超过宽限：自动解除（未出动时）', () => {
  const s = freshState();
  const bib = 'A007';
  const { index, t } = pointAtKm(s.course.points, 8.4 * 1000);
  applyPing(s, 400, bib, lateralOffsetPoint(s.course.points, index, t, 15));
  const t0 = 400 + RULES.DANGER_GRACE_S + 5;
  applyPing(s, t0, bib, atKm(s, 11.5));
  const alert = s.alerts.find((a) => a.bib === bib && a.type === ALERT_TYPES.DANGER_ENTRY);
  assert.equal(alert.status, ALERT_STATUS.RESOLVED);
  assert.equal(alert.closedAt, t0);
});

test('静止异常：连续低速窗口触发 stall 并派单，恢复移动自动解除', () => {
  const s = freshState();
  const bib = 'A002';
  // 以约 0.2m/s 移动 240s（约 48m），先跑出起步宽限
  let t = 600;
  for (let i = 0; i < 6; i++) {
    const pos = atKm(s, 3.0 + (0.2 * (i + 1) * 50) / 1000);
    t += 50;
    applyPing(s, t, bib, pos);
  }
  const stall = s.alerts.find((a) => a.bib === bib && a.type === ALERT_TYPES.STALL);
  assert.ok(stall, '应触发静止告警');
  assert.equal(stall.status, ALERT_STATUS.DISPATCHED);

  // 恢复正常速度前进
  const resumeT = t + 60;
  for (let i = 1; i <= 4; i++) {
    applyPing(s, resumeT + i * 55, bib, atKm(s, 3.1 + i * 0.25));
  }
  assert.equal(stall.status, ALERT_STATUS.RESOLVED);
});

test('配速异常：显著慢于计划配速触发 pace_anomaly；CP 打卡宽限期内不误报', () => {
  const s = freshState();
  const bib = 'A001'; // 计划 8′/km ≈ 2.08m/s
  let t = 600;
  // 0.9m/s 连续打点（慢于阈值 2.08/1.6≈1.30）
  for (let i = 1; i <= 5; i++) {
    t += 55;
    applyPing(s, t, bib, atKm(s, 2.0 + (0.9 * (t - 600)) / 1000));
  }
  const slow = s.alerts.find((a) => a.bib === bib && a.type === ALERT_TYPES.PACE_ANOMALY);
  assert.ok(slow, '应触发配速异常');

  // CP 打卡后 grace 窗口内极慢移动不应新开告警（关闭旧告警后）
  updateAlert(s, t, slow.id, 'resolve', '测试员');
  applyCheckin(s, t + 5, bib, 1, 'manual', atKm(s, 5.2));
  const t2 = t + 30;
  applyPing(s, t2, bib, atKm(s, 5.21));
  applyPing(s, t + 60, bib, atKm(s, 5.22));
  const again = s.alerts.filter((a) => a.bib === bib && a.type === ALERT_TYPES.PACE_ANOMALY && a.status !== ALERT_STATUS.RESOLVED);
  assert.equal(again.length, 0, '检录宽限期内不应重新报警');
});

test('冷却：同类告警关闭后 600s 内不重复呼叫', () => {
  const s = freshState();
  const bib = 'A001';
  let t = 600;
  for (let i = 1; i <= 5; i++) {
    t += 55;
    applyPing(s, t, bib, atKm(s, 2.0 + (0.9 * (t - 600)) / 1000));
  }
  const first = s.alerts.filter((a) => a.bib === bib && a.type === ALERT_TYPES.PACE_ANOMALY).at(-1);
  updateAlert(s, t, first.id, 'resolve', '测试员');
  const paceBefore = s.alerts.filter((a) => a.type === ALERT_TYPES.PACE_ANOMALY).length;
  applyPing(s, t + 300, bib, atKm(s, (2.0 + (0.9 * (t - 600)) / 1000) + 0.04));
  const paceAfter = s.alerts.filter((a) => a.type === ALERT_TYPES.PACE_ANOMALY).length;
  assert.equal(paceAfter, paceBefore, '冷却期内不应产生新的配速告警');
});

test('关门风险与错过关门：ETA 超关门预警；超过 cutoffS 升级为 critical', () => {
  const s = freshState();
  const bib = 'A006'; // 11.5′/km ≈ 1.45m/s，CP3 关门 11100s
  const v = s.runners.find((r) => r.bib === bib).planPaceMs;
  let km = 0;
  let t = 0;
  let sawRisk = false;
  for (let i = 0; i < 90; i++) {
    t += 120;
    km += (v * 120) / 1000;
    const stopKm = s.checkpoints[3].km - 0.8; // 停在 CP3 之前（避免误入 D2 走廊）
    applyPing(s, t, bib, atKm(s, Math.min(km, stopKm)));
    if (s.alerts.some((a) => a.bib === bib && a.type === ALERT_TYPES.CUTOFF_RISK && !a.closedAt)) {
      sawRisk = true;
      break;
    }
  }
  assert.ok(sawRisk, '应先出现关门风险预警');
  // 继续拖到超过 CP3 关门
  let k2 = km;
  while (t <= s.checkpoints[3].cutoffS + 200) {
    t += 120;
    k2 += (v * 120) / 1000;
    applyPing(s, t, bib, atKm(s, Math.min(k2, s.checkpoints[3].km - 0.8)));
  }
  const missed = s.alerts.find((a) => a.bib === bib && a.type === ALERT_TYPES.MISSED_CUTOFF);
  assert.ok(missed, '超过 CP3 关门后应产生 missed_cutoff');
  assert.equal(missed.status, ALERT_STATUS.DISPATCHED);
});

test('派单升级：45s 未接单自动 escalated 并写升级日志', () => {
  const s = freshState();
  const bib = 'A007';
  const { index, t } = pointAtKm(s.course.points, 8.4 * 1000);
  applyPing(s, 400, bib, lateralOffsetPoint(s.course.points, index, t, 15));
  const alert = s.alerts.find((a) => a.type === ALERT_TYPES.DANGER_ENTRY && a.bib === bib);
  const esc = tickDispatch(s, 400 + RULES.ACK_TIMEOUT_S + 1);
  assert.equal(esc.length, 1);
  assert.equal(alert.status, ALERT_STATUS.ESCALATED);
  assert.ok(alert.dispatchLog.some((l) => l.action === 'escalate'));
});

test('处置流：ack → enroute → arrived → resolve；非法跳转被拒绝', () => {
  const s = freshState();
  const bib = 'A007';
  const { index, t } = pointAtKm(s.course.points, 8.4 * 1000);
  applyPing(s, 400, bib, lateralOffsetPoint(s.course.points, index, t, 15));
  const alert = s.alerts.at(-1);
  updateAlert(s, 410, alert.id, 'ack');
  assert.equal(alert.status, ALERT_STATUS.ACK);
  assert.throws(() => updateAlert(s, 411, alert.id, 'arrived'), /不能执行/);
  updateAlert(s, 420, alert.id, 'enroute');
  updateAlert(s, 430, alert.id, 'arrived');
  updateAlert(s, 440, alert.id, 'resolve');
  assert.equal(alert.status, ALERT_STATUS.RESOLVED);
  assert.equal(alert.closedAt, 440);
});

test('救护点容量：满载后新告警改派次近空闲站点', () => {
  const s = freshState();
  // S2（CP2 石脊）对崖壁附近最近；制造两起落在 D1 的不同选手告警占满容量
  ['A001', 'A002'].forEach((bib, i) => {
    const p = pointAtKm(s.course.points, (8.0 + i * 0.4) * 1000);
    applyPing(s, 400 + i * 5, bib, lateralOffsetPoint(s.course.points, p.index, p.t, -15));
  });
  const s2Jobs = s.alerts.filter((a) => a.stationId === 'S2').length;
  assert.equal(s2Jobs, 2, 'S2 应接到 2 起任务');
  // 第三起：S2 满载，应派给其他空闲站
  {
    const p = pointAtKm(s.course.points, 8.6 * 1000);
    applyPing(s, 420, 'A003', lateralOffsetPoint(s.course.points, p.index, p.t, -15));
  }
  const third = s.alerts.find((a) => a.bib === 'A003' && a.type === ALERT_TYPES.DANGER_ENTRY);
  assert.ok(third, '第三起危险区告警应被建立');
  assert.notEqual(third.stationId, 'S2', 'S2 满载后应改派其他救护点');
  assert.equal(third.overload, false, '次近站点空闲，不应标过载');
});

test('selectStation：无任务时返回物理最近站点', () => {
  const s = freshState();
  const nearS2 = atKm(s, 10.8);
  const { station } = selectStation(s, nearS2);
  assert.equal(station.id, 'S2');
});

test('检录：重复检录拒绝；终点检录判完赛并收口在途告警', () => {
  const s = freshState();
  const bib = 'A007';
  applyCheckin(s, 100, bib, 1, 'auto', atKm(s, 5.2));
  assert.throws(() => applyCheckin(s, 120, bib, 1), /已在/);
  const { index, t } = pointAtKm(s.course.points, 8.4 * 1000);
  applyPing(s, 400, bib, lateralOffsetPoint(s.course.points, index, t, 15));
  const finishIdx = s.checkpoints.length - 1;
  applyCheckin(s, 5000, bib, finishIdx, 'auto', atKm(s, 21.2));
  const runner = s.runners.find((r) => r.bib === bib);
  assert.equal(runner.status, 'finished');
  for (const a of s.alerts.filter((x) => x.bib === bib)) {
    if (!a.closedAt) assert.fail('完赛后不应残留开放告警');
  }
});

test('退赛：markDnf 收口全部在途告警', () => {
  const s = freshState();
  const bib = 'A008';
  const { index, t } = pointAtKm(s.course.points, 14.5 * 1000);
  applyPing(s, 700, bib, lateralOffsetPoint(s.course.points, index, t, 20));
  markDnf(s, 800, bib, '测试退赛');
  const runner = s.runners.find((r) => r.bib === bib);
  assert.equal(runner.status, 'dnf');
  assert.ok(s.alerts.every((a) => a.bib !== bib || a.closedAt != null));
});

test('偏航：远离赛道超过阈值触发 offtrack，回到赛道自动解除', () => {
  const s = freshState();
  const bib = 'A007';
  const far = offsetMeters(atKm(s, 6.0), 600, 0);
  applyPing(s, 500, bib, far);
  const off = s.alerts.find((a) => a.bib === bib && a.type === ALERT_TYPES.OFFTRACK);
  assert.ok(off);
  applyPing(s, 700, bib, atKm(s, 6.3));
  assert.equal(off.status, ALERT_STATUS.RESOLVED);
});
