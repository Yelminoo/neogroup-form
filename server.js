const express     = require('express');
const multer      = require('multer');
const { google }  = require('googleapis');
const { Readable } = require('stream');
const path        = require('path');
const fs          = require('fs');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT            || 4000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';   // Neogroup Inquiry Files folder ID
const CLIENT_ID       = process.env.CLIENT_ID       || '';
const CLIENT_SECRET   = process.env.CLIENT_SECRET   || '';
const REDIRECT_URI    = process.env.REDIRECT_URI    || '';   // e.g. https://form.neogrouplimited.com/oauth/callback
const TOKEN_PATH      = process.env.TOKEN_PATH      || path.join(__dirname, 'token.json');
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN  || 'https://form.neogrouplimited.com';
// ─────────────────────────────────────────────────────────────────────────────

// OAuth2 client
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Load saved token on startup
if (fs.existsSync(TOKEN_PATH)) {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oauth2Client.setCredentials(token);
}

// Auto-save refreshed tokens
oauth2Client.on('tokens', (tokens) => {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH))
    : {};
  const merged = { ...existing, ...tokens };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/upload/health', (req, res) => {
  const authed = fs.existsSync(TOKEN_PATH);
  res.json({ status: 'ok', authorized: authed });
});

// ── OAUTH: Step 1 — redirect to Google consent screen ─────────────────────────
app.get('/oauth/authorize', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',      // force refresh_token to be returned
    scope: ['https://www.googleapis.com/auth/drive'],
  });
  res.redirect(url);
});

// ── OAUTH: Step 2 — Google redirects back with ?code= ─────────────────────────
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:#C9A96E">Authorization successful</h2>
        <p>Neo Group upload server is now connected to Google Drive.</p>
        <p style="color:#888;font-size:13px">You can close this tab.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Authorization failed: ' + err.message);
  }
});

// ── UPLOAD: POST /upload ───────────────────────────────────────────────────────
app.post('/upload', upload.array('files', 10), async (req, res) => {
  if (!fs.existsSync(TOKEN_PATH)) {
    return res.status(401).json({ error: 'Server not authorized. Visit /oauth/authorize first.' });
  }

  const { clientName, submissionDate } = req.body;
  const files = req.files || [];

  if (files.length === 0) {
    return res.json({ links: [], folderLink: '' });
  }

  try {
    // Create a subfolder: ClientName_YYYY-MM-DD
    const safeName   = (clientName || 'Unknown').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    const dateStr    = submissionDate || new Date().toISOString().slice(0, 10);
    const folderName = `${safeName}_${dateStr}`;

    const folderMeta = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [DRIVE_FOLDER_ID],
      },
      supportsAllDrives: true,
      fields: 'id, webViewLink',
    });

    const folderId   = folderMeta.data.id;
    const folderLink = folderMeta.data.webViewLink;

    // Upload each file into the subfolder
    const links = [];
    for (const file of files) {
      const stream = Readable.from(file.buffer);
      const result = await drive.files.create({
        requestBody: {
          name: file.originalname,
          parents: [folderId],
        },
        media: {
          mimeType: file.mimetype || 'application/octet-stream',
          body: stream,
        },
        supportsAllDrives: true,
        fields: 'id, name, webViewLink',
      });
      links.push({
        name: result.data.name,
        link: result.data.webViewLink,
      });
    }

    res.json({ links, folderLink });

  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Upload server running on 127.0.0.1:${PORT}`);
});
