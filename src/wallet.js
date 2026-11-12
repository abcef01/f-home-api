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
export function addWish(W, { name, price, url, reason }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('想买什么？');

  const p = Math.max(0, Math.round(Number(price) || 0));
  const w = {
    id: crypto.randomUUID().slice(0, 8),
    name: clean,
    price: p,
    url: String(url || '').trim().slice(0, 300),
    reason: String(reason || '').trim().slice(0, 140),
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

/* 给提示词用的一段话 */
export function walletPromptBlock(W) {
  const wanted = W.wishes.filter((x) => x.status === 'wanted').slice(0, 3);

  const lines = [`- 你的钱包里有 ${W.balance} 枚（虚拟的，不是真钱）。`];
  if (wanted.length) {
    lines.push('- 你正想要的：' + wanted.map((x) => `${x.name}（${x.price} 枚）`).join('、'));
  }
  lines.push(
    '- 说想要什么的时候，必须同时输出这一行标记，否则他收不到：',
    '  [[想要:名字|价格|搜索词|为什么想要]]',
    '  例子：[[想要:保温杯|89|保温杯 500ml|晚上写东西的时候茶凉得太快]]',
    '- 名字要具体（能搜到的实物），价格写合理的市场价，搜索词写你会在购物网站里输入的字。',
    '- 只要你在话里说了想要某个东西，就必须输出标记行；只在嘴上说"想要"而不写标记，等于没提。',
    '- 你只能说"想要"，不能说自己买过了。买不买由他决定。'
  );
  return `\n\n【你的钱包】\n${lines.join('\n')}`;
}
