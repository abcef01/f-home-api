/**
 * Supabase 连接
 * ------------------------------------------------------------
 * 只用 service_role key，绝不暴露给前端。
 * 这个 key 能绕过 RLS，所以只允许出现在后端进程的环境变量里。
 */
import fs from 'node:fs';

/* 加载配置的来源，按顺序：
   1. 本地 bunny-home-api/.env
   2. Render 的 Secret File（挂载在 /etc/secrets/.env）
   3. 平台注入的环境变量（优先级最高，不会被覆盖）
*/
const envFiles = [
  new URL('../.env', import.meta.url),
  new URL('file:///etc/secrets/.env')
];

for (const file of envFiles) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, '');
      if (value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* 这个来源不存在，跳过 */
  }
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
