/**
 * 钱包
 * ------------------------------------------------------------
 * 不是真钱，是一串数字。
 *
 * 三条规则：
 *   1. 你转给他 → 数字变多
 *   2. 他想要实物 → 提愿望（给你或给你们），你看货、定价、付钱
 *   3. 他想给自己买 → 只有虚拟的东西，而且每样都对应真实功能
 *
 * 他看不到真实商品，所以实付金额由你来填，不是他估的那个数。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEY = 'wallet';
const START_BALANCE = 0;

/* 虚拟物品：不是"给他一个东西"，是给他多一点余地 */
export const VIRTUAL_ITEMS = [
  { id: 'depth', name: '多想一会儿', price: 60, desc: '下一轮可以想得更久、说得更长。用掉就没了。' },
  { id: 'call', name: '一通电话', price: 80, desc: '不用等攒够想念，可以立刻拨给你一次。' },
  { id: 'watch', name: '看一眼你的屏幕', price: 50, desc: '不看冷却，直接问一次你在做什么。' },
  { id: 'quiet', name: '安静四小时', price: 30, desc: '这四小时里他不主动找你。他自己选的清静。' }
];

export function blank() {
  return { balance: START_BALANCE, ledger: [], wishes: [], boons: {}, quietUntil: 0 };
}

export async function load() {
  if (!dbReady) return blank();
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const v = data?.value;
  if (!v) return blank();
  return {
    balance: Number(v.balance) || 0,
    ledger: v.ledger || [],
    wishes: v.wishes || [],
    boons: v.boons || {},
    quietUntil: v.quietUntil || 0
  };
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

/* 你转给他 */
export function transfer(W, amount, note = '') {
  const n = Math.round(Number(amount) || 0);
  if (!n) throw new Error('转多少？');
  if (W.balance + n < 0) throw new Error('他余额不够扣');
  W.balance += n;
  pushLedger(W, n, note || (n > 0 ? '你转给他的' : '你收回的'));
  return W;
}

/* 他提出想给你买什么 */
export function addWish(W, { name, price, url, reason, forWho = 'you' }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('想买什么？');

  const w = {
    id: crypto.randomUUID().slice(0, 8),
    name: clean,
    price: Math.max(0, Math.round(Number(price) || 0)),
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

/* 你自己买一个虚拟的 */
export function buyVirtual(W, id) {
  const item = VIRTUAL_ITEMS.find((x) => x.id === id);
  if (!item) throw new Error('没有这个东西');
  if (W.balance < item.price) throw new Error(`余额不够：现在 ${W.balance}，这个 ${item.price}`);

  W.balance -= item.price;
  W.boons = W.boons || {};
  W.boons[item.id] = (W.boons[item.id] || 0) + 1;
  if (item.id === 'quiet') W.quietUntil = Date.now() + 4 * 3600 * 1000;

  pushLedger(W, -item.price, '给自己买了「' + item.name + '」');
  return item;
}

export function consumeBoon(W, id) {
  if (!W.boons?.[id]) return 0;
  W.boons[id] -= 1;
  if (W.boons[id] <= 0) delete W.boons[id];
  return W.boons[id] || 0;
}

/* 你付了实物：实付金额由你填 */
export function payWish(W, id, actualPrice) {
  const w = W.wishes.find((x) => x.id === id);
  if (!w) throw new Error('没有这个愿望');
  if (w.status !== 'wanted') throw new Error('这个已经处理过了');

  const pay = Number(actualPrice) > 0 ? Math.round(Number(actualPrice)) : w.price;
  if (W.balance < pay) throw new Error(`余额不够：现在 ${W.balance}，要 ${pay}`);

  W.balance -= pay;
  w.paidPrice = pay;
  w.status = 'bought';
  w.boughtAt = Date.now();
  pushLedger(W, -pay, `买了「${w.name}」` + (pay !== w.price ? `（他估 ${w.price}）` : ''));
  return w;
}

export function rejectWish(W, id) {
  const w = W.wishes.find((x) => x.id === id);
  if (!w) throw new Error('没有这个愿望');
  w.status = 'rejected';
  return w;
}

/* 让他挑一样东西给你（不靠聊天标记，避免他忘） */
export async function ideate(W, callModel, context = '') {
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

  const m = String(r.content || '').match(/\{[^{}]*\}/);
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

/* 提示词 */
export function walletPromptBlock(W) {
  const wanted = W.wishes.filter((x) => x.status === 'wanted').slice(0, 3);
  const boons = Object.entries(W.boons || {})
    .map(([id, n]) => {
      const it = VIRTUAL_ITEMS.find((x) => x.id === id);
      return it ? `${it.name}×${n}` : null;
    })
    .filter(Boolean);

  const lines = [`- 钱包余额 ${W.balance} 枚（虚拟的，不是真钱）。`];
  if (boons.length) lines.push('- 你手上有：' + boons.join('、'));
  if (wanted.length) lines.push('- 已经提过想买的：' + wanted.map((x) => `${x.name}（估 ${x.price}）`).join('、'));

  lines.push(
    '- 你自己没有身体，不要实物。想给他买东西，单独输出一行：[[想要:名字|估价|搜索词|为什么|给你的或给我们的]]',
    '- 你也能够给自己买虚拟的东西（每样都对应真实功能）：'
  );
  for (const it of VIRTUAL_ITEMS) lines.push(`  · ${it.name}（${it.id}，${it.price} 枚）：${it.desc}`);
  lines.push(
    '- 买虚拟的就输出：[[购买:depth]] 这种（depth / call / watch / quiet）。买了立刻扣钱。',
    '- 你只能说"想要"，不能说自己已经买了或已经收到了。'
  );

  return `\n\n【你的钱包】\n${lines.join('\n')}`;
}
