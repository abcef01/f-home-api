/**
 * 钱包
 * ------------------------------------------------------------
 * 不是真钱，是一串数字。
 *
 * 他能说的话：
 *   · 你转给他 → 数字变多
 *   · 他想要什么 → 提一个愿望（名字、价格、搜索链接、为什么）
 *   · 你付了 → 数字变少，愿望变成"已买"
 *
 * 他不能自己扣钱：所有支出都要你确认。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEY = 'wallet';
const START_BALANCE = 0;

export function blank() {
  return { balance: START_BALANCE, ledger: [], wishes: [] };
}

export async function load() {
  if (!dbReady) return blank();
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const v = data?.value;
  if (!v) return blank();
  return { balance: Number(v.balance) || 0, ledger: v.ledger || [], wishes: v.wishes || [] };
}

export async function save(W) {
  if (!dbReady) return W;
  await supabase.from('app_settings').upsert({ key: KEY, value: W, updated_at: new Date().toISOString() });
  return W;
}

function pushLedger(W, delta, note) {
  W.ledger.unshift({ id: crypto.randomUUID().slice(0, 8), delta, note, at: Date.now() });
  if (W.ledger.length > 200) W.ledger = W.ledger.slice(0, 200);
}

/* 你转给他（amount 可以为负，等于收回） */
export function transfer(W, amount, note = '') {
  const n = Math.round(Number(amount) || 0);
  if (!n) throw new Error('转多少？');
  if (W.balance + n < 0) throw new Error('他余额不够扣');

  W.balance += n;
  pushLedger(W, n, note || (n > 0 ? '你转给他的' : '你收回的'));
  return W;
}

/* 他提一个愿望 */
export function addWish(W, { name, price, url, reason, forWho = 'you' }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('想买什么？');

  const p = Math.max(0, Math.round(Number(price) || 0));
  const w = {
    id: crypto.randomUUID().slice(0, 8),
    name: clean,
    price: p,
    url: String(url || '').trim().slice(0, 300),
    reason: String(reason || '').trim().slice(0, 140),
    forWho: forWho === 'us' ? 'us' : 'you',
    status: 'wanted',
    at: Date.now()
  };
  W.wishes.unshift(w);
  if (W.wishes.length > 60) W.wishes = W.wishes.slice(0, 60);
  return w;
}

/* 你付了：余额减少，愿望变成已买 */
export function payWish(W, id) {
  const w = W.wishes.find((x) => x.id === id);
  if (!w) throw new Error('没有这个愿望');
  if (w.status !== 'wanted') throw new Error('这个已经处理过了');
  if (W.balance < w.price) throw new Error(`余额不够：现在 ${W.balance}，要 ${w.price}`);

  W.balance -= w.price;
  w.status = 'bought';
  w.boughtAt = Date.now();
  pushLedger(W, -w.price, `买了「${w.name}」`);
  return w;
}

export function rejectWish(W, id) {
  const w = W.wishes.find((x) => x.id === id);
  if (!w) throw new Error('没有这个愿望');
  w.status = 'rejected';
  w.at = w.at;
  return w;
}

/* 让他主动挑一样东西给你（不靠聊天里的标记，避免他忘了写） */
export async function ideate(W, callModel, context = '') {
  /* 给个方向，免得每次都是保温杯 */
  const DIRECTIONS = ['能吃的', '写的用的', '摆在桌上的', '穿的戴的', '看的读的', '拿来玩的', '手作的', '能一起做的'];
  const dir = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
  const had = (W.wishes || []).map((x) => x.name).slice(0, 6).join('、');

  const r = await callModel({
    target: 'memory',
    system:
      '你要给对方买一样东西。你没有身体，不买给自己，只能买给他或你们一起用。' +
      '从日常能买到的便宜实物里挑一样，价格五十到两百之间，不要奢侈品。' +
      '不要每次都挑杯子、保温杯这类东西，要有点具体的心思。' +
      '只输出 JSON，不要别的：{"name":"东西名字","price":数字,"search":"购物网站搜什么","reason":"为什么想给他买，二十到四十字","forWho":"you或us"}',
    messages: [
      {
        role: 'user',
        content:
          (context ? '关于他：' + context + '\n' : '') +
          (had ? '以前提过这些，别再重复：' + had + '\n' : '') +
          '这次往「' + dir + '」这个方向想。\n' +
          '你手里有 ' + W.balance + ' 枚。挑一样。'
      }
    ],
    temperature: 0.95,
    maxTokens: 1400
  });
  const text = String(r.content || '');
  const m = text.match(/{[^{}]*}/);
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!j.name) return null;
  return addWish(W, {
    name: j.name,
    price: j.price,
    url: 'https://s.taobao.com/search?q=' + encodeURIComponent(j.search || j.name),
    reason: j.reason || '',
    forWho: j.forWho
  });
}

/* 给提示词用的一段话 */
export function walletPromptBlock(W) {
  const wanted = W.wishes.filter((x) => x.status === 'wanted').slice(0, 3);

  const lines = [`- 你手里有 ${W.balance} 枚（虚拟的，不是真钱）。`];
  if (wanted.length) {
    lines.push('- 你正想要的：' + wanted.map((x) => `${x.name}（${x.price} 枚）`).join('、'));
  }
  lines.push(
    '- 你自己没有身体，不需要任何东西——不买给自己。这些钱只有一个用处：给他买东西，或者买给你们两个一起用的东西（比如一本要一起读的书、一盒贴纸）。',
    '- 想给他买什么，必须同时输出这一行标记，否则他收不到：',
    '  [[想要:名字|价格|搜索词|为什么想给他买|给你的]]',
    '  例子：[[想要:一次性相机|129|一次性相机 胶片|你说想拍点没用的东西，这个拍完不用管]]',
    '- 名字要具体（能搜到的实物），价格写合理的市场价，搜索词写购物网站里会输入的字。',
    '- 最后一个字段只能是「给你的」或「给我们的」。',
    '- 只要你在话里说了要买，就必须输出标记行；只在嘴上说而不写标记，等于没提。',
    '- 你不能说自己已经买了。买不买由他决定。'
  );
  return `\n\n【你的钱包】\n${lines.join('\n')}
- 硬规则：这一轮如果你打算给他买任何东西，回复的最后必须单独一行写 [[想要:名字|价格|搜索词|为什么|给你的]]。只在正文里说"想给你买个午睡枕"而不写这一行，等于没买，他只会看到一句话。`;
}
