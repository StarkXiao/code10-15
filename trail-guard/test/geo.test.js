import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, lateralOffsetPoint, offsetMeters, pointAtKm, pointInPolygon, projectOnPolyline } from '../src/shared/geo.js';

test('haversine：经线方向 1 纬度约 111.32km', () => {
  const d = haversine([120, 30], [120, 31]);
  assert.ok(Math.abs(d - 111320) / 111320 < 0.002, `实际 ${d}`);
});

test('offsetMeters 往返一致', () => {
  const c = [120, 30];
  const p = offsetMeters(c, 1000, 2000);
  const dx = haversine(c, [p[0], c[1]]);
  const dy = haversine(c, [c[0], p[1]]);
  assert.ok(Math.abs(dx - 1000) < 2);
  assert.ok(Math.abs(dy - 2000) < 2);
});

test('projectOnPolyline：中点投影里程与偏离距离', () => {
  const line = [
    [120, 30],
    [120, 30.01],
  ];
  const halfLen = haversine(line[0], line[1]);
  const midLng = 120 + 300 / (111320 * Math.cos((30.005 * Math.PI) / 180));
  const mid = [midLng, 30.005]; // 线段几何中点偏东 300m
  const proj = projectOnPolyline(mid, line);
  assert.ok(Math.abs(proj.dist - 300) < 3, `偏离 ${proj.dist}`);
  assert.ok(Math.abs(proj.traveled - halfLen / 2) < 3, `里程 ${proj.traveled} vs ${halfLen / 2}`);
});

test('pointInPolygon：矩形内外判定', () => {
  const c = [120, 30];
  const ring = [
    offsetMeters(c, -100, -100),
    offsetMeters(c, 100, -100),
    offsetMeters(c, 100, 100),
    offsetMeters(c, -100, 100),
  ];
  assert.equal(pointInPolygon(c, ring), true);
  assert.equal(pointInPolygon(offsetMeters(c, 500, 0), ring), false);
});

test('pointAtKm：沿折线里程递增且不越界', () => {
  const pts = [
    [120, 30],
    [120.01, 30.01],
    [120.02, 30],
  ];
  const p0 = pointAtKm(pts, 0).point;
  assert.ok(Math.abs(p0[0] - 120) < 1e-9);
  const end = pointAtKm(pts, 1e9).point;
  assert.ok(Math.abs(end[0] - 120.02) < 1e-9);
  const a = pointAtKm(pts, 500).point;
  const b = pointAtKm(pts, 1500).point;
  assert.ok(haversine(a, b) > 800);
});

test('lateralOffsetPoint：偏移点到赛道距离约等于偏移量', () => {
  const line = [
    [120, 30],
    [120, 30.01],
  ];
  const p = lateralOffsetPoint(line, 0, 0.5, 250);
  assert.ok(Math.abs(haversine(pointAtKm(line, haversine(line[0], line[1]) * 0.5).point, p) - 250) < 5);
});
