/**
 * 该不该现在打扰你
 * ------------------------------------------------------------
 * 思路来自 revive-companion（pearthink123，MIT）：
 *   1. 泊松掷骰 —— 「想念」是按速率随机到达的，不是定时器
 *   2. 贝叶斯推断 —— 先猜你在干嘛（聊天中/在线发呆/忙/睡/不在/需要关心）
 *   3. 信息增益 —— 已经知道你在干嘛，就别再问一遍
 *
 * 这里是纯数学，不调模型、不发网络请求。积温负责「想说」，
 * 这一层负责「现在说合不合适」。
 */

/* 六种隐藏状态 + 各自的打扰效用（越大越值得打扰） */
const STATES = {
  chatting: { utility: 0.2, label: '聊天中' },
  idle: { utility: 0.7, label: '在线但安静' },
  busy: { utility: 0.1, label: '在忙' },
  sleeping: { utility: 0.0, label: '在睡觉' },
  away: { utility: 0.3, label: '不在' },
  care: { utility: 0.9, label: '可能不太好' }
};

/* 先验：按小时给不同权重（凌晨更可能睡，工作时间更可能忙） */
function priors(hour) {
  if (hour >= 2 && hour < 7) return { sleeping: 0.85, away: 0.1, busy: 0.02, idle: 0.02, chatting: 0.005, care: 0.005 };
  if (hour >= 7 && hour < 9) return { sleeping: 0.25, away: 0.2, busy: 0.3, idle: 0.15, chatting: 0.03, care: 0.07 };
  if (hour >= 9 && hour < 18) return { busy: 0.45, idle: 0.2, away: 0.2, chatting: 0.05, sleeping: 0.01, care: 0.09 };
  if (hour >= 18 && hour < 23) return { idle: 0.4, busy: 0.15, away: 0.15, chatting: 0.15, sleeping: 0.02, care: 0.13 };
  return { sleeping: 0.35, idle: 0.25, away: 0.15, busy: 0.1, chatting: 0.05, care: 0.1 };
}

/* 观测 → 各状态的似然（0~1，越大越支持该状态） */
function likelihoods(obs) {
  const { deviceFresh, deviceVisible, locked, minutesSinceUser, unanswered, night } = obs;

  return {
    chatting: clamp(0.15 + (deviceVisible && deviceFresh ? 0.55 : 0) + (minutesSinceUser < 5 ? 0.35 : 0)),
    idle: clamp(0.2 + (deviceFresh ? 0.5 : 0) + (deviceVisible ? 0.2 : 0) - (unanswered > 1 ? 0.2 : 0)),
    busy: clamp(0.15 + (deviceVisible && !deviceFresh ? 0.35 : 0) + (unanswered > 0 ? 0.3 : 0)),
    sleeping: clamp((night ? 0.5 : 0.05) + (locked ? 0.35 : 0) + (!deviceFresh ? 0.2 : 0) - (deviceVisible && deviceFresh ? 0.4 : 0)),
    away: clamp(0.2 + (!deviceFresh ? 0.5 : 0) - (locked ? 0.1 : 0)),
    care: clamp(0.08 + (minutesSinceUser > 60 * 18 ? 0.3 : 0) + (night ? 0.1 : 0) + (unanswered > 2 ? 0.15 : 0))
  };
}

function clamp(v) {
  return Math.max(0.001, Math.min(0.999, v));
}

/* 贝叶斯：后验 ∝ 先验 × 似然 */
export function inferState({ hour, device = {}, minutesSinceUser = 999, unanswered = 0 }) {
  const night = hour >= 23 || hour < 6;
  const ageMin = device.at ? (Date.now() - device.at) / 60000 : 999;
  const obs = {
    deviceFresh: ageMin < 6,
    deviceVisible: device.visibility === 'visible',
    locked: device.locked === true,
    minutesSinceUser,
    unanswered,
    night
  };

  const prior = priors(hour);
  const like = likelihoods(obs);

  let total = 0;
  const post = {};
  for (const k of Object.keys(STATES)) {
    post[k] = (prior[k] || 0.01) * (like[k] || 0.1);
    total += post[k];
  }
  for (const k of Object.keys(post)) post[k] = total > 0 ? post[k] / total : 0;

  let best = 'idle';
  let bestP = -1;
  let expected = 0;
  for (const [k, p] of Object.entries(post)) {
    expected += p * STATES[k].utility;
    if (p > bestP) {
      bestP = p;
      best = k;
    }
  }

  /* 用「最可能状态」的效用做决策，期望值只作参考 */
  const utility = STATES[best].utility;

  return {
    state: best,
    label: STATES[best].label,
    confidence: Number(bestP.toFixed(2)),
    utility: Number(utility.toFixed(2)),
    expected: Number(expected.toFixed(2)),
    distribution: Object.fromEntries(Object.entries(post).map(([k, v]) => [k, Number(v.toFixed(2))])),
    obs
  };
}

/* 泊松：经过 t 小时后「想起你」的概率；miss 越多越容易 */
export function desire({ minutes, misses = 0, rate = 0.16 }) {
  const t = Math.max(0, minutes) / 60;
  const base = 1 - Math.exp(-rate * t);
  return Math.min(0.98, base + Math.min(0.45, misses * 0.06));
}

/**
 * 最终决策
 * @returns {{send: boolean, reason: string, detail: object}}
 */
export function decide({
  hour,
  device = {},
  minutesSinceUser = 999,
  minutesSinceCheck = 10,
  unanswered = 0,
  misses = 0,
  rate = 0.16,
  allowNight = true,
  ignoreSuitability = false
}) {
  const inferred = inferState({ hour, device, minutesSinceUser, unanswered });
  const p = desire({ minutes: minutesSinceCheck, misses, rate });

  const detail = { ...inferred, desire: Number(p.toFixed(2)), unanswered };

  /* 关掉「合不合适」判断后，只保留泊松掷骰 */
  if (!ignoreSuitability) {
    if (inferred.state === 'sleeping') {
      return { send: false, reason: '对方在睡觉', detail };
    }

    if (!allowNight && (hour >= 23 || hour < 6)) {
      return { send: false, reason: '夜间静默', detail };
    }

    if (unanswered >= 2 && inferred.state !== 'care') {
      return { send: false, reason: '前面还有没回的消息', detail };
    }

    if (inferred.utility < 0.5 && inferred.state !== 'care') {
      return { send: false, reason: `现在不太合适（${inferred.label}）`, detail };
    }
  }

  /* 泊松没掷中 */
  if (Math.random() > p) {
    return { send: false, reason: `这轮没想起你（${Math.round(p * 100)}%）`, detail };
  }

  return { send: true, reason: `掷中了（${Math.round(p * 100)}%，${inferred.label}）`, detail };
}
