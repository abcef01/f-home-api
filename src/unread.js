/**
 * 未读：他写的东西你有没有看过
 * 按分区记一个时间戳，比它新且是他写的就是未读。
 */
import { supabase, dbReady } from './db.js';

const READ_KEY = 'reads';

async function readKey(key, fallback) {
  if (!dbReady) return fallback;
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? fallback;
}

export async function getReads() {
  return (await readKey(READ_KEY, {})) || {};
}

export async function markRead(section) {
  const r = await getReads();
  r[section] = Date.now();
  await supabase.from('app_settings').upsert({ key: READ_KEY, value: r, updated_at: new Date().toISOString() });
  return r;
}

export async function unreadCounts() {
  const reads = await getReads();
  const diary = await readKey('diary', {});
  const moments = (await readKey('moments', [])) || [];
  const out = { diary: 0, notes: 0, moments: 0 };

  const since = (s) => Number(reads[s] || 0);

  out.diary = (diary.entries || []).filter((e) => e.who === 'ta' && e.at > since('diary')).length;
  out.notes = (diary.notes || []).filter((n) => n.who === 'ta' && n.at > since('notes')).length;
  out.moments = moments.filter((m) => m.who === 'ta' && m.at > since('moments')).length;

  return out;
}
