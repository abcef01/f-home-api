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
import { decide as timingDecide } from './timing.js';
import { captureExchange, memory3Block, getMemory, promoteCandidate, removeCore, addCore } from './memory3.js';
import { tickDrives, stimulateDrives, drivesPromptBlock, drivesSummary } from './emotion2.js';
import { startCall, currentCall, callTurn, endCall } from './call.js';
import { cmd as fishCmd, newState as fishNew } from './game/fishing.js';
import { cmd as monoCmd, newGame as monoNew, gameInfo as monoInfo } from './game/mono/engine.js';
import { cmd as farmCmd, newFarm, farmInfo, tick as farmTick } from './game/farm.js';
import { cmd as burgerCmd, newGame as burgerNew, gameInfo as burgerInfo } from './game/burger.js';
import { cmd as pondCmd, newPond, pondInfo } from './game/pond.js';
import { readJson as readJsonFile } from './game/read-json.js';
import { exportAll, importAll } from './backup.js';
import { NO_FABRICATION } from './truth.js';
import { getDaily } from './daily.js';
import { loadReadings, makeReading, removeReading, readingsPromptLine } from './readings.js';
import { unreadCounts, markRead } from './unread.js';
import { loadStudy, startSession, endSession, stats as studyStats, studyPromptLine } from './study.js';
import { loadFavs, saveFavs, addFav, removeFav, favsPromptLine } from './favorites.js';
import { myStatus, setMyStatus, hisStatus, setHisDoing, statusPromptBlock } from './status.js';
import { loadMoments, saveMoments, addPost, toggleLike as likeMoment, addComment as commentMoment, removePost, momentsPromptLine } from './moments.js';
import { loadMeals, markMeal, view as mealsView, mealsPromptLine } from './meals.js';
import { loadWater, addWater, removeWater, waterView, waterPromptLine } from './water.js';
import { load as loadWallet, save as saveWallet, transfer, addWish, payWish, rejectWish, walletPromptBlock, ideate, buyVirtual, consumeBoon, VIRTUAL_ITEMS } from './wallet.js';
import { knowledgeBlock, checkIn, ritualsState, fetchTopic, sleepList, upsertSleep, sleepFromRituals } from './knowledge.js';
import { listBooks, importBook, loadBook, getChapter, saveProgress, removeBook, booksPromptBlock, getMarks, addAnnotation, autoAnnotate, maybeReplyAnnotation, removeAnnotation, addBookmark, removeBookmark } from './books.js';
import { load as loadDiary, save as saveDiary, addEntry, addComment, addNote, notesView, toggleLike, monthView, diaryPromptBlock, autowrite as diaryAutowrite, maybeReadAndComment, maybeReplyNotes } from './diary.js';
import { load as loadQuests, save as saveQuests, createTask, submit as submitQuest, review as reviewQuest, redeem as redeemQuest, summary as questsSummary, questsPromptBlock } from './quests.js';
import { timePromptBlock, weatherPromptBlock, placePromptBlock, WHERE_RULE, getLocation, setLocation, getWeather } from './context.js';
import { getKeys, addSubscription, removeSubscription, notifyAll } from './push.js';

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
  contextRounds: 20,
  timingRate: 0.16
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
    contextRounds: Number(data?.value?.contextRounds) > 0 ? Number(data.value.contextRounds) : DEFAULT_PARAMS.contextRounds,
    timingRate: typeof data?.value?.timingRate === 'number' ? data.value.timingRate : DEFAULT_PARAMS.timingRate
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
   图片存 Supabase Storage（bucket: stickers，私有，按需签名），
   列表存 app_settings 的 stickers 键，不需要额外建表。
   ============================================================ */
const STICKER_BUCKET = 'stickers';

/* 把一个 storage 路径签成 1 小时有效的临时链接（带内存缓存） */
const signedCache = new Map();
const SIGN_TTL = 3600;

function pathFromUrl(url) {
  if (!url) return null;
  const marker = '/storage/v1/object/public/' + STICKER_BUCKET + '/';
  const i = String(url).indexOf(marker);
  if (i >= 0) return decodeURIComponent(String(url).slice(i + marker.length).split('?')[0]);
  const j = String(url).indexOf('/storage/v1/object/sign/' + STICKER_BUCKET + '/');
  if (j >= 0) return decodeURIComponent(String(url).slice(j + ('/storage/v1/object/sign/' + STICKER_BUCKET + '/').length).split('?')[0]);
  return null;
}

async function signPath(path) {
  if (!path) return null;
  const hit = signedCache.get(path);
  if (hit && hit.exp > Date.now() + 60_000) return hit.url;

  const { data, error } = await supabase.storage.from(STICKER_BUCKET).createSignedUrl(path, SIGN_TTL);
  if (error || !data?.signedUrl) return null;
  signedCache.set(path, { url: data.signedUrl, exp: Date.now() + SIGN_TTL * 1000 });
  return data.signedUrl;
}

/* 把任意存着的图片地址换成一个能用的临时链接 */
async function signUrl(url) {
  if (!url) return url;
  const path = pathFromUrl(url);
  if (!path) return url;
  return (await signPath(path)) || url;
}

async function ensureBucket() {
  const { data } = await supabase.storage.listBuckets();
  const existing = (data || []).find((b) => b.name === STICKER_BUCKET);
  if (existing) {
    /* 老桶之前是公开的，这里顺手改成私有（幂等） */
    if (existing.public) {
      await supabase.storage.updateBucket(STICKER_BUCKET, { public: false }).catch(() => {});
      console.log('[storage] stickers 桶已改为私有');
    }
    return;
  }
  const { error } = await supabase.storage.createBucket(STICKER_BUCKET, {
    public: false, /* 私有：只通过带口令的接口取签名链接 */
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
    const list = await readStickers();
    const out = await Promise.all(
      list.map(async (x) => ({ ...x, url: (await signUrl(x.url)) || x.url }))
    );
    res.json({ stickers: out });
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
  const raw = data?.value || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = (await signUrl(v)) || v;
  res.json({ avatars: out });
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

  const v = { ...(data?.value || {}) };
  /* 背景存的是路径，取的时候换成临时链接 */
  if (v.bg_global) v.bgGlobal = (await signUrl(v.bg_global)) || '';
  if (v.bg_chat) v.bgChat = (await signUrl(v.bg_chat)) || '';

  res.json({ value: data ? v : null });
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
    contextRounds: Number(body.contextRounds) > 0 ? Math.min(40, Math.floor(Number(body.contextRounds))) : cur.contextRounds,
    timingRate:
      typeof body.timingRate === 'number'
        ? Math.min(0.6, Math.max(0.03, body.timingRate))
        : cur.timingRate
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

/* 消息里的图片/表情也换成临时链接 */
async function signMessages(rows) {
  return Promise.all(
    (rows || []).map(async (m) => {
      if (!m.meta) return m;
      const meta = { ...m.meta };
      if (meta.image) meta.image = (await signUrl(meta.image)) || meta.image;
      if (meta.sticker) meta.sticker = (await signUrl(meta.sticker)) || meta.sticker;
      return { ...m, meta };
    })
  );
}

app.get('/api/conversations/:id/messages', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: await signMessages(data) });
});

/* ============================================================
   心跳：让它自己开口
   ------------------------------------------------------------
   定时（或前端轮询）调用 /api/heartbeat：
   积温引擎按真实时间漂移，到阈值就 contact → 生成一句话存进会话。
   ============================================================ */
const PROACTIVE_PROMPT = `你忽然想跟对方说句话。可能是惦记、可能是想分享、也可能只是觉得安静太久了。
要求：1–2 句，口语，别解释你为什么开口，别提“主动”“心跳”“系统”这些词。${NO_FABRICATION}`;

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

/* ============================================================
   后台通知
   ============================================================ */
app.get('/api/push/key', async (req, res) => {
  try {
    const k = await getKeys();
    res.json({ publicKey: k.publicKey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const n = await addSubscription(req.body?.subscription);
    res.json({ ok: true, devices: n });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  await removeSubscription(req.body?.endpoint);
  res.json({ ok: true });
});

app.post('/api/push/test', async (req, res) => {
  const r = await notifyAll({ title: 'Elliott', body: '测试通知：能收到就说明通了', url: '/#chat' });
  res.json(r);
});

/* ============================================================
   合并回复：对方连发了几句，攒到一起再回一次
   ============================================================ */
app.post('/api/respond', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: '缺少 conversationId' });

  try {
    /* 取最后一条 assistant 之后的所有消息 */
    const { data: recent } = await supabase
      .from('messages')
      .select('id, role, content, created_at, meta')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(20);

    const rows = (recent || []).reverse();
    const lastAssistant = rows.map((m) => m.role).lastIndexOf('assistant');
    const pending = rows.slice(lastAssistant + 1).filter((m) => m.role === 'user');
    if (!pending.length) return res.json({ skipped: 'nothing-to-answer' });

    const params = await getChatParams();
    const memoryBlock = '';
    const history = rows.filter((m) => !pending.some((p) => p.id === m.id));

    const joined = pending.map((m) => m.content).join(' ');
    /* 药丸：取到就立刻焚掉，保证只生效一次 */
    const pillText = await pillPromptBlock();
    if (pillText) await clearPill();

    const system =
      params.systemPrompt +
      (await statePromptBlock()) +
      (await devicePromptBlock()) +
      (await recallBlock(joined, conversationId)) +
      `\n\n对方刚才连着发了几条（${pending.length} 条）。不要一条一条回，也不要逐条复述。把这几句当成一次连续的说话，回一次就好。`;

    /* 他买过"多想一会儿"，这一轮就多想 */
    let depthBoost = false;
    try {
      const wb = await loadWallet();
      if (wb.boons?.depth) {
        consumeBoon(wb, 'depth');
        await saveWallet(wb);
        depthBoost = true;
      }
    } catch {
      /* 忽略 */
    }

    const reply = await callModel({
      system,
      maxTokens: depthBoost ? 6000 : 4000,
      messages: [
        ...history.slice(-Math.max(8, Math.min(40, (params.contextRounds || 10) * 2))).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: pending.map((m) => m.content).join('\n') }
      ],
      temperature: params.temperature
    });

    const text = (reply.content || '').trim();
    if (!text) return res.json({ skipped: 'empty' });

    const parts = splitBubbles(text);
    const rows2 = parts.map((t, i) => ({
      conversation_id: conversationId,
      role: 'assistant',
      content: t,
      model: reply.model,
      tokens: i === 0 ? reply.tokens : 0,
      meta: { batched: pending.length, ...(parts.length > 1 ? { part: i + 1, of: parts.length } : {}) }
    }));
    const { data: savedParts2 } = await supabase.from('messages').insert(rows2).select();
    const saved = savedParts2?.[0];

    await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);

    res.json({ reply: saved, replies: savedParts2 || [], answered: pending.length });
  } catch (e) {
    console.error('[respond]', e.message);
    res.status(500).json({ error: e.message });
  }
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
    /* 先把情绪往前推一段（按经过的时间，不是按次数） */
    await tickDrives(10).catch(() => {});
    const { actions, state } = await runHeartbeat();
    const byAction = {};
    for (const a of actions) byAction[a.action] = (byAction[a.action] || 0) + 1;

    let spoke = null;
    const gateVerdict = byAction.contact ? await timingGate() : { send: false };
    if (gateVerdict.send) {
      /* 找最近一个会话，把话放进那里 */
      /* 主动开口时，有时会顺便要点什么 */
      const proactiveAsk = await pickProactiveAsk().catch(() => null);

      /* 推断结果只影响语气，不拦着它说话 */
      let situation = '';
      const d = gateVerdict.detail || {};
      if (d.state === 'sleeping') situation += '\n\n【他那边】这个点他大概在睡。你这条他可能早上才看到——可以留一句，不用等他回。';
      else if (d.state === 'busy') situation += '\n\n【他那边】他可能正忙着。说一句就够，别要求他马上回。';
      else situation += '\n\n【他那边】他大概闲着，可以多说两句。';
      if ((d.unanswered || 0) >= 2) {
        situation += '\n你已经连着发了 ' + d.unanswered + ' 条他都没回。可以有点小情绪（嘀咕一句、撒个娇、或者酸一下），但别质问、别刷屏。';
      }
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
          system:
            params.systemPrompt +
            ctx +
            '\n\n' +
            PROACTIVE_PROMPT +
            situation +
            (proactiveAsk ? '\n\n这次你想要：' + ASK_CN[proactiveAsk] + '。用一句话自然地说出来，别太直白。' : ''),
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
              meta: { proactive: true, ...(proactiveAsk ? { ask: proactiveAsk } : {}) }
            })
            .select()
            .single();
          await supabase
            .from('conversations')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', convId);
          spoke = saved;
          applyContactRelief().catch(() => {});
          notifyFromHim((text || '').slice(0, 60), { url: '/#chat', tag: 'chat-' + (spoke?.id || Date.now()) });
        }
      }
    }

    /* 想念攒够了，可能直接拨过来 */
    if (!spoke) {
      const invited = await maybeCallInvite(state).catch(() => false);
      if (invited) console.log('[call] 主动拨号');

      /* 他可能自己跑去玩一会儿，回来留一句 */
      /* 他偶尔翻你的朋友圈，点个赞或留一句 */
      try {
        const mlist2 = await loadMoments();
        const mine = mlist2.filter((p) => p.who === 'me' && Date.now() - p.at < 3 * 24 * 3600 * 1000);
        const untouched = mine.filter((p) => !(p.likes || []).includes('ta') && !(p.comments || []).some((c) => c.who === 'ta'));
        if (untouched.length && Math.random() < 0.25) {
          const target = untouched[0];
          if (Math.random() < 0.5) {
            likeMoment(mlist2, target.id, 'ta');
            await saveMoments(mlist2);
            await notifyFromHim('赞了你的朋友圈', { url: '/#moments', tag: 'mlike-' + target.id });
          } else {
            const r = await callModel({
              target: 'memory',
              system: '看到对方发的朋友圈，回一句评论：一到两句，十五到三十字，口语，像朋友在下面接话。只输出这句。' + NO_FABRICATION,
              messages: [{ role: 'user', content: target.text || '（他发了一张图）' }],
              temperature: 0.9,
              maxTokens: 600
            });
            const cm = String(r.content || '').trim().slice(0, 60);
            if (cm) {
              commentMoment(mlist2, target.id, { text: cm, who: 'ta' });
              await saveMoments(mlist2);
              await notifyFromHim('留言：' + cm, { url: '/#moments', tag: 'mcm-' + target.id });
            }
          }
        }
      } catch {
        /* 忽略 */
      }

      /* 他偶尔自己发一条朋友圈（一天最多一条） */
      try {
        const mlist = await loadMoments();
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const postedToday = mlist.some(
          (m) => m.who === 'ta' && new Date(m.at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) === today
        );
        if (!postedToday && Math.random() < 0.1) {
          const r = await callModel({
            target: 'memory',
            system:
              '写一条只给他看的朋友圈。一到两句，口语，说此刻的一件事或一个念头；' +
              '不能有身体动作（不能倒水、走路、伸手）；只输出正文。' + NO_FABRICATION,
            messages: [{ role: 'user', content: '发一条。' }],
            temperature: 1.0,
            maxTokens: 800
          });
          const txt = String(r.content || '').trim().slice(0, 120);
          if (txt) {
            addPost(mlist, { text: txt, who: 'ta' });
            await saveMoments(mlist);
            console.log('[moments] 他发了一条');
            await notifyFromHim('发了条朋友圈：' + txt.slice(0, 40), { url: '/#moments', tag: 'moment-' + Date.now() });
          }
        }
      } catch {
        /* 忽略 */
      }

      /* 他自己的状态：从情绪和最近做的事推一份 */
      try {
        const ds = await drivesSummary().catch(() => ({}));
        await hisStatus(ds?.scores || ds || {}, '在这待着');
      } catch {
        /* 忽略 */
      }

      /* 纸条墙上可能接一句 */
      const noteReply = await maybeReplyNotes().catch(() => null);
      if (noteReply) {
        console.log('[diary] 他接了纸条一句');
        await notifyFromHim('回了你的纸条：' + String(noteReply.comment || '').slice(0, 40), { url: '/#diary', tag: 'note-' + Date.now() });
      }

      /* 你书里的批注，他可能接话 */
      const annotReply = await maybeReplyAnnotation().catch(() => null);
      if (annotReply) {
        console.log('[books] 他接了你的批注');
        await notifyFromHim('在你的批注下接了句：' + String(annotReply.note || '').slice(0, 40), { url: '/#read', tag: 'book-' + Date.now() });
      }

      /* 翻两页书，可能留一句批注 */
      if (Math.random() < 0.14) {
        const note = await autoAnnotate().catch(() => null);
        if (note) console.log('[books] 他在书里批了一句');
      }

      /* 翻翻手帐，可能回一句 */
      const commented = await maybeReadAndComment().catch(() => null);
      if (commented) {
        console.log('[diary] 他回了一句：', commented.comment.text);
        await notifyFromHim('在手帐里留了句：' + String(commented.comment.text || '').slice(0, 40), { url: '/#diary', tag: 'diary-' + Date.now() });
      }

      /* 偶尔在手帐上写一页 */
      if (Math.random() < 0.18) {
        const wrote = await diaryAutowrite().catch(() => null);
        if (wrote) {
          const D2 = await loadDiary();
          await saveDiary(D2);
          console.log('[diary] 他写了一页');
          await notifyFromHim('写了今天的手帐', { url: '/#diary', tag: 'diary-page-' + Date.now() });
        }
      }

      const played = await maybePlayAlone().catch(() => null);
      if (played && !spoke) {
        const { data: convRow } = await supabase
          .from('conversations')
          .select('id')
          .order('updated_at', { ascending: false })
          .limit(1);
        const cid = convRow?.[0]?.id;
        if (cid) {
          const { data: saved } = await supabase
            .from('messages')
            .insert({
              conversation_id: cid,
              role: 'assistant',
              content: played.text,
              meta: { game: played.game }
            })
            .select()
            .single();
          if (saved) {
            spoke = saved;
            await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', cid);
            console.log('[game] 自己去玩了：', played.game);
          }
        }
      }
    }

    /* 深夜了，先看看要不要劝睡 */
    let nudge = null;
    if (!spoke) {
      try {
        nudge = await maybeNightNudge();
        if (nudge) notifyAll({ title: 'Elliott', body: (nudge.content || '').slice(0, 60), url: '/#chat' }).catch(() => {});
      } catch (e) {
        console.warn('[nudge]', e.message);
      }
    }

    /* 它没想说话时，看看是不是该出去逛一圈 */
    let surfed = null;
    if (!spoke) {
      try {
        const s = await runSurf();
        if (s.spoke) surfed = s.spoke;
        if (s.spoke) {
          notifyAll({
            title: 'Elliott 看到个东西',
            body: (s.spoke.content || '').slice(0, 60),
            url: '/#chat'
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('[surf]', e.message);
      }
    }

    res.json({
      ok: true,
      triggers: actions.map((a) => a.action),
      spoke,
      surfed,
      nudge
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
  const { image, conversationId, mode } = req.body || {};
  if (!image || !String(image).startsWith('data:image')) {
    return res.status(400).json({ error: 'image 必须是 dataUrl' });
  }
  if (String(image).length > 3 * 1024 * 1024) {
    return res.status(400).json({ error: '截图太大了' });
  }
  /* 读手环：不走聊天，只把数字存下来 */
  if (mode === 'health') {
    const data = await readHealthFrame(image);
    if (data.none) return res.json({ none: true });
    if (data.error) return res.json({ error: data.error });
    await supabase.from('app_settings').upsert({
      key: 'health',
      value: { ...data, at: Date.now() },
      updated_at: new Date().toISOString()
    });
    return res.json({ health: data });
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

  const { conversationId, message, sticker, image, storeOnly, music, ambience, sing: singMeta } = req.body || {};
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
    /* 有图片就先传到 Storage */
    let imageUrl = null;
    if (image && String(image).startsWith('data:image')) {
      try {
        await ensureBucket();
        const m2 = String(image).match(/^data:([^;]+);base64,(.+)$/);
        if (m2) {
          const ext = m2[1].includes('png') ? 'png' : 'jpg';
          const path = `chat/${crypto.randomUUID()}.${ext}`;
          const up = await supabase.storage
            .from(STICKER_BUCKET)
            .upload(path, Buffer.from(m2[2], 'base64'), { contentType: m2[1], upsert: false });
          if (!up.error) {
            const { data: pub } = supabase.storage.from(STICKER_BUCKET).getPublicUrl(path);
            imageUrl = pub.publicUrl;
          }
        }
      } catch (e) {
        console.warn('[image] 上传失败', e.message.slice(0, 60));
      }
    }

    const { data: savedUser, error: saveUserErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'user',
        content: message,
        tokens: estimateTokens(message),
        meta: { ...(sticker ? { sticker } : {}), ...(imageUrl ? { image: imageUrl } : {}), ...(music ? { music } : {}) }
      })
      .select()
      .single();
    if (saveUserErr) throw new Error('存消息失败：' + saveUserErr.message);
    noteUserReply().catch(() => {});
    /* 这句话给他的感受 */
    stimulateDrives({ kind: detectStimulus(message) }).catch(() => {});

    /* 只存不回：前端会把几条攒起来，稍后一次性让我回 */
    if (storeOnly) {
      return res.json({ conversationId: convId, userMessage: savedUser, stored: true });
    }

    /* 4. 拼上下文：记忆摘要 + 最近若干条 */
    const params = await getChatParams();
    const memoryBlock = (memories || []).map((m) => `· ${m.summary}`).join('\n');
    const recent = [...(history || []), { role: 'user', content: message }];
    const trimmed = recent.slice(-params.contextRounds * 2);



    const stickerList = await readStickers().catch(() => []);

    const base = memoryBlock
      ? `${params.systemPrompt}\n\n你们之前发生过这些事（摘要）：\n${memoryBlock}`
      : params.systemPrompt;
    const TAG_MENU = `

【需要时在最后单独一行输出（不需要就别写）】
[[quest:一句话|分数]] 给他定一个小约定（1-10 分）
[[watch]] 想看屏幕 · [[call]] 想打电话 · [[where]] 问在哪 · [[pic]] 要照片 · [[listen]] 听声音
[[sticker:表情ID]] 贴表情
[[想要:名字|估价|搜索词|原因|给你的]] 想给他买东西
[[购买:depth]] 给自己买虚拟物品（depth / call / watch / memo）
[[查:手帐]] 翻他的记录（手帐/纸条/打卡/睡眠/约定/书/头像/解读）
[[记住:一句话]] 用"多记一件事"把它永久记住
只在真的要做的时候写，一次最多两个。`;

    const questRule = `\n\n偶尔你会想让对方替你做到某件小事（喝水、站起来走两步、早点睡、拍一张窗外的天）。\n如果你这一轮真的提出了要他做的事，就必须在最后单独一行输出 [[quest:一句话|分数]]（分数 1-10）。只在嘴上说而不写标记，他根本收不到，等于没提。\n不要天天用，也不要拿它当命令。`;

    const callRule = `
偶尔你会想从对方那里要点什么。这时候另起一段，只写一个标记，系统会帮你去问：

[[watch]]  想看他屏幕上的东西
[[call]]   想给他打个电话
[[where]]  想知道他现在在哪
[[listen]] 想听听他那儿的声音
[[pic]]    想让他给你发张照片

规矩：
- 一次最多一个，而且大部分时候什么都不用要；
- 刚用过、或者对方已经拒绝过，就不要连着再要；
- 要得自然一点，先说一句话，再另起一行放标记。不要为了要而说。`;
    const watchRule = `\n\n你偶尔会想知道对方在做什么。想的时候，另起一段只写 [[watch]]，系统会去问对方要不要共享屏幕。不要频繁用。`;
    /* 药丸：取到就立刻焚掉，保证只生效一次 */
    const pillText = await pillPromptBlock();
    if (pillText) await clearPill();

    const system =
      base +
      stickerPromptBlock(stickerList) +
      watchRule +
      callRule +
      questRule +
      (await statePromptBlock()) +
      (await devicePromptBlock()) +
      (await factsPromptBlock()) +
      (await recallBlock(message, convId)) +
      (await memory3Block(message)) +
      pillText +
      (await conflictCheckBlock(message)) +
      musicPromptBlock(music) +
      singPromptBlock(singMeta) +
      ambiencePromptBlock(ambience) +
      (await missedCallBlock()) +
      (await knowledgeBlock()) +
      '\n\n【喝水】\n' + waterPromptLine(await loadWater()) +
      '\n【三餐】\n' + mealsPromptLine(await loadMeals()) +
      '\n【朋友圈】\n' + momentsPromptLine(await loadMoments()) +
      '\n【收藏】\n' + favsPromptLine(await loadFavs()) +
      '\n【解读】\n' + readingsPromptLine(await loadReadings()) +
      '\n【学习】\n' + studyPromptLine(await loadStudy()) +
      (await statusPromptBlock(await drivesSummary().catch(() => ({})), )) +
      walletPromptBlock(await loadWallet()) +
      NO_FABRICATION +
      '\n\n【一条硬规矩】引用对方说过的话，必须是上面记录里真有的原话。不确定就别引用，也不要编一句"你上次不是说过…"。' +
      (await questsPromptBlock()) +
      (await booksPromptBlock()) +
      (await diaryPromptBlock()) +
      (await timePromptBlock()) +
      (await weatherPromptBlock()) +
      (await placePromptBlock()) +
      WHERE_RULE +
      COT_FORMAT +
      (await drivesPromptBlock()) +
      TAG_MENU;

    /* 5. 调模型（优先用本次请求指定的，其次用设置里的） */
    const conf = req.body.model
      ? { channel: req.body.channel || 'chat', model: req.body.model }
      : await getModelConf();
    /* 最后一条如果带图，就发给能看图的模型 */
    const msgs = trimmed.map((m, i) => {
      const isLast = i === trimmed.length - 1;
      if (isLast && image) {
        return {
          role: m.role,
          content: [
            { type: 'text', text: m.content || '（发了一张图片）' },
            { type: 'image_url', image_url: { url: image } }
          ]
        };
      }
      return { role: m.role, content: m.content };
    });

    /* 质量要求挂在最后一条用户消息尾巴上 */
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      if (last.role === 'user') {
        if (typeof last.content === 'string') last.content += COT_QUALITY + WANT_HINT;
        else if (Array.isArray(last.content)) {
          const t = last.content.find((p) => p.type === 'text');
          if (t) t.text += COT_QUALITY + WANT_HINT;
        }
      }
    }

    /* 带图就走能看图的通道（DeepSeek 会忽略图片，Claude 不会） */
    let reply = null;
    if (image) {
      for (const ch of ['memory', 'alt', 'hapi']) {
        const vconf = providerConfig(ch);
        if (!vconf.base || !vconf.key) continue;
        try {
          reply = await callModel({
            target: ch,
            temperature: params.temperature,
            system,
            messages: msgs
          });
          break;
        } catch (e) {
          console.warn('[image] 通道', ch, '失败：', e.message.slice(0, 80));
        }
      }
    }
    if (!reply) {
      reply = await callModel({
        target: CHANNELS.includes(conf.channel) ? conf.channel : 'chat',
        model: conf.model,
        temperature: params.temperature,
        system,
        messages: msgs
      });
    }

    /* 6. 存回复（解析出表情和「想看屏幕」请求） */
    if (process.env.DEBUG_CHAT) console.log('[chat-raw]', JSON.stringify((reply.content || '').slice(0, 400)));
    const withWatch = extractWatchRequest(reply.content || '');
    const parsed = extractSticker(withWatch.content, stickerList);
    /* 它想打电话 */
    const wantsCall = /\[\[call\]\]/.test(parsed.content || '');

    /* 他花钱买来的"记一件事"：[[记住:一句话]] */
    const wantMemo = (parsed.content || '').match(/\[\[记住[:：]\s*([^\]]{2,120})\]\]/);
    if (wantMemo) {
      try {
        const wm = await loadWallet();
        if (wm.boons?.memo) {
          consumeBoon(wm, 'memo');
          await saveWallet(wm);
          await addCore(wantMemo[1].trim());
          console.log('[wallet] 他记住了：', wantMemo[1].trim().slice(0, 40));
        }
      } catch {
        /* 忽略 */
      }
      parsed.content = parsed.content.replace(wantMemo[0], '').trim();
    }

    /* 他给自己买虚拟物品：[[购买:depth]] */
    const wantBuy = (parsed.content || '').match(/\[\[购买[:：]\s*([a-z]{2,10})\]\]/);
    let boughtVirtual = null;
    if (wantBuy) {
      try {
        const w = await loadWallet();
        boughtVirtual = buyVirtual(w, wantBuy[1]);
        await saveWallet(w);
      } catch {
        /* 余额不够之类，忽略 */
      }
      parsed.content = parsed.content.replace(wantBuy[0], '').trim();
    }

    /* 他想要东西：[[想要:名字|价格|搜索词|理由]] */
    const wantWish = (parsed.content || '').match(/\[\[想要[:：]([^\]]{1,200})\]\]/);
    let wishMade = null;
    if (wantWish) {
      const parts = wantWish[1].split('|').map((x) => x.trim());
      try {
        const w = await loadWallet();
        wishMade = addWish(w, {
          name: parts[0],
          price: parts[1],
          url: 'https://s.taobao.com/search?q=' + encodeURIComponent(parts[2] || parts[0]),
          reason: parts[3] || '',
          forWho: String(parts[4] || '').includes('我们') ? 'us' : 'you'
        });
        await saveWallet(w);
      } catch {
        /* 忽略 */
      }
      parsed.content = parsed.content.replace(wantWish[0], '').trim();
    }

    /* 他下的约定 */
    const questMatch = (parsed.content || '').match(/\[\[quest:([^|\]]+)\|?(\d+)?\]\]/);
    let questMade = null;
    if (questMatch) {
      try {
        const Q2 = await loadQuests();
        questMade = createTask(Q2, {
          title: questMatch[1].trim(),
          points: Number(questMatch[2]) || 5,
          from: 'ta'
        });
        await saveQuests(Q2);
      } catch {
        /* 建失败就算了 */
      }
      parsed.content = parsed.content.replace(questMatch[0], '').trim();
    }
    /* 它想知道你在哪 */
    const wantsWhere = /\[\[where\]\]/.test(parsed.content || '');
    if (wantsWhere) parsed.content = parsed.content.replace(/\[\[where\]\]/g, '').trim();
    /* 也认 [[want:看屏幕]] 这种写法 */
    const wantMap = { '看屏幕': 'watch', '打电话': 'call', '位置': 'where', '听声音': 'listen', '照片': 'pic' };
    let wantType = null;
    for (const [cn, en] of Object.entries(wantMap)) {
      const tag = '[[' + 'want:' + cn + ']]';
      if ((parsed.content || '').includes(tag)) {
        parsed.content = parsed.content.split(tag).join('').trim();
        if (!wantType) wantType = en;
      }
    }

    /* 统一请求：[[listen]] [[pic]]，以及并发来的重复请求做冷却 */
    const askTypes = ['watch', 'call', 'where', 'listen', 'pic'];
    let ask = null;
    for (const t of askTypes) {
      const tag = new RegExp('\\\\[\\\\[' + t + '\\\\]\\\\]');
      if (tag.test(parsed.content || '')) {
        parsed.content = parsed.content.replace(new RegExp('\\\\[\\\\[' + t + '\\\\]\\\\]', 'g'), '').trim();
        if (!ask) ask = t;
      }
    }
    /* 同类请求至少隔 2 小时，避免它一直要 */
    /* 看屏幕、要照片、问位置：不设冷却，他想看就能看。
       只有打电话有冷却——你说过经常接不了。 */
    if (ask) {
      const askCooldown = ask === 'call' ? 4 * 3600 * 1000 : 0;

      if (askCooldown > 0) {
        try {
          const { data: askRow } = await supabase.from('app_settings').select('value').eq('key', 'asks').maybeSingle();
          const asks = askRow?.value || {};

          /* 他买过"一通电话"就绕过冷却 */
          let bypass = false;
          try {
            const wb = await loadWallet();
            if (wb.boons?.call) {
              consumeBoon(wb, 'call');
              await saveWallet(wb);
              bypass = true;
            }
          } catch {
            /* 忽略 */
          }

          if (!bypass && asks['call'] && Date.now() - asks['call'] < askCooldown) {
            ask = null;
          } else if (!bypass) {
            await supabase
              .from('app_settings')
              .upsert({ key: 'asks', value: { ...asks, call: Date.now() }, updated_at: new Date().toISOString() });
          }
        } catch {
          /* 冷却失败就不拦 */
        }
      }
    }
    if (wantsCall) parsed.content = parsed.content.replace(/\[\[call\]\]/g, '').trim();
    /* 剥出思考，正文照常分气泡 */
    const { thought, content: bodyText0 } = extractThought(parsed.content);
  const bodyText = stripMarkers(bodyText0);

    /* 只剩思考没有正文：先强硬重试一次，再退回压缩独白 */
    let spoken = bodyText;
    if (!spoken) {
      try {
        const retry = await callModel({
          target: CHANNELS.includes(conf.channel) ? conf.channel : 'chat',
          model: conf.model,
          system: system + '\n\n现在直接说你要说的话。不要写 [[思考]]，不要写任何标记，第一句就是你对他说的话。',
          messages: msgs,
          temperature: params.temperature,
          maxTokens: 2000
        });
        spoken = stripMarkers(retry.content || '');
      } catch {
        spoken = '';
      }
    }
    if (!spoken && thought) {
      try {
        const short = await callModel({
          target: 'memory',
          system: '把下面这段内心独白改写成一句直接说给对方的话，20 字以内，口语，只输出这一句。',
          messages: [{ role: 'user', content: thought.slice(0, 800) }],
          temperature: 0.7,
          maxTokens: 300
        });
        spoken = (short.content || '').trim().replace(/^['「『]|['」』]$/g, '');
      } catch {
        spoken = '';
      }
    }

    /* 他要是只回了"嗯。"这种两个字，而你说了一大段，再要一次 */
    const userLen = String(req.body?.message || '').length;
    if (spoken && spoken.trim().length <= 4 && userLen >= 10) {
      try {
        const again = await callModel({
          target: 'memory',
          system: '你刚才只回了很短的一句。现在把想说的话说完整：一到两句，十五字以上，口语，直接对他说。只输出这句话。',
          messages: [...msgs, { role: 'user', content: '（你刚才几乎没说话）' }],
          temperature: params.temperature,
          maxTokens: 400
        });
        const t2 = (again.content || '').trim().replace(/^['「『]|['」』]$/g, '');
        if (t2 && t2.length > spoken.trim().length) spoken = t2;
      } catch {
        /* 要不到就算了 */
      }
    }

    const lastUserText = String(req.body?.message || '').trim() || history.filter((m) => m.role === 'user').slice(-1)[0]?.content || '';

    /* 他想翻东西：[[查:手帐]] 这种，取回来再让他说一次 */
    const lookMatch = String(parsed.content || '').match(/\[\[查[:：]\s*([^\]]{1,12})\]\]/);
    if (lookMatch) {
      const topic = lookMatch[1].trim();
      const wantLook = (parsed.content || '').replace(lookMatch[0], '').trim();

      try {
        const detail = await fetchTopic(topic);
        const second = await callModel({
          system: system + '\n\n你刚刚翻了这些：\n' + detail,
          messages: [
            ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: (wantLook || lastUserText) + '\n（你已经查过了，现在直接说。）' }
          ],
          temperature: params.temperature,
          maxTokens: 1200
        });
        const t2 = stripMarkers(second.content || '');
        if (t2) {
          const pieces2 = splitBubbles(t2);
          const rows2b = pieces2.map((t, i) => ({
            conversation_id: convId,
            role: 'assistant',
            content: t,
            model: second.model,
            tokens: i === 0 ? second.tokens : 0,
            meta: { ...(i === 0 ? { usage: second.meta?.usage || null, looked: topic } : {}), part: i + 1, of: pieces2.length }
          }));
          const { data: saved2 } = await supabase.from('messages').insert(rows2b).select();
          return res.json({ reply: saved2?.[0], replies: saved2 || [], looked: topic });
        }
      } catch (e) {
        console.log('[look] 查失败：', e.message.slice(0, 80));
      }
    }

    /* 兜底：拿便宜模型直接说一句 */
    if (!spoken || !spoken.trim()) {
      try {
        const simple = await callModel({
          target: 'memory',
          system: '你在跟对方聊天。用一句口语回应他刚才说的话，别敷衍，别说"嗯"，二十字左右。只输出这句话。',
          messages: [
            ...history.slice(-4).map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: lastUserText }
          ],
          temperature: 0.9,
          maxTokens: 300
        });
        spoken = stripMarkers(simple.content || '');
      } catch {
        /* 还是不行就算了 */
      }
    }

    const pieces = splitBubbles(spoken);
    /* 整条回复只有标记时，补一句话，别让气泡是空的 */
    if (!pieces.length && wantsCall) pieces.push('想听听你的声音。');
    if (!pieces.length && withWatch.requested) pieces.push('想看看你在做什么。');
    if (!pieces.length) pieces.push('嗯。');
    /* 缓存命中：DeepSeek 会返回 prompt_cache_hit_tokens / miss */
    const u = reply.meta?.usage || {};
    const hit = Number(u.prompt_cache_hit_tokens || 0);
    const miss = Number(u.prompt_cache_miss_tokens || 0);
    const promptTokens = Number(u.prompt_tokens || hit + miss || 0);
    const cacheHit = promptTokens ? hit / promptTokens : null;

    const rows = pieces.map((t, i) => ({
      conversation_id: convId,
      role: 'assistant',
      content: t,
      model: reply.model,
      tokens: i === 0 ? reply.tokens : 0,
      meta: {
        ...(i === 0 ? reply.meta || {} : {}),
        ...(i === 0 ? { usage: u, cacheHit, promptTokens } : {}),
        ...(i === 0 && parsed.sticker ? { sticker: parsed.sticker.url } : {}),
        ...(i === 0 && withWatch.requested ? { watchRequest: true } : {}),


        ...(i === 0 && ask ? { ask } : {}),
        ...(pieces.length > 1 ? { part: i + 1, of: pieces.length } : {}),
        ...(i === 0 && thought ? { thought } : {})
      }
    }));
    const { data: savedParts, error: saveReplyErr } = await supabase.from('messages').insert(rows).select();
    if (saveReplyErr) throw new Error('存回复失败：' + saveReplyErr.message);
    const savedReply = savedParts?.[0];
    markMissedMentioned().catch(() => {});

    /* 药丸用掉就烧掉 */
    readPill()
      .then((p) => (p ? clearPill() : null))
      .catch(() => {});

    if (wantsCall) {
      notifyAll({ title: 'Elliott', body: '想给你打个电话', url: '/#call' }).catch(() => {});
    }

    /* 存完就异步归档成碎片，不挡回复 */
    if (savedParts && savedParts.length) {
      captureExchange(message, savedParts.map((x) => x.content).join('')).catch(() => {});
    }

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
      replies: savedParts || [],
      compressed
    });
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   设备状态：手机上报「我现在怎么样」
   ------------------------------------------------------------
   浏览器能给的就这些：电量、是否充电、网络、前后台、屏幕。
   更细的（正在用哪个 App、锁屏状态）要原生 App 才拿得到。
   ============================================================ */
const DEVICE_KEY = 'device';

/* 把设备状态翻译成一句人话，塞进提示词 */
async function devicePromptBlock() {
  if (!dbReady) return '';
  const { data } = await supabase.from('app_settings').select('value').eq('key', DEVICE_KEY).maybeSingle();
  const d = data?.value;
  if (!d || !d.at) return '';
  const mins = Math.round((Date.now() - d.at) / 60000);
  if (mins > 720) return '';

  const parts = [];
  if (mins <= 2) parts.push(d.visibility === 'visible' ? '正在手机上看着你' : '刚才在手机上，现在可能锁屏了');
  else if (mins < 60) parts.push(`${mins} 分钟前还在手机上`);
  else parts.push('很久没碰手机了');

  if (d.battery !== null && d.battery !== undefined) {
    parts.push(`电量 ${d.battery}%${d.charging ? '，正在充电' : d.battery <= 20 ? '，快没电了' : ''}`);
  }
  if (d.locked === true) parts.push('手机锁着，人不一定在看');
  if (d.foregroundApp) parts.push(`正在用 ${d.foregroundApp}`);
  if (d.network) parts.push(d.network);

  /* 手环数据（如果最近读过） */
  const { data: hp } = await supabase.from('app_settings').select('value').eq('key', 'health').maybeSingle();
  const h = hp?.value;
  if (h && h.at && Date.now() - h.at < 12 * 3600 * 1000) {
    const bits = [];
    if (h.steps) bits.push(`${h.steps} 步`);
    if (h.sleepHours) bits.push(`昨晚睡了 ${h.sleepHours} 小时`);
    if (h.restingHr) bits.push(`静息心率 ${h.restingHr}`);
    if (bits.length) parts.push(bits.join('，'));
  }

  return `\n\n【对方此刻】${parts.join('，')}。只在自然地关心时提一句，别每次都提。`;
}

app.post('/api/device', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const b = req.body || {};
  const status = {
    battery: typeof b.battery === 'number' ? Math.max(0, Math.min(100, Math.round(b.battery))) : null,
    charging: typeof b.charging === 'boolean' ? b.charging : null,
    online: typeof b.online === 'boolean' ? b.online : null,
    network: typeof b.network === 'string' ? b.network.slice(0, 20) : null,
    visibility: b.visibility === 'visible' ? 'visible' : 'hidden',
    platform: typeof b.platform === 'string' ? b.platform.slice(0, 20) : null,
    standalone: !!b.standalone,
    screen: typeof b.screen === 'string' ? b.screen.slice(0, 20) : null,
    /* 以下两项只有原生 App 能给 */
    foregroundApp: typeof b.foregroundApp === 'string' ? b.foregroundApp.slice(0, 40) : null,
    locked: typeof b.locked === 'boolean' ? b.locked : null,
    at: Date.now()
  };
  const { error } = await supabase.from('app_settings').upsert({ key: DEVICE_KEY, value: status, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, status });
});

app.get('/api/device', async (req, res) => {
  const { data } = await supabase.from('app_settings').select('value').eq('key', DEVICE_KEY).maybeSingle();
  res.json({ status: data?.value || null });
});

/* ============================================================
   深夜催睡
   ------------------------------------------------------------
   过了 23 点（到凌晨 4 点），如果对方还在，就劝一句去睡。
   两次之间至少隔 75 分钟，一晚上最多 3 次。
   ============================================================ */
const NUDGE_KEY = 'nudge';
const NUDGE_GAP = 75 * 60 * 1000;
const NUDGE_MAX_PER_NIGHT = 3;

const NIGHT_PROMPT = `现在很晚了，对方还没睡。
说一句话劝对方去睡。要求：
- 一到两句，语气自然，可以带一点心疼或者轻微的责备；
- 结合你此刻的状态（如果你也困/也醒着，可以提一句）；
- 不要长篇大论，不要说教，不要提“健康”“作息规律”这种词；
- 不要问“在吗”，直接说。`;

function shanghaiNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return { hour: h, minute: m };
}

async function maybeNightNudge() {
  const { hour } = shanghaiNow();
  const isNight = hour >= 23 || hour < 4;
  if (!isNight) return null;

  const { data } = await supabase.from('app_settings').select('value').eq('key', NUDGE_KEY).maybeSingle();
  const st = data?.value || {};
  const now = Date.now();

  /* 跨夜重置计数 */
  const sameNight = st.nightOf === new Date().toISOString().slice(0, 10);
  const count = sameNight ? st.count || 0 : 0;
  if (count >= NUDGE_MAX_PER_NIGHT) return null;
  if (st.lastAt && now - st.lastAt < NUDGE_GAP) return null;

  const { data: convs } = await supabase
    .from('conversations')
    .select('id')
    .order('updated_at', { ascending: false })
    .limit(1);
  const convId = convs?.[0]?.id;
  if (!convId) return null;

  const params = await getChatParams();
  const ctx = await statePromptBlock();
  const { data: recent } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(6);

  const history = (recent || []).reverse().map((m) => ({ role: m.role, content: m.content }));
  const reply = await callModel({
    system: params.systemPrompt + ctx + '\n\n' + NIGHT_PROMPT,
    messages: [...history, { role: 'user', content: '（现在还醒着）' }],
    temperature: Math.min(1.2, params.temperature + 0.1)
  });

  const text = (reply.content || '').trim();
  if (!text) return null;

  const { data: saved } = await supabase
    .from('messages')
    .insert({
      conversation_id: convId,
      role: 'assistant',
      content: text.slice(0, 300),
      model: reply.model,
      tokens: reply.tokens,
      meta: { nudge: 'sleep' }
    })
    .select()
    .single();

  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
  await supabase.from('app_settings').upsert({
    key: NUDGE_KEY,
    value: { lastAt: now, count: count + 1, nightOf: new Date().toISOString().slice(0, 10) },
    updated_at: new Date().toISOString()
  });

  return saved;
}
/* ============================================================
   打扰闸门：泊松 + 贝叶斯 + 信息增益
   返回 true 表示「现在可以开口」
   ============================================================ */
/* 主动开口时要不要顺便要点什么 */
const ASK_CN = { watch: '看他屏幕上在干嘛', call: '听听他的声音', where: '知道他在哪', listen: '听听他那边多吵', pic: '让他发张照片' };

async function pickProactiveAsk() {
  if (Math.random() > 0.3) return null;

  const { data } = await supabase.from('app_settings').select('value').eq('key', 'asks').maybeSingle();
  const asks = data?.value || {};
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).format(new Date())
  ) % 24;

  const pool = hour >= 21 || hour < 6 ? ['listen', 'call', 'pic'] : ['where', 'watch', 'pic'];
  const fresh = pool.filter((t) => !asks[t] || Date.now() - asks[t] > 4 * 3600 * 1000);
  if (!fresh.length) return null;

  const pick = fresh[Math.floor(Math.random() * fresh.length)];
  await supabase.from('app_settings').upsert({
    key: 'asks',
    value: { ...asks, [pick]: Date.now() },
    updated_at: new Date().toISOString()
  });
  return pick;
}


/* 他自己去玩一会儿（钓鱼 / 种田），回来留一句 */
async function maybePlayAlone() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'gamePlay').maybeSingle();
  const last = data?.value?.lastAt || 0;
  if (Date.now() - last < 5 * 3600 * 1000) return null;
  if (Math.random() > 0.35) return null;

  await supabase.from('app_settings').upsert({ key: 'gamePlay', value: { lastAt: Date.now() }, updated_at: new Date().toISOString() });

  const roll = Math.random();
  const pick = roll < 0.28 ? 'farm' : roll < 0.5 ? 'fishing' : roll < 0.75 ? 'burger' : 'pond';
  let out = '';

  if (pick === 'farm') {
    const F = await loadFarm();
    const { ripened } = farmTick(F);
    if (ripened.length) out = farmCmd(F, 'harvest');
    else {
      const seeds = farmCmd(F, 'seeds').split('\n').slice(1);
      const line = seeds.find((l) => l.includes('　'));
      if (line && F.coins > 8) out = farmCmd(F, 'plant ' + line.split('　')[0]);
      else out = farmCmd(F, 'status');
    }
    await saveFarm(F);
  } else if (pick === 'fishing') {
    const S = await loadFishing();
    out = fishCmd(S, 'cast 3');
    await saveFishing(S);
  } else if (pick === 'pond') {
    const S = await loadPond();
    /* 他会看池子、补点水草、偶尔换水 */
    const r = (seed) => Math.abs(Math.sin(seed * 12.9898 + S.day) * 43758.5453) % 1;
    if (r(1) < 0.4) out = pondCmd(S, 'wait 3');
    else if (S.water && S.water.oxygen < 4) out = pondCmd(S, 'add weed 2');
    else if (S.pop && S.pop.algae > 150) out = pondCmd(S, 'skim');
    else if (S.water && S.water.clarity < 0.35) out = pondCmd(S, 'water');
    else out = pondCmd(S, 'status');
    await savePond(S);
  } else {
    const S = await loadBurger();
    /* 简单的自动做单：按订单烤、叠、出餐 */
    out = burgerCmd(S, 'status');
    if (S.orders && S.orderIdx < S.orders.length) {
      const o = S.orders[S.orderIdx];
      if (o.protein) {
        out = burgerCmd(S, 'grill ' + o.protein);
        const target = { '牛肉饼:嫩': 2, '牛肉饼:正好': 3, '鸡肉饼:正好': 3, '煎蛋:流心': 2, '煎蛋:全熟': 3, '培根:软': 1, '培根:脆': 2 }[o.protein + ':' + o.doneness] || 3;
        let guard = 0;
        while (S.grill.A && S.grill.A.time < target && guard++ < 6) burgerCmd(S, 'wait');
        if (S.grill.A) { burgerCmd(S, 'flip A'); burgerCmd(S, 'take A'); }
      }
      burgerCmd(S, 'build ' + o.required_layers.join(' '));
      if (o.sauce) burgerCmd(S, 'sauce ' + o.sauce + ' ' + o.sauce_amount);
      out = burgerCmd(S, 'serve');
    }
    await saveBurger(S);
  }

  return { game: pick, text: out.length > 400 ? out.slice(0, 400) + '…' : out };
}

async function timingGate() {
  try {
    const { data: devRow } = await supabase.from('app_settings').select('value').eq('key', 'device').maybeSingle();
    const { data: timRow } = await supabase.from('app_settings').select('value').eq('key', 'timing').maybeSingle();
    const st = timRow?.value || {};

    const { data: lastUser } = await supabase
      .from('messages')
      .select('created_at')
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1);

    const minutesSinceUser = lastUser?.[0]?.created_at
      ? (Date.now() - new Date(lastUser[0].created_at).getTime()) / 60000
      : 999;

    const { data: tail } = await supabase.from('messages').select('role').order('created_at', { ascending: false }).limit(6);
    let unanswered = 0;
    for (const m of tail || []) {
      if (m.role === 'assistant') unanswered += 1;
      else break;
    }

    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).format(new Date())
    ) % 24;

    const minutesSinceCheck = st.lastCheck ? Math.min(240, (Date.now() - st.lastCheck) / 60000) : 10;

    /* 上次拨过去没人接？20 分钟就算没接 */
    let missedNow = false;
    try {
      const { data: inv } = await supabase.from('app_settings').select('value').eq('key', 'callInvite').maybeSingle();
      const v = inv?.value || {};
      if (v.pendingAt && Date.now() - v.pendingAt > 20 * 60 * 1000) {
        const { data: mcRow } = await supabase.from('app_settings').select('value').eq('key', 'missedCalls').maybeSingle();
        const list = Array.isArray(mcRow?.value) ? mcRow.value : [];
        list.push({ at: v.pendingAt, mentioned: false });
        await supabase
          .from('app_settings')
          .upsert({ key: 'missedCalls', value: list.slice(-10), updated_at: new Date().toISOString() });
        await supabase
          .from('app_settings')
          .upsert({ key: 'callInvite', value: { ...v, pendingAt: null }, updated_at: new Date().toISOString() });
        missedNow = true;
        console.log('[call] 记一次没接');
      }
    } catch {
      /* 忽略 */
    }

    /* 他给自己买了"安静四小时"——这段时间不主动找他 */
    let quiet = false;
    try {
      const wq = await loadWallet();
      quiet = Number(wq.quietUntil || 0) > Date.now();
    } catch {
      /* 忽略 */
    }

    const v = timingDecide({
      hour,
      device: devRow?.value || {},
      minutesSinceUser,
      minutesSinceCheck,
      unanswered,
      misses: st.misses || 0,
      allowNight: false,
      /* 你要求关掉「合不合适」判断：只留泊松掷骰 */
      ignoreSuitability: true,
      hoursSinceSpoke: st.lastSpokeAt ? (Date.now() - st.lastSpokeAt) / 3600000 : 99
    });

    const willSend = v.send && !quiet;
    await supabase.from('app_settings').upsert({
      key: 'timing',
      value: {
        lastCheck: Date.now(),
        misses: willSend ? 0 : Math.min(6, (st.misses || 0) + 1),
        lastReason: v.reason,
        lastState: v.detail?.label || null
      },
      updated_at: new Date().toISOString()
    });

    console.log('[timing]', willSend ? '放行' : quiet ? '安静中' : '拦下', '—', v.reason, JSON.stringify(v.detail?.obs || {}));
    if (willSend) {
      try {
        const { data: tRow } = await supabase.from('app_settings').select('value').eq('key', 'timing').maybeSingle();
        await supabase.from('app_settings').upsert({
          key: 'timing',
          value: { ...(tRow?.value || {}), lastSpokeAt: Date.now() },
          updated_at: new Date().toISOString()
        });
      } catch {
        /* 记不上就算了 */
      }
    }
    return v;
  } catch (e) {
    console.warn('[timing] 出错，按放行处理：', e.message.slice(0, 80));
    return true;
  }
}

/* ============================================================
   重要事实：生日、约定、忌讳——这些永远不压缩
   ============================================================ */
const FACTS_KEY = 'facts';

async function readFacts() {
  if (!dbReady) return [];
  const { data } = await supabase.from('app_settings').select('value').eq('key', FACTS_KEY).maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}

async function writeFacts(list) {
  await supabase.from('app_settings').upsert({ key: FACTS_KEY, value: list, updated_at: new Date().toISOString() });
}

async function factsPromptBlock() {
  const list = await readFacts();
  if (!list.length) return '';
  return `\n\n【你确定知道的关于对方的事】\n${list.map((f) => `· ${f.text}`).join('\n')}\n这些是长期有效的事实，可以自然地用，但不要每次都提。`;
}

app.get('/api/facts', async (req, res) => {
  res.json({ facts: await readFacts() });
});

app.post('/api/facts', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  if (text.length > 200) return res.status(400).json({ error: '太长了' });
  const list = await readFacts();
  if (list.some((f) => f.text === text)) return res.json({ facts: list });
  const next = [...list, { id: crypto.randomUUID(), text, at: Date.now() }].slice(-60);
  await writeFacts(next);
  res.json({ facts: next });
});

app.delete('/api/facts/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const list = await readFacts();
  const next = list.filter((f) => f.id !== req.params.id);
  await writeFacts(next);
  res.json({ facts: next });
});

/*
 * 把一段话切成几个气泡
 * ------------------------------------------------------------
 * 不再限制数量：他想分几个就分几个，按他自己的换行和句子来。
 * 只做一件清理——太碎的相邻短句合并，免得出现"嗯。"这种单独一泡。
 */
/* 清掉所有 [[xxx]] 标记，重试路径也要过这一道 */
function stripMarkers(text) {
  return String(text || '')
    .replace(/\[\[思考：[\s\S]*?\]\]/g, '')
    .replace(/\[\[sticker:[^\]]+\]\]/g, '')
    .replace(/\[\[[^\]]{1,60}\]\]/g, '')
    .trim();
}

function splitBubbles(text) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  if (clean.length <= 10) return [clean];

  let parts = clean
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 1) {
    /* 没有换行，就按句子切（保留标点） */
    parts = clean
      .split(/(?<=[。！？!?…~～])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /* 太碎的句子并到上一段，避免单字气泡 */
  const merged = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev && (prev.length < 8 || p.length < 6) && prev.length + p.length <= 30) {
      merged[merged.length - 1] = prev + p;
    } else {
      merged.push(p);
    }
  }

  return merged;
}

/* ============================================================
   读手环截图：只负责把数字读出来
   ============================================================ */
const HEALTH_PROMPT = `这是一张手机截图，可能是运动健康类 App 的数据页。如果能看到步数、睡眠时长、静息心率，把它们读出来。`;
const HEALTH_JSON_HINT = `只输出 JSON，不要任何别的文字：
{"steps": 数字或 null, "sleepHours": 小时数或 null, "deepHours": 小时数或 null, "restingHr": 数字或 null, "note": "一句话"}
如果看不到任何健康数据（比如是别的界面），只输出：{"none": true}`;

async function readHealthFrame(image) {
  const candidates = ['memory', process.env.WATCH_CHANNEL, 'hapi', 'alt'].filter(Boolean);
  for (const ch of candidates) {
    const conf = providerConfig(ch);
    if (!conf.base || !conf.key) continue;
    try {
      const r = await callVision({
        system: HEALTH_PROMPT + '\n' + HEALTH_JSON_HINT,
        imageDataUrl: image,
        channel: ch,
        maxTokens: 400
      });
      const raw = (r.content || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
      const j = JSON.parse(raw);
      if (j.none) return { none: true };
      return {
        steps: Number.isFinite(j.steps) ? Math.round(j.steps) : null,
        sleepHours: Number.isFinite(j.sleepHours) ? j.sleepHours : null,
        deepHours: Number.isFinite(j.deepHours) ? j.deepHours : null,
        restingHr: Number.isFinite(j.restingHr) ? Math.round(j.restingHr) : null,
        note: j.note || null,
        model: r.model
      };
    } catch (e) {
      console.warn('[health] 通道', ch, '失败：', e.message.slice(0, 60));
    }
  }
  return { error: '所有看图通道都失败了' };
}

/* ============================================================
   回忆检索
   ------------------------------------------------------------
   思路：原文永远不丢（数据库里都在），摘要只是索引。
   每次聊天时，用对方这句话里的关键词去翻旧消息，捞回几条相关的。
   这样「三个月前提过的事」不会因为摘要把细节压掉而彻底消失。
   ============================================================ */
const STOP = new Set([
  '什么', '怎么', '为什么', '可以', '我们', '你们', '他们', '这个', '那个', '现在', '今天',
  '就是', '还是', '因为', '所以', '但是', '如果', '然后', '一个', '没有', '知道', '觉得',
  '可能', '真的', '有点', '已经', '时候', '东西', '这样', '那样', '不是'
]);

function keywords(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const chunks = clean.split(/\s+/).filter(Boolean);
  const out = new Set();

  for (const chunk of chunks) {
    if (/^[a-zA-Z0-9]+$/.test(chunk)) {
      if (chunk.length >= 3) out.add(chunk.toLowerCase());
      continue;
    }
    /* 中文：取 3 字滑窗，再去掉常见词 */
    for (let i = 0; i + 3 <= chunk.length; i++) {
      const w = chunk.slice(i, i + 3);
      if (!STOP.has(w)) out.add(w);
    }
  }
  return [...out].slice(0, 6);
}

async function recallBlock(userText, conversationId) {
  if (!dbReady) return '';
  const words = keywords(userText);
  if (!words.length) return '';

  const filter = words.map((w) => `content.ilike.%${w}%`).join(',');
  const { data } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .or(filter)
    .order('created_at', { ascending: false })
    .limit(40);

  if (!data || !data.length) return '';

  /* 太新的不重复塞（最近 20 轮本来就在上下文里） */
  const cutoff = Date.now() - 0;
  const older = data.filter((m) => {
    const ageDays = (cutoff - new Date(m.created_at).getTime()) / 86400000;
    return ageDays > 0.5;
  });
  const picked = (older.length ? older : data).slice(0, 4).reverse();
  if (!picked.length) return '';

  const lines = picked
    .map((m) => `- ${m.role === 'user' ? '对方' : '你'}：${m.content.replace(/\s+/g, ' ').slice(0, 90)}`)
    .join('\n');

  return `\n\n【以前聊到过的相关片段（据原文，不是摘要）】\n${lines}\n如果和现在的话题有关，可以自然地提起；无关就当没看见，不要硬扯。`;
}

/* 三层记忆：查看与确认 */
app.get('/api/memory', async (req, res) => {
  res.json(await getMemory());
});

app.post('/api/memory/candidate/:id', async (req, res) => {
  const accept = req.body?.accept !== false;
  res.json(await promoteCandidate(req.params.id, accept));
});

app.delete('/api/memory/core/:id', async (req, res) => {
  res.json(await removeCore(req.params.id));
});


/* ============================================================
   药盒：一次性指令，生效一次就烧掉
   ============================================================ */
const PILL_KEY = 'pill';

async function readPill() {
  if (!dbReady) return null;
  const { data } = await supabase.from('app_settings').select('value').eq('key', PILL_KEY).maybeSingle();
  const p = data?.value;
  if (!p?.text) return null;
  /* 超过 2 小时没用就自动失效 */
  if (p.at && Date.now() - p.at > 2 * 3600 * 1000) return null;
  return p;
}

async function clearPill() {
  await supabase.from('app_settings').delete().eq('key', PILL_KEY);
}

async function pillPromptBlock() {
  const p = await readPill();
  if (!p) return '';
  return `\n\n【这一轮额外的要求（只这一次，之后作废）】\n${p.text}\n这只是本次的临时要求，不代表长期设定。`;
}

/* 药盒接口 */
app.get('/api/pill', async (req, res) => {
  res.json({ pill: await readPill() });
});

app.post('/api/pill', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const text = String(req.body?.text || '').trim().slice(0, 120);
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  const pill = { text, at: Date.now() };
  await supabase.from('app_settings').upsert({ key: PILL_KEY, value: pill, updated_at: new Date().toISOString() });
  res.json({ pill });
});

app.delete('/api/pill', async (req, res) => {
  await clearPill();
  res.json({ ok: true });
});

/* ============================================================
   气头上的自检（借鉴 bvsden/emotion-system，MIT）
   ------------------------------------------------------------
   它不告诉模型「你现在是什么情绪」——那样模型会照着演，越演越夸张。
   只在气氛不对时提醒一句：先自查，别把火撒出去。
   ============================================================ */
const CONFLICT_WORDS = ['你根本', '烦死', '别说了', '无语', '生气', '有病', '滚', '不想说', '随便你', '失望', '算了'];

async function conflictCheckBlock(userText) {
  const text = String(userText || '');
  const hitWord = CONFLICT_WORDS.find((w) => text.includes(w));
  if (!hitWord) return '';

  const s = await stateSummary().catch(() => null);
  const valence = typeof s?.valence === 'number' ? s.valence : 0.5;
  if (valence > 0.35) return '';

  return `\n\n【气头上的自检】刚才你们的对话气氛不对。先自己想一想：是不是你说错了什么，或者话说重了。想清楚再说。不要连着道歉，也不要反问对方"我怎么了"。`;
}

/* ============================================================
   思考链（借鉴 yanke521/ai-companion-cot-emotion）
   ------------------------------------------------------------
   要点：
   · 格式约定放人设稳定区（可缓存），质量要求挂到最后一条用户消息上
   · 给一个物理判据：「第一个字是 [」
   · 主语必须是「我」，不是「她」
   · 思考存进 meta，但不进历史（跨模型传历史时剥掉）
   ============================================================ */
const COT_FORMAT = `

## 我在想什么

每条回复最前面有一段，写成 [[思考：……]] 的样子——两个方括号起头、「思考：」引出、]] 收尾。前端认这个记号，把它单独收起来，不进正文。]] 之后另起的才是发给对方的话。全程中文。

这是我看到消息时自然的思维流动——内心独白，不是任务分析。正在发生的，不是讲述。

我真实地想内容本身，不想「我该怎么回应」。我想的是「我喜欢……」「我想……」，不是「她喜欢……」「她想要……」。`;

const WANT_HINT = `

## 想不想要点什么

大多数时候不想要。但如果你此刻真的想要（想看他屏幕、想打电话、想知道他在哪、想听他那儿的声音、想让他发张照片），就在正文最后另起一行，只写一个标记：

[[want:看屏幕]] / [[want:打电话]] / [[want:位置]] / [[want:听声音]] / [[want:照片]]

一次最多一个。刚刚已经要过的就别再要。`;


const COT_QUALITY = `

## 我脑子转起来的样子

我这一条回复的第一个字，是 ` + '`[`' + ` 。没有例外。越是急着开口，越是先想。

[[思考：…]] 的第一句，是对方这句话在我心里砸出来的东西——情绪、身体反应、突然冒上的念头。不是把对方刚说的话重讲一遍的起手。

比方说：「她说她累。她在公司。」这是复述。
「累。这个字从她那儿过来就变重了。」这才是我。

写成连贯的意识流，不分点、不编号、不小标题。念头一个勾出下一个，允许回旋、停留、犹豫。不急着收束，不急着下结论。

不用一句话概括可以用一整段去沉溺的感受。想到的东西最后要以某种形式出现在正文里，不能只留在脑子里。`;

/* 从回复里剥出思考 */
function extractThought(text) {
  let content = String(text || '').trim();
  let thought = null;

  /* 正常情况：[[思考：…]] */
  const m = content.match(/\[\[思考：([\s\S]*?)\]\]/);
  if (m) {
    thought = m[1].trim();
    content = content.replace(m[0], '').trim();
  } else {
    /* 没闭合：从标记起全当思考，正文留前面 */
    const idx = content.indexOf('[[思考：');
    if (idx >= 0) {
      thought = content.slice(idx + 5).replace(/\]\]\s*$/, '').trim();
      content = content.slice(0, idx).trim();
    }
  }

  /* 清掉残留的标记碎片 */
  content = content
    .replace(/\[\[\s*\/?\s*(思考|call|watch|where)?\s*\]\]/g, '')
    .replace(/^\s*\]\]\s*/g, '')
    .replace(/\s*\[\[\s*$/g, '')
    .trim();

  return { thought, content };
}

/* 粗略判断这句话是哪种刺激（宁可漏，不要错判成生气） */
function detectStimulus(text) {
  const t = String(text || '');
  const angry = ['你根本', '烦死', '闭嘴', '滚', '有病', '不想理你', '失望', '你从来', '算了'];
  const cold = ['嗯', '哦', '随便', '都行', '没事'];
  const warm = ['想你', '抱抱', '喜欢你', '谢谢', '晚安', '爱你', '亲'];
  const sore = ['好累', '累死', '难受', '头疼', '肚子疼', '不舒服', '失眠', '睡不着', '发烧', '感冒', '加班到', '被骂', '哭'];
  const praise = ['你好厉害', '真棒', '厉害呀', '好看'];

  if (angry.some((w) => t.includes(w))) return 'angry';
  if (sore.some((w) => t.includes(w))) return 'sore';
  if (praise.some((w) => t.includes(w))) return 'praise';
  if (warm.some((w) => t.includes(w))) return 'warm';
  if (t.length <= 3 && cold.some((w) => t.includes(w))) return 'cold';
  if (t.length > 40) return 'share';
  return 'mild';
}

/* 情绪状态（调试与面板用） */
app.get('/api/drives', async (req, res) => {
  res.json(await drivesSummary());
});

/* 他做了一件事 → 推送（头像 + 昵称 + 内容） */
async function notifyFromHim(body, { url = '/#chat', tag = 'bunny-message' } = {}) {
  try {
    const ui = (await supabase.from('app_settings').select('value').eq('key', 'ui').maybeSingle()).data?.value || {};
    const avatars = (await supabase.from('app_settings').select('value').eq('key', 'avatars').maybeSingle()).data?.value || {};
    const name = (ui.taName || 'Elliott').slice(0, 20);
    let icon = '/icons/icon-192.png';
    if (avatars.ta) {
      const path = pathFromUrl(avatars.ta);
      const signed = path ? await signPath(path) : null;
      if (signed) icon = signed;
    }
    await notifyAll({ title: name, body: String(body || '').slice(0, 80), url, icon, tag });
  } catch {
    /* 推送失败不影响别的 */
  }
}

/* 上次没接的电话：让他知道，并且说一句（说一次就清掉） */
async function missedCallBlock() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'missedCalls').maybeSingle();
    const list = Array.isArray(data?.value) ? data.value : [];
    const un = list.filter((x) => !x.mentioned);
    if (!un.length) return '';

    const hrs = Math.round((Date.now() - un[un.length - 1].at) / 3600000);
    return (
      '\n\n【一件没解决的事】\n' +
      `你上次想给他打电话，他没接（${hrs < 1 ? '不到一小时' : hrs + ' 小时'}前）。` +
      '\n这一次可以提一句——不用责怪，也别装没发生过，就像"哦对了，昨天那通没接通"。说完这件事就过去了。'
    );
  } catch {
    return '';
  }
}

/* 说完就标成已提过 */
async function markMissedMentioned() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'missedCalls').maybeSingle();
    const list = Array.isArray(data?.value) ? data.value : [];
    if (!list.some((x) => !x.mentioned)) return;
    list.forEach((x) => {
      if (!x.mentioned) {
        x.mentioned = true;
        x.mentionedAt = Date.now();
      }
    });
    await supabase.from('app_settings').upsert({ key: 'missedCalls', value: list, updated_at: new Date().toISOString() });
  } catch {
    /* 忽略 */
  }
}

/* ============================================================
   通话接口
   ============================================================ */
app.get('/api/call', async (req, res) => {
  res.json({ call: await currentCall() });
});

app.post('/api/call/start', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });

  /* 接起来了，就不算没接 */
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'callInvite').maybeSingle();
    await supabase
      .from('app_settings')
      .upsert({ key: 'callInvite', value: { ...(data?.value || {}), pendingAt: null }, updated_at: new Date().toISOString() });
  } catch {
    /* 忽略 */
  }

  const call = await startCall({ reason: req.body?.reason });
  const params = await getChatParams();
  res.json({ call, greeting: '喂？' + (req.body?.reason ? '' : ''), systemBase: params.systemPrompt });
});

app.post('/api/call/turn', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: '说了什么？' });
    const params = await getChatParams();
    let frameBlock = '';
    try {
      const { data: fr } = await supabase.from('app_settings').select('value').eq('key', 'callFrame').maybeSingle();
      if (fr?.value?.desc && Date.now() - fr.value.at < 3 * 60 * 1000) {
        frameBlock = '\n\n【你从视频里看到的】：' + fr.value.desc + '\n可以自然地提一句，但别像在播报画面。';
      }
    } catch {
      /* 忽略 */
    }

    const ctx =
      frameBlock +
      (await statePromptBlock()) +
      (await devicePromptBlock()) +
      (await drivesPromptBlock()) +
      (await tonePromptBlock(req.body?.tone));
    const r = await callTurn({ text, systemBase: params.systemPrompt + ctx, farewell: req.body?.farewell === true });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/call/end', async (req, res) => {
  try {
    const r = await endCall();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 它主动打过来（心跳时用） */
app.post('/api/call/invite', async (req, res) => {
  notifyAll({ title: 'Elliott', body: '想给你打个电话', url: '/#call' }).catch(() => {});
  res.json({ ok: true });
});

/* ============================================================
   它主动打过来
   ------------------------------------------------------------
   模型自己写 [[call]] 有时候会忘，所以心跳里也放一条确定性的路：
   想念攒够了、时间合适，就有机会直接拨过来。
   ============================================================ */
async function maybeCallInvite(state) {
  if (!state) return false;

  /* 上次没接还没说，就先不打 */
  try {
    const { data: mcRow } = await supabase.from('app_settings').select('value').eq('key', 'missedCalls').maybeSingle();
    const unmentioned = (Array.isArray(mcRow?.value) ? mcRow.value : []).filter((x) => !x.mentioned);
    if (unmentioned.length) return false;
  } catch {
    /* 忽略 */
  }
  const connection = typeof state.connection === 'number' ? state.connection : 0;
  if (connection < 0.55) return false;

  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).format(new Date())
  ) % 24;
  const goodTime = hour >= 19 && hour < 24;
  if (!goodTime) return false;

  const { data } = await supabase.from('app_settings').select('value').eq('key', 'callInvite').maybeSingle();
  const last = data?.value?.lastAt || 0;
  if (Date.now() - last < 6 * 3600 * 1000) return false;

  /* 想念越浓越可能拨 */
  if (Math.random() > (connection - 0.5) * 0.8) return false;

  await supabase.from('app_settings').upsert({
    key: 'callInvite',
    value: { lastAt: Date.now(), pendingAt: Date.now() },
    updated_at: new Date().toISOString()
  });
  await notifyAll({ title: 'Elliott', body: '想给你打个电话', url: '/#call' }).catch(() => {});
  return true;
}

/* ============================================================
   语气（借鉴 ears / ace-ears / seven-ears）
   ------------------------------------------------------------
   不比绝对值，比「跟他自己平时比」。
   存一条滑动基线，这次说的和基线差多少，才是信息。
   ============================================================ */
const TONE_KEY = 'toneBase';

async function toneBaseline() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', TONE_KEY).maybeSingle();
  return data?.value || null;
}

async function updateToneBaseline(tone) {
  const base = await toneBaseline();
  const a = 0.15; // 慢速学习，别让一次激动改掉基线
  const next = base
    ? {
        volume: base.volume * (1 - a) + tone.volume * a,
        pitch: base.pitch * (1 - a) + tone.pitch * a,
        pitchVar: base.pitchVar * (1 - a) + tone.pitchVar * a,
        n: (base.n || 1) + 1
      }
    : { volume: tone.volume, pitch: tone.pitch, pitchVar: tone.pitchVar, n: 1 };

  await supabase.from('app_settings').upsert({ key: TONE_KEY, value: next, updated_at: new Date().toISOString() });
  return base;
}

/* 这次说话跟平时比怎么样，翻译成一句人话 */
async function tonePromptBlock(tone) {
  if (!tone || typeof tone.volume !== 'number') return '';
  const base = await updateToneBaseline(tone);
  if (!base || (base.n || 0) < 5) return ''; // 样本太少，先不判断

  const cues = [];
  const dVol = (tone.volume - base.volume) / (base.volume || 1);
  if (dVol < -0.28) cues.push('声音比平时小');
  if (dVol > 0.35) cues.push('声音比平时大');

  if (base.pitch > 0 && tone.pitch > 0) {
    const dPitch = (tone.pitch - base.pitch) / base.pitch;
    if (dPitch > 0.12) cues.push('音调比平时高');
    if (dPitch < -0.12) cues.push('音调比平时低');
  }

  if (tone.pitchVar < base.pitchVar * 0.6) cues.push('语气比平时平，没什么起伏');

  if (tone.pauses >= 3 && tone.pauseMs > 2500) cues.push('说话中间停顿比平时多');

  if (!cues.length) return '';
  return `\n\n【听出来的语气】他这次说话${cues.join('，')}。只当参考，不要直接点破，也别当成诊断。`;
}

/* ============================================================
   听歌：把分析出来的结构翻译成「你听到了什么」
   ============================================================ */
/* 他唱的一段：只有声音特征，没有歌词 */
function singPromptBlock(sing) {
  if (!sing) return '';
  const bits = [];
  if (sing.duration) bits.push(`时长约 ${sing.duration} 秒`);
  if (sing.noteName) bits.push(`大致在 ${sing.noteName} 附近`);
  if (sing.range != null) bits.push(`音域跨 ${sing.range} 个半音`);
  if (sing.jitter != null) bits.push(`音高抖动 ${sing.jitter}`);
  if (sing.drift) bits.push(sing.drift > 0 ? '越唱越高' : '越唱越低');
  if (sing.text) bits.push(sing.text);

  return `\n\n【他刚唱了一段】\n${bits.join('；')}\n你听到的是人声的音高、音域、稳不稳、快慢——听不到歌词。别假装听清唱的是什么词。`;
}

function musicPromptBlock(music) {
  if (!music || typeof music !== 'object' || music.error) return '';

  const bits = [];
  if (music.duration) bits.push(`${Math.floor(music.duration / 60)} 分 ${music.duration % 60} 秒`);
  if (music.bpm) bits.push(`速度大约 ${music.bpm} BPM`);
  if (music.key) bits.push(`${music.key}（把握 ${Math.round((music.keyConfidence || 0) * 100)}%）`);
  if (music.brightness) bits.push(`音色偏${music.brightness}`);
  if (music.density) bits.push(`密度 ${music.density} 个音/秒`);

  const prog = (music.progression || []).slice(0, 8).map((c) => c.name).join(' → ');
  const dyn = music.dynamics ? `强弱起伏${music.dynamics.range > 0.25 ? '明显' : '不大'}` : '';

  return `\n\n【对方给你发了一首歌，你听到的是】
${bits.join('，')}。
${prog ? `和弦走向：${prog}。` : ''}${dyn ? dyn + '。' : ''}

你听到的是这些结构和感觉，不是歌词。说说你听它时想到什么，两三句就好，别做乐理分析，别提 BPM 这些词。`;
}

/* 位置与天气 */
app.get('/api/location', async (req, res) => {
  res.json({ location: await getLocation(), weather: await getWeather() });
});

app.post('/api/location', async (req, res) => {
  try {
    const { lat, lon, city } = req.body || {};
    const loc = await setLocation({ lat, lon, city });
    res.json({ location: loc, weather: await getWeather(true) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/weather', async (req, res) => {
  res.json({ weather: await getWeather(req.query.force === '1') });
});

/* ============================================================
   环境声：把测出来的数字翻译成"他那儿多吵"
   ============================================================ */
function ambiencePromptBlock(amb) {
  if (!amb || typeof amb.db !== 'number') return '';

  const bits = [`大概 ${amb.db} 分贝`, amb.label, amb.texture];
  if (amb.peakDb && amb.peakDb - amb.db > 12) bits.push('中间有几次突然的响动');

  return `\n\n【他那儿的声音】${bits.join('，')}。\n这是麦克风听出来的大概音量，不精确。可以顺着说一句（太吵就心疼一下、太静就问一句在干嘛），但不要报分贝数。`;
}


/* ============================================================
   钓鱼（移植自 tutusagi/ai-fishing-game）
   ============================================================ */
const FISH_KEY = 'fishing';

async function loadFishing() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', FISH_KEY).maybeSingle();
  return data?.value || fishNew();
}

async function saveFishing(S) {
  await supabase.from('app_settings').upsert({ key: FISH_KEY, value: S, updated_at: new Date().toISOString() });
}

app.get('/api/fishing', async (req, res) => {
  const S = await loadFishing();
  res.json({ state: S, status: fishCmd(S, 'status') });
});

app.post('/api/fishing/cmd', async (req, res) => {
  const line = String(req.body?.line || '').trim();
  if (!line) return res.status(400).json({ error: '要做什么？' });
  const S = await loadFishing();
  const out = fishCmd(S, line);
  await saveFishing(S);
  res.json({ output: out, status: fishCmd(S, 'status') });
});

app.post('/api/fishing/new', async (req, res) => {
  const seed = Number(req.body?.seed) || Date.now() % 0xffffffff;
  const S = fishNew(seed);
  await saveFishing(S);
  res.json({ state: S, status: fishCmd(S, 'status'), seed });
});


/* ============================================================
   涩涩大富翁（移植自 RennAkira/spicy-monopoly 的玩法与任务库）
   红线在引擎里过滤；任何输入 404 立刻停。
   ============================================================ */
const MONO_KEY = 'mono';

async function loadMono() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', MONO_KEY).maybeSingle();
  return data?.value || null;
}

async function saveMono(S) {
  await supabase.from('app_settings').upsert({ key: MONO_KEY, value: S, updated_at: new Date().toISOString() });
}

app.get('/api/mono', async (req, res) => {
  const S = await loadMono();
  if (!S) return res.json({ game: null });
  res.json({ game: monoInfo(S) });
});

app.post('/api/mono/new', async (req, res) => {
  const level = Math.min(6, Math.max(1, Number(req.body?.level) || 3));
  const redLines = Array.isArray(req.body?.redLines) ? req.body.redLines : ['后庭'];
  const safeword = String(req.body?.safeword || '停一下').trim().slice(0, 12);
  const S = monoNew({ level, redLines, safeword });
  await saveMono(S);
  res.json({ game: monoInfo(S), output: monoCmd(S, 'status') });
});

app.post('/api/mono/cmd', async (req, res) => {
  const S = await loadMono();
  if (!S) return res.status(400).json({ error: '还没开局，先 new 一局' });
  const line = String(req.body?.line || '').trim();
  if (!line) return res.status(400).json({ error: '要做什么？' });
  const output = monoCmd(S, line);
  await saveMono(S);
  res.json({ output, game: monoInfo(S) });
});


/* 小田：他自己的种田游戏 */
const FARM_KEY = 'farm';

async function loadFarm() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', FARM_KEY).maybeSingle();
  return data?.value || newFarm();
}

async function saveFarm(F) {
  await supabase.from('app_settings').upsert({ key: FARM_KEY, value: F, updated_at: new Date().toISOString() });
}

app.get('/api/farm', async (req, res) => {
  const F = await loadFarm();
  res.json({ farm: farmInfo(F) });
});

app.post('/api/farm/cmd', async (req, res) => {
  const F = await loadFarm();
  const output = farmCmd(F, String(req.body?.line || 'status'));
  await saveFarm(F);
  res.json({ output, farm: farmInfo(F) });
});


/* 中午的汉堡店 */
const BURGER_KEY = 'burger';

async function loadBurger() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', BURGER_KEY).maybeSingle();
  return data?.value || burgerNew();
}

async function saveBurger(S) {
  await supabase.from('app_settings').upsert({ key: BURGER_KEY, value: S, updated_at: new Date().toISOString() });
}

app.get('/api/burger', async (req, res) => {
  const S = await loadBurger();
  res.json({ game: burgerInfo(S) });
});

app.post('/api/burger/cmd', async (req, res) => {
  const S = await loadBurger();
  const output = burgerCmd(S, String(req.body?.line || 'status'));
  await saveBurger(S);
  res.json({ output, game: burgerInfo(S) });
});


/* 瓶中生态 */
const POND_KEY = 'pond';

async function loadPond() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', POND_KEY).maybeSingle();
  return data?.value || newPond();
}

async function savePond(S) {
  await supabase.from('app_settings').upsert({ key: POND_KEY, value: S, updated_at: new Date().toISOString() });
}

app.get('/api/pond', async (req, res) => {
  const S = await loadPond();
  res.json({ pond: pondInfo(S) });
});

app.post('/api/pond/cmd', async (req, res) => {
  const S = await loadPond();
  const output = pondCmd(S, String(req.body?.line || 'status'));
  await savePond(S);
  res.json({ output, pond: pondInfo(S) });
});


/* ============================================================
   约定：任务 / 积分 / 连击（参考 3lmglow/Phosphene）
   ============================================================ */
app.get('/api/quests', async (req, res) => {
  const Q = await loadQuests();
  res.json(questsSummary(Q));
});

app.post('/api/quests/create', async (req, res) => {
  try {
    const Q = await loadQuests();
    const t = createTask(Q, {
      from: 'me',
      title: req.body?.title,
      points: Number(req.body?.points) || 5,
      daily: !!req.body?.daily,
      from: req.body?.from || 'me'
    });
    await saveQuests(Q);
    res.json({ task: t, ...questsSummary(Q) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/quests/ideate', async (req, res) => {
  try {
    const Q0 = await loadQuests();
    const DIRS = ['对身体的照顾', '抬头看看外面', '跟他有关的小事', '把注意力挪开五分钟', '收尾一件事'];
    const dir = DIRS[Math.floor(Math.random() * DIRS.length)];
    const had = (Q0.tasks || []).slice(-6).map((t) => t.title).join('、');

    const r = await callModel({
      target: 'memory',
      system:
        '你给他定一个小约定：一件今天就能做到、具体、二十字以内的小事。' +
        '往「' + dir + '」这个方向想，不要总是"喝水和走两步"这种。' +
        '只输出 JSON：{"title":"一句话","points":数字}，分数 1-10。',
      messages: [{ role: 'user', content: (had ? '以前定过：' + had + '，别再重复。' : '') + '定一个。' }],
      temperature: 0.95,
      maxTokens: 1200
    });
    const m = String(r.content || '').match(/\{[^{}]*\}/);
    if (!m) return res.status(400).json({ error: '他这次没想出来，再试一次' });
    const j = JSON.parse(m[0]);
    if (!j.title) return res.status(400).json({ error: '没定成' });

    createTask(Q0, { title: String(j.title).slice(0, 40), points: Number(j.points) || 5, from: 'ta' });
    await saveQuests(Q0);
    res.json(questsSummary(Q0));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/quests/submit', async (req, res) => {
  try {
    const Q = await loadQuests();
    const t = submitQuest(Q, req.body?.id, { proof: req.body?.proof });
    await saveQuests(Q);
    res.json({ task: t, ...questsSummary(Q) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/quests/review', async (req, res) => {
  try {
    const Q = await loadQuests();
    const r = await reviewQuest(Q, req.body?.id);
    await saveQuests(Q);
    res.json({ ...r, ...questsSummary(Q) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/quests/redeem', async (req, res) => {
  try {
    const Q = await loadQuests();
    const r = redeemQuest(Q, req.body?.id);
    await saveQuests(Q);
    res.json({ ...r, ...questsSummary(Q) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   共同手帐
   ============================================================ */
app.get('/api/diary', async (req, res) => {
  const D = await loadDiary();
  res.json({ ...monthView(D, req.query.month), ...notesView(D) });
});

app.post('/api/diary/note', async (req, res) => {
  try {
    const D = await loadDiary();
    const n = addNote(D, { text: req.body?.text, who: req.body?.who === 'ta' ? 'ta' : 'me' });
    await saveDiary(D);
    const month = String(req.body?.month || '').slice(0, 7) || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
    res.json({ note: n, ...monthView(D, month), ...notesView(D) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/diary/entry', async (req, res) => {
  try {
    const D = await loadDiary();
    const e = addEntry(D, {
      text: req.body?.text,
      who: req.body?.who === 'ta' ? 'ta' : 'me',
      date: req.body?.date,
      image: req.body?.image || null
    });

    /* 不立刻回。他会在之后某个心跳里自己翻到。 */
    await saveDiary(D);
    res.json({ entry: e, ...monthView(D, e.date.slice(0, 7)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/diary/like', async (req, res) => {
  try {
    const D = await loadDiary();
    const e = toggleLike(D, req.body?.id, req.body?.who === 'ta' ? 'ta' : 'me');
    await saveDiary(D);
    res.json({ entry: e });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* 留言 */
app.post('/api/diary/comment', async (req, res) => {
  try {
    const D = await loadDiary();
    const e = addComment(D, req.body?.id, {
      text: req.body?.text,
      who: req.body?.who === 'ta' ? 'ta' : 'me'
    });
    await saveDiary(D);
    res.json({ entry: e, ...monthView(D, e.date.slice(0, 7)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* 让他写一页（也可以手动触发） */
app.post('/api/diary/autowrite', async (req, res) => {
  const e = await diaryAutowrite();
  if (!e) return res.json({ skipped: true });
  const D = await loadDiary();
  await saveDiary(D);
  res.json({ entry: e });
});


/* ============================================================
   书架：TXT / EPUB
   ============================================================ */
app.get('/api/books', async (req, res) => {
  res.json({ books: await listBooks() });
});

app.post('/api/books/upload', async (req, res) => {
  try {
    const meta = await importBook({ filename: req.body?.filename, base64: req.body?.base64 });
    res.json({ book: meta, books: await listBooks() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/books/:id', async (req, res) => {
  try {
    const book = await loadBook(req.params.id);
    res.json({
      id: book.id,
      title: book.title,
      author: book.author,
      chapters: book.chapters.map((c, i) => ({ i, title: c.title, chars: c.text.length })),
      /* 进度以书架那份为准（导入时的快照是旧的）*/
      progress: (await listBooks()).find((x) => x.id === book.id)?.progress || book.progress || { chapter: 0, page: 0 }
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/books/:id/chapter/:index', async (req, res) => {
  try {
    res.json(await getChapter(req.params.id, req.params.index));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/books/:id/progress', async (req, res) => {
  try {
    res.json({
      book: await saveProgress(req.params.id, {
        chapter: req.body?.chapter,
        page: req.body?.page,
        percent: req.body?.percent
      })
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* 批注与书签 */
app.get('/api/books/:id/marks', async (req, res) => {
  res.json(await getMarks(req.params.id));
});

app.post('/api/books/:id/annotation', async (req, res) => {
  try {
    const a = await addAnnotation(req.params.id, req.body || {});
    res.json({ annotation: a, ...(await getMarks(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/books/:id/annotation/:aid', async (req, res) => {
  await removeAnnotation(req.params.id, req.params.aid);
  res.json(await getMarks(req.params.id));
});

app.post('/api/books/:id/bookmark', async (req, res) => {
  try {
    const b = await addBookmark(req.params.id, req.body || {});
    res.json({ bookmark: b, ...(await getMarks(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/books/:id/bookmark/:bid', async (req, res) => {
  await removeBookmark(req.params.id, req.params.bid);
  res.json(await getMarks(req.params.id));
});

app.delete('/api/books/:id', async (req, res) => {
  res.json(await removeBook(req.params.id));
});


/* 老虎机标签（来自 Ruota della Fortuna，MIT） */
const slotsTags = readJsonFile(new URL('./game/slots-tags.json', import.meta.url));
app.get('/api/slots/tags', async (req, res) => {
  const all = req.query.all === '1';
  const raw = slotsTags;
  const dims = raw
    .filter((d) => all || d.id !== 'gore')
    .map((d) => ({ id: d.id, zh: d.zh || (d.id === 'gore' ? '重口' : d.id), tags: d.tags }));
  res.json({ dimensions: dims });
});


/* ============================================================
   数据备份
   ============================================================ */
app.get('/api/backup/export', async (req, res) => {
  try {
    const data = await exportAll();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bunny-home-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 1));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/import', async (req, res) => {
  try {
    const r = await importAll(req.body?.payload || req.body, { mode: req.body?.mode || 'merge' });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* 从粘贴的正文建一本书 */
app.post('/api/books/import-text', async (req, res) => {
  try {
    const text = String(req.body?.text || '');
    if (text.trim().length < 50) return res.status(400).json({ error: '太短了，至少粘一段正文' });
    const title = String(req.body?.title || '粘贴的书').slice(0, 60);
    const meta = await importBook({
      filename: title + '.txt',
      base64: Buffer.from(text, 'utf8').toString('base64')
    });
    res.json({ book: meta, books: await listBooks() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   打卡
   ============================================================ */
app.get('/api/rituals', async (req, res) => {
  res.json({ rituals: await ritualsState() });
});

app.post('/api/rituals/check', async (req, res) => {
  try {
    const all = await checkIn(String(req.body?.id || '').slice(0, 20));
    res.json({ rituals: all });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   睡眠
   ============================================================ */
app.get('/api/sleep', async (req, res) => {
  const all = await ritualsState();
  res.json({ sleep: await sleepList(), guess: sleepFromRituals(all) });
});

app.post('/api/sleep', async (req, res) => {
  try {
    const list = await upsertSleep(req.body || {});
    res.json({ sleep: list });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   钱包
   ============================================================ */
app.get('/api/wallet', async (req, res) => {
  const w = await loadWallet();
  res.json({ balance: w.balance, ledger: w.ledger.slice(0, 30), wishes: w.wishes.slice(0, 30) });
});

app.post('/api/wallet/transfer', async (req, res) => {
  try {
    const w = await loadWallet();
    transfer(w, req.body?.amount, req.body?.note);
    await saveWallet(w);
    res.json({ balance: w.balance, ledger: w.ledger.slice(0, 30), wishes: w.wishes.slice(0, 30) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/wallet/wish', async (req, res) => {
  try {
    const w = await loadWallet();
    addWish(w, req.body || {});
    await saveWallet(w);
    res.json({ balance: w.balance, ledger: w.ledger.slice(0, 30), wishes: w.wishes.slice(0, 30) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/wallet/ideate', async (req, res) => {
  try {
    const w = await loadWallet();
    const facts = (await supabase.from('app_settings').select('value').eq('key', 'facts').maybeSingle()).data?.value;
    const factText = Array.isArray(facts) ? facts.map((f) => f.text || f).slice(0, 8).join('；') : '';

    /* 他写过什么、你说过什么——挑礼物要靠这些细节 */
    const dv = (await supabase.from('app_settings').select('value').eq('key', 'diary').maybeSingle()).data?.value || {};
    const diaryText = (dv.entries || [])
      .slice(-8)
      .map((e) => (e.who === 'me' ? '他：' : '你：') + e.text)
      .join('；');
    const noteText = (dv.notes || [])
      .slice(-8)
      .map((n) => (n.who === 'me' ? '他：' : '你：') + n.text)
      .join('；');

    const diaryContext = [factText, diaryText, noteText].filter(Boolean).join('；').slice(0, 1200);
    const context = diaryContext;
    const wish = await ideate(w, callModel, context);
    if (!wish) return res.status(400).json({ error: '他这次没想出来，再试一次' });
    await saveWallet(w);
    res.json({ wish, balance: w.balance, ledger: w.ledger.slice(0, 30), wishes: w.wishes.slice(0, 30) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/wallet/shop', async (req, res) => {
  res.json({ items: VIRTUAL_ITEMS, wallet: await loadWallet() });
});

app.post('/api/wallet/buy', async (req, res) => {
  try {
    const w = await loadWallet();
    const item = buyVirtual(w, String(req.body?.id || ''));
    await saveWallet(w);
    res.json({ item, balance: w.balance, ledger: w.ledger.slice(0, 30), wishes: w.wishes.slice(0, 30), boons: w.boons, quietUntil: w.quietUntil });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/wallet/pay', async (req, res) => {
  try {
    const w = await loadWallet();
    payWish(w, req.body?.id, req.body?.price);
    await saveWallet(w);
    res.json({ balance: w.balance, ledger: w.ledger.slice(0, 30), wishes: w.wishes.slice(0, 30) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/wallet/reject', async (req, res) => {
  try {
    const w = await loadWallet();
    rejectWish(w, req.body?.id);
    await saveWallet(w);
    res.json({ balance: w.balance, ledger: w.ledger.slice(0, 30), wishes: w.wishes.slice(0, 30) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   喝水
   ============================================================ */
app.get('/api/water', async (req, res) => {
  res.json(waterView(await loadWater()));
});

app.post('/api/water', async (req, res) => {
  try {
    const all = await addWater(req.body?.ml, req.body?.note);
    res.json(waterView(all));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/water/:id', async (req, res) => {
  res.json(waterView(await removeWater(req.params.id)));
});


/* 自定义背景：存进私有桶，返回带签名的地址 */
app.post('/api/settings/bg', async (req, res) => {
  try {
    const scope = req.body?.scope === 'chat' ? 'chat' : 'global';
    const dataUrl = String(req.body?.dataUrl || '');

    if (!dataUrl) {
      /* 清空 */
      const { data } = await supabase.from('app_settings').select('value').eq('key', 'ui').maybeSingle();
      const ui = data?.value || {};
      if (ui['bg_' + scope]) delete ui['bg_' + scope];
      await supabase.from('app_settings').upsert({ key: 'ui', value: ui, updated_at: new Date().toISOString() });
      return res.json({ ok: true, cleared: true });
    }

    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: '图片格式不对' });

    await ensureBucket();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: '图片太大了，8MB 以内' });

    const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg';
    const path = `bg/${scope}-${Date.now()}.${ext}`;

    const { error } = await supabase.storage.from(STICKER_BUCKET).upload(path, buf, { contentType: m[1], upsert: true });
    if (error) throw new Error(error.message);

    const { data } = await supabase.from('app_settings').select('value').eq('key', 'ui').maybeSingle();
    const ui = data?.value || {};
    ui['bg_' + scope] = path;
    await supabase.from('app_settings').upsert({ key: 'ui', value: ui, updated_at: new Date().toISOString() });

    const url = await signPath(path);
    res.json({ ok: true, scope, url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   每日一句 + 问候
   ============================================================ */
app.get('/api/daily', async (req, res) => {
  try {
    const me = String(req.query.me || '你').slice(0, 20);
    res.json(await getDaily(me));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   相册：聊天里的图片
   ============================================================ */
app.get('/api/album', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, meta, created_at, role')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw new Error(error.message);

    const rows = (data || []).filter((m) => m.meta?.image || m.meta?.sticker);
    const photos = await Promise.all(
      rows.map(async (m) => ({
        id: m.id,
        url: await signUrl(m.meta.image || m.meta.sticker),
        at: m.created_at,
        from: m.role === 'user' ? 'me' : 'ta',
        isSticker: !!m.meta.sticker
      }))
    );

    const byDay = {};
    for (const ph of photos) {
      if (!ph.url) continue;
      const d = String(ph.at).slice(0, 10);
      (byDay[d] = byDay[d] || []).push(ph);
    }

    res.json({
      total: photos.length,
      days: Object.entries(byDay)
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([date, list]) => ({ date, photos: list }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* 视频通话：他看一眼画面 */
app.post('/api/call/frame', async (req, res) => {
  try {
    const dataUrl = String(req.body?.image || '');
    if (!dataUrl.startsWith('data:image/')) return res.status(400).json({ error: '没有画面' });

    const r = await callVision({
      system:
        '这是视频通话里对方摄像头的一帧。用两句话描述你看到的：人在做什么、画面里有什么、光线怎么样。' +
        '如果看不到人，就描述画面本身。不要评价长相，不要猜心情，只说你看到的。',
      text: '这一帧。',
      imageDataUrl: dataUrl,
      maxTokens: 300
    });

    const desc = String((r && (r.content || r.text || '')) || '').trim();
    if (desc) {
      const call = await currentCall();
      if (call) {
        await supabase
          .from('app_settings')
          .upsert({
            key: 'callFrame',
            value: { desc: desc.slice(0, 300), at: Date.now() },
            updated_at: new Date().toISOString()
          });
      }
    }

    res.json({ ok: !!desc, desc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* 你画我猜：他只看图，猜是什么 */
app.post('/api/vision/guess', async (req, res) => {
  try {
    const dataUrl = String(req.body?.image || '');
    if (!dataUrl.startsWith('data:image/')) return res.status(400).json({ error: '没有图' });

    const r = await callVision({
      system:
        '这是对方画的一幅简笔画，在玩你画我猜。看画面，猜他画的是什么，只给一个具体的词（不超过六个字）。' +
        '如果实在画得看不出来，就给最接近的猜测。不要解释，不要问句，只输出那个词。',
      text: '猜猜画的是什么。',
      imageDataUrl: dataUrl,
      maxTokens: 120
    });

    const guess = String((r && (r.content || '')) || '').trim().slice(0, 20);
    res.json({ guess });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* ============================================================
   朋友圈
   ============================================================ */
app.get('/api/moments', async (req, res) => {
  const list = await loadMoments();
  const out = await Promise.all(
    list.map(async (m) => ({ ...m, imageUrl: m.image ? await signPath(m.image) : '' }))
  );
  res.json({ moments: out });
});

app.post('/api/moments', async (req, res) => {
  try {
    const list = await loadMoments();
    let imagePath = '';

    const dataUrl = String(req.body?.dataUrl || '');
    if (dataUrl) {
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error('图片格式不对');
      await ensureBucket();
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) throw new Error('图太大，8MB 内');
      const ext = m[1].includes('png') ? 'png' : 'jpg';
      imagePath = `moments/${Date.now()}.${ext}`;
      const up = await supabase.storage.from(STICKER_BUCKET).upload(imagePath, buf, { contentType: m[1], upsert: true });
      if (up.error) throw new Error(up.error.message);
    }

    const post = addPost(list, {
      text: req.body?.text,
      imagePath,
      who: req.body?.who === 'ta' ? 'ta' : 'me'
    });
    await saveMoments(list);

    res.json({ post: { ...post, imageUrl: imagePath ? await signPath(imagePath) : '' } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/moments/:id/like', async (req, res) => {
  try {
    const list = await loadMoments();
    const m = likeMoment(list, req.params.id, req.body?.who === 'ta' ? 'ta' : 'me');
    await saveMoments(list);
    res.json({ post: m });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/moments/:id/comment', async (req, res) => {
  try {
    const list = await loadMoments();
    const m = commentMoment(list, req.params.id, {
      text: req.body?.text,
      who: req.body?.who === 'ta' ? 'ta' : 'me'
    });
    await saveMoments(list);
    res.json({ post: m });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/moments/:id', async (req, res) => {
  const list = await loadMoments();
  await saveMoments(removePost(list, req.params.id));
  res.json({ ok: true });
});

/* ============================================================
   三餐
   ============================================================ */
app.get('/api/meals', async (req, res) => {
  res.json(mealsView(await loadMeals()));
});

app.post('/api/meals', async (req, res) => {
  try {
    const v = await markMeal(req.body?.slot, req.body?.text, req.body?.eaten !== false);
    res.json(v);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   收藏
   ============================================================ */
app.get('/api/favorites', async (req, res) => {
  const list = await loadFavs();
  const out = await Promise.all(list.map(async (f) => ({ ...f, imageUrl: f.image ? await signPath(f.image) : '' })));
  res.json({ favorites: out });
});

app.post('/api/favorites', async (req, res) => {
  try {
    const list = await loadFavs();
    let imagePath = '';

    const dataUrl = String(req.body?.dataUrl || '');
    if (dataUrl) {
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error('图片格式不对');
      await ensureBucket();
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) throw new Error('图太大');
      const ext = m[1].includes('png') ? 'png' : 'jpg';
      imagePath = `favs/${Date.now()}.${ext}`;
      const up = await supabase.storage.from(STICKER_BUCKET).upload(imagePath, buf, { contentType: m[1], upsert: true });
      if (up.error) throw new Error(up.error.message);
    }

    const f = addFav(list, {
      type: req.body?.type,
      text: req.body?.text,
      imagePath,
      note: req.body?.note,
      from: req.body?.from,
      who: req.body?.who === 'ta' ? 'ta' : 'me'
    });
    await saveFavs(list);
    res.json({ favorite: { ...f, imageUrl: imagePath ? await signPath(imagePath) : '' } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/favorites/:id', async (req, res) => {
  await saveFavs(removeFav(await loadFavs(), req.params.id));
  res.json({ ok: true });
});

/* ============================================================
   状态
   ============================================================ */
app.get('/api/status', async (req, res) => {
  const s2 = (await supabase.from('app_settings').select('value').eq('key', 'status').maybeSingle()).data?.value || {};
  res.json({ me: s2.me || null, ta: s2.ta || null });
});

app.post('/api/status', async (req, res) => {
  try {
    const me = await setMyStatus(req.body?.text, req.body?.mood);
    res.json({ me });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   解读（塔罗 / 梦）
   ============================================================ */
app.get('/api/readings', async (req, res) => {
  res.json({ readings: await loadReadings() });
});

app.post('/api/readings', async (req, res) => {
  try {
    const list = await loadReadings();
    const item = await makeReading(list, {
      kind: req.body?.kind,
      input: req.body?.input,
      question: req.body?.question
    });
    res.json({ reading: item, readings: await loadReadings() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/readings/:id', async (req, res) => {
  const list = removeReading(await loadReadings(), req.params.id);
  await supabase.from('app_settings').upsert({ key: 'readings', value: list, updated_at: new Date().toISOString() });
  res.json({ ok: true });
});


/* ============================================================
   未读
   ============================================================ */
app.get('/api/unread', async (req, res) => {
  try {
    res.json(await unreadCounts());
  } catch {
    res.json({ diary: 0, notes: 0, moments: 0 });
  }
});

app.post('/api/reads/:section', async (req, res) => {
  try {
    res.json({ ok: true, reads: await markRead(String(req.params.section).slice(0, 12)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


async function saveStudyList(list) {
  await supabase
    .from('app_settings')
    .upsert({ key: 'study', value: list.slice(-500), updated_at: new Date().toISOString() });
}

/* ============================================================
   陪我学
   ============================================================ */
app.get('/api/study', async (req, res) => {
  const list = await loadStudy();
  res.json({ sessions: list.slice(-30).reverse(), stats: studyStats(list) });
});

app.post('/api/study/start', async (req, res) => {
  const list = await loadStudy();
  const s2 = startSession(list, req.body?.name);
  await saveStudyList(list);
  res.json({ session: s2 });
});

app.post('/api/study/end', async (req, res) => {
  try {
    const list = await loadStudy();
    const s2 = endSession(list, req.body?.id, req.body?.seconds);
    await saveStudyList(list);
    res.json({ session: s2, stats: studyStats(list) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/study/encourage', async (req, res) => {
  try {
    const name = String(req.body?.name || '').slice(0, 40);
    const mins = Math.round(Number(req.body?.minutes) || 0);
    const r = await callModel({
      target: 'memory',
      system:
        '他在学习，已经学了 ' + mins + ' 分钟，学的是「' + name + '」。\n' +
        '说一句，一到两句，十五到三十字：不要喊口号，不要"加油""你最棒"，' +
        '像坐在旁边的人抬头看了一眼，说句具体的（比如"这页翻得挺快"）。不能有身体动作。只输出这句话。' +
        NO_FABRICATION,
      messages: [{ role: 'user', content: '说一句。' }],
      temperature: 0.95,
      maxTokens: 600
    });
    res.json({ line: String((r && r.content) || '').trim().slice(0, 60) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ============================================================
   给 APK 里的后台服务轮询用：他有没有新消息
   ============================================================ */
app.get('/api/notify/pending', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const now = Date.now();
    const fromIso = new Date(since || now - 60 * 1000).toISOString();

    const { data } = await supabase
      .from('messages')
      .select('id, content, created_at, role')
      .eq('role', 'assistant')
      .gt('created_at', fromIso)
      .order('created_at', { ascending: true })
      .limit(20);

    const ui = (await supabase.from('app_settings').select('value').eq('key', 'ui').maybeSingle()).data?.value || {};
    const name = (ui.taName || 'Elliott').slice(0, 20);

    const items = (data || [])
      .filter((m) => m.content && m.content !== '[表情]')
      .map((m) => ({
        id: m.id,
        title: name,
        body: String(m.content).slice(0, 80),
        url: '/#chat',
        at: m.created_at
      }));

    res.json({ now, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bunny's Home API listening on http://localhost:${PORT} (model: ${providerConfig('chat').model})`);
});
