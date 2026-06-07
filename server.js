// THE QUBIT — lobby + relay server
// Run: node server.js  (default port 8080)

const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODERATION_URL = process.env.OPENAI_MODERATION_URL || 'https://api.openai.com/v1/moderations';
const OPENAI_MODERATION_MODEL = process.env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest';
const OPENAI_MODERATION_TIMEOUT_MS = Math.max(1000, Number(process.env.OPENAI_MODERATION_TIMEOUT_MS) || 4000);
const OPENAI_MODERATION_CACHE_TTL_MS = Math.max(0, Number(process.env.OPENAI_MODERATION_CACHE_TTL_MS) || 10 * 60 * 1000);
const OPENAI_MODERATION_FAIL_OPEN = process.env.OPENAI_MODERATION_FAIL_OPEN === '1';
const OPENAI_MODERATION_BLOCK_CATEGORIES = new Set(
  String(process.env.OPENAI_MODERATION_BLOCK_CATEGORIES || [
    'harassment',
    'harassment/threatening',
    'hate',
    'hate/threatening',
    'illicit',
    'illicit/violent',
    'self-harm',
    'self-harm/intent',
    'self-harm/instructions',
    'sexual',
    'sexual/minors',
    'violence/graphic'
  ].join(','))
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);
const nicknameModerationCache = new Map();
const runTokens = new Map();
const usedRunTokens = new Map();

// ---- Leaderboard storage ----
const APP_DIR = __dirname;
const DEFAULT_DATA_DIR = path.basename(APP_DIR) === 'app'
  ? path.resolve(APP_DIR, '..', 'data')
  : path.join(APP_DIR, 'data');
const DATA_DIR = path.resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR);
const LEGACY_LB_FILE = path.join(APP_DIR, 'leaderboard.json');
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const RUN_TOKEN_SECRET_FILE = path.join(DATA_DIR, 'run-token-secret');
const MODES = ['normal', 'hard', 'extraHard'];
const TOP_N = 10;
const SCORE_MAX_SECONDS = 3600;
const SCORE_GRACE_SECONDS = Math.max(1, Number(process.env.SCORE_GRACE_SECONDS) || 4);
const RUN_TOKEN_TTL_MS = Math.max(60000, Number(process.env.RUN_TOKEN_TTL_MS) || (SCORE_MAX_SECONDS + 60) * 1000);
const NICK_MAX = 18;
const NICK_ALLOWED_RE = /^[a-z0-9 _.-]+$/i;
const PUBLIC_STATIC_FILES = new Set(['index.html', 'favicon.ico']);
const PUBLIC_STATIC_DIRS = ['assets', 'public', 'static'];
const PUBLIC_STATIC_EXTS = new Set(['.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.mp3', '.wav', '.ogg', '.json', '.txt']);
const REPLAY_VERSION = 2;
const REPLAY_DT = 1 / 60;
const REPLAY_HIT_SLACK = 12;
const REPLAY_MAX_GAP_SECONDS = 0.7;
const REPLAY_MAX_SAMPLES = 45000;
const REPLAY_MAX_BYTES = 1200000;
const MODE_CONFIG = {
  normal:    { spawn: 0.55, speedMul: 1.04, antimatterChance: 0.20, lightChance: 0.28, darkChance: 0.12, energyChance: 0.00, electronChance: 0.008, falseChance: 0.008, neutrinoChance: 0.00 },
  hard:      { spawn: 0.29, speedMul: 1.24, antimatterChance: 0.28, lightChance: 0.34, darkChance: 0.11, energyChance: 0.008, electronChance: 0.008, falseChance: 0.008, neutrinoChance: 0.00 },
  extraHard: { spawn: 0.23, speedMul: 1.38, antimatterChance: 0.32, lightChance: 0.37, darkChance: 0.13, energyChance: 0.014, electronChance: 0.014, falseChance: 0.014, neutrinoChance: 0.026 }
};
const PARTICLE_STATS = {
  normal: { speed: 220, r: 5, track: 0, maxLife: 14 },
  light:  { speed: 460, r: 3, track: 0, maxLife: 14 },
  dark:   { speed: 130, r: 7, track: 5, maxLife: 14, trackForce: 180, maxTrackMul: 1.6 },
  anti:   { speed: 340, r: 5, track: 0, maxLife: 14 },
  energy: { speed: 115, r: 8, track: 0, maxLife: 16 },
  electron: { speed: 165, r: 5, track: 0, maxLife: 16 },
  falseQubit: { speed: 180, r: 9, track: 8, maxLife: 16, trackForce: 300, maxTrackMul: 2.15 },
  neutrino: { speed: 460, r: 3, track: 0, maxLife: 22, bounces: 4 }
};
const POWER_DEFS = {
  super: { unlock: 30, charges: 2, duration: 20 },
  schro: { unlock: 60, charges: 1, duration: 20 },
  decoh: { unlock: 90, charges: 1, duration: 15 }
};
const BLOCKED_NICK_EXACT = new Set([
  'kys',
  'kkk'
]);
const BLOCKED_NICK_PARTS = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'whore',
  'slut',
  'dick',
  'cock',
  'pussy',
  'asshole',
  'bastard',
  'butt',
  'lickedabutt',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'hitler',
  'nazi',
  'porn',
  'killyourself'
];
let leaderboard = { normal: [], hard: [], extraHard: [] };
let leaderboardChanged = false;
const runTokenSecret = loadRunTokenSecret();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LB_FILE) && fs.existsSync(LEGACY_LB_FILE) && path.resolve(LEGACY_LB_FILE) !== path.resolve(LB_FILE)) {
    fs.copyFileSync(LEGACY_LB_FILE, LB_FILE);
  }
  if (fs.existsSync(LB_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
    for (const m of MODES) leaderboard[m] = sanitizeLeaderboardRows(loaded[m]);
    if (leaderboardChanged) saveLeaderboard();
  }
} catch (e) {
  console.warn('[QUBIT] leaderboard storage unavailable, starting fresh');
}

function loadRunTokenSecret() {
  const envSecret = String(process.env.RUN_TOKEN_SECRET || '').trim();
  if (envSecret) return envSecret;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(RUN_TOKEN_SECRET_FILE)) {
      const existing = fs.readFileSync(RUN_TOKEN_SECRET_FILE, 'utf8').trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(RUN_TOKEN_SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('base64url');
  }
}

function normalizeNickname(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NICK_MAX);
}

function profanityKey(nick) {
  return nick
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[@4]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[7+]/g, 't')
    .replace(/[8]/g, 'b')
    .replace(/[^a-z0-9]/g, '');
}

function hasBlockedNickname(nick) {
  const compact = profanityKey(nick);
  const squashed = compact.replace(/(.)\1+/g, '$1');
  if (BLOCKED_NICK_EXACT.has(compact) || BLOCKED_NICK_EXACT.has(squashed)) return true;
  return BLOCKED_NICK_PARTS.some(part => compact.includes(part) || squashed.includes(part));
}

function validateNickname(raw) {
  const nick = normalizeNickname(raw);
  if (!nick) return { ok: false, reason: 'nickname required' };
  if (!NICK_ALLOWED_RE.test(nick)) {
    return { ok: false, reason: 'use letters, numbers, spaces, _, -, or .' };
  }
  if (hasBlockedNickname(nick)) return { ok: false, reason: 'nickname not allowed' };
  return { ok: true, nick };
}

function shouldBlockModerationResult(result) {
  if (!result || !result.categories) return Boolean(result && result.flagged);
  if (result.flagged) return true;
  return [...OPENAI_MODERATION_BLOCK_CATEGORIES].some(category => result.categories[category]);
}

function getModerationCache(key) {
  if (!OPENAI_MODERATION_CACHE_TTL_MS) return null;
  const cached = nicknameModerationCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.when > OPENAI_MODERATION_CACHE_TTL_MS) {
    nicknameModerationCache.delete(key);
    return null;
  }
  return cached.result;
}

function setModerationCache(key, result) {
  if (!OPENAI_MODERATION_CACHE_TTL_MS) return;
  nicknameModerationCache.set(key, { when: Date.now(), result });
  if (nicknameModerationCache.size > 500) {
    const oldest = nicknameModerationCache.keys().next().value;
    if (oldest !== undefined) nicknameModerationCache.delete(oldest);
  }
}

async function moderateNicknameWithOpenAI(nick) {
  if (!OPENAI_API_KEY) return { ok: true, skipped: true };

  const cacheKey = profanityKey(nick);
  const cached = getModerationCache(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_MODERATION_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODERATION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODERATION_MODEL,
        input: nick
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI moderation ${response.status}: ${detail.slice(0, 160)}`);
    }

    const data = await response.json();
    const blocked = shouldBlockModerationResult(data && data.results && data.results[0]);
    const result = blocked ? { ok: false, reason: 'nickname not allowed' } : { ok: true };
    setModerationCache(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[QUBIT] OpenAI nickname moderation failed:', err && err.message ? err.message : err);
    if (OPENAI_MODERATION_FAIL_OPEN) return { ok: true, skipped: true };
    return { ok: false, reason: 'nickname moderation unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

async function validateNicknameForPublicUse(raw) {
  const checked = validateNickname(raw);
  if (!checked.ok) return checked;
  const moderated = await moderateNicknameWithOpenAI(checked.nick);
  if (!moderated.ok) return moderated;
  return checked;
}

async function nicknameOrDefault(raw) {
  const checked = await validateNicknameForPublicUse(raw);
  if (checked.ok) return checked;
  return { ok: false, nick: 'qubit', reason: checked.reason };
}

function sanitizeLeaderboardRows(rows) {
  if (!Array.isArray(rows)) {
    leaderboardChanged = true;
    return [];
  }
  const cleaned = [];
  for (const row of rows) {
    const nick = validateNickname(row && row.nick);
    const time = Number(row && row.time);
    if (!nick.ok || !isFinite(time) || time <= 0 || time > SCORE_MAX_SECONDS) {
      leaderboardChanged = true;
      continue;
    }
    const near = Math.max(0, Math.floor(Number(row.near) || 0));
    const when = Number(row.when) || Date.now();
    const next = { nick: nick.nick, time: +time.toFixed(2), near, when };
    if (JSON.stringify(next) !== JSON.stringify(row)) leaderboardChanged = true;
    cleaned.push(next);
  }
  cleaned.sort((a, b) => b.time - a.time);
  return cleaned.slice(0, 50);
}

function saveLeaderboard() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${LB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(leaderboard, null, 2));
    fs.renameSync(tmpFile, LB_FILE);
  } catch {}
}
function topN(mode) {
  return (leaderboard[mode] || []).slice(0, TOP_N);
}

function clampReplayDimension(value, fallback) {
  const n = Math.round(Number(value));
  if (!isFinite(n)) return fallback;
  return Math.max(320, Math.min(4096, n));
}

function makeRng(seed) {
  return { seed: (Number(seed) >>> 0) || 1 };
}

function seededRandom(rng) {
  rng.seed = (rng.seed + 0x6D2B79F5) >>> 0;
  let t = rng.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function particleStats(type) {
  return PARTICLE_STATS[type] || PARTICLE_STATS.normal;
}

function spawnReplayParticle(particles, rng, mode, width, height) {
  const cfg = MODE_CONFIG[mode];
  const roll = seededRandom(rng);
  const energyChance = cfg.energyChance || 0;
  const electronChance = cfg.electronChance || 0;
  const falseChance = cfg.falseChance || 0;
  const neutrinoChance = cfg.neutrinoChance || 0;
  let type;
  if (roll < energyChance) type = 'energy';
  else if (roll < energyChance + electronChance) type = 'electron';
  else if (roll < energyChance + electronChance + falseChance) type = 'falseQubit';
  else if (roll < energyChance + electronChance + falseChance + neutrinoChance) type = 'neutrino';
  else if (roll < energyChance + electronChance + falseChance + neutrinoChance + cfg.antimatterChance) type = 'anti';
  else if (roll < energyChance + electronChance + falseChance + neutrinoChance + cfg.antimatterChance + cfg.lightChance) type = 'light';
  else if (roll < energyChance + electronChance + falseChance + neutrinoChance + cfg.antimatterChance + cfg.lightChance + cfg.darkChance) type = 'dark';
  else type = 'normal';

  const side = Math.floor(seededRandom(rng) * 4);
  const margin = 30;
  let x, y, ang;
  if (side === 0)      { x = -margin;       y = seededRandom(rng) * height; ang = (seededRandom(rng) - 0.5) * 0.9; }
  else if (side === 1) { x = width + margin; y = seededRandom(rng) * height; ang = Math.PI + (seededRandom(rng) - 0.5) * 0.9; }
  else if (side === 2) { x = seededRandom(rng) * width; y = -margin;        ang = Math.PI / 2 + (seededRandom(rng) - 0.5) * 0.9; }
  else                 { x = seededRandom(rng) * width; y = height + margin; ang = -Math.PI / 2 + (seededRandom(rng) - 0.5) * 0.9; }

  const stats = particleStats(type);
  const speed = stats.speed * (cfg.speedMul || 1);
  particles.push({
    type, x, y,
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    r: stats.r,
    life: 0,
    maxLife: stats.maxLife,
    trackUntil: stats.track || 0,
    bouncesLeft: stats.bounces || 0,
    enteredField: false,
    baseSpeed: speed
  });
}

function updateReplayNeutrino(p, rng, width, height) {
  if (p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) p.enteredField = true;
  if (!p.enteredField) return;

  let side = '';
  if (p.x < 0) { p.x = 0; side = 'left'; }
  else if (p.x > width) { p.x = width; side = 'right'; }
  if (p.y < 0) { p.y = 0; side = side || 'top'; }
  else if (p.y > height) { p.y = height; side = side || 'bottom'; }
  if (!side) return;

  if (p.bouncesLeft <= 0) {
    p.remove = true;
    return;
  }

  p.bouncesLeft--;
  let ang;
  if (side === 'left') ang = -Math.PI / 2 + seededRandom(rng) * Math.PI;
  else if (side === 'right') ang = Math.PI / 2 + seededRandom(rng) * Math.PI;
  else if (side === 'top') ang = seededRandom(rng) * Math.PI;
  else ang = Math.PI + seededRandom(rng) * Math.PI;
  const speed = Math.max(1, p.baseSpeed || particleStats('neutrino').speed);
  p.vx = Math.cos(ang) * speed;
  p.vy = Math.sin(ang) * speed;
}

function sanitizeReplaySamples(samples, time, width, height) {
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > REPLAY_MAX_SAMPLES) {
    return { ok: false, reason: 'bad anti-cheat samples' };
  }
  const out = [];
  let prevT = -1;
  for (const raw of samples) {
    if (!Array.isArray(raw) || raw.length < 3) return { ok: false, reason: 'bad anti-cheat samples' };
    const t = Number(raw[0]) / 100;
    const x = Number(raw[1]);
    const y = Number(raw[2]);
    if (!isFinite(t) || !isFinite(x) || !isFinite(y)) return { ok: false, reason: 'bad anti-cheat samples' };
    if (t < -0.01 || t < prevT) return { ok: false, reason: 'bad anti-cheat timing' };
    if (prevT >= 0 && t - prevT > REPLAY_MAX_GAP_SECONDS) return { ok: false, reason: 'anti-cheat sample gap' };
    if (x < -20 || x > width + 20 || y < -20 || y > height + 20) return { ok: false, reason: 'anti-cheat position out of bounds' };
    out.push({ t, x, y });
    prevT = t;
  }
  if (out[0].t > 0.35) return { ok: false, reason: 'anti-cheat proof starts late' };
  if (out[out.length - 1].t < time - 0.5) return { ok: false, reason: 'anti-cheat proof ends early' };
  return { ok: true, samples: out };
}

function qubitAt(samples, t, cursor) {
  while (cursor.i < samples.length - 2 && samples[cursor.i + 1].t < t) cursor.i++;
  const a = samples[cursor.i];
  const b = samples[Math.min(cursor.i + 1, samples.length - 1)];
  if (!b || b.t <= a.t) return { x: a.x, y: a.y };
  const f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

function prepareReplayPowers(rawPowers) {
  if (!Array.isArray(rawPowers)) return [];
  const events = [];
  for (const raw of rawPowers.slice(0, 20)) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const t = Number(raw[0]) / 100;
    const id = String(raw[1] || '');
    if (isFinite(t) && POWER_DEFS[id]) events.push({ t, id });
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

function validateReplayPowerEvent(powerState, event) {
  const def = POWER_DEFS[event.id];
  const ps = powerState[event.id];
  if (!def || !ps) return false;
  if (!ps.unlocked || ps.charges <= 0) return false;
  if (def.duration > 0 && event.t < ps.activeUntil) return false;
  ps.charges -= 1;
  ps.activeUntil = def.duration > 0 ? event.t + def.duration : event.t;
  return true;
}

function validateReplayProof(run, mode, time, proof) {
  if (!run || !run.seed) return { ok: false, reason: 'anti-cheat seed missing' };
  if (!proof || typeof proof !== 'object') return { ok: false, reason: 'anti-cheat proof missing' };
  if (Number(proof.v) !== REPLAY_VERSION) return { ok: false, reason: 'anti-cheat proof outdated' };
  if (String(proof.mode || '') !== mode) return { ok: false, reason: 'anti-cheat mode mismatch' };
  const seed = Number(proof.seed) >>> 0;
  if (!seed || seed !== (Number(run.seed) >>> 0)) return { ok: false, reason: 'anti-cheat seed mismatch' };

  const width = clampReplayDimension(run.width, 900);
  const height = clampReplayDimension(run.height, 600);
  if (clampReplayDimension(proof.w, width) !== width || clampReplayDimension(proof.h, height) !== height) {
    return { ok: false, reason: 'anti-cheat field mismatch' };
  }

  const checkedSamples = sanitizeReplaySamples(proof.samples, time, width, height);
  if (!checkedSamples.ok) return checkedSamples;
  const samples = checkedSamples.samples;
  const powerEvents = prepareReplayPowers(proof.powers);
  const powerState = {};
  for (const id of Object.keys(POWER_DEFS)) powerState[id] = { charges: 0, unlocked: false, activeUntil: 0 };

  const cfg = MODE_CONFIG[mode];
  const rng = makeRng(seed);
  const particles = [];
  const cursor = { i: 0 };
  let nextSpawnAt = 0;
  let powerIdx = 0;
  const qubitR = 9;
  const endT = Math.max(0, time - 0.08);

  for (let simT = 0; simT <= endT; simT += REPLAY_DT) {
    const q = qubitAt(samples, simT, cursor);

    for (const [id, def] of Object.entries(POWER_DEFS)) {
      const ps = powerState[id];
      if (!ps.unlocked && simT >= def.unlock) {
        ps.unlocked = true;
        ps.charges = def.charges;
      }
    }
    while (powerIdx < powerEvents.length && powerEvents[powerIdx].t <= simT + REPLAY_DT * 0.5) {
      if (!validateReplayPowerEvent(powerState, powerEvents[powerIdx])) {
        return { ok: false, reason: 'anti-cheat power mismatch' };
      }
      powerIdx++;
    }

    if (simT >= nextSpawnAt) {
      spawnReplayParticle(particles, rng, mode, width, height);
      const ramp = Math.max(0.5, 1 / (1 + (simT / 60) * 0.10));
      nextSpawnAt = simT + cfg.spawn * ramp * (0.6 + seededRandom(rng) * 0.8);
    }

    const schroActive = simT < powerState.schro.activeUntil;
    const decohActive = simT < powerState.decoh.activeUntil;
    const speedMul = decohActive ? 0.35 : 1.0;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const stats = particleStats(p.type);
      p.life += REPLAY_DT;
      if ((p.type === 'dark' || p.type === 'falseQubit') && p.life < p.trackUntil) {
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        const force = stats.trackForce || 180;
        p.vx += (dx / d) * force * REPLAY_DT;
        p.vy += (dy / d) * force * REPLAY_DT;
        const sp = Math.hypot(p.vx, p.vy);
        const maxSp = p.baseSpeed * (stats.maxTrackMul || 1.6);
        if (sp > maxSp) {
          p.vx = (p.vx / sp) * maxSp;
          p.vy = (p.vy / sp) * maxSp;
        }
      }
      p.x += p.vx * REPLAY_DT * speedMul;
      p.y += p.vy * REPLAY_DT * speedMul;
      if (p.type === 'neutrino') updateReplayNeutrino(p, rng, width, height);
      if (p.remove || p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60 || p.life > p.maxLife) {
        particles.splice(i, 1);
        continue;
      }

      if (p.type !== 'electron') {
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const hitR = Math.max(1, p.r + qubitR - REPLAY_HIT_SLACK);
        if (dist < hitR && (!schroActive || p.type === 'dark' || p.type === 'energy' || p.type === 'falseQubit')) {
          return { ok: false, reason: 'server replay detected collision' };
        }
      }
    }
  }

  return { ok: true };
}

function isPublicStaticPath(routePath) {
  if (!routePath || routePath.includes('\0')) return false;
  const normalized = path.normalize(routePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  if (normalized.split(path.sep).some(part => part.startsWith('.'))) return false;
  if (PUBLIC_STATIC_FILES.has(normalized)) return true;
  const topLevel = normalized.split(path.sep)[0];
  return PUBLIC_STATIC_DIRS.includes(topLevel) && PUBLIC_STATIC_EXTS.has(path.extname(normalized).toLowerCase());
}

function pruneRunTokens(now = Date.now()) {
  for (const [token, run] of runTokens) {
    if (!run || run.expiresAt <= now) runTokens.delete(token);
  }
  for (const [token, expiresAt] of usedRunTokens) {
    if (!expiresAt || expiresAt <= now) usedRunTokens.delete(token);
  }
}

function createRunToken(mode, meta = {}) {
  pruneRunTokens();
  const now = Date.now();
  const seed = crypto.randomBytes(4).readUInt32LE(0) || 1;
  const width = clampReplayDimension(meta.width, 900);
  const height = clampReplayDimension(meta.height, 600);
  const payload = {
    v: 2,
    mode,
    seed,
    width,
    height,
    proof: REPLAY_VERSION,
    startedAt: now,
    expiresAt: now + RUN_TOKEN_TTL_MS,
    nonce: crypto.randomBytes(12).toString('base64url')
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', runTokenSecret).update(body).digest('base64url');
  const token = `${body}.${sig}`;
  return token;
}

function validateRunToken(token, mode, time) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, reason: 'missing run token' };
  if (raw.includes('.')) return validateSignedRunToken(raw, mode, time);
  const run = runTokens.get(raw);
  if (!run) return { ok: false, reason: 'run token expired' };
  const now = Date.now();
  if (run.expiresAt <= now) return { ok: false, reason: 'run token expired' };
  if (run.mode !== mode) return { ok: false, reason: 'run mode mismatch' };
  const elapsed = (now - run.startedAt) / 1000;
  if (time > elapsed + SCORE_GRACE_SECONDS) return { ok: false, reason: 'score does not match run timer' };
  return { ok: true, run, kind: 'legacy', key: raw, expiresAt: run.expiresAt };
}

function validateSignedRunToken(raw, mode, time) {
  const [body, sig] = raw.split('.');
  if (!body || !sig) return { ok: false, reason: 'bad run token' };
  const expected = crypto.createHmac('sha256', runTokenSecret).update(body).digest('base64url');
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expectedBuf, sigBuf)) {
    return { ok: false, reason: 'bad run token' };
  }
  let run;
  try {
    run = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad run token' };
  }
  const now = Date.now();
  if (!run || run.expiresAt <= now) return { ok: false, reason: 'run token expired' };
  if (usedRunTokens.has(sig)) return { ok: false, reason: 'run token already used' };
  if (run.mode !== mode) return { ok: false, reason: 'run mode mismatch' };
  const elapsed = (now - Number(run.startedAt || 0)) / 1000;
  if (!isFinite(elapsed) || elapsed < 0) return { ok: false, reason: 'bad run token' };
  if (time > elapsed + SCORE_GRACE_SECONDS) return { ok: false, reason: 'score does not match run timer' };
  return { ok: true, run, kind: 'signed', key: sig, expiresAt: Number(run.expiresAt) };
}

function consumeRunToken(runCheck) {
  if (!runCheck || !runCheck.ok) return false;
  if (runCheck.kind === 'legacy') {
    const run = runTokens.get(runCheck.key);
    if (!run) return false;
    runTokens.delete(runCheck.key);
    return true;
  }
  if (runCheck.kind === 'signed') {
    if (usedRunTokens.has(runCheck.key)) return false;
    usedRunTokens.set(runCheck.key, runCheck.expiresAt);
    return true;
  }
  return false;
}

function jsonResp(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(body));
}

function readJsonRequest(req, res, maxBytes, cb) {
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > maxBytes) req.destroy();
  });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body || '{}'); } catch { return jsonResp(res, 400, { ok: false, reason: 'bad json' }); }
    Promise.resolve(cb(data)).catch(err => {
      console.error('[QUBIT] request handler failed:', err);
      if (!res.writableEnded) jsonResp(res, 500, { ok: false, reason: 'server error' });
    });
  });
}

// HTTP server: static files + leaderboard API
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const url = parsedUrl.pathname;

  if (url.startsWith('/api/poll/') && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  if (url === '/api/poll/open' && req.method === 'POST') return handlePollOpen(req, res);
  if (url === '/api/poll/send' && req.method === 'POST') return handlePollSend(req, res);
  if (url === '/api/poll/events' && req.method === 'GET') return handlePollEvents(req, res, parsedUrl);
  if (url === '/api/poll/close' && req.method === 'POST') return handlePollClose(req, res);

  if (url === '/api/leaderboard' && req.method === 'GET') {
    const out = {};
    for (const m of MODES) out[m] = topN(m);
    return jsonResp(res, 200, out);
  }

  if (url === '/api/run/start' && req.method === 'POST') {
    readJsonRequest(req, res, 4096, data => {
      const mode = String(data.mode || '');
      if (!MODES.includes(mode)) return jsonResp(res, 400, { ok: false, reason: 'bad mode' });
      const width = clampReplayDimension(data.width, 900);
      const height = clampReplayDimension(data.height, 600);
      const token = createRunToken(mode, { width, height });
      const [body] = token.split('.');
      const run = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return jsonResp(res, 200, {
        ok: true,
        token,
        seed: run.seed,
        width: run.width,
        height: run.height,
        proof: REPLAY_VERSION,
        maxSeconds: SCORE_MAX_SECONDS
      });
    });
    return;
  }

  if (url === '/api/score' && req.method === 'POST') {
    readJsonRequest(req, res, REPLAY_MAX_BYTES, async data => {
      const mode = String(data.mode || '');
      const nick = await validateNicknameForPublicUse(data.nick);
      const time = Number(data.time);
      const near = Math.max(0, Math.floor(Number(data.near) || 0));
      if (!MODES.includes(mode)) return jsonResp(res, 400, { ok: false, reason: 'bad mode' });
      if (!nick.ok) return jsonResp(res, 400, { ok: false, reason: nick.reason });
      if (!isFinite(time) || time <= 0 || time > SCORE_MAX_SECONDS) return jsonResp(res, 400, { ok: false, reason: 'bad time' });
      const runCheck = validateRunToken(data.runToken, mode, time);
      if (!runCheck.ok) return jsonResp(res, 400, { ok: false, reason: runCheck.reason });
      const replayCheck = validateReplayProof(runCheck.run, mode, time, data.proof);
      if (!replayCheck.ok) return jsonResp(res, 400, { ok: false, reason: replayCheck.reason });
      if (!consumeRunToken(runCheck)) return jsonResp(res, 400, { ok: false, reason: 'run token already used' });
      const entry = { nick: nick.nick, time: +time.toFixed(2), near, when: Date.now() };
      leaderboard[mode].push(entry);
      leaderboard[mode].sort((a, b) => b.time - a.time);
      leaderboard[mode] = leaderboard[mode].slice(0, 50); // keep more than we display
      saveLeaderboard();
      const rank = leaderboard[mode].findIndex(e => e === entry) + 1;
      return jsonResp(res, 200, { ok: true, rank, top: topN(mode), inTop: rank <= TOP_N });
    });
    return;
  }

  // Static files are allowlisted so backend code and project metadata stay private.
  let routePath;
  try {
    routePath = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, { 'Cache-Control': 'no-store' });
    res.end('bad path');
    return;
  }
  if (!isPublicStaticPath(routePath)) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('not found');
    return;
  }
  const full = path.resolve(__dirname, routePath);
  if (full !== __dirname && !full.startsWith(`${__dirname}${path.sep}`)) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': mime, 'Cache-Control': 'no-store' };
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

const players = new Map();        // id -> { id, ws, nick, code, matchId }
const codes = new Map();          // code -> id
const matches = new Map();        // matchId -> { p1, p2, mode }
const pendingInvites = new Map(); // inviteId -> { from, to, mode, role }

const CHARS = 'abcdefghijklmnopqrstuvwxyz23456789'; // no 01ol for legibility
const POLL_TIMEOUT_MS = 25000;
const POLL_MAX_EVENTS = 50;
const POLL_STALE_MS = 65000;

function genCode() {
  for (let i = 0; i < 200; i++) {
    let c = '';
    for (let j = 0; j < 5; j++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
    if (!codes.has(c)) return c;
  }
  return crypto.randomBytes(3).toString('hex');
}

function send(ws, msg) {
  if (!ws) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    if (ws.isPollTransport) ws.send(msg);
    else ws.send(JSON.stringify(msg));
  } catch {}
}

function createPollTransport() {
  return {
    isPollTransport: true,
    readyState: WebSocket.OPEN,
    queue: [],
    waiters: [],
    send(msg) {
      this.queue.push(msg);
      flushPollTransport(this);
    },
    close() {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CLOSED;
      for (const done of this.waiters.splice(0)) done([]);
    }
  };
}

function drainPollEvents(transport) {
  return transport.queue.splice(0, POLL_MAX_EVENTS);
}

function flushPollTransport(transport) {
  while (transport.waiters.length && transport.queue.length) {
    const done = transport.waiters.shift();
    done(drainPollEvents(transport));
  }
}

function pollPlayer(id) {
  const player = players.get(String(id || ''));
  if (!player || !player.ws || !player.ws.isPollTransport) return null;
  player.lastSeen = Date.now();
  return player;
}

function handlePollOpen(req, res) {
  readJsonRequest(req, res, 4096, async data => {
    const transport = createPollTransport();
    const ctx = { ws: transport, player: null };
    await handleClientMessage(ctx, { t: 'hello', nick: data.nick });
    if (!ctx.player) return jsonResp(res, 500, { ok: false, reason: 'could not open session' });
    ctx.player.transport = 'poll';
    ctx.player.lastSeen = Date.now();
    jsonResp(res, 200, { ok: true, id: ctx.player.id, events: drainPollEvents(transport) });
  });
}

function handlePollSend(req, res) {
  readJsonRequest(req, res, 8192, async data => {
    const player = pollPlayer(data.id);
    if (!player) return jsonResp(res, 404, { ok: false, reason: 'session not found' });
    if (!data.msg || typeof data.msg !== 'object') return jsonResp(res, 400, { ok: false, reason: 'bad message' });
    await handleClientMessage({ ws: player.ws, player }, data.msg);
    jsonResp(res, 200, { ok: true, events: drainPollEvents(player.ws) });
  });
}

function handlePollEvents(req, res, parsedUrl) {
  const player = pollPlayer(parsedUrl.searchParams.get('id'));
  if (!player) return jsonResp(res, 404, { ok: false, reason: 'session not found' });
  const transport = player.ws;
  const events = drainPollEvents(transport);
  if (events.length) return jsonResp(res, 200, { ok: true, events });

  let active = true;
  const done = nextEvents => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    const idx = transport.waiters.indexOf(done);
    if (idx >= 0) transport.waiters.splice(idx, 1);
    if (!res.writableEnded) jsonResp(res, 200, { ok: true, events: nextEvents });
  };
  const timer = setTimeout(() => done([]), POLL_TIMEOUT_MS);
  req.on('close', () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    const idx = transport.waiters.indexOf(done);
    if (idx >= 0) transport.waiters.splice(idx, 1);
  });
  transport.waiters.push(done);
}

function handlePollClose(req, res) {
  readJsonRequest(req, res, 4096, data => {
    const player = pollPlayer(data.id);
    if (player) closeClient({ player });
    jsonResp(res, 200, { ok: true });
  });
}

function lobbyList() {
  return [...players.values()]
    .filter(p => !p.matchId)
    .map(p => ({ id: p.id, nick: p.nick, code: p.code }));
}

function broadcastLobby() {
  const msg = { t: 'lobby', players: lobbyList() };
  for (const p of players.values()) {
    if (!p.matchId) send(p.ws, msg);
  }
}

function otherRole(mode, role) {
  if (mode === 'qvm') return role === 'qubit' ? 'matter' : 'qubit';
  return 'p2';
}

function endMatch(matchId, reason) {
  const m = matches.get(matchId);
  if (!m) return;
  for (const pid of [m.p1, m.p2]) {
    const p = players.get(pid);
    if (p) {
      p.matchId = null;
      send(p.ws, { t: 'match-end', reason });
    }
  }
  matches.delete(matchId);
  broadcastLobby();
}

async function handleClientMessage(ctx, msg) {
  const ws = ctx.ws;

  if (msg.t === 'hello') {
    const checkedNick = await nicknameOrDefault(msg.nick || 'qubit');
    if (ctx.player) {
      if (!checkedNick.ok) {
        send(ws, { t: 'nick-error', reason: checkedNick.reason, nick: ctx.player.nick });
        return;
      }
      ctx.player.nick = checkedNick.nick;
      send(ws, { t: 'renamed', nick: checkedNick.nick });
      broadcastLobby();
      return;
    }
    const id = crypto.randomUUID();
    const code = genCode();
    ctx.player = { id, ws, nick: checkedNick.nick, code, matchId: null, transport: ws.isPollTransport ? 'poll' : 'ws', lastSeen: Date.now() };
    players.set(id, ctx.player);
    codes.set(code, id);
    send(ws, { t: 'welcome', id, code, nick: checkedNick.nick });
    if (!checkedNick.ok) send(ws, { t: 'nick-error', reason: checkedNick.reason, nick: checkedNick.nick });
    broadcastLobby();
    return;
  }
  const player = ctx.player;
  if (!player) return;
  player.lastSeen = Date.now();

  if (msg.t === 'invite') {
    let target = null;
    if (msg.to) {
      if (msg.to.length === 5) target = players.get(codes.get(msg.to.toLowerCase()));
      if (!target) target = players.get(msg.to);
    }
    if (!target) { send(ws, { t: 'invite-fail', reason: 'NOT FOUND' }); return; }
    if (target.id === player.id) { send(ws, { t: 'invite-fail', reason: 'CANNOT INVITE SELF' }); return; }
    if (target.matchId) { send(ws, { t: 'invite-fail', reason: target.nick + ' IS BUSY' }); return; }
    if (player.matchId) { send(ws, { t: 'invite-fail', reason: 'YOU ARE IN MATCH' }); return; }
    const matchMode = msg.mode === 'qvm' ? 'qvm' : 'competition';
    const role = msg.role === 'matter' ? 'matter' : 'qubit';
    const difficulty = MODES.includes(msg.difficulty) ? msg.difficulty : 'normal';
    const inviteId = crypto.randomUUID();
    pendingInvites.set(inviteId, { from: player.id, to: target.id, mode: matchMode, role, difficulty });
    setTimeout(() => pendingInvites.delete(inviteId), 30000);
    send(target.ws, {
      t: 'invite', inviteId,
      fromId: player.id, fromNick: player.nick,
      mode: matchMode, role, difficulty
    });
    send(ws, { t: 'invite-sent', toNick: target.nick });
    return;
  }

  if (msg.t === 'accept') {
    const inv = pendingInvites.get(msg.inviteId);
    if (!inv || inv.to !== player.id) return;
    pendingInvites.delete(msg.inviteId);
    const inviter = players.get(inv.from);
    if (!inviter || inviter.matchId || player.matchId) {
      send(ws, { t: 'match-fail', reason: 'UNAVAILABLE' });
      return;
    }
    const matchId = crypto.randomUUID();
    inviter.matchId = matchId;
    player.matchId = matchId;
    matches.set(matchId, { p1: inviter.id, p2: player.id, mode: inv.mode });
    const inviterRole = inv.mode === 'qvm' ? inv.role : 'p1';
    const accepterRole = inv.mode === 'qvm' ? otherRole('qvm', inv.role) : 'p2';
    send(inviter.ws, {
      t: 'match', matchId, mode: inv.mode, role: inviterRole,
      peerNick: player.nick, peerId: player.id, isHost: true, difficulty: inv.difficulty
    });
    send(ws, {
      t: 'match', matchId, mode: inv.mode, role: accepterRole,
      peerNick: inviter.nick, peerId: inviter.id, isHost: false, difficulty: inv.difficulty
    });
    broadcastLobby();
    return;
  }

  if (msg.t === 'decline') {
    const inv = pendingInvites.get(msg.inviteId);
    if (!inv) return;
    pendingInvites.delete(msg.inviteId);
    const inviter = players.get(inv.from);
    if (inviter) send(inviter.ws, { t: 'declined', nick: player.nick });
    return;
  }

  if (msg.t === 'relay' && player.matchId) {
    const m = matches.get(player.matchId);
    if (!m) return;
    const peerId = m.p1 === player.id ? m.p2 : m.p1;
    const peer = players.get(peerId);
    if (peer) send(peer.ws, { t: 'relay', data: msg.data });
    return;
  }

  if (msg.t === 'leave-match' && player.matchId) {
    endMatch(player.matchId, 'PEER LEFT');
    return;
  }

  if (msg.t === 'rename') {
    const checkedNick = await validateNicknameForPublicUse(msg.nick);
    if (!checkedNick.ok) {
      send(ws, { t: 'nick-error', reason: checkedNick.reason, nick: player.nick });
      return;
    }
    player.nick = checkedNick.nick;
    send(ws, { t: 'renamed', nick: checkedNick.nick });
    broadcastLobby();
  }
}

function closeClient(ctx) {
  const player = ctx.player;
  if (!player) return;
  ctx.player = null;
  codes.delete(player.code);
  players.delete(player.id);
  if (player.ws && player.ws.isPollTransport) player.ws.close();
  if (player.matchId) endMatch(player.matchId, 'PEER DISCONNECTED');
  broadcastLobby();
}

wss.on('connection', ws => {
  const ctx = { ws, player: null };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleClientMessage(ctx, msg).catch(err => console.error('[QUBIT] websocket handler failed:', err));
  });

  ws.on('close', () => closeClient(ctx));
});

const pollCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const player of [...players.values()]) {
    if (player.transport === 'poll' && now - (player.lastSeen || 0) > POLL_STALE_MS) {
      closeClient({ player });
    }
  }
}, 30000);
if (pollCleanupTimer.unref) pollCleanupTimer.unref();

server.listen(PORT, () => {
  console.log(`[THE QUBIT] server running:`);
  console.log(`  Game:      http://localhost:${PORT}/`);
  console.log(`  WebSocket: ws://localhost:${PORT}/`);
});
