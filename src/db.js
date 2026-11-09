/**
 * Supabase 连接
 * ------------------------------------------------------------
 * 只用 service_role key，绝不暴露给前端。
 * 这个 key 能绕过 RLS，所以只允许出现在后端进程的环境变量里。
 */
import fs from 'node:fs';

/* 本地开发时自动读 .env；线上（Render）直接用平台注入的环境变量 */
try {
  const file = new URL('../.env', import.meta.url);
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value && !process.env[key]) process.env[key] = value;
  }
} catch {
  /* 没有 .env 或读不到，忽略 —— 线上就是这种情况 */
}

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const looksPlaceholder = (v) =>
  !v || v.includes('xxxx') || v.trim() === '' || v.includes('粘贴');

export const dbReady = !looksPlaceholder(url) && !looksPlaceholder(key);

if (!dbReady) {
  console.warn(
    '[db] 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（或还是占位内容），数据库接口会返回 503'
  );
}

export const supabase = dbReady
  ? createClient(url, key, { auth: { persistSession: false } })
  : null;
