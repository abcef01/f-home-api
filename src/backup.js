/**
 * 数据备份：导出 / 导入
 * ------------------------------------------------------------
 * 这不只是"留个文件"——它是你随时能把这个家搬走的能力。
 *
 * 导出时剔除的东西：
 *   · push_keys（里面的私钥等于推送凭证）
 *   · push_subs（设备订阅地址）
 * 其余全带走：对话、消息、记忆三层、事实、手帐、纸条、约定、书架、四个游戏、设置。
 */
import { supabase, dbReady } from './db.js';

/* 不出现在的表 */
const SECRET_KEYS = new Set(['push_keys', 'push_subs']);

const TABLES = [
  { name: 'app_settings', label: '设置与状态' },
  { name: 'conversations', label: '会话' },
  { name: 'messages', label: '消息' },
  { name: 'memories', label: '记忆摘要' }
];

async function fetchAll(table, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

export async function exportAll() {
  if (!dbReady) throw new Error('数据库未配置');

  const payload = {
    format: 'bunny-home-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {}
  };

  for (const t of TABLES) {
    let rows = await fetchAll(t.name);
    if (t.name === 'app_settings') {
      rows = rows.filter((r) => !SECRET_KEYS.has(r.key));
    }
    payload.tables[t.name] = rows;
  }

  /* 统计，方便你判断文件对不对 */
  payload.summary = Object.fromEntries(
    Object.entries(payload.tables).map(([k, v]) => [k, v.length])
  );
  return payload;
}

export async function importAll(payload, { mode = 'merge' } = {}) {
  if (!dbReady) throw new Error('数据库未配置');
  if (!payload || payload.format !== 'bunny-home-backup') throw new Error('这不是本软件的备份文件');

  const report = {};

  for (const t of TABLES) {
    const rows = payload.tables?.[t.name];
    if (!Array.isArray(rows) || !rows.length) continue;

    /* app_settings 按 key 覆盖；其余按 id 覆盖 */
    const onConflict = t.name === 'app_settings' ? 'key' : 'id';

    if (mode === 'replace') {
      /* 先清空这张表（只清我们认识的表） */
      const ids = rows.map((r) => r[onConflict]).filter(Boolean);
      if (ids.length) {
        await supabase.from(t.name).delete().in(onConflict, ids);
      }
    }

    let ok = 0;
    const chunk = 200;
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      const { error } = await supabase.from(t.name).upsert(slice, { onConflict });
      if (error) throw new Error(`${t.name} 恢复失败：${error.message}`);
      ok += slice.length;
    }
    report[t.name] = ok;
  }

  return { ok: true, restored: report };
}

export function backupSummary(payload) {
  return payload?.summary || {};
}
