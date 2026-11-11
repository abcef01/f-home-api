/**
 * 书架：TXT / EPUB 导入 + 分章
 * ------------------------------------------------------------
 * 不需要任何第三方库：
 *   · ZIP 自己解（EPUB 就是个 zip）
 *   · GBK/Big5 用 Node 自带的 TextDecoder
 *
 * 解析结果存成 JSON 放在 Supabase Storage 里，元信息存 app_settings。
 * 这样书不会把数据库撑爆，换设备也能接着读。
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { supabase, dbReady } from './db.js';
import { callModel } from './llm.js';

const META_KEY = 'books';
const BUCKET = 'bh-books'; /* 私有桶：书不能公开可读 */
const DIR = 'books';

/* ============================================================
   1. 最小 ZIP 读取器
   ============================================================ */
function readZip(buf) {
  /* 找 EOCD（End of Central Directory）*/
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/epub');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lo = e.localOff;
      const nameLen = buf.readUInt16LE(lo + 26);
      const extraLen = buf.readUInt16LE(lo + 28);
      const start = lo + 30 + nameLen + extraLen;
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error('不支持的压缩方式：' + e.method);
    }
  };
}

/* ============================================================
   2. 文本清理
   ============================================================ */
function htmlToText(html) {
  return html
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============================================================
   3. TXT：编码探测 + 分章
   ============================================================ */
function decodeText(buf) {
  /* 先按 UTF-8 试；有替换字符就说明不是 */
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0) return { text: utf8, encoding: 'utf-8' };

  for (const enc of ['gbk', 'big5', 'utf-16le']) {
    try {
      const t = new TextDecoder(enc, { fatal: false }).decode(buf);
      const bad2 = (t.match(/\uFFFD/g) || []).length;
      if (bad2 < bad * 0.3) return { text: t, encoding: enc };
    } catch {
      /* 这个编码不支持就跳过 */
    }
  }
  return { text: utf8.replace(/\uFFFD/g, ''), encoding: 'utf-8?' };
}

const CHAPTER_RE = /^[ \t　]*(第[0-9一二三四五六七八九十百千零两]{1,6}[章节回卷篇话][^\n]{0,40}|Chapter[ \t]+\d+[^\n]{0,40}|(?:序章|楔子|尾声|后记|番外)[^\n]{0,40})[ \t　]*$/gm;

function splitChapters(text, fallbackTitle = '正文') {
  const marks = [];
  CHAPTER_RE.lastIndex = 0;
  let m;
  while ((m = CHAPTER_RE.exec(text))) marks.push({ index: m.index, title: m[0].trim() });

  if (marks.length < 2) {
    /* 没有明显章节：按长度切 */
    const size = 6000;
    const out = [];
    for (let i = 0; i < text.length; i += size) {
      out.push({ title: `${fallbackTitle} ${out.length + 1}`, text: text.slice(i, i + size) });
    }
    return out;
  }

  return marks.map((mk, i) => ({
    title: mk.title.slice(0, 60),
    text: text.slice(mk.index + mk.title.length, i + 1 < marks.length ? marks[i + 1].index : text.length).trim()
  }));
}

/* ============================================================
   4. EPUB
   ============================================================ */
function parseEpub(buf) {
  const zip = readZip(buf);

  /* 找 OPF */
  const container = zip.read('META-INF/container.xml');
  let opfPath = null;
  if (container) {
    const m = container.toString('utf8').match(/full-path="([^"]+)"/);
    if (m) opfPath = m[1];
  }
  if (!opfPath) {
    const guess = zip.names.find((n) => n.endsWith('.opf'));
    opfPath = guess || null;
  }
  if (!opfPath) throw new Error('EPUB 里找不到 opf');

  const opf = zip.read(opfPath)?.toString('utf8') || '';
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const title = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1]?.trim() || '未命名';
  const author = (opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1]?.trim() || '';

  /* manifest: id -> href */
  const items = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = (tag.match(/\bid="([^"]+)"/i) || [])[1];
    const href = (tag.match(/\bhref="([^"]+)"/i) || [])[1];
    const type = (tag.match(/\bmedia-type="([^"]+)"/i) || [])[1] || '';
    if (id && href) items.set(id, { href, type });
  }

  /* spine: 阅读顺序 */
  const order = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/gi)) {
    const it = items.get(m[1]);
    if (it) order.push(it);
  }
  if (!order.length) {
    /* 没有 spine 就按 xhtml 文件名排序 */
    for (const n of zip.names) if (/\.x?html?$/i.test(n)) order.push({ href: n.replace(baseDir, '') });
  }

  const chapters = [];
  for (const it of order) {
    const path = decodeURIComponent(baseDir + it.href);
    const raw = zip.read(path) || zip.read(path.replace(/^\.\//, ''));
    if (!raw) continue;

    const html = raw.toString('utf8');
    const text = htmlToText(html);
    if (!text) continue;

    const heading =
      (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1]?.replace(/<[^>]+>/g, '').trim() ||
      (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<[^>]+>/g, '').trim() ||
      `第 ${chapters.length + 1} 节`;

    const cleanText = text.startsWith(heading) ? text.slice(heading.length).trim() : text;
    chapters.push({ title: heading.slice(0, 60), text: cleanText });
  }

  if (!chapters.length) throw new Error('EPUB 里没有可读的正文');
  return { title, author, chapters };
}

/* ============================================================
   5. 书架
   ============================================================ */
async function readMeta() {
  if (!dbReady) return [];
  const { data } = await supabase.from('app_settings').select('value').eq('key', META_KEY).maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}

async function writeMeta(list) {
  await supabase.from('app_settings').upsert({ key: META_KEY, value: list, updated_at: new Date().toISOString() });
}

async function ensureBucket() {
  try {
    await supabase.storage.createBucket(BUCKET, { public: false });
  } catch {
    /* 已存在 */
  }
}

export async function listBooks() {
  return readMeta();
}

export async function importBook({ filename = 'book.txt', base64 }) {
  if (!dbReady) throw new Error('数据库未配置');
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('文件是空的');

  const lower = filename.toLowerCase();
  let parsed;

  if (lower.endsWith('.epub') || (buf[0] === 0x50 && buf[1] === 0x4b && lower.includes('epub'))) {
    parsed = parseEpub(buf);
  } else if (buf[0] === 0x50 && buf[1] === 0x4b) {
    /* 是 zip 但不是 epub：当 epub 试试 */
    parsed = parseEpub(buf);
  } else {
    const { text, encoding } = decodeText(buf);
    if (!text.trim()) throw new Error('读不到文字（可能是 PDF 或加密文件）');
    const clean = filename.replace(/\.[^.]+$/, '');
    parsed = { title: clean, author: '', chapters: splitChapters(text, clean), encoding };
  }

  const id = crypto.randomUUID().slice(0, 8);
  const meta = {
    id,
    title: (parsed.title || filename).slice(0, 80),
    author: (parsed.author || '').slice(0, 40),
    encoding: parsed.encoding || 'utf-8',
    chapters: parsed.chapters.length,
    chars: parsed.chapters.reduce((a, c) => a + c.text.length, 0),
    at: Date.now(),
    progress: { chapter: 0, updatedAt: Date.now() }
  };

  await ensureBucket();
  const payload = JSON.stringify({ id, ...meta, chapters: parsed.chapters });
  const up = await supabase.storage.from(BUCKET).upload(`${DIR}/${id}.json`, Buffer.from(payload, 'utf8'), {
    contentType: 'application/json',
    upsert: true
  });
  if (up.error) throw new Error('存书失败：' + up.error.message);

  const list = await readMeta();
  list.unshift(meta);
  await writeMeta(list);
  return meta;
}

export async function loadBook(id) {
  const { data, error } = await supabase.storage.from(BUCKET).download(`${DIR}/${id}.json`);
  if (error || !data) throw new Error('找不到这本书');
  const text = await data.text();
  return JSON.parse(text);
}

export async function getChapter(id, index) {
  const book = await loadBook(id);
  const i = Math.max(0, Math.min(book.chapters.length - 1, Number(index) || 0));
  return { index: i, total: book.chapters.length, ...book.chapters[i] };
}

export async function removeBook(id) {
  const list = await readMeta();
  await writeMeta(list.filter((x) => x.id !== id));
  await supabase.storage.from(BUCKET).remove([`${DIR}/${id}.json`, `${DIR}/${id}.marks.json`]);
  return { ok: true };
}

/* ---------- 批注与书签 ---------- */
async function readMarks(id) {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(`${DIR}/${id}.marks.json`);
    if (error || !data) return { annotations: [], bookmarks: [] };
    const j = JSON.parse(await data.text());
    return { annotations: j.annotations || [], bookmarks: j.bookmarks || [] };
  } catch {
    return { annotations: [], bookmarks: [] };
  }
}

async function writeMarks(id, marks) {
  const up = await supabase.storage
    .from(BUCKET)
    .upload(`${DIR}/${id}.marks.json`, Buffer.from(JSON.stringify(marks), 'utf8'), {
      contentType: 'application/json',
      upsert: true
    });
  if (up.error) throw new Error('存批注失败：' + up.error.message);
  return marks;
}

export async function getMarks(id) {
  return readMarks(id);
}

export async function addAnnotation(id, { chapter = 0, quote = '', note = '', who = 'me', replyTo = null }) {
  const marks = await readMarks(id);
  const a = {
    id: crypto.randomUUID().slice(0, 8),
    chapter: Number(chapter) || 0,
    who,
    replyTo,
    quote: String(quote || '').slice(0, 400),
    note: String(note || '').slice(0, 400),
    at: Date.now()
  };
  if (!a.quote && !a.note) throw new Error('没选中内容，也没写批注');
  marks.annotations.unshift(a);
  await writeMarks(id, marks);
  return a;
}

export async function removeAnnotation(id, aid) {
  const marks = await readMarks(id);
  marks.annotations = marks.annotations.filter((x) => x.id !== aid);
  await writeMarks(id, marks);
  return { ok: true };
}

export async function addBookmark(id, { chapter = 0, page = 0, label = '' }) {
  const marks = await readMarks(id);
  const b = {
    id: crypto.randomUUID().slice(0, 8),
    chapter: Number(chapter) || 0,
    page: Number(page) || 0,
    label: String(label || '').slice(0, 60),
    at: Date.now()
  };
  marks.bookmarks.unshift(b);
  await writeMarks(id, marks);
  return b;
}

export async function removeBookmark(id, bid) {
  const marks = await readMarks(id);
  marks.bookmarks = marks.bookmarks.filter((x) => x.id !== bid);
  await writeMarks(id, marks);
  return { ok: true };
}

/* 你在书上批了一句，他可能接一句 */
export async function maybeReplyAnnotation() {
  const list = await readMeta();
  if (!list.length) return null;

  const book = list[0];
  const marks = await readMarks(book.id);
  const now = Date.now();

  const mine = marks.annotations.filter(
    (a) => a.who === 'me' && now - a.at < 3 * 24 * 3600 * 1000 && now - a.at > 20 * 60 * 1000
  );
  const targets = mine.filter((a) => !marks.annotations.some((b2) => b2.who === 'ta' && b2.replyTo === a.id));
  if (!targets.length) return null;

  if (book.replyNextAt && now < book.replyNextAt) return null;
  if (Math.random() > 0.5) return null;

  const target = targets[targets.length - 1];
  let chapterText = '';
  try {
    const ch = await getChapter(book.id, target.chapter);
    chapterText = String(ch.text || '').slice(0, 900);
  } catch {
    /* 没正文也能回 */
  }

  try {
    const r = await callModel({
      target: 'memory',
      system:
        '你在读一本书，对方在页边写了批注。你接一句，像另一个人在同一页写下的铅笔字：' +
        '一到两句，二十到四十字，具体，口语。不要评价他的想法，不要总结。只输出这句。',
      messages: [
        {
          role: 'user',
          content:
            '书：《' + book.title + '》第 ' + (target.chapter + 1) + ' 章\n' +
            (chapterText ? '正文：' + chapterText + '\n' : '') +
            '他批注：' + (target.quote ? '「' + target.quote + '」' : '') + target.note
        }
      ],
      temperature: 0.9,
      maxTokens: 400
    });
    const note = String(r.content || '').trim().slice(0, 90);
    if (!note) return null;

    return await addAnnotation(book.id, {
      chapter: target.chapter,
      quote: '',
      note,
      who: 'ta',
      replyTo: target.id
    });
  } catch {
    return null;
  }
}

/* 他自己在书上留一句（心跳里偶发，同一章只留一次） */
export async function autoAnnotate() {
  const list = await readMeta();
  if (!list.length) return null;

  const book = list[0];
  const chapterIdx = book.progress?.chapter || 0;
  const marks = await readMarks(book.id);

  /* 这一章他留过了就不再留 */
  if (marks.annotations.some((a) => a.who === 'ta' && a.chapter === chapterIdx)) return null;

  let chapter;
  try {
    chapter = await getChapter(book.id, chapterIdx);
  } catch {
    return null;
  }

  const excerpt = String(chapter.text || '').slice(0, 1400);
  if (excerpt.length < 30) return null;

  try {
    const r = await callModel({
      target: 'memory',
      system:
        '你在读一本书，读到某一章，在页边留一句铅笔批注。' +
        '要求：一到两句，二十到四十字；说具体的（某个动作、某句话、某个细节），不要总结整章；' +
        '不要评价作者，不要用"作者想表达"这种话；像自言自语。只输出这句话。',
      messages: [{ role: 'user', content: `《${book.title}》第 ${chapterIdx + 1} 章：
${excerpt}` }],
      temperature: 0.9,
      maxTokens: 500
    });
    let note = String(r.content || '').trim().slice(0, 80);
    if (!note) {
      const r2 = await callModel({
        target: 'memory',
        system: '就这本书这一章写一句页边批注，二十到四十字，具体，口语。只输出这一句。',
        messages: [{ role: 'user', content: excerpt.slice(0, 800) }],
        temperature: 0.9,
        maxTokens: 400
      });
      note = String(r2.content || '').trim().slice(0, 80);
    }
    if (!note) return null;

    return await addAnnotation(book.id, {
      chapter: chapterIdx,
      quote: '',
      note,
      who: 'ta'
    });
  } catch (err) {
    console.error('[books] 批注失败：', err.message.slice(0, 120));
    return null;
  }
}

/* ---------- 进度：章 + 页 ---------- */
export async function saveProgress(id, { chapter = 0, page = 0, percent = 0 }) {
  const list = await readMeta();
  const b = list.find((x) => x.id === id);
  if (!b) throw new Error('没有这本书');
  b.progress = {
    chapter: Math.max(0, Number(chapter) || 0),
    page: Math.max(0, Number(page) || 0),
    percent: Math.min(1, Math.max(0, Number(percent) || 0)),
    updatedAt: Date.now()
  };
  await writeMeta(list);
  return b;
}

/* 给聊天用：他现在读到哪 */
export async function booksPromptBlock() {
  const list = await readMeta();
  if (!list.length) return '';
  const latest = list[0];

  const chapterNo = (latest.progress?.chapter || 0) + 1;
  const lines = [
    `他在读《${latest.title}》${latest.author ? '（' + latest.author + '）' : ''}，读到第 ${chapterNo}/${latest.chapters} 章。`
  ];

  try {
    const marks = await readMarks(latest.id);
    const recent = (marks.annotations || []).slice(0, 4);
    if (recent.length) {
      lines.push('他最近在这本书里做过这些批注：');
      for (const a of recent) {
        const ch = (a.chapter || 0) + 1;
        lines.push(`- 第 ${ch} 章｜选中「${a.quote || ''}」${a.note ? '，写下：' + a.note : ''}`);
      }
      lines.push('你可以顺着这些批注聊，但别一条条点评，也别问"你为什么这么写"。');
    }
  } catch {
    /* 没批注就算了 */
  }

  return '\n\n【书架】\n' + lines.join('\n');
}
