/**
 * 模型调用
 * ------------------------------------------------------------
 * 三个中转站/服务商都是 OpenAI 兼容格式，所以只需要一个适配器。
 *
 *   CHAT_*    主对话（默认 DeepSeek，走 x-llm）
 *   MEMORY_*  记忆压缩（便宜的 Flash；留空则复用 CHAT 的地址和 key）
 *   ALT_*     备用通道（hapi），留空就不用
 */

export const CHANNELS = ['chat', 'alt', 'hapi', 'hapi2', 'hapi3'];

/* 给界面看的名字 */
export const CHANNEL_LABELS = {
  chat: 'DeepSeek 官方',
  alt: 'x-llm 中转',
  hapi: 'hapi · Claude',
  hapi2: 'hapi · GPT',
  hapi3: 'hapi · 其他'
};

const cfg = (prefix) => ({
  base: (process.env[`${prefix}_BASE_URL`] || '').replace(/\/+$/, ''),
  key: process.env[`${prefix}_API_KEY`] || '',
  model: process.env[`${prefix}_MODEL`] || ''
});

export function providerConfig(name = 'chat') {
  if (name === 'memory') {
    /* 记忆压缩：单独配了就用单独的，否则复用主对话，只换模型 */
    const own = cfg('MEMORY');
    if (own.base && own.key) return own;
    const chat = cfg('CHAT');
    return { ...chat, model: own.model || chat.model };
  }
  return cfg(String(name).toUpperCase());
}

/* 给前端看的通道清单：哪些配好了、默认模型是什么 */
export function channelsInfo() {
  return CHANNELS.map((name) => {
    const c = cfg(name.toUpperCase());
    return {
      name,
      label: CHANNEL_LABELS[name] || name,
      configured: Boolean(c.base && c.key),
      base: c.base,
      model: c.model
    };
  });
}

export function chatModelName() {
  return providerConfig('chat').model;
}

function endpoint(base) {
  /* 允许填 https://x-llm.net 或 https://x-llm.net/v1 两种写法 */
  return /\/v\d+$/.test(base) ? base : base + '/v1';
}

export async function callModel({
  messages,
  system,
  target = 'chat',
  model: modelOverride = '',
  temperature = 0.8,
  maxTokens = 1200
}) {
  const conf = providerConfig(target);
  const { base, key } = conf;
  const model = modelOverride || conf.model;
  if (!base) throw new Error(`缺少 ${target.toUpperCase()}_BASE_URL`);
  if (!key) throw new Error(`缺少 ${target.toUpperCase()}_API_KEY`);
  if (!model) throw new Error(`缺少 ${target.toUpperCase()}_MODEL`);

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages
  };

  const res = await fetch(endpoint(base) + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`模型返回 ${res.status}：${text.slice(0, 300)}`);

  const json = JSON.parse(text);
  const choice = json.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    model: json.model || model,
    tokens: json.usage?.total_tokens ?? 0,
    meta: {
      finish: choice?.finish_reason || null,
      reasoning: choice?.message?.reasoning_content || null
    }
  };
}

/* 列出某个通道可用的模型（第七章做模型选择器时用） */
export async function listModels(target = 'chat') {
  const { base, key } = providerConfig(target);
  if (!base || !key) throw new Error('该通道未配置');
  const res = await fetch(endpoint(base) + '/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`列表返回 ${res.status}：${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  return (json.data || []).map((m) => m.id).sort();
}
