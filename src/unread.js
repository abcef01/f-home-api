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
  const favorites = (await readKey('favorites', [])) || [];
  const quests = (await readKey('quests', null)) || {};
  const books = (await readKey('books', [])) || [];
  const out = { diary: 0, notes: 0, moments: 0, favorites: 0, quests: 0, books: 0 };

  const since = (s) => Number(reads[s] || 0);

  out.diary = (diary.entries || []).filter((e) => e.who === 'ta' && e.at > since('diary')).length;
  out.notes = (diary.notes || []).filter((n) => n.who === 'ta' && n.at > since('notes')).length;
  out.moments = moments.filter((m) => m.who === 'ta' && m.at > since('moments')).length;
  out.favorites = favorites.filter((f) => f.who === 'ta' && f.at > since('favorites')).length;
  out.quests = (quests.tasks || []).filter((t) => t.from === 'ta' && Number(t.at || 0) > since('quests')).length;

  /* 书：他在书里留的批注 */
  try {
    const { data } = await supabase.storage.from('bh-books').list('books', { limit: 5 });
    if (data?.length) {
      let n = 0;
      for (const f of data.filter((x) => x.name.endsWith('.marks.json')).slice(0, 3)) {
        const file = await supabase.storage.from('bh-books').download('books/' + f.name);
        if (!file?.data) continue;
        const marks = JSON.parse(await file.data.text());
        n += (marks.annotations || []).filter((a) => a.who === 'ta' && Number(a.at || 0) > since('books')).length;
      }
      out.books = n;
    }
  } catch {
    out.books = 0;
  }

  return out;
}
