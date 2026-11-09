# Bunny's Home · 后端

第四章的骨架：一个能被 Render 跑起来、带健康检查的 Express 服务。

```bash
npm install
npm start     # http://localhost:3000
```

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查，返回 `{ ok: true, ... }`，Render 用它确认服务活着 |
| GET | `/` | 一句人话，说明服务在跑 |
| POST | `/api/chat` | 占位，第五章接模型时替换 |

健康检查示例：

```json
{ "ok": true, "service": "bunny's home api", "uptime": 12, "time": "2026-11-09T06:40:51.005Z" }
```

## 部署到 Render

- Environment：`Node`
- Build Command：`npm install`
- Start Command：`node src/server.js`

Render 会自动读取 `PORT` 环境变量，代码里已经处理。

---

## 数据库（第五章）

表结构在 `supabase/schema.sql`，在 Supabase SQL Editor 里整段跑一次即可。
一共 7 张表：`conversations` / `messages` / `memories` / `diary_entries` / `notes` / `agenda_items` / `app_settings`。

连接只需要两个环境变量（本地放 `.env`，线上放 Render 的 Environment）：

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

用的是 **service_role**，它绕过 RLS——所以只能待在服务端，绝不能进前端。

### 验证接口

| 路径 | 作用 |
|---|---|
| `GET /health` | 含 `db: configured / missing-env` |
| `GET /api/db-check` | 真读一次 `conversations`，返回条数 |
| `GET /api/conversations` | 会话列表 |
| `GET /api/conversations/:id/messages` | 某会话的消息 |
