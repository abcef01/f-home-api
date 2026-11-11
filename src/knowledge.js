/**
 * 他知道的事（按需版）
 * ------------------------------------------------------------
 * 以前是把所有东西塞进每次请求——贵，而且大部分时候用不上。
 *
 * 现在：
 *   · 常驻的只有一小段"索引"（几行字，告诉他有什么可看）
 *   · 他真想知道，就单独发一行 [[查:手帐]] / [[查:睡眠]]
 *   · 后端去取，追加一轮，再让他说
 *
 * 只有他主动翻的时候才花那份钱。
 */
import { supabase, dbReady } from './db.js';
import { callVision } from './llm.js';

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

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
    /* 忽略 */
  }
}

/* ============================================================
   打卡
   ============================================================ */
const RITUAL_NAMES = { morning: '早安', night: '晚安', water: '喝水', meal: '好好吃饭', move: '动一动' };

export async function ritualsState() {
  return (await readKey('rituals', {})) || {};
}

function ritualAt(v) {
  if (!v || v === true) return null;
  return v.at || null;
}
const isOn = (v) => !!(v === true || v?.done);

export async function checkIn(id) {
  const all = await ritualsState();
  const today = dayKey();
  const day = all[today] || {};
  const cur = day[id];

  if (isOn(cur)) delete day[id];
  else day[id] = { done: true, at: Date.now() };

  all[today] = day;
  const keys = Object.keys(all).sort().slice(-60);
  const trimmed = Object.fromEntries(keys.map((k) => [k, all[k]]));
  await writeKey('rituals', trimmed);
  return trimmed;
}

/* ============================================================
   睡眠
   ============================================================ */
export async function sleepList() {
  return (await readKey('sleep', [])) || [];
}

export async function upsertSleep(entry) {
  const list = await sleepList();
  const date = String(entry.date || dayKey()).slice(0, 10);
  const idx = list.findIndex((x) => x.date === date);
  const item = {
    date,
    bedAt: entry.bedAt || null,
    wakeAt: entry.wakeAt || null,
    hours: entry.hours === null || entry.hours === undefined ? null : Number(entry.hours),
    wakings: Number(entry.wakings) || 0,
    note: String(entry.note || '').slice(0, 120),
    at: Date.now()
  };
  if (idx >= 0) list[idx] = item;
  else list.push(item);
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  await writeKey('sleep', list.slice(-90));
  return list;
}

/* 从打卡推：昨晚晚安 → 今天早安 */
export function sleepFromRituals(all, date = dayKey()) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  const prev = dayKey(d);

  const nightAt = ritualAt(all[prev]?.night) || null;
  const morningAt = ritualAt(all[date]?.morning) || null;
  if (!nightAt || !morningAt) return null;

  const hours = Math.round(((morningAt - nightAt) / 3600000) * 10) / 10;
  if (hours <= 0 || hours > 20) return null;
  return { bedAt: nightAt, wakeAt: morningAt, hours };
}

/* ============================================================
   常驻索引（很短）
   ============================================================ */
export async function knowledgeBlock() {
  const avatars = (await readKey('avatars', {})) || {};
  const all = await ritualsState();
  const today = all[dayKey()] || {};
  const done = Object.entries(today).filter(([, v]) => isOn(v)).map(([k]) => RITUAL_NAMES[k] || k);

  const lines = [];
  lines.push(`- 头像：${avatars.me ? '他设了' : '他没设'} / ${avatars.ta ? '你设了' : '你没设'}`);
  lines.push(done.length ? `- 今天的打卡：${done.join('、')}` : '- 今天他还没打卡');

  return `\n\n【他现在能看的】\n${lines.join('\n')}
想细看就单独输出一行 [[查:手帐]]（或 纸条 / 打卡 / 睡眠 / 约定 / 书 / 头像 / 照片 / 界面）。
查了你会拿到详细内容；不查就别装作知道。上面的索引里没有的事，就是你真的不知道。`;
}

/* ============================================================
   按主题取详情
   ============================================================ */
export async function fetchTopic(topic) {
  const t = String(topic || '').trim();

  if (t === '手帐' || t === 'diary') {
    const d = (await readKey('diary', null)) || {};
    const entries = (d.entries || []).slice(-12);
    if (!entries.length) return '手帐还是空的。';
    return (
      '【手帐最近 12 条】\n' +
      entries
        .map((e) => {
          const cs = (e.comments || []).map((c) => `（${c.who === 'me' ? '他' : '你'}留：${c.text}）`).join('');
          return `${e.date} ${e.who === 'me' ? '他' : '你'}：${e.text}${cs}`;
        })
        .join('\n')
    );
  }

  if (t === '纸条' || t === 'notes') {
    const d = (await readKey('diary', null)) || {};
    const notes = (d.notes || []).slice(-15);
    if (!notes.length) return '纸条墙还是空的。';
    return '【最近的纸条】\n' + notes.map((n) => `${n.who === 'me' ? '他' : '你'}：${n.text}`).join('\n');
  }

  if (t === '打卡' || t === 'checkin' || t === 'rituals') {
    const all = await ritualsState();
    const days = Object.keys(all).sort().slice(-7).reverse();
    if (!days.length) return '还没有任何打卡记录。';
    return (
      '【最近 7 天打卡】\n' +
      days
        .map((day) => {
          const items = Object.entries(all[day] || {})
            .filter(([, v]) => isOn(v))
            .map(([k, v]) => {
              const at = ritualAt(v);
              const hhmm = at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
              return `${RITUAL_NAMES[k] || k}${hhmm ? ' ' + hhmm : ''}`;
            });
          return `${day}：${items.length ? items.join('、') : '没打卡'}`;
        })
        .join('\n')
    );
  }

  if (t === '睡眠' || t === 'sleep') {
    const list = (await sleepList()).slice(-7).reverse();
    const all = await ritualsState();
    const guess = sleepFromRituals(all);
    if (!list.length && !guess) return '还没有睡眠记录。';
    const lines = list.map((s) => `${s.date}：睡了 ${s.hours ?? '?'} 小时，醒 ${s.wakings} 次${s.note ? '，' + s.note : ''}`);
    if (guess) lines.unshift(`（打卡推出来昨晚：${guess.hours} 小时，还没确认）`);
    return '【最近睡眠】\n' + lines.join('\n');
  }

  if (t === '约定' || t === 'quests') {
    const q = (await readKey('quests', null)) || {};
    const tasks = (q.tasks || []).filter((x) => x.status !== 'done').slice(0, 10);
    if (!tasks.length) return '现在没有未完成的约定。';
    return (
      `【约定】积分 ${q.points || 0}，连击 ${q.streak?.count || 0} 天\n` +
      tasks.map((x) => `- ${x.title}（${x.points} 分，${x.status === 'submitted' ? '等他审' : '进行中'}）`).join('\n')
    );
  }

  if (t === '书' || t === 'books') {
    const books = (await readKey('books', [])) || [];
    if (!books.length) return '书架是空的。';
    return '【书架】\n' + books.map((b) => `《${b.title}》第 ${(b.progress?.chapter || 0) + 1}/${b.chapters} 章`).join('\n');
  }

  if (t === '头像' || t === 'avatar') {
    const avatars = (await readKey('avatars', {})) || {};
    const descs = (await readKey('avatarDesc', {})) || {};
    if (!avatars.me && !avatars.ta) return '两个人现在都没设头像。';

    const out = [];
    for (const who of ['me', 'ta']) {
      if (!avatars[who]) continue;
      if (!descs[who]) {
        try {
          const r = await callVision({
            system: '用两句话描述这张图：画面、颜色、气质。只描述，不评价。',
            text: '这是头像。',
            imageDataUrl: avatars[who],
            maxTokens: 260
          });
          const x = String(r || '').trim();
          if (x) descs[who] = x.slice(0, 200);
        } catch {
          /* 忽略 */
        }
        await writeKey('avatarDesc', descs);
      }
      out.push(`${who === 'me' ? '他' : '你'}的头像：${descs[who] || '画面说不出来'}`);
    }
    return '【头像】\n' + out.join('\n');
  }

  if (t === '界面' || t === 'ui') {
    const ui = (await readKey('ui', null)) || {};
    const dev = (await readKey('device', null)) || {};
    return `【界面与设备】\n标题：${ui.homeTitle || '未设'}\n配色：${ui.theme || '默认'}\n设备：${dev.model || '未知'}`;
  }

  if (t === '照片' || t === 'photos') {
    return '【照片】图片在聊天记录里，但我没把画面记成文字。想让我记得，就告诉我图里是什么。';
  }

  if (t === '全部' || t === 'all') {
    const parts = [];
    for (const x of ['手帐', '打卡', '睡眠', '约定', '书']) parts.push(await fetchTopic(x));
    return parts.join('\n\n');
  }

  return `没有「${t}」这一类。可查：手帐、纸条、打卡、睡眠、约定、书、头像、照片、界面。`;
}
