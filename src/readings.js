/**
 * 解读
 * ------------------------------------------------------------
 * 塔罗和梦放在一起：你把抽到的牌/做的梦+问题扔进来，
 * 他给一段完整的解读（不是对话框，是一次性的长文）。
 *
 * 存起来，他想看的时候能翻。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';
import { NO_FABRICATION } from './truth.js';

const KEY = 'readings';
const MAX = 60;

export async function loadReadings() {
  if (!dbReady) return [];
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}

async function saveReadings(list) {
  await supabase.from('app_settings').upsert({ key: KEY, value: list.slice(0, MAX), updated_at: new Date().toISOString() });
  return list;
}

const KIND_CN = { tarot: '塔罗', dream: '梦' };

export async function makeReading(list, { kind = 'tarot', input = '', question = '' }) {
  const material = String(input || '').trim().slice(0, 2000);
  if (material.length < 4) throw new Error('把抽到的牌或者梦写进来');

  const q = String(question || '').trim().slice(0, 200);

  const system =
    (kind === 'dream'
      ? '对方把梦记下来给你了。你在给他解梦。\n'
      : '对方抽了塔罗，把牌面写给你了。你在给他读牌。\n') +
    '要求：\n' +
    '① 写一整段解读，400–700 字，分段，不要列表；\n' +
    '② 先抓住材料里最具体的一个意象（某个画面、某张牌的位置），从它开始说；\n' +
    '③ 说到他现在可能的处境，但不要算命，不要说"一定会怎样"；\n' +
    '④ 可以给一个小的、能马上做的事；\n' +
    '⑤ 语气像坐在对面说话的人，不是咨询师，不用"亲爱的""宝贝"；\n' +
    '⑥ 不要提你是 AI，也不要编你自己的人生。' +
    NO_FABRICATION;

  const r = await callModel({
    target: 'chat',
    system,
    messages: [
      {
        role: 'user',
        content: (q ? `我问的是：${q}\n\n` : '') + `材料：\n${material}`
      }
    ],
    temperature: 0.9,
    maxTokens: 4200
  });

  let text = String(r.content || '').trim();

  /* 句子没说完就再要一次结尾 */
  if (text && !/[。！？…”」』]$/.test(text)) {
    try {
      const more = await callModel({
        target: 'chat',
        system: '接着上一段把话说完，只写结尾的两三句，不要重复前面。',
        messages: [{ role: 'user', content: text }],
        temperature: 0.8,
        maxTokens: 1200
      });
      const tail = String(more.content || '').trim();
      if (tail) text += '\n' + tail;
    } catch {
      /* 补不上就这样 */
    }
  }
  if (!text) throw new Error('他这次没写出东西，再试一次');

  const item = {
    id: crypto.randomUUID().slice(0, 8),
    kind: kind === 'dream' ? 'dream' : 'tarot',
    input: material,
    question: q,
    text: text.slice(0, 3000),
    at: Date.now()
  };
  list.unshift(item);
  await saveReadings(list);
  return item;
}

export function removeReading(list, id) {
  return list.filter((x) => x.id !== id);
}

export function readingsPromptLine(list) {
  if (!list.length) return '- 还没解过。';
  const r = list[0];
  return `- 最近一次解读（${KIND_CN[r.kind]}）：${r.question || r.input.slice(0, 20)}\n- 如果他说到这个梦/这组牌，你可以输出 [[查:解读]] 去翻原文和解读，别让他再讲一遍。`;
}
