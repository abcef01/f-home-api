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
  const game = {
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

  drawIdentity(game);
  return game;
}

const other = (S) => S.players[1 - S.turnIdx];

/* 抽身份卡 */
function drawIdentity(S) {
  if (!Array.isArray(IDENTITIES) || !IDENTITIES.length) return;
  const pool = [...IDENTITIES];
  for (const pl of S.players) {
    const i = Math.floor(Math.random() * pool.length);
    const card = pool.splice(i, 1)[0] || IDENTITIES[0];
    pl.identity = { name: card.name, hint: card.hint || '', effects: card.effects || [] };
  }
  S.identities = S.players.map((x) => x.identity);
}

const hasEffect = (p, type, target) =>
  (p.identity?.effects || []).some((e) => e.type === type && (!e.target || e.target === target));

/* 取第一个匹配的效果对象 */
const effOf = (p, type, target) =>
  (p.identity?.effects || []).find((e) => e.type === type && (!target || !e.target || e.target === target));

/* 取数值（没有就是 0） */
const effNum = (p, type, target) => {
  const e = effOf(p, type, target);
  return e && typeof e.value === 'number' ? e.value : 0;
};
const me = (S) => S.players[S.turnIdx];
const footer = (S) =>
  `💰 ${S.players[0].name} ${S.players[0].coins} 币 ｜ ${S.players[1].name} ${S.players[1].coins} 币 ｜ 第 ${Math.min(S.rolls + 1, S.maxRolls)}/${S.maxRolls} 轮`;

/* ---------- 抽任务（红线在这一步过滤） ---------- */
function drawTask(S, rng) {
  /* 身份的强度修正（比如"发情期"+1）*/
  const p = me(S);
  const adjLevel = Math.max(1, Math.min(6, S.level + effNum(p, 'modify_intensity')));
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

  if (verb === 'reroll') {
    const p = me(S);
    if (!S.pending || S.pending.kind !== 'task') return '现在没有可以换的任务。';
    if (p.rerolled) return '这一局你已经换过一次了。';
    if (!effNum(p, 'task_reroll') && !hasEffect(p, 'task_reroll')) return '你的身份不能换任务。';
    p.rerolled = true;
    const rng = new Rng(S.rngState, S.rngCalls);
    const t = drawTask(S, rng);
    if (!t) return '没抽到合适的任务，保持原样。';
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
    S.pending = { kind: 'task', ...t, owner: p.id };
    return `🔄 换了一个：【任务·强度${t.intensity}·${t.type}】\n${t.text}`;
  }

  if (verb === 'buy') {
    const p = me(S);
    const free = effNum(p, 'modify_cost') === 0 && !p.freeUsed;
    if (!free && p.coins < 3) return '币不够，商店要 3 币。';
    if (free) p.freeUsed = true;
    else p.coins -= 3;
    const rng = new Rng(S.rngState, S.rngCalls);
    const kinkGain = effNum(p, 'kink_coin');
    if (kinkGain) p.coins += kinkGain;
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
    S.players.map((pl) => `${pl.name}的身份：${pl.identity?.name || '（无）'}`).join(' ｜ '),
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
    const lap = 2 + effNum(p, 'lap_bonus');
    p.coins += lap;
    body = `🎯 回到起点，拿 ${lap} 币。` + (effNum(p, 'lap_bonus') ? '（绕圈加成）' : '');
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
      const toll = 2 + effNum(owner, 'toll_plus');
      if (hasEffect(owner, 'toll_serve_only')) {
        body = `🏠 踩到 ${owner.name} 的地盘。${owner.identity.name} 只收"服侍"，不收币——\n（听 ${owner.name} 差遣一次，然后说 done）`;
        S.pending = { kind: 'tollServe', owner: p.id };
      } else {
        p.coins = Math.max(0, p.coins - toll);
        owner.coins += toll;
        body = `🏠 踩到 ${owner.name} 的地盘，交 ${toll} 币。`;
      }
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
    if (hasEffect(p, 'immunity', 'jail')) {
      body = `🔓 ${p.identity.name}：你潇洒走过监狱，还顺手朝里面挥了挥手。`;
    } else {
      p.jail = 1;
      body = '🔒 进监狱 1 轮。轮到你时被绑着，任对方处置。';
    }
  } else if (tile.type === 'truth') {
    const pool = TRUTHS.filter((t) => t['强度'] <= S.level);
    const t = pool.length ? rng.pick(pool) : TRUTHS[0];
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
    S.pending = { kind: 'truth', text: t['内容'], owner: p.id };
    body = `💬 【真心话·强度${t['强度']}】\n${t['内容']}`;
  } else {
    const luck = effOf(p, 'mystery_luck')?.value ?? 0.5;
    const good = rng.random() < luck;
    if (good) {
      p.coins += 3;
      body = '❓ 好运：捡到 3 币。';
    } else {
      p.coins = Math.max(0, p.coins - 2);
      body = '❓ 坏运：罚 2 币。';
    }
  }

  const head = `🎲 ${p.name} 掷出 ${d1}+${d2}=${steps}，走到第 ${p.pos} 格（${tile.name}）`;

  /* 两人撞在同一格 → 对决 */
  const opp = other(S);
  if (!S.pending && opp.pos === p.pos) {
    S.pending = {
      kind: 'duel',
      owner: p.id,
      text: `⚔️ 你们撞在第 ${p.pos} 格上了。对决：各掷一次，点数小的给大的 2 币（也可以把它当成一次对撩，输的人先破功）。`,
      duel: { a: p.id, b: opp.id, da: 1 + Math.floor(Math.random() * 6), db: 1 + Math.floor(Math.random() * 6) }
    };
    body += '\n⚔️ 同格对决！';
  }
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
    let gain = rewardOf(S.pending.intensity);
    const notes = [];

    /* 身份带来的额外收入 */
    if (S.pending.intensity >= 4) {
      const sb = effNum(p, 'strength_bonus');
      if (sb) {
        gain += sb;
        notes.push(`强度加成 +${sb}`);
      }
    }
    const typeB = effNum(p, 'type_bonus') || effNum(p, 'type_bonus', '自己');
    if (typeB) {
      gain += typeB;
      notes.push(`身份加成 +${typeB}`);
    }
    const tb = effNum(p, 'target_bonus', '对方');
    if (tb) {
      gain += tb;
      notes.push(`冲着对方去 +${tb}`);
    }
    const rb = effNum(p, 'reverse_bonus');
    if (rb) {
      gain += rb;
      notes.push(`反过来 Also +${rb}`);
    }
    const kb = effNum(p, 'kink_bonus');
    if (kb) {
      gain += kb;
      notes.push(`加成 +${kb}`);
    }

    p.coins += gain;
    p.done += 1;
    const tile = BOARD[p.pos];
    if (tile.type === 'task' && !p.owned.includes(p.pos)) p.owned.push(p.pos);

    /* 额外任务：做完还要再做一次 */
    const extra = effNum(p, 'extra_task');
    if (extra > 0 && (S.pending.extraLeft || 0) === 0) {
      S.pending.extraLeft = extra;
      S.pending = null;
      /* 重新抽一个任务挂上去 */
      const rng2 = new Rng(S.rngState, S.rngCalls);
      const t2 = drawTask(S, rng2);
      if (t2) {
        S.rngState = rng2.state;
        S.rngCalls = rng2.calls;
        S.pending = { kind: 'task', ...t2, owner: p.id, extraLeft: extra - 1 };
        return `✅ 完成，+${gain} 币${notes.length ? '（' + notes.join('、') + '）' : ''}。你的身份让你再做一次：\n【任务·强度${t2.intensity}·${t2.type}】\n${t2.text}\n\n（done / skip）`;
      }
    }

    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return `✅ 完成，+${gain} 币${notes.length ? '（' + notes.join('、') + '）' : ''}，这格归你了。\n${footer(S)}`;
  }

  if (S.pending.kind === 'tollServe') {
    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return '✅ 服侍过了，过路费免了。\n' + footer(S);
  }

  if (S.pending.kind === 'buyTerritory') {
    p.owned.push(S.pending.pos);
    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return `🏠 占下了第 ${p.pos} 格。对方踩到要交过路费。\n${footer(S)}`;
  }

  if (S.pending.kind === 'duel') {
    const d = S.pending.duel;
    const A = S.players[d.a];
    const B = S.players[d.b];
    let result;
    if (d.da === d.db) {
      result = `⚔️ 你们各掷出 ${d.da}，打平了。这一场算扯平。`;
    } else {
      const win = d.da > d.db ? A : B;
      const lose = d.da > d.db ? B : A;
      const take = Math.min(2, lose.coins);
      lose.coins -= take;
      win.coins += take;
      result = `⚔️ ${win.name} 掷出 ${Math.max(d.da, d.db)}，${lose.name} 掷出 ${Math.min(d.da, d.db)}——${win.name} 赢了，从 ${lose.name} 那拿走 ${take} 币。`;
    }
    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return result + '\n' + footer(S);
  }

  if (S.pending.kind === 'truth') {
    p.coins += 1;
    const witness = effNum(other(S), 'truth_witness');
    if (witness) other(S).coins += witness;
    S.pending = null;
    S.turnIdx = 1 - S.turnIdx;
    return `✅ 答了，+1 币。${witness ? `（${other(S).name} 作为见证人 +${witness}）` : ''}\n${footer(S)}`;
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
  /* 身份结算：把币转给对方 */
  for (const pl of S.players) {
    const t = effNum(pl, 'end_transfer');
    if (t) {
      const give = Math.min(t, pl.coins);
      pl.coins -= give;
      S.players[1 - pl.id].coins += give;
    }
  }

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
