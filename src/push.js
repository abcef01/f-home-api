/**
 * 后台通知（Web Push，无需安装 App）
 * ------------------------------------------------------------
 * 不依赖 web-push 之类的库：Node 自带的 crypto 足够做 VAPID 签名。
 *
 * 采用「无 payload 的推送」——只发一个信号，Service Worker 收到后
 * 自己弹通知，点开进 App 就能看到新消息。好处是不用实现 RFC 8291
 * 的消息加密（那是整套里最容易写错的部分）。
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEYS_KEY = 'push_keys';
const SUBS_KEY = 'push_subs';

/* ---------- 密钥 ---------- */
let keysCache = null;

async function readSetting(key) {
  if (!dbReady) return null;
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

async function writeSetting(key, value) {
  if (!dbReady) return;
  await supabase.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() });
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export async function getKeys() {
  if (keysCache) return keysCache;
  const saved = await readSetting(KEYS_KEY);
  if (saved?.publicKey && saved?.privateKey) {
    keysCache = saved;
    return keysCache;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url')
  ]);
  keysCache = {
    publicKey: b64url(raw), // 给浏览器用的 applicationServerKey
    privateKey: priv.d, // base64url
    x: pub.x,
    y: pub.y
  };
  await writeSetting(KEYS_KEY, keysCache);
  return keysCache;
}

/* ---------- VAPID ---------- */
function vapidHeaders(endpoint, keys) {
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: 'mailto:bunny@example.com'
    })
  );
  const signingInput = `${header}.${payload}`;

  const d = Buffer.from(keys.privateKey, 'base64url');
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: keys.x, y: keys.y },
    format: 'jwk'
  });
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });

  return {
    Authorization: `vapid t=${signingInput}.${b64url(sig)}, k=${keys.publicKey}`,
    TTL: '120',
    Urgency: 'high',
    'Content-Length': '0'
  };
}

/* ---------- 订阅 ---------- */
export async function listSubscriptions() {
  const v = await readSetting(SUBS_KEY);
  return Array.isArray(v) ? v : [];
}

export async function addSubscription(sub) {
  if (!sub?.endpoint) throw new Error('订阅不合法');
  const list = await listSubscriptions();
  const next = list.filter((s) => s.endpoint !== sub.endpoint);
  next.push({ endpoint: sub.endpoint, keys: sub.keys || null, at: Date.now() });
  await writeSetting(SUBS_KEY, next.slice(-10));
  return next.length;
}

export async function removeSubscription(endpoint) {
  const list = await listSubscriptions();
  await writeSetting(SUBS_KEY, list.filter((s) => s.endpoint !== endpoint));
}

/* ---------- 发送 ---------- */
export async function notifyAll() {
  if (!dbReady) return { sent: 0 };
  const subs = await listSubscriptions();
  if (!subs.length) return { sent: 0 };

  const keys = await getKeys();
  let sent = 0;
  const dead = [];

  for (const s of subs) {
    try {
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: vapidHeaders(s.endpoint, keys),
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) sent += 1;
      else if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
      else console.warn('[push] 发送失败', res.status, (await res.text()).slice(0, 80));
    } catch (e) {
      console.warn('[push] 网络失败', e.message.slice(0, 60));
    }
  }

  if (dead.length) {
    await writeSetting(
      SUBS_KEY,
      subs.filter((s) => !dead.includes(s.endpoint))
    );
  }
  return { sent, removed: dead.length };
}
