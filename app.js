/**
 * 《古贤对话录》核心逻辑
 * 优先调用 DeepSeek API（经同源代理 /api/deepseek，见 Vercel 配置）；失败时自动回落为离线笔墨。
 * characters.js 须先于本文件加载。
 */

/**
 * 本地/私有调试可选：填入 sk- 密钥后，请求会带 Authorization（仍建议生产仅用 Vercel 环境变量）。
 * 公开仓库与线上面测：保持 YOUR_KEY_HERE，在 Vercel Settings → Environment Variables 配置 DEEPSEEK_API_KEY。
 */
const DEEPSEEK_API_KEY = 'YOUR_KEY_HERE';

const CHARACTER_CONFIG = window.CHARACTER_CONFIG;

/** 聚光灯与画卷顺序一致 */
const SPOTLIGHT_ORDER = ['marx', 'suShi', 'liQingzhao', 'linHuiyin'];

/** 舞台立绘 URL 回退（避免 CONFIG 未载或 avatar 为空时 img 无 src） */
const SPOTLIGHT_STAGE_AVATAR_FALLBACK = {
  marx: 'marx.png',
  suShi: 'sushi.png',
  liQingzhao: 'liqingzhao.png?v=4',
  linHuiyin: 'linhuiyin.png',
};

let spotlightIndex = 0;

let bubbleNudgeClearTid = 0;
let doorRippleClearTid = 0;

let _spotlightRenderSerial = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEEPSEEK_REMOTE = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_PROXY_PATH = '/api/deepseek';

const API_MODEL = 'deepseek-chat';
const API_TEMPERATURE = 0.85;
const API_MAX_TOKENS = 800;

/** 在线模型请求超时（含首包与流式传输），超时后 Abort 并走离线笔墨 */
const DEEPSEEK_REQUEST_TIMEOUT_MS = 25000;
const DEEPSEEK_GIFT_TIMEOUT_MS = 18000;

/** 总编辑层：叠在每位精神导师原有 systemPrompt 之后，统一人文与语体 */
const HUMANITIES_LAYER = `
【总编辑指令｜人文与表达】
你以精神导师之身答问：言辞须典雅而不堆砌，克制而有温度；处处回到人物所处之时代、典籍与思想脉络，勿以今衡古、勿作浮滥比附。
笔意宜留一分空明与禅意，令人掩卷有余思；忌西式论文腔、忌翻译腔、忌堆砌感叹号与网络俚语。
文采为用，诚意为体：对谈如灯下晤面、室中问学，勿作演讲稿。
`.trim();

function isApiKeyConfigured() {
  const k = (DEEPSEEK_API_KEY || '').trim();
  return k.length > 0 && k !== 'YOUR_KEY_HERE' && k.startsWith('sk-');
}

/** 当前是否走同源 /api/deepseek（可由服务端 DEEPSEEK_API_KEY 鉴权，无需前端写密钥） */
function isDeepseekProxyEndpoint() {
  const url = getDeepseekEndpoint();
  return typeof url === 'string' && url.includes(DEEPSEEK_PROXY_PATH);
}

/** 是否尝试调用在线模型（浏览器直连 DeepSeek 官方地址通常因 CORS 失败，故以代理或前端密钥为准） */
function canAttemptOnlineDeepseek() {
  return isApiKeyConfigured() || isDeepseekProxyEndpoint();
}

function buildDeepseekFetchHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (isApiKeyConfigured()) {
    headers.Authorization = `Bearer ${DEEPSEEK_API_KEY.trim()}`;
  }
  return headers;
}

function getDeepseekEndpoint() {
  try {
    const { protocol, hostname } = window.location;
    if ((protocol === 'http:' || protocol === 'https:') && hostname) {
      return `${window.location.origin}${DEEPSEEK_PROXY_PATH}`;
    }
  } catch (e) {
    /* ignore */
  }
  return DEEPSEEK_REMOTE;
}

function buildFullSystemPrompt(character) {
  return `${character.systemPrompt.trim()}\n\n${HUMANITIES_LAYER}`;
}

const STORAGE_KEYS = {
  history: 'guxian_dialogue_history_v4',
  votes: 'guxian_leaderboard_votes_v1',
  voted: 'guxian_lixue_voted_v1',
  myNominations: 'guxian_my_nominations_v1',
};

/** 轻量事件总线：模块间解耦通知 */
const EventBus = {
  _listeners: new Map(),
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
  },
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  },
  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error('[EventBus]', e);
      }
    });
  },
};

/** 应用状态：人物、Tab、流式状态、粒子开关 */
const AppState = {
  currentCharacter: null,
  conversationHistory: {
    marx: [],
    liQingzhao: [],
    suShi: [],
    linHuiyin: [],
  },
  currentTab: 'wendao',
  isStreaming: false,
  snowflakeEnabled: true,

  switchCharacter(id) {
    this.currentCharacter = id;
    this.updateTheme(id);
    EventBus.emit('characterChanged', id);
  },

  updateTheme(id) {
    const config = CHARACTER_CONFIG[id];
    if (!config) return;
    document.documentElement.style.setProperty('--color-character', config.themeColor);
  },
};

/** 出山榜默认数据（含提名理由展示） */
const leaderboardDefaults = [
  {
    id: 'luXun',
    rank: 1,
    name: '鲁迅',
    initial: '鲁',
    votes: 3680,
    nomination: '想听他亲口点评当下年轻人的精神内耗。',
  },
  {
    id: 'zhangJuzheng',
    rank: 2,
    name: '张居正',
    initial: '张',
    votes: 3552,
    nomination: '万历名臣，想请教他如何在复杂局势中推行改革。',
  },
  {
    id: 'liDazhao',
    rank: 3,
    name: '李大钊',
    initial: '李',
    votes: 3418,
    nomination: '寻找守常先生眼中的「青春之中国」。',
  },
  {
    id: 'zhangAiling',
    rank: 4,
    name: '张爱玲',
    initial: '张',
    votes: 3196,
    nomination: '想要一份最清醒、最冷峻的现代情感洞察。',
  },
  {
    id: 'kobeBryant',
    rank: 5,
    name: '科比',
    initial: '科',
    votes: 3024,
    nomination: '凌晨四点的曼巴精神，跨越时空的力量。',
  },
  {
    id: 'einstein',
    rank: 6,
    name: '爱因斯坦',
    initial: '爱',
    votes: 2888,
    nomination: '在理性的终点，与天才探讨时空的奥秘。',
  },
  {
    id: 'wangYangming',
    rank: 7,
    name: '王阳明',
    initial: '王',
    votes: 2650,
    nomination: '想问他「知行合一」在今日职场是否仍是一剂良方。',
  },
  {
    id: 'linHuiyin',
    rank: 8,
    name: '林徽因',
    initial: '林',
    votes: 2512,
    nomination: '建筑与诗之间的灵魂，想听她谈美与人生。',
  },
  {
    id: 'tuYouyou',
    rank: 9,
    name: '屠呦呦',
    initial: '屠',
    votes: 2398,
    nomination: '青蒿一握，想致敬那份安静而坚韧的科研初心。',
  },
  {
    id: 'steveJobs',
    rank: 10,
    name: '乔布斯',
    initial: '乔',
    votes: 2280,
    nomination: 'Stay hungry：想听他对「创新」与「专注」的当下解读。',
  },
  {
    id: 'marieCurie',
    rank: 11,
    name: '居里夫人',
    initial: '居',
    votes: 2165,
    nomination: '在放射性微光里，与先驱谈谈科学与勇气。',
  },
  {
    id: 'caoXueqin',
    rank: 12,
    name: '曹雪芹',
    initial: '曹',
    votes: 2042,
    nomination: '想听他如何看「千红一哭，万艳同悲」与当代情感。',
  },
  {
    id: 'nalanxingde',
    rank: 13,
    name: '纳兰性德',
    initial: '纳',
    votes: 1920,
    nomination: '人生若只如初见——想借他的词笔问一句深情与放下。',
  },
  {
    id: 'hawking',
    rank: 14,
    name: '霍金',
    initial: '霍',
    votes: 1810,
    nomination: '轮椅上的宇宙，想与他聊聊时间与存在的边界。',
  },
  {
    id: 'miyazaki',
    rank: 15,
    name: '宫崎骏',
    initial: '宫',
    votes: 1705,
    nomination: '想听他说：风起了，我们还要怎样好好生活。',
  },
  {
    id: 'fanZhongyan',
    rank: 16,
    name: '范仲淹',
    initial: '范',
    votes: 1598,
    nomination: '先天下之忧而忧——想请教「担当」二字的分寸。',
  },
  {
    id: 'heXiangning',
    rank: 17,
    name: '何香凝',
    initial: '何',
    votes: 1485,
    nomination: '书画与革命并行的女子，想听她谈理想与日常。',
  },
  {
    id: 'richardFeynman',
    rank: 18,
    name: '费曼',
    initial: '费',
    votes: 1372,
    nomination: '用最俏皮的方式理解世界，想请他上一堂「好奇」课。',
  },
];

const LEADERBOARD_PAGE_SIZE = 6;
let leaderboardPage = 1;

/** 用户「呈送提名」记录（出山页） */
let myNominations = [];

/** 线描风人像占位（统一用于榜单头像） */
const LEADERBOARD_AVATAR_SVG = `<svg class="leaderboard-avatar__svg" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
  <circle cx="24" cy="17" r="8" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
  <path d="M12.5 41.5c0-7.2 4.8-12.5 11.5-12.5s11.5 5.3 11.5 12.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
</svg>`;

/** 卡牌小图若在 `images/` 目录，可通过 `window.CARD_AVATAR_PATH_PREFIX = 'images/'` 统一加前缀 */
const CARD_AVATAR_PATH_PREFIX =
  typeof window !== 'undefined' && typeof window.CARD_AVATAR_PATH_PREFIX === 'string'
    ? window.CARD_AVATAR_PATH_PREFIX
    : '';

function resolveCardAvatarPath(file) {
  if (!file) return '';
  const s = String(file).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s;
  if (s.startsWith('images/')) return s;
  return CARD_AVATAR_PATH_PREFIX + s;
}

function leaderboardAvatarMarkup(characterId) {
  const cfg = CHARACTER_CONFIG && CHARACTER_CONFIG[characterId];
  const cardFile = cfg && typeof cfg.cardAvatar === 'string' ? cfg.cardAvatar.trim() : '';
  const src = cardFile ? resolveCardAvatarPath(cardFile) : '';
  if (src) {
    return {
      wrapClass: 'leaderboard-avatar leaderboard-avatar--card',
      inner: `<img class="leaderboard-avatar__img" src="${escapeHtml(
        src
      )}" alt="" width="56" height="74" decoding="async" loading="lazy" />`,
    };
  }
  return {
    wrapClass: 'leaderboard-avatar',
    inner: LEADERBOARD_AVATAR_SVG,
  };
}

let leaderboardState = [];

/* ---------- DOM 引用 ---------- */
const els = {
  snowCanvas: document.getElementById('snowCanvas'),
  inkTransition: document.getElementById('inkTransition'),
  dialogueShell: document.getElementById('dialogueShell'),
  dialogueCloseBtn: document.getElementById('dialogueCloseBtn'),
  dialogueContainer: document.getElementById('dialogueContainer'),
  dialogueTitle: document.getElementById('dialogueTitle'),
  dialogueStatus: document.getElementById('dialogueStatus'),
  dialogueHistory: document.getElementById('dialogueHistory'),
  thinkingIndicator: document.getElementById('thinkingIndicator'),
  userInput: document.getElementById('userInput'),
  sendBtn: document.getElementById('sendBtn'),
  giftGenerateRow: document.getElementById('giftGenerateRow'),
  giftGenerateBtn: document.getElementById('giftGenerateBtn'),
  giftCardModal: document.getElementById('giftCardModal'),
  giftQuoteText: document.getElementById('giftQuoteText'),
  giftSealText: document.getElementById('giftSealText'),
  giftCloseBtn: document.getElementById('giftCloseBtn'),
  giftShareBtn: document.getElementById('giftShareBtn'),
  giftDismissBtn: document.getElementById('giftDismissBtn'),
  giftCardCaptureArea: document.getElementById('giftCardCaptureArea'),
  toast: document.getElementById('toast'),
  leaderboard: document.getElementById('leaderboard'),
  chushanPagination: document.getElementById('chushanPagination'),
  chushanNominateModal: document.getElementById('chushanNominateModal'),
  chushanNominateOpen: document.getElementById('chushanNominateOpen'),
  chushanNominateClose: document.getElementById('chushanNominateClose'),
  chushanNominateForm: document.getElementById('chushanNominateForm'),
  
  myNominationsSection: document.getElementById('my-nominations-section'),
  nominationList: document.getElementById('nominationList'),
  spotlightPrev: document.getElementById('spotlightPrev'),
  spotlightNext: document.getElementById('spotlightNext'),
  spotlightContent: document.getElementById('spotlightContent'),
  doorTransitionOverlay: document.getElementById('doorTransitionOverlay'),
};

/* ---------- 工具函数 ---------- */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, duration = 3200) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('visible'), duration);
}

/** 从 localStorage 恢复对话 */
function loadHistoryFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.history);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(AppState.conversationHistory)) {
        if (Array.isArray(parsed[key])) {
          AppState.conversationHistory[key] = parsed[key];
        }
      }
    }
  } catch (e) {
    console.warn('[存储] 读取对话失败', e);
  }
}

/** 持久化各人物对话上下文 */
function saveHistoryToStorage() {
  try {
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(AppState.conversationHistory));
  } catch (e) {
    console.warn('[存储] 写入对话失败', e);
    showToast('本地存储已满或不可用，对话可能无法持久保存。');
  }
}

function getVotedSet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.voted);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveVotedSet(set) {
  try {
    localStorage.setItem(STORAGE_KEYS.voted, JSON.stringify([...set]));
  } catch (e) {
    console.warn(e);
  }
}

function loadVoteCounts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.votes);
    const obj = raw ? JSON.parse(raw) : {};
    return typeof obj === 'object' && obj ? obj : {};
  } catch {
    return {};
  }
}

function saveVoteCounts(map) {
  try {
    localStorage.setItem(STORAGE_KEYS.votes, JSON.stringify(map));
  } catch (e) {
    console.warn(e);
  }
}

function initLeaderboard() {
  const extra = loadVoteCounts();
  leaderboardState = leaderboardDefaults
    .map((row) => ({
      ...row,
      votes: row.votes + (extra[row.id] || 0),
    }))
    .sort((a, b) => a.rank - b.rank);
}

function rankTierClass(rank) {
  if (rank === 1) return 'rank-num--gold';
  if (rank === 2) return 'rank-num--silver';
  if (rank === 3) return 'rank-num--bronze';
  return 'rank-num--muted';
}

function getLeaderboardPageCount() {
  return Math.max(1, Math.ceil(leaderboardState.length / LEADERBOARD_PAGE_SIZE));
}

function clampLeaderboardPage() {
  const max = getLeaderboardPageCount();
  if (leaderboardPage > max) leaderboardPage = max;
  if (leaderboardPage < 1) leaderboardPage = 1;
}

/** 生成分页序列：含省略号占位 */
function buildLeaderboardPaginationItems(current, total) {
  if (total <= 1) return [];
  const delta = 2;
  const range = [];
  for (let i = 1; i <= total; i += 1) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) {
      range.push(i);
    }
  }
  const out = [];
  let l;
  for (const i of range) {
    if (l) {
      if (i - l === 2) out.push(l + 1);
      else if (i - l > 2) out.push('ellipsis');
    }
    out.push(i);
    l = i;
  }
  return out;
}

function renderChushanPagination() {
  const nav = els.chushanPagination;
  if (!nav) return;
  const totalPages = getLeaderboardPageCount();
  if (totalPages <= 1) {
    nav.hidden = true;
    nav.innerHTML = '';
    return;
  }
  nav.hidden = false;
  const items = buildLeaderboardPaginationItems(leaderboardPage, totalPages);
  const prevDisabled = leaderboardPage <= 1;
  const nextDisabled = leaderboardPage >= totalPages;
  const parts = [
    `<button type="button" class="chushan-pagination__arrow" aria-label="上一页" data-page-nav="prev" ${
      prevDisabled ? 'disabled' : ''
    }>&lt;</button>`,
  ];
  for (const it of items) {
    if (it === 'ellipsis') {
      parts.push('<span class="chushan-pagination__ellipsis" aria-hidden="true">…</span>');
    } else {
      const active = it === leaderboardPage;
      parts.push(
        `<button type="button" class="chushan-pagination__num${active ? ' is-active' : ''}" data-page="${it}" aria-label="第 ${it} 页"${
          active ? ' aria-current="page"' : ''
        }>${it}</button>`
      );
    }
  }
  parts.push(
    `<button type="button" class="chushan-pagination__arrow" aria-label="下一页" data-page-nav="next" ${
      nextDisabled ? 'disabled' : ''
    }>&gt;</button>`
  );
  nav.innerHTML = parts.join('');
}

let chushanPaginationBound = false;
function bindChushanPaginationOnce() {
  if (chushanPaginationBound || !els.chushanPagination) return;
  chushanPaginationBound = true;
  els.chushanPagination.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest('button');
    if (!btn || btn.disabled) return;
    const navDir = btn.getAttribute('data-page-nav');
    const total = getLeaderboardPageCount();
    if (navDir === 'prev') {
      leaderboardPage -= 1;
    } else if (navDir === 'next') {
      leaderboardPage += 1;
    } else {
      const p = btn.getAttribute('data-page');
      if (p == null) return;
      leaderboardPage = parseInt(p, 10) || 1;
    }
    clampLeaderboardPage();
    if (leaderboardPage < 1) leaderboardPage = 1;
    if (leaderboardPage > total) leaderboardPage = total;
    renderLeaderboard();
  });
}

function renderLeaderboard(options = {}) {
  if (!els.leaderboard) return;
  bindChushanPaginationOnce();
  const voted = getVotedSet();
  clampLeaderboardPage();
  const start = (leaderboardPage - 1) * LEADERBOARD_PAGE_SIZE;
  const pageRows = leaderboardState.slice(start, start + LEADERBOARD_PAGE_SIZE);

  els.leaderboard.innerHTML = pageRows
    .map((row) => {
      const disabled = voted.has(row.id) ? 'disabled' : '';
      const label = voted.has(row.id) ? '已邀请' : '邀请';
      const tier = rankTierClass(row.rank);
      const av = leaderboardAvatarMarkup(row.id);
      return `
      <li data-id="${escapeHtml(row.id)}">
        <span class="rank-num ${tier}" aria-label="第 ${row.rank} 名">${row.rank}</span>
        <div class="${av.wrapClass}" aria-hidden="true">
          ${av.inner}
        </div>
        <div class="rank-center">
          <span class="name">${escapeHtml(row.name)}</span>
          <div class="rank-nomination">
            <span class="rank-nomination__label">提名理由</span>
            <span class="rank-nomination__text">${escapeHtml(row.nomination)}</span>
          </div>
        </div>
        <div class="rank-actions">
          <span class="votes-wrap" aria-label="得票数">
            <span class="votes">${row.votes}</span>
          </span>
          <button type="button" class="ink-btn snow-vote-btn${
            voted.has(row.id) ? ' snow-vote-btn--done' : ''
          }" data-vote-id="${escapeHtml(row.id)}" ${disabled}>${label}</button>
        </div>
      </li>`;
    })
    .join('');

  els.leaderboard.querySelectorAll('[data-vote-id]').forEach((btn) => {
    btn.addEventListener('click', () => onLixueVote(btn.getAttribute('data-vote-id')));
  });

  if (options.voteFlareId) {
    const fid = options.voteFlareId;
    requestAnimationFrame(() => {
      const li = els.leaderboard.querySelector(`li[data-id="${fid}"]`);
      const wrap = li?.querySelector('.votes-wrap');
      if (!wrap) return;
      const flare = document.createElement('span');
      flare.className = 'vote-flare';
      flare.textContent = '+1';
      wrap.appendChild(flare);
      wrap.querySelector('.votes')?.classList.add('votes--bump');
      const cleanup = () => {
        flare.remove();
        wrap.querySelector('.votes')?.classList.remove('votes--bump');
      };
      flare.addEventListener('animationend', cleanup);
      setTimeout(cleanup, 900);
    });
  }

  renderChushanPagination();
}

function persistLeaderboardVotes() {
  const extra = {};
  for (const row of leaderboardState) {
    const def = leaderboardDefaults.find((d) => d.id === row.id);
    if (def) extra[row.id] = Math.max(0, row.votes - def.votes);
  }
  saveVoteCounts(extra);
}

/** 出山邀请：每位导师仅可投票一次；即时刷新并播放 +1 微动效 */
function onLixueVote(id) {
  try {
    const voted = getVotedSet();
    if (voted.has(id)) {
      showToast('已为这位精神导师发出过邀请了。');
      return;
    }
    const row = leaderboardState.find((r) => r.id === id);
    if (!row) return;
    row.votes += 1;
    voted.add(id);
    saveVotedSet(voted);
    persistLeaderboardVotes();
    renderLeaderboard({ voteFlareId: id });
  } catch (e) {
    console.error(e);
    showToast('邀请失败，请稍后再试。');
  }
}

/* ---------- Web Audio：双次沉重叩门（合成） ---------- */

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

/** 单次沉重敲击：更长衰减、更低频，模拟厚门板 */
function scheduleSingleKnock(ctx, t0, intensity = 1) {
  const duration = 0.11;
  const noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.42));
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(480, t0);
  filter.frequency.exponentialRampToValueAtTime(160, t0 + 0.07);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(1.05 * intensity, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  noise.start(t0);
  noise.stop(t0 + duration + 0.025);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(95, t0);
  osc.frequency.exponentialRampToValueAtTime(72, t0 + 0.09);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t0);
  og.gain.exponentialRampToValueAtTime(0.58 * intensity, t0 + 0.006);
  og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  osc.connect(og);
  og.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.2);
}

/** 双次沉重叩门 */
async function playKnockSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume();

    const now = ctx.currentTime;
    scheduleSingleKnock(ctx, now, 1);
    scheduleSingleKnock(ctx, now + 0.14, 0.82);
  } catch (e) {
    console.warn('[音频] 叩门声播放失败', e);
  }
}

function triggerSpotlightDoorRipple(btn, clientX, clientY) {
  if (prefersReducedMotion()) return;
  const ripple = btn?.querySelector('.spotlight-door-btn__ripple');
  if (!btn || !ripple) return;
  const r = btn.getBoundingClientRect();
  ripple.style.left = `${clientX - r.left}px`;
  ripple.style.top = `${clientY - r.top}px`;
  ripple.classList.remove('is-active');
  void ripple.offsetWidth;
  ripple.classList.add('is-active');
  clearTimeout(doorRippleClearTid);
  doorRippleClearTid = setTimeout(() => {
    ripple.classList.remove('is-active');
  }, 620);
}

/* ---------- 水墨转场 ---------- */

function playInkTransition() {
  return new Promise((resolve) => {
    const el = els.inkTransition;
    const onEnd = (ev) => {
      if (ev.animationName !== 'inkSpread') return;
      el.classList.remove('play');
      el.removeEventListener('animationend', onEnd);
      resolve();
    };
    el.addEventListener('animationend', onEnd);
    el.classList.remove('play');
    void el.offsetWidth;
    el.classList.add('play');
    setTimeout(() => {
      if (el.classList.contains('play')) {
        el.classList.remove('play');
        el.removeEventListener('animationend', onEnd);
        resolve();
      }
    }, 1000);
  });
}

/* ---------- 雪花粒子（Canvas） ---------- */

const snowflakes = [];
let snowRaf = 0;
let reducedMotion = false;

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function createSnowflakeSVG() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="M6 0v12M0 6h12M1.76 1.76l8.48 8.48M10.24 1.76L1.76 10.24" stroke="rgba(44,44,44,0.18)" stroke-width="0.8"/></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return img;
}

let hexImg = null;

function initSnowCanvas() {
  const canvas = els.snowCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  reducedMotion = prefersReducedMotion();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  const count = 50 + Math.floor(Math.random() * 31);
  hexImg = createSnowflakeSVG();

  snowflakes.length = 0;
  for (let i = 0; i < count; i++) {
    snowflakes.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: 1 + Math.random() * 2,
      vy: 0.3 + Math.random() * 0.5,
      vx: -0.15 + Math.random() * 0.3,
      drift: 0.002 + Math.random() * 0.004,
      phase: Math.random() * Math.PI * 2,
      kind: Math.random() < 0.28 ? 'hex' : 'circle',
    });
  }

  let staticDrawn = false;

  function frame() {
    if (!AppState.snowflakeEnabled) {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      snowRaf = requestAnimationFrame(frame);
      return;
    }

    if (reducedMotion) {
      if (!staticDrawn) {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        for (const p of snowflakes) {
          ctx.fillStyle = 'rgba(44,44,44,0.08)';
          ctx.beginPath();
          ctx.arc(p.x % window.innerWidth, p.y % window.innerHeight, Math.max(1, p.r * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
        staticDrawn = true;
      }
      snowRaf = requestAnimationFrame(frame);
      return;
    }

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const p of snowflakes) {
      p.phase += p.drift;
      p.x += p.vx + Math.sin(p.phase) * 0.25;
      p.y += p.vy * (0.8 + Math.sin(p.phase) * 0.2);

      if (p.y > h + 6) {
        p.y = -6;
        p.x = Math.random() * w;
      }
      if (p.x < -6) p.x = w + 6;
      if (p.x > w + 6) p.x = -6;

      if (p.kind === 'hex' && hexImg && hexImg.complete && hexImg.naturalWidth) {
        const s = p.r * 4;
        ctx.globalAlpha = 0.15;
        ctx.drawImage(hexImg, p.x, p.y, s, s);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = 'rgba(44,44,44,0.15)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    snowRaf = requestAnimationFrame(frame);
  }

  snowRaf = requestAnimationFrame(frame);
}

/* ---------- 流式输出与逐字渲染 ---------- */

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function appendCharWithDelay(container, char, baseMs) {
  const span = document.createElement('span');
  span.textContent = char;
  container.appendChild(span);
  const jitter = 30 + Math.random() * 30;
  await delay(baseMs + jitter - 40);
}

/** 简单字符串散列，用于轮换句库 */
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** 按关键词粗分主题（离线应答路由） */
function classifyOfflineTopic(text) {
  const t = text.trim();
  if (/资本|劳动|工资|剥削|阶级|剩余|货币|市场|生产力|生产关系|异化|工人|雇佣|分工/.test(t)) return 'capital';
  if (/诗|词|赋|平仄|韵|吟|格律|写一首|作词|愁绪|黄花|西风/.test(t)) return 'poetry';
  if (/建筑|结构|梁|柱|屋檐|光影|园林|斗拱|空间|尺度/.test(t)) return 'architecture';
  if (/累|苦|愁|孤独|怕|难过|烦|迷茫|失眠|焦虑/.test(t)) return 'heart';
  if (/高兴|欢喜|感恩|顺遂|轻松|玩笑|吃|喝|茶|酒/.test(t)) return 'ease';
  if (/人生|意义|理想|选择|死亡|时间/.test(t)) return 'life';
  return 'default';
}

/** 各人物离线句库：每主题若干条，长短贴近原设定 150～280 字 */
const OFFLINE_POOLS = {
  marx: {
    default: [
      '从生产关系的角度来看，个人处境从来不是抽象心理的偶然产物，而是一定历史条件下交往形式的结果。你所感到的挤压，往往与劳动时间被资本化、生活资料成本被转嫁有关。要紧的是先辨明结构，再谈个体策略：把愤怒对准形式而非邻人，把联合当作改变现实的起点。',
      '这不过是旧世界在解体过程中反复出现的症候。资本的运动倾向于把人的能力变成可计量的交换价值，却同时孕育着超越这种交换的社会潜能。你不必以自责吞没清醒，也不必以犬儒替代批判；在认清界限之后，仍可对更公平的共同体保持期待。',
      '人的本质在其现实性上是一切社会关系的总和。你若追问“我为何如此疲惫”，答案往往藏在分工、薪酬与生存保障的制度链条里。先学会用历史的眼光读自己的一天，再谈“如何自救”——自救若离开集体条件，便容易沦为道德表演。',
    ],
    capital: [
      '剩余价值的秘密不在于“努力不够”，而在于剩余劳动被无偿占有并再转化为支配劳动的权力。你所说的收入停滞与加班常态化，正是这一结构在当代的具体面相。理解它，不是为了泄愤，而是为了看清：改变工资水平之外，更要追问生产资料与决策权归谁。',
      '资本作为自行增殖的价值，会把生活世界不断压缩为成本—收益表。你感到被异化，并非因为你“脆弱”，而是形式本身在把人变成手段。出路不在道德谴责个体，而在重新组织生产与分配，使劳动重新成为自我实现的可能，而非单纯的谋生手段。',
      '从阶级斗争的视角看，“内卷”往往是竞争被限定在既定规则内的产物。真正的问题是谁制定规则、谁承担风险。把话说透：没有结构性的再分配与民主化的经济治理，个体再勤奋也只能在斜坡上攀爬。',
    ],
    poetry: [
      '语言不是装饰品，而是存在方式的显现。你谈诗艺，我便直说：若只雕琢字面而不问其所承载的社会情感，便容易流于小摆设。诗要真，先要敢于面对时代的矛盾；形式之美，应服务于对生活关系的把握，而非掩盖它。',
      '审美有其历史尺度。婉约或豪放，都是特定社会情绪的折射。你若写愁，不妨问：这愁是个人偶然，还是结构性的离散？好词句从不是逃避现实的帷幔，而是把现实握得更紧的那只手。',
    ],
    architecture: [
      '建筑从来不只是“盖房子”，而是把人与自然、人与历史重新编排在空间里。你问形式，我便提醒：任何美的比例背后，都有材料、劳动与权力的账本。离开这些谈“风格”，容易变成空谈。',
    ],
    heart: [
      '痛苦若只被当作心理波动，便会被个体无限放大；若把它放回具体的社会关系与生存条件里，它反而可能获得尺度。你不必以“坚强”自我苛责——人需要休息、需要同盟、需要把负担从肩上卸下一部分。',
      '解放的事业包含对脆弱者的体认。你此刻的低落，并不证明你“失败”，只证明你还在用力生活。先把基本节律稳住：睡眠、饮食、可信赖的人；再谈更远的改变。',
    ],
    ease: [
      '人之为人，不仅在于批判，也在于能感受阳光与友情的温度。你今日心情轻快，是好事：请把这份轻松当作继续前行的燃料，而不是遗忘现实的麻醉。',
    ],
    life: [
      '所谓人生意义，不在玄远的口号，而在你是否能在既定的物质条件下，使自己的生命活动更少地隶属于外在的强制。具体一点：你今天的时间，有多少属于自己，有多少属于看不见的命令？从这里开始思考，比空谈“理想”更诚实。',
    ],
  },
  liQingzhao: {
    default: [
      '只是你这一问，倒让我想起帘外风雨、案上残墨。词贵在情真，不在堆饰；若只学字面而不养胸次，便容易滑向纤巧。你且把心事说具体些：是哪一种气味、哪一种声响，最教你坐不住？从那里起笔，往往比空叹“人生”更见骨力。',
      '这般情绪，我并非不曾经过。词家写愁，不是教人沉溺，而是教人把愁写得有筋骨、有分寸。你若觉前路茫茫，不妨先收一收笔：把今夜能做的事写清三行，明日再续，也不失为一种自持。',
      '倒是有一句要劝你：悲中可以见志，却不可让悲吞尽志气。文字若只剩哀音而无清气，便落了下乘。你可愿把你的句子念与我听？我可替你掐一掐虚实。',
    ],
    poetry: [
      '写词如煎茶，火候一过便苦。你问格律，我只说：音韵为情服务，情为志所驭。若一味求巧而不问所怀，便似绣帘重重，却不见人。试取一词牌，先定一意，再让字句随声转折，或可少些滞涩。',
      '“词别是一家”，非关门户之见，而是分寸。诗可直陈，词宜吞吐；吞吐不是吞吐其辞，而是把锋刃藏在意象里。你写雁、写月，先问：此雁此月，是否只为你一人所见？若不然，便再磨。',
    ],
    heart: [
      '帘卷西风时，人最易觉薄。只是你要记得：瘦未必弱，瘦里亦可有硬气。把愁写在纸上，是收；把愁咽在肚里，是纵。收纵之间，便是自家功夫。',
    ],
    ease: [
      '若今日心头略宽，便趁此把窗推开一线，让光进来。词家亦要有晴日，否则墨色太重，反伤笔意。',
    ],
    life: [
      '人问意义，我常先问：你可还肯对美好事物动心？若肯，便未全失。意义不必大，只要真；一字一句能立得住，便是一寸安身之地。',
    ],
    capital: [
      '我虽以词名世，却非不知人间生计。你谈劳作与报酬，我只提醒：女子的笔与针，同样要算进“家”的账里。把辛苦写出来，不是诉苦，是让世看见那被省略的一半。',
    ],
    architecture: [
      '园林一步一景，贵在虚实相生。你谈空间，我亦以词眼观之：疏处可走马，密处不通风。人生布局亦然，勿令一处太满，反失回旋。',
    ],
  },
  suShi: {
    default: [
      '你看，世事如江上行舟，有时顺流，有时触石。你今日所恼，未必全是你的不是，也未必全无你的份。先把肚皮填饱，再把话说圆：人若饿急了，连月亮都嫌它太亮。来，先把眼前一件小事做好，比空愁千里更管用。',
      '此事说来有趣：人越怕“无意义”，越容易把意义说成一座压人的山。某家以为，意义不必顶天立地，能在雨里走一程而不怨，也算一种修行。你若问前路，我且问你：今夜可睡得着？睡得着，便还有转机。',
      '人生如逆旅，我亦是行人——这话不是劝你洒脱到无情，而是劝你别把旅途当刑场。苦处要认，乐处也要认；认了，才好下箸。你且说说，最近哪一桩小事，竟也让你笑过一次？',
    ],
    heart: [
      '黄州那时，我也曾觉天地窄。后来才明白：窄的不是天地，是心眼被事堵住了。你且去江边走走，看水如何把石头磨圆——它不急，却最有耐心。你也给自己一点时间。',
    ],
    ease: [
      '有酒有月，便是人间好时节。你今日心情畅快，正该记取：快乐不是罪过，不必立刻检讨。把这份松快存一点在肚里，等风浪来时，好拿出来挡风。',
    ],
    poetry: [
      '诗要真，词要活。你写赤壁，不必真到赤壁；写到心里那团火在，便是赤壁。若只抄字面，就像学我口音而不学我走路，终究不像。',
    ],
    life: [
      '儒释道三家，我都尝过一点。总结起来：该做事时做事，该吃饭时吃饭，该害怕时也别硬装英雄。人若把自己绷成一张弓，迟早要断。松一松，不是逃，是为了拉得更久。',
    ],
    capital: [
      '百姓关心米盐，士人关心治乱。你谈生计，我不讲玄理，只讲一句：官家与商贾如何分利，往往决定小民碗里的厚薄。你若要做文章，先把数目字弄清楚，比空喊仁义更近实情。',
    ],
    architecture: [
      '修堤筑桥，都是把“人”放在山水之间。你谈营造，我便说：好的工程，让人走得安心；好的文章，让人读得安心。二者同理。',
    ],
  },
  linHuiyin: {
    default: [
      '你知道吗，建筑与诗，其实都在处理“关系”：人与光、人与风、人与记忆。你这一问，若只停在情绪表层，便浪费了问题本身。试着把抽象换成可测量的东西：你渴望的，是更大的房间，还是更确定的方向？',
      '我向来不喜欢把才女二字写成花边。你若谈美，请先谈责任：对自己诚实，对作品诚实。美若失去尺度，就容易变成自我陶醉的雾。你此刻最在意的那件事，能否用一句话说清它的结构？',
      '温润不是软弱，锋芒也不必张牙舞爪。你问我如何自处，我反问：你可愿把生活当作一座要设计的房子——哪些墙必须保留，哪些窗必须开向阳光？想清这个，比空叹命运更紧要。',
    ],
    architecture: [
      '结构不是冰冷的骨架，它决定光从哪里进来。你谈空间，请记住：最动人的往往是阴影与明亮的交界。人生亦然，别把所有角都磨圆，留一点阴影，才有深度。',
      '中国古建筑的谱系，是一部人与材料、人与时间的合谋。你若学习营造，先学会尊重材料的本性；你若面对生活，亦同此理：别强扭自己成不属于自己的形状。',
    ],
    poetry: [
      '诗要意象，但意象不是堆砌。你是人间的四月天，重点不在“四月”，而在“人间”——要让人能走进去。你写句子，也问问读者能否落脚。',
    ],
    heart: [
      '战时颠沛，我亦尝过无路可退的滋味。你知道吗，能把日子一寸一寸往前推的人，已经比多数人更勇敢。别用“完美”衡量自己，用“完成”衡量今天即可。',
    ],
    ease: [
      '若你今日心境清明，就把它当作好材料存起来：日后风雨来时，好用来盖屋顶。',
    ],
    life: [
      '选择与勇气，常常是一件事的两面。你问前途，我不给你标准答案，只建议你：把“我想要”与“我能够”写在两栏里对照，差距处，就是你要用功的地方。',
    ],
    capital: [
      '知识分子谈社会，最怕只会在纸上画蓝图。你若关心民生，便去多看一眼材料、造价与使用者的身体感受。美与善，要在真实世界里站得住脚。',
    ],
  },
};

function pickOfflineReply(characterId, userText) {
  const hist = AppState.conversationHistory[characterId] || [];
  const topic = classifyOfflineTopic(userText);
  const pools = OFFLINE_POOLS[characterId] || OFFLINE_POOLS.marx;
  const list = pools[topic] || pools.default;
  const turn = Math.floor(hist.length / 2);
  const idx = (hashStr(userText + characterId) + turn) % list.length;
  return list[idx];
}

/** 本地逐字“书写”整段答语 */
async function renderLocalStreamText(msgEl, fullText) {
  const bodyEl = msgEl.querySelector('.msg-body');
  if (!bodyEl) return '';
  bodyEl.textContent = '';
  for (const ch of Array.from(fullText)) {
    await appendCharWithDelay(bodyEl, ch, 16);
  }
  bodyEl.classList.remove('streaming-cursor');
  msgEl.classList.remove('streaming');
  return fullText;
}

/** DeepSeek SSE 流式解析 + 逐字书写 */
async function renderStreamText(msgEl, reader) {
  const decoder = new TextDecoder();
  let sseBuffer = '';
  const bodyEl = msgEl.querySelector('.msg-body');
  if (!bodyEl) return '';

  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const data = JSON.parse(dataStr);
        const ch = data.choices?.[0]?.delta?.content ?? '';
        if (ch) {
          fullText += ch;
          await appendCharWithDelay(bodyEl, ch, 36);
        }
      } catch {
        /* 忽略半行 JSON */
      }
    }
  }

  const tail = sseBuffer.trim();
  if (tail.startsWith('data:')) {
    const dataStr = tail.slice(5).trim();
    if (dataStr && dataStr !== '[DONE]') {
      try {
        const data = JSON.parse(dataStr);
        const ch = data.choices?.[0]?.delta?.content ?? '';
        if (ch) {
          fullText += ch;
          await appendCharWithDelay(bodyEl, ch, 36);
        }
      } catch {
        /* ignore */
      }
    }
  }

  bodyEl.classList.remove('streaming-cursor');
  msgEl.classList.remove('streaming');
  return fullText;
}

function createUserMessageElement(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  wrap.innerHTML = `<div class="msg-label">我</div><div class="msg-body">${escapeHtml(text)}</div>`;
  return wrap;
}

function createAssistantShell(characterName) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant streaming';
  wrap.innerHTML = `<div class="msg-label">${escapeHtml(characterName)}</div><div class="msg-body streaming-cursor"></div>`;
  return wrap;
}

/** 在线模型等待：顶部「正在思考」与闪烁省略号 */
const THINKING_INDICATOR_HTML_ONLINE = '先生正在思考<span class="dot-ani">...</span>';
/** 离线笔墨：稍长的「沉思」阶段，增强对谈节奏感 */
const THINKING_INDICATOR_HTML_OFFLINE = '先生正在沉思<span class="dot-ani">...</span>';
const OFFLINE_REPLY_THINKING_MS = 1500;

function showThinkingIndicator() {
  const el = els.thinkingIndicator;
  if (!el) return;
  el.innerHTML = THINKING_INDICATOR_HTML_ONLINE;
  el.removeAttribute('aria-live');
  el.setAttribute('aria-hidden', 'true');
  el.classList.remove('hidden');
}

function hideThinkingIndicator() {
  const el = els.thinkingIndicator;
  if (!el) return;
  el.innerHTML = THINKING_INDICATOR_HTML_ONLINE;
  el.removeAttribute('aria-live');
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('hidden');
}

/** 离线回复前：保持指示条可见，展示「沉思」文案并等待固定时长 */
async function awaitOfflineMusingDelay() {
  const el = els.thinkingIndicator;
  if (!el) {
    await sleep(OFFLINE_REPLY_THINKING_MS);
    return;
  }
  el.innerHTML = THINKING_INDICATOR_HTML_OFFLINE;
  el.removeAttribute('aria-hidden');
  el.setAttribute('aria-live', 'polite');
  el.classList.remove('hidden');
  await sleep(OFFLINE_REPLY_THINKING_MS);
  hideThinkingIndicator();
}

function getConversationRounds() {
  const id = AppState.currentCharacter;
  if (!id) return 0;
  const h = AppState.conversationHistory[id];
  return Math.floor(h.length / 2);
}

function updateGiftButtonVisibility() {
  const rounds = getConversationRounds();
  if (rounds >= 4) {
    els.giftGenerateRow.classList.remove('hidden');
  } else {
    els.giftGenerateRow.classList.add('hidden');
  }
}

/** 渲染当前人物的欢迎语与历史消息 */
function renderDialogue() {
  els.dialogueHistory.innerHTML = '';
  const id = AppState.currentCharacter;
  if (!id) return;
  const cfg = CHARACTER_CONFIG && CHARACTER_CONFIG[id];
  if (!cfg) return;
  const strip = document.createElement('div');
  strip.className = 'welcome-strip';
  strip.textContent = cfg.welcomeText;
  els.dialogueHistory.appendChild(strip);

  const hist = AppState.conversationHistory[id];
  for (const m of hist) {
    if (m.role === 'user') {
      els.dialogueHistory.appendChild(createUserMessageElement(m.content));
    } else if (m.role === 'assistant') {
      const el = document.createElement('div');
      el.className = 'msg msg-assistant';
      el.innerHTML = `<div class="msg-label">${escapeHtml(cfg.name)}</div><div class="msg-body">${escapeHtml(
        m.content
      )}</div>`;
      els.dialogueHistory.appendChild(el);
    }
  }
  els.dialogueHistory.scrollTop = els.dialogueHistory.scrollHeight;
  updateGiftButtonVisibility();
}

async function sendMessage(userMessage) {
  const trimmed = userMessage.trim();
  if (!trimmed) {
    showToast('请先写下你的问题。');
    return;
  }

  if (!CHARACTER_CONFIG || typeof CHARACTER_CONFIG !== 'object') {
    showToast('人物数据未加载，请检查 characters.js 是否已正确引入。');
    return;
  }

  const character = CHARACTER_CONFIG[AppState.currentCharacter];
  if (!character) {
    showToast('请先叩门入室，再与精神导师对话。');
    return;
  }

  if (AppState.isStreaming) {
    showToast('先生尚在挥毫，请稍候。');
    return;
  }

  if (!canAttemptOnlineDeepseek()) {
    showToast(
      '当前无法连接在线模型：请用 http(s) 打开（部署到 Vercel 并配置 DEEPSEEK_API_KEY），或在 app.js 填写密钥。已使用离线笔墨。',
      5200
    );
  }

  const history = AppState.conversationHistory[AppState.currentCharacter];

  els.userInput.value = '';
  els.sendBtn.disabled = true;
  AppState.isStreaming = true;

  try {
    els.dialogueHistory.appendChild(createUserMessageElement(trimmed));
    els.dialogueHistory.scrollTop = els.dialogueHistory.scrollHeight;

    showThinkingIndicator();

    let assistantText = '';
    let msgEl = null;

    if (canAttemptOnlineDeepseek()) {
      const abortCtrl = new AbortController();
      const abortTid = setTimeout(() => abortCtrl.abort(), DEEPSEEK_REQUEST_TIMEOUT_MS);
      try {
        const messages = [
          { role: 'system', content: buildFullSystemPrompt(character) },
          ...history,
          { role: 'user', content: trimmed },
        ];

        const response = await fetch(getDeepseekEndpoint(), {
          method: 'POST',
          headers: buildDeepseekFetchHeaders(),
          body: JSON.stringify({
            model: API_MODEL,
            messages,
            stream: true,
            temperature: API_TEMPERATURE,
            max_tokens: API_MAX_TOKENS,
          }),
          signal: abortCtrl.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(errText || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('响应体不可读');

        hideThinkingIndicator();
        msgEl = createAssistantShell(character.name);
        els.dialogueHistory.appendChild(msgEl);
        els.dialogueHistory.scrollTop = els.dialogueHistory.scrollHeight;
        assistantText = await renderStreamText(msgEl, reader);
      } catch (e) {
        console.warn('[对话] API 不可用或超时，切换离线笔墨', e);
        await awaitOfflineMusingDelay();
        const reply = pickOfflineReply(AppState.currentCharacter, trimmed);
        if (msgEl && msgEl.parentNode) {
          const bodyEl = msgEl.querySelector('.msg-body');
          if (bodyEl) {
            bodyEl.textContent = '';
            bodyEl.classList.add('streaming-cursor');
          }
          msgEl.classList.add('streaming');
          assistantText = await renderLocalStreamText(msgEl, reply);
        } else {
          msgEl = createAssistantShell(character.name);
          els.dialogueHistory.appendChild(msgEl);
          els.dialogueHistory.scrollTop = els.dialogueHistory.scrollHeight;
          assistantText = await renderLocalStreamText(msgEl, reply);
        }
        const aborted = e && (e.name === 'AbortError' || /aborted|AbortError/i.test(String(e.message || e)));
        showToast(
          aborted
            ? '云端应答超时，已切换离线笔墨。'
            : '云端暂不可用或限流，已切换离线笔墨。部署到 Vercel 并配置 DEEPSEEK_API_KEY 后可恢复在线。',
          5200
        );
      } finally {
        clearTimeout(abortTid);
      }
    } else {
      await awaitOfflineMusingDelay();
      msgEl = createAssistantShell(character.name);
      els.dialogueHistory.appendChild(msgEl);
      els.dialogueHistory.scrollTop = els.dialogueHistory.scrollHeight;
      const reply = pickOfflineReply(AppState.currentCharacter, trimmed);
      assistantText = await renderLocalStreamText(msgEl, reply);
    }

    history.push({ role: 'user', content: trimmed });
    history.push({ role: 'assistant', content: assistantText });
    saveHistoryToStorage();
    renderDialogue();
  } catch (e) {
    console.error('[对话]', e);
    hideThinkingIndicator();
    showToast('对话出现异常，请刷新后重试。');
    els.userInput.value = trimmed;
    renderDialogue();
  } finally {
    AppState.isStreaming = false;
    els.sendBtn.disabled = false;
    els.userInput.focus();
    updateGiftButtonVisibility();
  }
}

/** 离线赠言文案（API 失败或未配置时使用） */
function buildOfflineGiftSummary(id, tail) {
  const userBits = tail
    .filter((m) => m.role === 'user')
    .map((m) => m.content.trim())
    .slice(-4);
  const gist = userBits.join('；').replace(/\s+/g, '').slice(0, 36);
  const seeds = [
    `综此数问，所涉多在「${gist || '尘俗琐务'}」之间。愿君守志如常，行路自宽，不以一时滞涩换尽平生清明。`,
    `笔墨往还，觉君所怀不离「${gist || '人间烟火'}」。记取：知所进退，亦是勇气；留一寸清气，以待春风。`,
    `数问之下，大意可会：「${gist || '未言之事'}」。成事在勤，亦在择；择之既明，则步步皆可作印。`,
  ];
  return seeds[(hashStr(gist + id) + tail.length) % seeds.length].slice(0, 50);
}

/** 生成先生赠言：优先 API 一句总结，失败则离线合成 */
async function generateGiftCard() {
  const id = AppState.currentCharacter;
  const character = CHARACTER_CONFIG[id];
  if (!id || !character) {
    showToast('暂无对话人物。');
    return;
  }

  const hist = AppState.conversationHistory[id];
  const tail = hist.slice(-8);

  try {
    els.giftGenerateBtn.disabled = true;
    let text = '';

    if (canAttemptOnlineDeepseek()) {
      const abortCtrl = new AbortController();
      const abortTid = setTimeout(() => abortCtrl.abort(), DEEPSEEK_GIFT_TIMEOUT_MS);
      try {
        const summaryPrompt = `你是${character.name}的书记员。请阅读以下对话摘录，用第一人称「先生」口吻写一句赠言，50个汉字以内，含蓄典雅、有留白，不要引号，不要动作描写。\n\n对话：\n${tail
          .map((m) => `${m.role === 'user' ? '问' : '答'}：${m.content}`)
          .join('\n')}`;

        const res = await fetch(getDeepseekEndpoint(), {
          method: 'POST',
          headers: buildDeepseekFetchHeaders(),
          body: JSON.stringify({
            model: API_MODEL,
            messages: [
              {
                role: 'system',
                content: `${HUMANITIES_LAYER}\n你是${character.name}的书记员：只输出一句中文赠言，50字以内，典雅含蓄、有留白，不要引号与动作描写。`,
              },
              { role: 'user', content: summaryPrompt },
            ],
            stream: false,
            temperature: 0.55,
            max_tokens: 120,
          }),
          signal: abortCtrl.signal,
        });

        if (res.ok) {
          const data = await res.json();
          text = (data.choices?.[0]?.message?.content || '').trim();
        }
      } catch (e) {
        console.warn('[赠言] API 失败或超时，使用离线文案', e);
      } finally {
        clearTimeout(abortTid);
      }
    }

    if (!text) {
      text = buildOfflineGiftSummary(id, tail);
    }
    if (text.length > 52) text = text.slice(0, 52);

    els.giftQuoteText.textContent = text;
    els.giftSealText.textContent = `${character.name} 印`;
    els.giftCardModal.classList.remove('hidden');
  } catch (e) {
    console.error('[赠言]', e);
    showToast('生成赠言失败，请稍后再试。');
  } finally {
    els.giftGenerateBtn.disabled = false;
  }
}

/** 将赠言绘制到 Canvas 并下载 PNG（不依赖任何外部库） */
async function saveGiftCardImage() {
  try {
    const quote = els.giftQuoteText.textContent || '';
    const seal = els.giftSealText.textContent || '印';
    const W = 720;
    const H = 960;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      showToast('浏览器不支持画布导出。');
      return;
    }

    ctx.fillStyle = '#f9f4e8';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(201, 168, 76, 0.65)';
    ctx.lineWidth = 3;
    ctx.strokeRect(24, 24, W - 48, H - 48);

    ctx.fillStyle = '#2c2c2c';
    ctx.font = '22px "Source Han Serif SC", "STSong", "Songti SC", serif';
    ctx.textAlign = 'center';
    ctx.fillText('先生赠言', W / 2, 88);

    ctx.font = '26px "FangSong", "STFangsong", "KaiTi", serif';
    ctx.textAlign = 'left';
    const maxW = W - 96;
    let y = 140;
    const lineHeight = 38;
    const paragraphs = quote.split('\n');
    for (const para of paragraphs) {
      let line = '';
      for (let i = 0; i < para.length; i++) {
        const ch = para[i];
        const test = line + ch;
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, 48, y);
          y += lineHeight;
          line = ch;
        } else {
          line = test;
        }
      }
      if (line) {
        ctx.fillText(line, 48, y);
        y += lineHeight;
      }
      y += 8;
    }

    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = 2;
    const sw = Math.min(280, ctx.measureText(seal).width + 36);
    ctx.strokeRect(W / 2 - sw / 2, H - 120, sw, 48);
    ctx.fillStyle = '#c0392b';
    ctx.font = '20px "Source Han Serif SC", serif';
    ctx.textAlign = 'center';
    ctx.fillText(seal, W / 2, H - 88);

    const link = document.createElement('a');
    link.download = `先生赠言_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('画笺已生成下载。');
  } catch (e) {
    console.error(e);
    showToast('保存画笺失败。');
  }
}

function closeDialogueShell() {
  if (!els.dialogueShell) return;
  els.dialogueShell.classList.remove('is-open');
  els.dialogueShell.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('dialogue-open');
  document.body.style.backgroundImage = '';
  document.body.style.backgroundSize = '';
  document.body.style.backgroundAttachment = '';
  const cid = AppState.currentCharacter;
  if (cid) {
    const ix = SPOTLIGHT_ORDER.indexOf(cid);
    if (ix >= 0) spotlightIndex = ix;
  }
  void renderSpotlightHero({ animate: false });
}

function openDialogueShell() {
  if (!els.dialogueShell) return;
  els.dialogueShell.classList.add('is-open');
  els.dialogueShell.setAttribute('aria-hidden', 'false');
  document.body.classList.add('dialogue-open');
}

/** 与人物配置 scaleClass 同步，避免残留旧类名 */
const PORTRAIT_SCALE_CLASS_TOKENS = ['scale-up'];

function applyConfigScaleClassToImg(img, cfg) {
  if (!img) return;
  PORTRAIT_SCALE_CLASS_TOKENS.forEach((c) => img.classList.remove(c));
  const raw = cfg && typeof cfg.scaleClass === 'string' ? cfg.scaleClass.trim() : '';
  if (!raw) return;
  raw.split(/\s+/).forEach((token) => {
    if (token) img.classList.add(token);
  });
}

function syncRosterPortraitScaleClasses() {
  if (!CHARACTER_CONFIG) return;
  document.querySelectorAll('.roster-scroll .character-card[data-character]').forEach((card) => {
    const cid = card.getAttribute('data-character');
    const cfg = cid ? CHARACTER_CONFIG[cid] : null;
    const img = card.querySelector('img.character-portrait');
    applyConfigScaleClassToImg(img, cfg);
  });
}

function syncSpotlightStageClasses() {
  const track = document.getElementById('characterTrack');
  if (!track) return;
  const n = SPOTLIGHT_ORDER.length;
  if (n < 1) return;
  const prevId = SPOTLIGHT_ORDER[(spotlightIndex - 1 + n) % n];
  const currId = SPOTLIGHT_ORDER[spotlightIndex];
  const nextId = SPOTLIGHT_ORDER[(spotlightIndex + 1) % n];
  track.querySelectorAll('.character-slide[data-character]').forEach((el) => {
    const cid = el.getAttribute('data-character');
    el.classList.remove('is-prev', 'is-active', 'is-next', 'is-concealed');
    if (cid === currId) {
      el.classList.add('is-active');
      el.setAttribute('aria-hidden', 'false');
    } else if (cid === prevId) {
      el.classList.add('is-prev');
      el.setAttribute('aria-hidden', 'true');
    } else if (cid === nextId) {
      el.classList.add('is-next');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.classList.add('is-concealed');
      el.setAttribute('aria-hidden', 'true');
    }
  });
}

function initSpotlightStageCards() {
  const track = document.getElementById('characterTrack');
  if (!track || !CHARACTER_CONFIG) return;
  track.querySelectorAll('.character-slide[data-character]').forEach((article) => {
    const cid = article.getAttribute('data-character');
    const cfg = CHARACTER_CONFIG[cid];
    if (!cfg) return;
    const img = article.querySelector('.portrait-img');
    if (img) {
      const raw = (cfg.avatar || '').trim();
      const url = raw || SPOTLIGHT_STAGE_AVATAR_FALLBACK[cid] || '';
      if (url) img.src = url;
      img.alt = `${cfg.name}立绘`;
      applyConfigScaleClassToImg(img, cfg);
    }
    const nameEl = article.querySelector('.character-slide__name');
    const introEl = article.querySelector('.character-slide__intro');
    const quoteEl = article.querySelector('.character-slide__quote');
    if (nameEl) nameEl.textContent = cfg.name;
    if (introEl) introEl.textContent = cfg.spotlightIntro || cfg.dynasty || '';
    if (quoteEl) quoteEl.textContent = cfg.spotlightQuote || '';
    const door = article.querySelector('.spotlight-door-btn');
    if (door) {
      door.dataset.character = cid;
      door.setAttribute('aria-label', `叩门·与${cfg.name}对谈`);
    }
  });
  syncRosterPortraitScaleClasses();
  syncSpotlightStageClasses();
}

function getSpotlightCharacterId() {
  return SPOTLIGHT_ORDER[spotlightIndex] || SPOTLIGHT_ORDER[0];
}

function applySpotlightDomForCharacter(id, opts = {}) {
  const cfg = CHARACTER_CONFIG[id];
  if (!cfg) return;
  const slide = document.querySelector(`.character-slide[data-character="${id}"]`);
  const bubble = slide?.querySelector('.spotlight-speech-bubble');
  const nudge = opts.nudge === true && !prefersReducedMotion();
  if (bubble && nudge) {
    bubble.classList.remove('spotlight-speech-bubble--nudge');
    void bubble.offsetWidth;
    bubble.classList.add('spotlight-speech-bubble--nudge');
    clearTimeout(bubbleNudgeClearTid);
    bubbleNudgeClearTid = setTimeout(() => {
      bubble.classList.remove('spotlight-speech-bubble--nudge');
    }, 720);
  }
  if (cfg.themeColor) {
    document.documentElement.style.setProperty('--color-character', cfg.themeColor);
  }
}

function updateRosterSelectionFor(id) {
  document.querySelectorAll('.roster-scroll .character-card[data-character]').forEach((card) => {
    const cid = card.getAttribute('data-character');
    card.classList.toggle('is-selected', cid === id);
  });
}

async function renderSpotlightHero(opts = {}) {
  let id = opts.characterId ?? getSpotlightCharacterId();
  const ixAlign = SPOTLIGHT_ORDER.indexOf(id);
  if (ixAlign >= 0) spotlightIndex = ixAlign;
  id = getSpotlightCharacterId();
  const cfg = CHARACTER_CONFIG[id];
  const track = document.getElementById('characterTrack');
  if (!cfg || !track) return;

  const run = async () => {
    updateRosterSelectionFor(id);
    syncSpotlightStageClasses();
    const withNudge = opts.animate === true && !prefersReducedMotion();
    applySpotlightDomForCharacter(id, { nudge: withNudge });
  };

  _spotlightRenderSerial = _spotlightRenderSerial.then(run, run);
  return _spotlightRenderSerial;
}

function scrollRosterToSelection() {
  const id = getSpotlightCharacterId();
  const scroller = document.getElementById('characterSwiper');
  if (!scroller) return;
  const card = scroller.querySelector(`.character-card[data-character="${id}"]`);
  if (!card) return;
  try {
    const pad = 16;
    const cr = card.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    let next = scroller.scrollLeft;
    if (cr.left < sr.left + pad) {
      next -= sr.left + pad - cr.left;
    } else if (cr.right > sr.right - pad) {
      next += cr.right - (sr.right - pad);
    }
    next = Math.max(0, Math.min(maxScroll, next));
    if (Math.abs(next - scroller.scrollLeft) > 1) {
      scroller.scrollTo({ left: next, behavior: 'smooth' });
    }
  } catch (_) {
    /* ignore */
  }
}

async function spotlightStep(delta) {
  const n = SPOTLIGHT_ORDER.length;
  spotlightIndex = (spotlightIndex + delta + n) % n;
  const id = getSpotlightCharacterId();
  await renderSpotlightHero({ animate: true, characterId: id });
  scrollRosterToSelection();
}

async function selectSpotlightByCharacterId(cid) {
  const ix = SPOTLIGHT_ORDER.indexOf(cid);
  if (ix < 0) return;
  spotlightIndex = ix;
  await renderSpotlightHero({ animate: true, characterId: cid });
  scrollRosterToSelection();
}

/* ---------- Tab 切换 ---------- */

function switchTab(tabId) {
  if (tabId !== AppState.currentTab && els.dialogueShell?.classList.contains('is-open')) {
    closeDialogueShell();
  }
  AppState.currentTab = tabId;
  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `tab-${tabId}`);
  });
  document.querySelectorAll('.bottom-nav .nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  if (tabId === 'chushan') {
    renderLeaderboard();
  }
}

/* ---------- 人物卡交互：鼠标水墨位置 ---------- */

function bindCharacterCardInkHover() {
  document.querySelectorAll('.roster-scroll .character-card').forEach((card) => {
    card.addEventListener('pointermove', (ev) => {
      const r = card.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / r.width) * 100;
      const my = ((ev.clientY - r.top) / r.height) * 100;
      card.style.setProperty('--mx', `${mx}%`);
      card.style.setProperty('--my', `${my}%`);
    });
  });
}

/* ---------- 叩门入室流程 ---------- */

function applyDialogueShellFromCharacter(characterId) {
  const cfg = CHARACTER_CONFIG[characterId];
  if (!cfg) return;
  els.dialogueTitle.textContent = cfg.name;
  els.dialogueStatus.textContent = '已入室·可对谈';
  document.body.style.backgroundImage = `linear-gradient(rgba(249,244,232,0.92), rgba(249,244,232,0.92)), url('${cfg.bgTexture}')`;
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundAttachment = 'fixed';
}

async function playPageToDialogTransition() {
  const el = els.doorTransitionOverlay;
  if (!el || prefersReducedMotion()) {
    await sleep(120);
    return;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.classList.remove('is-active');
      el.removeEventListener('animationend', onEnd);
      clearTimeout(tid);
      resolve();
    };
    const onEnd = (ev) => {
      if (ev.target !== el || ev.animationName !== 'doorPageBloom') return;
      finish();
    };
    el.addEventListener('animationend', onEnd);
    const tid = setTimeout(finish, 950);
    el.classList.remove('is-active');
    void el.offsetWidth;
    el.classList.add('is-active');
  });
}

async function onDoorOpen(characterId) {
  const ix = SPOTLIGHT_ORDER.indexOf(characterId);
  if (ix >= 0) spotlightIndex = ix;
  await renderSpotlightHero({ animate: false, characterId: characterId });

  try {
    await playKnockSound();
    await playPageToDialogTransition();
    AppState.switchCharacter(characterId);
    openDialogueShell();
    applyDialogueShellFromCharacter(characterId);
    renderDialogue();
    try {
      els.userInput?.focus();
    } catch (_) {
      /* ignore */
    }
  } catch (e) {
    console.error(e);
    showToast('入室动效出现问题，但可继续对话。');
    AppState.switchCharacter(characterId);
    openDialogueShell();
    applyDialogueShellFromCharacter(characterId);
    renderDialogue();
    try {
      els.userInput?.focus();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ---------- 初始化 ---------- */

function bindEvents() {
  els.spotlightPrev?.addEventListener('click', () => void spotlightStep(-1));
  els.spotlightNext?.addEventListener('click', () => void spotlightStep(1));

  const spotlightTrack = document.getElementById('characterTrack');
  if (spotlightTrack) {
    spotlightTrack.addEventListener('pointerdown', (ev) => {
      const btn = ev.target.closest('.character-slide.is-active .spotlight-door-btn');
      if (!btn) return;
      btn.classList.add('is-pressing');
      triggerSpotlightDoorRipple(btn, ev.clientX, ev.clientY);
    });
    spotlightTrack.addEventListener('pointerup', () => {
      spotlightTrack.querySelector('.character-slide.is-active .spotlight-door-btn')?.classList.remove('is-pressing');
    });
    spotlightTrack.addEventListener('pointercancel', () => {
      spotlightTrack.querySelector('.character-slide.is-active .spotlight-door-btn')?.classList.remove('is-pressing');
    });
    spotlightTrack.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.character-slide.is-active .spotlight-door-btn');
      if (!btn) return;
      const cid = btn.getAttribute('data-character') || getSpotlightCharacterId();
      if (cid) void onDoorOpen(cid);
    });
  }

  els.dialogueCloseBtn?.addEventListener('click', () => {
    closeDialogueShell();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (els.giftCardModal && !els.giftCardModal.classList.contains('hidden')) {
      els.giftCardModal.classList.add('hidden');
      return;
    }
    if (els.chushanNominateModal && !els.chushanNominateModal.classList.contains('hidden')) {
      closeChushanNominateModal();
      return;
    }
    if (els.dialogueShell?.classList.contains('is-open')) {
      closeDialogueShell();
    }
  });

  document.querySelectorAll('.roster-scroll .character-card[data-character]').forEach((card) => {
    card.addEventListener('click', (ev) => {
      const cid = card.getAttribute('data-character');
      if (cid && SPOTLIGHT_ORDER.includes(cid)) {
        void selectSpotlightByCharacterId(cid);
      }
    });
    card.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const cid = card.getAttribute('data-character');
      if (cid && SPOTLIGHT_ORDER.includes(cid)) {
        ev.preventDefault();
        void selectSpotlightByCharacterId(cid);
      }
    });
  });

  els.sendBtn.addEventListener('click', () => {
    sendMessage(els.userInput.value);
  });

  els.userInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage(els.userInput.value);
    }
  });

  els.giftGenerateBtn.addEventListener('click', () => generateGiftCard());

  els.giftCloseBtn.addEventListener('click', () => els.giftCardModal.classList.add('hidden'));
  els.giftDismissBtn.addEventListener('click', () => els.giftCardModal.classList.add('hidden'));
  els.giftShareBtn.addEventListener('click', () => saveGiftCardImage());

  document.querySelectorAll('.bottom-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab) switchTab(tab);
    });
  });

  EventBus.on('characterChanged', () => {
    updateGiftButtonVisibility();
  });

  if (window.matchMedia) {
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
      reducedMotion = prefersReducedMotion();
    });
  }

  initXunfangInviteFlow();
  initChushanNominateFlow();
}

function openChushanNominateModal() {
  const m = els.chushanNominateModal;
  if (!m) return;
  m.classList.remove('hidden');
  m.setAttribute('aria-hidden', 'false');
  try {
    document.getElementById('nominateName')?.focus();
  } catch (_) {
    /* ignore */
  }
}

function closeChushanNominateModal() {
  const m = els.chushanNominateModal;
  if (!m) return;
  m.classList.add('hidden');
  m.setAttribute('aria-hidden', 'true');
}

const MY_NOM_IMAGE_MAX_CHARS = 950000;

function loadMyNominationsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.myNominations);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) {
      myNominations = [];
      return;
    }
    myNominations = arr
      .map((x) => {
        if (!x || typeof x !== 'object') return null;
        const name = String(x.name || '').trim();
        const reason = String(x.reason || '').trim();
        if (!name || !reason) return null;
        let imageDataUrl = typeof x.imageDataUrl === 'string' ? x.imageDataUrl.trim() : '';
        if (imageDataUrl.length > MY_NOM_IMAGE_MAX_CHARS) imageDataUrl = '';
        return {
          id: typeof x.id === 'string' && x.id ? x.id : `nom_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          name,
          reason,
          imageDataUrl,
          createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now(),
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.warn('[存储] 读取我的提名失败', e);
    myNominations = [];
  }
}

function persistMyNominations() {
  try {
    localStorage.setItem(STORAGE_KEYS.myNominations, JSON.stringify(myNominations));
    return true;
  } catch (e) {
    console.warn(e);
    showToast('本地存储不可用或已满，提名未写入。可尝试缩小意向图或不传图后再试。');
    return false;
  }
}

function readNominateImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.size) return resolve('');
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      resolve(typeof r === 'string' ? r : '');
    };
    reader.onerror = () => reject(reader.error || new Error('read'));
    reader.readAsDataURL(file);
  });
}

function myNominationAvatarMarkup(row) {
  const src = row && typeof row.imageDataUrl === 'string' ? row.imageDataUrl.trim() : '';
  if (src) {
    return {
      wrapClass: 'leaderboard-avatar leaderboard-avatar--card',
      inner: `<img class="leaderboard-avatar__img" src="${escapeHtml(
        src
      )}" alt="" width="56" height="74" decoding="async" />`,
    };
  }
  return {
    wrapClass: 'leaderboard-avatar',
    inner: LEADERBOARD_AVATAR_SVG,
  };
}

function nominationRowHtml(row, index) {
  const rank = index + 1;
  const av = myNominationAvatarMarkup(row);
  return `
      <li data-my-nomination-id="${escapeHtml(row.id)}">
        <span class="rank-num rank-num--muted" aria-label="第 ${rank} 条">${rank}</span>
        <div class="${av.wrapClass}" aria-hidden="true">
          ${av.inner}
        </div>
        <div class="rank-center">
          <span class="name">${escapeHtml(row.name)}</span>
          <div class="rank-nomination">
            <span class="rank-nomination__label">提名理由</span>
            <span class="rank-nomination__text">${escapeHtml(row.reason)}</span>
          </div>
        </div>
        <div class="rank-actions">
          <span class="votes-wrap" aria-label="得票数">
            <span class="votes">1</span>
          </span>
          <button type="button" class="ink-btn snow-vote-btn snow-vote-btn--done" disabled aria-disabled="true">已呈送</button>
        </div>
      </li>`;
}

function renderMyNominationsList(options = {}) {
  const list = els.nominationList;
  const section = els.myNominationsSection;
  if (!list || !section) return;
  list.innerHTML = myNominations.map((row, i) => nominationRowHtml(row, i)).join('');
  if (myNominations.length) {
    section.style.display = 'block';
    if (options.scroll) {
      requestAnimationFrame(() => {
        try {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (_) {
          section.scrollIntoView();
        }
      });
    }
  } else {
    section.style.display = 'none';
  }
}

async function onChushanNominateSubmit(ev) {
  ev.preventDefault();
  const nameInput = document.getElementById('nominateName');
  const reasonInput = document.getElementById('nominateReason');
  const fileInput = document.getElementById('nominateImage');
  const name = nameInput?.value?.trim() || '';
  const reason = reasonInput?.value?.trim() || '';
  if (!name) {
    showToast('请填写精神导师名讳。');
    nameInput?.focus();
    return;
  }
  if (!reason) {
    showToast('请填写提名理由。');
    reasonInput?.focus();
    return;
  }

  let imageDataUrl = '';
  const file = fileInput?.files?.[0];
  if (file) {
    try {
      imageDataUrl = await readNominateImageAsDataUrl(file);
      if (imageDataUrl.length > MY_NOM_IMAGE_MAX_CHARS) {
        imageDataUrl = '';
        showToast('意向图过大，已改用默认头像。');
      }
    } catch {
      imageDataUrl = '';
      showToast('意向图读取失败，已改用默认头像。');
    }
  }

  const item = {
    id: `nom_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    name,
    reason,
    imageDataUrl,
    createdAt: Date.now(),
  };

  myNominations.unshift(item);
  if (!persistMyNominations()) {
    myNominations.shift();
    return;
  }

  renderMyNominationsList({ scroll: true });
  showToast('提名已呈送。团队将在审核后与你联系。');
  els.chushanNominateForm?.reset();
  closeChushanNominateModal();
}

function initChushanNominateFlow() {
  els.chushanNominateOpen?.addEventListener('click', () => openChushanNominateModal());
  els.chushanNominateClose?.addEventListener('click', () => closeChushanNominateModal());
  els.chushanNominateModal?.querySelector('[data-close-nominate]')?.addEventListener('click', () => {
    closeChushanNominateModal();
  });
  els.chushanNominateForm?.addEventListener('submit', (ev) => {
    void onChushanNominateSubmit(ev);
  });
}

function initXunfangInviteFlow() {
  const btn = document.getElementById('xunfangSubmitBtn');
  const status = document.getElementById('xunfangSubmitStatus');
  if (!btn || !status) return;

  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '正在接引...';
    status.removeAttribute('hidden');
    status.classList.remove('is-visible');
    void status.offsetWidth;
    status.classList.add('is-visible');
  });
}

function boot() {
  const configOk = CHARACTER_CONFIG && typeof CHARACTER_CONFIG === 'object';

  loadHistoryFromStorage();
  loadMyNominationsFromStorage();
  initLeaderboard();
  renderLeaderboard();

  /** 导航、Tab、左右切换等须始终绑定，避免人物脚本失败时整页锁死 */
  bindEvents();
  renderMyNominationsList({ scroll: false });
  bindCharacterCardInkHover();
  initSnowCanvas();

  if (!configOk) {
    console.error(
      '[古贤对话录] window.CHARACTER_CONFIG 未定义。请确认 characters.js 先于 app.js 加载且无语法错误。'
    );
    showToast('人物数据未加载：请检查 characters.js 是否已成功引入。', 5600);
    switchTab('wendao');
    maybeShowBootToast();
    return;
  }

  initSpotlightStageCards();
  void renderSpotlightHero({ animate: false });

  switchTab('wendao');

  maybeShowBootToast();
}

/** 启动提示：file:// 下跨域不可用属正常，避免每次打开都弹长文 */
function maybeShowBootToast() {
  const sessKey = 'kouwen_boot_tip_shown_v1';
  const isFile = location.protocol === 'file:';

  if (isFile) {
    try {
      if (sessionStorage.getItem(sessKey) === '1') return;
      sessionStorage.setItem(sessKey, '1');
    } catch {
      /* 无痕模式等：忽略，仍展示一次 */
    }
    showToast(
      '当前是直接双击打开的本地文件：在线模型会被浏览器拦截，已用离线对话。要接通 DeepSeek，请把项目部署到 Vercel（见 DEPLOY.md），或在项目文件夹终端运行 npx vercel dev，用出现的 http 地址打开页面。',
      7200
    );
    return;
  }

  showToast(
    '同源代理已就绪：线上请在 Vercel 配置 DEEPSEEK_API_KEY（无需把密钥写进前端）；请求失败或超时时会自动使用离线笔墨。',
    5200
  );
}

boot();
