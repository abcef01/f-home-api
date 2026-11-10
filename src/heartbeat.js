/**
 * 心跳与情绪：把「积温」引擎接进 Bunny's Home
 * ------------------------------------------------------------
 * 引擎本身是纯数学（原作者 ClaraShafiq，MIT，见 vendor/jiwen.cjs）：
 * 五轴数值随分钟漂移，到阈值给出 contact / find_activity / observation。
 * 这里只做三件事：存状态、按真实时间补算、把数值翻译成人话喂给模型。
 */
import jiwenPkg from './vendor/jiwen.cjs';
import { supabase, dbReady } from './db.js';

const { createJiwen } = jiwenPkg;

const STATE_KEY = 'jiwen';
const TICK_KEY = 'jiwen_tick';

/* 中性起点：Elliott 平常是温和偏安静的，不是默认的“低落” */
const NEUTRAL_STATE = {
  connection: 0.12,
  pride: 0.22,
  valence: 0.15,
  arousal: 0,
  immersion: 0,
  lastActivity: null,
  lastChatMessageId: null,
  lastBotMessageId: null,
  userStatus: 'active'
};

let engine = null;

async function readSetting(key) {
  if (!dbReady) return null;
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

async function writeSetting(key, value) {
  if (!dbReady) return;
  await supabase.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() });
}

export function getEngine() {
  if (engine) return engine;
  engine = createJiwen({
    onLoad: async () => {
      const saved = await readSetting(STATE_KEY);
      return saved && typeof saved === 'object' ? { ...NEUTRAL_STATE, ...saved } : { ...NEUTRAL_STATE };
    },
    onSave: async (s) => writeSetting(STATE_KEY, s),
    connectionRateFn: () => 0.012, // 每分钟涨 0.012：一小时约 0.7
    persona: { subjectName: '你', selfName: 'Elliott', subjectPronoun: '你' },
    rates: {
      accelDelay: 25, // 25 分钟内线性，之后加速
      connectionAccel: 0.2,
      valenceConnectBoost: 1.35,
      valenceConnectBoostThreshold: -0.2,
      valenceConnectDampen: 0.5,
      valenceConnectDampenThreshold: -0.45,
      valenceLockThreshold: 0.35,
      valenceLockFactor: 0.35,
      arousalConnectionRiseThreshold: 0.4,
      arousalConnectionRiseRate: 0.004,
      prideDefendThreshold: 0.45,
      prideDefendTarget: 0.62,
      prideDefendRate: 0.004,
      prideErosionRate: 0.004,
      activityConnectionRelief: 0.12
    }
  });
  return engine;
}

/* 按真实经过的时间补算（后端睡着时也不会漏算） */
export async function runHeartbeat() {
  const e = getEngine();
  await e.load();

  const now = Date.now();
  const last = Number(await readSetting(TICK_KEY)) || 0;
  const minutes = last ? Math.min(720, (now - last) / 60000) : 1;
  await writeSetting(TICK_KEY, now);

  const actions = minutes >= 1 ? await e.tick(minutes) : [];
  await e.save();
  const state = await e.getState();
  return { actions, state, minutes: Math.round(minutes) };
}

/* 把当前状态塞进对话的 system 里 */
export async function statePromptBlock() {
  const e = getEngine();
  await e.load();
  const ctx = e.getPromptContext();
  const guide = e.getStyleGuidance ? e.getStyleGuidance() : '';
  return `\n\n【你此刻的内在状态】\n${ctx}${guide ? `\n${guide}` : ''}`;
}

/* 对方说话了：连接需求下降（引擎规定开口不是终点，回复才是） */
export async function noteUserReply() {
  const e = getEngine();
  await e.load();
  e.applyDelta({ connection: -0.28, arousal: -0.04 });
  await e.save();
}

/* 看一眼今天的状态，给前端展示 */
export async function stateSummary() {
  const e = getEngine();
  await e.load();
  const s = await e.getState();
  return {
    connection: Number(s.connection?.toFixed(2)),
    pride: Number(s.pride?.toFixed(2)),
    valence: Number(s.valence?.toFixed(2)),
    arousal: Number(s.arousal?.toFixed(2)),
    immersion: Number(s.immersion?.toFixed(2)),
    summary: e.getStateSummary()
  };
}
