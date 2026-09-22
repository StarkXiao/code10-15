// 赛道模拟器：虚拟赛钟驱动选手沿赛道前进，以真实定位链路喂给引擎
// 预置剧情：danger=崖壁区摔倒贴线爬行、cramp=途中抽筋停滞、cutoff=掉速面临关门
import { lateralOffsetPoint, pointAtKm } from '../shared/geo.js';
import { applyCheckin, applyPing } from './engine.js';
import { RUNNER_STATUS } from '../shared/rules.js';

const PING_CADENCE_S = 120; // 设备每 120s（赛钟）上报一次
const CRAMP_AT = 520;
const CRAMP_DURATION = 300;
const SLOW_FROM = 180;
const SLOW_FACTOR = 0.55;
// A004 在 D1 鹰嘴崖（7.4–9.6km）内摔倒，贴赛道一侧缓慢爬行
const DANGER_FROM_M = 7400;
const DANGER_TO_M = 9700;
const DANGER_FACTOR = 0.18;
const INTEGRATE_STEP_S = 10;

export class Simulator {
  constructor(getState) {
    this.getState = getState;
    this.dist = new Map(); // bib -> 上一 tick 末里程
    this.lastPingT = new Map(); // bib -> 上次上报赛钟
  }

  reset() {
    this.dist.clear();
    this.lastPingT.clear();
  }

  /** 发枪：起点统一自动检录 */
  startAll(t) {
    const state = this.getState();
    for (const r of state.runners) {
      if (r.status === RUNNER_STATUS.DNS) {
        this.dist.set(r.bib, 0);
        this.lastPingT.set(r.bib, 0);
      }
      try {
        applyCheckin(state, t, r.bib, 0, 'auto', state.course.points[0]);
      } catch {
        /* 已检录忽略 */
      }
    }
  }

  /** 当前剧情下的速度系数（危险区按里程、抽筋/掉速按赛钟） */
  #factor(runner, distM, t) {
    if (runner.scenario === 'danger' && distM >= DANGER_FROM_M && distM < DANGER_TO_M) {
      return DANGER_FACTOR;
    }
    if (runner.scenario === 'cramp') {
      if (t >= CRAMP_AT && t < CRAMP_AT + CRAMP_DURATION) return 0;
      if (t >= CRAMP_AT + CRAMP_DURATION) return 1.25;
    }
    if (runner.scenario === 'cutoff' && t > SLOW_FROM) return SLOW_FACTOR;
    return 1;
  }

  /** 选手在赛钟 t 时刻的精确里程（从发枪 0 起小步长积分） */
  #distanceAt(runner, t) {
    if (t <= 0) return 0;
    let d = 0;
    for (let tt = 0; tt < t; tt += INTEGRATE_STEP_S) {
      const dt = Math.min(INTEGRATE_STEP_S, t - tt);
      d += runner.planPaceMs * this.#factor(runner, d, tt + dt / 2) * dt;
    }
    return d;
  }

  #positionAt(runner, distM) {
    const state = this.getState();
    const { index, t, point } = pointAtKm(state.course.points, distM);
    // 危险剧情：经过 D1（鹰嘴崖）区间时贴赛道一侧行进，坐标落在危险多边形内
    if (runner.scenario === 'danger' && distM >= DANGER_FROM_M && distM <= DANGER_TO_M + 200) {
      return lateralOffsetPoint(state.course.points, index, t, 15);
    }
    return point;
  }

  /** 推进 dtS 秒（赛钟）；打点与打卡按精确时刻排序后送入引擎 */
  advance(dtS, nowS) {
    const state = this.getState();
    const from = nowS - dtS;

    // 以 tick 开始时的状态为准，确保本 tick 内完赛的选手也能完成跨越打卡
    const actives = state.runners.filter((r) => r.status === RUNNER_STATUS.RACING);
    for (const runner of actives) {
      const prevDist = this.dist.get(runner.bib) ?? 0;
      const newDist = Math.min(this.#distanceAt(runner, nowS), state.course.lengthM);
      this.dist.set(runner.bib, newDist);

      const timeline = [];

      // 定位打点（整 CADENCE 时刻）
      let last = this.lastPingT.get(runner.bib) ?? 0;
      for (let t = last + PING_CADENCE_S; t <= nowS; t += PING_CADENCE_S) {
        timeline.push({ t, kind: 'ping' });
        last = t;
      }
      this.lastPingT.set(runner.bib, last);

      // 检查点跨越（按精确时刻；5m 容差与引擎投影推进一致）
      for (let i = 1; i < state.checkpoints.length; i++) {
        const cpM = state.checkpoints[i].km * 1000 - 5;
        if (runner.checkins.some((c) => c.cpIndex === i)) continue;
        if (prevDist < cpM && newDist >= cpM) {
          timeline.push({ t: this.#crossingTime(runner, cpM, from, nowS), kind: 'checkin', cp: i });
        }
      }

      timeline.sort((a, b) => a.t - b.t);
      for (const ev of timeline) {
        const dAt = Math.min(this.#distanceAt(runner, ev.t), state.course.lengthM);
        const pos = this.#positionAt(runner, dAt);
        if (ev.kind === 'ping') applyPing(state, ev.t, runner.bib, pos, { source: 'sim' });
        else applyCheckin(state, ev.t, runner.bib, ev.cp, 'auto', pos);
      }
    }
  }

  /** 二分求从 from 起到达目标里程的赛钟时刻 */
  #crossingTime(runner, targetM, from, hi0) {
    let lo = from;
    let hi = hi0;
    for (let i = 0; i < 36; i++) {
      const mid = (lo + hi) / 2;
      if (this.#distanceAt(runner, mid) >= targetM) hi = mid;
      else lo = mid;
    }
    return hi;
  }
}
