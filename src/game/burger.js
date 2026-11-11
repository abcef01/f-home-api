/**
 * 中午的汉堡店
 * ------------------------------------------------------------
 * 移植自 linzhi-524/noon-burger-shop 的核心循环（Python 1787 行 → 这里只搬玩法）：
 * 看订单 → 上烤台 → 翻面/等待 → 取出 → 按顺序叠 → 加酱 → 出餐。
 *
 * 分数构成照原版：准确度 40 + 火候 25 + 摆放 15 + 速度 20 = 100。
 * 没搬：城市事件、剧情 beat、探店主播那些扩展。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(fs.readFileSync(path.join(here, 'burger-data.json'), 'utf8'));

const CUSTOMERS = Object.values(DATA.CUSTOMERS).filter((c) => c && c.name);
const UNLOCKS = DATA.UNLOCKS;
const RENOVATIONS = DATA.RENOVATIONS;
const ALIASES = DATA.ALIASES;
const AMOUNTS = DATA.AMOUNTS;
const DAY_ORDER_COUNT = DATA.DAY_ORDER_COUNT;
const GOALS = DATA.GOALS;

const PROTEINS = ['牛肉饼', '鸡肉饼', '煎蛋', '培根'];
const SAUCES = ['番茄酱', '蛋黄酱', '辣酱'];

/* ---------- 随机（确定性） ---------- */
class Rng {
  constructor(state, calls = 0) {
    this.state = state >>> 0;
    this.calls = calls;
  }
  random() {
    this.calls += 1;
    const a = (this.state + 0x6d2b79f5) >>> 0;
    this.state = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) {
    return Math.floor(this.random() * n);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  sample(arr, k) {
    const copy = [...arr];
    const out = [];
    while (out.length < k && copy.length) out.push(copy.splice(this.int(copy.length), 1)[0]);
    return out;
  }
}

/* ---------- 熟度 ---------- */
function doneness(protein, t) {
  if (protein === '牛肉饼') return t <= 1 ? '生' : t === 2 ? '嫩' : t === 3 ? '正好' : t === 4 ? '焦熟' : '烧焦';
  if (protein === '鸡肉饼') return t <= 2 ? '未熟' : t === 3 ? '正好' : t === 4 ? '偏干' : '烧焦';
  if (protein === '煎蛋') return t <= 2 ? '流心' : t === 3 ? '全熟' : '焦';
  if (protein === '培根') return t <= 1 ? '软' : t === 2 ? '脆' : '焦';
  return '未知';
}

const TARGET_TIME = {
  '牛肉饼:嫩': 2,
  '牛肉饼:正好': 3,
  '鸡肉饼:正好': 3,
  '煎蛋:流心': 2,
  '煎蛋:全熟': 3,
  '培根:软': 1,
  '培根:脆': 2
};

/* ---------- 状态 ---------- */
export function newGame({ seed = Date.now() >>> 0 } = {}) {
  return {
    version: 1,
    seed: seed >>> 0,
    rngState: seed >>> 0,
    rngCalls: 0,
    day: 1,
    week: 1,
    turn: 0,
    coins: 0,
    grill: { A: null, B: null },
    cooked: [],
    layers: [],
    sauces: {},
    renovations: [],
    orderIdx: 0,
    orders: [],
    dayScores: [],
    goal: null,
    finished: false
  };
}

const unlocked = (day) => {
  const out = [];
  for (let d = 1; d <= day; d++) out.push(...(UNLOCKS[String(d)] || []));
  return out;
};

const hasRenovation = (S, name) => S.renovations.includes(name);
const grillSlots = (S) => (hasRenovation(S, '高级灶台') ? 3 : 2);

function ensureGrill(S) {
  const n = grillSlots(S);
  const keys = ['A', 'B', 'C'].slice(0, n);
  for (const k of keys) if (!(k in S.grill)) S.grill[k] = null;
}

const currentOrder = (S) => S.orders[S.orderIdx] || null;

/* ---------- 生成订单 ---------- */
function generateOrder(S, rng) {
  const day = S.day;
  const avail = unlocked(day);
  const customer = rng.pick(CUSTOMERS);
  const bun = rng.pick(['原味胚', ...(avail.includes('全麦胚') ? ['全麦胚'] : [])]);
  const vegetarian = customer.name === '伊芙';

  let protein = null;
  if (vegetarian) protein = avail.includes('煎蛋') && rng.random() < 0.75 ? '煎蛋' : null;
  else {
    const proteins = ['牛肉饼', '鸡肉饼'].filter((p) => avail.includes(p));
    const liked = proteins.filter((p) => customer.likes.includes(p));
    protein = rng.pick(liked.length ? liked : proteins);
  }

  let pool = ['芝士', '生菜', '番茄', '洋葱', '酸黄瓜', '培根'].filter(
    (x) => avail.includes(x) && !customer.dislikes.includes(x)
  );
  if (vegetarian) pool = pool.filter((x) => x !== '培根');
  const count = Math.min(pool.length, vegetarian ? 2 + rng.int(3) : 1 + rng.int(4));
  const toppings = count ? rng.sample(pool, count) : [];
  if (customer.focus === 'portion' && day >= 5 && protein) toppings.push(protein);

  const saucePool = SAUCES.filter((x) => avail.includes(x) && !customer.dislikes.includes(x));
  const sauce = saucePool.length && rng.random() < 0.72 ? rng.pick(saucePool) : null;
  const sauceAmount = sauce ? rng.pick(['少量', '正常']) : null;

  let target = null;
  if (protein === '牛肉饼') target = rng.pick(['嫩', '正好']);
  else if (protein === '鸡肉饼') target = '正好';
  else if (protein === '煎蛋') target = rng.pick(['流心', '全熟']);
  else if (protein === '培根') target = rng.pick(['软', '脆']);

  const lower = toppings.filter((x) => ['生菜', '番茄', '洋葱', '酸黄瓜'].includes(x));
  const hot = toppings.filter((x) => ['芝士', '培根'].includes(x));
  const layers = [bun, ...lower.slice(0, 2), ...(protein ? [protein] : []), ...hot, ...lower.slice(2), bun];

  let basePrice = 12 + toppings.length * 2 + (protein ? 5 : 0) + (sauce ? 2 : 0);
  if (toppings.includes(protein)) basePrice += 5;
  if (hasRenovation(S, '霓虹招牌')) basePrice += 2;

  const cookOps = protein ? TARGET_TIME[`${protein}:${target}`] || 3 : 0;
  let minOps = cookOps + 1 + (hasRenovation(S, '加宽操作台') ? 0 : 1);
  if (sauce && !hasRenovation(S, '自动酱料机')) minOps += 1;
  const patience = minOps + Math.max(2, customer.patience - 6) + (hasRenovation(S, '暖色壁灯') ? 1 : 0);

  return {
    customer: customer.name,
    focus: customer.focus,
    patience,
    base_price: basePrice,
    bun,
    protein,
    doneness: target,
    toppings,
    sauce,
    sauce_amount: sauceAmount,
    required_layers: layers,
    dislikes: customer.dislikes,
    tip_mult: customer.tip,
    vegetarian
  };
}

function startDay(S, rng) {
  ensureGrill(S);
  const count = DAY_ORDER_COUNT[String(S.day)] || Math.min(10, 8 + Math.floor((S.week - 1) / 2));
  S.orders = Array.from({ length: count }, () => generateOrder(S, rng));
  S.orderIdx = 0;
  S.turn = 0;
  S.cooked = [];
  S.layers = [];
  S.sauces = {};
  return `🌤️ 第 ${S.day} 天开门，今天 ${count} 张单。`;
}

export function cmd(S, line = '') {
  const raw = String(line || '').trim();
  const [verbRaw, ...rest] = raw.split(/\s+/);
  const verb = (verbRaw || '').toLowerCase();
  const rng = new Rng(S.rngState, S.rngCalls);

  const done = () => {
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
  };

  if (S.finished && verb !== 'restart' && verb !== 'status') return '这一周结束了。restart 再开一家。';

  if (!verb || verb === 'status') return statusText(S);
  if (verb === 'restart') {
    Object.assign(S, newGame({ seed: Date.now() >>> 0 }));
    return '换了块牌子，重新开张。\n' + startDay(S, rng);
  }

  if (!S.orders.length && verb !== 'shop' && verb !== 'buy') {
    const msg = startDay(S, rng);
    done();
    return msg + '\n' + statusText(S);
  }

  if (verb === 'order' || verb === '单子') {
    return orderText(S);
  }

  if (verb === 'grill' || verb === '烤') {
    const p = ALIASES[rest[0]] || ALIASES[String(rest[0] || '').toLowerCase()];
    if (!PROTEINS.includes(p)) return '可烤：牛肉饼 / 鸡肉饼 / 煎蛋 / 培根';
    ensureGrill(S);
    const slot = Object.keys(S.grill).find((k) => !S.grill[k]);
    if (!slot) return '烤台满了，先取一个下来。';
    S.grill[slot] = { protein: p, time: 0, flipped: false };
    advance(S, 1);
    done();
    return `${p} 放上 ${slot} 号位。\n` + grillHint(S, S.grill[slot]);
  }

  if (verb === 'flip' || verb === '翻面') {
    ensureGrill(S);
    const item = S.grill[(rest[0] || 'A').toUpperCase()];
    if (!item) return '这个位置是空的。';
    if (item.flipped) return '已经翻过了。';
    item.flipped = true;
    return `${rest[0].toUpperCase()} 号位翻面了。\n` + grillHint(S, item);
  }

  if (verb === 'wait' || verb === '等') {
    advance(S, 1);
    done();
    return '等了一回合。\n' + grillText(S);
  }

  if (verb === 'take' || verb === '取') {
    ensureGrill(S);
    const key = (rest[0] || 'A').toUpperCase();
    const item = S.grill[key];
    if (!item) return '这个位置是空的。';
    item.doneness = doneness(item.protein, item.time);
    S.cooked.push(item);
    S.grill[key] = null;
    return `取出${item.protein}，熟度：${item.doneness}。`;
  }

  if (verb === 'build' || verb === '叠') {
    const layers = [];
    for (const token of rest) {
      const f = ALIASES[token] || ALIASES[token.toLowerCase()];
      if (!f) return `认不出：${token}`;
      layers.push(f);
    }
    S.layers = layers;
    if (!hasRenovation(S, '加宽操作台')) advance(S, 1);
    done();
    return '叠好了：' + layers.join(' → ');
  }

  if (verb === 'sauce' || verb === '酱') {
    const s = ALIASES[rest[0]] || ALIASES[String(rest[0] || '').toLowerCase()];
    const amount = AMOUNTS[rest[1]] || AMOUNTS[String(rest[1] || '').toLowerCase()];
    if (!SAUCES.includes(s)) return '酱料：番茄酱 / 蛋黄酱 / 辣酱';
    if (!amount) return '用量：少量 / 正常 / 过量';
    S.sauces[s] = amount;
    if (!hasRenovation(S, '自动酱料机')) advance(S, 1);
    done();
    return `加了${s}：${amount}。`;
  }

  if (verb === 'serve' || verb === '出餐') {
    const o = currentOrder(S);
    if (!o) return '今天没有单了。day 结束今天。';
    const r = evaluate(S, o);
    const coins = Math.round((o.base_price * o.tip_mult * r.total) / 100);
    S.coins += coins;
    S.dayScores.push(r.total);
    S.orderIdx += 1;
    S.cooked = [];
    S.layers = [];
    S.sauces = {};
    S.turn = 0;
    done();
    const next = currentOrder(S);
    return (
      `🍔 出餐！评分 ${r.total}/100（准确 ${r.acc} · 火候 ${r.fire} · 摆放 ${r.plate} · 速度 ${r.speed}）\n` +
      `${r.details.length ? r.details.join('；') + '\n' : ''}` +
      `拿到 ${coins} 币，共 ${S.coins} 币。\n` +
      (next ? `\n下一位：${next.customer}` : '\n今天的单做完了，day 收摊。')
    );
  }

  if (verb === 'day' || verb === '收摊') {
    const msg = finishDay(S);
    done();
    return msg;
  }

  if (verb === 'shop') return shopText(S);

  if (verb === 'buy') {
    const name = rest.join(' ');
    const r = RENOVATIONS[name];
    if (!r) return '没有这个装修。shop 看列表。';
    if (hasRenovation(S, name)) return '已经装过了。';
    if (S.coins < r.cost) return `钱不够：${name} 要 ${r.cost}，你有 ${S.coins}。`;
    S.coins -= r.cost;
    S.renovations.push(name);
    return `装好了【${name}】：${r.desc}。剩 ${S.coins} 币。`;
  }

  if (verb === 'goal') {
    const g = rest.join(' ');
    if (!GOALS.includes(g)) return '目标可选：' + GOALS.join(' / ');
    S.goal = g;
    return `本周目标：${g}。`;
  }

  return `不认识的指令：${verb}。可用：order / grill <肉> / flip <位> / wait / take <位> / build <食材...> / sauce <酱> <量> / serve / day / shop / buy <装修> / goal <目标> / status`;
}

function advance(S, steps) {
  S.turn += steps;
  for (const k of Object.keys(S.grill)) {
    const it = S.grill[k];
    if (it) it.time += steps;
  }
}

function grillHint(S, item) {
  const now = doneness(item.protein, item.time);
  const o = currentOrder(S);
  if (o && o.protein === item.protein && o.doneness) {
    const tt = TARGET_TIME[`${item.protein}:${o.doneness}`];
    if (tt != null) {
      const delta = tt - item.time;
      if (delta > 0) return `现在${now}，再 ${delta} 回合就是「${o.doneness}」`;
      if (delta === 0) return `正好是「${o.doneness}」，现在取`;
      return `已经过火 ${Math.abs(delta)} 回合，赶紧取。`;
    }
  }
  return `当前熟度：${now}`;
}

function grillText(S) {
  const keys = Object.keys(S.grill);
  return keys
    .map((k) => (S.grill[k] ? `  ${k}：${S.grill[k].protein} ${doneness(S.grill[k].protein, S.grill[k].time)}（${S.grill[k].time} 回合）` : `  ${k}：空`))
    .join('\n');
}

function orderText(S) {
  const o = currentOrder(S);
  if (!o) return '今天没有单了。day 收摊。';
  return [
    `👤 ${o.customer}　耐心 ${o.patience - S.turn} 回合　价位 ${o.base_price}`
  ]
    .concat([`🍔 要：${o.required_layers.join(' → ')}`])
    .concat([o.protein ? `🥩 ${o.protein}：要「${o.doneness}」` : ''])
    .concat([o.sauce ? `🧴 ${o.sauce}（${o.sauce_amount}）` : '不要酱'])
    .concat([o.dislikes.length ? `🚫 忌口：${o.dislikes.join('、')}` : ''])
    .concat([`（第 ${S.turn} 回合，已过 ${S.turn} 回合）`])
    .join('\n');
}

function evaluate(S, o) {
  let acc = 40;
  let fire = 25;
  let plate = 15;
  let speed = 20;
  const details = [];

  const count = (arr, x) => arr.filter((y) => y === x).length;
  const missing = [];
  const extra = [];
  for (const x of new Set([...o.required_layers, ...S.layers])) {
    const d = count(S.layers, x) - count(o.required_layers, x);
    if (d < 0) missing.push(...Array(-d).fill(x));
    if (d > 0) extra.push(...Array(d).fill(x));
  }

  if (missing.length) {
    const p = Math.min(24, 6 * missing.length);
    acc -= p;
    details.push(`缺${missing.join('、')} -${p}`);
  }
  if (extra.length) {
    const p = Math.min(20, 5 * extra.length);
    acc -= p;
    details.push(`多${extra.join('、')} -${p}`);
  }
  for (const bad of o.dislikes) {
    if (S.layers.includes(bad) || S.sauces[bad]) {
      acc -= 15;
      details.push(`忌口 ${bad} -15`);
    }
  }
  if (o.sauce) {
    const got = S.sauces[o.sauce];
    if (!got) {
      acc -= 8;
      details.push(`少${o.sauce} -8`);
    } else if (got !== o.sauce_amount) {
      acc -= 5;
      details.push(`${o.sauce}用量错 -5`);
    }
    for (const s of Object.keys(S.sauces)) {
      if (s !== o.sauce) {
        acc -= 6;
        details.push(`多加了${s} -6`);
      }
    }
  } else if (Object.keys(S.sauces).length) {
    acc -= 10;
    details.push('不要酱 -10');
  }

  if (o.protein) {
    const cooked = S.cooked.find((x) => x.protein === o.protein);
    if (!cooked) {
      fire = 0;
      details.push('主料没烤 -25');
    } else {
      if (cooked.doneness !== o.doneness) {
        fire -= 12;
        details.push(`要${o.doneness}实际${cooked.doneness} -12`);
      }
      if (['牛肉饼', '鸡肉饼'].includes(o.protein) && !cooked.flipped) {
        fire = Math.min(fire, 15);
        details.push('没翻面，火候上限 15');
      }
    }
  }

  if (S.layers.join('|') !== o.required_layers.join('|')) {
    let common = 0;
    S.layers.forEach((x, i) => {
      if (i < o.required_layers.length && x === o.required_layers[i]) common += 1;
    });
    plate = Math.min(plate, Math.floor((15 * common) / Math.max(1, o.required_layers.length)));
    details.push(`层次对了一部分 ${plate}/15`);
  }

  const left = o.patience - S.turn;
  if (left >= 2) speed = 20;
  else if (left === 1) speed = 17;
  else if (left === 0) speed = 13;
  else {
    speed = Math.max(0, 13 + left * 3);
    details.push(`出餐晚了，速度 ${speed}/20`);
  }

  if (o.focus === 'speed' && speed < 20) speed = Math.max(0, speed - 2);
  if (o.focus === 'plating' && plate < 15) plate = Math.max(0, plate - 2);
  if (o.focus === 'fire' && fire < 25) fire = Math.max(0, fire - 3);
  if (o.focus === 'accuracy' && acc < 40) acc = Math.max(0, acc - 2);

  if (hasRenovation(S, '招牌照片墙')) plate = Math.max(plate, 8);

  acc = Math.max(0, Math.min(40, acc));
  fire = Math.max(0, Math.min(25, fire));
  plate = Math.max(0, Math.min(15, plate));
  speed = Math.max(0, Math.min(20, speed));

  return { acc, fire, plate, speed, total: Math.max(0, Math.min(100, acc + fire + plate + speed)), details };
}

function finishDay(S) {
  const avg = S.dayScores.length ? Math.round(S.dayScores.reduce((a, b) => a + b, 0) / S.dayScores.length) : 0;
  const bonus = Math.round(avg >= 90 ? 30 : avg >= 75 ? 15 : 0);
  S.coins += bonus;
  const msg = `🌙 第 ${S.day} 天收摊。平均 ${avg} 分，奖金 ${bonus} 币，共 ${S.coins} 币。`;
  S.dayScores = [];
  S.orders = [];
  S.orderIdx = 0;
  S.day += 1;
  if (S.day > 7) {
    S.finished = true;
    return msg + `\n🎉 一周过去了，最后有 ${S.coins} 币。restart 再开一家。`;
  }
  return msg;
}

function shopText(S) {
  const list = Object.entries(RENOVATIONS)
    .map(([name, r]) => `  ${name}　${r.cost} 币　${r.desc}${hasRenovation(S, name) ? '（已装）' : ''}`)
    .join('\n');
  return `🛠️ 装修（buy <名字>，你有 ${S.coins} 币）\n${list}`;
}

function statusText(S) {
  const o = currentOrder(S);
  return [
    `🍔 第 ${S.day}/7 天 · ${S.coins} 币 · 第 ${S.orderIdx + (o ? 1 : 0)}/${S.orders.length} 单`,
    o ? `👤 ${o.customer}（耐心 ${o.patience - S.turn}）` : '今天没单了',
    '烤台：\n' + grillText(S),
    S.layers.length ? `叠好的：${S.layers.join(' → ')}` : '还没叠'
  ].join('\n');
}

export function gameInfo(S) {
  ensureGrill(S);
  return { status: statusText(S), day: S.day, coins: S.coins, order: currentOrder(S), grill: S.grill };
}
