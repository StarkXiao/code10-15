// 指挥台前端：原生 JS + Canvas 战术地图，SSE 实时驱动
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let S = null;
let seenAlerts = new Set();
let criticalFlash = 0;

// ---------- API ----------
const api = async (path, body) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) toast('⚠ ' + data.error, true);
  return data;
};

async function refresh() {
  const res = await fetch('/api/state');
  S = await res.json();
  render();
}

// ---------- SSE（断线自动退化为轮询） ----------
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = () => refresh();
  es.onerror = () => es.close();
}
setInterval(() => {
  // 兜底：SSE 异常时也能更新
  if (!document.hidden) refresh();
}, 4000);
connectSSE();

// ---------- 声光告警 ----------
let audioCtx = null;
function beep(level) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = level === 'critical' ? [880, 660, 880] : [660, 520];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      o.type = 'square';
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.15);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.18);
      o.stop(now + i * 0.18 + 0.16);
    });
  } catch {
    /* 浏览器未允许音频时静默 */
  }
}

// ---------- 渲染 ----------
const STATUS_LABEL = { dns: '未出发', racing: '比赛中', dnf: '退赛', finished: '完赛' };

function render() {
  $('#clock').textContent = S.clockText;
  $('#race-status').textContent =
    S.race.status === 'running' ? '● 比赛进行中' : S.race.status === 'finished' ? '■ 比赛结束' : '○ 未发枪';
  $('#btn-start').disabled = S.race.status === 'running';
  $('#runner-count').textContent = `共 ${S.runners.length} 人`;

  const openCritical = S.alerts.filter((a) => !a.closedAt && a.meta.level === 'critical');
  const badge = $('#alert-badge');
  const openCount = S.alerts.filter((a) => !a.closedAt).length;
  badge.textContent = openCount;
  badge.className = openCount ? '' : 'zero';
  if (openCritical.length) {
    criticalFlash = 1;
    document.title = `🔴 ${openCritical.length} 起紧急 - 赛事保障指挥台`;
  } else {
    document.title = '五云岭越野赛事保障指挥台';
  }

  for (const a of S.alerts) {
    if (!seenAlerts.has(a.id)) {
      seenAlerts.add(a.id);
      if (!a.closedAt) beep(a.meta.level);
    }
  }

  renderRunners();
  renderAlerts();
  renderEvents();
  drawMap();
  fillOpsSelects();
}

function renderRunners() {
  const el = $('#runner-list');
  el.innerHTML = S.runners
    .map((r) => {
      const tags = r.activeAlertIds
        .map(({ type }) => {
          const meta = alertMeta(type);
          return `<span class="tag ${meta.level}">${meta.icon} ${meta.label}</span>`;
        })
        .join('');
      const scenario =
        r.scenario === 'danger' ? '<span class="tag warning">剧情:崖壁</span>'
        : r.scenario === 'cramp' ? '<span class="tag warning">剧情:抽筋</span>'
        : r.scenario === 'cutoff' ? '<span class="tag warning">剧情:掉速</span>'
        : '';
      const km = r.lastPing ? `${r.lastPing.km.toFixed(1)}km` : '—';
      return `
      <div class="runner ${r.activeAlertIds.length ? 'has-alert' : ''}" data-bib="${r.bib}">
        <div class="r1">
          <span class="chip">${r.bib}</span>
          <span class="name" style="color:${r.color}">${r.name}</span>
          <span class="st ${r.status}">${STATUS_LABEL[r.status]}</span>
        </div>
        <div class="r2">
          <span>里程 <b>${km}</b></span>
          <span>当前 <b>${r.speedText}</b></span>
          <span>计划 <b>${r.planPaceText}</b></span>
        </div>
        <div class="r2"><span>下一点 <b>${r.nextCp ?? '—'}</b></span><span>设备 <b>${r.bound ? r.deviceId : '未绑定'}</b></span></div>
        <div class="tags">${tags}${scenario}</div>
      </div>`;
    })
    .join('');
}

function alertMeta(type) {
  // 与后端 ALERT_META 保持同步（界面侧轻量副本）
  const map = {
    danger_entry: { label: '进入危险路段', level: 'critical', icon: '⛰' },
    stall: { label: '长时间静止', level: 'warning', icon: '⏸' },
    pace_anomaly: { label: '配速异常', level: 'warning', icon: '🐢' },
    cutoff_risk: { label: '关门风险', level: 'warning', icon: '⏳' },
    missed_cutoff: { label: '已错过关门', level: 'critical', icon: '🚷' },
    offtrack: { label: '偏航', level: 'warning', icon: '🧭' },
  };
  return map[type] ?? { label: type, level: 'warning', icon: '!' };
}

const STATUS_TEXT = {
  open: '待派单', dispatched: '已呼叫·待接单', ack: '已接单',
  enroute: '出动中', arrived: '已到场', resolved: '已关闭', escalated: '已升级',
};

function renderAlerts() {
  const el = $('#alert-list');
  const open = S.alerts.filter((a) => !a.closedAt);
  const closed = S.alerts.filter((a) => a.closedAt).slice(0, 12);
  const list = [...open, ...closed];
  if (!list.length) {
    el.innerHTML = '<div class="empty">暂无告警<br/><small>系统正在持续监测危险路段进入、静止、配速、关门与偏航</small></div>';
    return;
  }
  el.innerHTML = list.map((a) => {
    const closed = !!a.closedAt;
    const btns = [];
    if (!closed) {
      if (a.status === 'dispatched' || a.status === 'escalated') btns.push(['ack', '✓ 接单', 'go']);
      if (a.status === 'ack') btns.push(['enroute', '🚑 已出动', 'go']);
      if (a.status === 'enroute') btns.push(['arrived', '📍 到达现场', 'go']);
      if (a.status === 'arrived') btns.push(['resolve', '✅ 处置完成', 'go']);
      btns.push(['resolve', '关闭']);
    }
    return `
    <div class="alert ${a.meta.level} ${closed ? 'resolved' : ''}" data-id="${a.id}">
      <div class="a-head">
        <span class="a-type">${a.meta.icon} ${a.meta.label}</span>
        <span class="a-id">${a.id}</span>
        <span class="status-pill ${a.status}">${STATUS_TEXT[a.status]}</span>
        <span class="a-age">${closed ? a.closedAtText : (a.ageS != null ? Math.floor(a.ageS / 60) + '′' + String(a.ageS % 60).padStart(2, '0') : '')}</span>
      </div>
      <div class="a-reason">${a.bib} ${a.runnerName}${a.km != null ? ` · ${a.km}km` : ''} — ${a.reason}</div>
      <div class="a-dispatch ${a.overload ? 'overload' : ''}">📟 已自动呼叫：<b>${a.stationName}</b>${a.overload ? '（站点满载，需增援）' : ''} · ${a.openedAtText}</div>
      <div class="a-log">${a.dispatchLog.slice(-3).map((l) => `<div>▸ ${fmtT(l.t)} ${l.detail}</div>`).join('')}</div>
      <div class="a-actions">
        ${btns.map(([act, label, cls]) => `<button data-act="${act}" class="${cls ?? ''}">${label}</button>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderEvents() {
  const KIND = {
    alert_opened: '🚨 告警', alert_auto_resolved: '♻ 自动解除', alert_ack: '接单',
    alert_enroute: '出动', alert_arrived: '到场', alert_resolve: '关闭',
    alert_escalated: '⬆ 升级', checkin: '✔ 检录', cp_passed: '· 过点',
    finish: '🏁 完赛', dnf: '✖ 退赛',
  };
  $('#event-log').innerHTML = S.events
    .map((e) => `<div class="ev"><span class="et">${e.tText}</span><span class="ek">${KIND[e.kind] ?? e.kind}</span><span class="ed">${e.bib} ${e.detail ?? e.type ?? e.cp ?? ''}</span></div>`)
    .join('');
}

const fmtT = (s) => {
  s = Math.round(s);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
};

function fillOpsSelects() {
  const opts = S.runners.map((r) => `<option value="${r.bib}">${r.bib} ${r.name}</option>`).join('');
  if ($('#bind-bib').dataset.filled !== '1') {
    $('#bind-bib').innerHTML = opts;
    $('#ci-bib').innerHTML = opts;
    $('#ci-cp').innerHTML = S.checkpoints.map((cp) => `<option value="${cp.index}">${cp.name}（关门 ${fmtT(cp.cutoffS)}）</option>`).join('');
    $('#bind-bib').dataset.filled = '1';
  }
}

// ---------- Canvas 战术地图 ----------
const canvas = $('#map');
const ctx = canvas.getContext('2d');
let view = null;

function buildView() {
  const pts = [...S.course.points];
  for (const z of S.dangerZones) pts.push(...z.polygon);
  const lat0 = S.course.points[0][1];
  const k = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = ([lng, lat]) => [(lng - pts.reduce((m, p) => Math.min(m, p[0]), Infinity)) * k, (lat - pts.reduce((m, p) => Math.min(m, p[1]), Infinity)) * 111320];
  const all = pts.map(xy);
  const minX = Math.min(...all.map((p) => p[0]));
  const maxX = Math.max(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1]));
  const maxY = Math.max(...all.map((p) => p[1]));
  const pad = 46;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const scale = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
  view = {
    xy: (p) => [(xy(p)[0] - minX) * scale + pad, h - ((xy(p)[1] - minY) * scale + pad)],
    w, h,
  };
}

function drawMap() {
  if (!S) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  ctx.clearRect(0, 0, w, h);
  buildView();
  const P = view.xy;

  // 危险区
  for (const z of S.dangerZones) {
    ctx.beginPath();
    z.polygon.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(239,68,68,0.14)';
    ctx.strokeStyle = 'rgba(239,68,68,0.65)';
    ctx.setLineDash([5, 4]);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.setLineDash([]);
    const cx = z.polygon.reduce((s, p) => s + p[0], 0) / z.polygon.length;
    const cy = z.polygon.reduce((s, p) => s + p[1], 0) / z.polygon.length;
    const [tx, ty] = P([cx, cy]);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(252,165,165,.95)';
    ctx.textAlign = 'center';
    ctx.fillText(`⚠ ${z.name}(${z.level})`, tx, ty);
  }

  // 赛道
  ctx.beginPath();
  S.course.points.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = 'rgba(148,197,255,.35)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  S.course.points.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // 检查点
  ctx.textAlign = 'left';
  for (const cp of S.checkpoints) {
    // CP 位置：用 course points 中的里程近似——直接按 polyline 比例取点
    const p = pointOnCourse(cp.km * 1000);
    const [x, y] = P(p);
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = cp.index === 0 || cp.index === S.checkpoints.length - 1 ? '#0ea5e9' : '#38bdf8';
    ctx.fill();
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#bae6fd';
    ctx.fillText(cp.name, x + 8, y - 6);
    ctx.fillStyle = '#64748b';
    ctx.fillText(`关门 ${fmtT(cp.cutoffS)}`, x + 8, y + 8);
  }

  // 救护点
  for (const st of S.stations) {
    const [x, y] = P(st.pos);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    const overload = st.engaged >= st.capacity;
    ctx.fillStyle = overload ? '#f97316' : '#22c55e';
    ctx.fillRect(-6, -6, 12, 12);
    ctx.strokeStyle = '#052e16';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-6, -6, 12, 12);
    ctx.restore();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = overload ? '#fdba74' : '#86efac';
    ctx.fillText(`✚ ${st.name}`, x + 9, y + 4);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText(`${st.engaged}/${st.capacity} 任务`, x + 9, y + 17);
  }

  // 选手
  for (const r of S.runners) {
    if (!r.lastPing) continue;
    const [x, y] = P(r.lastPing.pos);
    const hasAlert = r.activeAlertIds.length > 0;
    if (hasAlert) {
      const pulse = 8 + Math.sin(Date.now() / 200) * 3;
      ctx.beginPath();
      ctx.arc(x, y, pulse + 5, 0, Math.PI * 2);
      ctx.strokeStyle = r.activeAlertIds.some((a) => isCritical(a.type)) ? 'rgba(239,68,68,.9)' : 'rgba(245,158,11,.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = r.status === 'finished' ? '#38bdf8' : r.status === 'dnf' ? '#64748b' : r.color;
    ctx.fill();
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = 'bold 10px Consolas';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(r.bib, x + 7, y - 6);
  }
}

function isCritical(type) {
  return type === 'danger_entry' || type === 'missed_cutoff';
}

// 按里程（米）在赛道折线上取点
function pointOnCourse(meters) {
  const pts = S.course.points;
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segLen(pts[i], pts[i + 1]);
    segs.push(d);
    total += d;
  }
  let target = Math.min(meters, total);
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i]) {
      const t = target / segs[i];
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    target -= segs[i];
  }
  return pts[pts.length - 1];
}
function segLen(a, b) {
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180) * 111320;
  const dy = (b[1] - a[1]) * 111320;
  return Math.hypot(dx, dy);
}
window.addEventListener('resize', () => S && drawMap());
setInterval(() => S && drawMap(), 400); // 脉冲动画

// ---------- 交互 ----------
$('#alert-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.alert').dataset.id;
  await api('/api/alert/action', { alertId: id, action: btn.dataset.act });
});

$('#btn-start').addEventListener('click', async () => {
  await api('/api/race/start');
  seenAlerts = new Set();
  toast('发枪！选手已从起点出发');
});
$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('重置演练数据？当前告警与定位将清空。')) return;
  await api('/api/race/reset');
  seenAlerts = new Set();
  toast('已重置');
});
$('#speed-group').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-speed]');
  if (!b) return;
  $$('#speed-group button').forEach((x) => x.classList.toggle('on', x === b));
  await api('/api/clock/speed', { speed: Number(b.dataset.speed) });
});
$('#btn-bind').addEventListener('click', async () => {
  const r = await api('/api/bind', { bib: $('#bind-bib').value, deviceId: $('#bind-device').value });
  if (r.ok) toast('绑定已更新');
});
$('#btn-checkin').addEventListener('click', async () => {
  const r = await api('/api/checkin', {
    bib: $('#ci-bib').value,
    cpIndex: Number($('#ci-cp').value),
    method: $('#ci-method').value,
  });
  if (r.ok) toast(r.reason === 'late_checkin' ? '已记录超时检录并触发告警' : '检录成功');
});

$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
    $$('.tab-page').forEach((p) => p.classList.toggle('on', p.id === `tab-${t.dataset.tab}`));
  }),
);

// DNF 标记
$('#runner-list').addEventListener('click', async (e) => {
  const card = e.target.closest('.runner');
  if (!card) return;
  if (e.shiftKey) {
    if (!confirm(`将 ${card.dataset.bib} 标记为退赛？`)) return;
    await api('/api/runner/dnf', { bib: card.dataset.bib, reason: '指挥台人工标记' });
  }
});

let toastTimer = null;
function toast(msg, err = false) {
  const t = $('#toast') ?? mkToast();
  t.textContent = msg;
  t.style.background = err ? '#b91c1c' : '#0e7490';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function mkToast() {
  const d = document.createElement('div');
  d.id = 'toast';
  document.body.appendChild(d);
  return d;
}

refresh();
