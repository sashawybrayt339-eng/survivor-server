// بازمانده - سرور چندنفره (بدون وابستگی خارجی)
// اجرا: node server.js   |   روی Render: start = node server.js
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 10;          // ظرفیت هر سرور
const STALE_MS = 10000;          // بازیکنی که ۱۰ ثانیه صدایی نداده، بیرون می‌رود
const SEND_LIMIT_PER_SEC = 20;   // محدودیت ارسال هر بازیکن
const MAX_BODY = 4096;

// سه سرور عمومی. ورود مستقیم بدون کد: کلاینت فقط id را می‌فرستد.
const SERVERS = [
  { id: 'iran1', name: 'Iran#1', rate: 'منابع 1X' },
  { id: 'iran2', name: 'Iran#2', rate: 'منابع 1X' },
  { id: 'iran3', name: 'Iran#3', rate: 'منابع 1X' },
];

// roomId -> Map(token -> player)
const rooms = new Map();
for (const s of SERVERS) rooms.set(s.id, new Map());

function cleanup() {
  const t = Date.now();
  for (const room of rooms.values()) {
    for (const [token, p] of room) {
      if (t - p.seen > STALE_MS) room.delete(token);
    }
  }
}
setInterval(cleanup, 2000).unref();

function findPlayer(token) {
  if (typeof token !== 'string' || token.length !== 32) return null;
  for (const [roomId, room] of rooms) {
    const p = room.get(token);
    if (p) return { roomId, room, p };
  }
  return null;
}

function cleanName(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 16) : '';
  return s.length ? s : 'بازیکن';
}

function num(v, limit = 100000) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : 0;
}

function serverInfo(s) {
  const room = rooms.get(s.id);
  return { id: s.id, name: s.name, rate: s.rate, players: room.size, max: MAX_PLAYERS, full: room.size >= MAX_PLAYERS };
}

function joinRoom(roomId, name) {
  const room = rooms.get(roomId);
  if (room.size >= MAX_PLAYERS) return null;
  const token = crypto.randomBytes(16).toString('hex');
  const id = crypto.randomBytes(3).toString('hex');
  room.set(token, {
    id, name, x: 0, y: 0, z: 0, ry: 0, anim: 'idle',
    seen: Date.now(), windowStart: Date.now(), windowCount: 0,
  });
  return { token, id };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (req.method === 'GET' && url.pathname === '/servers') {
      return send(res, 200, { servers: SERVERS.map(serverInfo) });
    }

    // ورود خودکار: پرجمعیت‌ترین سرورِ غیرپر، تا بازیکن‌ها جمع شوند و سرورهای خالی نمانند.
    if (req.method === 'POST' && url.pathname === '/quickjoin') {
      const body = await readJson(req);
      const name = cleanName(body.name);
      const candidates = SERVERS.map(serverInfo).filter((s) => !s.full).sort((a, b) => b.players - a.players);
      if (!candidates.length) return send(res, 503, { error: 'all_full' });
      const joined = joinRoom(candidates[0].id, name);
      if (!joined) return send(res, 503, { error: 'all_full' });
      return send(res, 200, { server: candidates[0].id, token: joined.token, id: joined.id });
    }

    if (req.method === 'POST' && url.pathname === '/join') {
      const body = await readJson(req);
      if (!rooms.has(body.server)) return send(res, 404, { error: 'unknown_server' });
      const joined = joinRoom(body.server, cleanName(body.name));
      if (!joined) return send(res, 409, { error: 'full' });
      return send(res, 200, { server: body.server, token: joined.token, id: joined.id });
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const body = await readJson(req);
      const f = findPlayer(body.token);
      if (!f) return send(res, 401, { error: 'not_in_room' });
      const t = Date.now();
      if (t - f.p.windowStart >= 1000) { f.p.windowStart = t; f.p.windowCount = 0; }
      if (++f.p.windowCount > SEND_LIMIT_PER_SEC) return send(res, 429, { error: 'slow_down' });
      f.p.x = num(body.x); f.p.y = num(body.y); f.p.z = num(body.z);
      f.p.ry = num(body.ry, 10);
      f.p.anim = typeof body.anim === 'string' ? body.anim.slice(0, 16) : 'idle';
      f.p.seen = t;
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/poll') {
      const f = findPlayer(url.searchParams.get('token'));
      if (!f) return send(res, 401, { error: 'not_in_room' });
      f.p.seen = Date.now();
      const others = [];
      for (const [token, p] of f.room) {
        if (token === url.searchParams.get('token')) continue;
        others.push({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, ry: p.ry, anim: p.anim });
      }
      return send(res, 200, { server: f.roomId, you: f.p.id, players: others });
    }

    if (req.method === 'POST' && url.pathname === '/leave') {
      const body = await readJson(req);
      const f = findPlayer(body.token);
      if (f) f.room.delete(body.token);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not_found' });
  } catch (e) {
    send(res, 400, { error: e.message || 'bad_request' });
  }
});

server.listen(PORT, () => console.log('server listening on', PORT));
