/**
 * 情绪双时间尺度（借鉴 A1batr055/Drivesoid 的模型描述 + ai-companion-cot-emotion 的数值设计）
 * ------------------------------------------------------------
 * 两条时间线：
 *   values   —— 快情绪，几十分钟到几小时内回归
 *   residual —— 余味，强刺激留下，衰减得更慢
 *
 * 关键三点（都是那份指南里踩过的坑）：
 *   1. 分数 = 值 + 余味 − 基线。别看原始值，基线不同的量没有可比性。
 *   2. 漂移必须按「过了多久」补，不能按「跑了几次」，否则服务停了情绪就冻住。
 *   3. 生气回落快，委屈回落慢；而且同一句话连说几次要打折，否则会顶死。
 */
import { supabase, dbReady } from './db.js';

const KEY = 'drives';

const SPEC = {
  connection: { home: 0.28, rate: 0.008, cap: 1, cn: '惦记' },
  pride: { home: 0.15, rate: 0.02, cap: 1, cn: '得意' },
  valence: { home: 0.30, rate: 0.02, cap: 1, cn: '高兴' },
  arousal: { home: 0.10, rate: 0.08, cap: 1, cn: '火气' },
  immersion: { home: 0.20, rate: 0.05, cap: 1, cn: '沉浸' },
  grievance: { home: 0.08, rate: 0.008, cap: 0.4, cn: '委屈' },
  hurt: { home: 0.05, rate: 0.02, cap: 0.5, cn: '伤心' },
  tender: { home: 0.15, rate: 0.03, cap: 1, cn: '心疼' }
};

const AXES = Object.keys(SPEC);

function blank() {
  const values = {};
  const residuals = {};
  for (const k of AXES) {
    values[k] = SPEC[k].home;
    residuals[k] = 0;
  }
  return { values, residuals, updatedAt: Date.now(), recent: {} };
}

async function load() {
  if (!dbReady) return blank();
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const v = data?.value;
  if (!v?.values) return blank();
  for (const k of AXES) {
    if (typeof v.values[k] !== 'number') v.values[k] = SPEC[k].home;
    if (typeof v.residuals?.[k] !== 'number') v.residuals = { ...(v.residuals || {}), [k]: 0 };
  }
  v.recent = v.recent || {};
  return v;
}

async function save(s) {
  await supabase.from('app_settings').upsert({ key: KEY, value: s, updated_at: new Date().toISOString() });
}


/* 真正的时间推进 */
export async function tickDrives(elapsedMinutes = 10) {
  const s = await load();
  const steps = Math.max(1, elapsedMinutes / 10);
  const now = Date.now();

  for (const k of AXES) {
    const { home, rate } = SPEC[k];
    /* values 向基线回归 */
    const effV = 1 - Math.pow(1 - rate, steps);
    s.values[k] = s.values[k] + (home - s.values[k]) * effV;
    /* 余味衰减得更慢（一半速度） */
    const effR = 1 - Math.pow(1 - rate * 0.5, steps);
    s.residuals[k] = s.residuals[k] * (1 - effR);
  }
  s.updatedAt = now;
  await save(s);
  return s;
}

/* 同一个刺激重复出现就衰减，防止一句话刷满 */
function discount(s, key, now) {
  const list = (s.recent[key] || []).filter((t) => now - t < 5 * 60000);
  s.recent[key] = [...list, now].slice(-8);
  /* 火气和委屈衰减得慢一些：吵架就是靠反复叠加升级的 */
  const k = key === 'arousal' || key === 'grievance' ? 0.12 : 0.4;
  return 1 / (1 + list.length * k);
}

export async function stimulateDrives({ kind, strength = 1 }) {
  const s = await load();
  const now = Date.now();
  const deltas = {
    angry: { arousal: 0.18, grievance: 0.12, valence: -0.12, hurt: 0.1 },
    cold: { grievance: 0.1, arousal: 0.05, valence: -0.06, hurt: 0.05 },
    warm: { valence: 0.16, connection: 0.08, tender: 0.06 },
    praise: { pride: 0.16, valence: 0.12 },
    share: { immersion: 0.14, connection: 0.06, tender: 0.04 },
    neglect: { connection: 0.1, grievance: 0.03, hurt: 0.02 },
    sore: { tender: 0.2, connection: 0.06, valence: -0.04 }
  }[kind];

  if (!deltas) return s;

  for (const [key, base] of Object.entries(deltas)) {
    if (!SPEC[key]) continue;
    const d = discount(s, key, now);
    const gain = base * strength * d;

    if (gain >= 0) {
      /* 正向：直接加，但接近上限时边际递减 */
      const room = SPEC[key].cap - s.values[key];
      s.values[key] = Math.min(SPEC[key].cap, s.values[key] + gain * Math.max(0.15, room));
      /* 强刺激留余味 */
      if (Math.abs(gain) > 0.08) s.residuals[key] = Math.min(0.35, s.residuals[key] + gain * 0.5);
    } else {
      s.values[key] = Math.max(0, s.values[key] + gain);
      if (Math.abs(gain) > 0.08) s.residuals[key] = Math.max(-0.35, s.residuals[key] + gain * 0.5);
    }
  }

  /* 说完一句总会顺一点 */
  s.values.arousal = Math.max(0, s.values.arousal - 0.02);

  s.updatedAt = now;
  await save(s);
  return s;
}

/* 分数 = (值 + 余味) − 基线，这才是「偏离平静多少」 */
export function scores(s) {
  const out = {};
  for (const k of AXES) {
    const eff = Math.min(SPEC[k].cap, Math.max(0, s.values[k] + s.residuals[k]));
    out[k] = Number((eff - SPEC[k].home).toFixed(3));
  }
  return out;
}

/* 给提示词用：只说「你现在的状态」，不报数字 —— 报数字他会照着演 */
export async function drivesPromptBlock() {
  if (!dbReady) return '';
  const s = await load();
  const sc = scores(s);
  const level = (x) => (x >= 0.35 ? '很强' : x >= 0.2 ? '明显' : x >= 0.1 ? '有一点' : null);

  const lines = [];
  for (const k of AXES) {
    const v = sc[k];
    if (Math.abs(v) < 0.1) continue;
    const lv = level(Math.abs(v));
    const name = SPEC[k].cn;
    lines.push(v > 0 ? `- ${name}：${lv}` : `- ${name}：没有，甚至有点反着来`);
  }
  if (!lines.length) return '';

  return `\n\n【你此刻的状态】（这是你真实的感受，不是你演出来的）\n${lines.join('\n')}\n照这个感觉说话，但不要直接说出这些词。`;
}

export async function drivesSummary() {
  const s = await load();
  return { values: s.values, residuals: s.residuals, scores: scores(s), updatedAt: s.updatedAt };
}
