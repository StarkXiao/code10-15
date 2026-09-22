// 演示赛事实体：21km 山地越野赛（五云岭越野挑战赛）
// 6 个检查点、4 个救护点、3 段危险路段、8 名选手（其中 3 人预置异常剧情）
import { lateralOffsetPoint, pointAtKm, polylineLength } from '../shared/geo.js';

const NOMINAL_KM = 21.2;

const RAW_POINTS = [
  [120.000, 30.200], // 起点 0km
  [120.015, 30.212],
  [120.028, 30.206],
  [120.040, 30.218], // ~CP1 5.2km
  [120.052, 30.230],
  [120.060, 30.245],
  [120.072, 30.250], // 危险区1（崖壁路段）
  [120.084, 30.240], // ~CP2 10.8km
  [120.096, 30.248],
  [120.105, 30.236],
  [120.112, 30.224], // 危险区2（滚石路段）
  [120.108, 30.210],
  [120.118, 30.200],
  [120.128, 30.192], // 危险区3（溪谷下降）
  [120.138, 30.200],
  [120.140, 30.212], // 终点 21.2km
];

// 将手工坐标按经纬度增量等比缩放，使折线长度恰为标称里程
function normalizedPoints() {
  const rawLen = polylineLength(RAW_POINTS);
  const f = (NOMINAL_KM * 1000) / rawLen;
  const [lng0, lat0] = RAW_POINTS[0];
  return RAW_POINTS.map(([lng, lat]) => [lng0 + (lng - lng0) * f, lat0 + (lat - lat0) * f]);
}

/** 在赛道某标称里程区间两侧取点，构造包围赛道的危险区多边形 */
function corridorPolygon(points, kmFrom, kmTo, halfWidthM) {
  const steps = 6;
  const left = [];
  const right = [];
  for (let i = 0; i <= steps; i++) {
    const m = (kmFrom + ((kmTo - kmFrom) * i) / steps) * 1000;
    const { index, t, point } = pointAtKm(points, m);
    left.push(lateralOffsetPoint(points, index, t, halfWidthM));
    right.push(lateralOffsetPoint(points, index, t, -halfWidthM));
  }
  return [...left, ...right.reverse()];
}

/** 赛道旁侧（救护点）位置：offsetM 正负表示左右 */
function sidePoint(points, km, offsetM = 70) {
  const { index, t } = pointAtKm(points, km * 1000);
  return lateralOffsetPoint(points, index, t, offsetM);
}

// 配速换算：分:秒/km → m/s
const pace = (mmss) => 1000 / (mmss * 60);

export function buildSeed() {
  const points = normalizedPoints();
  const lengthM = polylineLength(points);
  const lengthKm = lengthM / 1000;

  const course = {
    id: 'course-main',
    name: '五云岭越野挑战赛',
    distanceKm: Math.round(lengthKm * 100) / 100,
    elevationGain: 1180,
    points,
    lengthM,
  };

  const cpDefs = [
    { name: '起点/检录处', km: 0, cutoffMin: 30 },
    { name: 'CP1 云门', km: 5.2, cutoffMin: 75 },
    { name: 'CP2 石脊', km: 10.8, cutoffMin: 140 },
    { name: 'CP3 松风垭口', km: 13.5, cutoffMin: 185 },
    { name: 'CP4 溪谷口', km: 17.8, cutoffMin: 230 },
    { name: '终点', km: NOMINAL_KM, cutoffMin: 260 },
  ];
  const checkpoints = cpDefs.map((c, i) => ({
    index: i,
    name: c.name,
    km: c.km,
    cutoffS: c.cutoffMin * 60,
  }));

  const dangerZones = [
    {
      id: 'D1',
      name: '鹰嘴崖临崖路段',
      level: '高',
      desc: '宽约 1.2m 的崖壁横切，落石风险，禁止超车',
      polygon: corridorPolygon(points, 7.4, 9.6, 45),
    },
    {
      id: 'D2',
      name: '乱石坡滚石区',
      level: '高',
      desc: '400m 乱石下降，雨后湿滑，需佩戴手套',
      polygon: corridorPolygon(points, 13.8, 15.6, 40),
    },
    {
      id: 'D3',
      name: '青溪谷湿滑下降',
      level: '中',
      desc: '溪谷涉水下降，注意青苔与山洪预警',
      polygon: corridorPolygon(points, 18.4, 20.0, 35),
    },
  ];

  const stations = [
    { id: 'S1', name: '起点救护站', pos: sidePoint(points, 0.4, 90), crew: ['周队'], channel: 'CH1' },
    { id: 'S2', name: 'CP2 石脊救护点', pos: sidePoint(points, 10.8, -80), crew: ['林岚'], channel: 'CH3' },
    { id: 'S3', name: 'CP3 垭口救护点', pos: sidePoint(points, 13.5, 80), crew: ['赵岩'], channel: 'CH4' },
    { id: 'S4', name: '终点救护站', pos: sidePoint(points, 20.9, 90), crew: ['孙医生'], channel: 'CH2' },
  ];

  // scenario: none / danger / cramp / cutoff
  const runnerDefs = [
    { bib: 'A001', name: '林越', deviceId: 'GT-1001', planPaceMin: 8.0, color: '#38bdf8' },
    { bib: 'A002', name: '陈岭', deviceId: 'GT-1002', planPaceMin: 9.0, color: '#4ade80' },
    { bib: 'A003', name: '高原', deviceId: 'GT-1003', planPaceMin: 10.0, color: '#a3e635' },
    { bib: 'A004', name: '许岩', deviceId: 'GT-1004', planPaceMin: 9.5, color: '#f472b6', scenario: 'danger' },
    { bib: 'A005', name: '王蔓', deviceId: 'GT-1005', planPaceMin: 8.8, color: '#fbbf24', scenario: 'cramp' },
    { bib: 'A006', name: '孙迟', deviceId: 'GT-1006', planPaceMin: 11.5, color: '#fb923c', scenario: 'cutoff' },
    { bib: 'A007', name: '何川', deviceId: 'GT-1007', planPaceMin: 9.8, color: '#c084fc' },
    { bib: 'A008', name: '郑南', deviceId: 'GT-1008', planPaceMin: 10.5, color: '#2dd4bf' },
  ];
  const runners = runnerDefs.map((r) => ({
    bib: r.bib,
    name: r.name,
    deviceId: r.deviceId,
    bound: true,
    planPaceMs: pace(r.planPaceMin),
    color: r.color,
    scenario: r.scenario ?? 'none',
    status: 'dns',
    startOffsetS: 0,
    checkins: [],
    pings: [],
    lastPing: null,
  }));

  return {
    race: {
      id: 'R2026',
      name: '2026 五云岭 21K 越野挑战赛',
      status: 'idle', // idle | running | finished
      startedAt: null,
      nowS: 0,
    },
    course,
    checkpoints,
    dangerZones,
    stations,
    runners,
    alerts: [],
    events: [],
    seq: { alert: 1, event: 1 },
    runtime: {},
  };
}
