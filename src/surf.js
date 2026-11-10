/**
 * 自己上网逛一圈，带点东西回来
 * ------------------------------------------------------------
 * 思路参考 proactive-web-surf-agent（huihui191，MIT）：
 * 拉一批公开内容 → 去重 → 让模型挑一条真的想给你看的 → 写成一句话。
 * 这里没有用它的采集器（那些是 HN / GitHub，英文技术圈），
 * 换成了中文且稳定的几个公开接口。
 */
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const STATE_KEY = 'surf';
const MIN_GAP_MS = 3 * 3600 * 1000; // 最快三小时一次
const HOUR_MIN = 9;
const HOUR_MAX = 23;

const UA = { 'User-Agent': 'bunnys-home/1.0 (+personal companion app)' };

/* ---------- 采集 ---------- */
async function fetchJson(url, timeout = 12000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fromPoem() {
  const list = await Promise.all(
    [1, 2].map(() =>
      fetchJson('https://v1.jinrishici.com/all').then((j) => ({
        source: '今日诗词',
        text: j.content,
        title: `${j.author || ''}《${j.origin || ''}》`.trim(),
        url: ''
      }))
    )
  );
  return list.filter((x) => x.text);
}

async function fromHitokoto() {
  const list = await Promise.all(
    [1, 2].map(() =>
      fetchJson('https://v1.hitokoto.cn/?c=i&c=k').then((j) => ({
        source: '一言',
        text: j.hitokoto,
        title: j.from ? `${j.from}${j.from_who ? ' · ' + j.from_who : ''}` : '',
        url: ''
      }))
    )
  );
  return list.filter((x) => x.text);
}

async function collect() {
  const settled = await Promise.allSettled([fromPoem(), fromHitokoto()]);
  const out = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      for (const c of s.value) {
        if (c.text && !out.some((x) => x.text === c.text)) out.push(c);
      }
    }
  }
  return out;
}

/* ---------- 状态 ---------- */
async function readState() {
  if (!dbReady) return {};
  const { data } = await supabase.from('app_settings').select('value').eq('key', STATE_KEY).maybeSingle();
  return data?.value || {};
}

async function writeState(v) {
  if (!dbReady) return;
  await supabase.from('app_settings').upsert({ key: STATE_KEY, value: v, updated_at: new Date().toISOString() });
}

function shanghaiHour() {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).format(new Date());
  return Number(s) % 24;
}

/* ---------- 主流程 ---------- */
const SURF_PROMPT = `你在外面闲逛，看到几段文字。挑一段你此刻真的想拿给对方看的，然后写一两句话发给对方。
要求：
- 先自然地引出你看到的这句（可以原样引一小段），再说为什么想到对方；
- 不要像资讯播报，不要写“今日推荐”“我发现”这种开头；
- 不要提“联网”“搜索”“接口”这些词；
- 只输出要发的那段话，不要解释你的选择过程。`;

export async function runSurf({ force = false } = {}) {
  if (!dbReady) return { skipped: 'no-db' };

  const state = await readState();
  const now = Date.now();
  const hour = shanghaiHour();

  if (!force) {
    if (state.lastAt && now - state.lastAt < MIN_GAP_MS) return { skipped: 'too-soon' };
    if (hour < HOUR_MIN || hour > HOUR_MAX) return { skipped: 'night' };
  }

  let candidates = [];
  try {
    candidates = await collect();
  } catch (e) {
    return { skipped: 'fetch-failed', error: e.message };
  }
  if (candidates.length < 2) return { skipped: 'no-candidates' };

  const listing = candidates
    .map((c, i) => `${i + 1}. 「${c.text}」${c.title ? ' —— ' + c.title : ''}（来源：${c.source}）`)
    .join('\n');

  const reply = await callModel({
    system: SURF_PROMPT,
    messages: [{ role: 'user', content: listing }],
    temperature: 0.9,
    maxTokens: 1200
  });

  const text = (reply.content || '').trim();
  if (!text) return { skipped: 'empty' };

  /* 挑它可能引用的那条，作为卡片信息 */
  const picked = candidates.find((c) => text.includes(c.text.slice(0, 6))) || candidates[0];

  const { data: convs } = await supabase
    .from('conversations')
    .select('id')
    .order('updated_at', { ascending: false })
    .limit(1);
  const convId = convs?.[0]?.id;
  if (!convId) return { skipped: 'no-conversation' };

  const { data: saved, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: convId,
      role: 'assistant',
      content: text.slice(0, 500),
      model: reply.model,
      tokens: reply.tokens,
      meta: {
        surf: {
          source: picked.source,
          title: picked.title,
          quote: picked.text
        }
      }
    })
    .select()
    .single();
  if (error) return { skipped: 'save-failed', error: error.message };

  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
  await writeState({ lastAt: now, lastQuote: picked.text });

  return { spoke: saved };
}
