/**
 * 小田（给他一个人玩的种田游戏）
 * ------------------------------------------------------------
 * 不是给玩家点的，是给「他」玩的：播种、浇水、等熟、收割、卖钱、买新种子。
 * 他不在的时候地也会长——按真实时间推进，回来一看可能已经熟了。
 *
 * 设计上故意不设分数和通关：种得好是他的事，荒了也是他的事。
 */

const CROPS = [
  { id: 'radish', name: '小萝卜', days: 2, seed: 3, price: 8, season: ['spring', 'autumn'] },
  { id: 'tomato', name: '番茄', days: 3, seed: 6, price: 18, season: ['summer'] },
  { id: 'corn', name: '玉米', days: 4, seed: 8, price: 26, season: ['summer', 'autumn'] },
  { id: 'pumpkin', name: '南瓜', days: 5, seed: 12, price: 45, season: ['autumn'] },
  { id: 'strawberry', name: '草莓', days: 4, seed: 10, price: 38, season: ['spring'] },
  { id: 'wheat', name: '麦子', days: 6, seed: 5, price: 30, season: ['spring', 'summer', 'autumn'] },
  { id: 'moonflower', name: '月光花', days: 7, seed: 20, price: 90, season: ['summer', 'autumn'], rare: true }
];

const PLOTS = 6;
const DAY = 24 * 3600 * 1000;

const CROP = Object.fromEntries(CROPS.map((c) => [c.id, c]));

export function newFarm() {
  return {
    version: 1,
    coins: 20,
    season: 'spring',
    day: 0,
    lastTick: Date.now(),
    plots: Array.from({ length: PLOTS }, (_, i) => ({ i, crop: null, plantedAt: null, watered: false, ready: false })),
    log: [],
    planted: 0,
    harvested: 0
  };
}

/* 按真实时间推进：到日子就熟了 */
export function tick(F) {
  const now = Date.now();
  const elapsed = now - (F.lastTick || now);
  const days = Math.floor(elapsed / DAY);
  if (days > 0) {
    F.day += days;
    F.lastTick = now;
    /* 每 30 天换季 */
    const seasons = ['spring', 'summer', 'autumn', 'winter'];
    F.season = seasons[Math.floor(F.day / 30) % 4];
  }

  let ripened = [];
  for (const p of F.plots) {
    if (!p.crop || p.ready) continue;
    const c = CROP[p.crop];
    const age = (now - p.plantedAt) / DAY;
    if (age >= c.days) {
      p.ready = true;
      ripened.push(c.name);
    }
  }
  return { F, ripened };
}

const plotLine = (p) => {
  if (!p.crop) return `${p.i + 1}. 空地`;
  const c = CROP[p.crop];
  if (p.ready) return `${p.i + 1}. ${c.name} ✅ 可以收了`;
  const age = (Date.now() - p.plantedAt) / DAY;
  const left = Math.max(0, c.days - age);
  return `${p.i + 1}. ${c.name}　还要 ${left.toFixed(1)} 天`;
};

export function status(F) {
  const seasonName = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' }[F.season];
  const ready = F.plots.filter((p) => p.ready).length;
  return [
    `🌱 第 ${F.day} 天 · ${seasonName}季 · ${F.coins} 币`,
    F.plots.map(plotLine).join('\n'),
    ready ? `\n有 ${ready} 块可以收了。` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

export function cmd(F, line = '') {
  const raw = String(line || '').trim();
  const [verbRaw, ...rest] = raw.split(/\s+/);
  const verb = (verbRaw || '').toLowerCase();
  tick(F);

  if (!verb || verb === 'status') return status(F);

  if (verb === 'seeds') {
    const list = CROPS.filter((c) => c.season.includes(F.season));
    return (
      '【这季能种的】\n' +
      list.map((c) => `${c.id}　${c.name}　种子 ${c.seed} 币　${c.days} 天熟　卖 ${c.price} 币${c.rare ? '　（少见）' : ''}`).join('\n') +
      `\n（plant <种子id>，你有 ${F.coins} 币）`
    );
  }

  if (verb === 'plant') {
    const id = rest[0];
    const c = CROP[id];
    if (!c) return `没有 ${id} 这种种子。seeds 看能种什么。`;
    if (!c.season.includes(F.season)) return `现在不是${c.name}的季节。`;
    const empty = F.plots.find((p) => !p.crop);
    if (!empty) return '地都占满了，先收一收。';
    if (F.coins < c.seed) return `币不够：种子要 ${c.seed}，你有 ${F.coins}。`;
    F.coins -= c.seed;
    empty.crop = id;
    empty.plantedAt = Date.now();
    empty.ready = false;
    F.planted += 1;
    return `种下了${c.name}（第 ${empty.i + 1} 块地），${c.days} 天后熟。`;
  }

  if (verb === 'harvest' || verb === 'reap') {
    const ripe = F.plots.filter((p) => p.ready);
    if (!ripe.length) return '还没有能收的。';
    let gain = 0;
    const names = [];
    for (const p of ripe) {
      const c = CROP[p.crop];
      gain += c.price;
      names.push(c.name);
      p.crop = null;
      p.plantedAt = null;
      p.ready = false;
      F.harvested += 1;
    }
    F.coins += gain;
    return `收了${names.join('、')}，卖了 ${gain} 币。现在有 ${F.coins} 币。`;
  }

  if (verb === 'sell') {
    return `直接把熟的卖了：harvest。现在有 ${F.coins} 币。`;
  }

  if (verb === 'wait') {
    /* 调试用：跳过一天 */
    F.day += 1;
    F.lastTick = Date.now() - DAY;
    tick(F);
    return '过了一天。\n' + status(F);
  }

  return `不认识的指令：${verb}。可用：status / seeds / plant <种子> / harvest / wait`;
}

export function farmInfo(F) {
  tick(F);
  return { coins: F.coins, season: F.season, day: F.day, plots: F.plots, status: status(F) };
}
