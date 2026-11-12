/**
 * 陪我学
 * ------------------------------------------------------------
 * 起一个计时器，给这段时间起个名字（在学什么），结束就退出。
 * 统计：今天 / 这周 / 这个月 / 今年。
 * 学的时候他偶尔会说一句。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEY = 'study';
const MAX = 500;

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

export async function loadStudy() {
  if (!dbReady) return [];
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}

async function saveStudy(list) {
  await supabase.from('app_settings').upsert({ key: KEY, value: list.slice(-MAX), updated_at: new Date().toISOString() });
  return list;
}

export function startSession(list, name) {
  const s = {
    id: crypto.randomUUID().slice(0, 8),
    name: String(name || '').trim().slice(0, 40) || '没写学什么',
    start: Date.now(),
    end: null,
    seconds: 0
  };
  list.push(s);
  return s;
}

export function endSession(list, id, seconds) {
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error('没有这次学习');
  s.end = Date.now();
  s.seconds = Math.max(0, Math.round(Number(seconds) || Math.round((s.end - s.start) / 1000)));
  return s;
}

/* 汇总 */
export function stats(list) {
  const now = new Date();
  const today = dayKey(now);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const ws = weekStart.getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

  const done = list.filter((s) => s.end && s.seconds > 0);

  const sum = (arr) => arr.reduce((a, s) => a + s.seconds, 0);

  return {
    today: sum(done.filter((s) => dayKey(new Date(s.start)) === today)),
    week: sum(done.filter((s) => s.start >= ws)),
    month: sum(done.filter((s) => s.start >= monthStart)),
    year: sum(done.filter((s) => s.start >= yearStart)),
    total: sum(done),
    count: done.length,
    recent: done.slice(-12).reverse()
  };
}

export function studyPromptLine(list) {
  const st = stats(list);
  if (!st.today) return '- 今天还没学习。';
  const mins = Math.round(st.today / 60);
  return `- 今天学了 ${mins} 分钟（${st.count} 次累计 ${Math.round(st.total / 60)} 分钟）。`;
}
