/**
 * 朋友圈
 * ------------------------------------------------------------
 * 两边都能发：文字 / 图片 / 图文。
 * 能点赞、能留言。时间按真实写入时间记。
 *
 * 图片存私有桶，读的时候换签名链接。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEY = 'moments';
const MAX = 200;

export async function loadMoments() {
  if (!dbReady) return [];
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}

export async function saveMoments(list) {
  await supabase.from('app_settings').upsert({ key: KEY, value: list.slice(0, MAX), updated_at: new Date().toISOString() });
  return list;
}

export function addPost(list, { text = '', imagePath = '', who = 'me' }) {
  const t = String(text || '').trim().slice(0, 500);
  if (!t && !imagePath) throw new Error('写点字或者放张图');

  const post = {
    id: crypto.randomUUID().slice(0, 8),
    who: who === 'ta' ? 'ta' : 'me',
    text: t,
    image: imagePath || '',
    likes: [],
    comments: [],
    at: Date.now()
  };
  list.unshift(post);
  return post;
}

export function toggleLike(list, id, who = 'me') {
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('没有这条');
  p.likes = p.likes || [];
  p.likes = p.likes.includes(who) ? p.likes.filter((x) => x !== who) : [...p.likes, who];
  return p;
}

export function addComment(list, id, { text, who = 'me' }) {
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('没有这条');
  const t = String(text || '').trim().slice(0, 200);
  if (!t) throw new Error('写点什么');
  p.comments = p.comments || [];
  p.comments.push({ id: crypto.randomUUID().slice(0, 6), who, text: t, at: Date.now() });
  return p;
}

export function removePost(list, id) {
  return list.filter((x) => x.id !== id);
}

/* 给他看的一句话 */
export function momentsPromptLine(list) {
  const recent = list.slice(0, 3);
  if (!recent.length) return '- 朋友圈还没人发东西。';
  return (
    '- 朋友圈最近：' +
    recent
      .map((p) => `${p.who === 'me' ? '他' : '你'}：${p.text || '（一张图）'}`)
      .join('；')
  );
}
