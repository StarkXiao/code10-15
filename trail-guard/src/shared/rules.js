// 判定规则常量：所有阈值集中在此，方便赛事总监按赛道调整
export const RULES = {
  // —— 定位 ——
  GPS_MAX_OFFTRACK_M: 120, // 超出赛道此距离判定为偏航（危险区判定不依赖此项）

  // —— 静止异常 ——
  STALL_SPEED_MS: 0.45, // 近窗平均速度低于此值视为“停下”
  STALL_WINDOW_S: 180, // 取最近 180s 的移动平均
  STALL_MIN_ELAPSED_S: 120, // 起跑 120s 内不判静止（热身/拍照）

  // —— 配速异常 ——
  PACE_SLOW_RATIO: 1.6, // 实际配速 ≥ 计划配速 ×1.6（即慢 60%）
  PACE_WINDOW_S: 240, // 取最近 240s 平滑速度
  PACE_MIN_ELAPSED_S: 300,
  PACE_GRACE_S: 90, // 检录点后 90s 宽限（补水/打卡造成的降速不算）

  // —— 关门风险 ——
  CUTOFF_LEAD_S: 300, // 按当前配速预测到达 CP 的时间晚于关门 5 分钟即预警
  CUTOFF_GRACE_S: 120,

  // —— 危险路段 ——
  DANGER_GRACE_S: 60, // 离开危险区 60s 后自动解除（防止边界抖动）

  // —— 告警冷却：同选手同类型关闭后多久内不再重复 ——
  ALERT_COOLDOWN_S: 600,

  // —— 救护派单 ——
  ACK_TIMEOUT_S: 45, // 45s 无人接单 → 升级（全员响铃 + 调度员可见）
  // 站点同时可处置的现场任务数（超过则视为不可派，自动选下一站）
  STATION_CAPACITY: 2,
};

// 告警类型
export const ALERT_TYPES = {
  DANGER_ENTRY: 'danger_entry',
  STALL: 'stall',
  PACE_ANOMALY: 'pace_anomaly',
  CUTOFF_RISK: 'cutoff_risk',
  MISSED_CUTOFF: 'missed_cutoff',
  OFFTRACK: 'offtrack',
};

export const ALERT_META = {
  danger_entry: { label: '进入危险路段', level: 'critical', icon: '⛰' },
  stall: { label: '长时间静止', level: 'warning', icon: '⏸' },
  pace_anomaly: { label: '配速异常', level: 'warning', icon: '🐢' },
  cutoff_risk: { label: '关门风险', level: 'warning', icon: '⏳' },
  missed_cutoff: { label: '已错过关门', level: 'critical', icon: '🚷' },
  offtrack: { label: '偏航', level: 'warning', icon: '🧭' },
};

// 告警状态机
export const ALERT_STATUS = {
  OPEN: 'open', // 系统刚发现
  DISPATCHED: 'dispatched', // 已自动派给最近救护点
  ACK: 'ack', // 救护点已接单
  ENROUTE: 'enroute', // 已出动
  ARRIVED: 'arrived', // 到达选手位置
  RESOLVED: 'resolved', // 处置完成（自动解除或人工关闭）
  ESCALATED: 'escalated', // 超时无人接单，升级到全员
};

// 选手实时状态
export const RUNNER_STATUS = {
  DNS: 'dns', // 未出发
  RACING: 'racing',
  DNF: 'dnf',
  FINISHED: 'finished',
};
