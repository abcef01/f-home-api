/**
 * 它自己上网逛一圈，带点东西回来
 * ------------------------------------------------------------
 * 思路参考 proactive-web-surf-agent（huihui191，MIT）：
 * 拉一批公开内容 → 去重 → 让模型挑一条真的想给你看的 → 写成一句话。
 *
 * 内容源是「现在大家在看的、在聊的」：
 *   · B 站热门视频
 *   · 知乎日报
 *   · 百度热搜
 * 小红书没有公开接口（要登录态 + 签名，服务器 IP 会被拦），这里不碰。
 */
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const STATE_KEY = 'surf';
const MIN_GAP_MS = 3 * 3600 * 1000; // 最快三小时一次
const HOUR_MIN = 9;
const HOUR_MAX = 23;

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
};

async function fetchJson(url, timeout = 12000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------- B 站热门 ---------- */
async function fromBilibili() {
  const j = await fetchJson('https://api.bilibili.com/x/web-interface/popular?ps=8&pn=1');
  return (j.data?.list || []).slice(0, 8).map((v) => ({
    source: 'B站',
    title: v.title,
    summary: `${v.owner?.name || ''}${v.tname ? ' · ' + v.tname : ''}`,
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ''
  }));
}

/* ---------- 知乎日报 ---------- */
async function fromZhihu() {
  const j = await fetchJson('https://news-at.zhihu.com/api/4/news/latest');
  return (j.stories || []).slice(0, 6).map((s) => ({
    source: '知乎',
    title: s.title,
    summary: s.hint || '',
    url: s.url || ''
  }));
}

/* ---------- 百度热搜（结构嵌套，递归找 word） ---------- */
function collectWords(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.word === 'string' && node.word.trim()) {
    out.push({ word: node.word.trim(), url: node.url || '' });
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectWords(v, out);
  }
  return out;
}

async function fromBaidu() {
  const j = await fetchJson('https://top.baidu.com/api/board?platform=wise&tab=realtime');
  const words = collectWords(j).slice(0, 10);
  return words.map((w) => ({ source: '热搜', title: w.word, summary: '', url: w.url }));
}

async function collect() {
  const settled = await Promise.allSettled([fromBilibili(), fromZhihu(), fromBaidu()]);
  const out = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const c of s.value) {
      if (!c.title) continue;
      if (out.some((x) => x.title === c.title)) continue;
      out.push(c);
    }
  }
  return out.slice(0, 14);
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
const SURF_PROMPT = `你刚在网上随便逛，看到现在大家在看的、在聊的一些东西。
挑一条你此刻真的想拿给对方看的，然后写一两句话发给对方。

要求：
- 先说你在看什么（一句话讲清楚，别照抄标题），再说你的感受或为什么想到对方；
- 像刷到有意思的东西随手发给朋友那样，不要像新闻播报，不要列清单；
- 不要提「热搜」「接口」「联网」「抓取」这些词；
- 不要编造候选里没有的细节。

只输出一个 JSON 对象，不要任何别的文字：
{"index": 你选的编号（数字）, "message": "要发给对方的那两句话"}`;

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
  if (candidates.length < 3) return { skipped: 'no-candidates' };

  /* 最近发过的不再发 */
  const recent = new Set((state.recent || []).slice(-20));
  candidates = candidates.filter((c) => !recent.has(c.title));
  if (candidates.length < 3) return { skipped: 'all-seen' };

  const listing = candidates
    .map((c, i) => `${i + 1}. [${c.source}] ${c.title}${c.summary ? '（' + c.summary + '）' : ''}`)
    .join('\n');

  /* 主通道偶尔 500，退一次备用的 */
  let reply = null;
  try {
    reply = await callModel({
      system: SURF_PROMPT,
      messages: [{ role: 'user', content: listing }],
      temperature: 0.9,
      maxTokens: 1200
    });
  } catch (e1) {
    console.warn('[surf] 主通道失败：', e1.message.slice(0, 60), '→ 换备用');
    try {
      reply = await callModel({
        target: 'hapi',
        system: SURF_PROMPT,
        messages: [{ role: 'user', content: listing }],
        temperature: 0.9,
        maxTokens: 800
      });
    } catch (e2) {
      return { skipped: 'model-failed', error: e2.message };
    }
  }

  const raw = (reply.content || '').trim();
  if (!raw) return { skipped: 'empty' };

  /* 让它自己报名次；解析失败就退回文本匹配 */
  let pickedIndex = -1;
  let text = raw;
  try {
    const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
    if (Number.isInteger(j.index)) pickedIndex = j.index - 1;
    if (typeof j.message === 'string' && j.message.trim()) text = j.message.trim();
  } catch {
    const m = raw.match(/"index"\s*:\s*(\d+)/);
    if (m) pickedIndex = Number(m[1]) - 1;
    const mm = raw.match(/"message"\s*:\s*"([\s\S]*?)"\s*\}?\s*$/);
    if (mm) text = mm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  if (pickedIndex < 0 || pickedIndex >= candidates.length) {
    pickedIndex = Math.max(0, candidates.findIndex((c) => text.includes(c.title.slice(0, 8))));
  }
  const picked = candidates[pickedIndex] || candidates[0];

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
          url: picked.url || ''
        }
      }
    })
    .select()
    .single();
  if (error) return { skipped: 'save-failed', error: error.message };

  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
  await writeState({
    lastAt: now,
    recent: [...(state.recent || []), picked.title].slice(-30)
  });

  return { spoke: saved };
}
