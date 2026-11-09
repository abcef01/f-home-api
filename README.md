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
