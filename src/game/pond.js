/**
 * 瓶中生态
 * ------------------------------------------------------------
 * 灵感来自 Zizuixixiang/cedareco（一池清水、鱼会死、水会臭）。
 * 原版一万七千行、有定居者亲缘和天气年鉴，这里不搬，另写一个小的：
 * 还是那件事——放什么进去、放多少、什么时候放，全是你的事；
 * 生态会自己演化，你只能看着。
 *
 * 没有分数，没有通关。不做任何"你应该怎样"的提示。
 */

/* 物种：吃谁、被谁吃、繁殖快慢、对水质的要求 */
const SPECIES = {
  algae: { name: '藻类', prey: [], preyed: ['daphnia', 'snail'], grow: 0.34, needLight: true, needsOxygen: 0, waste: 0.5, cn: '绿' },
  weed: { name: '水草', prey: [], preyed: [], grow: 0.18, needLight: true, needsOxygen: 2, waste: -0.6, cn: '草' },
  daphnia: { name: '水蚤', prey: ['algae'], preyed: ['minnow'], grow: 0.42, needLight: false, needsOxygen: 3, waste: 0.2, cn: '蚤' },
  snail: { name: '田螺', prey: ['algae'], preyed: [], grow: 0.12, needLight: false, needsOxygen: 3, waste: 0.3, cn: '螺' },
  minnow: { name: '小鱼', prey: ['daphnia'], preyed: [], grow: 0.1, needLight: false, needsOxygen: 5, waste: 0.6, cn: '鱼' },
  nymph: { name: '水虿', prey: ['daphnia', 'minnow'], preyed: [], grow: 0.06, needLight: false, needsOxygen: 4, waste: 0.4, cn: '虿' }
};

const ORDER = ['algae', 'weed', 'daphnia', 'snail', 'minnow', 'nymph'];

class Rng {
  constructor(state) {
    this.s = state >>> 0;
  }
  next() {
    const a = (this.s + 0x6d2b79f5) >>> 0;
    this.s = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) + t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export function newPond(seed = Date.now() >>> 0) {
  return {
    version: 1,
    seed: seed >>> 0,
    day: 0,
    water: { clarity: 1, oxygen: 8, algaeFree: true },
    pop: { algae: 0, weed: 0, daphnia: 0, snail: 0, minnow: 0, nymph: 0 },
    history: [],
    events: [],
    ended: false
  };
}

const total = (S) => ORDER.reduce((a, k) => a + S.pop[k], 0);

function oxygenUse(S) {
  return ORDER.reduce((a, k) => a + S.pop[k] * SPECIES[k].needsOxygen * 0.01, 0);
}
function wasteLoad(S) {
  return ORDER.reduce((a, k) => a + S.pop[k] * SPECIES[k].waste * 0.01, 0);
}

/* 一天过去 */
export function step(S, days = 1) {
  const rng = new Rng(S.seed + S.day * 7919);
  const log = [];

  for (let d = 0; d < days; d++) {
    if (S.ended) break;
    S.day += 1;

    /* 藻类靠光长；水草造氧；动物耗氧 */
    const weedOxy = S.pop.weed * 0.02;
    const use = oxygenUse(S);
    S.water.oxygen = Math.max(0, Math.min(14, S.water.oxygen + weedOxy - use + 1.2));

    /* 浑浊度：废物累积，水草和田螺清理 */
    const load = wasteLoad(S);
    const clean = S.pop.weed * 0.004 + S.pop.snail * 0.006;
    S.water.clarity = Math.max(0, Math.min(1, S.water.clarity - load * 0.05 + clean + 0.02));

    /* 各物种增减 */
    for (const key of ORDER) {
      const sp = SPECIES[key];
      const n = S.pop[key];
      if (n <= 0) continue;

      let growth = 0;

      if (key === 'algae') {
        /* 靠光和水里的营养；但水浑了会遮光 */
        growth = sp.grow * n * (0.4 + S.water.clarity) * (S.water.oxygen > 1 ? 1 : 0.3);
      } else {
        /* 捕食者：食物够就涨 */
        let food = 0;
        for (const prey of sp.prey) food += S.pop[prey];
        const satiety = food / (n * 4 + 1);
        growth = sp.grow * n * Math.min(1.4, satiety);
      }

      /* 被吃 */
      let eaten = 0;
      for (const pred of ORDER) {
        if (!SPECIES[pred].prey.includes(key)) continue;
        eaten += S.pop[pred] * 0.22;
      }

      /* 缺氧、水臭 */
      let die = 0;
      if (S.water.oxygen < sp.needsOxygen) die += n * 0.25;
      if (S.water.clarity < 0.25) die += n * 0.08;

      const rand = (rng.next() - 0.5) * 0.1 * n;
      S.pop[key] = Math.max(0, Math.round(n + growth - eaten - die + rand));
    }

    /* 事件：藻华、缺氧翻塘 */
    if (S.pop.algae > 220 && S.water.clarity > 0.6 && rng.next() < 0.3) {
      S.water.clarity = Math.max(0, S.water.clarity - 0.25);
      S.events.push(`第 ${S.day} 天：水绿得看不见底了。`);
    }
    if (S.water.oxygen < 2 && total(S) > 60) {
      const dead = Math.round(S.pop.minnow * 0.5);
      S.pop.minnow = Math.max(0, S.pop.minnow - dead);
      if (dead) S.events.push(`第 ${S.day} 天：天没亮，水面上浮了几条鱼。`);
      S.water.clarity = Math.max(0, S.water.clarity - 0.1);
    }

    S.history.push({ day: S.day, pop: { ...S.pop }, oxygen: Number(S.water.oxygen.toFixed(1)), clarity: Number(S.water.clarity.toFixed(2)) });
  }

  return log;
}

/* 指令 */
export function cmd(S, line = '') {
  const raw = String(line || '').trim();
  const [verbRaw, ...rest] = raw.split(/\s+/);
  const verb = (verbRaw || '').toLowerCase();

  if (!verb || verb === 'status' || verb === '看') return statusText(S);

  if (verb === 'help') {
    return [
      'add <东西> [数量]　放进去（algae 藻 / weed 水草 / daphnia 水蚤 / snail 田螺 / minnow 小鱼 / nymph 水虿）',
      'wait [天数]　　　让时间过去',
      'feed 　　　　　　撒一点饵（养水蚤和小鱼，但会脏水）',
      'skim 　　　　　　捞掉一些藻',
      'water 　　　　　 换水（稀释浑浊，也带走一点氧）',
      'status 　　　　　看池子'
    ].join('\n');
  }

  if (verb === 'add') {
    const map = { 藻: 'algae', 藻类: 'algae', 水草: 'weed', 水蚤: 'daphnia', 田螺: 'snail', 螺: 'snail', 小鱼: 'minnow', 鱼: 'minnow', 水虿: 'nymph' };
    const key = SPECIES[rest[0]] ? rest[0] : map[rest[0]];
    if (!key) return '能放：algae 藻 / weed 水草 / daphnia 水蚤 / snail 田螺 / minnow 小鱼 / nymph 水虿';
    const n = Math.max(1, parseInt(rest[1], 10) || 2);
    S.pop[key] += n;
    return `放进了 ${SPECIES[key].name} ×${n}。\n` + statusText(S);
  }

  if (verb === 'wait' || verb === '等') {
    const d = Math.max(1, Math.min(30, parseInt(rest[0], 10) || 1));
    step(S, d);
    const recent = S.events.slice(-3);
    return `过了 ${d} 天。\n` + (recent.length ? recent.join('\n') + '\n' : '') + statusText(S);
  }

  if (verb === 'feed') {
    S.pop.daphnia += 3;
    S.water.clarity = Math.max(0, S.water.clarity - 0.05);
    return '撒了一点饵。水蚤多了几条，水也浑了一点。';
  }

  if (verb === 'skim') {
    const take = Math.round(S.pop.algae * 0.35);
    S.pop.algae -= take;
    S.water.clarity = Math.min(1, S.water.clarity + 0.12);
    return take ? `捞掉了 ${take} 团藻，水清了一些。` : '水里没什么藻可捞。';
  }

  if (verb === 'water') {
    S.water.clarity = Math.min(1, S.water.clarity + 0.4);
    S.water.oxygen = Math.max(0, S.water.oxygen - 1);
    S.pop.daphnia = Math.round(S.pop.daphnia * 0.7);
    return '换了水。清是清了，也冲走了一些水蚤。';
  }

  if (verb === 'reset' || verb === 'new') {
    Object.assign(S, newPond(Date.now() >>> 0));
    return '一池清水。\n' + statusText(S);
  }

  return `不认识的指令：${verb}（help 看看能做什么）`;
}

function statusText(S) {
  const totalPop = total(S);
  const alive = ORDER.filter((k) => S.pop[k] > 0).map((k) => `${SPECIES[k].name} ${S.pop[k]}`);
  const bar = (x) => (x > 0.75 ? '清' : x > 0.45 ? '有点浑' : x > 0.2 ? '浑' : '看不见底');
  const oxy = S.water.oxygen > 7 ? '足' : S.water.oxygen > 4 ? '一般' : S.water.oxygen > 2 ? '有点闷' : '快没了';

  return [
    `🫙 第 ${S.day} 天｜水${bar(S.water.clarity)}｜氧${oxy}｜一共 ${totalPop} 个活物`,
    alive.length ? '　' + alive.join('　') : '　空的。放点什么进去吧。',
    S.events.length ? '最近：' + S.events.slice(-2).join(' / ') : ''
  ]
    .filter(Boolean)
    .join('\n');
}

export function pondInfo(S) {
  return {
    day: S.day,
    pop: S.pop,
    water: S.water,
    status: statusText(S),
    events: S.events.slice(-5),
    history: S.history.slice(-30)
  };
}
