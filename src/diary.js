/**
 * 共同手帐
 * ------------------------------------------------------------
 * 参考 KKarsyline/shared-page（手帐风日历，人和 AI 一起写）。
 * 那是个 iOS 原生 App，搬不过来，所以只取它的想法：
 *
 *   · 一天一页，你和他都能写
 *   · 能互相点赞（不是打分，是"我看到了"）
 *   · 他会在某些日子自己写一句 —— 不是每天都有
 *
 * 存法：app_settings 里一个 JSON，按月取用。不做分页，因为一年也就几百条。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const KEY = 'diary';
const MAX = 3000;

export async function blank() {
  return { entries: [], at: Date.now() };
}

export async function load() {
  if (!dbReady) return blank();
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return data?.value || blank();
}

export async function save(D) {
  if (!dbReady) return;
  await supabase.from('app_settings').upsert({ key: KEY, value: D, updated_at: new Date().toISOString() });
}

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

export function addEntry(D, { text, who = 'me', date, image }) {
  const t = String(text || '').trim().slice(0, 600);
  if (!t) throw new Error('写点什么');
  const e = {
    id: crypto.randomUUID().slice(0, 8),
    date: date || dayKey(),
    who,
    text: t,
    image: image || null,
    likes: [],
    at: Date.now()
  };
  D.entries.push(e);
  if (D.entries.length > MAX) D.entries = D.entries.slice(-MAX);
  return e;
}

export function addComment(D, id, { text, who = 'me' }) {
  const e = D.entries.find((x) => x.id === id);
  if (!e) throw new Error('没有这一条');
  const t = String(text || '').trim().slice(0, 120);
  if (!t) throw new Error('说点什么');
  e.comments = e.comments || [];
  e.comments.push({ who, text: t, at: Date.now() });
  return e;
}

/* 他读了你的手帐，留一句 */
export async function autoComment(entry) {
  if (!entry || entry.who !== 'me') return null;
  try {
    const r = await callModel({
      target: 'memory',
      system:
        '你在读对方写的手帐。留一句话——像在页边用铅笔写的批注：可以接一句、问一句、或者只说你也想到了什么。二十字上下，不要总结，不要评价他的情绪，不要用"抱抱""加油"。只输出这句话。',
      messages: [{ role: 'user', content: entry.text }],
      temperature: 0.9,
      maxTokens: 200
    });
    const t = (r.content || '').trim().slice(0, 80);
    if (!t) return null;
    return { who: 'ta', text: t, at: Date.now() };
  } catch (err) {
    console.warn('[diary] 留言失败：', err.message.slice(0, 80));
    return null;
  }
}

export function toggleLike(D, id, who = 'me') {
  const e = D.entries.find((x) => x.id === id);
  if (!e) throw new Error('没有这一条');
  e.likes = e.likes || [];
  e.likes = e.likes.includes(who) ? e.likes.filter((x) => x !== who) : [...e.likes, who];
  return e;
}

/* 按月取：month 形如 2026-11 */
export function monthView(D, month) {
  const m = month || dayKey().slice(0, 7);
  const list = D.entries.filter((e) => e.date.startsWith(m)).sort((a, b) => (a.at > b.at ? 1 : -1));
  const byDay = {};
  for (const e of list) (byDay[e.date] = byDay[e.date] || []).push(e);
  return { month: m, byDay, entries: list, text: renderMonth(list) };
}

function renderMonth(list) {
  if (!list.length) return '这个月还没有字。';
  const byDay = {};
  for (const e of list) (byDay[e.date] = byDay[e.date] || []).push(e);
  return Object.entries(byDay)
    .map(([d, es]) => `${d}\n` + es.map((e) => `  ${e.who === 'me' ? '你' : '他'}：${e.text}`).join('\n'))
    .join('\n');
}

/* 提示词：让他知道最近写了什么 */
export async function diaryPromptBlock() {
  const D = await load();
  const recent = D.entries.slice(-6);
  if (!recent.length) return '';

  const lines = recent.map((e) => `- ${e.date} ${e.who === 'me' ? '他' : '你'}：${e.text}`).join('\n');
  return `\n\n【手帐最近几页】\n${lines}\n可以聊到这些事，但别像在核对账本。`;
}

/* 他自己写一页（心跳里偶发） */
export async function autowrite() {
  const D = await load();
  const d = dayKey();
  /* 同一天他已经写过就不再写 */
  if (D.entries.some((e) => e.who === 'ta' && e.date === d)) return null;

  try {
    const r = await callModel({
      target: 'memory',
      system:
        '你在给一本两个人的手帐写今天这一页。写两句，第一人称，当下的、具体的、可以很小（天气、窗外的声音、想到了什么）。不要总结，不要抒情，不要用"今天"开头。只输出正文。',
      messages: [{ role: 'user', content: `今天是 ${d}。你一个人待着，写两句。` }],
      temperature: 0.9,
      maxTokens: 300
    });
    const text = (r.content || '').trim().slice(0, 200);
    if (!text) return null;
    const e = addEntry(D, { text, who: 'ta', date: d });
    await save(D);
    return e;
  } catch {
    return null;
  }
}
