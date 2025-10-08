// server.js
// Minimal Express + WebSocket server that writes issues.json and commits changes to a local git repo.

const express = require('express');
const http = require('http');
const ws = require('ws');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const bodyParser = require('body-parser');
const cors = require('cors');

const DATA_FILE = path.join(__dirname, 'issues.json');
const GIT_ENABLED = true; // set false to disable git operations

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new ws.Server({ server });

let clients = new Set();

wss.on('connection', socket => {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
});

function broadcast(data) {
  const str = JSON.stringify(data);
  for (const c of clients) {
    if (c.readyState === ws.OPEN) c.send(str);
  }
}

// Load current data from file
async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // if missing, initialize
    const init = { nextId: 1, issues: [] };
    await fs.writeFile(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
}

let writeInProgress = false;
let queuedWrite = null;

// Serialize writes to avoid race conditions
async function writeData(newData, commitMessage) {
  // if a write is in progress, queue the latest write and return
  if (writeInProgress) {
    queuedWrite = { newData, commitMessage };
    return;
  }

  writeInProgress = true;

  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(newData, null, 2));

    if (GIT_ENABLED) {
      await gitCommit(DATA_FILE, commitMessage);
    }
  } catch (err) {
    console.error('Error writing data:', err);
  } finally {
    writeInProgress = false;
    if (queuedWrite) {
      const q = queuedWrite;
      queuedWrite = null;
      // fire-and-forget
      writeData(q.newData, q.commitMessage);
    }
  }
}

function gitCommit(filePath, message) {
  return new Promise((resolve, reject) => {
    // stage file and commit
    // Using exec to run git CLI. In production consider a library or more robust checks.
    exec(`git add "${filePath}" && git commit -m "${escapeShellArg(message)}"`, { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) {
        // git might fail (e.g., no changes, or git not initialized). Log but don't crash server.
        console.warn('Git commit failed:', (err && err.message) ? err.message.trim() : err);
        return resolve();
      }
      console.log('Git commit created:', message);
      resolve();
    });
  });
}

// simple escape for commit message
function escapeShellArg(s) {
  return String(s).replace(/"/g, '\\"');
}

// REST endpoints for basic operations
app.get('/api/issues', async (req, res) => {
  const data = await readData();
  res.json(data);
});

app.post('/api/issues', async (req, res) => {
  const { title, description, createdBy } = req.body;
  if (!title || !createdBy) return res.status(400).json({ error: 'title and createdBy required' });

  const data = await readData();
  const now = new Date().toISOString();
  const issue = {
    id: data.nextId++,
    title,
    description: description || '',
    status: 'Open',
    createdBy,
    createdAt: now,
    comments: []
  };

  data.issues.push(issue);

  const commitMessage = `Issue #${issue.id} created by ${createdBy}`;
  writeData(data, commitMessage);

  broadcast({ type: 'issue_created', issue });

  res.json(issue);
});

app.post('/api/issues/:id/comment', async (req, res) => {
  const id = Number(req.params.id);
  const { author, text } = req.body;
  if (!author || !text) return res.status(400).json({ error: 'author and text required' });

  const data = await readData();
  const issue = data.issues.find(i => i.id === id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const comment = { author, text, createdAt: new Date().toISOString() };
  issue.comments.push(comment);

  const commitMessage = `Comment on Issue #${id} by ${author}`;
  writeData(data, commitMessage);

  broadcast({ type: 'issue_commented', id, comment });

  res.json(comment);
});

app.post('/api/issues/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const { status, updatedBy } = req.body;
  if (!status || !updatedBy) return res.status(400).json({ error: 'status and updatedBy required' });
  if (!['Open', 'In Progress', 'Closed'].includes(status)) return res.status(400).json({ error: 'invalid status' });

  const data = await readData();
  const issue = data.issues.find(i => i.id === id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  issue.status = status;
  issue.updatedAt = new Date().toISOString();

  const commitMessage = `Issue #${id} marked as ${status} by ${updatedBy}`;
  writeData(data, commitMessage);

  broadcast({ type: 'issue_updated', issue });

  res.json(issue);
});

// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

// graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  wss.close();
  server.close(() => process.exit(0));
});
