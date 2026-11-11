/**
 * 命运牌阵
 * ------------------------------------------------------------
 * 移植自 ceshihaox-dotcom/mingyun-paizhen 的抽卡思路（数据表原样使用）：
 * 时空坐标 × 母题 × 身份 × 变数 —— 四张牌拼出一个场景。
 *
 * 抽出来的是"设定"，不是故事。故事由他讲。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(fs.readFileSync(path.join(here, 'oracle-data.json'), 'utf8'));

class Rng {
  constructor(seed) {
    this.s = seed >>> 0;
  }
  next() {
    const a = (this.s + 0x6d2b79f5) >>> 0;
    this.s = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) + t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

const AXES = ['coords', 'motifs', 'identities', 'variables'];
const AXIS_CN = { coords: '时空', motifs: '母题', identities: '身份', variables: '变数' };

export function drawSpread({ seed = Date.now() >>> 0, nsfw = false, axes = AXES } = {}) {
  const rng = new Rng(seed);
  const cards = [];

  for (const axis of AXES) {
    if (!axes.includes(axis)) continue;
    const pool = DATA[axis].filter((x) => nsfw || !x.nsfw);
    if (!pool.length) continue;
    const pick = rng.pick(pool);
    cards.push({ axis, label: AXIS_CN[axis], ...pick });
  }

  return { seed, nsfw, cards, at: Date.now() };
}

/* 给聊天用：把四张牌铺成一段可读的设定 */
export function spreadPrompt(spread) {
  if (!spread?.cards?.length) return '';
  const c = spread.cards;
  const get = (a) => c.find((x) => x.axis === a);

  const time = get('coords');
  const motif = get('motifs');
  const who = get('identities');
  const v = get('variables');

  const lines = [];
  if (time) lines.push(`- 在哪：${time.n}（${time.r}，${time.p}）。${time.s || ''}`);
  if (motif) lines.push(`- 什么事：${motif.n}——${motif.d || ''}${motif.arc ? ' 走向：' + motif.arc : ''}`);
  if (who) lines.push(`- 你是：${who.n}。${who.d || ''}`);
  if (v) lines.push(`- 变数：${v.n}——${v.d || ''}${v.e ? ' 影响：' + v.e : ''}`);

  return `\n\n【这一局的牌（祂抽的，不是你编的）】\n${lines.join('\n')}\n\n带着这个设定讲一个场景。第一人称，正在发生，不要解释牌面，不要旁白式总结。一次两三段就停。`;
}

export function spreadText(spread) {
  if (!spread) return '还没抽。';
  return spread.cards
    .map((c) => `【${c.label}】${c.n}\n${c.d || c.s || ''}${c.p ? '（' + c.p + '）' : ''}`)
    .join('\n\n');
}

export function oracleInfo(spread) {
  return {
    seed: spread?.seed || null,
    nsfw: !!spread?.nsfw,
    cards: spread?.cards || [],
    text: spreadText(spread),
    counts: { coords: DATA.coords.length, motifs: DATA.motifs.length, identities: DATA.identities.length, variables: DATA.variables.length }
  };
}
