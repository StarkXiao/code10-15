// 真实 HTTP 冒烟：对着已启动的服务打完整保障链路
// 用法：node scripts/smoke.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://localhost:3700';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};
const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
};
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n== 冒烟测试 ${BASE} ==`);

// 0. 重置并以 480× 推演
let s = await state();
await post('/api/race/reset');
await post('/api/clock/speed', { speed: 480 });

// 1. 发枪
const started = await post('/api/race/start');
ok(started.ok, '发枪开赛');
s = started.state;
ok(s.runners.every((r) => r.status === 'racing'), '8 名选手起点检录后全部进入比赛状态');

// 2. 设备绑定
const bind = await post('/api/bind', { bib: 'A001', deviceId: 'GT-9999' });
ok(bind.ok, '设备 A001 → GT-9999 绑定更新');
s = await state();
ok(s.runners.find((r) => r.bib === 'A001').deviceId === 'GT-9999', '绑定结果可查询');
await post('/api/bind', { bib: 'A001', deviceId: 'GT-1001' });

// 3. 轮询等待危险路段自动呼叫出现（A004 约赛钟 4200s 进入鹰嘴崖）
let danger = null;
for (let i = 0; i < 40; i++) {
  s = await state();
  danger = s.alerts.find((a) => a.type === 'danger_entry' && !a.closedAt);
  if (danger) break;
  await sleep(500);
}
ok(!!danger, '已产生危险路段告警');
if (danger) {
  ok(!!danger.stationId && danger.stationName, `告警已自动呼叫最近救护点：${danger.stationName}`);
  ok(danger.status === 'dispatched' || danger.status === 'escalated', `告警处于派单/升级状态（${danger.status}）`);

  // 4. 处置流
  const ack = await post('/api/alert/action', { alertId: danger.id, action: 'ack' });
  ok(ack.ok, '救护点接单');
  const enr = await post('/api/alert/action', { alertId: danger.id, action: 'enroute' });
  ok(enr.ok, '救护队出动');
  const arr = await post('/api/alert/action', { alertId: danger.id, action: 'arrived' });
  ok(arr.ok, '到达现场');
  const res = await post('/api/alert/action', { alertId: danger.id, action: 'resolve' });
  ok(res.ok, '处置完成关闭');
}

// 5. 静止 / 配速 / 关门 至少出现两类
s = await state();
const types = new Set(s.alerts.map((a) => a.type));
ok(types.has('stall') || types.has('pace_anomaly'), '出现静止或配速异常告警');
ok(types.has('danger_entry'), '危险区呼叫链路完整');

// 6. 每条告警都有派单记录
const noDispatch = s.alerts.filter((a) => !a.dispatchLog.some((l) => l.action === 'auto_dispatch'));
ok(noDispatch.length === 0, '不存在未派单的孤儿告警');

// 7. 事件流
ok(s.events.length > 5, `事件流有记录（${s.events.length} 条）`);

// 8. 手动检录
const ci = await post('/api/checkin', { bib: 'A007', cpIndex: 1, method: 'rfid' });
ok(ci.ok || ci.error?.includes('已在'), 'CP1 手动/RFID 检录被接受或幂等拒绝');

// 9. 等到比赛结束或超时
for (let i = 0; i < 30; i++) {
  s = await state();
  if (s.race.status === 'finished') break;
  await sleep(1500);
}
const finished = s.runners.filter((r) => r.status === 'finished').length;
ok(finished >= 7, `比赛推进后至少 7 人完赛（实际 ${finished}）`);

// 10. SSE 端点可连接
const es = await fetch(`${BASE}/api/events`, { headers: { Accept: 'text/event-stream' } });
ok(es.headers.get('content-type')?.includes('text/event-stream'), 'SSE 事件端点可用');
es.body?.cancel();

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
