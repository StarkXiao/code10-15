// 越野赛事保障系统 —— HTTP/SSE 服务入口
// 零依赖：Node 原生 http；静态前端 + REST + Server-Sent Events
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve } from 'node:path';
import { Store } from './store.js';
import { Simulator } from './simulator.js';
import { applyCheckin, applyPing, markDnf, tickDispatch, updateAlert } from './engine.js';
import { ALERT_META, ALERT_STATUS, RULES, RUNNER_STATUS } from '../shared/rules.js';
import { fmtClock, paceText } from '../shared/geo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, '../../web');
const PORT = Number(process.env.PORT ?? 3700);
const SPEEDS = { 1: 1, 60: 60, 180: 180, 480: 480 };

const store = new Store(process.env.NO_DB ? null : join(__dirname, '../../data/state.json'));
let state = store.state;
const sim = new Simulator(() => state);

// ---------- SSE ----------
const clients = new Set();
function broadcast(reason) {
  const payload = JSON.stringify({ v: store.version, reason });
  for (const res of clients) res.write(`data: ${payload}\n\n`);
}

// ---------- 赛钟循环 ----------
let timer = null;
let speed = 180; // 1 秒真实时间 = 180 秒赛钟
const TICK_S = 0.5;

function startClock() {
  if (timer) return;
  timer = setInterval(() => {
    if (state.race.status !== 'running') return;
    const dt = TICK_S * speed;
    state.race.nowS += dt;
    sim.advance(dt, state.race.nowS);
    const escalated = tickDispatch(state, state.race.nowS);
    if (state.runners.every((r) => [RUNNER_STATUS.FINISHED, RUNNER_STATUS.DNF].includes(r.status))) {
      state.race.status = 'finished';
    }
    store.bump();
    broadcast(escalated.length ? 'escalated' : 'tick');
  }, TICK_S * 1000);
}
startClock();

// ---------- 视图模型 ----------
function snapshot() {
  const openAlerts = state.alerts.filter((a) => !a.closedAt);
  const engaged = new Map();
  for (const a of openAlerts) {
    if (a.stationId) engaged.set(a.stationId, (engaged.get(a.stationId) ?? 0) + 1);
  }
  return {
    now: new Date().toISOString(),
    race: state.race,
    clockText: fmtClock(state.race.nowS),
    course: state.course,
    checkpoints: state.checkpoints,
    dangerZones: state.dangerZones,
    stations: state.stations.map((s) => ({
      ...s,
      engaged: engaged.get(s.id) ?? 0,
      capacity: RULES.STATION_CAPACITY,
    })),
    runners: state.runners.map((r) => {
      const rt = state.runtime?.[r.bib] ?? {};
      const nextCp = state.checkpoints.find((cp) => !r.checkins.some((c) => c.cpIndex === cp.index));
      return {
        bib: r.bib,
        name: r.name,
        deviceId: r.deviceId,
        bound: r.bound,
        color: r.color,
        scenario: r.scenario,
        status: r.status,
        planPaceMs: r.planPaceMs,
        planPaceText: paceText(r.planPaceMs),
        lastPing: r.lastPing ?? null,
        speed: rt.lastSpeed ?? null,
        speedText: rt.lastSpeed ? paceText(rt.lastSpeed) : '—',
        nextCp: nextCp ? nextCp.name : null,
        activeAlertIds: Object.entries(rt.active ?? {}).map(([type, id]) => ({ type, id })),
        checkinCount: r.checkins.length,
        finishedAt: r.finishedAt ?? null,
        dnfReason: r.dnfReason ?? null,
      };
    }),
    alerts: state.alerts
      .slice()
      .reverse()
      .slice(0, 60)
      .map((a) => ({
        ...a,
        meta: ALERT_META[a.type],
        openedAtText: fmtClock(a.openedAt),
        closedAtText: a.closedAt != null ? fmtClock(a.closedAt) : null,
        ageS: a.closedAt == null ? Math.round(state.race.nowS - a.openedAt) : null,
      })),
    events: state.events.slice(-40).reverse().map((e) => ({ ...e, tText: fmtClock(e.t) })),
    rules: RULES,
  };
}

// ---------- HTTP 工具 ----------
const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const readBody = (req) =>
  new Promise((resolveBody, rejectBody) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) rejectBody(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolveBody(buf ? JSON.parse(buf) : {});
      } catch (e) {
        rejectBody(e);
      }
    });
  });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

async function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = join(WEB_DIR, p);
  if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method !== 'POST') return serveStatic(req, res);

  try {
    const body = await readBody(req);
    let changed = true;
    let reason = 'update';

    if (p === '/api/race/start') {
      if (state.race.status === 'running') throw new Error('赛事已在进行中');
      state.race.status = 'running';
      state.race.startedAt = state.race.nowS;
      sim.reset();
      sim.startAll(state.race.nowS);
      reason = 'race_start';
    } else if (p === '/api/race/reset') {
      store.reset();
      state = store.state;
      sim.reset();
      reason = 'race_reset';
    } else if (p === '/api/clock/speed') {
      if (!SPEEDS[body.speed]) throw new Error('不支持的倍速');
      speed = SPEEDS[body.speed];
      reason = 'speed';
    } else if (p === '/api/ping') {
      // 真实设备上报：POST /api/ping {deviceId, lng, lat, t?}
      const runner = state.runners.find((r) => r.bound && r.deviceId === body.deviceId);
      if (!runner) throw new Error('设备未绑定或不存在');
      if (state.race.status !== 'running') throw new Error('赛事未开始');
      const t = typeof body.t === 'number' ? body.t : state.race.nowS;
      applyPing(state, t, runner.bib, [Number(body.lng), Number(body.lat)], { source: 'device' });
      reason = 'ping';
    } else if (p === '/api/bind') {
      const runner = state.runners.find((r) => r.bib === body.bib);
      if (!runner) throw new Error('选手不存在');
      runner.deviceId = String(body.deviceId ?? '').trim();
      runner.bound = !!runner.deviceId;
      reason = 'bind';
    } else if (p === '/api/checkin') {
      const runner = state.runners.find((r) => r.bib === body.bib);
      if (!runner) throw new Error('选手不存在');
      const cpIndex = Number(body.cpIndex);
      const pos = body.lng != null ? [Number(body.lng), Number(body.lat)] : runner.lastPing?.pos ?? null;
      const result = applyCheckin(state, state.race.nowS, runner.bib, cpIndex, body.method ?? 'manual', pos);
      reason = result.late ? 'late_checkin' : 'checkin';
    } else if (p === '/api/alert/action') {
      updateAlert(state, state.race.nowS, body.alertId, body.action, body.operator ?? '调度员');
      reason = `alert_${body.action}`;
    } else if (p === '/api/runner/dnf') {
      const runner = state.runners.find((r) => r.bib === body.bib);
      markDnf(state, state.race.nowS, runner.bib, body.reason ?? '调度员标记退赛');
      reason = 'dnf';
    } else {
      return json(res, 404, { error: '未知接口' });
    }

    if (changed) store.bump();
    broadcast(reason);
    return json(res, 200, { ok: true, reason, state: snapshot() });
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }
});

function SPEDSFix(v) {
  return Number(v);
}

server.listen(PORT, () => {
  console.log(`\n🏔  五云岭越野赛事保障系统`);
  console.log(`   指挥台: http://localhost:${PORT}`);
  console.log(`   虚拟倍速: 1s = ${speed}s 赛钟（默认 180×）\n`);
});
