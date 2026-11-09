/**
 * Supabase 连接
 * ------------------------------------------------------------
 * 只用 service_role key，绝不暴露给前端。
 * 这个 key 能绕过 RLS，所以只允许出现在后端进程的环境变量里。
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn(
    '[db] 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，数据库相关接口会返回 503'
  );
}

export const dbReady = Boolean(url && key);

export const supabase = dbReady
  ? createClient(url, key, { auth: { persistSession: false } })
  : null;
