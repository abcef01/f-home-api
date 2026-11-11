/**
 * 约定（任务 / 积分 / 连击）
 * ------------------------------------------------------------
 * 思路来自 3lmglow/Phosphene（MIT）：AI 下任务、人交凭证、审核后记账。
 *
 * 这里的几条硬规矩：
 *   · 积分账本只追加，不修改 —— 记错了就用一条负数补，不留"改过的账"
 *   · 审核只是判断"这个凭证够不够"，不评价你这个人
 *   · 连击断了就断了，不羞辱、不补救
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const KEY = 'quests';

export function blank() {
  return {
    points: 0,
    streak: { count: 0, lastDay: null, best: 0 },
    tasks: [],
    ledger: [],
    rewards: [
      { id: 'r_song', name: '点一首歌', cost: 20 },
      { id: 'r_photo', name: '要一张照片', cost: 30 },
      { id: 'r_call', name: '打一通电话', cost: 40 },
      { id: 'r_wish', name: '许愿一次', cost: 60 }
    ],
    achievements: [],
    at: Date.now()
  };
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

export async function load() {
  if (!dbReady) return blank();
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const v = data?.value;
  if (!v) return blank();
  return { ...blank(), ...v };
}

export async function save(Q) {
  if (!dbReady) return;
  await supabase.from('app_settings').upsert({ key: KEY, value: Q, updated_at: new Date().toISOString() });
}

export function createTask(Q, { title, points = 5, daily = false, from = 'ta' }) {
  const t = {
    id: crypto.randomUUID().slice(0, 8),
    title: String(title || '').trim().slice(0, 60),
    points: Math.max(1, Math.min(50, Math.round(points))),
    daily: !!daily,
    from,
    status: 'open', // open | submitted | done | rejected
    createdAt: Date.now(),
    submittedAt: null,
    proof: null,
    comment: null
  };
  if (!t.title) throw new Error('任务得有内容');
  Q.tasks.push(t);
  return t;
}

export function submit(Q, id, { proof }) {
  const t = Q.tasks.find((x) => x.id === id);
  if (!t) throw new Error('没有这个任务');
  if (t.status === 'done') throw new Error('已经完成了');
  t.proof = String(proof || '').slice(0, 500);
  t.submittedAt = Date.now();
  t.status = 'submitted';
  return t;
}

/* 审核：只看凭证够不够 */
export async function review(Q, id) {
  const t = Q.tasks.find((x) => x.id === id);
  if (!t) throw new Error('没有这个任务');

  let approved = true;
  let comment = '';

  try {
    const r = await callModel({
      target: 'memory',
      system:
        '你在审核一条任务凭证。文字自述也算凭证——只要说得具体、听起来是真做了，就算做到过。只有明显糊弄（比如只写"做了""完成了"）才不通过。不评价人。只输出一行 JSON：{"ok": true/false, "comment": "一句话，20 字内"}',
      messages: [{ role: 'user', content: `任务：${t.title}\n凭证：${t.proof || '（没有写凭证）'}` }],
      temperature: 0.2,
      maxTokens: 600
    });
    const raw = (r.content || '').replace(/```json|```/g, '').trim();
    /* 模型不一定老老实实只输出 JSON，能捞出来就捞 */
    const m = raw.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j) {
      approved = j.ok !== false;
      comment = String(j.comment || '').slice(0, 60);
    } else {
      approved = true;
      comment = raw.slice(0, 40) || '看了。';
    }
  } catch {
    /* 模型挂了就按"看过了"算，不卡人 */
    approved = true;
    comment = '看了。';
  }

  t.status = approved ? 'done' : 'rejected';
  t.comment = comment;

  if (approved) {
    Q.points += t.points;
    Q.ledger.push({
      id: crypto.randomUUID().slice(0, 8),
      delta: t.points,
      reason: t.title,
      at: Date.now()
    });

    const d = today();
    if (Q.streak.lastDay === d) {
      /* 同一天多个任务不重复加连击 */
    } else {
      const y = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      Q.streak.count = Q.streak.lastDay === y ? Q.streak.count + 1 : 1;
      Q.streak.lastDay = d;
      Q.streak.best = Math.max(Q.streak.best || 0, Q.streak.count);
    }

    const done = Q.tasks.filter((x) => x.status === 'done').length;
    const badges = [
      [1, '第一个约定'],
      [5, '五个了'],
      [20, '二十个'],
      [50, '五十个']
    ];
    for (const [n, name] of badges) {
      if (done >= n && !Q.achievements.includes(name)) Q.achievements.push(name);
    }
    if (Q.streak.count >= 7 && !Q.achievements.includes('连着一周')) Q.achievements.push('连着一周');
  }

  return { task: t, approved, comment, points: Q.points };
}

/* 兑换 */
export function redeem(Q, rewardId) {
  const r = Q.rewards.find((x) => x.id === rewardId);
  if (!r) throw new Error('没有这个奖励');
  if (Q.points < r.cost) throw new Error(`还差 ${r.cost - Q.points} 分`);
  Q.points -= r.cost;
  Q.ledger.push({ id: crypto.randomUUID().slice(0, 8), delta: -r.cost, reason: '兑换：' + r.name, at: Date.now() });
  return { reward: r, points: Q.points };
}

export function summary(Q) {
  const open = Q.tasks.filter((t) => t.status === 'open' || t.status === 'submitted');
  return {
    points: Q.points,
    streak: Q.streak,
    achievements: Q.achievements,
    open,
    done: Q.tasks.filter((t) => t.status === 'done').slice(-10),
    rewards: Q.rewards,
    ledger: Q.ledger.slice(-20),
    text: [
      `📒 积分 ${Q.points}　连击 ${Q.streak.count} 天（最长 ${Q.streak.best || 0}）`,
      open.length ? `未完成 ${open.length} 件：` + open.map((t) => `「${t.title}」${t.points}分`).join('　') : '手上没有约定。'
    ].join('\n')
  };
}

/* 提示词：让他知道现在有什么约定 */
export async function questsPromptBlock() {
  const Q = await load();
  const open = Q.tasks.filter((t) => t.status === 'open' || t.status === 'submitted');
  if (!open.length) return '';
  return `\n\n【你们之间的约定】\n${open
    .map((t) => `- ${t.title}（${t.points} 分）${t.status === 'submitted' ? '｜他已交了凭证，等你审' : ''}`)
    .join('\n')}\n可以顺口问一句进展，但别每次催。`;
}
