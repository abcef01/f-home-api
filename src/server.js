/**
 * Bunny's Home — 后端
 * 第四章：健康检查骨架
 * 第五章：接上 Supabase（建表见 supabase/schema.sql）
 */
import express from 'express';
import cors from 'cors';
import { supabase, dbReady } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

/* ---------- 健康检查 ---------- */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: "bunny's home api",
    uptime: Math.round(process.uptime()),
    db: dbReady ? 'configured' : 'missing-env',
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.type('text/plain').send(
    "Bunny's Home API 正在运行。\n健康检查：/health\n数据库自检：/api/db-check\n"
  );
});

/* ---------- 数据库自检：能不能真的读到表 ---------- */
app.get('/api/db-check', async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({
      ok: false,
      error: '缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY'
    });
  }
  const { data, error, count } = await supabase
    .from('conversations')
    .select('id, title, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
  res.json({ ok: true, count, conversations: data });
});

/* ---------- 会话列表 ---------- */
app.get('/api/conversations', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未配置' });
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversations: data });
});

/* ---------- 某个会话的消息 ---------- */
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

/* ---------- 占位：第六章接模型 ---------- */
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages 必须是数组' });
  }
  res.json({
    role: 'assistant',
    content: '（骨架阶段）我收到你的消息了，第六章接上模型就会真的回你。',
    model: 'stub',
    tokens: 0
  });
});

app.listen(PORT, () => {
  console.log(`Bunny's Home API listening on http://localhost:${PORT}`);
});
