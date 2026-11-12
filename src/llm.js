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

/* 有些模型不接受 temperature（比如 claude-sonnet-5），传了直接 400 */
function acceptsTemperature(model) {
  return !/claude|sonnet|opus|haiku/i.test(String(model || ''));
}

export async function callModel({
  messages,
  system,
  target = 'chat',
  model: modelOverride = '',
  temperature = 0.8,
  maxTokens = 2000
}) {
  const conf = providerConfig(target);
  const { base, key } = conf;
  const model = modelOverride || conf.model;
  if (!base) throw new Error(`缺少 ${target.toUpperCase()}_BASE_URL`);
  if (!key) throw new Error(`缺少 ${target.toUpperCase()}_API_KEY`);
  if (!model) throw new Error(`缺少 ${target.toUpperCase()}_MODEL`);

  const body = {
    model,
    ...(acceptsTemperature(model) ? { temperature } : {}),
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

  /* 空回复自动重试：推理模型有时把 token 全用在思考上，正文是空的。
     这种情况把额度翻倍再要一次，别让它变成"嗯。"。 */
  if (!String(choice?.message?.content || '').trim()) {
    try {
      const retryBody = {
        ...body,
        max_tokens: Math.min(8000, Math.max(2000, (body.max_tokens || 1200) * 3))
      };
      const r2 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(retryBody)
      });
      const t2 = await r2.text();
      if (r2.ok) {
        const j2 = JSON.parse(t2);
        const c2 = j2.choices?.[0];
        if (String(c2?.message?.content || '').trim()) {
          return {
            content: c2.message.content,
            model: j2.model || model,
            tokens: j2.usage?.total_tokens ?? 0,
            meta: { finish: c2.finish_reason || null, reasoning: c2.message?.reasoning_content || null, retried: true, usage: j2.usage || null }
          };
        }
      }
    } catch {
      /* 重试失败就返回原来那份 */
    }
  }

  return {
    content: choice?.message?.content ?? '',
    model: json.model || model,
    tokens: json.usage?.total_tokens ?? 0,
    meta: {
      finish: choice?.finish_reason || null,
      reasoning: choice?.message?.reasoning_content || null,
      usage: json.usage || null
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

/* ============================================================
   流式输出：逐块吐出 token
   ------------------------------------------------------------
   用法：
     for await (const ev of streamChat({ system, messages })) {
       if (ev.type === 'delta') ...   // 一小段文字
       if (ev.type === 'usage') ...   // 最后的 token 统计
     }
   ============================================================ */
export async function* streamChat({
  messages,
  system,
  target = 'chat',
  model: modelOverride = '',
  temperature = 0.8,
  maxTokens = 2000
}) {
  const conf = providerConfig(target);
  const { base, key } = conf;
  const model = modelOverride || conf.model;
  if (!base) throw new Error(`缺少 ${target.toUpperCase()}_BASE_URL`);
  if (!key) throw new Error(`缺少 ${target.toUpperCase()}_API_KEY`);
  if (!model) throw new Error(`缺少 ${target.toUpperCase()}_MODEL`);

  const res = await fetch(endpoint(base) + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
    ...(acceptsTemperature(model) ? { temperature } : {}),
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`模型返回 ${res.status}：${t.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        yield { type: 'reasoning', text: delta.reasoning_content };
      }
      if (delta?.content) {
        yield { type: 'delta', text: delta.content };
      }
      if (json.usage) {
        yield { type: 'usage', usage: json.usage, model: json.model || model };
      }
    }
  }
}

/* ============================================================
   看图：把一张截图发给视觉模型
   ------------------------------------------------------------
   走的通道可以用 WATCH_CHANNEL / WATCH_MODEL 指定，默认复用主对话。
   ============================================================ */
export async function callVision({
  system,
  text = '这是对方此刻的屏幕。',
  imageDataUrl,
  channel = process.env.WATCH_CHANNEL || 'chat',
  model = '',
  temperature = 0.7,
  maxTokens = 120
}) {
  const conf = providerConfig(channel);
  /* WATCH_MODEL 只对指定的看图通道生效，别把别的通道也顶成 Claude */
  const envModel = channel === (process.env.WATCH_CHANNEL || '') ? process.env.WATCH_MODEL || '' : '';
  const useModel = model || envModel || conf.model;
  const { base, key } = conf;
  if (!base) throw new Error('看图通道未配置');
  if (!key) throw new Error('看图通道缺少 key');

  const res = await fetch(endpoint(base) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: useModel,
      ...(acceptsTemperature(useModel) ? { temperature } : {}),
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: imageDataUrl } }
          ]
        }
      ]
    })
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`看图失败 ${res.status}：${raw.slice(0, 200)}`);
  const json = JSON.parse(raw);
  return {
    content: json.choices?.[0]?.message?.content ?? '',
    model: json.model || useModel,
    tokens: json.usage?.total_tokens ?? 0
  };
}
