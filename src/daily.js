/**
 * 每日一句 + 按时间的问候
 * ------------------------------------------------------------
 * 一天只生成一次，存下来复用。
 * 问候按时间段变（清晨 / 上午 / 下午 / 傍晚 / 深夜），
 * 但同一段里不重复生成，省钱。
 */
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const KEY = 'daily';
const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

function slot(hour) {
  if (hour < 5) return 'deepnight';
  if (hour < 9) return 'morning';
  if (hour < 12) return 'forenoon';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'evening';
  if (hour < 23) return 'night';
  return 'latenight';
}

function slotCn(s) {
  return { deepnight: '凌晨', morning: '清晨', forenoon: '上午', afternoon: '下午', evening: '傍晚', night: '晚上', latenight: '深夜' }[s] || '现在';
}

async function read() {
  if (!dbReady) return null;
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return data?.value || null;
}

async function write(v) {
  await supabase.from('app_settings').upsert({ key: KEY, value: v, updated_at: new Date().toISOString() });
}

export async function getDaily(me = '你') {
  const today = dayKey();
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).format(new Date())
  ) % 24;
  const s = slot(hour);

  const cur = await read();
  const out = { ...(cur || {}) };

  /* 每日一句：一天一次 */
  if (cur?.date !== today || !cur?.quote) {
    try {
      const r = await callModel({
        target: 'memory',
        system:
          '写一句给对方的"每日一句"。要求：一句话，十五到三十字；像随口说的一句，不要励志、不要鸡汤、不要排比；' +
          '可以是很小的事（天气、光、声音、正在做的事）。只输出这句话。',
        messages: [{ role: 'user', content: `今天是 ${today}。` }],
        temperature: 1.0,
        maxTokens: 400
      });
      const q = String(r.content || '').trim().replace(/^["'「]|["'」]$/g, '').slice(0, 60);
      if (q) {
        out.quote = q;
        out.date = today;
        out.quoteAt = Date.now();
      }
    } catch {
      /* 生成失败就沿用旧的 */
    }
  }

  /* 问候：同一时段只生成一次 */
  if (out.greetSlot !== s || !out.greeting) {
    try {
      const r = await callModel({
        target: 'memory',
        system:
          '写一句问候，用在软件首页。要求：一到两句，口语，像同居的人看到你回来随口说的；' +
          '要跟时间段贴合（现在是' + slotCn(s) + '）；不要"早上好呀～"这种客服腔，不要表情符号。只输出这句话。',
        messages: [{ role: 'user', content: `现在是${slotCn(s)}，他打开软件了。` }],
        temperature: 1.0,
        maxTokens: 400
      });
      const g = String(r.content || '').trim().slice(0, 80);
      if (g) {
        out.greeting = g;
        out.greetSlot = s;
        out.greetAt = Date.now();
      }
    } catch {
      /* 失败就沿用旧的 */
    }
  }

  if (out.date !== today && out.quote) {
    /* 跨天但生成失败：旧句子可以继续顶一天 */
    out.date = today;
  }

  if (JSON.stringify(out) !== JSON.stringify(cur)) await write(out);

  return {
    date: today,
    quote: out.quote || '别急，我们还有很多个这样的晚上。',
    greeting: out.greeting || `${slotCn(s)}好，${me}。`,
    slot: s,
    slotCn: slotCn(s)
  };
}
