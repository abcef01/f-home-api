/**
 * 记忆压缩
 * ------------------------------------------------------------
 * 对话变长以后，把「较早的一批消息」交给便宜模型摘要成一段话，
 * 存进 memories。之后拼上下文只带：摘要 + 最近 N 条。
 * 摘要用的模型由 MEMORY_* 决定，没配就复用主对话的。
 */
import { callModel } from './llm.js';

/* 粗略估 token：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/* 什么时候压：消息超过 24 条，且总量超过 4000 token */
export const COMPRESS_AFTER_MESSAGES = 24;
export const COMPRESS_AFTER_TOKENS = 4000;
export const KEEP_RECENT = 10;

export async function summarize(messages) {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '我' : 'Elliott'}：${m.content}`)
    .join('\n');

  const result = await callModel({
    target: 'memory',
    temperature: 0.3,
    maxTokens: 400,
    system:
      '你在帮一个 AI 伙伴整理记忆。把下面的对话压缩成一段第三人称摘要，' +
      '保留：发生过什么事、说过的承诺、对方的偏好和情绪变化。' +
      '不要评价，不要加标题，控制在 200 字以内。',
    messages: [{ role: 'user', content: transcript }]
  });

  return {
    summary: (result.content || '').trim(),
    tokens: result.tokens || estimateTokens(result.content || '')
  };
}

export function shouldCompress(messages) {
  if (messages.length <= COMPRESS_AFTER_MESSAGES) return false;
  const total = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  return total > COMPRESS_AFTER_TOKENS;
}
