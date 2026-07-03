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

const ROOMS_DIR = path.join(__dirname, 'data', 'rooms');
if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });

const rooms = new Map(); // code → room state

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
    createdAt: new Date().toISOString()
  };
}

function saveRoom(room) {
  room.queueDate = getTodayDate();
  fs.writeFileSync(path.join(ROOMS_DIR, `${room.code}.json`), JSON.stringify(room, null, 2));
}

function loadRooms() {
  try {
    const files = fs.readdirSync(ROOMS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const room = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, file), 'utf8'));
        if (room.queueDate !== getTodayDate()) {
          room.currentToken = 0;
          room.lastTokenIssued = 0;
          room.tokens = [];
          room.paused = false;
          saveRoom(room);
        }
        rooms.set(room.code, room);
      } catch (e) {}
    }
    console.log(`Loaded ${rooms.size} clinic room(s)`);
  } catch (e) {}
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
    currentPriority: current?.priority || 'normal',
    nextToken: next?.tokenNumber || 0,
    nextPatientName:   next?.patientName   || null,
    nextPatientNameML: next?.patientNameML || null,
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
    allTokens: room.tokens
  };
}

function requireRoom(req, res, next) {
  const room = rooms.get(req.params.code?.toUpperCase());
  if (!room) return res.status(404).json({ success: false, message: 'Clinic room not found' });
  req.room = room;
  next();
}

loadRooms();

// Create LOCAL room for self-hosted (non-cloud) use
function ensureLocalRoom() {
  if (rooms.has('LOCAL')) return;
  const room = newRoom('LOCAL', config.clinicName);
  rooms.set('LOCAL', room);
  saveRoom(room);
}

// Seed demo room for Render deployment
function seedDemoRoom() {
  if (rooms.has('DEMO')) return;
  const room = newRoom('DEMO', 'Kerala Health Clinic (Demo)');
  const patients = [
    { name: 'Rajesh Kumar',    nameML: 'രാജേഷ് കുമാർ',   priority: 'normal', status: 'called'  },
    { name: 'Meera Nair',      nameML: 'മീര നായർ',        priority: 'normal', status: 'waiting' },
    { name: 'Suresh Babu',     nameML: 'സുരേഷ് ബാബു',     priority: 'normal', status: 'waiting' },
    { name: 'Lakshmi Devi',    nameML: 'ലക്ഷ്മി ദേവി',    priority: 'urgent', status: 'waiting' },
    { name: 'Mohammed Ansari', nameML: 'മുഹമ്മദ് അൻസാരി', priority: 'normal', status: 'waiting' },
    { name: 'Priya Thomas',    nameML: 'പ്രിയ തോമസ്',     priority: 'normal', status: 'waiting' },
    { name: 'Arun Krishnan',   nameML: 'അരുൺ കൃഷ്ണൻ',    priority: 'normal', status: 'waiting' },
  ];
  patients.forEach(p => {
    room.lastTokenIssued++;
    room.tokens.push({
      tokenNumber: room.lastTokenIssued,
      patientName: p.name, patientNameML: p.nameML,
      priority: p.priority, status: p.status,
      createdAt: new Date().toISOString(),
      calledAt: p.status === 'called' ? new Date().toISOString() : null
    });
  });
  room.currentToken = 1;
  rooms.set('DEMO', room);
  saveRoom(room);
  console.log('Demo room seeded → /r/DEMO');
}

if (process.env.NODE_ENV === 'production') {
  seedDemoRoom();
} else {
  ensureLocalRoom();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Page routes ────────────────────────────────────────────────────────────
app.get('/',               (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/setup',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/r/:code',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/r/:code/admin',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/r/:code/patient',(req, res) => res.sendFile(path.join(__dirname, 'public', 'patient.html')));

// Legacy routes for local self-hosted use (uses LOCAL room)
app.get('/display', (req, res) => res.redirect('/r/LOCAL'));
app.get('/admin',   (req, res) => res.redirect('/r/LOCAL/admin'));
app.get('/patient', (req, res) => res.redirect('/r/LOCAL/patient'));

app.get('/pitch', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presentation.html')));
app.get('/info',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// ── Room creation ───────────────────────────────────────────────────────────
app.post('/api/rooms/create', (req, res) => {
  const clinicName = (req.body.clinicName || '').trim() || 'My Clinic';
  let code;
  do { code = generateCode(); } while (rooms.has(code));
  const room = newRoom(code, clinicName);
  rooms.set(code, room);
  saveRoom(room);
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

// ── Room API ────────────────────────────────────────────────────────────────
app.get('/api/room/:code/status', requireRoom, (req, res) => res.json(getStatus(req.room)));

app.post('/api/room/:code/token', requireRoom, (req, res) => {
  const room = req.room;
  const patientName   = (req.body.patientName   || '').trim() || null;
  const patientNameML = (req.body.patientNameML || '').trim() || null;
  const priority      = req.body.priority === 'urgent' ? 'urgent' : 'normal';
  room.lastTokenIssued++;
  const token = { tokenNumber: room.lastTokenIssued, patientName, patientNameML, priority, status: 'waiting', createdAt: new Date().toISOString(), calledAt: null };
  room.tokens.push(token);
  saveRoom(room);
  const status = getStatus(room);
  io.to(room.code).emit('queue-updated', status);
  const position = status.queue.findIndex(t => t.tokenNumber === token.tokenNumber) + 1;
  res.json({ success: true, tokenNumber: room.lastTokenIssued, queuePosition: position });
});

app.post('/api/room/:code/tokens/bulk', requireRoom, (req, res) => {
  const room = req.room;
  const patients = Array.isArray(req.body.patients) ? req.body.patients : [];
  if (patients.length === 0) return res.json({ success: false, message: 'No patients provided' });
  const issued = [];
  for (const p of patients) {
    const patientName   = (p.patientName   || '').trim() || null;
    const patientNameML = (p.patientNameML || '').trim() || null;
    const priority      = p.priority === 'urgent' ? 'urgent' : 'normal';
    room.lastTokenIssued++;
    const token = { tokenNumber: room.lastTokenIssued, patientName, patientNameML, priority, status: 'waiting', createdAt: new Date().toISOString(), calledAt: null };
    room.tokens.push(token);
    issued.push({ tokenNumber: token.tokenNumber, patientName, patientNameML, priority });
  }
  saveRoom(room);
  io.to(room.code).emit('queue-updated', getStatus(room));
  res.json({ success: true, issued, count: issued.length });
});

app.post('/api/room/:code/next', requireRoom, (req, res) => {
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
  saveRoom(room);
  io.to(room.code).emit('token-called', { ...getStatus(room), action: 'next' });
  res.json({ success: true, currentToken: room.currentToken });
});

app.post('/api/room/:code/recall', requireRoom, (req, res) => {
  const room = req.room;
  if (room.currentToken === 0) return res.json({ success: false, message: 'No active token' });
  io.to(room.code).emit('token-called', { ...getStatus(room), action: 'recall' });
  res.json({ success: true, currentToken: room.currentToken });
});

app.post('/api/room/:code/skip', requireRoom, (req, res) => {
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
  saveRoom(room);
  io.to(room.code).emit('token-called', { ...getStatus(room), action: 'skip', skippedToken: skippedNumber });
  res.json({ success: true, currentToken: room.currentToken, skippedToken: skippedNumber });
});

app.post('/api/room/:code/pause', requireRoom, (req, res) => {
  const room = req.room;
  room.paused = !room.paused;
  saveRoom(room);
  io.to(room.code).emit('queue-updated', getStatus(room));
  res.json({ success: true, paused: room.paused });
});

app.post('/api/room/:code/reset', requireRoom, (req, res) => {
  const room = req.room;
  room.currentToken = 0; room.lastTokenIssued = 0; room.tokens = []; room.paused = false;
  room.queueDate = getTodayDate();
  saveRoom(room);
  io.to(room.code).emit('queue-reset', getStatus(room));
  res.json({ success: true });
});

// ── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join-room', (code) => {
    const room = rooms.get(code?.toUpperCase());
    if (room) {
      socket.join(room.code);
      socket.emit('queue-updated', getStatus(room));
    }
  });
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || config.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Clinic Token Display System        ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`\nSetup  : http://localhost:${PORT}/setup`);
  console.log(`Local  : http://localhost:${PORT}/r/LOCAL`);
  console.log(`Admin  : http://localhost:${PORT}/r/LOCAL/admin\n`);
});
