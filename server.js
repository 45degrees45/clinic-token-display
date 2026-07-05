const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let config = { clinicName: 'My Clinic', port: 3000, avgMinutesPerPatient: 5 };
try {
  config = { ...config, ...JSON.parse(fs.readFileSync('./config.json', 'utf8')) };
} catch (e) {}

// ── Storage: PostgreSQL (production) or files (local) ───────────────────────
const USE_DB = !!process.env.DATABASE_URL;
let pool;

if (USE_DB) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
} else {
  const ROOMS_DIR = path.join(__dirname, 'data', 'rooms');
  if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });
}

const ROOMS_DIR = path.join(__dirname, 'data', 'rooms');

async function initDb() {
  if (!USE_DB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

const rooms = new Map(); // code → room state (always the source of truth for reads)

// Safety limits
const LIMITS = {
  maxRooms:          100,
  maxQueueSize:      100,
  rateWindowMs:    60_000,
  rateMaxTokens:      10,
  deviceCooldownMs: 15 * 60_000,
};

const ipRateMap = new Map();

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function newRoom(code, clinicName) {
  return {
    code,
    clinicName: clinicName || 'My Clinic',
    currentToken: 0,
    lastTokenIssued: 0,
    queueDate: getTodayDate(),
    tokens: [],
    paused: false,
    avgMinutesPerPatient: config.avgMinutesPerPatient || 5,
    audioLang: 'en',
    createdAt: new Date().toISOString()
  };
}

async function saveRoom(room) {
  room.queueDate = getTodayDate();
  if (USE_DB) {
    await pool.query(
      `INSERT INTO rooms (code, data, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (code) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [room.code, JSON.stringify(room)]
    );
  } else {
    fs.writeFileSync(path.join(ROOMS_DIR, `${room.code}.json`), JSON.stringify(room, null, 2));
  }
}

async function loadRooms() {
  if (USE_DB) {
    const result = await pool.query('SELECT data FROM rooms');
    for (const row of result.rows) {
      const room = row.data;
      if (room.queueDate !== getTodayDate()) {
        room.currentToken = 0; room.lastTokenIssued = 0; room.tokens = []; room.paused = false;
        await saveRoom(room);
      }
      rooms.set(room.code, room);
    }
    console.log(`Loaded ${rooms.size} clinic room(s) from database`);
  } else {
    try {
      const files = fs.readdirSync(ROOMS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const room = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, file), 'utf8'));
          if (room.queueDate !== getTodayDate()) {
            room.currentToken = 0; room.lastTokenIssued = 0; room.tokens = []; room.paused = false;
            await saveRoom(room);
          }
          rooms.set(room.code, room);
        } catch (e) {}
      }
      console.log(`Loaded ${rooms.size} clinic room(s) from files`);
    } catch (e) {}
  }
}

function getStatus(room) {
  const waiting = room.tokens
    .filter(t => t.status === 'waiting')
    .sort((a, b) => {
      if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
      if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
      return a.tokenNumber - b.tokenNumber;
    });
  const current = room.tokens.find(t => t.tokenNumber === room.currentToken) || null;
  const next    = waiting[0] || null;
  return {
    clinicName: room.clinicName,
    roomCode: room.code,
    currentToken: room.currentToken,
    currentPatientName:   current?.patientName   || null,
    currentPatientNameML: current?.patientNameML || null,
    currentPatientNameNL: current?.patientNameNL || null,
    currentPriority: current?.priority || 'normal',
    nextToken: next?.tokenNumber || 0,
    nextPatientName:   next?.patientName   || null,
    nextPatientNameML: next?.patientNameML || null,
    nextPatientNameNL: next?.patientNameNL || null,
    nextPriority: next?.priority || 'normal',
    lastTokenIssued: room.lastTokenIssued,
    waitingCount: waiting.length,
    estimatedWaitMinutes: waiting.length * (room.avgMinutesPerPatient || 5),
    paused: room.paused,
    queue: waiting.map(t => ({
      tokenNumber: t.tokenNumber,
      patientName: t.patientName,
      patientNameML: t.patientNameML,
      priority: t.priority || 'normal'
    })),
    avgMinutesPerPatient: room.avgMinutesPerPatient || 5,
    audioLang: room.audioLang || 'en',
    allTokens: room.tokens
  };
}

function findDeviceToken(room, deviceId, fingerprint) {
  if (!deviceId && !fingerprint) return null;
  const now = Date.now();
  return room.tokens.find(t => {
    const idMatch = deviceId    && t.deviceId    === deviceId;
    const fpMatch = fingerprint && t.fingerprint === fingerprint;
    if (!idMatch && !fpMatch) return false;
    if (t.status === 'waiting' || t.status === 'called') return true;
    return (now - new Date(t.createdAt).getTime()) < LIMITS.deviceCooldownMs;
  }) || null;
}

function checkIpRateLimit(ip) {
  const now = Date.now();
  const entry = ipRateMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > LIMITS.rateWindowMs) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  ipRateMap.set(ip, entry);
  return entry.count <= LIMITS.rateMaxTokens;
}

setInterval(() => {
  const cutoff = Date.now() - LIMITS.rateWindowMs * 2;
  for (const [ip, entry] of ipRateMap) {
    if (entry.windowStart < cutoff) ipRateMap.delete(ip);
  }
}, 5 * 60_000);

function requireRoom(req, res, next) {
  const room = rooms.get(req.params.code?.toUpperCase());
  if (!room) return res.status(404).json({ success: false, message: 'Clinic room not found' });
  req.room = room;
  next();
}

async function ensureLocalRoom() {
  if (rooms.has('LOCAL')) return;
  const room = newRoom('LOCAL', config.clinicName);
  rooms.set('LOCAL', room);
  await saveRoom(room);
}

async function seedDemoRoom() {
  if (rooms.has('DEMO')) return;
  const room = newRoom('DEMO', 'Kerala Health Clinic (Demo)');
  room.audioLang = 'en+nl';
  const patients = [
    { name: 'Rajesh Kumar',    nameML: 'രാജേഷ് കുമാർ',   nameNL: null,                priority: 'normal', status: 'called'  },
    { name: 'Jan de Vries',    nameML: null,               nameNL: 'Jan de Vries',      priority: 'normal', status: 'waiting' },
    { name: 'Suresh Babu',     nameML: 'സുരേഷ് ബാബു',     nameNL: null,                priority: 'normal', status: 'waiting' },
    { name: 'Maria van Berg',  nameML: null,               nameNL: 'Maria van Berg',    priority: 'urgent', status: 'waiting' },
    { name: 'Mohammed Ansari', nameML: 'മുഹമ്മദ് അൻസാരി', nameNL: null,                priority: 'normal', status: 'waiting' },
    { name: 'Pieter Bakker',   nameML: null,               nameNL: 'Pieter Bakker',     priority: 'normal', status: 'waiting' },
    { name: 'Arun Krishnan',   nameML: 'അരുൺ കൃഷ്ണൻ',    nameNL: null,                priority: 'normal', status: 'waiting' },
  ];
  patients.forEach(p => {
    room.lastTokenIssued++;
    room.tokens.push({
      tokenNumber: room.lastTokenIssued,
      patientName: p.name, patientNameML: p.nameML, patientNameNL: p.nameNL,
      priority: p.priority, status: p.status,
      createdAt: new Date().toISOString(),
      calledAt: p.status === 'called' ? new Date().toISOString() : null
    });
  });
  room.currentToken = 1;
  rooms.set('DEMO', room);
  await saveRoom(room);
  console.log('Demo room seeded → /r/DEMO');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Page routes ─────────────────────────────────────────────────────────────
app.get('/',               (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/setup',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/r/:code',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/r/:code/admin',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/r/:code/patient',(req, res) => res.sendFile(path.join(__dirname, 'public', 'patient.html')));
app.get('/display', (req, res) => res.redirect('/r/LOCAL'));
app.get('/admin',   (req, res) => res.redirect('/r/LOCAL/admin'));
app.get('/patient', (req, res) => res.redirect('/r/LOCAL/patient'));
app.get('/pitch', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presentation.html')));
app.get('/info',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/demo',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo-guide.html')));

// ── Server stats ─────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const roomList = [...rooms.values()].map(r => ({
    code: r.code,
    clinicName: r.clinicName,
    waiting: r.tokens.filter(t => t.status === 'waiting').length,
    createdAt: r.createdAt,
  }));
  res.json({ totalRooms: rooms.size, rooms: roomList });
});

// ── Room creation ────────────────────────────────────────────────────────────
app.post('/api/rooms/create', async (req, res) => {
  if (rooms.size >= LIMITS.maxRooms) {
    return res.status(503).json({ success: false, message: 'Server is at capacity. Please try again later.' });
  }
  const clinicName = (req.body.clinicName || '').trim() || 'My Clinic';
  let code;
  do { code = generateCode(); } while (rooms.has(code));
  const room = newRoom(code, clinicName);
  rooms.set(code, room);
  await saveRoom(room);
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true, code, clinicName,
    links: {
      display: `${base}/r/${code}`,
      admin:   `${base}/r/${code}/admin`,
      patient: `${base}/r/${code}/patient`
    }
  });
});

// ── Room API ─────────────────────────────────────────────────────────────────
app.get('/api/room/:code/status', requireRoom, (req, res) => res.json(getStatus(req.room)));

app.get('/api/room/:code/my-token', requireRoom, (req, res) => {
  const { deviceId, fingerprint } = req.query;
  if (!deviceId && !fingerprint) return res.json({ found: false });
  const token = findDeviceToken(req.room, deviceId, fingerprint);
  if (!token) return res.json({ found: false });
  res.json({ found: true, tokenNumber: token.tokenNumber, status: token.status, patientName: token.patientName });
});

app.post('/api/room/:code/token', requireRoom, async (req, res) => {
  const room = req.room;
  const waitingCount = room.tokens.filter(t => t.status === 'waiting').length;
  if (waitingCount >= LIMITS.maxQueueSize) {
    return res.status(429).json({ success: false, message: `Queue is full (max ${LIMITS.maxQueueSize} patients). Please wait.` });
  }
  const ip = req.ip || req.socket.remoteAddress;
  if (!checkIpRateLimit(ip)) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please wait a minute.' });
  }
  const deviceId    = (req.body.deviceId    || '').trim().substring(0, 64) || null;
  const fingerprint = (req.body.fingerprint || '').trim().substring(0, 64) || null;
  const existing = findDeviceToken(room, deviceId, fingerprint);
  if (existing) {
    const minutesLeft = Math.ceil((LIMITS.deviceCooldownMs - (Date.now() - new Date(existing.createdAt).getTime())) / 60_000);
    return res.status(409).json({
      success: false, duplicate: true,
      message: existing.status === 'waiting' || existing.status === 'called'
        ? 'You already have a token in this queue.'
        : `Please wait ${minutesLeft} more minute(s) before getting a new token.`,
      existingToken: existing.tokenNumber,
      existingStatus: existing.status,
    });
  }
  const patientName   = (req.body.patientName   || '').trim() || null;
  const patientNameML = (req.body.patientNameML || '').trim() || null;
  const patientNameNL = (req.body.patientNameNL || '').trim() || null;
  const priority      = req.body.priority === 'urgent' ? 'urgent' : 'normal';
  room.lastTokenIssued++;
  const token = { tokenNumber: room.lastTokenIssued, patientName, patientNameML, patientNameNL, priority, status: 'waiting', createdAt: new Date().toISOString(), calledAt: null, deviceId, fingerprint };
  room.tokens.push(token);
  await saveRoom(room);
  const status = getStatus(room);
  io.to(room.code).emit('queue-updated', status);
  const position = status.queue.findIndex(t => t.tokenNumber === token.tokenNumber) + 1;
  res.json({ success: true, tokenNumber: room.lastTokenIssued, queuePosition: position });
});

app.post('/api/room/:code/tokens/bulk', requireRoom, async (req, res) => {
  const room = req.room;
  const patients = Array.isArray(req.body.patients) ? req.body.patients : [];
  if (patients.length === 0) return res.json({ success: false, message: 'No patients provided' });
  const waitingCount = room.tokens.filter(t => t.status === 'waiting').length;
  const canAdd = LIMITS.maxQueueSize - waitingCount;
  if (canAdd <= 0) return res.status(429).json({ success: false, message: `Queue is full (max ${LIMITS.maxQueueSize} patients).` });
  const issued = [];
  for (const p of patients.slice(0, canAdd)) {
    const patientName   = (p.patientName   || '').trim() || null;
    const patientNameML = (p.patientNameML || '').trim() || null;
    const patientNameNL = (p.patientNameNL || '').trim() || null;
    const priority      = p.priority === 'urgent' ? 'urgent' : 'normal';
    room.lastTokenIssued++;
    const token = { tokenNumber: room.lastTokenIssued, patientName, patientNameML, patientNameNL, priority, status: 'waiting', createdAt: new Date().toISOString(), calledAt: null };
    room.tokens.push(token);
    issued.push({ tokenNumber: token.tokenNumber, patientName, patientNameML, patientNameNL, priority });
  }
  await saveRoom(room);
  io.to(room.code).emit('queue-updated', getStatus(room));
  res.json({ success: true, issued, count: issued.length });
});

app.post('/api/room/:code/next', requireRoom, async (req, res) => {
  const room = req.room;
  const waiting = room.tokens.filter(t => t.status === 'waiting').sort((a, b) => {
    if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
    if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
    return a.tokenNumber - b.tokenNumber;
  });
  const next = waiting[0];
  if (!next) return res.json({ success: false, message: 'Queue is empty' });
  const prev = room.tokens.find(t => t.tokenNumber === room.currentToken && t.status === 'called');
  if (prev) prev.status = 'done';
  next.status = 'called'; next.calledAt = new Date().toISOString();
  room.currentToken = next.tokenNumber;
  await saveRoom(room);
  io.to(room.code).emit('token-called', { ...getStatus(room), action: 'next' });
  res.json({ success: true, currentToken: room.currentToken });
});

app.post('/api/room/:code/recall', requireRoom, (req, res) => {
  const room = req.room;
  if (room.currentToken === 0) return res.json({ success: false, message: 'No active token' });
  io.to(room.code).emit('token-called', { ...getStatus(room), action: 'recall' });
  res.json({ success: true, currentToken: room.currentToken });
});

app.post('/api/room/:code/skip', requireRoom, async (req, res) => {
  const room = req.room;
  if (room.currentToken === 0) return res.json({ success: false, message: 'No active token' });
  const current = room.tokens.find(t => t.tokenNumber === room.currentToken);
  const skippedNumber = current?.tokenNumber;
  if (current) current.status = 'skipped';
  const waiting = room.tokens.filter(t => t.status === 'waiting').sort((a, b) => {
    if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
    if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
    return a.tokenNumber - b.tokenNumber;
  });
  const next = waiting[0];
  if (next) { next.status = 'called'; next.calledAt = new Date().toISOString(); room.currentToken = next.tokenNumber; }
  else room.currentToken = 0;
  await saveRoom(room);
  io.to(room.code).emit('token-called', { ...getStatus(room), action: 'skip', skippedToken: skippedNumber });
  res.json({ success: true, currentToken: room.currentToken, skippedToken: skippedNumber });
});

app.post('/api/room/:code/pause', requireRoom, async (req, res) => {
  const room = req.room;
  room.paused = !room.paused;
  await saveRoom(room);
  io.to(room.code).emit('queue-updated', getStatus(room));
  res.json({ success: true, paused: room.paused });
});

const VALID_LANG_CODES = new Set(['en', 'nl', 'hi', 'ml']);
function isValidAudioLang(val) {
  return val && val.split('+').every(l => VALID_LANG_CODES.has(l));
}

app.post('/api/room/:code/settings', requireRoom, async (req, res) => {
  const room = req.room;
  if (req.body.audioLang && isValidAudioLang(req.body.audioLang)) {
    room.audioLang = req.body.audioLang;
  }
  await saveRoom(room);
  io.to(room.code).emit('queue-updated', getStatus(room));
  res.json({ success: true, audioLang: room.audioLang });
});

app.post('/api/room/:code/reset', requireRoom, async (req, res) => {
  const room = req.room;
  room.currentToken = 0; room.lastTokenIssued = 0; room.tokens = []; room.paused = false;
  room.queueDate = getTodayDate();
  await saveRoom(room);
  io.to(room.code).emit('queue-reset', getStatus(room));
  res.json({ success: true });
});

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join-room', (code) => {
    const room = rooms.get(code?.toUpperCase());
    if (room) { socket.join(room.code); socket.emit('queue-updated', getStatus(room)); }
  });
  socket.on('disconnect', () => {});
});

// ── Startup ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || config.port || 3000;

async function startup() {
  await initDb();
  await loadRooms();
  if (process.env.NODE_ENV === 'production') {
    await seedDemoRoom();
  } else {
    await ensureLocalRoom();
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║   Clinic Token Display System        ║`);
    console.log(`╚══════════════════════════════════════╝`);
    console.log(`\nSetup  : http://localhost:${PORT}/setup`);
    console.log(`Local  : http://localhost:${PORT}/r/LOCAL`);
    console.log(`Admin  : http://localhost:${PORT}/r/LOCAL/admin\n`);
    console.log(USE_DB ? '💾 Storage: PostgreSQL' : '📁 Storage: local files');
  });
}

startup().catch(err => { console.error('Startup failed:', err); process.exit(1); });
