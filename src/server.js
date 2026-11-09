/**
 * Bunny's Home — 后端骨架
 * 第四章只做一件事：能被 Render 跑起来，并且有一个健康检查接口。
 */
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

/* ---------- 健康检查：Render 用这个确认服务活着 ---------- */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: "bunny's home api",
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString()
  });
});

/* ---------- 根路径给个人看的说明 ---------- */
app.get('/', (req, res) => {
  res.type('text/plain').send(
    "Bunny's Home API 正在运行。\n健康检查：/health\n"
  );
});

/* ---------- 占位：第五章接模型时替换这里 ---------- */
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages 必须是数组' });
  }
  res.json({
    role: 'assistant',
    content: '（骨架阶段）我收到你的消息了，等第五章接上模型就会真的回你。',
    model: 'stub',
    tokens: 0
  });
});

app.listen(PORT, () => {
  console.log(`Bunny's Home API listening on http://localhost:${PORT}`);
});
