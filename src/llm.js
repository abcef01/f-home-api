/**
 * 模型调用
 * ------------------------------------------------------------
 * 三个中转站/服务商都是 OpenAI 兼容格式，所以只需要一个适配器。
 *
 *   CHAT_*    主对话（默认 DeepSeek，走 x-llm）
 *   MEMORY_*  记忆压缩（便宜的 Flash；留空则复用 CHAT 的地址和 key）
 *   ALT_*     备用通道（hapi），留空就不用
 */

const cfg = (prefix) => ({
  base: (process.env[`${prefix}_BASE_URL`] || '').replace(/\/+$/, ''),
  key: process.env[`${prefix}_API_KEY`] || '',
  model: process.env[`${prefix}_MODEL`] || ''
});

export function providerConfig(name = 'chat') {
  const own = cfg(name.toUpperCase());
  if (own.base && own.key) return own;
  /* 没单独配就回落到主对话 */
  return cfg('CHAT');
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
