// موقع تفعيل روبلوكس - خادم Node.js بدون أي مكتبات خارجية (Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- المتغيرات (Railway Variables أو ملف .env محلي) ----------
// على Railway تُقرأ مباشرة من process.env. ملف .env اختياري للتشغيل المحلي فقط.
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

// ينظف القيمة من المسافات وعلامات الاقتباس (حتى لو الصقتها "هكذا")
const env = (k, def) => {
  let v = process.env[k];
  if (v === undefined || v === null) return def;
  v = String(v).trim().replace(/^(["'`])([\s\S]*)\1$/, '$2').trim();
  return v === '' ? def : v;
};

const C = {
  apiKey: env('ROBLOX_API_KEY'),
  universe: env('UNIVERSE_ID'),
  discordToken: env('DISCORD_BOT_TOKEN'),
  adminPassword: env('ADMIN_PASSWORD'),
  guildId: env('DISCORD_GUILD_ID'),
  secret: env('SESSION_SECRET') || crypto.createHash('sha256').update('s:' + (env('ADMIN_PASSWORD') || '') + (env('ROBLOX_API_KEY') || '')).digest('hex'),
  port: Number(env('PORT')) || 3000,
  wlStore: env('WHITELIST_STORE', 'ActivationWhitelist'),
  wlKey: env('WHITELIST_KEY', 'list'),
  lsStore: env('LASTSEEN_STORE', 'ActivationLastSeen'),
};
const REQUIRED = { ROBLOX_API_KEY: C.apiKey, UNIVERSE_ID: C.universe, DISCORD_BOT_TOKEN: C.discordToken, ADMIN_PASSWORD: C.adminPassword };
const missing = Object.keys(REQUIRED).filter(k => !REQUIRED[k]);
if (missing.length) { console.error('❌ متغيرات ناقصة (أضفها في Railway > Variables):', missing.join(', ')); process.exit(1); }
if (!/^\d+$/.test(C.universe)) { console.error('❌ UNIVERSE_ID يجب أن يكون أرقام فقط. القيمة الحالية غير صالحة.'); process.exit(1); }

// ---------- أدوات ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}
async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = (await r.text().catch(() => '')).slice(0, 200);
    const e = new Error(`HTTP ${r.status}`); e.status = r.status;
    e.detail = `${String(url).split('?')[0]} -> ${body}`;
    throw e;
  }
  return r.json();
}
const sign = (s) => crypto.createHmac('sha256', C.secret).update(s).digest('hex');
function makeToken() { const exp = Date.now() + 12 * 3600e3; return `${exp}.${sign(String(exp))}`; }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

// ---------- Roblox Open Cloud (DataStore) ----------
const dsBase = `https://apis.roblox.com/datastores/v1/universes/${C.universe}/standard-datastores/datastore/entries/entry`;
async function dsGet(store, key) {
  const r = await fetch(`${dsBase}?datastoreName=${encodeURIComponent(store)}&entryKey=${encodeURIComponent(key)}`, { headers: { 'x-api-key': C.apiKey } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`DataStore GET ${r.status}: ${await r.text()}`);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}
async function dsSet(store, key, value) {
  const body = JSON.stringify(value);
  const r = await fetch(`${dsBase}?datastoreName=${encodeURIComponent(store)}&entryKey=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'x-api-key': C.apiKey, 'content-type': 'application/json', 'content-md5': crypto.createHash('md5').update(body).digest('base64') },
    body,
  });
  if (!r.ok) throw new Error(`DataStore SET ${r.status}: ${await r.text()}`);
}
// قفل بسيط حتى لا تتداخل عمليات الكتابة
let lock = Promise.resolve();
function withLock(fn) { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run; }
async function readList() { const d = await dsGet(C.wlStore, C.wlKey); return d && Array.isArray(d.users) ? d.users : []; }

// ---------- Roblox العامة ----------
async function robloxThumbs(ids, size = '150x150') {
  if (!ids.length) return {};
  try {
  const j = await getJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(',')}&size=${size}&format=Png&isCircular=false`);
  const out = {}; for (const d of j.data || []) out[d.targetId] = d.imageUrl; return out;
  } catch (e) { console.error('thumbnails', e.message, e.detail || ''); return {}; }
}
async function robloxSearch(q) {
  const key = 'rs:' + q.toLowerCase();
  const found = await cached(key, 30e3, async () => {
    let list = [];
    // البحث العام: Roblox يقبل limit = 10 / 25 / 50 / 100 فقط، ويرفض الكلمات القصيرة جداً
    try {
      const j = await getJson(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(q)}&limit=25`);
      list = j.data || [];
    } catch (e) { if (e.status !== 400) throw e; }
    // تطابق تام مع الاسم (يفيد للأسماء القصيرة)
    try {
      const j = await getJson('https://users.roblox.com/v1/usernames/users', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usernames: [q], excludeBannedUsers: false }),
      });
      for (const u of j.data || []) if (!list.some(x => x.id === u.id)) list.unshift(u);
    } catch {}
    return list;
  });
  const users = found.slice(0, 24);
  const thumbs = await robloxThumbs(users.map(u => u.id));
  return users.map(u => ({ id: u.id, name: u.name, displayName: u.displayName, avatar: thumbs[u.id] || null }));
}
async function robloxProfile(id) {
  const u = await cached('rp:' + id, 60e3, () => getJson(`https://users.roblox.com/v1/users/${id}`));
  const thumbs = await robloxThumbs([id], '420x420');
  let lastSeen = null;
  try { lastSeen = await dsGet(C.lsStore, String(id)); } catch {}
  return {
    id: u.id, name: u.name, displayName: u.displayName, description: u.description,
    created: u.created, isBanned: u.isBanned, hasVerifiedBadge: u.hasVerifiedBadge,
    avatar: thumbs[id] || null,
    lastSeen: typeof lastSeen === 'number' ? lastSeen * 1000 : null, // آخر دخول للماب (ms)
  };
}

// ---------- Discord الرسمي ----------
const snowflakeDate = (id) => new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
async function discordApi(p) {
  return getJson(`https://discord.com/api/v10${p}`, { headers: { Authorization: `Bot ${C.discordToken}` } });
}
async function discordProfile(id) {
  return cached('dp:' + id, 10 * 60e3, async () => {
    const u = await discordApi(`/users/${id}`);
    const idx = Number((BigInt(u.id) >> 22n) % 6n);
    return {
      id: u.id, username: u.username, globalName: u.global_name,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256` : `https://cdn.discordapp.com/embed/avatars/${idx}.png`,
      banner: u.banner ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.png?size=600` : null,
      accentColor: u.accent_color != null ? '#' + u.accent_color.toString(16).padStart(6, '0') : null,
      created: snowflakeDate(u.id), bot: !!u.bot,
    };
  });
}
// رتب العضو داخل السيرفر المحدد في DISCORD_GUILD_ID
async function discordGuildInfo(userId) {
  if (!C.guildId) return null;
  try {
    const roles = await cached('gr:' + C.guildId, 5 * 60e3, () => discordApi(`/guilds/${C.guildId}/roles`));
    const member = await cached('gm:' + userId, 60e3, async () => {
      try { return await discordApi(`/guilds/${C.guildId}/members/${userId}`); }
      catch (e) { if (e.status === 404) return null; throw e; }
    });
    if (!member) return { inGuild: false };
    const byId = new Map(roles.map(r => [r.id, r]));
    const list = (member.roles || []).map(id => byId.get(id)).filter(Boolean)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }));
    return { inGuild: true, nick: member.nick || null, joinedAt: member.joined_at || null, roles: list };
  } catch (e) {
    console.error('guild roles', e.message, e.detail || '');
    return { error: e.status === 403 ? 'البوت لا يملك صلاحية رؤية الأعضاء (فعّل Server Members Intent)' : e.status === 401 ? 'توكن البوت غير صالح' : 'تعذر جلب الرتب' };
  }
}
// يحوّل اسم مستخدم ديسكورد إلى ID (يحتاج DISCORD_GUILD_ID وأن البوت داخل السيرفر)
async function resolveDiscordName(name) {
  if (!C.guildId) return null;
  try {
    const r = await discordApi(`/guilds/${C.guildId}/members/search?query=${encodeURIComponent(name)}&limit=5`);
    const exact = r.find(m => m.user.username.toLowerCase() === name.toLowerCase()) || r[0];
    return exact ? exact.user.id : null;
  } catch { return null; }
}

// ---------- الخادم ----------
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); req.on('error', no); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/health') { res.writeHead(200); return res.end('ok'); }
    if (!p.startsWith('/api/')) {
      const file = path.join(__dirname, 'public', 'index.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(file));
    }
    if (p === '/api/login' && req.method === 'POST') {
      const { password } = await readBody(req);
      const a = Buffer.from(String(password || '')), b = Buffer.from(C.adminPassword);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return send(res, 200, { token: makeToken() });
      return send(res, 401, { error: 'كلمة السر غير صحيحة' });
    }
    if (!validToken((req.headers.authorization || '').replace('Bearer ', ''))) return send(res, 401, { error: 'غير مصرح' });

    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 1) return send(res, 200, []);
      return send(res, 200, await robloxSearch(q));
    }
    if (p === '/api/users' && req.method === 'GET') {
      const list = await readList();
      const thumbs = await robloxThumbs(list.map(u => u.userId));
      const out = await Promise.all(list.map(async u => {
        let d = null;
        if (u.discordId) { try { d = await discordProfile(u.discordId); } catch {} }
        return { ...u, avatar: thumbs[u.userId] || null, discordName: d ? (d.globalName || d.username) : u.discordInput, discordAvatar: d ? d.avatar : null };
      }));
      return send(res, 200, out.reverse());
    }
    if (p === '/api/activate' && req.method === 'POST') {
      const { userId, username, discord } = await readBody(req);
      const uid = Number(userId);
      const dis = String(discord || '').trim();
      if (!uid || !username || !dis) return send(res, 400, { error: 'بيانات ناقصة' });
      let discordId = /^\d{17,20}$/.test(dis) ? dis : await resolveDiscordName(dis.replace(/^@/, ''));
      await withLock(async () => {
        const list = await readList();
        if (list.some(u => u.userId === uid)) throw Object.assign(new Error('dup'), { code: 409 });
        list.push({ userId: uid, username, discordInput: dis, discordId: discordId || null, addedAt: Date.now() });
        await dsSet(C.wlStore, C.wlKey, { users: list });
      });
      return send(res, 200, { ok: true, discordResolved: !!discordId });
    }
    let m;
    if ((m = p.match(/^\/api\/users\/(\d+)$/)) && req.method === 'DELETE') {
      await withLock(async () => {
        const list = (await readList()).filter(u => u.userId !== Number(m[1]));
        await dsSet(C.wlStore, C.wlKey, { users: list });
      });
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/roblox\/(\d+)$/))) return send(res, 200, await robloxProfile(m[1]));
    if ((m = p.match(/^\/api\/discord\/(\d{17,20})$/))) return send(res, 200, { ...(await discordProfile(m[1])), guild: await discordGuildInfo(m[1]) });
    send(res, 404, { error: 'غير موجود' });
  } catch (e) {
    if (e.code === 409) return send(res, 409, { error: 'هذا اللاعب مفعّل مسبقاً' });
    console.error(p, e.message, e.detail || '');
    send(res, 500, { error: e.message });
  }
});
server.listen(C.port, '0.0.0.0', () => {
  console.log('نسخة الخادم: v3');
  console.log(`✅ الموقع يعمل على http://localhost:${C.port}`);
});

// ---------- جعل بوت ديسكورد يظهر Online ----------
// جلب البروفايلات يعمل عبر REST حتى والبوت أوفلاين. هذا الجزء فقط لإظهار حالة Online.
function startPresence() {
  if (typeof WebSocket === 'undefined') { console.warn('⚠️ حالة Online تحتاج Node 22 أو أحدث (WebSocket غير متوفر).'); return; }
  let ws, hb, seq = null, stopped = false;
  const connect = () => {
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.s != null) seq = m.s;
      if (m.op === 10) {
        const iv = m.d.heartbeat_interval;
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: seq })); }, iv * Math.random());
        hb = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: seq })); }, iv);
        ws.send(JSON.stringify({ op: 2, d: {
          token: C.discordToken, intents: 0,
          properties: { os: 'linux', browser: 'activation', device: 'activation' },
          presence: { status: 'online', afk: false, activities: [{ name: 'نظام التفعيل', type: 3 }] },
        } }));
      } else if (m.op === 1) ws.send(JSON.stringify({ op: 1, d: seq }));
      else if (m.op === 7 || m.op === 9) ws.close();
      else if (m.t === 'READY') console.log('🟢 بوت ديسكورد Online:', m.d.user.username);
    };
    ws.onclose = (ev) => {
      clearInterval(hb);
      if (ev.code === 4004) { stopped = true; console.error('❌ DISCORD_BOT_TOKEN غير صالح (Discord رفض الاتصال).'); }
      if (!stopped) setTimeout(connect, 5000);
    };
    ws.onerror = () => {};
  };
  connect();
}
startPresence();
