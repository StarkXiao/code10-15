/* 越野赛事医疗保障指挥大屏（原生 JS，无外部依赖） */
"use strict";

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
let STATE = null;
let PROJECTION = null;
let selectedBib = null;
const feedMax = 80;

// ------------------------------------------------------------ 投影
function fitProjection(points, w, h) {
  const lats = points.map(p => p.lat), lons = points.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const sx = (w - 90) / Math.max(1e-9, maxLon - minLon);
  const sy = (h - 90) / Math.max(1e-9, maxLat - minLat);
  const s = Math.min(sx, sy);
  return {
    s,
    ox: 45 - s * minLon + ((w - 90) - s * (maxLon - minLon)) / 2,
    oy: 45 + s * maxLat - ((h - 90) - s * (maxLat - minLat)) / 2,
  };
}
const xy = (p) => ({ x: PROJECTION.ox + p.lon * PROJECTION.s,
                     y: PROJECTION.oy - p.lat * PROJECTION.s });

// ------------------------------------------------------------ 绘制
function draw() {
  if (!STATE) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const pts = STATE.course.points;
  PROJECTION = fitProjection(pts, W, H);
  const P = pts.map(xy);

  // 危险路段缓冲带
  for (const z of STATE.course.zones) {
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = z.severity === "critical"
      ? "rgba(255,107,107,.34)" : "rgba(255,209,102,.30)";
    ctx.lineWidth = 12;
    ctx.beginPath();
    for (let i = z.start_idx; i <= z.end_idx; i++) {
      const q = P[i];
      i === z.start_idx ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    const mid = P[Math.floor((z.start_idx + z.end_idx) / 2)];
    ctx.fillStyle = z.severity === "critical" ? "#ff6b6b" : "#ffd166";
    ctx.font = "12px sans-serif";
    ctx.fillText("⚠ " + z.name, mid.x + 8, mid.y - 10);
  }

  // 赛道
  ctx.strokeStyle = "#4a6b86"; ctx.lineWidth = 3;
  ctx.beginPath();
  P.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
  ctx.stroke();
  // 起终点
  ctx.fillStyle = "#9fb8cc";
  ctx.font = "11px sans-serif";
  ctx.fillText("起/终", P[0].x - 34, P[0].y + 4);

  // 检录点
  ctx.textAlign = "center";
  for (const cp of STATE.course.checkpoints) {
    const q = P[cp.route_idx];
    ctx.fillStyle = "#7fd1ff";
    ctx.beginPath();
    ctx.moveTo(q.x, q.y - 7); ctx.lineTo(q.x + 7, q.y);
    ctx.lineTo(q.x, q.y + 7); ctx.lineTo(q.x - 7, q.y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#9fc3d9";
    ctx.fillText(cp.id + " " + cp.name, q.x, q.y - 14);
  }
  ctx.textAlign = "left";

  // 救护点
  for (const s of STATE.stations) {
    const q = xy(s);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(q.x - 7, q.y - 7, 14, 14);
    ctx.fillStyle = "#d63344";
    ctx.fillRect(q.x - 1.5, q.y - 5, 3, 10);
    ctx.fillRect(q.x - 5, q.y - 1.5, 10, 3);
    ctx.fillStyle = "#e8f2fa";
    ctx.font = "11px sans-serif";
    ctx.fillText(s.id + " " + s.name, q.x + 10, q.y - 6);
    ctx.fillStyle = s.capabilities.includes("AED") ? "#69db7c" : "#e8a33d";
    ctx.fillText(s.capabilities.includes("AED") ? "AED" : "无AED",
                 q.x + 10, q.y + 7);
  }

  // 派单连线（选手 -> 救护点）
  for (const a of STATE.alerts) {
    if (!a.dispatch || a.status === "resolved") continue;
    const r = STATE.riders.find(x => x.bib === a.bib);
    const s = STATE.stations.find(x => x.id === a.dispatch.station_id);
    if (!r || !s) continue;
    const q1 = xy(r), q2 = xy(s);
    ctx.strokeStyle = a.escalated ? "rgba(255,107,107,.85)"
      : "rgba(127,209,255,.75)";
    ctx.lineWidth = a.escalated ? 2.5 : 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y);
    ctx.stroke(); ctx.setLineDash([]);
  }

  // 选手
  for (const r of STATE.riders) drawRider(r);

  // 图例旁的比例尺信息
  ctx.fillStyle = "#71869a";
  ctx.font = "11px sans-serif";
  ctx.fillText(`赛道全长 ${STATE.course.total_km.toFixed(1)} km`, 12, H - 40);
}

function riderColor(r) {
  const open = STATE.alerts.some(a => a.bib === r.bib
    && a.status !== "resolved" && a.level === "critical");
  if (open) return "#ff6b6b";
  const warn = STATE.alerts.some(a => a.bib === r.bib
    && a.status !== "resolved");
  if (warn) return "#ffd166";
  return r.status === "finished" ? "#69db7c" : "#8ce99a";
}

function drawRider(r) {
  const q = xy(r);
  const color = riderColor(r);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(q.x, q.y, 6.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#0e141b"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = color === "#8ce99a" ? "#dfe7ee" : "#0e141b";
  ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
  ctx.fillText(r.bib, q.x, q.y + 3);
  ctx.textAlign = "left";
  ctx.fillStyle = "#cfe0ee"; ctx.font = "11px sans-serif";
  ctx.fillText(r.name, q.x + 9, q.y - 7);
  if (r.in_zone) {
    ctx.fillStyle = "#ff8f8f";
    ctx.fillText("⚠ " + r.km.toFixed(1) + "km", q.x + 9, q.y + 6);
  }
  r._px = q.x; r._py = q.y;
}

// ------------------------------------------------------------ 面板
function renderStats() {
  const riders = STATE.riders;
  const open = STATE.alerts.filter(a => a.status !== "resolved");
  const crit = open.filter(a => a.level === "critical").length;
  const finished = riders.filter(r => r.status === "finished").length;
  document.getElementById("stats").innerHTML = `
    <span class="chip ok">在赛/完赛<b>${riders.length - finished}/${riders.length}</b></span>
    <span class="chip crit">危急<b>${crit}</b></span>
    <span class="chip warn">未结告警<b>${open.length}</b></span>
    <span class="chip">累计派单<b>${STATE.alerts.filter(a => a.dispatch).length}</b></span>`;
  const t = STATE.now;
  document.getElementById("clock").textContent =
    `${String(Math.floor(t / 3600)).padStart(2, "0")}:` +
    `${String(Math.floor(t % 3600 / 60)).padStart(2, "0")}:` +
    `${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

const STATUS_TEXT = {
  open: "待派单", dispatched: "已派出", acked: "已接单",
  onscene: "在现场", resolved: "已解除",
};

function renderAlerts() {
  const box = document.getElementById("alert-list");
  const list = [...STATE.alerts].reverse();
  document.getElementById("alert-count").textContent = `(${list.length})`;
  box.innerHTML = list.map(a => {
    const r = STATE.riders.find(x => x.bib === a.bib);
    const d = a.dispatch;
    const can = (acts) => acts.includes(a.status);
    return `<div class="alert-item ${a.level} ${a.status}">
      <div class="head">
        <span>${a.level === "critical" ? "🔴" : "🟡"} ${a.title}</span>
        <span class="badge ${a.status}">${STATUS_TEXT[a.status] || a.status}</span>
      </div>
      <div class="meta">${fmtT(a.ts)} · #${a.id} · ${a.bib} ${r ? r.name : ""}
        ${a.escalated ? '<span class="badge escalated">已升级</span>' : ""}</div>
      <div class="detail">${a.detail}</div>
      ${d ? `<div class="dispatch">🚑 ${d.station_name} · 直线 ${(d.distance_m / 1000).toFixed(1)}km
        · ETA ${Math.round(d.eta_sec / 60)} 分${d.capability ? " · " + d.capability : ""}</div>` : ""}
      <div class="actions">
        ${can(["dispatched"]) ? `<button onclick="act(${a.id},'ack')">接单确认</button>` : ""}
        ${can(["dispatched", "acked"]) ? `<button onclick="act(${a.id},'onscene')">到达现场</button>` : ""}
        ${can(["dispatched", "acked", "onscene", "open"])
          ? `<button onclick="resolveAlert(${a.id})">处置解除</button>` : ""}
      </div></div>`;
  }).join("");
}

async function act(id, action) {
  await fetch(`/api/alerts/${id}/${action}`, { method: "POST", body: "{}" });
}
async function resolveAlert(id) {
  const resolution = prompt("处置记录", "现场处置完成，选手生命体征平稳");
  if (resolution === null) return;
  await fetch(`/api/alerts/${id}/resolve`, {
    method: "POST", body: JSON.stringify({ resolution }) });
}

function showRiderCard(bib) {
  const r = STATE.riders.find(x => x.bib === bib);
  if (!r) return;
  selectedBib = bib;
  const card = document.getElementById("rider-card");
  card.classList.remove("hidden");
  card.innerHTML = `
    <span class="close" onclick="closeCard()">✕</span>
    <h3>${r.bib} ${r.name} <small>(${r.category})</small></h3>
    <div class="row"><span>状态</span><b>${riderStatus(r)}</b></div>
    <div class="row"><span>赛道里程</span><b>${r.km.toFixed(2)} km</b></div>
    <div class="row"><span>海拔</span><b>${Math.round(r.elev)} m</b></div>
    <div class="row"><span>当前配速</span><b>${r.pace ? r.pace.toFixed(1) + " 分/公里" : "—"}</b></div>
    <div class="row"><span>偏离赛道</span><b>${Math.round(r.lateral_m)} m</b></div>
    <div class="row"><span>最近定位</span><b>${r.last_ts != null ? Math.max(0, Math.round(STATE.now - r.last_ts)) + " 秒前" : "无"}</b></div>
    <div class="row"><span>所在路段</span><b>${r.in_zone ? "⚠ " + r.in_zone : "普通赛段"}</b></div>
    <h4>检录记录（${r.checkins.length}）</h4>
    <table>${r.checkins.map(c => `<tr><td>${c.id} ${c.name}</td>
      <td>${fmtT(c.ts)}</td><td>${c.split_pace ? c.split_pace.toFixed(1) + " 分/公里" : ""}</td></tr>`).join("")}
    </table>`;
}
function riderStatus(r) {
  return { registered: "已检录", oncourse: "在赛", finished: "已完赛",
           dnf: "退赛", dns: "未出发" }[r.status] || r.status;
}
function closeCard() {
  selectedBib = null;
  document.getElementById("rider-card").classList.add("hidden");
}
window.act = act; window.resolveAlert = resolveAlert; window.closeCard = closeCard;

// ------------------------------------------------------------ 事件流
function pushFeed(kind, ts, data) {
  const box = document.getElementById("feed-list");
  let text = "", cls = "";
  if (kind === "checkin")
    text = `🎫 ${data.bib} ${data.name} 检录（${data.km.toFixed(1)}km）`;
  else if (kind === "alert_new") {
    text = `${data.alert.level === "critical" ? "🔴" : "🟡"} #${data.alert.id} ` +
      `[${data.alert.bib}] ${data.alert.title}`;
    cls = data.alert.level === "critical" ? "crit" : "";
  } else if (kind === "alert_dispatch") {
    text = data.reason === "ack_timeout"
      ? `⏫ #${data.alert_id} 确认超时，改派 ${data.dispatch.station_name}`
      : `🚑 ${data.call}`;
    cls = "dispatch";
  } else if (kind === "alert_escalate") text = `⏫ #${data.alert_id} 升级为危急`, cls = "crit";
  else if (kind === "alert_ack") text = `✅ #${data.alert_id} 救护点已接单`, cls = "ok";
  else if (kind === "alert_onscene") text = `📍 #${data.alert_id} 到达现场`;
  else if (kind === "alert_resolve") text = `🟢 #${data.alert_id} 解除：${data.resolution}`, cls = "ok";
  else if (kind === "finish") text = `🏁 ${data.bib} 完赛`, cls = "ok";
  else return;
  const div = document.createElement("div");
  div.className = "feed-item " + cls;
  div.innerHTML = `<span class="t">${fmtT(ts)}</span>${text}`;
  box.prepend(div);
  while (box.children.length > feedMax) box.lastChild.remove();
}

// ------------------------------------------------------------ 交互
canvas.addEventListener("click", (e) => {
  if (!STATE) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let hit = null, best = 18;
  for (const r of STATE.riders) {
    const d = Math.hypot(r._px - mx, r._py - my);
    if (d < best) { best = d; hit = r.bib; }
  }
  if (hit) showRiderCard(hit);
});

// ------------------------------------------------------------ 轮询 + SSE
async function refresh() {
  const res = await fetch("/api/state");
  STATE = await res.json();
  renderStats(); renderAlerts(); draw();
  if (selectedBib) showRiderCard(selectedBib);
}
function fmtT(t) {
  return `${String(Math.floor(t / 3600)).padStart(2, "0")}:` +
    `${String(Math.floor(t % 3600 / 60)).padStart(2, "0")}:` +
    `${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

function connectSSE() {
  const es = new EventSource("/api/events");
  for (const kind of ["checkin", "alert_new", "alert_dispatch", "alert_escalate",
                      "alert_ack", "alert_onscene", "alert_resolve", "finish"]) {
    es.addEventListener(kind, (e) => {
      const m = JSON.parse(e.data);
      pushFeed(m.kind, m.ts, m.data);
    });
  }
  es.onerror = () => setTimeout(connectSSE, 3000);
}

function sim(action) {
  fetch("/api/sim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, speed: Number(document.getElementById("speed").value) }),
  });
}
document.getElementById("btn-start").onclick = () => sim("start");
document.getElementById("btn-pause").onclick = () => sim("pause");
document.getElementById("btn-reset").onclick = () => sim("reset");
document.getElementById("speed").onchange = (e) =>
  fetch("/api/sim", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "running", speed: Number(e.target.value) }) });

refresh();
connectSSE();
setInterval(refresh, 2000);
