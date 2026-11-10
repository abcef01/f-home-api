/**
 * 通话
 * ------------------------------------------------------------
 * 不是真的打电话（那要走运营商，一分钟几毛），
 * 而是把「打电话」这件事做出来：响铃、接通、说话、挂断、留摘要。
 *
 * 三个关键点：
 *   · 它会自己说「我先挂了」——柔性挂断，不是硬切
 *   · 通话记录会变成摘要，进记忆
 *   · 电话里说话短，不像打字那样能斟酌
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const KEY = 'call';

export const CALL_PROMPT = `

## 现在在打电话

你们在通电话，不是打字。
- 说话短，一句到两句，别写小作文；
- 会有停顿、会有"嗯""那个"这种语气词，那是正常的；
- 对方看不到你的表情，所以语气要更明确一点；
- 不要用括号写动作，电话里看不到。

如果这通电话该结束了（对方说要忙了、已经聊完、或者你想让他去睡），
**先好好说再见**，再挂。

告别要具体，不要干巴巴一句"拜拜"：
- 说清楚让他去做什么（"快去睡""路上小心""吃饭去"）；
- 可以说一句你自己的状态（"我也去躺着""我等你明天说"）；
- 语气跟你们刚才聊到的东西接上，别像客服。

告别说完，另起一行只写 [[挂断]]。系统会挂掉这通电话，你刚说的话照常说完。

反例（不要这样）：「那你去睡吧。[[挂断]]」——太干，像机器人。
好一点：「行，那你钻被窝吧，别刷手机了。我这边也安静下来了。晚安。[[挂断]]」`;

async function read() {
  if (!dbReady) return null;
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return data?.value || null;
}

async function write(v) {
  await supabase.from('app_settings').upsert({ key: KEY, value: v, updated_at: new Date().toISOString() });
}

export async function startCall({ reason = '想听听你的声音' } = {}) {
  const call = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    endedAt: null,
    reason,
    turns: []
  };
  await write(call);
  return call;
}

export async function currentCall() {
  const c = await read();
  if (!c || c.endedAt) return null;
  /* 超过一小时没动静就算掉了 */
  const last = c.turns.length ? c.turns[c.turns.length - 1].at : c.startedAt;
  if (Date.now() - last > 60 * 60 * 1000) return null;
  return c;
}

/**
 * 说一句，回一句
 * @returns {{reply: string, hangUp: boolean}}
 */
export async function callTurn({ text, systemBase, farewell = false }) {
  const c = await read();
  if (!c) throw new Error('没有正在进行的通话');

  const messages = [
    ...c.turns.slice(-12).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: text }
  ];

  const farewellRule = farewell
    ? `\n\n【现在对方要挂电话了】说最后一句告别，然后另起一行写 [[挂断]]。
告别要具体：让他去做什么（睡、吃饭、路上小心），可以说一句你自己的状态，语气跟刚才接上。
不要只说"行""嗯""你睡吧"。`
    : '';

  const r = await callModel({
    system: systemBase + CALL_PROMPT + farewellRule,
    messages,
    temperature: 0.9,
    maxTokens: 900
  });

  let reply = (r.content || '').trim();
  const hangUp = /\[\[挂断\]\]/.test(reply);
  reply = reply.replace(/\[\[挂断\]\]/g, '').trim();

  c.turns.push({ role: 'user', content: text, at: Date.now() });
  if (reply) c.turns.push({ role: 'assistant', content: reply, at: Date.now() });
  await write(c);

  return { reply, hangUp };
}

/* 挂断：生成摘要，写进消息和记忆 */
export async function endCall() {
  const c = await read();
  if (!c) return { skipped: 'no-call' };

  const transcript = c.turns.filter((t) => t.content).map((t) => `${t.role === 'user' ? '对方' : '你'}：${t.content}`).join('\n');
  const minutes = Math.max(1, Math.round((Date.now() - c.startedAt) / 60000));

  let summary = '';
  if (transcript.length > 20) {
    try {
      const r = await callModel({
        target: 'memory',
        system: '把下面这通电话整理成两三句摘要：聊了什么、对方状态如何、有没有要记住的事。不要评价，不要重复原话。',
        messages: [{ role: 'user', content: transcript }],
        temperature: 0.3,
        maxTokens: 800
      });
      summary = (r.content || '').trim().slice(0, 300);
    } catch (e) {
      console.warn('[call] 摘要失败', e.message.slice(0, 60));
    }
  }

  const ended = { ...c, endedAt: Date.now(), summary, minutes };
  await write(ended);

  /* 通话记录作为一条消息留在聊天里 */
  if (c.turns.length) {
    const { data: convs } = await supabase
      .from('conversations')
      .select('id')
      .order('updated_at', { ascending: false })
      .limit(1);
    const convId = convs?.[0]?.id;
    if (convId) {
      await supabase.from('messages').insert({
        conversation_id: convId,
        role: 'assistant',
        content: summary || `刚通了个电话，${minutes} 分钟。`,
        meta: {
          call: {
            minutes,
            turns: c.turns.length,
            startedAt: c.startedAt
          }
        }
      });
      await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
    }
  }

  return { summary, minutes, turns: c.turns.length };
}

/* 提示词里用：正在通话 */
export async function callPromptBlock() {
  const c = await currentCall();
  if (!c) return '';
  const mins = Math.round((Date.now() - c.startedAt) / 60000);
  return `\n\n【正在通话中】已经通了 ${mins} 分钟。`;
}
