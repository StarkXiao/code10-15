// 地理计算（纯函数，前后端共用同一实现）
// 坐标一律 [lng, lat]，距离单位米，速度 m/s，配速 s/km

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** Haversine 球面距离（米） */
export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 折线总长度（米） */
export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += haversine(points[i - 1], points[i]);
  return len;
}

/**
 * 将位置投影到折线：返回 { index, traveled, dist, point }
 *  - index: 最近段起点下标
 *  - traveled: 距折线起点的沿程里程（米）
 *  - dist: 到折线的垂直距离（米）
 *  - point: 折线上的最近点
 */
export function projectOnPolyline(pos, points) {
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const aLat = toRad(a[1]);
    // 局部米制平面求投影参数
    const x = toRad(b[0] - a[0]) * R * Math.cos(aLat);
    const y = toRad(b[1] - a[1]) * R;
    const px = toRad(pos[0] - a[0]) * R * Math.cos(aLat);
    const py = toRad(pos[1] - a[1]) * R;
    const segLen2 = x * x + y * y || 1e-9;
    let t = Math.max(0, Math.min(1, (px * x + py * y) / segLen2));
    // 用球面距离复核参数，消除高纬长段的平面近似误差
    const point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const segLen = haversine(a, b);
    if (segLen > 0) t = Math.max(0, Math.min(1, haversine(a, point) / segLen));
    const p2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const dist = haversine(pos, p2);
    if (!best || dist < best.dist) best = { index: i, t, dist, point: p2 };
  }
  let traveled = 0;
  for (let i = 0; i < best.index; i++) traveled += haversine(points[i], points[i + 1]);
  traveled += haversine(points[best.index], best.point);
  return { ...best, traveled };
}

/** 点是否在多边形内（射线法），ring 为闭合坐标数组 */
export function pointInPolygon(pos, ring) {
  const [x, y] = pos;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 沿以 [lng,lat] 为中心的米制偏移：dLng 向东、dLat 向北 */
export function offsetMeters(center, dLng, dLat) {
  const [lng, lat] = center;
  return [
    lng + dLng / (R * Math.cos(toRad(lat))) * (180 / Math.PI),
    lat + dLat / R * (180 / Math.PI),
  ];
}

/** 沿折线方向（index 段）取法向偏移点，用于模拟偏航 */
export function lateralOffsetPoint(points, index, t, meters) {
  const a = points[index];
  const b = points[index + 1] ?? a;
  const aLat = toRad(a[1]);
  // 米制切向量（R 在归一化时消去，方向保留 cos(lat)）
  const dx = Math.cos(aLat) * toRad(b[0] - a[0]);
  const dy = toRad(b[1] - a[1]);
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l; // 法向（米制，左为正）
  const ny = dx / l;
  const base = [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
  ];
  return offsetMeters(base, nx * meters, ny * meters);
}

/** 沿折线取指定里程（米）处的点与段信息，用于模拟选手行进 */
export function pointAtKm(points, meters) {
  let remain = Math.max(0, meters);
  for (let i = 0; i < points.length - 1; i++) {
    const seg = haversine(points[i], points[i + 1]);
    if (remain <= seg || i === points.length - 2) {
      const t = seg === 0 ? 0 : Math.min(1, remain / seg);
      const aLat = toRad(points[i][1]);
      return {
        index: i,
        t,
        point: [
          points[i][0] + t * (points[i + 1][0] - points[i][0]),
          points[i][1] + t * (points[i + 1][1] - points[i][1]),
        ],
      };
    }
    remain -= seg;
  }
  return { index: points.length - 1, t: 1, point: points[points.length - 1] };
}

/** m/s → 分:秒/km 文案 */
export function paceText(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(1000 / ms);
  return `${Math.floor(s / 60)}′${String(s % 60).padStart(2, '0')}″/km`;
}

export const fmtClock = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
};
