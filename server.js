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

// ---- Leaderboard storage ----
const LB_FILE = path.join(__dirname, 'leaderboard.json');
const MODES = ['easy', 'normal', 'hard'];
const TOP_N = 10;
const SCORE_MAX_SECONDS = 3600;
const SCORE_GRACE_SECONDS = Math.max(1, Number(process.env.SCORE_GRACE_SECONDS) || 4);
const RUN_TOKEN_TTL_MS = Math.max(60000, Number(process.env.RUN_TOKEN_TTL_MS) || (SCORE_MAX_SECONDS + 60) * 1000);
const NICK_MAX = 18;
const NICK_ALLOWED_RE = /^[a-z0-9 _.-]+$/i;
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
let leaderboard = { easy: [], normal: [], hard: [] };
let leaderboardChanged = false;
try {
  if (fs.existsSync(LB_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
    for (const m of MODES) leaderboard[m] = sanitizeLeaderboardRows(loaded[m]);
    if (leaderboardChanged) saveLeaderboard();
  }
} catch (e) {
  console.warn('[QUBIT] leaderboard.json unreadable, starting fresh');
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
  try { fs.writeFileSync(LB_FILE, JSON.stringify(leaderboard, null, 2)); } catch {}
}
function topN(mode) {
  return (leaderboard[mode] || []).slice(0, TOP_N);
}

function pruneRunTokens(now = Date.now()) {
  for (const [token, run] of runTokens) {
    if (!run || run.expiresAt <= now) runTokens.delete(token);
  }
}

function createRunToken(mode) {
  pruneRunTokens();
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  runTokens.set(token, {
    mode,
    startedAt: now,
    expiresAt: now + RUN_TOKEN_TTL_MS
  });
  if (runTokens.size > 5000) {
    const oldest = runTokens.keys().next().value;
    if (oldest !== undefined) runTokens.delete(oldest);
  }
  return token;
}

function validateRunToken(token, mode, time) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, reason: 'missing run token' };
  const run = runTokens.get(raw);
  runTokens.delete(raw);
  if (!run) return { ok: false, reason: 'run token expired' };
  const now = Date.now();
  if (run.expiresAt <= now) return { ok: false, reason: 'run token expired' };
  if (run.mode !== mode) return { ok: false, reason: 'run mode mismatch' };
  const elapsed = (now - run.startedAt) / 1000;
  if (time > elapsed + SCORE_GRACE_SECONDS) return { ok: false, reason: 'score does not match run timer' };
  return { ok: true };
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
      return jsonResp(res, 200, {
        ok: true,
        token: createRunToken(mode),
        maxSeconds: SCORE_MAX_SECONDS
      });
    });
    return;
  }

  if (url === '/api/score' && req.method === 'POST') {
    readJsonRequest(req, res, 4096, async data => {
      const mode = String(data.mode || '');
      const nick = await validateNicknameForPublicUse(data.nick);
      const time = Number(data.time);
      const near = Math.max(0, Math.floor(Number(data.near) || 0));
      if (!MODES.includes(mode)) return jsonResp(res, 400, { ok: false, reason: 'bad mode' });
      if (!nick.ok) return jsonResp(res, 400, { ok: false, reason: nick.reason });
      if (!isFinite(time) || time <= 0 || time > SCORE_MAX_SECONDS) return jsonResp(res, 400, { ok: false, reason: 'bad time' });
      const runCheck = validateRunToken(data.runToken, mode, time);
      if (!runCheck.ok) return jsonResp(res, 400, { ok: false, reason: runCheck.reason });
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

  // Static files
  let p = url;
  if (p === '/') p = '/index.html';
  const full = path.join(__dirname, p);
  if (!full.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  // Don't serve the leaderboard file directly
  if (path.basename(full) === 'leaderboard.json') { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': mime };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache';
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
    const inviteId = crypto.randomUUID();
    pendingInvites.set(inviteId, { from: player.id, to: target.id, mode: msg.mode, role: msg.role, difficulty: msg.difficulty });
    setTimeout(() => pendingInvites.delete(inviteId), 30000);
    send(target.ws, {
      t: 'invite', inviteId,
      fromId: player.id, fromNick: player.nick,
      mode: msg.mode, role: msg.role, difficulty: msg.difficulty
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
