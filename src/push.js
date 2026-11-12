/**
 * 后台通知（Web Push，无需安装 App）
 * ------------------------------------------------------------
 * 不依赖第三方库，用 Node 自带 crypto 实现：
 *   · VAPID（ES256 JWT）—— 证明「这条推送是我发的」
 *   · aes128gcm 载荷加密（RFC 8291）—— 让通知能带正文
 */
import crypto from 'node:crypto';
import { supabase, dbReady } from './db.js';

const KEYS_KEY = 'push_keys';
const SUBS_KEY = 'push_subs';

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

/* ---------- VAPID 密钥 ---------- */
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
  const raw = Buffer.concat([Buffer.from([0x04]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  keysCache = { publicKey: b64url(raw), privateKey: priv.d, x: pub.x, y: pub.y };
  await writeSetting(KEYS_KEY, keysCache);
  return keysCache;
}

/* ---------- VAPID 头 ---------- */
function vapidAuth(endpoint, keys) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: 'mailto:bunny@example.com'
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: keys.x, y: keys.y },
    format: 'jwk'
  });
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64url(sig)}, k=${keys.publicKey}`;
}

/* ---------- HKDF ---------- */
function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const okm = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return okm.subarray(0, length);
}

/* ---------- 加密 payload（RFC 8291，aes128gcm） ---------- */
function encryptPayload(payload, p256dhB64, authB64) {
  const uaPublic = Buffer.from(p256dhB64, 'base64url'); // 65 字节
  const authSecret = Buffer.from(authB64, 'base64url');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, authInfo, 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);

  return {
    body: Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]),
    asPublic
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
export async function notifyAll({ title = 'Elliott', body = '给你留了一句话', url = '/#chat', icon = '', tag = 'bunny-message' } = {}) {
  if (!dbReady) return { sent: 0 };
  const subs = await listSubscriptions();
  if (!subs.length) return { sent: 0 };

  const keys = await getKeys();
  const payload = JSON.stringify({ title, body, url, icon, tag });
  let sent = 0;
  const dead = [];

  for (const s of subs) {
    try {
      const headers = {
        TTL: '3600',
        Urgency: 'high',
        Authorization: vapidAuth(s.endpoint, keys)
      };

      let bodyBuf = null;
      if (s.keys?.p256dh && s.keys?.auth) {
        try {
          const enc = encryptPayload(payload, s.keys.p256dh, s.keys.auth);
          bodyBuf = enc.body;
          headers['Content-Encoding'] = 'aes128gcm';
          headers['Content-Type'] = 'application/octet-stream';
        } catch (e) {
          console.warn('[push] 加密失败，退回无内容推送：', e.message.slice(0, 60));
        }
      }

      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: bodyBuf ? { ...headers, 'Content-Length': String(bodyBuf.length) } : { ...headers, 'Content-Length': '0' },
        body: bodyBuf || undefined,
        signal: AbortSignal.timeout(10000)
      });

      if (res.ok) sent += 1;
      else if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
      else console.warn('[push] 发送失败', res.status, (await res.text()).slice(0, 100));
    } catch (e) {
      console.warn('[push] 网络失败', e.message.slice(0, 60));
    }
  }

  if (dead.length) await writeSetting(SUBS_KEY, subs.filter((s) => !dead.includes(s.endpoint)));
  return { sent, removed: dead.length };
}
