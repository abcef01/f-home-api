/**
 * 喝水记录
 * ------------------------------------------------------------
 * 数字你自己写。记每一条（时间 + 毫升），按天汇总。
 * 他只看得到，不会替你记。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEY = 'water';
const GOAL = 2000;

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

export async function loadWater() {
  if (!dbReady) return {};
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return (data?.value && typeof data.value === 'object' && data.value) || {};
}

async function saveWater(v) {
  await supabase.from('app_settings').upsert({ key: KEY, value: v, updated_at: new Date().toISOString() });
}

export async function addWater(ml, note = '') {
  const n = Math.round(Number(ml) || 0);
  if (n <= 0) throw new Error('写了多少毫升？');
  if (n > 5000) throw new Error('一次喝不了这么多吧');

  const all = await loadWater();
  const today = dayKey();
  const list = all[today] || [];
  list.push({ id: crypto.randomUUID().slice(0, 8), ml: n, at: Date.now(), note: String(note || '').slice(0, 40) });
  all[today] = list;

  /* 只留最近 60 天 */
  const keys = Object.keys(all).sort().slice(-60);
  const trimmed = Object.fromEntries(keys.map((k) => [k, all[k]]));
  await saveWater(trimmed);
  return trimmed;
}

export async function removeWater(id) {
  const all = await loadWater();
  for (const day of Object.keys(all)) {
    all[day] = (all[day] || []).filter((x) => x.id !== id);
    if (!all[day].length) delete all[day];
  }
  await saveWater(all);
  return all;
}

export function waterView(all) {
  const today = dayKey();
  const days = Object.keys(all).sort().reverse().slice(0, 14);
  const rows = days.map((d) => ({
    date: d,
    total: (all[d] || []).reduce((a, x) => a + x.ml, 0),
    items: all[d] || []
  }));
  const todayRow = rows.find((r) => r.date === today) || { date: today, total: 0, items: [] };
  return { goal: GOAL, today: todayRow, days: rows };
}

/* 给他看的一句话 */
export function waterPromptLine(all) {
  const v = waterView(all);
  if (!v.today.total) return '- 今天还没喝水记录。';
  return `- 今天喝了 ${v.today.total} ml（目标 ${v.goal}），分 ${v.today.items.length} 次。`;
}
