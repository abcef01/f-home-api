/**
 * 它知道你在哪、几点、外面什么天
 * ------------------------------------------------------------
 * 时间：自己算，不花钱
 * 位置：浏览器定位 → 反查城市名（免 key）
 * 天气：Open-Meteo（免 key，实测可用）
 *
 * 都不需要你去注册任何服务。
 */
import { supabase, dbReady } from './db.js';

const LOC_KEY = 'location';
const WX_KEY = 'weather';
const WX_TTL = 20 * 60 * 1000; // 天气 20 分钟缓存，别每次都打接口

/* ---------- 时间 ---------- */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function timeParts() {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '';

  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));

  let phase = '深夜';
  if (hour >= 5 && hour < 9) phase = '早上';
  else if (hour >= 9 && hour < 12) phase = '上午';
  else if (hour >= 12 && hour < 14) phase = '中午';
  else if (hour >= 14 && hour < 18) phase = '下午';
  else if (hour >= 18 && hour < 23) phase = '晚上';

  const d = new Date();
  const dayIdx = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' })
      .format(d)
      .replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, (m) => ({ Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' })[m])
  );

  return {
    hour,
    minute,
    phase,
    weekday: WEEKDAYS[dayIdx] || '',
    date: `${get('year')} 年 ${get('month')} 月 ${get('day')} 日`,
    clock: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

export async function timePromptBlock() {
  const t = timeParts();
  return `\n\n【现在是】${t.date} ${t.weekday}，${t.clock}（${t.phase}）。`;
}

/* ---------- 位置 ---------- */
export async function getLocation() {
  if (!dbReady) return null;
  const { data } = await supabase.from('app_settings').select('value').eq('key', LOC_KEY).maybeSingle();
  return data?.value || null;
}

async function saveLocation(loc) {
  await supabase.from('app_settings').upsert({ key: LOC_KEY, value: loc, updated_at: new Date().toISOString() });
}

/**
 * 反查位置：优先 Photon（能到具体店/学校），失败退回 BigDataCloud（只有城市区）
 */
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1`, {
      headers: { 'User-Agent': 'BunnyHome/1.0' },
      signal: AbortSignal.timeout(12000)
    });
    if (r.ok) {
      const j = await r.json();
      const p = j.features?.[0]?.properties;
      if (p) {
        return {
          poi: p.name || '',
          street: p.street || '',
          district: p.district || p.locality || '',
          city: p.city || p.county || '',
          region: p.state || ''
        };
      }
    }
  } catch {
    /* 换下一个 */
  }

  try {
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (r.ok) {
      const j = await r.json();
      return { city: j.city || '', district: j.locality || '', region: j.principalSubdivision || '' };
    }
  } catch {
    /* 全挂了就只留坐标 */
  }
  return {};
}

async function geocodeCity(name) {
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh`,
    { signal: AbortSignal.timeout(12000) }
  );
  if (!r.ok) throw new Error('找不到这个地名');
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) throw new Error('找不到这个地方');
  return { lat: hit.latitude, lon: hit.longitude, city: hit.name, region: hit.admin1 || '' };
}

export async function setLocation({ lat, lon, city }) {
  let loc;
  if (typeof lat === 'number' && typeof lon === 'number') {
    const g = await reverseGeocode(lat, lon);
    /* 只留四舍五入到 3 位（约 100 米）的坐标，够查天气，也不至于精确到门口 */
    loc = {
      lat: Math.round(lat * 1000) / 1000,
      lon: Math.round(lon * 1000) / 1000,
      city: g.city || city || '',
      district: g.district || '',
      street: g.street || '',
      poi: g.poi || '',
      region: g.region || '',
      at: Date.now()
    };
  } else if (city) {
    const g = await geocodeCity(city);
    loc = { ...g, at: Date.now() };
  } else {
    throw new Error('要么给坐标，要么给城市名');
  }
  await saveLocation(loc);
  /* 位置变了，天气缓存作废 */
  await supabase.from('app_settings').delete().eq('key', WX_KEY);
  return loc;
}

/* ---------- 天气 ---------- */
const WEATHER_CN = {
  0: '晴', 1: '基本晴', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴'
};

export async function getWeather(force = false) {
  if (!dbReady) return null;
  const loc = await getLocation();
  if (!loc) return null;

  if (!force) {
    const { data } = await supabase.from('app_settings').select('value').eq('key', WX_KEY).maybeSingle();
    const cached = data?.value;
    if (cached && Date.now() - cached.at < WX_TTL) return cached;
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
      `&timezone=Asia%2FShanghai&forecast_days=3`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('天气接口 ' + r.status);
    const j = await r.json();

    const wx = {
      at: Date.now(),
      city: loc.city,
      now: {
        temp: Math.round(j.current?.temperature_2m ?? 0),
        feels: Math.round(j.current?.apparent_temperature ?? 0),
        humidity: j.current?.relative_humidity_2m ?? null,
        text: WEATHER_CN[j.current?.weather_code] || '说不清',
        isDay: j.current?.is_day === 1
      },
      days: (j.daily?.time || []).map((d, i) => ({
        date: d,
        text: WEATHER_CN[j.daily.weather_code[i]] || '',
        max: Math.round(j.daily.temperature_2m_max[i]),
        min: Math.round(j.daily.temperature_2m_min[i]),
        rain: j.daily.precipitation_probability_max?.[i] ?? null
      })),
      sunrise: j.daily?.sunrise?.[0]?.slice(11) || null,
      sunset: j.daily?.sunset?.[0]?.slice(11) || null
    };

    await supabase.from('app_settings').upsert({ key: WX_KEY, value: wx, updated_at: new Date().toISOString() });
    return wx;
  } catch (e) {
    console.warn('[weather]', e.message.slice(0, 80));
    return null;
  }
}

export async function weatherPromptBlock() {
  const wx = await getWeather().catch(() => null);
  if (!wx) return '';

  const today = wx.days[0];
  const tomorrow = wx.days[1];
  const bits = [
    `${wx.city || '对方那边'}现在 ${wx.now.temp}°C（体感 ${wx.now.feels}°C），${wx.now.text}`,
    today ? `今天 ${today.min}~${today.max}°C` : '',
    today && today.rain > 30 ? `今天降雨概率 ${today.rain}%` : '',
    tomorrow ? `明天 ${tomorrow.min}~${tomorrow.max}°C，${tomorrow.text}${tomorrow.rain > 30 ? `，降雨 ${tomorrow.rain}%` : ''}` : ''
  ].filter(Boolean);

  return `\n\n【那边的天气】${bits.join('；')}。\n只在真的相关时说（他提到出门、穿衣、天气、或者正好在下雨），别每次都念一遍。`;
}

/* 它在哪：只用来让对话有地方感，不追踪 */
/* 它想知道你在哪（一条只触发一次请求的标记） */
export const WHERE_RULE = `\n\n如果你确实想知道对方此刻在哪（不是客气，是真的想知道），另起一段只写 [[where]]，系统会去取一次他的位置。这个不要常用。`;

export async function placePromptBlock() {
  const loc = await getLocation();
  if (!loc) return '';

  const parts = [];
  if (loc.poi) parts.push(loc.poi);
  if (loc.street && loc.street !== loc.poi) parts.push(loc.street + ' 附近');
  if (loc.district && loc.district !== loc.street) parts.push(loc.district);
  if (loc.city && loc.city !== loc.district) parts.push(loc.city);
  if (!parts.length) return '';

  const mins = Math.round((Date.now() - (loc.at || 0)) / 60000);
  const ago = mins < 5 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
  const stale = mins > 120;

  return `\n\n【他最后一次被定位到】${parts.join('，')}（${ago}）。${
    stale ? '已经有一段时间了，他可能不在那儿——合适的时候可以问一句，不要直接断定。' : ''
  }\n只有当他说到自己在哪、或者话题自然相关时才提，不要没话找话。`;
}
