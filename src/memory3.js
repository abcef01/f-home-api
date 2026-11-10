/**
 * 三层记忆（借鉴 garan0613/pawwake 的结构，AGPL，思路借鉴、代码重写）
 * ------------------------------------------------------------
 *   碎片 fragment —— 每次对话后自动提炼的一两句原文要点
 *   事件 event    —— 同一天/同一主题的碎片合并成一段完整的事
 *   核心 core     —— 手动确认过的长期事实（生日、忌讳、关系…）
 *
 * 加一条召回门槛：只有关键词命中的才注入，宁缺毋滥。
 * 另外记「最近注入过什么」，避免同一段反复出现。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const KEY = 'mem3';
const MAX_FRAGMENTS = 120;
const MAX_EVENTS = 60;
const MAX_CORE = 60;
const SEEN_TTL = 6 * 3600 * 1000;

async function readState() {
  if (!dbReady) return { fragments: [], events: [], core: [], candidates: [], seen: {} };
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const v = data?.value || {};
  return {
    fragments: Array.isArray(v.fragments) ? v.fragments : [],
    events: Array.isArray(v.events) ? v.events : [],
    core: Array.isArray(v.core) ? v.core : [],
    candidates: Array.isArray(v.candidates) ? v.candidates : [],
    seen: v.seen && typeof v.seen === 'object' ? v.seen : {}
  };
}

async function writeState(s) {
  await supabase.from('app_settings').upsert({ key: KEY, value: s, updated_at: new Date().toISOString() });
}

export async function getMemory() {
  const s = await readState();
  return { fragments: s.fragments, events: s.events, core: s.core, candidates: s.candidates };
}

/* ---------- 分词（和 recall 一致） ---------- */
const STOP = new Set(['什么', '怎么', '为什么', '可以', '我们', '这个', '那个', '现在', '今天', '就是', '还是', '因为', '所以', '但是', '如果', '然后', '一个', '没有', '知道', '觉得']);

function keywords(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const out = new Set();
  for (const chunk of clean.split(/\s+/).filter(Boolean)) {
    if (/^[a-zA-Z0-9]+$/.test(chunk)) {
      if (chunk.length >= 3) out.add(chunk.toLowerCase());
      continue;
    }
    for (let i = 0; i + 3 <= chunk.length; i++) {
      const w = chunk.slice(i, i + 3);
      if (!STOP.has(w)) out.add(w);
    }
  }
  return [...out].slice(0, 6);
}

/* ---------- 1. 提取碎片 ---------- */
const EXTRACT_PROMPT = `你在给一段聊天做记忆归档。从下面的对话里提炼 1–2 条值得长期记住的「碎片」。
每条一句话，不超过 30 字，只写事实（谁做了什么、说了什么重要的、什么偏好），不要评价，不要复述整段。
如果有长期有效的事实（生日、忌讳、关系、工作、习惯），额外标 core=true。
只输出 JSON 数组，不要别的：
[{"text":"...","core":false}]`;

export async function captureExchange(userText, assistantText) {
  if (!dbReady) return;
  const s = await readState();
  try {
    const r = await callModel({
      target: 'memory',
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: `对方：${userText}\n你：${assistantText}` }],
      temperature: 0.3,
      maxTokens: 800
    });
    const raw = (r.content || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return;

    const now = Date.now();
    for (const item of list.slice(0, 2)) {
      const text = String(item.text || '').trim().slice(0, 60);
      if (!text) continue;
      /* 去重：内容太像就不重复存 */
      if (s.fragments.some((f) => f.text.includes(text.slice(0, 8)))) continue;
      s.fragments.push({ id: crypto.randomUUID(), text, at: now });

      if (item.core) {
        if (!s.candidates.some((c) => c.text === text) && !s.core.some((c) => c.text === text)) {
          s.candidates.push({ id: crypto.randomUUID(), text, at: now });
        }
      }
    }

    s.fragments = s.fragments.slice(-MAX_FRAGMENTS);
    s.candidates = s.candidates.slice(-20);
    await writeState(s);
    await maybeConsolidate(s);
  } catch (e) {
    console.warn('[mem3] 提取失败：', e.message.slice(0, 80));
  }
}

/* ---------- 2. 碎片合并成事件 ---------- */
const EVENT_PROMPT = `把下面这些零散的记忆碎片合并成一段「发生过的事」。
一段话，60 字以内，有时间和因果，像日记里的一行。不要分点，不要评价。
只输出这段文字。`;

async function maybeConsolidate(s) {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  const old = s.fragments.filter((f) => f.at < cutoff);
  if (old.length < 6) return;

  const batch = old.slice(0, 12);
  try {
    const r = await callModel({
      target: 'memory',
      system: EVENT_PROMPT,
      messages: [{ role: 'user', content: batch.map((f) => `- ${f.text}`).join('\n') }],
      temperature: 0.4,
      maxTokens: 600
    });
    const text = (r.content || '').trim().slice(0, 200);
    if (!text) return;

    s.events.push({ id: crypto.randomUUID(), text, at: Date.now(), covers: batch.length });
    s.events = s.events.slice(-MAX_EVENTS);
    const ids = new Set(batch.map((f) => f.id));
    s.fragments = s.fragments.filter((f) => !ids.has(f.id));
    delete s.seen;
    await writeState(s);
    console.log('[mem3] 合并了', batch.length, '条碎片成一条事件');
  } catch (e) {
    console.warn('[mem3] 合并失败：', e.message.slice(0, 60));
  }
}

/* ---------- 3. 召回 ---------- */
export async function memory3Block(userText) {
  const s = await readState();
  const words = keywords(userText);
  if (!words.length) return '';

  const hit = (text) => words.filter((w) => text.includes(w)).length;

  const score = (arr, label) =>
    arr
      .map((x) => ({ ...x, label, hits: hit(x.text) }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.at - a.at);

  /* 核心是常驻的：确认过的重要事实，不靠关键词也带上（最多 8 条） */
  const coreResident = s.core.slice(-8).map((x) => ({ ...x, label: '核心', hits: 99 }));

  /* 事件和碎片才走关键词 */
  const events = score(s.events, '事件').slice(0, 2);
  const frags = score(s.fragments, '碎片').slice(0, 2);

  const now = Date.now();
  const seen = s.seen || {};
  const fresh = (x) => !seen[x.id] || now - seen[x.id] > SEEN_TTL;

  const picked = [...coreResident, ...events, ...frags].filter(
    (x) => x.label === '核心' || fresh(x)
  );
  if (!picked.length) return '';

  for (const p of picked) seen[p.id] = now;
  s.seen = seen;
  await writeState(s);

  const lines = picked.map((p) => `- [${p.label}] ${p.text}`).join('\n');
  return `\n\n【你记得的相关的事】\n${lines}\n只在自然的时候带出来，别硬提，也别一次全说完。`;
}

/* ---------- 核心候选确认 ---------- */
export async function promoteCandidate(id, accept) {
  const s = await readState();
  const c = s.candidates.find((x) => x.id === id);
  s.candidates = s.candidates.filter((x) => x.id !== id);
  if (c && accept) {
    s.core.push({ id: crypto.randomUUID(), text: c.text, at: Date.now() });
    s.core = s.core.slice(-MAX_CORE);
  }
  await writeState(s);
  return { core: s.core, candidates: s.candidates };
}

export async function removeCore(id) {
  const s = await readState();
  s.core = s.core.filter((x) => x.id !== id);
  await writeState(s);
  return { core: s.core };
}
