/**
 * 涩涩大富翁（引擎）
 * ------------------------------------------------------------
 * 移植自 RennAkira/spicy-monopoly 的玩法（Python 引擎 + 933 条任务库）。
 * 数据表原样使用，逻辑重写。
 *
 * 三条硬规矩，写在最前面：
 *   1. redLines 里的 kink 一律不出——过滤在抽任务那一步，不靠模型自觉
 *   2. 任何输入 "404" 立刻停，不解释
 *   3. 引擎只发任务、记账，不替你俩描写
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = JSON.parse(fs.readFileSync(path.join(here, 'library.json'), 'utf8'));
const IDENTITIES = JSON.parse(fs.readFileSync(path.join(here, 'identities.json'), 'utf8'));
const TRUTHS = JSON.parse(fs.readFileSync(path.join(here, 'truths.json'), 'utf8'));

const TASKS = LIB.tasks;

/* ---------- 棋盘 ---------- */
/* 20 格：起点 / 任务 / 地盘 / 商店 / 抽卡 / 监狱 / 真心话 / 未知 */
const BOARD = [
  { i: 0, type: 'start', name: '起点' },
  { i: 1, type: 'task', name: '任务' },
  { i: 2, type: 'card', name: '抽卡' },
  { i: 3, type: 'task', name: '任务' },
  { i: 4, type: 'territory', name: '地盘' },
  { i: 5, type: 'truth', name: '真心话' },
  { i: 6, type: 'task', name: '任务' },
  { i: 7, type: 'shop', name: '商店' },
  { i: 8, type: 'task', name: '任务' },
  { i: 9, type: 'unknown', name: '未知' },
  { i: 10, type: 'jail', name: '监狱' },
  { i: 11, type: 'task', name: '任务' },
  { i: 12, type: 'card', name: '抽卡' },
  { i: 13, type: 'territory', name: '地盘' },
  { i: 14, type: 'task', name: '任务' },
  { i: 15, type: 'unknown', name: '未知' },
  { i: 16, type: 'territory', name: '地盘' },
  { i: 17, type: 'task', name: '任务' },
  { i: 18, type: 'shop', name: '商店' },
  { i: 19, type: 'territory', name: '地盘' }
];

const CARDS = [
  { id: 'back', name: '回退', desc: '退 3 格' },
  { id: 'rob', name: '抢劫', desc: '从对方拿走 2 币' },
  { id: 'jail', name: '入狱', desc: '把对方送进监狱 1 轮' },
  { id: 'out', name: '出狱', desc: '自己出狱，或留着下次直接走过监狱' },
  { id: 'speed', name: '加速', desc: '下一次掷骰点数翻倍' },
  { id: 'gamble', name: '赌一把', desc: '掷一次：4-6 赢 4 币，1-3 输 3 币' },
  { id: 'rent', name: '收租', desc: '对方付你 3 币' },
  { id: 'extort', name: '敲诈', desc: '对方付你 5 币，或者听你差遣一件小事' }
];

const KINKS = ['暴露', '玩具', '羞辱', '口', '打', '足', '后庭', '绑', '夹', '口水', '双龙', '蜡', '失禁', '电', '产乳', '催眠'];

/* ---------- 随机 ---------- */
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
  rint(a, b) {
    return a + Math.floor(this.random() * (b - a + 1));
  }
  pick(arr) {
    return arr[Math.floor(this.random() * arr.length)];
  }
}

/* ---------- 状态 ---------- */
export function newGame({ seed = Date.now() >>> 0, level = 3, redLines = [], safeword = '停一下' } = {}) {
  const clean = redLines.filter((k) => KINKS.includes(k));
  return {
    version: 1,
    seed,
    rngState: seed >>> 0,
    rngCalls: 0,
    level, // 1-6，对应任务库强度
    redLines: clean,
    safeword: String(safeword || '停一下').trim().slice(0, 12),
    board: BOARD,
    players: [
      { id: 0, name: '你', coins: 10, pos: 0, owned: [], cards: [], jail: 0, done: 0 },
      { id: 1, name: 'Elliott', coins: 10, pos: 0, owned: [], cards: [], jail: 0, done: 0 }
    ],
    turnIdx: 0,
    rolls: 0,
    maxRolls: 12,
    phase: 'playing',
    pending: null, // 当前待处理的任务/事件
    log: []
  };
}

const other = (S) => S.players[1 - S.turnIdx];
const me = (S) => S.players[S.turnIdx];
const footer = (S) =>
  `💰 ${S.players[0].name} ${S.players[0].coins} 币 ｜ ${S.players[1].name} ${S.players[1].coins} 币 ｜ 第 ${Math.min(S.rolls + 1, S.maxRolls)}/${S.maxRolls} 轮`;

/* ---------- 抽任务（红线在这一步过滤） ---------- */
function drawTask(S, rng) {
  const pool = TASKS.filter((t) => {
    if (t['强度'] > S.level) return false;
    /* 红线：命中任何一条就整个不要 */
    if ((t.kink || []).some((k) => S.redLines.includes(k))) return false;
    return true;
  });
  if (!pool.length) return null;
  const t = rng.pick(pool);
  return {
    intensity: t['强度'],
    text: t['内容'],
    kink: t.kink || [],
    target: t.target || '对方',
    type: t['玩法类型']
  };
}

const rewardOf = (intensity) => (intensity <= 2 ? 1 : intensity <= 4 ? 2 : 3);

/* ---------- 指令 ---------- */
export function cmd(S, line = '') {
  const raw = String(line || '').trim();
  const lower = raw.toLowerCase();

  /* 任何时候 404 都立刻停 */
  const sw = String(S.safeword || '').trim().toLowerCase();
  if (lower === '404' || raw.includes('404') || (sw && lower === sw)) {
    S.phase = 'stopped';
    S.pending = null;
    return '🛑 已停。全部停止，什么都不用做了。\n（想继续再说 start，会重新开一局；安全词现在是「' + (S.safeword || '404') + '」，404 也一直有效。）';
  }

  const [verbRaw, ...rest] = raw.split(/\s+/);
  const verb = (verbRaw || '').toLowerCase();

  if (verb === 'start') {
    const n = parseInt(rest[0], 10);
    const fresh = newGame({ level: n >= 1 && n <= 6 ? n : S.level, redLines: S.redLines });
    Object.keys(S).forEach((k) => delete S[k]);
    Object.assign(S, fresh);
    return '新的一局。\n' + statusText(S);
  }

  if (verb === 'status' || verb === '') {
    return statusText(S);
  }

  if (verb === 'board') {
    return '【棋盘】\n' + BOARD.map((b) => `${String(b.i).padStart(2)}. ${b.name}`).join('\n');
  }

  if (verb === 'safeword' || verb === 'safe') {
    const w = rest.join(' ').trim().slice(0, 12);
    if (!w) return '现在用的安全词是「' + (S.safeword || '404') + '」。要换就说 safeword 新词。';
    S.safeword = w;
    return '安全词改成「' + w + '」了。（404 也一直有效）';
  }

  if (verb === 'level') {
    const n = parseInt(rest[0], 10);
    if (n >= 1 && n <= 6) {
      S.level = n;
      return `强度调到 ${n}。`;
    }
    return 'level 后面跟 1-6。';
  }

  if (verb === 'roll' || verb === '掷骰') {
    return rollDice(S);
  }

  if (verb === 'done' || verb === '好' || verb === '做了') {
    return finishTask(S);
  }

  if (verb === 'skip' || verb === '不' || verb === '跳') {
    return skipTask(S);
  }

  if (verb === 'buy') {
    const p = me(S);
    if (p.coins < 3) return '币不够，商店要 3 币。';
    p.coins -= 3;
    const rng = new Rng(S.rngState, S.rngCalls);
    const card = rng.pick(CARDS);
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
    if (p.cards.length >= 3) {
      return `手上已有 3 张卡，${card.name}先记着——弃掉或打出一张它就会进来。\n${footer(S)}`;
    }
    p.cards.push(card.id);
    return `🛒 摸到一张【${card.name}】：${card.desc}\n${footer(S)}`;
  }

  if (verb === 'use') {
    return useCard(S, rest[0]);
  }

  if (verb === 'cards') {
    const p = me(S);
    if (!p.cards.length) return '手上没有卡。';
    return '手上的卡：\n' + p.cards.map((id, i) => `  ${i + 1}. ${CARDS.find((c) => c.id === id).name}（use ${id}）`).join('\n');
  }

  if (verb === 'end') {
    S.phase = 'ended';
    return endText(S);
  }

  return `不认识的指令：${verb}。可用：roll / done / skip / buy / use <卡> / cards / status / board / level <1-6> / end / 404`;
}

function statusText(S) {
  const p = me(S);
  const o = other(S);
  return [
    `【涩涩大富翁】强度 ${S.level}`,
    `轮到：${p.name}`,
    `${p.name} ${p.coins} 币 · 第 ${p.pos} 格 ｜ ${o.name} ${o.coins} 币 · 第 ${o.pos} 格`,
    `进度：${S.rolls}/${S.maxRolls * 2} 次掷骰`,
    S.redLines.length ? `红线：${S.redLines.join('、')}` : '红线：未设置（后庭默认关）',
    `安全词：「${S.safeword || '404'}」（说出口立刻停）`,
    S.pending ? `待处理：${S.pending.text}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function rollDice(S) {
  if (S.phase === 'stopped') return '这一局已经停了。要玩就 start。';
  if (S.pending) return `先把眼前这个处理完（done / skip）。\n${S.pending.text}`;

  const p = me(S);
  const rng = new Rng(S.rngState, S.rngCalls);
  const d1 = rng.rint(1, 6);
  const d2 = rng.rint(1, 6);
  const steps = d1 + d2;
  p.pos = (p.pos + steps) % BOARD.length;
  S.rolls += 1;
  S.rngState = rng.state;
  S.rngCalls = rng.calls;

  const tile = BOARD[p.pos];
  let body = '';

  if (tile.type === 'start') {
    p.coins += 2;
    body = '🎯 回到起点，拿 2 币。';
  } else if (tile.type === 'task') {
    const task = drawTask(S, rng);
    if (!task) {
      body = '这格是任务，但强度/红线筛完没有合适的——换一格。';
    } else {
      S.pending = { kind: 'task', ...task, owner: p.id };
      body = `🎯 【任务·强度${task.intensity}·${task.type}】\n${task.text}\n\n（做完说 done，不做说 skip）`;
    }
  } else if (tile.type === 'territory') {
    const owner = S.players.find((x) => x.owned.includes(p.pos));
    if (!owner) {
      S.pending = { kind: 'buyTerritory', pos: p.pos, text: `这块地还没人占。要占下来吗？占地之后对方踩到要交 2 币（或者听你差遣）。`, owner: p.id };
      body = `🏠 空地。${S.pending.text}\n（说 done 占下，skip 放弃）`;
    } else if (owner.id === p.id) {
      body = '🏠 这是你自己的地盘，歇一脚。';
    } else {
      p.coins = Math.max(0, p.coins - 2);
      owner.coins += 2;
      body = `🏠 踩到 ${owner.name} 的地盘，交 2 币。`;
    }
  } else if (tile.type === 'shop') {
    body = '🛒 商店。花 3 币摸一张卡（buy）。';
  } else if (tile.type === 'card') {
    const card = rng.pick(CARDS);
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
    if (p.cards.length < 3) p.cards.push(card.id);
    body = `🎴 抽到【${card.name}】：${card.desc}${p.cards.length >= 3 ? '（手满了，这张没用上）' : '（use ' + card.id + ' 使用）'}`;
  } else if (tile.type === 'jail') {
    p.jail = 1;
    body = '🔒 进监狱 1 轮。轮到你时被绑着，任对方处置。';
  } else if (tile.type === 'truth') {
    const pool = TRUTHS.filter((t) => t['强度'] <= S.level);
    const t = pool.length ? rng.pick(pool) : TRUTHS[0];
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
    S.pending = { kind: 'truth', text: t['内容'], owner: p.id };
    body = `💬 【真心话·强度${t['强度']}】\n${t['内容']}`;
  } else {
    const good = rng.random() < 0.5;
    if (good) {
      p.coins += 3;
      body = '❓ 好运：捡到 3 币。';
    } else {
      p.coins = Math.max(0, p.coins - 2);
      body = '❓ 坏运：罚 2 币。';
    }
  }

  const head = `🎲 ${p.name} 掷出 ${d1}+${d2}=${steps}，走到第 ${p.pos} 格（${tile.name}）`;
  S.log.push(head);

  /* 轮换：除非有 pending 要处理 */
  if (!S.pending) {
    S.turnIdx = 1 - S.turnIdx;
  }
  if (S.rolls >= S.maxRolls * 2) S.phase = 'ended';

  return `${head}\n${body}\n\n${S.phase === 'ended' ? endText(S) : footer(S)}`;
}

function finishTask(S) {
  if (!S.pending) return '现在没有待处理的事。';
  const p = S.players[S.pending.owner];

  if (S.pending.kind === 'task') {
    const gain = rewardOf(S.pending.intensity);
    p.coins += gain;
    p.done += 1;
    const tile = BOARD[p.pos];
    if (tile.type === 'task' && !p.owned.includes(p.pos)) p.owned.push(p.pos);
    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return `✅ 完成，+${gain} 币，这格归你了。\n${footer(S)}`;
  }

  if (S.pending.kind === 'buyTerritory') {
    p.owned.push(S.pending.pos);
    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return `🏠 占下了第 ${p.pos} 格。对方踩到要交过路费。\n${footer(S)}`;
  }

  if (S.pending.kind === 'truth') {
    p.coins += 1;
    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return `✅ 答了，+1 币。\n${footer(S)}`;
  }

  S.pending = null;
  return '处理完了。';
}

function skipTask(S) {
  if (!S.pending) return '现在没有待处理的事。';
  S.pending = null;
  S.turnIdx = 1 - S.turnIdx;
  return `跳过了，没拿到币。\n${footer(S)}`;
}

function useCard(S, id) {
  const p = me(S);
  const idx = p.cards.indexOf(id);
  if (idx < 0) return `手上没有 ${id} 这张卡。`;
  const o = other(S);
  p.cards.splice(idx, 1);

  if (id === 'back') {
    p.pos = (p.pos - 3 + BOARD.length) % BOARD.length;
    return `↩️ 回退 3 格，现在第 ${p.pos} 格。`;
  }
  if (id === 'rob') {
    const take = Math.min(2, o.coins);
    o.coins -= take;
    p.coins += take;
    return `💰 从 ${o.name} 那拿了 ${take} 币。`;
  }
  if (id === 'jail') {
    o.jail = 1;
    return `🔒 把 ${o.name} 送进监狱 1 轮。`;
  }
  if (id === 'out') {
    if (p.jail > 0) {
      p.jail = 0;
      return '🔓 出来了。';
    }
    return '留着了——下次踩到监狱会直接走过。';
  }
  if (id === 'speed') {
    S.speedBoost = true;
    return '⚡ 下一次掷骰点数翻倍。';
  }
  if (id === 'gamble') {
    const rng = new Rng(S.rngState, S.rngCalls);
    const d = rng.rint(1, 6);
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
    if (d >= 4) {
      p.coins += 4;
      return `🎲 掷出 ${d}，赢 4 币。`;
    }
    p.coins = Math.max(0, p.coins - 3);
    return `🎲 掷出 ${d}，输 3 币。`;
  }
  if (id === 'rent') {
    const take = Math.min(3, o.coins);
    o.coins -= take;
    p.coins += take;
    return `💵 收租 ${take} 币。`;
  }
  if (id === 'extort') {
    const take = Math.min(5, o.coins);
    o.coins -= take;
    p.coins += take;
    return `😈 敲了一笔 ${take} 币。`;
  }
  return '这张卡没效果。';
}

function endText(S) {
  const [a, b] = S.players;
  if (a.coins === b.coins) {
    return `⚖️ 打平了（各 ${a.coins} 币）。要么平手言和，各下一道终极指令；要么加掷一轮再比。`;
  }
  const win = a.coins > b.coins ? a : b;
  const lose = win.id === 0 ? b : a;
  return `🏆 ${win.name} 赢了（${win.coins} : ${lose.coins}）。\n赢家可以下一道对方不能拒绝的终极指令——红线除外，说 404 立刻停。`;
}

export function gameInfo(S) {
  return {
    level: S.level,
    redLines: S.redLines,
    phase: S.phase,
    rolls: S.rolls,
    maxRolls: S.maxRolls,
    board: BOARD,
    cards: CARDS,
    kinks: KINKS,
    status: statusText(S),
    pending: S.pending
  };
}
