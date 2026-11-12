/**
 * 收藏
 * ------------------------------------------------------------
 * 图片、一句话、一段对话，两边都能收。
 * 图片存私有桶，读时签名。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEY = 'favorites';
const MAX = 300;

export async function loadFavs() {
  if (!dbReady) return [];
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}

export async function saveFavs(list) {
  await supabase.from('app_settings').upsert({ key: KEY, value: list.slice(0, MAX), updated_at: new Date().toISOString() });
  return list;
}

export function addFav(list, { type, text = '', imagePath = '', note = '', who = 'me', from = '' }) {
  const t = String(text || '').trim().slice(0, 400);
  if (!t && !imagePath) throw new Error('没有可收藏的内容');

  const f = {
    id: crypto.randomUUID().slice(0, 8),
    type: type === 'image' ? 'image' : 'text',
    text: t,
    image: imagePath || '',
    note: String(note || '').slice(0, 80),
    from: String(from || '').slice(0, 20),
    who: who === 'ta' ? 'ta' : 'me',
    at: Date.now()
  };
  list.unshift(f);
  return f;
}

export function removeFav(list, id) {
  return list.filter((x) => x.id !== id);
}

export function favsPromptLine(list) {
  if (!list.length) return '- 收藏夹是空的。';
  const recent = list.slice(0, 3);
  return '- 收藏了：' + recent.map((f) => (f.type === 'image' ? '一张图' : f.text.slice(0, 20))).join('；');
}
