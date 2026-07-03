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

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'queue-state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

let state = {
  currentToken: 0,
  lastTokenIssued: 0,
  queueDate: getTodayDate(),
  tokens: [],
  paused: false
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.queueDate === getTodayDate()) {
        state = { ...state, ...saved }; // merge so new fields default correctly
        console.log(`Resumed queue: ${state.tokens.length} tokens, current: ${state.currentToken}`);
      } else {
        console.log('New day — starting fresh queue');
        saveState();
      }
    }
  } catch (e) {
    console.log('Starting fresh state');
  }
}

function saveState() {
  state.queueDate = getTodayDate();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getStatus() {
  // Sort waiting: urgent tokens first, then by token number (FIFO within priority)
  const waiting = state.tokens
    .filter(t => t.status === 'waiting')
    .sort((a, b) => {
      if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
      if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
      return a.tokenNumber - b.tokenNumber;
    });

  const current = state.tokens.find(t => t.tokenNumber === state.currentToken) || null;
  const next    = waiting[0] || null;
  return {
    clinicName: config.clinicName,
    currentToken: state.currentToken,
    currentPatientName: current?.patientName || null,
    currentPatientNameML: current?.patientNameML || null,
    currentPriority: current?.priority || 'normal',
    nextToken: next?.tokenNumber || 0,
    nextPatientName: next?.patientName || null,
    nextPatientNameML: next?.patientNameML || null,
    nextPriority: next?.priority || 'normal',
    lastTokenIssued: state.lastTokenIssued,
    waitingCount: waiting.length,
    estimatedWaitMinutes: waiting.length * config.avgMinutesPerPatient,
    paused: state.paused,
    queue: waiting.map(t => ({
      tokenNumber: t.tokenNumber,
      patientName: t.patientName,
      patientNameML: t.patientNameML,
      priority: t.priority || 'normal'
    })),
    avgMinutesPerPatient: config.avgMinutesPerPatient,
    allTokens: state.tokens
  };
}

loadState();

// Seed demo patients when running on Render with an empty queue
function seedDemoPatients() {
  if (state.tokens.length > 0) return;
  const patients = [
    { name: 'Rajesh Kumar',    nameML: 'രാജേഷ് കുമാർ',      priority: 'normal', status: 'called' },
    { name: 'Meera Nair',      nameML: 'മീര നായർ',           priority: 'normal', status: 'waiting' },
    { name: 'Suresh Babu',     nameML: 'സുരേഷ് ബാബു',        priority: 'normal', status: 'waiting' },
    { name: 'Lakshmi Devi',    nameML: 'ലക്ഷ്മി ദേവി',       priority: 'urgent', status: 'waiting' },
    { name: 'Mohammed Ansari', nameML: 'മുഹമ്മദ് അൻസാരി',    priority: 'normal', status: 'waiting' },
    { name: 'Priya Thomas',    nameML: 'പ്രിയ തോമസ്',        priority: 'normal', status: 'waiting' },
    { name: 'Arun Krishnan',   nameML: 'അരുൺ കൃഷ്ണൻ',       priority: 'normal', status: 'waiting' },
  ];
  patients.forEach((p, i) => {
    state.lastTokenIssued++;
    state.tokens.push({
      tokenNumber: state.lastTokenIssued,
      patientName: p.name,
      patientNameML: p.nameML,
      priority: p.priority,
      status: p.status,
      createdAt: new Date().toISOString(),
      calledAt: p.status === 'called' ? new Date().toISOString() : null
    });
  });
  state.currentToken = 1;
  saveState();
  console.log('Demo patients seeded');
}

if (process.env.NODE_ENV === 'production') seedDemoPatients();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/patient', (req, res) => res.sendFile(path.join(__dirname, 'public', 'patient.html')));
app.get('/pitch', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presentation.html')));
app.get('/info', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// Issue new token
app.post('/api/token', (req, res) => {
  const patientName   = (req.body.patientName   || '').trim() || null;
  const patientNameML = (req.body.patientNameML || '').trim() || null;
  const priority      = req.body.priority === 'urgent' ? 'urgent' : 'normal';
  state.lastTokenIssued++;
  const token = {
    tokenNumber: state.lastTokenIssued,
    patientName,
    patientNameML,
    priority,
    status: 'waiting',
    createdAt: new Date().toISOString(),
    calledAt: null
  };
  state.tokens.push(token);
  saveState();

  const status = getStatus();
  io.emit('queue-updated', status);

  const position = status.queue.findIndex(t => t.tokenNumber === token.tokenNumber) + 1;
  res.json({ success: true, tokenNumber: state.lastTokenIssued, queuePosition: position });
});

// Bulk issue tokens
app.post('/api/tokens/bulk', (req, res) => {
  const patients = Array.isArray(req.body.patients) ? req.body.patients : [];
  if (patients.length === 0) return res.json({ success: false, message: 'No patients provided' });

  const issued = [];
  for (const p of patients) {
    const patientName   = (p.patientName   || '').trim() || null;
    const patientNameML = (p.patientNameML || '').trim() || null;
    const priority      = p.priority === 'urgent' ? 'urgent' : 'normal';
    state.lastTokenIssued++;
    const token = {
      tokenNumber: state.lastTokenIssued,
      patientName,
      patientNameML,
      priority,
      status: 'waiting',
      createdAt: new Date().toISOString(),
      calledAt: null
    };
    state.tokens.push(token);
    issued.push({ tokenNumber: token.tokenNumber, patientName, patientNameML, priority });
  }

  saveState();
  io.emit('queue-updated', getStatus());
  res.json({ success: true, issued, count: issued.length });
});

// Call next token (respects priority sort)
app.post('/api/next', (req, res) => {
  const waiting = state.tokens
    .filter(t => t.status === 'waiting')
    .sort((a, b) => {
      if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
      if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
      return a.tokenNumber - b.tokenNumber;
    });
  const next = waiting[0];
  if (!next) return res.json({ success: false, message: 'Queue is empty' });

  const prev = state.tokens.find(t => t.tokenNumber === state.currentToken && t.status === 'called');
  if (prev) prev.status = 'done';

  next.status = 'called';
  next.calledAt = new Date().toISOString();
  state.currentToken = next.tokenNumber;
  saveState();

  io.emit('token-called', { ...getStatus(), action: 'next' });
  res.json({ success: true, currentToken: state.currentToken });
});

// Recall current token (re-announce without changing queue)
app.post('/api/recall', (req, res) => {
  if (state.currentToken === 0) return res.json({ success: false, message: 'No active token' });
  io.emit('token-called', { ...getStatus(), action: 'recall' });
  res.json({ success: true, currentToken: state.currentToken });
});

// Skip current token
app.post('/api/skip', (req, res) => {
  if (state.currentToken === 0) return res.json({ success: false, message: 'No active token' });

  const current = state.tokens.find(t => t.tokenNumber === state.currentToken);
  const skippedNumber = current?.tokenNumber;
  if (current) current.status = 'skipped';

  const waiting = state.tokens
    .filter(t => t.status === 'waiting')
    .sort((a, b) => {
      if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
      if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
      return a.tokenNumber - b.tokenNumber;
    });
  const next = waiting[0];
  if (next) {
    next.status = 'called';
    next.calledAt = new Date().toISOString();
    state.currentToken = next.tokenNumber;
  } else {
    state.currentToken = 0;
  }

  saveState();
  io.emit('token-called', { ...getStatus(), action: 'skip', skippedToken: skippedNumber });
  res.json({ success: true, currentToken: state.currentToken, skippedToken: skippedNumber });
});

// Toggle pause
app.post('/api/pause', (req, res) => {
  state.paused = !state.paused;
  saveState();
  io.emit('queue-updated', getStatus());
  res.json({ success: true, paused: state.paused });
});

// Reset queue
app.post('/api/reset', (req, res) => {
  state = { currentToken: 0, lastTokenIssued: 0, queueDate: getTodayDate(), tokens: [], paused: false };
  saveState();
  io.emit('queue-reset', getStatus());
  res.json({ success: true });
});

// Status endpoint
app.get('/api/status', (req, res) => res.json(getStatus()));

io.on('connection', (socket) => {
  socket.emit('queue-updated', getStatus());
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || config.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Clinic Token Display System        ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`\nClinic : ${config.clinicName}`);
  console.log(`Display: http://localhost:${PORT}/        ← TV/Monitor`);
  console.log(`Admin  : http://localhost:${PORT}/admin   ← Doctor's phone`);
  console.log(`Patient: http://localhost:${PORT}/patient ← Self check-in\n`);
});
