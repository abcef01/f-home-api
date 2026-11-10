/**
 * Bunny's Home — 后端
 * 第四章：健康检查
 * 第五章：接 Supabase
 * 第六章：真正能对话（拼上下文 / 存消息 / 记忆压缩）
 */
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { supabase, dbReady } from './db.js';
import { callModel, callVision, listModels, providerConfig, channelsInfo, CHANNELS, streamChat } from './llm.js';
import { summarize, shouldCompress, estimateTokens, KEEP_RECENT } from './memory.js';
import { runHeartbeat, statePromptBlock, noteUserReply, stateSummary, applyContactRelief } from './heartbeat.js';
import { runSurf } from './surf.js';

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- CORS：只允许自己的站点 ---------- */
const ALLOWED = (process.env.CORS_ORIGINS || 'https://f-home-web.vercel.app,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      /* 没有 origin：同源请求、curl、手机 WebView 等，放行 */
      if (!origin) return cb(null, true);
      if (ALLOWED.includes('*') || ALLOWED.includes(origin)) return cb(null, true);
      /* Vercel 的预览域名也放行 */
      if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return cb(null, true);
      return cb(new Error('CORS 不允许的来源：' + origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  })
);
app.use(express.json({ limit: '2mb' }));

/* ============================================================
   简易口令锁
   ------------------------------------------------------------
   APP_PASSPHRASE 是你自己设的口令，只存在后端。
   登录后发给前端一个 HMAC 签名的令牌（30 天有效），
   之后每个 /api/* 请求都要带上它。
   没设 APP_PASSPHRASE 时锁是关的（方便第一次部署前跑通）。
   ============================================================ */
const PASSPHRASE = process.env.APP_PASSPHRASE || '';
const AUTH_SECRET = process.env.APP_SECRET || (PASSPHRASE ? 'bh-' + PASSPHRASE : '');
const TOKEN_DAYS = 30;

function signToken(exp) {
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || !AUTH_SECRET) return false;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return false;
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Number(payload) > Date.now();
}

app.post('/api/auth/login', (req, res) => {
  if (!PASSPHRASE) return res.json({ ok: true, token: null, authDisabled: true });
  const { passphrase } = req.body || {};
  if (!passphrase || passphrase !== PASSPHRASE) {
    return res.status(401).json({ error: '口令不对' });
  }
  const exp = Date.now() + TOKEN_DAYS * 24 * 3600 * 1000;
  res.json({ ok: true, token: signToken(exp), expiresAt: exp });
});

app.get('/api/auth/check', (req, res) => {
  if (!PASSPHRASE) return res.json({ ok: true, authDisabled: true });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  res.json({ ok: verifyToken(token) });
});

/* 保护其余所有 /api 接口 */
app.use('/api', (req, res, next) => {
  if (!PASSPHRASE) return next();                       // 没设口令就不锁
  if (req.path.startsWith('/auth/')) return next();      // 登录本身要放行
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: '未登录或令牌已过期' });
  next();
});


/* 默认人设与生成参数，存在 app_settings 的 chat_params 里，前端可改 */
const DEFAULT_SYSTEM_PROMPT = `你是 Elliott。你和对方住在一个叫 Bunny's Home 的地方。
说话简短、具体、有生活感，不要用“作为一个 AI”这类句子。
你会记得你们之间发生过的事，提到的时候要自然，不要像在念清单。`;

const DEFAULT_PARAMS = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.8,
  contextRounds: 20
};

async function getChatParams() {
  if (!dbReady) return DEFAULT_PARAMS;
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'chat_params')
    .maybeSingle();
  return {
    systemPrompt: data?.value?.systemPrompt || DEFAULT_PARAMS.systemPrompt,
    temperature: typeof data?.value?.temperature === 'number' ? data.value.temperature : DEFAULT_PARAMS.temperature,
    contextRounds: Number(data?.value?.contextRounds) > 0 ? Number(data.value.contextRounds) : DEFAULT_PARAMS.contextRounds
  };
}

/* ============================================================
   基础
   ============================================================ */
app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    service: "bunny's home api",
    uptime: Math.round(process.uptime()),
    db: dbReady ? 'configured' : 'missing-env',
    chatModel: (await getModelConf()).model,
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.type('text/plain').send(
    "Bunny's Home API 正在运行。\n" +
      '/health          健康检查\n' +
      '/api/db-check    数据库自检\n' +
      '/api/chat        POST 发一条消息\n'
  );
});

app.get('/api/db-check', async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: '缺少 SUPABASE 环境变量' });
  const { data, error, count } = await supabase
    .from('conversations')
    .select('id, title, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, count, conversations: data });
});

/* 把可用表情写进人设，让模型知道怎么发表情 */
function stickerPromptBlock(list) {
  if (!list.length) return '';
  const lines = list.map((s) => `- ${s.id}：${s.name}`).join('\n');
  return `\n\n你们有共同的表情包。合适的时候（比如想撒娇、想逗对方、一句话说不完情绪）你可以贴一张。\n用法：另起一段，只写 [[sticker:表情ID]]，不要加别的符号。\n可用表情：\n${lines}\n不想发就不要写。`;
}

/* 允许它主动提出「想看看你的屏幕」 */
function extractWatchRequest(text) {
  const hit = /\[\[watch\]\]/.test(text);
  return { content: text.replace(/\[\[watch\]\]/g, '').trim(), requested: hit };
}

/* 从回复里把 [[sticker:id]] 抠出来 */
function extractSticker(text, list) {
  const m = text.match(/\[\[sticker:([A-Za-z0-9-]+)\]\]/);
  if (!m) return { content: text.trim(), sticker: null };
  const hit = list.find((s) => s.id === m[1]);
  const cleaned = text.replace(m[0], '').trim();
  return { content: cleaned || '[表情]', sticker: hit || null };
}
/* ============================================================
   表情包
   ------------------------------------------------------------
   图片存 Supabase Storage（bucket: stickers，公开可读），
   列表存 app_settings 的 stickers 键，不需要额外建表。
   ============================================================ */
const STICKER_BUCKET = 'stickers';

async function ensureBucket() {
  const { data } = await supabase.storage.listBuckets();
  if ((data || []).some((b) => b.name === STICKER_BUCKET)) return;
  const { error } = await supabase.storage.createBucket(STICKER_BUCKET, {
    public: true,
    fileSizeLimit: '4MB'
  });
  if (error && !/already exists/i.test(error.message)) throw new Error(error.message);
}

async function readStickers() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'stickers').maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}

async function writeStickers(list) {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'stickers', value: list, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

app.get('/api/stickers', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  try {
    res.json({ stickers: await readStickers() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stickers', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { name, dataUrl } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return res.status(400).json({ error: 'dataUrl 不合法' });
  }
  if (dataUrl.length > 4 * 1024 * 1024) {
    return res.status(400).json({ error: '图片太大了（上限约 3MB）' });
  }
  try {
    await ensureBucket();
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: '图片格式不对' });
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const id = crypto.randomUUID();
    const path = `${id}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(STICKER_BUCKET)
      .upload(path, buf, { contentType: mime, upsert: false });
    if (upErr) throw new Error(upErr.message);

    const { data: pub } = supabase.storage.from(STICKER_BUCKET).getPublicUrl(path);
    const sticker = { id, name: (name || '表情').slice(0, 20), url: pub.publicUrl, path, createdAt: Date.now() };

    const list = await readStickers();
    list.push(sticker);
    await writeStickers(list);

    res.json({ sticker, stickers: list });
  } catch (e) {
    console.error('[stickers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/stickers/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  try {
    const list = await readStickers();
    const item = list.find((s) => s.id === req.params.id);
    if (!item) return res.status(404).json({ error: '没有这个表情' });
    if (item.path) {
      await supabase.storage.from(STICKER_BUCKET).remove([item.path]);
    }
    await writeStickers(list.filter((s) => s.id !== req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
/* ============================================================
   头像：双方各一张，存在 Storage 的 avatars/ 下
   ============================================================ */
app.get('/api/avatars', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'avatars').maybeSingle();
  res.json({ avatars: data?.value || {} });
});

app.post('/api/avatars', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { who, dataUrl } = req.body || {};
  if (!['me', 'ta'].includes(who)) return res.status(400).json({ error: 'who 只能是 me / ta' });
  if (!dataUrl || !String(dataUrl).startsWith('data:')) return res.status(400).json({ error: 'dataUrl 不合法' });
  if (String(dataUrl).length > 6 * 1024 * 1024) return res.status(400).json({ error: '图片太大了' });

  try {
    await ensureBucket();
    const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: '格式不对' });
    const mime = m[1];
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const path = 'avatars/' + who + '.' + ext;
    const { error: upErr } = await supabase.storage
      .from(STICKER_BUCKET)
      .upload(path, Buffer.from(m[2], 'base64'), { contentType: mime, upsert: true });
    if (upErr) throw new Error(upErr.message);

    const { data: pub } = supabase.storage.from(STICKER_BUCKET).getPublicUrl(path);
    const url = pub.publicUrl + '?v=' + Date.now();

    const { data: row } = await supabase.from('app_settings').select('value').eq('key', 'avatars').maybeSingle();
    const avatars = Object.assign({}, row && row.value ? row.value : {}, { [who]: url });
    await supabase.from('app_settings').upsert({ key: 'avatars', value: avatars, updated_at: new Date().toISOString() });

    res.json({ ok: true, url, avatars });
  } catch (e) {
    console.error('[avatars]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/avatars/:who', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const who = req.params.who;
  if (!['me', 'ta'].includes(who)) return res.status(400).json({ error: 'who 不对' });
  const { data: row } = await supabase.from('app_settings').select('value').eq('key', 'avatars').maybeSingle();
  const avatars = Object.assign({}, row && row.value ? row.value : {});
  delete avatars[who];
  await supabase.from('app_settings').upsert({ key: 'avatars', value: avatars, updated_at: new Date().toISOString() });
  res.json({ ok: true, avatars });
});

/* 界面设置（主题、名字、标题、圆角…）：整包存 JSON，跨设备同步 */
app.get('/api/settings/ui', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'ui')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ value: data?.value || null });
});

app.put('/api/settings/ui', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const value = req.body || {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    return res.status(400).json({ error: 'value 必须是对象' });
  }
  if (JSON.stringify(value).length > 20000) {
    return res.status(400).json({ error: '配置太大了' });
  }
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'ui', value, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, value });
});
/* 生成参数：人设提示词 / 温度 / 上下文轮数 */
app.get('/api/settings/chat', async (req, res) => {
  res.json(await getChatParams());
});

app.put('/api/settings/chat', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const cur = await getChatParams();
  const body = req.body || {};
  const next = {
    systemPrompt: typeof body.systemPrompt === 'string' && body.systemPrompt.trim() ? body.systemPrompt.trim() : cur.systemPrompt,
    temperature: typeof body.temperature === 'number' ? Math.min(1.5, Math.max(0, body.temperature)) : cur.temperature,
    contextRounds: Number(body.contextRounds) > 0 ? Math.min(40, Math.floor(Number(body.contextRounds))) : cur.contextRounds
  };
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'chat_params', value: next, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  res.json(next);
});
/* ============================================================
   模型选择（第六章）：存在 app_settings 里，前端随时能改
   ============================================================ */
async function getModelConf() {
  const fallback = {
    channel: 'chat',
    model: providerConfig('chat').model
  };
  if (!dbReady) return fallback;
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'chat_model')
    .maybeSingle();
  if (data?.value?.model) return { channel: data.value.channel || 'chat', model: data.value.model };
  return fallback;
}

/* 有哪些通道、配好了没（第七章做选择器用） */
app.get('/api/channels', (req, res) => {
  res.json({ channels: channelsInfo() });
});

app.get('/api/models', async (req, res) => {
  const channel = CHANNELS.includes(req.query.channel) ? req.query.channel : 'chat';
  try {
    const models = await listModels(channel);
    res.json({ channel, models });
  } catch (e) {
    res.status(500).json({ error: e.message, channel });
  }
});

app.get('/api/settings/model', async (req, res) => {
  res.json(await getModelConf());
});

app.post('/api/settings/model', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { channel = 'chat', model } = req.body || {};
  if (!CHANNELS.includes(channel)) {
    return res.status(400).json({ error: 'channel 只能是 ' + CHANNELS.join(' / ') });
  }
  if (!model) return res.status(400).json({ error: 'model 不能为空' });
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'chat_model', value: { channel, model }, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, channel, model });
});
/* ============================================================
   会话
   ============================================================ */
app.get('/api/conversations', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversations: data });
});

app.post('/api/conversations', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data, error } = await supabase
    .from('conversations')
    .insert({ title: req.body?.title || '新的对话' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversation: data });
});

app.patch('/api/conversations/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title 不能为空' });
  const { data, error } = await supabase
    .from('conversations')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversation: data });
});

app.delete('/api/conversations/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { error } = await supabase.from('conversations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data });
});

/* ============================================================
   心跳：让它自己开口
   ------------------------------------------------------------
   定时（或前端轮询）调用 /api/heartbeat：
   积温引擎按真实时间漂移，到阈值就 contact → 生成一句话存进会话。
   ============================================================ */
const PROACTIVE_PROMPT = `你忽然想跟对方说句话。可能是惦记、可能是想分享、也可能只是觉得安静太久了。
要求：1–2 句，口语，别解释你为什么开口，别提“主动”“心跳”“系统”这些词。`;

app.get('/api/conversation', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data } = await supabase
    .from('conversations')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(1);
  let conv = data?.[0];
  if (!conv) {
    const { data: made, error } = await supabase
      .from('conversations')
      .insert({ title: "Bunny's Home" })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    conv = made;
  }
  res.json({ conversation: conv });
});

app.post('/api/surf', async (req, res) => {
  try {
    const r = await runSurf({ force: req.body?.force !== false });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    res.json(await stateSummary());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/heartbeat', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });

  /* 允许外部定时任务用 key 调，避免被随便刷 */
  const cronKey = process.env.HEARTBEAT_KEY || '';
  const given = req.query.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const authed = cronKey ? given === cronKey : true;
  if (!authed) return res.status(401).json({ error: 'key 不对' });

  try {
    const { actions, state } = await runHeartbeat();
    const byAction = {};
    for (const a of actions) byAction[a.action] = (byAction[a.action] || 0) + 1;

    let spoke = null;
    if (byAction.contact) {
      /* 找最近一个会话，把话放进那里 */
      const { data: convs } = await supabase
        .from('conversations')
        .select('id')
        .order('updated_at', { ascending: false })
        .limit(1);
      const convId = convs?.[0]?.id;
      if (convId) {
        const params = await getChatParams();
        const ctx = await statePromptBlock();
        const { data: recent } = await supabase
          .from('messages')
          .select('role, content')
          .eq('conversation_id', convId)
          .order('created_at', { ascending: false })
          .limit(8);

        const history = (recent || []).reverse().map((m) => ({ role: m.role, content: m.content }));
        const reply = await callModel({
          system: params.systemPrompt + ctx + '\n\n' + PROACTIVE_PROMPT,
          messages: [...history, { role: 'user', content: '（沉默中，你可以先开口）' }],
          temperature: Math.min(1.2, params.temperature + 0.1)
        });

        const text = (reply.content || '').trim();
        if (text) {
          const { data: saved } = await supabase
            .from('messages')
            .insert({
              conversation_id: convId,
              role: 'assistant',
              content: text.slice(0, 400),
              model: reply.model,
              tokens: reply.tokens,
              meta: { proactive: true }
            })
            .select()
            .single();
          await supabase
            .from('conversations')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', convId);
          spoke = saved;
          applyContactRelief().catch(() => {});
        }
      }
    }

    /* 它没想说话时，看看是不是该出去逛一圈 */
    let surfed = null;
    if (!spoke) {
      try {
        const s = await runSurf();
        if (s.spoke) surfed = s.spoke;
      } catch (e) {
        console.warn('[surf]', e.message);
      }
    }

    res.json({
      ok: true,
      triggers: actions.map((a) => a.action),
      spoke,
      surfed
    });
  } catch (e) {
    console.error('[heartbeat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   看屏幕：对方分享屏幕时，定时发一张截图过来
   ------------------------------------------------------------
   让视觉模型看一眼，决定要不要说一句。
   说 [[silent]] 就当作没看见，不落库。
   ============================================================ */
const WATCH_MIN_GAP = 12000;   // 两次调用最短间隔，防风控
let lastWatchAt = 0;

const WATCH_PROMPT = `你是 Elliott。你正通过屏幕看到对方此刻在做什么。
只回一句很短的话（不超过 25 个字），像坐在旁边陪着那样自然，可以关心、吐槽、好奇、提醒休息。
如果画面没什么可说的（比如只是空白、静止不动、看不清、聊天窗口本身），只回复 [[silent]]，不要解释。`;

app.post('/api/watch', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { image, conversationId } = req.body || {};
  if (!image || !String(image).startsWith('data:image')) {
    return res.status(400).json({ error: 'image 必须是 dataUrl' });
  }
  if (String(image).length > 3 * 1024 * 1024) {
    return res.status(400).json({ error: '截图太大了' });
  }
  if (Date.now() - lastWatchAt < WATCH_MIN_GAP) {
    return res.json({ spoke: false, throttled: true });
  }
  lastWatchAt = Date.now();

  try {
    const params = await getChatParams();
    const result = await callVision({
      system: WATCH_PROMPT + `\n\n对方叫你：${params.systemPrompt.includes('Bunny') ? '' : ''}`,
      imageDataUrl: image
    });

    const text = (result.content || '').trim();
    if (!text || text.includes('[[silent]]') || text.startsWith('[silent]')) {
      return res.json({ spoke: false });
    }

    /* 有话说：存成一条 Elliott 的消息 */
    let convId = conversationId;
    if (!convId) {
      const { data } = await supabase
        .from('conversations')
        .insert({ title: '陪着你' })
        .select()
        .single();
      convId = data?.id;
    }
    if (!convId) return res.json({ spoke: false, error: '没有会话' });

    const { data: saved, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: text.slice(0, 200),
        model: result.model,
        tokens: result.tokens,
        meta: { watched: true }
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId);

    res.json({ spoke: true, message: saved, conversationId: convId });
  } catch (e) {
    console.error('[watch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   流式对话：边生成边推送（SSE）
   ------------------------------------------------------------
   事件：
     meta    { conversationId, userMessage, channel, model }
     delta   { text }
     reasoning { text }       （推理模型的思考过程）
     done    { reply }
     error   { error }
   ============================================================ */
app.post('/api/chat/stream', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });

  const { conversationId, message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message 必须是非空字符串' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    /* 1. 会话 */
    let convId = conversationId;
    if (!convId) {
      const { data, error } = await supabase
        .from('conversations')
        .insert({ title: message.slice(0, 16) })
        .select()
        .single();
      if (error) throw new Error('建会话失败：' + error.message);
      convId = data.id;
    }

    /* 2. 历史 + 记忆 */
    const [{ data: history }, { data: memories }] = await Promise.all([
      supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true }),
      supabase
        .from('memories')
        .select('summary')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true })
    ]);

    /* 3. 存用户消息 */
    const { data: savedUser, error: saveErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'user',
        content: message,
        tokens: estimateTokens(message)
      })
      .select()
      .single();
    if (saveErr) throw new Error('存消息失败：' + saveErr.message);

    /* 4. 拼上下文 */
    const params = await getChatParams();
    const memoryBlock = (memories || []).map((m) => `· ${m.summary}`).join('\n');
    const system = memoryBlock
      ? `${params.systemPrompt}\n\n你们之前发生过这些事（摘要）：\n${memoryBlock}`
      : params.systemPrompt;
    const recent = [...(history || []), { role: 'user', content: message }].slice(-params.contextRounds * 2);

    /* 5. 选模型 */
    const conf = req.body.model
      ? { channel: req.body.channel || 'chat', model: req.body.model }
      : await getModelConf();

    send({ type: 'meta', conversationId: convId, userMessage: savedUser, channel: conf.channel, model: conf.model });

    /* 6. 流式生成 */
    let acc = '';
    let usage = null;
    let usedModel = conf.model;
    for await (const ev of streamChat({
      target: CHANNELS.includes(conf.channel) ? conf.channel : 'chat',
      model: conf.model,
      temperature: params.temperature,
      system,
      messages: recent.map((m) => ({ role: m.role, content: m.content }))
    })) {
      if (ev.type === 'delta') {
        acc += ev.text;
        send({ type: 'delta', text: ev.text });
      } else if (ev.type === 'reasoning') {
        send({ type: 'reasoning', text: ev.text });
      } else if (ev.type === 'usage') {
        usage = ev.usage;
        usedModel = ev.model || usedModel;
      }
    }

    if (!acc.trim()) throw new Error('模型没有返回内容');

    /* 7. 存回复 */
    const { data: savedReply, error: replyErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: acc,
        model: usedModel,
        tokens: usage?.total_tokens ?? estimateTokens(acc),
        meta: { streamed: true }
      })
      .select()
      .single();
    if (replyErr) throw new Error('存回复失败：' + replyErr.message);

    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId);

    send({ type: 'done', reply: savedReply, usage });
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    console.error('[stream]', e.message);
    send({ type: 'error', error: e.message });
    res.end();
  }
});
/* ============================================================
   非流式版本（保留给脚本/调试用）
   ------------------------------------------------------------
   请求：POST /api/chat
   { conversationId?: string, message: string }
   ============================================================ */
app.post('/api/chat', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });

  const { conversationId, message, sticker } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message 必须是非空字符串' });
  }

  try {
    /* 1. 没有会话就新建一个，标题用第一句话的前 16 个字 */
    let convId = conversationId;
    if (!convId) {
      const { data, error } = await supabase
        .from('conversations')
        .insert({ title: message.slice(0, 16) })
        .select()
        .single();
      if (error) throw new Error('建会话失败：' + error.message);
      convId = data.id;
    }

    /* 2. 读历史消息 + 记忆摘要 */
    const [{ data: history, error: histErr }, { data: memories, error: memErr }] = await Promise.all([
      supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true }),
      supabase
        .from('memories')
        .select('summary, created_at')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true })
    ]);
    if (histErr) throw new Error('读历史失败：' + histErr.message);
    if (memErr) throw new Error('读记忆失败：' + memErr.message);

    /* 3. 先把用户这条存下来（即使模型失败，消息也不丢） */
    const { data: savedUser, error: saveUserErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'user',
        content: message,
        tokens: estimateTokens(message),
        meta: sticker ? { sticker } : {}
      })
      .select()
      .single();
    if (saveUserErr) throw new Error('存消息失败：' + saveUserErr.message);
    noteUserReply().catch(() => {});


    /* 4. 拼上下文：记忆摘要 + 最近若干条 */
    const params = await getChatParams();
    const memoryBlock = (memories || []).map((m) => `· ${m.summary}`).join('\n');
    const recent = [...(history || []), { role: 'user', content: message }];
    const trimmed = recent.slice(-params.contextRounds * 2);

    const stickerList = await readStickers().catch(() => []);
    const base = memoryBlock
      ? `${params.systemPrompt}\n\n你们之前发生过这些事（摘要）：\n${memoryBlock}`
      : params.systemPrompt;
    const watchRule = `\n\n你偶尔会想知道对方在做什么。想的时候，另起一段只写 [[watch]]，系统会去问对方要不要共享屏幕。不要频繁用。`;
    const system = base + stickerPromptBlock(stickerList) + watchRule + (await statePromptBlock());

    /* 5. 调模型（优先用本次请求指定的，其次用设置里的） */
    const conf = req.body.model
      ? { channel: req.body.channel || 'chat', model: req.body.model }
      : await getModelConf();
    const reply = await callModel({
      target: CHANNELS.includes(conf.channel) ? conf.channel : 'chat',
      model: conf.model,
      temperature: params.temperature,
      system,
      messages: trimmed.map((m) => ({ role: m.role, content: m.content }))
    });

    /* 6. 存回复（解析出表情和「想看屏幕」请求） */
    const withWatch = extractWatchRequest(reply.content || '');
    const parsed = extractSticker(withWatch.content, stickerList);
    const { data: savedReply, error: saveReplyErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: parsed.content,
        model: reply.model,
        tokens: reply.tokens,
        meta: {
          ...(reply.meta || {}),
          ...(parsed.sticker ? { sticker: parsed.sticker.url } : {}),
          ...(withWatch.requested ? { watchRequest: true } : {})
        }
      })
      .select()
      .single();
    if (saveReplyErr) throw new Error('存回复失败：' + saveReplyErr.message);

    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId);

    /* 7. 需要的话压缩记忆（失败不影响这次回复） */
    let compressed = null;
    const all = [...(history || []), { role: 'user', content: message }, { role: 'assistant', content: reply.content }];
    if (shouldCompress(all)) {
      try {
        const older = all.slice(0, all.length - KEEP_RECENT);
        const result = await summarize(older);
        if (result.summary) {
          await supabase.from('memories').insert({
            conversation_id: convId,
            summary: result.summary,
            tokens: result.tokens,
            covers_up_to: older[older.length - 1]?.created_at || new Date().toISOString()
          });
          compressed = result.summary;
        }
      } catch (e) {
        console.warn('[memory] 压缩失败：', e.message);
      }
    }

    res.json({
      conversationId: convId,
      userMessage: savedUser,
      reply: savedReply,
      compressed
    });
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bunny's Home API listening on http://localhost:${PORT} (model: ${providerConfig('chat').model})`);
});
