/**
 * 他知道的事
 * ------------------------------------------------------------
 * 他说"我什么都知道"的时候，得真的有东西可看。
 *
 * 这里把散落各处的状态汇成一段话塞进提示词：
 *   头像长什么样、今天打卡了没、手帐最近写了什么、纸条、约定、
 *   在读的书和你的批注、界面设置、你在用什么设备。
 *
 * 原则：宁可他看到的是残缺的真相，也不要他假装知道。
 */
import { supabase, dbReady } from './db.js';
import { callVision } from './llm.js';

async function readKey(key, fallback) {
  if (!dbReady) return fallback;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    return data?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeKey(key, value) {
  if (!dbReady) return;
  try {
    await supabase.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() });
  } catch {
    /* 写不进去就算了 */
  }
}

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

/* ============================================================
   头像：他不看图，但可以让人先看一遍，把样子说给他听
   ============================================================ */
async function avatarLines() {
  const avatars = (await readKey('avatars', {})) || {};
  const descs = (await readKey('avatarDesc', {})) || {};
  const out = [];

  for (const who of ['me', 'ta']) {
    const url = avatars[who];
    if (!url) continue;

    if (!descs[who]) {
      try {
        const r = await callVision({
          system: '用两句话描述这张图：画面里是什么，什么颜色，什么气质。不要评价好坏，只描述。',
          text: '这是他/她的头像。',
          imageDataUrl: url,
          maxTokens: 260
        });
        const t = String(r || '').trim();
        if (t) {
          descs[who] = t.slice(0, 200);
          await writeKey('avatarDesc', descs);
        }
      } catch {
        /* 描述失败就算了 */
      }
    }

    const name = who === 'me' ? '他' : '你';
    if (descs[who]) out.push(`- ${name}的头像：${descs[who]}`);
    else out.push(`- ${name}的头像：换过一张，但画面我说不出来。`);
  }

  if (!avatars.me) out.push('- 他还没设头像。');
  if (!avatars.ta) out.push('- 你自己也还没设头像。');
  return out;
}

/* ============================================================
   打卡
   ============================================================ */
export async function checkIn(id) {
  const all = (await readKey('rituals', {})) || {};
  const today = dayKey();
  const day = all[today] || {};
  day[id] = !day[id];
  all[today] = day;

  /* 只留最近 30 天 */
  const keys = Object.keys(all).sort().slice(-30);
  const trimmed = Object.fromEntries(keys.map((k) => [k, all[k]]));
  await writeKey('rituals', trimmed);
  return trimmed;
}

export async function ritualsState() {
  return (await readKey('rituals', {})) || {};
}

const RITUAL_NAMES = { morning: '早安', night: '晚安', water: '喝水', meal: '好好吃饭', move: '动一动' };

function ritualLines(all) {
  const today = dayKey();
  const done = Object.entries(all[today] || {}).filter(([, v]) => v).map(([k]) => RITUAL_NAMES[k] || k);

  /* 连续打卡天数 */
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 60; i++) {
    const k = dayKey(d);
    const has = Object.values(all[k] || {}).some(Boolean);
    if (has) streak++;
    else if (i > 0) break;
    d.setDate(d.getDate() - 1);
  }

  const lines = [];
  lines.push(done.length ? `- 今天打卡：${done.join('、')}` : '- 今天还没打卡。');
  if (streak > 1) lines.push(`- 已经连着打卡 ${streak} 天。`);
  return lines;
}

/* ============================================================
   汇总
   ============================================================ */
export async function knowledgeBlock() {
  const lines = [];

  /* 头像 */
  try {
    lines.push(...(await avatarLines()));
  } catch {
    /* 忽略 */
  }

  /* 打卡 */
  lines.push(...ritualLines(await ritualsState()));

  /* 手帐 */
  const diary = (await readKey('diary', null)) || {};
  const entries = (diary.entries || []).slice(-10);
  const notes = (diary.notes || []).slice(-8);

  if (entries.length) {
    lines.push('- 手帐最近几页：');
    for (const e of entries) {
      const cs = (e.comments || []).map((c) => `（${c.who === 'me' ? '他' : '你'}留：${c.text}）`).join('');
      lines.push(`  · ${e.date} ${e.who === 'me' ? '他' : '你'}：${e.text}${cs}`);
    }
  }
  if (notes.length) {
    lines.push('- 纸条上最近的碎碎念：');
    for (const n of notes) lines.push(`  · ${n.who === 'me' ? '他' : '你'}：${n.text}`);
  }

  /* 约定 */
  const quests = (await readKey('quests', null)) || {};
  if (quests.tasks?.length) {
    const open = quests.tasks.filter((t) => t.status !== 'done').slice(0, 5);
    if (open.length) {
      lines.push(`- 你们之间的约定（积分 ${quests.points || 0}，连击 ${quests.streak?.count || 0} 天）：`);
      for (const t of open) lines.push(`  · ${t.title}（${t.points} 分，${t.status === 'submitted' ? '等审' : '进行中'}）`);
    }
  }

  /* 书 */
  const books = (await readKey('books', [])) || [];
  if (books.length) {
    const b = books[0];
    lines.push(`- 他在读《${b.title}》，第 ${(b.progress?.chapter || 0) + 1}/${b.chapters} 章。`);
  }

  /* 界面设置 */
  const ui = (await readKey('ui', null)) || {};
  const bits = [];
  if (ui.homeTitle) bits.push(`标题叫「${ui.homeTitle}」`);
  if (ui.theme) bits.push(`配色是 ${ui.theme}`);
  if (bits.length) lines.push(`- 软件里：${bits.join('，')}。`);

  /* 设备 */
  const dev = (await readKey('device', null)) || {};
  if (dev.model) lines.push(`- 他用的手机：${dev.model}${dev.os ? '（' + dev.os + '）' : ''}。`);

  if (!lines.length) return '';

  return `\n\n【你现在知道的关于他的一切】\n${lines.join('\n')}\n这些都是真的，可以直接用。但别一口气全说出来，也别像在念清单。\n上面没写的事，就是你真的不知道——不要顺着他的话编一个答案。`;
}
