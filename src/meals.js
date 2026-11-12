/**
 * 三餐
 * ------------------------------------------------------------
 * 打卡式：可以只点"吃了"，也可以顺手写吃了什么。
 * 记时间，按天存，能翻以前的。
 */
import { supabase, dbReady } from './db.js';

const KEY = 'meals';
const SLOTS = ['breakfast', 'lunch', 'dinner'];
const NAMES = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

export async function loadMeals() {
  if (!dbReady) return {};
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return (data?.value && typeof data.value === 'object' && data.value) || {};
}

async function saveMeals(v) {
  await supabase.from('app_settings').upsert({ key: KEY, value: v, updated_at: new Date().toISOString() });
}

export async function markMeal(slot, text = '', eaten = true) {
  if (!SLOTS.includes(slot)) throw new Error('没有这一餐');

  const all = await loadMeals();
  const today = dayKey();
  const day = all[today] || {};

  if (!eaten) {
    delete day[slot];
  } else {
    day[slot] = { at: Date.now(), text: String(text || '').slice(0, 80) };
  }

  all[today] = day;

  const keys = Object.keys(all).sort().slice(-60);
  const trimmed = Object.fromEntries(keys.map((k) => [k, all[k]]));
  await saveMeals(trimmed);
  return view(trimmed);
}

export function view(all) {
  const today = dayKey();
  const days = Object.keys(all).sort().reverse().slice(0, 14);

  return {
    today: { date: today, ...(all[today] || {}) },
    days: days.map((d) => ({ date: d, ...(all[d] || {}) })),
    slots: SLOTS.map((k) => ({ id: k, name: NAMES[k] }))
  };
}

export function mealsPromptLine(all) {
  const t = all[dayKey()] || {};
  const done = SLOTS.filter((s) => t[s]);
  if (!done.length) return '- 今天还没记三餐。';

  return (
    '- 今天记了：' +
    done
      .map((s) => `${NAMES[s]}${t[s].text ? '（' + t[s].text + '）' : '（吃了）'}`)
      .join('、')
  );
}
