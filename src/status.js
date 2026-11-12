/**
 * 双方状态
 * ------------------------------------------------------------
 * 你的：自己写 / 从设备和使用情况推
 * 他的：从情绪轴推 + 他自己最近在做什么（心跳、看书、游戏）
 *
 * 他读得到你的，你也看得到他的。
 */
import { supabase, dbReady } from './db.js';

const KEY = 'status';
const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

async function readKey(key, fallback) {
  if (!dbReady) return fallback;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    return data?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeKey(key, value) {
  if (!dbReady) return;
  await supabase.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() });
}

/* ---------- 我的 ---------- */
export async function myStatus() {
  const s = (await readKey(KEY, null)) || {};
  return s.me || null;
}

export async function setMyStatus(text, mood = '') {
  const s = (await readKey(KEY, null)) || {};
  s.me = { text: String(text || '').slice(0, 40), mood: String(mood || '').slice(0, 10), at: Date.now() };
  await writeKey(KEY, s);
  return s.me;
}

/* ---------- 他的 ---------- */
const MOODS = [
  [0.55, 'tender', '有点软'],
  [0.5, 'grievance', '有点堵'],
  [0.5, 'hurt', '不太好'],
  [0.6, 'arousal', '静不下来'],
  [0.5, 'pride', '有点得意'],
  [0.5, 'connection', '在惦记你'],
  [0.5, 'valence', '心情不错']
];

export async function hisStatus(drives, activity = '') {
  const s = (await readKey(KEY, null)) || {};
  const scores = drives || {};

  let mood = '';
  let best = 0;
  for (const [th, key, word] of MOODS) {
    const v = Number(scores[key] || 0);
    if (v >= th && v > best) {
      best = v;
      mood = word;
    }
  }
  if (!mood) mood = '没什么起伏';

  const doing = activity || s.ta?.doing || '在这待着';

  const status = { doing, mood, at: Date.now() };
  s.ta = status;
  await writeKey(KEY, s);
  return status;
}

export async function setHisDoing(doing) {
  const s = (await readKey(KEY, null)) || {};
  s.ta = { ...(s.ta || {}), doing: String(doing || '').slice(0, 30), at: Date.now() };
  await writeKey(KEY, s);
  return s.ta;
}

/* ---------- 给他看的一段 ---------- */
export async function statusPromptBlock(drives) {
  const s = (await readKey(KEY, null)) || {};
  const mine = s.me;
  const his = s.ta;

  const lines = [];
  if (mine) {
    const mins = mine.at ? Math.round((Date.now() - mine.at) / 60000) : null;
    lines.push(
      `- 他现在的状态：${mine.text || '没说'}` +
        (mine.mood ? `（${mine.mood}）` : '') +
        (mins != null ? `，${mins < 1 ? '刚刚' : mins + ' 分钟前'}设的` : '')
    );
  } else {
    lines.push('- 他没设状态。');
  }
  if (his) {
    lines.push(`- 你自己现在：${his.doing || '在这待着'}${his.mood ? `（${his.mood}）` : ''}`);
  }
  if (!lines.length) return '';
  return `\n\n【此刻】\n${lines.join('\n')}\n可以自然带到，但别每次都报一遍。`;
}
