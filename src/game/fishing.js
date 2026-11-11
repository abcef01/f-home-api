/**
 * 文字钓鱼（水面部分）
 * ------------------------------------------------------------
 * 移植自 tutusagi/ai-fishing-game 的引擎（Python，单文件零依赖）。
 * 数据表由原引擎导出成 JSON，这里只重写逻辑。
 *
 * 保持原设计的三个性质：
 *   · 确定性：mulberry32，同种子 + 同指令 → 同样结果
 *   · 存档与对话分离：状态存在数据库里，聊天清空也不丢
 *   · 省 token：支持连钓，只汇总一条
 *
 * 还没搬：潜水远征（dive）、藏宝图碎片、深水遗迹抉择。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(fs.readFileSync(path.join(here, 'fishing-data.json'), 'utf8'));

const { RARITY, SEASONS, LOCATIONS, FISH, BAITS, ITEMS, EVENTS, _JUNK, _BITE_SOFT, _BITE_HARD, _LUCK_EVENTS, _HELP } = DATA;
const LUCK_CHANCE = DATA.LUCK_CHANCE ?? 0.05;
const FEVER_CASTS = DATA._FEVER_CASTS ?? 3;
const FREE_BAIT_CASTS = DATA._FREE_BAIT_CASTS ?? 3;
const DEFAULT_SEED = DATA._DEFAULT_SEED ?? 0x9e3779b9;

/* ---------- mulberry32（与 Python 版同源） ---------- */
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
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0) ^ t;
    t = t >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  rint(a, b) {
    return a + Math.floor(this.random() * (b - a + 1));
  }
}

/* ---------- 状态 ---------- */
export function newState(seed = DEFAULT_SEED) {
  seed = seed >>> 0;
  return {
    version: 1,
    seed,
    rngState: seed,
    rngCalls: 0,
    turn: 0,
    season_id: 'spring',
    season_length: 20,
    season_started_turn: 0,
    points: 200,
    location_id: 'moonlit_pond',
    unlocked_locations: ['moonlit_pond', 'reed_river'],
    bait_inventory: { basic_worm: 5 },
    catch_inventory: [],
    items: {},
    pending_chests: [],
    seen_letters: {},
    encyclopedia: {},
    stats: { total_casts: 0, total_caught: 0, total_chests: 0 },
    fever: 0,
    free_bait: 0,
    oxygen: 0,
    oxygen_ever: false,
    dive_unlocked: [],
    map_fragments: {},
    expedition: null
  };
}

const FISH_LIST = Object.values(FISH);
const LOC_LIST = Object.values(LOCATIONS);

/* ---------- 基础工具 ---------- */
const eligible = (f, locId, seaId) =>
  (f.locations.includes('all') || f.locations.includes(locId)) &&
  (f.seasons.includes('all') || f.seasons.includes(seaId));

function effWeight(f, locId, seaId, baitId) {
  const loc = LOCATIONS[locId];
  const sea = SEASONS[seaId];
  const bait = BAITS[baitId] || { effects: {} };
  let w = RARITY[f.rarity].weight * (f.individual_weight ?? 1);
  for (const tag of f.tags || []) {
    w *= loc.tag_weight_mult?.[tag] ?? 1;
    w *= sea.tag_weight_mult?.[tag] ?? 1;
    w *= bait.effects?.tag_weight_mult?.[tag] ?? 1;
  }
  w *= bait.effects?.rarity_weight_mult?.[f.rarity] ?? 1;
  return w;
}

function wpick(rng, items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = rng.random() * total;
  let up = 0;
  for (let i = 0; i < items.length; i++) {
    up += weights[i];
    if (r <= up) return items[i];
  }
  return items[items.length - 1];
}

function pickByWeight(rng, arr) {
  const total = arr.reduce((a, x) => a + x.weight, 0);
  const r = rng.random() * total;
  let up = 0;
  for (const it of arr) {
    up += it.weight;
    if (r <= up) return it;
  }
  return arr[arr.length - 1];
}

function rollSize(rng, f) {
  const a = f.size_min;
  const b = f.size_max;
  let base = a + ((b - a) * (rng.random() + rng.random())) / 2;
  if (rng.random() < 0.03) base = b - (b - base) * rng.random() * 0.3;
  return Math.round(base * 10) / 10;
}

function valueOf(f, size) {
  const mid = (f.size_min + f.size_max) / 2;
  return Math.max(1, Math.round(f.base_value * Math.pow(size / mid, 1.5)));
}

function recordCatch(S, f, size, value) {
  const first = !S.encyclopedia[f.id];
  if (first) {
    S.encyclopedia[f.id] = { discovered: true, first_caught_turn: S.turn, count: 0, max_size: 0, total_value_earned: 0 };
  }
  const e = S.encyclopedia[f.id];
  e.count += 1;
  e.max_size = Math.max(e.max_size, size);
  e.total_value_earned += value;

  const inst = 'f_' + String(S.stats.total_caught + 1).padStart(3, '0');
  S.catch_inventory.push({ instance_id: inst, fish_id: f.id, size, value });
  S.stats.total_caught += 1;

  const bonus = first ? RARITY[f.rarity].discovery_bonus : 0;
  if (bonus) S.points += bonus;
  return { inst, first, bonus };
}

function advSeason(S) {
  if (S.turn - S.season_started_turn < S.season_length) return '';
  const ordered = Object.values(SEASONS).sort((a, b) => a.order - b.order);
  const cur = SEASONS[S.season_id].order;
  const next = ordered[(cur + 1) % ordered.length];
  const old = SEASONS[S.season_id].name;
  S.season_id = next.id;
  S.season_started_turn = S.turn;
  return `🍃 ${old}季结束，已进入${next.name}季——某些鱼群离开了这片水域，也有新的鱼群正等着被发现。\n`;
}


/* ---------- 潜水 ---------- */
const OXYGEN = DATA.OXYGEN;
const DIVE_ENCOUNTERS = DATA.DIVE_ENCOUNTERS || [];
const DIVE_EVENTS = DATA.DIVE_EVENTS || {};
const DIVE_JUNK = DATA._DIVE_JUNK || [];
const FRAG_CHANCE = DATA._FRAG_CHANCE ?? 0.15;

const diveUnlocked = (S, locId) => (S.dive_unlocked || []).includes(locId);
const diveAware = (S) => Boolean(S.oxygen_ever || (S.dive_unlocked || []).length || Object.keys(S.map_fragments || {}).length);

function fragsNeeded(loc) {
  const c = loc.unlock_cost;
  return c <= 200 ? 3 : c <= 480 ? 4 : 5;
}

function gainFragment(S, locId) {
  S.map_fragments = S.map_fragments || {};
  S.map_fragments[locId] = (S.map_fragments[locId] || 0) + 1;
  const need = fragsNeeded(LOCATIONS[locId]);
  const name = LOCATIONS[locId].name;
  if (S.map_fragments[locId] >= need) {
    S.map_fragments[locId] = 0;
    S.dive_unlocked = S.dive_unlocked || [];
    if (!S.dive_unlocked.includes(locId)) S.dive_unlocked.push(locId);
    return `\n🗺️ 集齐 ${need} 块碎片，拼成了【${name}】的藏宝图——这里能潜水了！（买氧气瓶后 dive 下水）`;
  }
  return `\n🧩 捞上来一块【${name}】的藏宝图碎片（${S.map_fragments[locId]}/${need}）`;
}

const footer = (S) =>
  `点数 ${S.points} ｜ ${LOCATIONS[S.location_id].name} · ${SEASONS[S.season_id].name} ｜ 回合 ${S.turn} ｜ 图鉴 ${Object.keys(S.encyclopedia).length}/${FISH_LIST.length}`;

const rar = (k) => `${RARITY[k].label} ${RARITY[k].tag}`;
const ambience = (loc, rng) => {
  const list = loc.ambience || [];
  if (!list.length) return '';
  return '\n' + list[rng.rint(0, list.length - 1)];
};

/* ---------- 事件 / 奖励 ---------- */
function grantRewards(S, rng, rw) {
  const parts = [];
  if (!rw) return parts;

  if (rw.points_range) {
    const p = rng.rint(rw.points_range[0], rw.points_range[1]);
    S.points += p;
    parts.push(`+${p}点`);
  }
  for (const b of rw.bait || []) {
    S.bait_inventory[b.id] = (S.bait_inventory[b.id] || 0) + b.qty;
    parts.push(`${BAITS[b.id]?.name || b.id}×${b.qty}`);
  }
  for (const it of rw.items || []) {
    S.items[it.id] = (S.items[it.id] || 0) + it.qty;
    parts.push(`${ITEMS[it.id]?.name || it.id}×${it.qty}`);
  }
  if (rw.item_pool) {
    const iid = pickByWeight(rng, rw.item_pool).id;
    S.items[iid] = (S.items[iid] || 0) + 1;
    parts.push(`${ITEMS[iid]?.name || iid}×1`);
  }
  if (rw.fish) {
    const gf = FISH[rw.fish];
    if (gf) {
      const gs = rollSize(rng, gf);
      const gv = valueOf(gf, gs);
      const r = recordCatch(S, gf, gs, gv);
      parts.push(`${gf.name}${r.first ? '★新发现' : ''} ${gs}${gf.size_unit}`);
    }
  }
  if (rw.chest) {
    S.stats.total_chests += 1;
    const uid = 'ch_' + String(S.stats.total_chests).padStart(3, '0');
    S.pending_chests.push({ chest_uid: uid, event_id: rw.chest });
    parts.push(`${EVENTS[rw.chest]?.name || '宝箱'}（待开，open ${uid}）`);
  }
  return parts;
}

const letterExhausted = (S, e) =>
  Boolean(e.unique) && (S.seen_letters[e.id] || []).length >= (e.messages || []).length;

function resolveEvent(S, rng) {
  const list = Object.values(EVENTS).filter((e) => e.type !== 'junk' && !letterExhausted(S, e));
  if (!list.length) return `水面晃了晃，又归于平静。\n${footer(S)}`;

  const ev = pickByWeight(rng, list);

  if (ev.type === 'chest') {
    S.stats.total_chests += 1;
    const uid = 'ch_' + String(S.stats.total_chests).padStart(3, '0');
    S.pending_chests.push({ chest_uid: uid, event_id: ev.id });
    return `📦 ${ev.name}！${ev.description}\n（用 open ${uid} 打开）\n${footer(S)}`;
  }

  if (ev.type === 'bottle' && ev.unique && ev.messages) {
    const seen = (S.seen_letters[ev.id] = S.seen_letters[ev.id] || []);
    const avail = ev.messages.map((_, i) => i).filter((i) => !seen.includes(i));
    const idx = avail[rng.rint(0, avail.length - 1)];
    seen.push(idx);
    const parts = grantRewards(S, rng, ev.rewards);
    return `📜 ${ev.name}！${ev.description}\n${ev.messages[idx]}\n★ 收到新的一封！（已收集 ${seen.length}/${ev.messages.length}）${
      parts.length ? '\n获得 ' + parts.join('、') : ''
    }\n${footer(S)}`;
  }

  let msg = '';
  if (ev.type === 'bottle' && ev.messages) msg = '\n' + ev.messages[rng.rint(0, ev.messages.length - 1)];
  const parts = grantRewards(S, rng, ev.rewards);
  const icon = ev.type === 'bottle' ? '📜' : '✨';
  return `${icon} ${ev.name}！${ev.description}${msg}${parts.length ? '\n获得 ' + parts.join('、') : ''}\n${footer(S)}`;
}

function openChest(S, uid) {
  const idx = S.pending_chests.findIndex((c) => c.chest_uid === uid);
  if (idx < 0) return `没有这个待开的宝箱：${uid}。`;
  const ev = EVENTS[S.pending_chests[idx].event_id];
  if (!ev) return '这个宝箱打不开了。';
  S.pending_chests.splice(idx, 1);
  const rng = new Rng(S.rngState, S.rngCalls);
  const parts = grantRewards(S, rng, ev.rewards);
  S.rngState = rng.state;
  S.rngCalls = rng.calls;
  return `🔓 打开宝箱：${ev.name}${parts.length ? '\n获得 ' + parts.join('、') : ''}\n${footer(S)}`;
}

/* ---------- 幸运事件 ---------- */
function rollLuck(S, rng, pool, baitId, f, size, inst) {
  if (rng.random() >= LUCK_CHANCE) return '';
  const eid = pickByWeight(rng, _LUCK_EVENTS).id;

  if (eid === 'split_hook') {
    const weights = pool.map((g) => effWeight(g, S.location_id, S.season_id, baitId));
    const got = [];
    for (let i = 0; i < 2; i++) {
      const g = wpick(rng, pool, weights);
      const gs = rollSize(rng, g);
      const gv = valueOf(g, gs);
      const r = recordCatch(S, g, gs, gv);
      got.push(`${g.name}${r.first ? '★新' : ''} ${gs}${g.size_unit}[${r.inst}]`);
    }
    return '🪝✨ 分裂鱼钩！鱼钩一分为三，又拽上来两条：' + got.join('、');
  }

  if (eid === 'golden_touch') {
    const c = S.catch_inventory.find((x) => x.instance_id === inst);
    if (!c) return '';
    const old = c.value;
    c.value = old * 3;
    return `✨💰 点石成金！这条价值 ×3：${old} → ${c.value} 点`;
  }

  if (eid === 'fever') {
    S.fever += FEVER_CASTS;
    return `🔥 渔获热潮！接下来钓到的 ${FEVER_CASTS} 条鱼都会翻倍。`;
  }

  if (eid === 'river_blessing') {
    if (baitId) S.bait_inventory[baitId] = (S.bait_inventory[baitId] || 0) + 1;
    S.free_bait += FREE_BAIT_CASTS;
    return `🌊🙏 河神的祝福！退还这一竿的饵，接下来 ${FREE_BAIT_CASTS} 竿不耗鱼饵。`;
  }

  if (eid === 'tide_record') {
    const c = S.catch_inventory.find((x) => x.instance_id === inst);
    if (!c) return '';
    const rs = f.size_max;
    const rv = valueOf(f, rs);
    const e = S.encyclopedia[f.id];
    if (e) {
      e.max_size = Math.max(e.max_size, rs);
      e.total_value_earned += Math.max(0, rv - c.value);
    }
    c.size = rs;
    c.value = rv;
    return `🌊📏 千载难逢的涨潮！这条猛涨到极限 ${rs}${f.size_unit}，价值 ${rv} 点。`;
  }

  if (eid === 'lucky_pearl') {
    const pool2 = DATA._PEARL_TREASURES;
    const tk = pool2[rng.rint(0, pool2.length - 1)];
    S.items[tk] = (S.items[tk] || 0) + 1;
    return `🦪✨ 蚌中生珠！鱼肚里滚出一枚${ITEMS[tk].name}（可 sell item ${tk}）。`;
  }
  return '';
}

function biteLine(rng, rarity) {
  const pool = ['rare', 'epic', 'legendary', 'mythic'].includes(rarity) ? _BITE_HARD : _BITE_SOFT;
  return pool[rng.rint(0, pool.length - 1)];
}

function formatCatch(f, size, value, first) {
  const u = f.size_unit;
  const r = f.rarity;
  const nm = first ? `（★首次收录 +${RARITY[r].discovery_bonus}点）` : '';
  const desc = f.description || '';
  if (r === 'legendary' || r === 'mythic') {
    const top = r === 'legendary' ? '👑 ─── 传 说 ─── 👑' : '✧ ────── ❖ 神 话 ❖ ────── ✧';
    return `${top}\n${f.name} · ${size}${u} · ${value}点${nm}\n${desc}${f.rumor ? '\n📜 ' + f.rumor : ''}`;
  }
  if (first) return `🆕 ${f.name}（${rar(r)}）${size}${u} · ${value}点${nm}\n${desc}`;
  if (r === 'rare' || r === 'epic') return `${f.name}（${rar(r)}）${size}${u} · ${value}点`;
  return `${f.name} ${size}${u} · ${value}点`;
}

function milestoneLine(f, first, S) {
  if (!first) return '';
  const got = Object.keys(S.encyclopedia).length;
  if (got === FISH_LIST.length) return `\n🎉 全图鉴达成！${FISH_LIST.length} 种鱼，一条不落。`;
  if (got % 10 === 0) return `\n🎉 图鉴 ${got}/${FISH_LIST.length}！`;
  return '';
}

/* ---------- 抛竿 ---------- */
function castStep(S, rng, baitId) {
  const inv = S.bait_inventory;
  if (!baitId) {
    const avail = Object.keys(inv).filter((b) => inv[b] > 0);
    if (!avail.length) return { text: '没有鱼饵了！去 shop 买点饵再来。（没扣回合）', consumed: false, kind: 'no_bait' };
    baitId = avail.sort((a, b) => BAITS[a].cost - BAITS[b].cost)[0];
  }
  if (!BAITS[baitId]) return { text: `没有这种鱼饵：${baitId}`, consumed: false, kind: 'bad_bait' };
  if ((inv[baitId] || 0) <= 0) {
    return { text: `${BAITS[baitId].name} 用光了。换一种或去 shop 买。（没扣回合）`, consumed: false, kind: 'no_bait' };
  }
  if (S.free_bait > 0) S.free_bait -= 1;
  else inv[baitId] -= 1;

  const bait = BAITS[baitId];
  S.turn += 1;
  S.stats.total_casts += 1;
  const seasonMsg = advSeason(S);
  const loc = LOCATIONS[S.location_id];

  const eventChance = loc.event_chance_base ?? 0.05;
  if (eventChance > 0 && rng.random() < eventChance) {
    return { text: seasonMsg + resolveEvent(S, rng), consumed: true, kind: 'event' };
  }

  if (rng.random() < loc.junk_chance_base) {
    return {
      text: seasonMsg + `🪣 ${_JUNK[rng.rint(0, _JUNK.length - 1)]}。空军一竿。${ambience(loc, rng)}`,
      consumed: true,
      kind: 'junk'
    };
  }

  const pool = FISH_LIST.filter((f) => eligible(f, S.location_id, S.season_id) && !f.dive);
  if (!pool.length) {
    return {
      text: seasonMsg + `浮标纹丝不动……这片水域这个季节什么都没咬钩。${ambience(loc, rng)}`,
      consumed: true,
      kind: 'empty'
    };
  }

  const weights = pool.map((f) => effWeight(f, S.location_id, S.season_id, baitId));
  const f = wpick(rng, pool, weights);
  const size = rollSize(rng, f);
  const value = valueOf(f, size);
  const { inst, first } = recordCatch(S, f, size, value);

  let feverLine = '';
  if (S.fever > 0) {
    S.fever -= 1;
    const r2 = recordCatch(S, f, size, value);
    feverLine = `\n🔥 热潮翻倍：又得一条 ${f.name}${r2.first ? '★新' : ''}（${r2.inst}）`;
  }

  biteLine(rng, f.rarity); // 保持随机流一致，不显示

  const luck = rollLuck(S, rng, pool, baitId, f, size, inst);

  let fragLine = '';
  if (!diveUnlocked(S, S.location_id) && rng.random() < FRAG_CHANCE) {
    fragLine = gainFragment(S, S.location_id);
  }
  const be = bait.effects || {};
  const pref =
    Object.keys(be.rarity_weight_mult || {}).includes(f.rarity) ||
    (f.tags || []).some((t) => Object.keys(be.tag_weight_mult || {}).includes(t));

  return {
    text:
      seasonMsg +
      formatCatch(f, size, value, first) +
      milestoneLine(f, first, S) +
      feverLine +
      (luck ? '\n' + luck : '') +
      fragLine +
      ambience(loc, rng),
    consumed: true,
    kind: 'fish',
    fish_name: f.name,
    rarity: f.rarity,
    first,
    pref
  };
}

const RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };

function castMany(S, baitId, times) {
  times = Math.max(1, Math.min(20, times));
  const rng = new Rng(S.rngState, S.rngCalls);

  if (times === 1) {
    const r = castStep(S, rng, baitId);
    S.rngState = rng.state;
    S.rngCalls = rng.calls;
    return r.text;
  }

  const highlights = [];
  const caught = {};
  let caughtN = 0;
  let junkN = 0;
  let emptyN = 0;
  let done = 0;
  const newNames = new Set();
  let prefHits = 0;
  let stopReason = null;

  for (let i = 0; i < times; i++) {
    const r = castStep(S, rng, baitId);
    if (!r.consumed) {
      highlights.push(r.text);
      stopReason = '没饵了';
      break;
    }
    done += 1;
    const rank = RANK[r.rarity] ?? 0;
    if (r.first || rank >= 2 || r.kind === 'event') highlights.push(r.text);

    if (r.kind === 'fish') {
      caught[r.fish_name] = (caught[r.fish_name] || 0) + 1;
      caughtN += 1;
      if (r.first) newNames.add(r.fish_name);
      if (r.pref) prefHits += 1;
    } else if (r.kind === 'junk') junkN += 1;
    else if (r.kind === 'empty') emptyN += 1;
  }

  S.rngState = rng.state;
  S.rngCalls = rng.calls;

  const body = highlights.length ? highlights.join('\n———\n') + '\n\n' : '';
  const haul = Object.entries(caught).map(([n, c]) => `${n}${newNames.has(n) ? '★' : ''}×${c}`).join('、') || '空军';
  const head = `🎣 连钓 ${done} 竿${stopReason ? '·' + stopReason : ''}`;
  let tail = `🐟 渔获 ${caughtN}：${haul}`;
  if (junkN || emptyN) tail += `（空 ${junkN + emptyN}）`;
  if (prefHits) tail += `｜🎣 ${BAITS[baitId]?.name || ''}偏好命中 ${prefHits} 条`;
  return `${head}\n${body}${tail}`;
}


/* ---------- 潜水远征 ---------- */
function diveStep(S, rng) {
  if ((S.oxygen || 0) <= 0) return { text: '氧气瓶用光了！去 shop 买（buy oxygen 5）。', consumed: false, kind: 'no_air' };
  S.oxygen -= 1;
  S.turn += 1;
  S.stats.total_dives = (S.stats.total_dives || 0) + 1;

  const seasonMsg = advSeason(S);
  const loc = LOCATIONS[S.location_id];

  if (rng.random() < loc.junk_chance_base) {
    return {
      text: seasonMsg + `🪨 ${DIVE_JUNK[rng.rint(0, DIVE_JUNK.length - 1)]}。空潜一次，什么也没摸到。${ambience(loc, rng)}`,
      consumed: true,
      kind: 'junk'
    };
  }

  const pool = FISH_LIST.filter((f) => f.dive && !f.branch_only && eligible(f, S.location_id, S.season_id));
  if (!pool.length) {
    return { text: seasonMsg + '潜下去，这片水域水下这个季节空荡荡的。' + ambience(loc, rng), consumed: true, kind: 'empty' };
  }

  const weights = pool.map((f) => effWeight(f, S.location_id, S.season_id, 'basic_worm'));
  const f = wpick(rng, pool, weights);
  const size = rollSize(rng, f);
  const value = valueOf(f, size);
  const { inst, first } = recordCatch(S, f, size, value);

  /* 水下奇遇 / 大遗迹 */
  let encounter = '';
  const encPool = DIVE_ENCOUNTERS.map((e) => ({ id: e.id, weight: e.weight || 5 }));
  if (encPool.length && rng.random() < 0.12) {
    const pick = pickByWeight(rng, encPool);
    const enc = DIVE_ENCOUNTERS.find((e) => e.id === pick.id);
    if (enc?.branch) {
      S.pendingDive = { encId: enc.id, name: enc.name, intro: enc.intro, options: enc.options };
      return {
        text: seasonMsg + formatCatch(f, size, value, first) + `\n\n${enc.emoji || '🌊'}【${enc.name}】${enc.intro}`,
        consumed: true,
        kind: 'fish',
        fish_name: f.name,
        rarity: f.rarity,
        first,
        branch: enc.id
      };
    }
    if (enc) {
      const parts = grantRewards(S, rng, enc.reward);
      encounter = `\n${enc.emoji || '🌊'}【${enc.name}】${enc.text}` + (parts.length ? '\n🎁 获得 ' + parts.join('、') : '');
    }
  }

  return {
    text: seasonMsg + formatCatch(f, size, value, first) + milestoneLine(f, first, S) + encounter + ambience(loc, rng),
    consumed: true,
    kind: 'fish',
    fish_name: f.name,
    rarity: f.rarity,
    first
  };
}

function diveStart(S, n) {
  if (S.pendingDive) return '你正停在一处遗迹面前——用 choose <编号> 选一个，或者 surface 上来。';
  const locId = S.location_id;
  if (!diveUnlocked(S, locId)) {
    const need = fragsNeeded(LOCATIONS[locId]);
    const have = S.map_fragments?.[locId] || 0;
    return `🔒【${LOCATIONS[locId].name}】的潜水点还没解锁——先在水面钓鱼集碎片（已 ${have}/${need}）。`;
  }
  if ((S.oxygen || 0) <= 0) return '没有氧气瓶了。shop 里 buy oxygen 5（买 5 瓶 8 折）。';

  n = Math.max(1, Math.min(10, n || 1));
  const rng = new Rng(S.rngState, S.rngCalls);
  const seg = [];
  let done = 0;
  let junk = 0;
  const caught = {};

  for (let i = 0; i < n; i++) {
    const r = diveStep(S, rng);
    if (!r.consumed) {
      seg.push(r.text);
      break;
    }
    done += 1;
    if (r.kind === 'fish') {
      caught[r.fish_name] = (caught[r.fish_name] || 0) + 1;
      if (r.first || (RANK[r.rarity] ?? 0) >= 2 || r.branch) seg.push(r.text);
    } else junk += 1;
    if (r.branch) break;
  }

  S.rngState = rng.state;
  S.rngCalls = rng.calls;

  const haul = Object.entries(caught).map(([k, v]) => `${k}×${v}`).join('、') || '空手';
  const head = `🤿 下潜 ${done} 次｜余氧 ${S.oxygen}`;
  const tail = `🐟 渔获：${haul}${junk ? `（空潜 ${junk}）` : ''}`;
  const body = seg.length ? seg.join('\n———\n') + '\n\n' : '';
  return `${head}\n${body}${tail}` + (S.pendingDive ? '\n\n（用 choose <编号> 处理眼前的遗迹，或 surface 上来）' : '');
}

function diveChoose(S, idx) {
  const p = S.pendingDive;
  if (!p) return '现在没有等着你选的遗迹。';
  const opt = p.options[Number(idx) - 1];
  if (!opt) return `选 1-${p.options.length}。`;
  const cost = opt.oxygen || 0;
  if (cost > (S.oxygen || 0)) return `氧气不够：这需要 ${cost} 瓶，你还有 ${S.oxygen} 瓶。`;
  S.oxygen -= cost;
  S.pendingDive = null;
  const rng = new Rng(S.rngState, S.rngCalls);
  const parts = grantRewards(S, rng, opt.outcome?.reward);
  S.rngState = rng.state;
  S.rngCalls = rng.calls;
  return (opt.outcome?.text || opt.label) + (parts.length ? '\n🎁 获得 ' + parts.join('、') : '') + `\n（余氧 ${S.oxygen}）`;
}

/* ---------- 指令 ---------- */
function cStatus(S) {
  const baits =
    Object.entries(S.bait_inventory)
      .filter(([, n]) => n > 0)
      .map(([b, n]) => `${BAITS[b].name}×${n}`)
      .join('、') || '（没饵了，去 shop 买）';

  let extra = '';
  const items = Object.entries(S.items).filter(([, n]) => n > 0);
  if (items.length) extra += '\n物品：' + items.map(([k, n]) => `${ITEMS[k]?.name || k}×${n}`).join('、');
  if (S.pending_chests.length) extra += `\n📦 待开宝箱 ${S.pending_chests.length} 个（inventory 看，open 开）`;
  const frags = Object.entries(S.map_fragments || {}).filter(([k, v]) => v > 0 && !diveUnlocked(S, k));
  if (frags.length) extra += '\n🧩 藏宝图碎片：' + frags.map(([k, v]) => `${LOCATIONS[k].name} ${v}/${fragsNeeded(LOCATIONS[k])}`).join('、');
  if ((S.dive_unlocked || []).length) extra += '\n🗺️ 能潜水的地方：' + S.dive_unlocked.map((l) => LOCATIONS[l].name).join('、');
  if (S.oxygen > 0 || S.oxygen_ever) extra += `\n氧气瓶：${S.oxygen || 0}（dive 下水）`;

  return `【状态】${footer(S)}\n鱼饵：${baits}\n未卖渔获：${S.catch_inventory.length} 条 ｜ 总抛竿 ${S.stats.total_casts}${extra}`;
}

function cShop(S) {
  const lines = Object.values(BAITS).map(
    (b) =>
      `${b.id}　${b.name}　${b.cost}点　${
        Object.keys(b.effects?.tag_weight_mult || {}).length || Object.keys(b.effects?.rarity_weight_mult || {}).length
          ? '（有偏好加成）'
          : '无特殊效果'
      }`
  );
  if ((S.dive_unlocked || []).length) {
    lines.push(`${OXYGEN.id}　${OXYGEN.name}　${OXYGEN.cost}点　潜水用（买 5 瓶 8 折、10 瓶 7 折）`);
  }
  return `【商店】（buy <id> [数量]）\n${lines.join('\n')}\n老板搓了搓手：「好饵能让这片水里本来就有的鱼更肯上钩——可它变不出新鱼种。想要水下的稀客？买氧气，dive 下去。」`;
}

function cBuy(S, baitId, qty) {
  if (baitId === 'oxygen' || baitId === 'oxygen_tank' || baitId === '氧气瓶') {
    if (!(S.dive_unlocked || []).length) return '现在还买不了氧气瓶——先在水面钓出藏宝图碎片，解锁第一个潜水点，店里才会上架。';
    const n = Math.max(1, parseInt(qty, 10) || 1);
    const disc = n >= 10 ? 0.7 : n >= 5 ? 0.8 : 1;
    const base = OXYGEN.cost * n;
    const cost = Math.round(base * disc);
    if (S.points < cost) return `点数不够：氧气瓶×${n} 需 ${cost} 点，你只有 ${S.points}。`;
    S.points -= cost;
    S.oxygen = (S.oxygen || 0) + n;
    S.oxygen_ever = true;
    return `买了氧气瓶×${n}，花 ${cost} 点${disc < 1 ? `（套餐省 ${base - cost} 点）` : ''}。剩 ${S.points} 点，现有氧气瓶×${S.oxygen}。`;
  }

  const b = BAITS[baitId];
  if (!b) return `没有这种鱼饵：${baitId}。用 shop 看货架。`;
  qty = Math.max(1, parseInt(qty, 10) || 1);
  const cost = b.cost * qty;
  if (S.points < cost) return `点数不够：${b.name}×${qty} 需 ${cost} 点，你只有 ${S.points}。`;
  S.points -= cost;
  S.bait_inventory[baitId] = (S.bait_inventory[baitId] || 0) + qty;
  return `买了 ${b.name}×${qty}，花 ${cost} 点。剩 ${S.points} 点，现有 ${b.name}×${S.bait_inventory[baitId]}。`;
}

function undiscoveredHere(S, locId, seaId) {
  let normal = 0;
  let legend = 0;
  for (const f of FISH_LIST) {
    if (f.dive || !eligible(f, locId, seaId) || S.encyclopedia[f.id]) continue;
    if (f.rarity === 'legendary' || f.rarity === 'mythic') {
      if (!f.locations.includes('all')) legend += 1;
    } else normal += 1;
  }
  return [normal, legend];
}

function cGoto(S, locId) {
  if (!locId) {
    const rank = (l) => (l.id === S.location_id ? 0 : S.unlocked_locations.includes(l.id) ? 1 : 2);
    const entries = [...LOC_LIST].sort((a, b) => rank(a) - rank(b) || a.unlock_cost - b.unlock_cost);
    const lines = entries.map((l) => {
      const cur = l.id === S.location_id;
      const unlocked = S.unlocked_locations.includes(l.id);
      const mark = cur ? '✦' : unlocked ? '·' : '🔒';
      const st = cur ? '【当前】' : unlocked ? '已解锁' : `${l.unlock_cost}点解锁`;
      const ok = l.available_seasons.includes(S.season_id);
      const [n, leg] = ok ? undiscoveredHere(S, l.id, S.season_id) : [0, 0];
      const sea = !ok ? '本季冷清' : n > 0 ? `本季待发现 ${n} 种${leg ? `（+${leg} 传说级）` : ''}` : '本季已集齐';
      return `  ${mark} ${l.name}　${l.id}　—— ${st} · ${sea}`;
    });
    return `【钓点】（goto <地点id> 前往；🔒 的需花点数解锁）\n${lines.join('\n')}\n（你有 ${S.points} 点）`;
  }

  const loc = LOCATIONS[locId];
  if (!loc) return `没有这个地点：${locId}。`;
  if (!S.unlocked_locations.includes(locId)) {
    if (S.points < loc.unlock_cost) return `${loc.name} 还没解锁，需 ${loc.unlock_cost} 点，你只有 ${S.points}。`;
    S.points -= loc.unlock_cost;
    S.unlocked_locations.push(locId);
  }
  S.location_id = locId;
  const ok = loc.available_seasons.includes(S.season_id);
  const [n, leg] = ok ? undiscoveredHere(S, locId, S.season_id) : [0, 0];
  const hint = !ok
    ? '（注意：本季节这里没什么鱼）'
    : n > 0
      ? `\n本季这里还有 ${n} 种没见过的鱼${leg ? `，外加 ${leg} 种传说级潜伏` : ''}。`
      : '本季这里的常规鱼你已集齐了。';
  return `来到【${loc.name}】。${loc.description}${loc.character ? '\n' + loc.character : ''}${hint}`;
}

function cInv(S) {
  const out = [];
  if (S.catch_inventory.length) {
    out.push(
      '🐟 渔获：\n' +
        S.catch_inventory
          .map((c) => `  ${c.instance_id}　${FISH[c.fish_id]?.name || c.fish_id}　${c.size}${FISH[c.fish_id]?.size_unit || 'cm'}　${c.value}点`)
          .join('\n')
    );
  }
  const items = Object.entries(S.items).filter(([, n]) => n > 0);
  if (items.length) {
    out.push('🎁 物品：\n' + items.map(([k, n]) => `  ${k}　${ITEMS[k]?.name || k}×${n}${ITEMS[k]?.sellable ? `（可 sell item ${k}）` : ''}`).join('\n'));
  }
  if (S.pending_chests.length) {
    out.push('📦 待开宝箱：\n' + S.pending_chests.map((c) => `  ${c.chest_uid}（open ${c.chest_uid}）`).join('\n'));
  }
  if (!out.length) return '渔篓空空。去 cast 抛几竿吧。';
  return `【渔篓】（sell <实例id>/sell all/sell species <鱼id>/sell item <物品id>）\n${out.join('\n')}`;
}

function cSell(S, target = '') {
  target = target.trim();
  const itemMatch = target.match(/^item[:\s]+(.+)$/);
  if (itemMatch) {
    const iid = itemMatch[1].trim();
    const it = ITEMS[iid];
    if (!it) return `没有这种物品：${iid}`;
    if (!it.sellable) return `${it.name} 不能卖。`;
    const have = S.items[iid] || 0;
    if (have <= 0) return `你没有 ${it.name}。`;
    const gain = it.value * have;
    S.points += gain;
    S.items[iid] = 0;
    return `卖了 ${it.name}×${have}，得 ${gain} 点。现有 ${S.points} 点。`;
  }

  const sp = target.match(/^species[:\s]+(.+)$/);
  let sold;
  if (target === 'all') {
    sold = S.catch_inventory;
    S.catch_inventory = [];
  } else if (sp) {
    const fid = sp[1].trim();
    sold = S.catch_inventory.filter((c) => c.fish_id === fid);
    S.catch_inventory = S.catch_inventory.filter((c) => c.fish_id !== fid);
  } else {
    const c = S.catch_inventory.find((x) => x.instance_id === target);
    if (!c) return `渔篓里没有这条：${target}`;
    sold = [c];
    S.catch_inventory = S.catch_inventory.filter((x) => x.instance_id !== target);
  }
  if (!sold.length) return `没有可卖的（${target}）。`;
  const gain = sold.reduce((a, c) => a + c.value, 0);
  S.points += gain;
  return `卖了 ${sold.length} 条，得 ${gain} 点。现有 ${S.points} 点。（图鉴记录保留）`;
}

function cEnc(S) {
  const by = {};
  for (const f of FISH_LIST) {
    by[f.rarity] = by[f.rarity] || [0, 0];
    by[f.rarity][1] += 1;
    if (S.encyclopedia[f.id]) by[f.rarity][0] += 1;
  }
  const rl = Object.keys(RARITY)
    .filter((k) => by[k])
    .map((k) => `${RARITY[k].label} ${by[k][0]}/${by[k][1]}`)
    .join('　');
  const lines = FISH_LIST.filter((f) => S.encyclopedia[f.id]).map(
    (f) => `✔ ${f.name}（${rar(f.rarity)}）×${S.encyclopedia[f.id].count} 最大${S.encyclopedia[f.id].max_size}cm`
  );
  return `【图鉴】${Object.keys(S.encyclopedia).length}/${FISH_LIST.length}（只列已发现）　${rl}\n${lines.join('\n') || '（还没收录任何鱼——去 cast 抛几竿）'}`;
}

function byIdOrName(table, q) {
  if (table[q]) return table[q];
  return Object.values(table).find((v) => v.name === q) || null;
}

function cLook(S, oid) {
  const f = byIdOrName(FISH, oid);
  if (f) {
    if (!S.encyclopedia[f.id]) return `？？？（${rar(f.rarity)}）—— 你还没见过它，得亲手钓上来才会在图鉴里显形。`;
    const locs = f.locations.includes('all') ? '任意水域' : f.locations.map((l) => LOCATIONS[l]?.name || l).join('、');
    const seas = f.seasons.includes('all') ? '全年' : f.seasons.map((x) => SEASONS[x]?.name || x).join('、');
    return `${f.name}（${rar(f.rarity)}）\n${f.description}${f.rumor ? '\n📜 传闻：' + f.rumor : ''}\n体型 ${f.size_min}-${f.size_max}${f.size_unit} ｜ 基础价值 ${f.base_value} ｜ 出没：${locs} · ${seas}`;
  }
  const l = byIdOrName(LOCATIONS, oid);
  if (l) return `${l.name}\n${l.description}\n开放季节：${l.available_seasons.map((x) => SEASONS[x].name).join('、')}　解锁 ${l.unlock_cost} 点`;
  const b = byIdOrName(BAITS, oid);
  if (b) return `${b.name}（${b.cost}点）\n${b.description || ''}`;
  const it = byIdOrName(ITEMS, oid);
  if (it) return `${it.name}${it.sellable ? `（财宝，售价 ${it.value} 点）` : '（功能物品，不可卖）'}\n${it.description || ''}`;
  return `没有这个对象：${oid}`;
}

/* ---------- 入口 ---------- */
export function cmd(S, line = '') {
  const raw = String(line || '').trim();
  const [verbRaw, ...rest] = raw.split(/\s+/);
  const verb = (verbRaw || '').toLowerCase();
  const arg = rest.join(' ');

  switch (verb) {
    case '':
    case 'help':
      return _HELP || '指令：status / shop / buy / goto / cast / inventory / sell / encyclopedia / look';
    case 'status':
      return cStatus(S);
    case 'shop':
      return cShop(S);
    case 'buy':
      return cBuy(S, rest[0], rest[1]);
    case 'goto':
      return cGoto(S, rest[0]);
    case 'inventory':
    case 'inv':
      return cInv(S);
    case 'sell':
      return cSell(S, arg);
    case 'enc':
    case 'encyclopedia':
      return cEnc(S);
    case 'look':
      return cLook(S, rest[0]);
    case 'cast': {
      const n = parseInt(rest[0], 10);
      const baitId = rest[1] || null;
      if (Number.isFinite(n) && n > 1) return castMany(S, baitId, n);
      return castMany(S, baitId || rest[0], 1);
    }
    case 'dive': {
      const n = parseInt(rest[0], 10);
      return diveStart(S, Number.isFinite(n) ? n : 1);
    }
    case 'choose':
      return diveChoose(S, rest[0]);
    case 'surface':
      if (!S.pendingDive) return '你现在不在水下。';
      S.pendingDive = null;
      return '你浮上来了。';
    case 'open':
      return openChest(S, rest[0]);
    default:
      return `不认识的指令：${verb}。可用：status/shop/buy/goto/cast/inventory/sell/encyclopedia/look/open`;
  }
}

export function footerOf(S) {
  return footer(S);
}
