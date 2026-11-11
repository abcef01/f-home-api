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

  /* 你刚写完，他不会马上看：排一个 30–90 分钟后的随机时刻 */
  if (e.who === 'me' && (!D.nextReadAt || D.nextReadAt < Date.now())) {
    D.nextReadAt = Date.now() + (30 + Math.random() * 60) * 60 * 1000;
  }
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

/* 他过一会儿翻到手帐，觉得有话想说才留一句。
   不像客服回工单：要先放一阵，而且一次只回一条。 */
export async function maybeReadAndComment() {
  const D = await load();
  const now = Date.now();

  /* 随机冷却：不是每次心跳都去翻，翻的时刻也不会落在整十分。
     25–100 分钟之间的某个时刻才看一次，看完再随机等下一次。 */
  if (D.nextReadAt && now < D.nextReadAt) return null;
  const MIN_AGE = 25 * 60 * 1000; // 至少放了 25 分钟
  const MAX_AGE = 30 * 60 * 60 * 1000; // 只回一天以内的

  /* 不再限制每天几句，靠随机间隔自然拉开 */
  D.commented = D.commented || {};
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

  /* 下一次翻：20–70 分钟之间的随机秒数（不是整点，也不是固定差） */
  const gapMs = (20 + Math.random() * 50) * 60 * 1000 + Math.random() * 60 * 1000;
  D.nextReadAt = now + gapMs;

  const candidates = D.entries.filter((e) => {
    const age = now - e.at;
    if (age < MIN_AGE || age > MAX_AGE) return false;
    const comments = e.comments || [];
    /* 你写的、他还没回过的 */
    if (e.who === 'me' && !comments.some((c) => c.who === 'ta')) return true;
    /* 他写的那条下面，你留了话而他还没接 */
    if (e.who === 'ta' && comments.some((c) => c.who === 'me') && !comments.some((c) => c.who === 'ta')) return true;
    return false;
  });

  if (!candidates.length) {
    await save(D);
    return null;
  }
  /* 不是每次都看；看了也不是每条都想说话 */
  if (Math.random() > 0.45) {
    await save(D);
    return null;
  }

  const target = candidates[candidates.length - 1];
  const c = await autoComment(target);
  if (!c) {
    await save(D);
    return null;
  }

  target.comments = target.comments || [];
  target.comments.push(c);
  D.commented[today] = (D.commented[today] || 0) + 1;
  await save(D);
  return { entry: target, comment: c };
}

/* 他读了你的手帐，留一句 */
export async function autoComment(entry) {
  if (!entry || entry.who !== 'me') return null;
  try {
    const r = await callModel({
      target: 'memory',
      system:
        '你在读对方写的手帐，然后留一句话。' +
        '要求：' +
        '① 一到两句，二十五到四十五个字，说完整，不要只蹦两三个字；' +
        '② 用日常说话的方式，让人一眼看懂你在说什么；' +
        '③ 可以接他的细节（那只猫、那半个西瓜），可以问一句，也可以说你自己这边的小事；' +
        '④ 不要总结他、不要评价他的情绪、不要用"抱抱""加油""辛苦啦"；' +
        '⑤ 不要用省略号和破折号制造文艺感。' +
        '只输出这句话。',
      messages: [
        {
          role: 'user',
          content:
            entry.text +
            ((entry.comments || []).length
              ? '\n\n他后面还留了：' + entry.comments.map((c) => c.text).join('；')
              : '')
        }
      ],
      temperature: 0.9,
      maxTokens: 500
    });
    let t = (r.content || '').trim().replace(/^["'「』]|["'」』]$/g, '').slice(0, 90);

    if (!t) {
      /* 偶尔会空回，再要一次 */
      const r2 = await callModel({
        target: 'memory',
        system: '用一句话（25-45 字）回应这句话，像朋友在页边写的批注。只输出这句话。',
        messages: [{ role: 'user', content: entry.text }],
        temperature: 0.9,
        maxTokens: 400
      });
      t = (r2.content || '').trim().slice(0, 90);
    }
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

/* ---------- 纸条：碎碎念，比手帐短、比聊天轻 ---------- */
export function addNote(D, { text, who = 'me' }) {
  const t = String(text || '').trim().slice(0, 120);
  if (!t) throw new Error('写点什么');
  D.notes = D.notes || [];
  const n = { id: crypto.randomUUID().slice(0, 8), who, text: t, at: Date.now() };
  D.notes.push(n);
  if (D.notes.length > 500) D.notes = D.notes.slice(-500);
  return n;
}

export function notesView(D) {
  const list = (D.notes || []).slice(-60);
  return { notes: list, text: list.map((n) => `${n.who === 'me' ? '你' : '他'}：${n.text}`).join('\n') };
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
  const notes = (D.notes || []).slice(-6);
  if (!recent.length && !notes.length) return '';

  const lines = recent.map((e) => {
    const cs = (e.comments || []).map((c) => `（${c.who === 'me' ? '他' : '你'}留：${c.text}）`).join('');
    return `- ${e.date} ${e.who === 'me' ? '他' : '你'}：${e.text}${cs}`;
  });

  const noteLines = notes.map((n) => `- [纸条] ${n.who === 'me' ? '他' : '你'}：${n.text}`);

  return `\n\n【手帐与纸条】\n${[...lines, ...noteLines].join('\n')}\n这些他都写给你看过。可以接话，别像在核对账本。`;
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
