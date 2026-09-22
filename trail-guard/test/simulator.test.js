import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/server/seed.js';
import { ensureRuntime, tickDispatch } from '../src/server/engine.js';
import { Simulator } from '../src/server/simulator.js';
import { ALERT_STATUS, ALERT_TYPES, RULES } from '../src/shared/rules.js';

// 完整推演：用虚拟赛钟跑完整场比赛（最高 480×，步长 240s）
function runFull(maxS = 30000) {
  const s = buildSeed();
  s.race.status = 'running';
  const sim = new Simulator(() => s);
  sim.reset();
  sim.startAll(0);
  const dt = 240;
  for (let t = dt; t <= maxS; t += dt) {
    sim.advance(dt, t);
    tickDispatch(s, t);
    if (s.runners.every((r) => r.status === 'finished' || r.status === 'dnf')) break;
  }
  return s;
}

test('联调：发枪自动起点检录；8 名选手均产生连续定位打点', () => {
  const s = runFull();
  for (const r of s.runners) {
    assert.ok(r.checkins.some((c) => c.cpIndex === 0), `${r.bib} 应在起点检录`);
    assert.ok(r.pings.length >= 5, `${r.bib} 应有多个定位点，实际 ${r.pings.length}`);
    // 里程单调不减
    const kms = r.pings.map((p) => p.km);
    for (let i = 1; i < kms.length; i++) assert.ok(kms[i] >= kms[i - 1] - 0.001);
  }
});

test('剧情 danger：A004 许岩进入鹰嘴崖危险区并自动派给最近救护点', () => {
  const s = runFull();
  const alerts = s.alerts.filter((a) => a.bib === 'A004' && a.type === ALERT_TYPES.DANGER_ENTRY);
  assert.ok(alerts.length >= 1, 'A004 应产生危险区告警');
  const a = alerts[0];
  assert.equal(a.status === ALERT_STATUS.DISPATCHED || a.status === ALERT_STATUS.RESOLVED || a.status === ALERT_STATUS.ESCALATED, true);
  assert.ok(a.stationName.includes('石脊'), `最近站应为石脊，实际 ${a.stationName}`);
});

test('剧情 cramp：A005 王蔓抽筋产生静止告警，恢复后自动解除', () => {
  const s = runFull();
  const stalls = s.alerts.filter((a) => a.bib === 'A005' && a.type === ALERT_TYPES.STALL);
  assert.ok(stalls.length >= 1, 'A005 应产生静止告警');
  const first = stalls[0];
  assert.equal(first.closedAt != null || first.status === ALERT_STATUS.DISPATCHED, true);
  // 恢复后继续前进：最终应完赛（引擎中 stall 自动解除）
  const runner = s.runners.find((r) => r.bib === 'A005');
  assert.equal(runner.status, 'finished');
  // 静止告警最终被自动关闭
  assert.ok(stalls.some((a) => a.closedAt != null));
});

test('剧情 cutoff：A006 孙迟出现关门风险/错过关门 critical 告警', () => {
  const s = runFull();
  const runner = s.runners.find((r) => r.bib === 'A006');
  const risk = s.alerts.some(
    (a) => a.bib === 'A006' && [ALERT_TYPES.CUTOFF_RISK, ALERT_TYPES.MISSED_CUTOFF].includes(a.type),
  );
  assert.ok(risk, 'A006 应触发关门相关告警');
  // 若已跑过关门时刻仍未完赛，状态不应是 finished（或存在 missed_cutoff）
  if (s.race.nowS > 11100 && runner.status === 'racing') {
    assert.ok(s.alerts.some((a) => a.bib === 'A006' && a.type === ALERT_TYPES.MISSED_CUTOFF));
  }
});

test('所有派单告警都带救护点；无孤儿 open 告警', () => {
  const s = runFull();
  for (const a of s.alerts) {
    assert.ok(a.stationId, `${a.id} 缺少派单站点`);
    assert.ok(a.dispatchLog.some((l) => l.action === 'auto_dispatch'));
  }
});

test('派单超时：未人工接单时在推演中被自动升级或保持合理状态', () => {
  const s = runFull();
  // A004 的危险告警在 45s 内无人为 ack，tickDispatch 应将其升级
  const danger = s.alerts.find((a) => a.bib === 'A004' && a.type === ALERT_TYPES.DANGER_ENTRY);
  assert.ok(danger);
  assert.ok(
    [ALERT_STATUS.ESCALATED, ALERT_STATUS.RESOLVED].includes(danger.status),
    `超时未接单应已升级或已自动解除，实际 ${danger.status}`,
  );
});
