/**
 * 打包前清空数据
 * ------------------------------------------------------------
 * 把测试期间的一切抹掉，交给用户一个干净的软件。
 *
 * 会删：
 *   · 所有会话与消息
 *   · 所有记忆摘要（memories 表）
 *   · app_settings 里的全部状态（手帐、纸条、约定、书、游戏、打卡、睡眠、驱动值……）
 *   · Storage 里的图片（stickers / avatars）、书（bh-books）
 *
 * 不会删：Supabase 项目本身、表结构、环境变量（口令、模型 key）。
 *
 * 用法：
 *   node scripts/reset-data.mjs --yes
 * 不加 --yes 只做演练，不会真的删。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* 读 .env */
function loadEnv() {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const { createClient } = await import('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const CONFIRM = process.argv.includes('--yes');

const TABLES = ['messages', 'conversations', 'memories', 'app_settings'];
const BUCKETS = ['stickers', 'bh-books'];

async function countRows(table) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) return `? (${error.message})`;
  return count ?? 0;
}

async function wipeTable(table) {
  /* 用 id != '' 之类的条件保证真的会删，同时给 PostgREST 一个过滤条件 */
  const { error } = await supabase.from(table).delete().not('id', 'is', null);
  if (error) {
    /* app_settings 主键是 key */
    const { error: e2 } = await supabase.from(table).delete().not('key', 'is', null);
    if (e2) throw new Error(`${table}: ${e2.message}`);
  }
}

async function wipeBucket(bucket) {
  let removed = 0;
  const { data: top } = await supabase.storage.from(bucket).list('', { limit: 1000 });

  const walk = async (prefix) => {
    const { data } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
    if (!data?.length) return;
    const files = data.filter((x) => x.id).map((x) => (prefix ? `${prefix}/${x.name}` : x.name));
    if (files.length) {
      const { error } = await supabase.storage.from(bucket).remove(files);
      if (!error) removed += files.length;
    }
    for (const dir of data.filter((x) => !x.id)) {
      await walk(prefix ? `${prefix}/${dir.name}` : dir.name);
    }
  };

  await walk('');
  /* 顶层文件单独处理（list('') 只返回文件夹与根文件）*/
  const topFiles = (top || []).filter((x) => x.id).map((x) => x.name);
  if (topFiles.length) {
    await supabase.storage.from(bucket).remove(topFiles);
    removed += topFiles.length;
  }
  return removed;
}

console.log('将要清空：');
for (const t of TABLES) console.log(`  ${t.padEnd(14)} ${await countRows(t)} 行`);
console.log(`  图片桶 stickers / 书桶 bh-books 里的全部文件`);

if (!CONFIRM) {
  console.log('\n这是演练。要真的删，加 --yes：');
  console.log('  node scripts/reset-data.mjs --yes');
  process.exit(0);
}

console.log('\n开始清空…');
for (const t of TABLES) {
  const n = await countRows(t);
  await wipeTable(t);
  console.log(`  ${t} 清空 ${n} 行`);
}
for (const b of BUCKETS) {
  const n = await wipeBucket(b);
  console.log(`  ${b} 删除 ${n} 个文件`);
}

console.log('\n完成。现在是干净的。');
