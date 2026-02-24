require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const fs = require('fs');

const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon requires SSL; this makes pg happy even in serverless envs
      ssl: { rejectUnauthorized: false },
    })
  : null;


const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data-local');
fs.mkdirSync(DATA_DIR, { recursive: true });
const finance = require('./finance');


const bookingsFile = path.join(DATA_DIR, 'bookings.json');
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';



// Ensure required folders/files exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const SIGNATURES_DIR = path.join(UPLOADS_DIR, 'signatures');
fs.mkdirSync(SIGNATURES_DIR, { recursive: true });

// Seed an empty bookings file if missing
if (!fs.existsSync(bookingsFile)) {
  fs.writeFileSync(bookingsFile, '[]', 'utf8');
}


// Where to put generated PDFs
// On Render (no disk), use /tmp which is always writable but ephemeral
const OUTPUT_DIR = process.env.RENDER ? '/tmp' : path.join(__dirname, 'outputs');

// Make sure the folder exists (safe if it already exists)
try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (e) { console.error('mkdir OUTPUT_DIR failed:', e); }



const generateMoveInPDF = require('./generate-movein');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const PORT = process.env.PORT || 3000;
const session = require('express-session');





// Session setup (after app is initialized)
app.use(session({
  secret: 'your_secret_key', // replace with something secure
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 } // 1 hour session
}));

// Body parsers (needed for early API routes like checklist/comment)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'adam.kischinovsky@gmail.com',         // ← din Gmail-adresse
    pass: 'odtfujoqggybjurh'      // ← den 16-cifrede app-adgangskode
  }

  



});

// Update checklist steps (simple toggle)
app.post('/api/checklist/:id', requireAdmin, (req, res) => {
  const bookingId = req.params.id;
  const { field, value } = req.body || {};
  const allowed = new Set(['step1','step2','step3','step4','step5','emailSent','cleaned']);
  if (!allowed.has(field)) {
    if (!IS_PROD) console.error('CHECKLIST 400 invalid field', bookingId, req.body);
    return res.status(400).json({ error: 'Invalid field' });
  }

  if (usePgBookings(req)) {
    console.log('Bookings write backend: postgres');
    pgUpdateChecklist(req.session.workspaceId, bookingId, field, value === 'true' || value === true)
      .then((bk)=> bk ? res.json(bk) : res.status(404).json({ error:'Booking not found' }))
      .catch((e)=>{ console.error('Failed to update checklist (pg)', e); res.status(500).json({ error:'Failed to update checklist' });});
    return;
  }

  try {
    const bookings = readBookingsLocal();
    const idx = bookings.findIndex(
      b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId))
    );
    if (idx === -1) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    bookings[idx].checklist = bookings[idx].checklist || {};
    bookings[idx].checklist[field] = value === 'true' || value === true;
    writeBookingsLocal(bookings);
    pushBookingsToGist(bookings).catch(() => {});
    return res.json({ ok: true });
  } catch (e) {
    console.error('Failed to update checklist', e);
    return res.status(500).json({ error: 'Failed to update checklist' });
  }
});

// Add or update a booking comment/notes
app.post('/api/comment/:id', requireAdmin, (req, res) => {
  const bookingId = req.params.id;
  const { notes } = req.body || {};
  try {
    if (usePgBookings(req)) {
      console.log('Bookings write backend: postgres');
      pgUpdateNotes(req.session.workspaceId, bookingId, notes || '')
        .then((bk)=> bk ? res.json(bk) : res.status(404).json({ error:'Booking not found' }))
        .catch((e)=>{ console.error('Failed to save comment (pg)', e); res.status(500).json({ error:'Failed to save comment' });});
      return;
    }

    const bookings = readBookingsLocal();
    const idx = bookings.findIndex(
      b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId))
    );
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });
    bookings[idx].notes = typeof notes === 'string' ? notes : '';
    writeBookingsLocal(bookings);
    pushBookingsToGist(bookings).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to save comment', e);
    res.status(500).json({ error: 'Failed to save comment' });
  }
});

const IS_PROD = process.env.APP_ENV === 'production';
const BOOKINGS_BACKEND = process.env.BOOKINGS_BACKEND || 'localjson';
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || null;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const RESET_TOKEN_TTL_MINUTES = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
const VERIFY_TOKEN_TTL_MINUTES = Number(process.env.VERIFY_TOKEN_TTL_MINUTES || 60);
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Fetch user from DB by email
async function getUserByEmail(email) {
  if (!pool) return null;
  const norm = normalizeEmail(email);
  const { rows } = await pool.query(
    `SELECT id, phone, password_hash, role, workspace_id, full_name, email,
            email_verified, email_verification_token_hash, email_verification_expires_at,
            facebook_id, auth_provider
     FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [norm]
  );
  return rows[0] || null;
}

async function getUserByFacebookId(facebookId) {
  if (!pool || !facebookId) return null;
  const { rows } = await pool.query(
    `SELECT id, phone, password_hash, role, workspace_id, full_name, email,
            email_verified, facebook_id, auth_provider
     FROM users WHERE facebook_id = $1 LIMIT 1`,
    [facebookId]
  );
  return rows[0] || null;
}

async function linkFacebookToUser(userId, facebookId) {
  if (!pool || !userId || !facebookId) return null;
  const { rows } = await pool.query(
    `UPDATE users SET facebook_id = $1, auth_provider = 'facebook' WHERE id = $2 RETURNING *`,
    [facebookId, userId]
  );
  return rows[0] || null;
}

async function getUserById(userId) {
  if (!pool || !userId) return null;
  const { rows } = await pool.query(
    'SELECT id, phone, role, workspace_id, full_name, email, email_verified FROM users WHERE id = $1 LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

async function getDefaultUnit(workspaceId) {
  if (!pool || !workspaceId) return null;
  const { rows } = await pool.query(
    'SELECT id, workspace_id, unit_number, unit_owner_name, unit_phone, name, signature_file_key FROM units WHERE workspace_id = $1 AND is_default = true LIMIT 1',
    [workspaceId]
  );
  return rows[0] || null;
}

async function ensureDefaultUnit(workspaceId, client = null) {
  if (!pool || !workspaceId) return null;
  const runner = client || pool;
  const { rows: existing } = await runner.query(
    'SELECT id, workspace_id, unit_number, unit_owner_name, unit_phone, name, signature_file_key FROM units WHERE workspace_id = $1 AND is_default = true LIMIT 1',
    [workspaceId]
  );
  if (existing && existing[0]) return existing[0];
  const insert = await runner.query(
    'INSERT INTO units (workspace_id, name, is_default, unit_number, unit_owner_name, unit_phone, signature_file_key) VALUES ($1,$2,true,NULL,NULL,NULL,NULL) RETURNING id, workspace_id, unit_number, unit_owner_name, unit_phone, name, signature_file_key',
    [workspaceId, 'Default Unit']
  );
  return insert.rows[0] || null;
}

async function createUserAndWorkspaceFromFacebook(profile) {
  if (!pool || !profile || !profile.email) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wsName = profile.name ? `${profile.name}'s workspace` : 'New workspace';
    const ws = await client.query(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
      [wsName]
    );
    const workspaceId = ws.rows[0].id;
    const user = await client.query(
      `INSERT INTO users (full_name, email, role, workspace_id, auth_provider, facebook_id, password_hash, email_verified, email_verified_at)
       VALUES ($1,$2,'admin',$3,'facebook',$4,NULL,true,NOW())
       RETURNING id, role, workspace_id, full_name, email`,
      [profile.name || '', profile.email, workspaceId, profile.id]
    );
    await ensureDefaultUnit(workspaceId, client);
    await client.query('COMMIT');
    return user.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function isUnitConfigured(unit) {
  if (!unit) return false;
  const required = [
    unit.unit_number,
    unit.unit_owner_name,
    unit.unit_phone,
    unit.signature_file_key
  ];
  return required.every((v) => v !== null && v !== undefined && String(v).trim() !== '');
}

// --- Password reset helpers ---
const resetRateEmail = new Map();
const resetRateIp = new Map();
function rateLimit(map, key, windowMs = 60_000, max = 5) {
  const now = Date.now();
  const arr = map.get(key) || [];
  const recent = arr.filter(t => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  map.set(key, recent);
  return true;
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueEmailVerification(userId, email, client = null) {
  const runner = client || pool;
  const normEmail = normalizeEmail(email);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expires = new Date(Date.now() + VERIFY_TOKEN_TTL_MINUTES * 60 * 1000);
  await runner.query(
    'UPDATE users SET email_verification_token_hash = $1, email_verification_expires_at = $2, email_verified = false WHERE id = $3',
    [tokenHash, expires, userId]
  );
  const link = `${APP_BASE_URL.replace(/\/$/, '')}/verify-email?token=${token}`;
  const mailOptions = {
    from: '"SpotManager" <adam.kischinovsky@gmail.com>',
    to: normEmail,
    subject: 'Verify your email',
    text: `Please verify your email by clicking the link below (expires in ${VERIFY_TOKEN_TTL_MINUTES} minutes):\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
  };
  if (!IS_PROD) console.log('[verify-email] sent to', normEmail);
  await safeSendMail(mailOptions);
}



// ---- Per-environment credentials (hardcoded) ----
// ✅ Replace the sample values with your real ones.
const ADMIN_USER = IS_PROD ? 'admin' : 'admin';
const ADMIN_PASS = IS_PROD ? 'gern_jark_FLIT' : '1234';

// If you also want different cleaner creds per environment, set them here too:
const CLEANER_USER = IS_PROD ? 'Diane' : 'Diane';
const CLEANER_PASS = IS_PROD ? '2525'  : '2525';

// Viewer can remain the same across envs (read-only):
const VIEWER_USER = 'viewer';
const VIEWER_PASS = 'viewonly';







const SftpClient = require('ssh2-sftp-client');

// Base dir you created on the server
const SFTP_ROOT = process.env.SFTP_BASE_DIR || '/var/www/www.demoaleph.dk/spotmanager/staging';
const ON_RENDER = !!process.env.RENDER || !!process.env.RENDER_SERVICE_ID;

function hasSftpCreds() {
  return Boolean(
    process.env.SFTP_HOST &&
    process.env.SFTP_USER &&
    process.env.SFTP_PRIVATE_KEY
  );
}

const USE_SFTP_SIGNATURES = hasSftpCreds() && (IS_PROD || ON_RENDER);
if (!IS_PROD) {
  console.log('[signature] USE_SFTP_SIGNATURES=', USE_SFTP_SIGNATURES, 'ON_RENDER=', ON_RENDER);
}


function getSftp() {
  const sftp = new SftpClient();

  // Render sometimes stores multiline keys as literal "\n"
  const rawKey = process.env.SFTP_PRIVATE_KEY || '';
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;

  return sftp.connect({
    host: process.env.SFTP_HOST,
    port: process.env.SFTP_PORT ? Number(process.env.SFTP_PORT) : 22,
    username: process.env.SFTP_USER,
    privateKey,
    readyTimeout: 20000,           // be patient on cold starts
    algorithms: {                  // conservative, helps some hosts
      serverHostKey: ['ssh-ed25519', 'ssh-rsa']
    }
  }).then(() => sftp);
}

async function loadSignatureBuffer(key) {
  if (!key) return null;
  if (USE_SFTP_SIGNATURES) {
    if (!IS_PROD) console.log('[signature] fetch via SFTP', key);
    const sftp = await getSftp();
    try {
      const remotePath = `${SFTP_ROOT}/${key}`;
      const buf = await sftp.get(remotePath);
      await sftp.end();
      return buf;
    } catch (e) {
      try { await sftp.end(); } catch (_) {}
      throw e;
    }
  } else {
    const localPath = path.join(UPLOADS_DIR, key);
    if (!IS_PROD) console.log('[signature] fetch local', localPath);
    if (!fs.existsSync(localPath)) return null;
    return fs.readFileSync(localPath);
  }
}






async function safeSendMail(options) {
  const allowRealStaging = process.env.ALLOW_REAL_EMAILS_IN_STAGING === 'true';
  const stagingInbox = process.env.STAGING_MAIL_TO || 'adamkischi@hotmail.com';

  // Production: send as-is
  if (IS_PROD) {
    return transporter.sendMail(options);
  }

  // Non‑prod: always mark as staging
  const clone = { ...options };
  clone.subject = `[STAGING] ${options.subject}`;

  // Add a visible staging banner
  const bannerText = '[STAGING] This email was sent from the staging environment.';
  if (clone.html) {
    const bannerHtml = `<div style="padding:10px 12px;margin-bottom:12px;border:1px solid #ffeeba;border-radius:6px;background:#fff8e1;color:#8a6d3b;font-size:14px;">${bannerText}</div>`;
    clone.html = `${bannerHtml}${clone.html}`;
  }
  if (clone.text) {
    clone.text = `${bannerText}\n\n${clone.text}`;
  }

  if (allowRealStaging) {
    // Send to real recipient, optionally BCC staging for visibility
    if (stagingInbox) {
      clone.bcc = stagingInbox;
    }
  } else {
    // Redirect to staging inbox for safety
    clone.to = stagingInbox;
    clone.cc = undefined;
    clone.bcc = undefined;
  }

  if (!IS_PROD) {
    console.log('[mail] staging send', {
      allowRealStaging,
      to: clone.to,
      bcc: clone.bcc,
      subject: clone.subject
    });
  }

  return transporter.sendMail(clone);
}






const multer = require('multer');

// Configure multer to save in uploads/ folder
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    cb(null, `booking-${req.params.id}-${file.originalname}`);
  }
});
const upload = multer({ storage });

function formatDate(isoDate) {
  const date = new Date(isoDate);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}/${dd}-${yy}`;
}


// Separate storage for arrival stamps (force a clean, predictable filename)
const storageStamp = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg') || '.jpg';
    cb(null, `booking-${req.params.id}-stamp-${Date.now()}${ext}`);
  }
});
const uploadStamp = multer({ storage: storageStamp });

// Signature uploads
const signatureStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SIGNATURES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.png') || '.png';
    cb(null, `sig-temp-${Date.now()}${ext}`);
  }
});
const uploadSignature = multer({ storage: signatureStorage });





app.get('/upload-id/:id', requireAdmin, (req, res) => {
  const bookingId = req.params.id;

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) throw err;
    const bookings = JSON.parse(data);
    const booking = bookings.find(b => b.timestamp === bookingId);

    if (!booking) return res.send('Booking not found.');

    res.send(`
      <html>
        <head>
          <title>Upload ID for ${booking.guestName}and </title>
          <link rel="stylesheet" href="/style.css" />
        </head>
        <body>
        <div class="modal-container">
        <a href="#" class="modal-close" onclick="window.parent.closeModal(); return false;" aria-label="Close">&times;</a>
          <h1>Upload ID for ${booking.guestName}</h1>
          <form id="upload" class="modal-form" enctype="multipart/form-data">
            <input type="file" name="guestIds" multiple accept="image/*,application/pdf" required><br><br>
            <button type="submit">Upload Files</button>
        </form>
        </div>

        <script>
  document.getElementById('upload').addEventListener('submit', async function(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);

    try {
      const response = await fetch('/upload-id/${booking.timestamp}', {
        method: 'POST',
        body: formData // ✅ do NOT use URLSearchParams here
      });

      if (response.ok) {
        window.parent.closeModal();
        window.parent.location.reload();
      } else {
        alert('Failed to upload files.');
      
      }
    } catch (err) {
      alert('Error occurred while uploading.');
      console.error(err);
    }
  });
</script>

        </body>
      </html>
    `);
  });
});



app.get('/_sftp-test', async (req, res) => {
  try {
    const sftp = await getSftp();
    const cwd = await sftp.cwd();
    await sftp.end();
    res.send('SFTP OK. cwd=' + cwd);
  } catch (e) {
    console.error('SFTP test failed:', e);
    res.status(500).send('SFTP test failed: ' + (e && e.message ? e.message : String(e)));
  }
});





app.post('/upload-id/:id', requireAdmin, upload.array('guestIds', 10), async (req, res) => {
  const bookingId = req.params.id;

  if (!req.files || req.files.length === 0) {
    return res.status(400).send('No files uploaded.');
  }

  try {
    // ---- 1) Save the files (SFTP in prod, keep locally on staging/local) ----
    if (IS_PROD && hasSftpCreds()) {
      const sftp = await getSftp();
      const remoteDir = `${SFTP_ROOT}/ids`;
      try { await sftp.mkdir(remoteDir, true); } catch (_) {}

      for (const f of req.files) {
        const localPath = path.join(UPLOADS_DIR, f.filename);
        const remotePath = `${remoteDir}/${f.filename}`;
        await sftp.put(localPath, remotePath);
        if (!IS_PROD) {
          console.log(`[id-upload] saved booking-${bookingId}-${f.originalname} to ${remotePath}`);
        }
        try { fs.unlinkSync(localPath); } catch (_) {}
      }

      await sftp.end();
    }
    // (On local / staging we already saved into UPLOADS_DIR via multer; nothing else to do.)
    if (!IS_PROD) {
      req.files.forEach(f => {
        console.log(`[id-upload] saved booking-${bookingId}-${f.originalname} to ${f.path || (UPLOADS_DIR + '/' + f.filename)}`);
      });
    }

    // ---- 2) Mark "ID uploaded" on the booking checklist (step1) ----
    let bookings = readBookingsLocal();   // uses the helpers defined later in the file
    const idx = bookings.findIndex(
      b =>
        String(b.timestamp) === String(bookingId) ||
        (b.id && String(b.id) === String(bookingId))
    );

    if (idx !== -1) {
      if (!bookings[idx].checklist) {
        bookings[idx].checklist = {};
      }
      bookings[idx].checklist.step1 = true;

      writeBookingsLocal(bookings);
      // mirror to Gist, but don't block response if it fails
      pushBookingsToGist(bookings).catch(() => {});
    }

    // ---- 3) Simple 200 response for both modal + in-page uploads ----
    return res.status(200).send('OK');
  } catch (e) {
    console.error('SFTP upload failed:', e);
    return res.status(500).send('Failed to upload to SFTP: ' + e.message);
  }
});


app.get('/view-ids/:id', async (req, res) => {
  const bookingId = req.params.id;

    // Local/staging: list from local uploads folder, Production: use SFTP
  if (!IS_PROD || !hasSftpCreds()) {
    try {
      const files = fs.readdirSync(UPLOADS_DIR);
      const matching = files.filter(
        name =>
          name.includes(`booking-${bookingId}-`) &&
          !name.includes('-stamp-') // exclude payment receipts from ID viewer
      );

      // Optional: read bookings to show guest name (same as your SFTP path does)
      const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
      const booking = bookings.find(
        b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId))
      );
      const guestName = booking ? booking.guestName : '';

      const remaining = matching.length;
      const notifyScript = `<script>
        (function(){
          try {
            if (window.parent) {
              window.parent.postMessage({ type: 'idsCount', bookingId: ${JSON.stringify(bookingId)}, count: ${remaining} }, '*');
            }
          } catch (_) {}
        })();
      </script>`;

      if (remaining === 0) {
        return res.send(`
        <html>
          <head>
            <style>
              :root {
                --accent: #10b981;
                --text: #0f172a;
                --muted: #6b7280;
                --border: rgba(148,163,184,0.4);
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: linear-gradient(135deg, #ecfdf5, #ffffff);
                color: var(--text);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 32px 16px;
              }
              .modal-card {
                width: min(920px, 100%);
                background: #ffffff;
                border: 1px solid var(--border);
                border-radius: 18px;
                box-shadow: 0 20px 45px rgba(15, 23, 42, 0.12);
                padding: 24px 28px 28px;
              }
              .modal-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                margin-bottom: 18px;
              }
              .title {
                font-size: 22px;
                font-weight: 700;
                margin: 0;
              }
              .subtitle { color: var(--muted); margin: 4px 0 0; font-size: 14px; }
              .close {
                border: 1px solid var(--border);
                border-radius: 999px;
                width: 36px;
                height: 36px;
                background: #fff;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
              }
              .empty {
                padding: 20px;
                border: 1px dashed var(--border);
                border-radius: 12px;
                text-align: center;
                color: var(--muted);
              }
            </style>
          </head>
          <body>
            <div class="modal-card">
              <div class="modal-head">
                <div>
                  <div class="title">Guest IDs</div>
                  <div class="subtitle">${guestName || ''}</div>
                </div>
                <button class="close" onclick="window.parent.closeModal();return false;" aria-label="Close">&times;</button>
              </div>
              <div class="empty">No uploaded IDs found for this booking.</div>
            </div>
            ${notifyScript}
          </body>
        </html>
        `);
      }

      const items = matching.map(fname => {
        const encoded = encodeURIComponent(fname);
        const ext = path.extname(fname).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
        const preview = isImage
          ? `<img class="zoomable-id" src="/uploads/${encoded}" />`
          : `<a href="/uploads/${encoded}" target="_blank">${fname}</a>`;
        return `<div class="id-item">
                  ${preview}
                  <div class="delete-form">
                    <form action="/delete-id/${bookingId}/${encoded}" method="POST">
                      <button type="submit" class="delete-btn">Delete</button>
                    </form>
                  </div>
                </div>`;
      }).join('');

      return res.send(`
        <html>
          <head>
            <style>
              :root {
                --accent: #10b981;
                --text: #0f172a;
                --muted: #6b7280;
                --border: rgba(148,163,184,0.4);
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: linear-gradient(135deg, #ecfdf5, #ffffff);
                color: var(--text);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 32px 16px;
              }
              .modal-card {
                width: min(980px, 100%);
                background: #ffffff;
                border: 1px solid var(--border);
                border-radius: 18px;
                box-shadow: 0 20px 45px rgba(15, 23, 42, 0.12);
                padding: 24px 28px 28px;
              }
              .modal-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                margin-bottom: 18px;
              }
              .title {
                font-size: 22px;
                font-weight: 700;
                margin: 0;
              }
              .subtitle { color: var(--muted); margin: 4px 0 0; font-size: 14px; }
              .close {
                border: 1px solid var(--border);
                border-radius: 999px;
                width: 36px;
                height: 36px;
                background: #fff;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
              }
              .id-gallery {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
                gap: 14px;
              }
              .id-item {
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 12px;
                background: linear-gradient(180deg, #ffffff, #f9fafb);
                box-shadow: 0 10px 20px rgba(15, 23, 42, 0.06);
              }
              .id-item img {
                width: 100%;
                height: 180px;
                object-fit: cover;
                border-radius: 10px;
                border: 1px solid var(--border);
              }
              .delete-form {
                margin-top: 10px;
                text-align: center;
              }
              .delete-btn {
                border: 1px solid rgba(239, 68, 68, 0.3);
                background: #fff1f2;
                color: #b91c1c;
                padding: 8px 12px;
                border-radius: 10px;
                cursor: pointer;
                font-weight: 600;
              }
              .delete-btn:hover { background: #fee2e2; }
              a { color: var(--accent); font-weight: 600; text-decoration: none; }
            </style>
          </head>
          <body>
            <div class="modal-card">
              <div class="modal-head">
                <div>
                  <div class="title">Guest IDs</div>
                  <div class="subtitle">${guestName || ''}</div>
                </div>
                <button class="close" onclick="window.parent.closeModal();return false;" aria-label="Close">&times;</button>
              </div>
              <div class="id-gallery">${items}</div>
            </div>
            ${notifyScript}
          </body>
        </html>
      `);
    } catch (e) {
      return res.status(500).send('Failed to list local IDs: ' + e.message);
    }
  }





  try {
    const sftp = await getSftp();
    const remoteDir = `${SFTP_ROOT}/ids`;
    let list = [];
    try {
      list = await sftp.list(remoteDir);
    } catch (_) {
      list = [];
    }
    await sftp.end();

    const matching = list
      .map(f => f.name)
      .filter(
        name =>
          name.includes(`booking-${bookingId}-`) &&
          !name.includes('-stamp-') // exclude payment receipts from ID viewer
      );

      // 🔎 Look up this booking so we can show the guest name in the modal title
const bookings =
  typeof readBookingsLocal === 'function'
    ? readBookingsLocal()
    : JSON.parse(fs.readFileSync(bookingsFile, 'utf8')); // fallback if you don't have readBookingsLocal()

// try to match either timestamp or id
const booking = bookings.find(
  b =>
    String(b.timestamp) === String(bookingId) ||
    (b.id && String(b.id) === String(bookingId))
);

      const guestName = booking ? booking.guestName : '';


    const remaining = matching.length;
    const notifyScript = `<script>
      (function(){
        try {
          if (window.parent) {
            window.parent.postMessage({ type: 'idsCount', bookingId: ${JSON.stringify(bookingId)}, count: ${remaining} }, '*');
          }
        } catch (_) {}
      })();
    </script>`;

    if (remaining === 0) {
      return res.send(`
        <html>
          <head>
            <style>
              :root {
                --accent: #10b981;
                --text: #0f172a;
                --muted: #6b7280;
                --border: rgba(148,163,184,0.4);
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: linear-gradient(135deg, #ecfdf5, #ffffff);
                color: var(--text);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 32px 16px;
              }
              .modal-card {
                width: min(920px, 100%);
                background: #ffffff;
                border: 1px solid var(--border);
                border-radius: 18px;
                box-shadow: 0 20px 45px rgba(15, 23, 42, 0.12);
                padding: 24px 28px 28px;
              }
              .modal-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                margin-bottom: 18px;
              }
              .title {
                font-size: 22px;
                font-weight: 700;
                margin: 0;
              }
              .subtitle { color: var(--muted); margin: 4px 0 0; font-size: 14px; }
              .close {
                border: 1px solid var(--border);
                border-radius: 999px;
                width: 36px;
                height: 36px;
                background: #fff;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
              }
              .empty {
                padding: 20px;
                border: 1px dashed var(--border);
                border-radius: 12px;
                text-align: center;
                color: var(--muted);
              }
            </style>
          </head>
          <body>
            <div class="modal-card">
              <div class="modal-head">
                <div>
                  <div class="title">Guest IDs</div>
                  <div class="subtitle">${guestName || ''}</div>
                </div>
                <button class="close" onclick="window.parent.closeModal();return false;" aria-label="Close">&times;</button>
              </div>
              <div class="empty">No uploaded IDs found for this booking.</div>
            </div>
            ${notifyScript}
          </body>
        </html>
      `);
    }

    const items = matching.map(fname => {
      const encoded = encodeURIComponent(fname);
      const ext = path.extname(fname).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
      const preview = isImage
        ? `<img class="zoomable-id" src="/id/${encoded}" />`
        : `<a href="/id/${encoded}" target="_blank">${fname}</a>`;
      return `<div class="id-item">${preview}
                <div class="delete-form">
                  <form action="/delete-id/${bookingId}/${encoded}" method="POST">
                    <button type="submit" class="delete-btn">Delete</button>
                  </form>
                </div>
              </div>`;
    }).join('');

    res.send(`
      <html>
        <head>
          <style>
            :root {
              --accent: #10b981;
              --text: #0f172a;
              --muted: #6b7280;
              --border: rgba(148,163,184,0.4);
            }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              background: linear-gradient(135deg, #ecfdf5, #ffffff);
              color: var(--text);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 32px 16px;
            }
            .modal-card {
              width: min(980px, 100%);
              background: #ffffff;
              border: 1px solid var(--border);
              border-radius: 18px;
              box-shadow: 0 20px 45px rgba(15, 23, 42, 0.12);
              padding: 24px 28px 28px;
            }
            .modal-head {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 12px;
              margin-bottom: 18px;
            }
            .title {
              font-size: 22px;
              font-weight: 700;
              margin: 0;
            }
            .subtitle { color: var(--muted); margin: 4px 0 0; font-size: 14px; }
            .close {
              border: 1px solid var(--border);
              border-radius: 999px;
              width: 36px;
              height: 36px;
              background: #fff;
              cursor: pointer;
              font-size: 18px;
              line-height: 1;
            }
            .id-gallery {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
              gap: 14px;
            }
            .id-item {
              border: 1px solid var(--border);
              border-radius: 12px;
              padding: 12px;
              background: linear-gradient(180deg, #ffffff, #f9fafb);
              box-shadow: 0 10px 20px rgba(15, 23, 42, 0.06);
            }
            .id-item img {
              width: 100%;
              height: 180px;
              object-fit: cover;
              border-radius: 10px;
              border: 1px solid var(--border);
            }
            .delete-form {
              margin-top: 10px;
              text-align: center;
            }
            .delete-btn {
              border: 1px solid rgba(239, 68, 68, 0.3);
              background: #fff1f2;
              color: #b91c1c;
              padding: 8px 12px;
              border-radius: 10px;
              cursor: pointer;
              font-weight: 600;
            }
            .delete-btn:hover { background: #fee2e2; }
            a { color: var(--accent); font-weight: 600; text-decoration: none; }
          </style>
        </head>
        <body>
          <div class="modal-card">
            <div class="modal-head">
              <div>
                <div class="title">Guest IDs</div>
                <div class="subtitle">${guestName || ''}</div>
              </div>
              <button class="close" onclick="window.parent.closeModal();return false;" aria-label="Close">&times;</button>
            </div>
            <div class="id-gallery">${items}</div>
          </div>
          ${notifyScript}
        </body>
      </html>
    `);
  } catch (e) {
    console.error('/view-ids error:', e);
    res.status(500).send('Failed to list IDs: ' + e.message);
  }
});

// return a single file from SFTP (Buffer)
app.get('/id/:filename', async (req, res) => {
  const file = req.params.filename;                 // Express already URL-decodes
  const remotePath = `${SFTP_ROOT}/ids/${file}`;

  try {
    const sftp = await getSftp();
    const data = await sftp.get(remotePath);        // ← Buffer
    await sftp.end();

    const ext = path.extname(file).toLowerCase();
    if (ext === '.pdf') res.setHeader('Content-Type', 'application/pdf');
    else if (ext === '.png') res.setHeader('Content-Type', 'image/png');
    else if (ext === '.jpg' || ext === '.jpeg') res.setHeader('Content-Type', 'image/jpeg');
    else res.setHeader('Content-Type', 'application/octet-stream');

    // (optional) small cache so the modal feels snappier
    res.setHeader('Cache-Control', 'public, max-age=60');

    res.send(data);                                  // send Buffer
  } catch (e) {
    console.error('SFTP get error:', e);
    res.status(404).send('File not found');
  }
});





app.post('/delete-id/:id/:filename', requireAdmin, async (req, res) => {
  const bookingId = req.params.id;
  const file = path.basename(req.params.filename); // prevent path traversal

  const markIdPending = () => {
    try {
      const bookings = readBookingsLocal();
      const idx = bookings.findIndex(
        b =>
          String(b.timestamp) === String(bookingId) ||
          (b.id && String(b.id) === String(bookingId))
      );
      if (idx !== -1) {
        bookings[idx].checklist = bookings[idx].checklist || {};
        bookings[idx].checklist.step1 = false;
        writeBookingsLocal(bookings);
        pushBookingsToGist(bookings).catch(() => {});
      }
    } catch (e) {
      console.error('Failed to mark ID as pending after delete:', e);
    }
  };

  // Local/staging: delete from uploads folder
  if (!IS_PROD || !hasSftpCreds()) {
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, file));

      // If no IDs remain, mark checklist as pending again
      const remaining = fs
        .readdirSync(UPLOADS_DIR)
        .filter(name => name.includes(`booking-${bookingId}-`)).length;
      if (remaining === 0) {
        markIdPending();
      }

      return res.redirect(`/view-ids/${bookingId}`);
    } catch (e) {
      console.error('Local delete error:', e);
      return res.status(500).send('Error deleting file');
    }
  }

  // Production: delete from SFTP
  try {
    const sftp = await getSftp();
    await sftp.delete(`${SFTP_ROOT}/ids/${file}`);
    let remaining = 0;
    try {
      const list = await sftp.list(`${SFTP_ROOT}/ids`);
      remaining = list
        .map(f => f.name)
        .filter(name => name.includes(`booking-${bookingId}-`)).length;
    } catch (_) {}

    await sftp.end();

    if (remaining === 0) {
      markIdPending();
    }

    res.redirect(`/view-ids/${bookingId}`);
  } catch (e) {
    console.error('SFTP delete error:', e);
    res.status(500).send('Error deleting file');
  }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());


app.get('/OneSignalSDKWorker.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'OneSignalSDKWorker.js'));
});
app.get('/OneSignalSDKUpdaterWorker.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'OneSignalSDKUpdaterWorker.js'));
});


const favicon = require('serve-favicon');
app.use(
  favicon(path.join(__dirname, 'public', 'favicon.ico'), { maxAge: '1h' })
);






// Serve your views (HTML files in the views folder):
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'reset-password.html'));
});

app.get('/add-booking', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'add-booking.html'));
});

// Set view engine to render .html using ejs
app.set('views', path.join(__dirname, 'views'));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');



// Add booking form
app.get('/add-booking', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'add-booking.html'));
});

// Handle form submission
app.post('/save-booking', requireAdmin, async (req, res) => {

  const newBooking = {
    guestName: req.body.guestName,
    guestName2: req.body.guestName2,
    checkIn: req.body.checkIn,
    checkOut: req.body.checkOut,
    platform: req.body.platform,
    people: req.body.people,
    notes: req.body.notes,
    timestamp: new Date().toISOString()
  };

  if (usePgBookings(req)) {
    if (!req.session.workspaceId) {
      console.error('save-booking: missing workspaceId');
      return res.status(400).send('workspace not set');
    }
    console.log('Bookings write backend: postgres');
    try {
      const { rows } = await pool.query(
        `INSERT INTO bookings (
            workspace_id, guest_name, check_in, check_out, platform, people, notes,
            step1, step2, step3, step4, step5, email_sent, cleaned, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,false,false,false,false,false,false,false,NOW(),NOW())
         RETURNING id`,
        [
          req.session.workspaceId,
          newBooking.guestName || '',
          newBooking.checkIn || null,
          newBooking.checkOut || null,
          newBooking.platform || '',
          newBooking.people || null,
          newBooking.notes || ''
        ]
      );
      const newId = rows[0]?.id;
      return res.json({ ok: true, id: newId });
    } catch (e) {
      console.error('Error saving booking to postgres:', e);
      return res.status(500).send('An error occurred while saving the booking.');
    }
  }

  try {
    const data = await fs.promises.readFile(bookingsFile, 'utf8');
    const bookings = JSON.parse(data || '[]');
    bookings.push(newBooking);

    // Write locally first (so current runtime has the data)
    await fs.promises.writeFile(bookingsFile, JSON.stringify(bookings, null, 2));

    // Mirror to Gist (don’t block the response if GitHub is slow)
    pushBookingsToGist(bookings).catch(() => {});

    // Format checkOutDate to MM-DD-YYYY (unchanged)
    const checkOut = new Date(newBooking.checkOut);
    const formattedDate = `${(checkOut.getMonth() + 1).toString().padStart(2, '0')}-${checkOut.getDate().toString().padStart(2, '0')}-${checkOut.getFullYear()}`;

    // Send push notification with formatted date (unchanged)
    await sendPushNotification(`New cleaning task created (${formattedDate})`);

    res.send('<h2>Booking saved to file! <a href="/dashboard">Go back</a></h2>');
  } catch (err) {
    console.error('Error saving booking:', err);
    res.status(500).send('An error occurred while saving the booking.');
  }
});


app.get('/send-cleaning-reminder', async (req, res) => {
  try {
    const data = await fs.promises.readFile(bookingsFile, 'utf8');
    const bookings = JSON.parse(data);

    // Convert UTC time to Manila time (UTC+8)
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const manilaTime = new Date(utc + 8 * 60 * 60000);

    // Get tomorrow's date in YYYY-MM-DD
    manilaTime.setDate(manilaTime.getDate() + 1);
    const tomorrow = manilaTime.toISOString().split('T')[0];

    const matching = bookings.filter(b => b.checkOut === tomorrow);

    if (matching.length > 0) {
      const message = `Reminder: Cleaning task tomorrow (${formatDateForMessage(manilaTime)})`;
      await sendPushNotification(message);
      return res.send('Notification sent: ' + message);
    } else {
      return res.send('No check-outs tomorrow.');
    }
  } catch (error) {
    console.error('Error in /send-cleaning-reminder:', error);
    return res.status(500).send('Server error: ' + error.message);
  }
});

function formatDateForMessage(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}






// Handle login (email only)
app.post('/login', async (req, res) => {

  const { email, password } = req.body;
  if (!email || !password) return res.redirect('/?error=1');
  const normEmail = normalizeEmail(email);




  // 1) DB login first
  try {
    const user = await getUserByEmail(normEmail);
    if (user) {
      const ok = await bcrypt.compare(password, user.password_hash);
      if (ok) {
        if (!user.email_verified) {
          return res.redirect('/?unverified=1');
        }
        req.session.loggedIn = true;
        req.session.role = user.role;
        req.session.workspaceId = user.workspace_id || DEFAULT_WORKSPACE_ID || null;
        req.session.userId = user.id || null;
        req.session.fullName = user.full_name || '';
        req.session.email = user.email ? normalizeEmail(user.email) : normEmail;
        // Redirect based on role
        if (user.role === 'cleaner') return res.redirect('/cleaner-dashboard');
        return res.redirect('/dashboard-new');
      }
      return res.redirect('/?error=1');
    }
  } catch (e) {
    console.error('DB login failed:', e.message);
    // If DB is down, we fall back to the old env/hardcoded login below.
  }






  // Admin (env-specific)
  if (normEmail === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    req.session.role = 'admin';
    req.session.userId = null;
    req.session.fullName = 'Admin';
    req.session.email = normEmail;
    return res.redirect('/dashboard-new');
  }

  // Cleaner (env-specific if you changed CLEANER_* above)
  if (normEmail === CLEANER_USER && password === CLEANER_PASS) {
    req.session.loggedIn = true;
    req.session.role = 'cleaner';
    req.session.email = normEmail;
    return res.redirect('/cleaner-dashboard');
  }

  // Viewer (read-only; same for both envs)
  if (normEmail === VIEWER_USER && password === VIEWER_PASS) {
    req.session.loggedIn = true;
    req.session.role = 'viewer';
    req.session.userId = null;
    req.session.fullName = 'Viewer';
    req.session.email = normEmail;
    return res.redirect('/dashboard-new');
  }

  // No match
  return res.redirect('/?error=1');
});

// Forgot password: request reset link
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: true }); // keep generic
    const { email } = req.body || {};
    const normEmail = normalizeEmail(email);
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!rateLimit(resetRateIp, ip, 60_000, 10) || !rateLimit(resetRateEmail, normEmail || 'none', 60_000, 5)) {
      return res.status(200).json({ ok: true });
    }
    if (!normEmail) return res.status(200).json({ ok: true });

    const user = await getUserByEmail(normEmail);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
      await pool.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES ($1,$2,$3,NOW())`,
        [user.id, tokenHash, expiresAt]
      );
      const link = `${APP_BASE_URL.replace(/\/$/, '')}/reset-password?token=${token}`;
      const mailOptions = {
        from: '"SpotManager" <adam.kischinovsky@gmail.com>',
        to: normEmail,
        subject: 'Password reset',
        text: `Use the link below to reset your password. This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes.\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
      };
      if (!IS_PROD) console.log('[reset-request]', 'email=', normEmail);
      await safeSendMail(mailOptions);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('forgot-password failed', e);
    return res.status(200).json({ ok: true });
  }
});

// Reset password using token
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'unavailable' });
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'Invalid request' });

    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at, u.id as uid
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = $1
       LIMIT 1`,
      [tokenHash]
    );
    const row = rows[0];
    const now = new Date();
    if (!row || row.used_at || new Date(row.expires_at) < now) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id]);
    await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [row.id]);
    if (!IS_PROD) console.log('[reset-complete]', 'user=', row.user_id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('reset-password failed', e);
    return res.status(400).json({ error: 'Invalid or expired token' });
  }
});

// Resend verification email
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    if (!pool) return res.status(200).json({ ok: true });
    const { email } = req.body || {};
    const normEmail = normalizeEmail(email);
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!rateLimit(resetRateIp, ip, 60_000, 10) || !rateLimit(resetRateEmail, normEmail || 'none', 60_000, 5)) {
      return res.status(200).json({ ok: true });
    }
    if (normEmail) {
      const user = await getUserByEmail(normEmail);
      if (user && !user.email_verified) {
        await issueEmailVerification(user.id, user.email);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('resend-verification failed', e);
    return res.status(200).json({ ok: true });
  }
});

// Verify email
app.get('/verify-email', async (req, res) => {
  try {
    if (!pool) return res.redirect('/?error=1');
    const token = req.query.token;
    if (!token) return res.redirect('/?error=1');
    const tokenHash = hashToken(token);
    const now = new Date();
    const { rows } = await pool.query(
      `SELECT id, email_verification_expires_at, email_verified FROM users WHERE email_verification_token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    const user = rows[0];
    if (!user || user.email_verified || new Date(user.email_verification_expires_at) < now) {
      return res.redirect('/?error=1');
    }
    await pool.query(
      `UPDATE users
       SET email_verified = true, email_verified_at = NOW(),
           email_verification_token_hash = NULL, email_verification_expires_at = NULL
       WHERE id = $1`,
      [user.id]
    );
    if (!IS_PROD) console.log('[verify-email] completed for user', user.id);
    return res.redirect('/?verified=1');
  } catch (e) {
    console.error('verify-email failed', e);
    return res.redirect('/?error=1');
  }
});


// end session on log out
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.redirect('/dashboard');
    }
    res.redirect('/'); // Redirect to login after logout
  });
});

// Signup (admin role)
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

app.post('/signup', async (req, res) => {
  const { fullName, phone, email, password } = req.body || {};
  const normEmail = normalizeEmail(email);
  const normPhone = (phone || '').trim();
  const friendlyEmailError = () => res.redirect('/signup?email_exists=1');
  const friendlyPhoneError = () => res.redirect('/signup?phone_exists=1');
  // Postgres multi-tenant signup (dev/staging only)
  const usePg = !IS_PROD && BOOKINGS_BACKEND === 'postgres' && pool;
  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // email uniqueness check
      const { rows: existing } = await client.query(
        'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
        [normEmail]
      );
      if (existing[0]) {
        await client.query('ROLLBACK');
        return friendlyEmailError();
      }
      const { rows: phoneDup } = await client.query(
        'SELECT id FROM users WHERE phone = $1 LIMIT 1',
        [normPhone]
      );
      if (phoneDup[0]) {
        await client.query('ROLLBACK');
        return friendlyPhoneError();
      }
      const wsName = fullName ? `${fullName}'s workspace` : 'New workspace';
      const ws = await client.query(
        'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
        [wsName]
      );
      const workspaceId = ws.rows[0]?.id;
      const hash = await bcrypt.hash(password || '', 10);
      const user = await client.query(
        'INSERT INTO users (full_name, phone, email, password_hash, role, workspace_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, role, workspace_id, email',
        [fullName || '', normPhone || '', normEmail || '', hash, 'admin', workspaceId]
      );
      await ensureDefaultUnit(workspaceId, client);
      await issueEmailVerification(user.rows[0].id, normEmail || '', client);
      await client.query('COMMIT');
      return res.redirect('/?verify=1');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Signup failed (pg):', e.message);
      if (e && e.code === '23505') {
        const detail = (e.detail || '').toLowerCase();
        if (detail.includes('phone')) return friendlyPhoneError();
        return friendlyEmailError();
      }
      return res.redirect('/signup?error=1');
    } finally {
      client.release();
    }
  }

  // Legacy behavior (production or non-pg)
  if (!pool) {
    console.error('Signup attempted but no database configured.');
    return res.redirect('/signup?error=1');
  }
  if (!DEFAULT_WORKSPACE_ID) {
    console.error('Signup failed: DEFAULT_WORKSPACE_ID not set.');
    return res.redirect('/signup?error=1');
  }
  try {
    const hash = await bcrypt.hash(password || '', 10);
    const { rows: existing } = await pool.query(
      'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [normEmail]
    );
    if (existing[0]) return friendlyEmailError();
    const { rows: phoneDup } = await pool.query(
      'SELECT id FROM users WHERE phone = $1 LIMIT 1',
      [normPhone]
    );
    if (phoneDup[0]) return friendlyPhoneError();
    const user = await pool.query(
      'INSERT INTO users (full_name, phone, email, password_hash, role, workspace_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [fullName || '', normPhone || '', normEmail || '', hash, 'admin', DEFAULT_WORKSPACE_ID]
    );
    await issueEmailVerification(user.rows[0]?.id, normEmail || '');
    return res.redirect('/?verify=1');
  } catch (e) {
    console.error('Signup failed:', e.message);
    if (e && e.code === '23505') {
      const detail = (e.detail || '').toLowerCase();
      if (detail.includes('phone')) return friendlyPhoneError();
      return friendlyEmailError();
    }
    return res.redirect('/signup?error=1');
  }
});

// ====== Facebook OAuth (minimal flow) ======
app.get('/auth/facebook', async (req, res) => {
  if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) return res.redirect('/?error=1');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.fb_oauth_state = state;
  const redirectUri = `${APP_BASE_URL.replace(/\/$/, '')}/auth/facebook/callback`;
  const authUrl = new URL('https://www.facebook.com/v17.0/dialog/oauth');
  authUrl.searchParams.set('client_id', FACEBOOK_APP_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', 'email,public_profile');
  return res.redirect(authUrl.toString());
});

app.get('/auth/facebook/callback', async (req, res) => {
  try {
    if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) return res.redirect('/?error=1');
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.fb_oauth_state) {
      if (!IS_PROD) console.log('[fb] state mismatch or missing code');
      return res.redirect('/?error=1');
    }
    req.session.fb_oauth_state = null;
    const redirectUri = `${APP_BASE_URL.replace(/\/$/, '')}/auth/facebook/callback`;

    // Exchange code for token
    const tokenUrl = new URL('https://graph.facebook.com/v17.0/oauth/access_token');
    tokenUrl.searchParams.set('client_id', FACEBOOK_APP_ID);
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('client_secret', FACEBOOK_APP_SECRET);
    tokenUrl.searchParams.set('code', code);
    const tokenRes = await fetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      if (!IS_PROD) console.log('[fb] token exchange failed', tokenJson);
      return res.redirect('/?error=1');
    }

    // Fetch profile
    const profileUrl = new URL('https://graph.facebook.com/me');
    profileUrl.searchParams.set('fields', 'id,name,email');
    profileUrl.searchParams.set('access_token', tokenJson.access_token);
    const profileRes = await fetch(profileUrl.toString());
    const profile = await profileRes.json();
    if (!profile || !profile.email) {
      if (!IS_PROD) console.log('[fb] missing email', profile);
      return res.redirect('/?error=1');
    }

    const fbId = profile.id;
    const fbEmail = normalizeEmail(profile.email);
    let user = await getUserByFacebookId(fbId);
    if (!user) {
      user = await getUserByEmail(fbEmail);
      if (user && !user.facebook_id) {
        await linkFacebookToUser(user.id, fbId);
        user.facebook_id = fbId;
        user.auth_provider = 'facebook';
      }
    }
    if (!user) {
      user = await createUserAndWorkspaceFromFacebook({
        id: fbId,
        email: fbEmail,
        name: profile.name || fbEmail
      });
    }

    if (!user) return res.redirect('/?error=1');

    // Set session
    req.session.loggedIn = true;
    req.session.role = user.role;
    req.session.workspaceId = user.workspace_id || DEFAULT_WORKSPACE_ID || null;
    req.session.userId = user.id || null;
    req.session.fullName = user.full_name || user.fullName || profile.name || '';
    req.session.email = user.email || fbEmail;

    if (!IS_PROD) console.log('[fb] login success user=', user.id);

    if (user.role === 'cleaner') return res.redirect('/cleaner-dashboard');
    return res.redirect('/dashboard-new');
  } catch (e) {
    console.error('Facebook auth failed', e);
    return res.redirect('/?error=1');
  }
});

function isAuthenticated(req, res, next) {
  if (req.session.loggedIn) {
    next();
  } else {
    res.redirect('/');
  }
}

// Admin-only access
function requireAdmin(req, res, next) {
  if (req.session.loggedIn && req.session.role === 'admin') {
    next();
  } else {
    res.redirect('/access-denied-page.html');
  }
}

// Admin or Cleaner (shared access)
function requireAnyUser(req, res, next) {
  if (req.session.loggedIn && (req.session.role === 'admin' || req.session.role === 'cleaner' || req.session.role === 'viewer')) {
    next();
  } else {
    res.redirect('/access-denied-page.html');
  }
}


// Allow admin OR viewer (read-only) to see the dashboard
function requireAdminOrViewer(req, res, next) {
  if (
    req.session.loggedIn &&
    (req.session.role === 'admin' || req.session.role === 'viewer')
  ) {
    return next();
  }
  return res.redirect('/access-denied-page.html');
}

function usePgBookings(req) {
  return !IS_PROD && BOOKINGS_BACKEND === 'postgres' && pool && req.session && req.session.workspaceId;
}

async function pgFetchBookings(workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, guest_name, check_in, check_out, platform, people, notes, step1, step2, step3, step4, step5, email_sent, cleaned, unit_id, created_at, updated_at
     FROM bookings
     WHERE workspace_id = $1
     ORDER BY check_in ASC`,
    [workspaceId]
  );
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.id,
    guestName: r.guest_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
    platform: r.platform,
    people: r.people,
    notes: r.notes,
    unit_id: r.unit_id,
    checklist: {
      step1: r.step1,
      step2: r.step2,
      step3: r.step3,
      step4: r.step4,
      step5: r.step5,
    },
    emailSent: r.email_sent,
    cleaned: r.cleaned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function mapBookingRow(r){
  if (!r) return null;
  return {
    id: r.id,
    timestamp: r.id,
    guestName: r.guest_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
    platform: r.platform,
    people: r.people,
    notes: r.notes,
    unit_id: r.unit_id,
    checklist: {
      step1: r.step1,
      step2: r.step2,
      step3: r.step3,
      step4: r.step4,
      step5: r.step5,
    },
    emailSent: r.email_sent,
    cleaned: r.cleaned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function pgFetchBookingById(workspaceId, bookingId) {
  const { rows } = await pool.query(
    `SELECT id, guest_name, check_in, check_out, platform, people, notes, step1, step2, step3, step4, step5, email_sent, cleaned, unit_id, created_at, updated_at
     FROM bookings
     WHERE workspace_id = $1 AND id::text = $2
     LIMIT 1`,
    [workspaceId, String(bookingId)]
  );
  return mapBookingRow(rows[0]);
}

async function pgUpdateChecklist(workspaceId, bookingId, field, val) {
  // Map field names to DB columns while strictly whitelisting allowed fields
  const allowed = {
    step1: 'step1',
    step2: 'step2',
    step3: 'step3',
    step4: 'step4',
    step5: 'step5',
    emailSent: 'email_sent',
    cleaned: 'cleaned',
  };
  const column = allowed[field];
  if (!column) return false;
  const { rows } = await pool.query(
    `UPDATE bookings SET ${column} = $1, updated_at = NOW()
     WHERE workspace_id = $2 AND id = $3
     RETURNING id, guest_name, check_in, check_out, platform, people, notes, step1, step2, step3, step4, step5, email_sent, cleaned, created_at, updated_at`,
    [val === true || val === 'true', workspaceId, bookingId]
  );
  return mapBookingRow(rows[0]) || false;
}

async function pgFetchUnitById(workspaceId, unitId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id, workspace_id, unit_number, unit_owner_name, unit_phone, name, signature_file_key, is_default
     FROM units
     WHERE workspace_id = $1 AND id = $2
     LIMIT 1`,
    [workspaceId, unitId]
  );
  return rows[0] || null;
}

async function resolveUnitForBooking(workspaceId, booking) {
  if (!booking || !workspaceId) return null;
  if (booking.unit_id) {
    const u = await pgFetchUnitById(workspaceId, booking.unit_id);
    if (u) return u;
  }
  return await getDefaultUnit(workspaceId);
}

function validateUnitForMoveIn(unit) {
  if (!unit) return ['unit missing'];
  const missing = [];
  if (!unit.unit_number) missing.push('unit number');
  if (!unit.unit_owner_name) missing.push('owner name');
  if (!unit.unit_phone) missing.push('owner phone');
  if (!unit.signature_file_key) missing.push('signature');
  return missing;
}

async function pgUpdateNotes(workspaceId, bookingId, notes) {
  const { rows } = await pool.query(
    `UPDATE bookings SET notes = $1, updated_at = NOW()
     WHERE workspace_id = $2 AND id = $3
     RETURNING id, guest_name, check_in, check_out, platform, people, notes, step1, step2, step3, step4, step5, email_sent, cleaned, created_at, updated_at`,
    [notes || '', workspaceId, bookingId]
  );
  return mapBookingRow(rows[0]) || false;
}

async function pgSetCleaned(workspaceId, bookingId, isCleaned) {
  const { rows } = await pool.query(
    `UPDATE bookings SET cleaned = $1, updated_at = NOW()
     WHERE workspace_id = $2 AND id = $3
     RETURNING id, guest_name, check_in, check_out, platform, people, notes, step1, step2, step3, step4, step5, email_sent, cleaned, created_at, updated_at`,
    [isCleaned, workspaceId, bookingId]
  );
  return mapBookingRow(rows[0]) || false;
}

async function pgSetCancelled(workspaceId, bookingId, isCancelled) {
  const { rows } = await pool.query(
    `UPDATE bookings SET cancelled = $1, updated_at = NOW()
     WHERE workspace_id = $2 AND id = $3
     RETURNING id, guest_name, check_in, check_out, platform, people, notes, step1, step2, step3, step4, step5, email_sent, cleaned, created_at, updated_at`,
    [isCancelled, workspaceId, bookingId]
  );
  return mapBookingRow(rows[0]) || false;
}





function isViewer(req) {
  return req.session.loggedIn && req.session.role === 'viewer';
}

function forbidViewer(req, res, next) {
  if (isViewer(req)) return res.status(403).send('Read-only user.');
  next();
}




// About page
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});



// DB ping (no auth) - verifies DATABASE_URL works
app.get('/api/db-ping', async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ ok: false, error: 'DATABASE_URL not set' });
  }
  if (!pool) {
    return res.status(500).json({ ok: false, error: 'DB pool not initialized' });
  }

  try {
    const result = await pool.query('SELECT 1 AS ok');
    return res.json({ ok: true, db: 'connected', result: result.rows[0] });
  } catch (e) {
    console.error('DB ping failed:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});



const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));


// ==== Gist Sync (bookings.json) ====
const GIST_ID = process.env.GIST_ID;            // set in Render
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;  // set in Render
const GIST_FILENAME = 'bookings.json';

// Central local read/write helpers (use your existing bookingsFile path)
function readBookingsLocal() {
  try {
    const txt = fs.readFileSync(bookingsFile, 'utf8');
    return txt ? JSON.parse(txt) : [];
  } catch {
    return [];
  }
}
function writeBookingsLocal(bookings) {
  fs.writeFileSync(bookingsFile, JSON.stringify(bookings, null, 2));
}

// Pull current bookings from the Gist
async function pullBookingsFromGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return null;
  try {
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        'User-Agent': 'spotmanager'
      }
    });
    if (!r.ok) return null;
    const gist = await r.json();
    const content = gist?.files?.[GIST_FILENAME]?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (e) {
    console.error('Gist pull failed:', e.message);
    return null;
  }
}

// Push new bookings to the Gist
async function pushBookingsToGist(bookings) {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'spotmanager'
      },
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: { content: JSON.stringify(bookings, null, 2) }
        }
      })
    });
  } catch (e) {
    console.error('Gist push failed:', e.message);
  }
}

// On boot: if local file is empty, hydrate it from Gist
(async () => {
  try {
    const local = readBookingsLocal();
    if (!local || local.length === 0) {
      const remote = await pullBookingsFromGist();
      if (remote && Array.isArray(remote)) {
        writeBookingsLocal(remote);
        console.log('[Gist] Hydrated bookings.json from Gist');
      } else {
        console.log('[Gist] No remote data (or auth missing); keeping local []');
      }
    }
  } catch (e) {
    console.error('[Gist] Boot hydrate error:', e.message);
  }
})();





const sendPushNotification = async (message) => {
  try {
    const finalMessage = IS_PROD ? message : `[STAGING] ${message}`;


    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`, // Now from env variable
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID, // Now from env variable
        contents: { en: finalMessage },
        included_segments: ['All'] // Or target specific segments/users if needed
      })
    });
  } catch (error) {
    console.error('Push notification error:', error);
  }
};




app.get('/upload-stamp/:id', requireAdmin, (req, res) => {
  const bookingId = req.params.id;

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) return res.send('Error reading bookings file.');
    const bookings = JSON.parse(data);
    const booking = bookings.find(
      b =>
        String(b.timestamp) === String(bookingId) ||
        (b.id && String(b.id) === String(bookingId))
    );
    if (!booking) return res.send('Booking not found.');
    const uploadTarget = booking.id || booking.timestamp;

    res.send(`
      <html>
        <head>
          <title>Upload payment receipt for ${booking.guestName}</title>
          <link rel="stylesheet" href="/style.css" />
        </head>
        <body>
          <div class="modal-container">
          <a href="#" class="modal-close" onclick="window.parent.closeModal(); return false;" aria-label="Close">&times;</a>
            <h1>Receipt for access card for ${booking.guestName}</h1>
            <p>Upload the payment receipt for the access card here.</p>

            <form id="stampForm" class="modal-form" enctype="multipart/form-data" method="POST" action="/upload-stamp/${uploadTarget}">
              <input type="file" name="stamp" accept="image/*" capture="environment" required />
              <br><br>
              <button type="submit">Upload & Send</button>
            </form>
          </div>

          <script>
            // (Optional) you could add a preview here later if you want
          </script>
        </body>
      </html>
    `);
  });
});




app.post('/upload-stamp/:id', requireAdmin, uploadStamp.single('stamp'), async (req, res) => {
  const bookingId = req.params.id;
  const noModal = req.headers['x-no-modal'] === '1';

  try {
    let booking = null;
    let bookingsLocal = null;
    let unit = null;
    if (usePgBookings(req)) {
      if (!req.session.workspaceId) {
        return res.status(400).json({ ok: false, message: 'workspace not set' });
      }
      booking = await pgFetchBookingById(req.session.workspaceId, bookingId);
      unit = await resolveUnitForBooking(req.session.workspaceId, booking);
    } else {
      bookingsLocal = readBookingsLocal();
      booking = bookingsLocal.find(
        b =>
          String(b.timestamp) === String(bookingId) ||
          (b.id && String(b.id) === String(bookingId))
      );
      unit = {
        unit_number: '___',
        unit_owner_name: 'Unit Owner'
      };
    }
    if (!booking) return res.status(404).send('Booking not found.');
    if (!req.file) return res.status(400).send('No image uploaded.');




    // Manila weekend check (UTC+8)
const now = new Date();
const manila = new Date(now.getTime() + (now.getTimezoneOffset() + 8 * 60) * 60000);
const day = manila.getDay(); // 0 Sun .. 6 Sat in Manila
const isWeekend = (day === 0 || day === 6);

// Recipients by environment (same rule as endorsement email)
const prodRecipients = isWeekend
  ? ['pmo@knightsbridgeresidences.com.ph', 'securityandsafety@knightsbridgeresidences.com.ph']
  : ['pmo@knightsbridgeresidences.com.ph'];

  // Add accounting CC only on production
const accountingCC = IS_PROD ? 'accountingservices@knightsbridgeresidences.com.ph' : undefined;

// Keep staging/local safe: always send only to your test inbox
const stagingRecipients = ['adamkischi@hotmail.com'];

const recipients = IS_PROD ? prodRecipients : stagingRecipients;

const mailOptions = {
  from: '"Adam Kischinovsky" <adam.kischinovsky@gmail.com>',
  to: recipients.join(', '),
  cc: accountingCC,
  bcc: req.session.email || 'adamkischi@hotmail.com', // copy to logged-in user
  replyTo: req.session.email || 'adamkischi@hotmail.com',
  subject: `reciept of payment for access card for ${booking.guestName}`,
  text: `Hello, this is the receipt for payment of the access card of ${booking.guestName} that will stay in unit ${unit?.unit_number || '___'}.\n\nThank you\n\n- ${unit?.unit_owner_name || 'Unit Owner'}`,
  attachments: [
    { filename: req.file.filename, path: path.join(UPLOADS_DIR, req.file.filename) }
  ]
};

    await safeSendMail(mailOptions);

    // Mark checklist step3 as complete and persist
    if (usePgBookings(req)) {
      await pgUpdateChecklist(req.session.workspaceId, bookingId, 'step3', true);
    } else if (bookingsLocal) {
      const idx = bookingsLocal.findIndex(
        b =>
          String(b.timestamp) === String(bookingId) ||
          (b.id && String(b.id) === String(bookingId))
      );
      if (idx !== -1) {
        bookingsLocal[idx].checklist = bookingsLocal[idx].checklist || {};
        bookingsLocal[idx].checklist.step3 = true;
        writeBookingsLocal(bookingsLocal);
        pushBookingsToGist(bookingsLocal).catch(() => {});
      }
    }

    // If the client is uploading without a modal, return a lightweight JSON response after sending
    if (noModal) {
      return res.status(200).json({ ok: true });
    }




    // Close the modal and refresh the dashboard
    res.send(`
      <h2>Stamp uploaded and email sent!<br><br>
      <a href="/dashboard" target="_parent">Back to Dashboard</a>
      <script>
        if (window.parent) {
          window.parent.closeModal();
          window.parent.postMessage(
            { type: 'receiptUploaded', bookingId: ${JSON.stringify(bookingId)}, count: 1 },
            '*'
          );
        } else {
          window.location.href = '/dashboard';
        }
      </script>
      </h2>
    `);
  } catch (err) {
    console.error('Stamp send error:', err);
    res.status(500).send('Failed to send stamp email: ' + err.message);
  }
});

// View uploaded payment receipts (local uploads)
app.get('/view-stamps/:id', requireAdmin, (req, res) => {
  const bookingId = req.params.id;

  try {
    const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
    const booking = bookings.find(
      b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId))
    );
    const guestName = booking ? booking.guestName : '';

    const files = fs.readdirSync(UPLOADS_DIR);
    const matching = files.filter(name =>
      name.startsWith(`booking-${bookingId}-stamp-`)
    );
    const remaining = matching.length;
    const notifyScript = `<script>
      (function(){
        try {
          if (window.parent) {
            window.parent.postMessage({ type: 'receiptUploaded', bookingId: ${JSON.stringify(bookingId)}, count: ${remaining} }, '*');
          }
        } catch (_) {}
      })();
    </script>`;

    if (matching.length === 0) {
      return res.send(`
        <html>
          <head>
            <style>
              :root { --accent:#10b981; --text:#0f172a; --muted:#6b7280; --border:rgba(148,163,184,0.4); }
              * { box-sizing: border-box; }
              body { margin:0; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:linear-gradient(135deg,#ecfdf5,#ffffff); color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:32px 16px; }
              .modal-card { width:min(820px,100%); background:#fff; border:1px solid var(--border); border-radius:18px; box-shadow:0 20px 45px rgba(15,23,42,0.12); padding:24px 28px 28px; }
              .modal-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:18px; }
              .title { font-size:22px; font-weight:700; margin:0; }
              .subtitle { color:var(--muted); margin:4px 0 0; font-size:14px; }
              .close { border:1px solid var(--border); border-radius:999px; width:36px; height:36px; background:#fff; cursor:pointer; font-size:18px; line-height:1; }
              .empty { padding:20px; border:1px dashed var(--border); border-radius:12px; text-align:center; color:var(--muted); }
            </style>
          </head>
          <body>
            <div class="modal-card">
              <div class="modal-head">
                <div>
                  <div class="title">Payment receipts</div>
                  <div class="subtitle">${guestName || ''}</div>
                </div>
                <button class="close" onclick="window.parent.closeModal();return false;" aria-label="Close">&times;</button>
              </div>
              <div class="empty">No payment receipts uploaded for this booking.</div>
            </div>
            ${notifyScript}
          </body>
        </html>
      `);
    }

    const items = matching.map(fname => {
      const encoded = encodeURIComponent(fname);
      const ext = path.extname(fname).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
      const preview = isImage
        ? `<img class="stamp-img" src="/uploads/${encoded}" />`
        : `<a href="/uploads/${encoded}" target="_blank">${fname}</a>`;
      return `<div class="stamp-item">
                ${preview}
                <div style="text-align:center;margin-top:10px">
                  <form action="/delete-stamp/${bookingId}/${encoded}" method="POST">
                    <button type="submit" style="border:1px solid rgba(239,68,68,0.3);background:#fff1f2;color:#b91c1c;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:600;">Delete</button>
                  </form>
                </div>
              </div>`;
    }).join('');

    return res.send(`
      <html>
        <head>
          <style>
            :root { --accent:#10b981; --text:#0f172a; --muted:#6b7280; --border:rgba(148,163,184,0.4); }
            * { box-sizing: border-box; }
            body { margin:0; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:linear-gradient(135deg,#ecfdf5,#ffffff); color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:32px 16px; }
            .modal-card { width:min(980px,100%); background:#fff; border:1px solid var(--border); border-radius:18px; box-shadow:0 20px 45px rgba(15,23,42,0.12); padding:24px 28px 28px; }
            .modal-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:18px; }
            .title { font-size:22px; font-weight:700; margin:0; }
            .subtitle { color:var(--muted); margin:4px 0 0; font-size:14px; }
            .close { border:1px solid var(--border); border-radius:999px; width:36px; height:36px; background:#fff; cursor:pointer; font-size:18px; line-height:1; }
            .stamp-gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; }
            .stamp-item { border:1px solid var(--border); border-radius:12px; padding:12px; background:linear-gradient(180deg,#ffffff,#f9fafb); box-shadow:0 10px 20px rgba(15,23,42,0.06); }
            .stamp-item img { width:100%; height:200px; object-fit:cover; border-radius:10px; border:1px solid var(--border); }
            a { color:var(--accent); font-weight:600; text-decoration:none; }
            .delete-form { margin-top:10px; text-align:center; }
            .delete-btn { border:1px solid rgba(239,68,68,0.3); background:#fff1f2; color:#b91c1c; padding:8px 12px; border-radius:10px; cursor:pointer; font-weight:600; }
            .delete-btn:hover { background:#fee2e2; }
          </style>
        </head>
        <body>
          <div class="modal-card">
            <div class="modal-head">
              <div>
                <div class="title">Payment receipts</div>
                <div class="subtitle">${guestName || ''}</div>
              </div>
              <button class="close" onclick="window.parent.closeModal();return false;" aria-label="Close">&times;</button>
            </div>
            <div class="stamp-gallery">${items}</div>
          </div>
          ${notifyScript}
        </body>
      </html>
    `);
  } catch (e) {
    console.error('Failed to list receipts:', e);
    return res.status(500).send('Failed to list receipts.');
  }
});

// Delete a payment receipt (local uploads only)
app.post('/delete-stamp/:id/:filename', requireAdmin, (req, res) => {
  const bookingId = req.params.id;
  const file = path.basename(req.params.filename); // prevent traversal

  try {
    fs.unlinkSync(path.join(UPLOADS_DIR, file));
  } catch (e) {
    console.error('Delete stamp error:', e);
    return res.status(500).send('Error deleting receipt');
  }

  // After deletion, check how many receipts remain for this booking
  let remaining = 0;
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    remaining = files.filter(
      name => name.startsWith(`booking-${bookingId}-stamp-`)
    ).length;
  } catch (_) {}

  // If none remain, mark checklist step3 false and persist
  try {
    const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
    const idx = bookings.findIndex(
      b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId))
    );
    if (idx !== -1) {
      bookings[idx].checklist = bookings[idx].checklist || {};
      bookings[idx].checklist.step3 = remaining > 0;
      writeBookingsLocal(bookings);
      pushBookingsToGist(bookings).catch(() => {});
    }
  } catch (e) {
    console.error('Failed to update checklist after stamp delete:', e);
  }

  res.redirect(`/view-stamps/${bookingId}`);
});



// === New Booking Dashboard (static for now) ===
app.get('/dashboard-new', requireAdminOrViewer, (req, res) => {
res.sendFile(path.join(__dirname, 'views', 'dashboard-new.html'));
});

// Account info page
app.get('/account-info', requireAnyUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'account-info.html'));
});


// === Lightweight API for wiring UI later ===
app.get('/api/bookings', requireAnyUser, async (req, res) => {
  try {
    const usePg = usePgBookings(req);
    if (usePg) {
      console.log('Bookings backend: postgres');
      if (!req.session.workspaceId) {
        console.error('GET /api/bookings: workspaceId missing in session');
        return res.status(400).json({ error: 'workspace not set' });
      }
      const { rows } = await pool.query(
        `SELECT id, guest_name, check_in, check_out, platform, people, notes,
                step1, step2, step3, step4, step5, email_sent, cleaned, created_at, updated_at
         FROM bookings
         WHERE workspace_id = $1
         ORDER BY check_in ASC`,
        [req.session.workspaceId]
      );
      const mapped = rows.map((r) => ({
        id: r.id,
        timestamp: r.id,
        guestName: r.guest_name,
        checkIn: r.check_in,
        checkOut: r.check_out,
        platform: r.platform,
        people: r.people,
        notes: r.notes,
        checklist: {
          step1: r.step1,
          step2: r.step2,
          step3: r.step3,
          step4: r.step4,
          step5: r.step5,
        },
        emailSent: r.email_sent,
        cleaned: r.cleaned,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return res.json(mapped);
    }

    console.log('Bookings backend: localjson');
    const data =
      typeof readBookingsLocal === 'function'
        ? readBookingsLocal()
        : JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));

    // On local/staging, count uploaded ID files and keep checklist in sync
    const isLocal = !IS_PROD || !hasSftpCreds();
    let idCounts = {};
    let receiptCounts = {};

    if (isLocal) {
      const extractIdFromFilename = (fname) => {
        // filename shapes:
        //   booking-<bookingId>-<timestamp>-<origName>     (ID uploads)
        //   booking-<bookingId>-stamp-<timestamp>.<ext>   (stamp uploads) -> ignore
        if (!fname.startsWith('booking-')) return null;
        if (fname.includes('-stamp-')) return null; // don't count stamps as IDs
        const m = fname.match(/^booking-(.+?)-\d{5,}-/); // non-greedy up to the numeric timestamp
        return m ? m[1] : null;
      };

      try {
        const files = fs.readdirSync(UPLOADS_DIR);
        files.forEach((fname) => {
          const id = extractIdFromFilename(fname);
          if (id) {
            idCounts[id] = (idCounts[id] || 0) + 1;
          }
          if (fname.startsWith('booking-') && fname.includes('-stamp-')) {
            const rest = fname.slice('booking-'.length);
            const mid = rest.split('-stamp-')[0];
            receiptCounts[mid] = (receiptCounts[mid] || 0) + 1;
          }
        });
      } catch (e) {
        console.error('Failed to read uploads dir for ID counts', e);
      }
    }

    let changed = false;
    const enriched = dedupeBookings(data).map((b) => {
      const id = String(b.timestamp || b.id || '');
      const count = isLocal ? (idCounts[id] || 0) : undefined;
      const receipts = isLocal ? (receiptCounts[id] || 0) : undefined;

      if (isLocal) {
        b.idFileCount = count;
        b.receiptFileCount = receipts;

        if (count > 0) {
          b.checklist = b.checklist || {};
          if (b.checklist.step1 !== true) {
            b.checklist.step1 = true;
            changed = true;
          }
        }
        if (typeof receipts === 'number') {
          if (receipts > 0) {
            b.checklist = b.checklist || {};
            if (b.checklist.step3 !== true) {
              b.checklist.step3 = true;
              changed = true;
            }
          }
        }
        // default missing fields to false for consistency
        b.checklist = b.checklist || {};
        if (typeof b.checklist.step4 !== 'boolean') b.checklist.step4 = false;
        if (typeof b.checklist.step5 !== 'boolean') b.checklist.step5 = false;
      }
      return b;
    });

    if (changed && typeof writeBookingsLocal === 'function') {
      writeBookingsLocal(data);
      if (typeof pushBookingsToGist === 'function') {
        pushBookingsToGist(data).catch(() => {});
      }
    }

    res.json(enriched);
  } catch (e) {
    console.error('GET /api/bookings failed:', e);
    res.status(500).json({ error: 'Failed to read bookings' });
  }
});

// expose session role so frontends can adapt UI state
app.get('/api/session-role', requireAnyUser, (req, res) => {
  res.json({ role: req.session.role || 'viewer' });
});

// expose session profile (name/role/email) for UI headers
app.get('/api/session-profile', requireAnyUser, async (req, res) => {
  try {
    // If session already holds profile info, return it without a DB roundtrip
    if (req.session && (req.session.fullName || req.session.workspaceId || req.session.userId)) {
      return res.json({
        role: req.session.role || 'viewer',
        fullName: req.session.fullName || '',
        phone: '',
        email: '',
        workspaceId: req.session.workspaceId || null
      });
    }

    // If we have a DB user id, fetch details; otherwise fallback to minimal info
    if (pool && req.session.userId) {
      const user = await getUserById(req.session.userId);
      if (user) {
        return res.json({
          role: user.role || req.session.role || 'viewer',
          fullName: user.full_name || '',
          phone: user.phone || '',
          email: user.email || '',
          workspaceId: user.workspace_id || null
        });
      }
    }
    // Fallback
    return res.json({
      role: req.session.role || 'viewer',
      fullName: '',
      phone: '',
      email: '',
      workspaceId: req.session.workspaceId || null
    });
  } catch (e) {
    console.error('session-profile failed:', e);
    res.status(500).json({ error: 'failed to load profile' });
  }
});

// Account info (self)
app.get('/api/account', requireAnyUser, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const user = await getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      fullName: user.full_name || '',
      phone: user.phone || '',
      email: user.email || ''
    });
  } catch (e) {
    console.error('GET /api/account failed', e);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

app.put('/api/account', requireAnyUser, express.json(), async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const { fullName, phone, email } = req.body || {};
    const normEmail = normalizeEmail(email);
    const normPhone = (phone || '').trim();
    if (!email || !fullName) {
      return res.status(400).json({ error: 'Full name and email are required' });
    }

    // Prevent duplicate emails (other users)
    const { rows: dup } = await pool.query(
      'SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2 LIMIT 1',
      [normEmail, req.session.userId]
    );
    if (dup[0]) {
      return res.status(409).json({ error: 'email_exists' });
    }
    const { rows: phoneDup } = await pool.query(
      'SELECT id FROM users WHERE phone = $1 AND id <> $2 LIMIT 1',
      [normPhone, req.session.userId]
    );
    if (phoneDup[0]) {
      return res.status(409).json({ error: 'phone_exists' });
    }

    const updated = await pool.query(
      `UPDATE users
         SET full_name = $1,
             phone = $2,
             email = $3,
             updated_at = NOW()
       WHERE id = $4
       RETURNING id, full_name, phone, email, role, workspace_id`,
      [fullName, normPhone, normEmail, req.session.userId]
    );
    if (!updated.rows[0]) return res.status(404).json({ error: 'User not found' });

    // refresh session cache
      req.session.fullName = updated.rows[0].full_name;
      req.session.email = updated.rows[0].email;
      req.session.phone = updated.rows[0].phone;

      return res.json({
        fullName: updated.rows[0].full_name,
        phone: updated.rows[0].phone,
        email: updated.rows[0].email
      });
  } catch (e) {
    if (e && e.code === '23505') {
      const detail = (e.detail || '').toLowerCase();
      if (detail.includes('phone')) return res.status(409).json({ error: 'phone_exists' });
      return res.status(409).json({ error: 'email_exists' });
    }
    console.error('PUT /api/account failed', e);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// ===== Units / default unit settings =====
app.get('/api/unit/default', requireAnyUser, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    if (!req.session.workspaceId) return res.status(400).json({ error: 'workspace not set' });
    const unit = await ensureDefaultUnit(req.session.workspaceId);
    if (!unit) return res.status(404).json({ error: 'Default unit not found' });
    if (!IS_PROD) console.log('[unit-default]', 'workspace=', req.session.workspaceId, 'unit=', unit.id);
    return res.json(unit);
  } catch (e) {
    console.error('GET /api/unit/default failed', e);
    return res.status(500).json({ error: 'failed to load unit' });
  }
});

app.put('/api/unit/default', requireAnyUser, express.json(), async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const ws = req.session.workspaceId;
    if (!ws) return res.status(400).json({ error: 'workspace not set' });
    const { name, unit_number, unit_owner_name, unit_phone } = req.body || {};
    if (!unit_number || !unit_owner_name || !unit_phone) {
      return res.status(400).json({ error: 'unit_number, unit_owner_name, unit_phone are required' });
    }
    const unit = await getDefaultUnit(ws);
    if (!unit) return res.status(404).json({ error: 'Default unit not found' });
    if (!IS_PROD) console.log('[unit-update]', 'workspace=', ws, 'unit=', unit.id, 'fields=', { name, unit_number, unit_owner_name, unit_phone });
    const { rows } = await pool.query(
      `UPDATE units SET name = $1, unit_number = $2, unit_owner_name = $3, unit_phone = $4, updated_at = NOW()
       WHERE id = $5 AND workspace_id = $6
       RETURNING id, workspace_id, unit_number, unit_owner_name, unit_phone, name, signature_file_key`,
      [name || null, unit_number, unit_owner_name, unit_phone, unit.id, ws]
    );
    return res.json(rows[0]);
  } catch (e) {
    console.error('PUT /api/unit/default failed', e);
    return res.status(500).json({ error: 'failed to update unit' });
  }
});

app.post('/api/unit/default/signature', requireAnyUser, uploadSignature.single('signature'), async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const ws = req.session.workspaceId;
    if (!ws) return res.status(400).json({ error: 'workspace not set' });
    const unit = await getDefaultUnit(ws);
    if (!unit) return res.status(404).json({ error: 'Default unit not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let ext = (path.extname(req.file.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.gif']);
    if (!allowedExt.has(ext)) ext = '.png';
    const finalRel = `signatures/unit-${unit.id}${ext}`;
    const finalPath = path.join(UPLOADS_DIR, finalRel);

  // move temp file into final path locally
  try {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.renameSync(req.file.path, finalPath);
    if (!IS_PROD) console.log('[signature] moved to', finalPath, 'exists=', fs.existsSync(finalPath));
  } catch (e) {
    console.error('Failed to move signature file', e);
    return res.status(500).json({ error: 'failed to save signature locally' });
  }

    // store signature
    if (USE_SFTP_SIGNATURES) {
      try {
        const sftp = await getSftp();
        const remoteDir = `${SFTP_ROOT}/signatures`;
        try { await sftp.mkdir(remoteDir, true); } catch (_) {}
        const remotePath = `${remoteDir}/unit-${unit.id}${ext}`;
        await sftp.put(finalPath, remotePath);
        await sftp.end();
        try { fs.unlinkSync(finalPath); } catch (_) {}
        if (!IS_PROD) console.log('[signature] uploaded to sftp', remotePath);
      } catch (e) {
        console.error('Signature SFTP upload failed', e);
        return res.status(500).json({ error: 'failed to upload signature' });
      }
    } else {
      if (!IS_PROD) console.log('[signature] stored locally at', finalPath);
    }

    if (!IS_PROD) console.log('[unit-signature]', 'workspace=', ws, 'unit=', unit.id, 'saved=', finalRel, 'useSftp=', USE_SFTP_SIGNATURES);

    await pool.query(
      'UPDATE units SET signature_file_key = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3',
      [finalRel, unit.id, ws]
    );

    return res.json({ ok: true, signature_file_key: finalRel });
  } catch (e) {
    console.error('POST /api/unit/default/signature failed', e);
    return res.status(500).json({ error: 'failed to save signature' });
  }
});

app.get('/signature/:unitId', requireAnyUser, async (req, res) => {
  try {
    if (!pool) return res.status(500).send('DB not configured');
    const ws = req.session.workspaceId;
    if (!ws) return res.status(400).send('workspace not set');
    const unitId = req.params.unitId;
    const unit = await pool.query(
      'SELECT id, workspace_id, signature_file_key FROM units WHERE id = $1 AND workspace_id = $2 LIMIT 1',
      [unitId, ws]
    );
    const row = unit.rows[0];
    if (!row || !row.signature_file_key) return res.status(404).send('Signature not found');
    const key = row.signature_file_key;

    if (USE_SFTP_SIGNATURES) {
      if (!IS_PROD) console.log('[signature] serve via sftp key=', key, 'useSftp=', USE_SFTP_SIGNATURES);
      try {
        const sftp = await getSftp();
        const remotePath = `${SFTP_ROOT}/${key}`;
        const result = await sftp.get(remotePath); // buffer or stream depending on lib
        if (!IS_PROD) console.log('[signature] sftp get typeof', typeof result, 'isBuffer', Buffer.isBuffer(result), 'remotePath', remotePath);
        const ext = path.extname(remotePath).toLowerCase();
        const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                    : ext === '.png' ? 'image/png'
                    : ext === '.gif' ? 'image/gif'
                    : 'application/octet-stream';
        res.setHeader('Content-Type', type);
        if (Buffer.isBuffer(result)) {
          res.end(result);
        } else if (result && typeof result.pipe === 'function') {
          result.pipe(res);
          result.on('error', (err)=> {
            console.error('signature stream err', err);
            if (!res.headersSent) res.status(500).end('Error');
          });
        } else {
          console.error('signature sftp get returned unsupported type');
          return res.status(500).send('Failed to load signature');
        }
        try { await sftp.end(); } catch(_) {}
      } catch (e) {
        console.error('signature sftp fetch failed', e);
        try { await sftp.end(); } catch(_) {}
        return res.status(500).send('Failed to load signature');
      }
    } else {
      const localPath = path.join(UPLOADS_DIR, key);
      if (!IS_PROD) console.log('[signature] serve local path=', localPath, 'exists=', fs.existsSync(localPath));
      if (!fs.existsSync(localPath)) return res.status(404).send('Signature not found');
      const ext = path.extname(localPath).toLowerCase();
      const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                  : ext === '.png' ? 'image/png'
                  : ext === '.gif' ? 'image/gif'
                  : 'application/octet-stream';
      res.setHeader('Content-Type', type);
      return res.sendFile(localPath);
    }
  } catch (e) {
    console.error('GET /signature/:unitId failed', e);
    return res.status(500).send('Failed');
  }
});

// Unit settings page
app.get('/unit-settings', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'unit-settings.html'));
});



// List bookings on dashboard


app.get('/dashboard', requireAdminOrViewer, (req, res) => {

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) throw err;
    const bookings = JSON.parse(data);

    const now = new Date();

  // Define categories once at the top
  const cancelled = bookings.filter(b => b.cancelled);
  const activeBookings = bookings.filter(b => !b.cancelled);

  const nowHosting = [];
  const upcoming = [];
  const past = [];

    // Categorize all bookings
activeBookings.forEach((b) => {
  const checkIn = new Date(b.checkIn);
  checkIn.setHours(14, 0, 0, 0);
  const checkOut = new Date(b.checkOut);
  checkOut.setHours(11, 0, 0, 0);

  if (now >= checkIn && now <= checkOut) {
    nowHosting.push(b);
  } else if (now < checkIn) {
    upcoming.push(b);
  } else {
    past.push(b);
  }
});

    // Sort them properly
    nowHosting.sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
    upcoming.sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
    past.sort((a, b) => new Date(b.checkOut) - new Date(a.checkOut));


    const cleanedCheckouts = bookings
  .filter(b => b.cleaned)
  .sort((a, b) => new Date(b.checkOut) - new Date(a.checkOut));

const cleanedFor = new Set();

cleanedCheckouts.forEach(b => {
  // candidates whose check-in is ON or AFTER this checkout
  const candidates = bookings
    .filter(other =>
      !other.cancelled &&
      new Date(other.checkIn) >= new Date(b.checkOut)
    )
    .sort((a, c) => new Date(a.checkIn) - new Date(c.checkIn));

  const next = candidates[0]; // earliest valid next stay
  if (next) cleanedFor.add(next.timestamp);
});



// ---- read-only helpers for "viewer" role ----
const readOnly = req.session.role === 'viewer';
const disabledAttr = readOnly ? 'disabled aria-disabled="true" style="opacity:.55; pointer-events:none"' : '';
const maybe = (html) => readOnly ? '' : html;




    function renderBookings(list) {


      

      return list.map((b) => {
        const checklist = b.checklist || {};
        const hasIncomplete = [checklist.step1, checklist.step2, checklist.step3, checklist.step4, checklist.step5].some(step => step !== true);

        const isMarkedClean = cleanedFor.has(b.timestamp);

        const isSeen = b.seen === true;

        const checkInDate = new Date(b.checkIn);
        const today = new Date();
        const timeDiff = checkInDate - today;
        const daysUntilCheckIn = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

        let cardColor = '';
        if (daysUntilCheckIn <= 3 && hasIncomplete) {
          cardColor = 'background-color: rgba(255, 0, 0, 0.3);';
        } else if (daysUntilCheckIn <= 3 && !hasIncomplete) {
          cardColor = 'background-color: rgba(7, 234, 7, 0.3);';
        }

        return `
          <li style="${cardColor}">
            ${hasIncomplete ? '<i class="fas fa-exclamation-circle alert-icon"></i>' : ''}
            <div class="button-group">
              <button ${disabledAttr} data-label="Checklist" ${maybe(`onclick="openModal('/checklist/${b.timestamp}')"`)}><i class="fas fa-clipboard-check"></i></button>
              <button ${disabledAttr} class="tab-desktop-only" data-label="Upload ID's" ${maybe(`onclick="openModal('/upload-id/${b.timestamp}')"`)}><i class="fas fa-upload"></i></button>
              <button ${disabledAttr} class="tab-desktop-only" data-label="View ID's" ${maybe(`onclick="openModal('/view-ids/${b.timestamp}')"`)}><i class="fas fa-image"></i></button>
              <button ${disabledAttr} class="tab-desktop-only" data-label="view move-in form" ${maybe(`onclick="openModal('/generate-movein/${b.timestamp}')"`)}><i class="fas fa-eye"></i></button>
              <button ${disabledAttr} data-label="Send endorsement e-mail" id="sendBtn-${b.timestamp}" ${maybe(`onclick="sendEmail('${b.timestamp}')" title="Send endorsement e-mail"`)}${b.emailSent ? 'disabled' : ''}><i id="sendIcon-${b.timestamp}" class="fas ${b.emailSent ? 'fa-check-circle' : 'fa-paper-plane'}"></i></button>
              <button ${disabledAttr} class="tab-desktop-only" data-label="Edit Booking" ${maybe(`onclick="openModal('/edit-booking/${b.timestamp}')"`)}><i class="fas fa-pen"></i></button>
              <button ${disabledAttr} class="tab-desktop-only" data-label="Cancel Booking" ${maybe(`onclick="cancelBooking('${b.timestamp}')"`)}><i class="fas fa-times"></i></button>
              <button ${disabledAttr} data-label="Stamp & send" ${maybe(`onclick="openModal('/upload-stamp/${b.timestamp}')"`)}><i class="fas fa-camera"></i></button>


            </div>
            <div class="booking-info-admin">
              <strong>${b.guestName}</strong>${b.guestName2 ? ` and <strong>${b.guestName2}</strong>` : ''} (${b.platform})<br>
              Check-in: ${b.checkIn} | Check-out: ${b.checkOut}<br>
              people: ${b.people}<br>
              Notes: ${b.notes || 'None'}
              ${isMarkedClean ? `<div style="color:green; font-size:0.9em; margin-top:4px;"><i class="fas fa-check-circle"></i> Cleaned and ready for guests</div>` : ''}
              ${isSeen ? `<div class="booking-seen"><i class="fas fa-eye"></i> Seen by cleaner</div>` : ''}
            </div>
          </li>
        `;
      }).join('');
    }

   


    const bookingsHtml = `
  <div class="tabs">
    <div class="tab-buttons">
      <button class="tab-btn" onclick="showTab('nowHosting')">Now Hosting</button>
      <button class="tab-btn active" onclick="showTab('upcoming')">Upcoming Bookings (${upcoming.length})</button>
      <button class="tab-btn tab-desktop-only" onclick="showTab('past')">Past Bookings</button>
      <button class="tab-btn tab-desktop-only" onclick="showTab('cancelled')">Cancelled Bookings (${cancelled.length})</button>
    </div>
    <div id="nowHosting" class="tab-content">
      <ul>${renderBookings(nowHosting)}</ul>
    </div>
    <div id="upcoming" class="tab-content" style="display:block">
      <ul>${renderBookings(upcoming)}</ul>
    </div>
    <div id="past" class="tab-content">
      <ul>${renderBookings(past)}</ul>
    </div>
    <div id="cancelled" class="tab-content">
      <ul>${renderBookings(cancelled)}</ul>
    </div>
  </div>
`;

    

    const fullHtml = `
      <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="stylesheet" href="/style.css">
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
          <link rel="manifest" href="/manifest.json" />
          <meta name="theme-color" content="#007bff" />

          <title>Dashboard</title>
        </head>
        <body>

         ${req.session.role !== 'viewer' ? `
          <div class="env-banner ${IS_PROD ? 'prod' : 'staging'}">
            ${IS_PROD ? 'PRODUCTION SERVER' : 'STAGING SERVER'}
          </div>
        ` : ''}



        <form action="/logout" method="POST" class="logout-form">
          <button type="submit" class="button-logout">Log Out</button>
        </form>

        <form action="/logout" method="POST" class="logout-form-phone">
          <button type="submit" class="button-logout-phone">Log Out</button>
        </form>

            <!-- button to view cleaner dashboard -->
              <a href="/cleaner-dashboard" class="view-cleaner-dashboard-button-phone">View Cleaner Dashboard</a>
            </div>

        <h1>Booking Dashboard</h1>

          <div class="view-toggle">
            <button id="listViewBtn" class="view-icon active" onclick="toggleView('list')">
              <i class="fas fa-list"></i>
            </button>
            <button id="calendarViewBtn" class="view-icon" onclick="toggleView('calendar')">
              <i class="fas fa-calendar-alt"></i>
            </button>
          </div>

            <!-- button to view cleaner dashboard -->
              <a href="/cleaner-dashboard" class="view-cleaner-dashboard-button">View Cleaner Dashboard</a>
            </div>


                ${readOnly ? '' : `
              <div style="text-align: center;">
                <button class="button-add-booking" onclick="openModal('/add-booking')">+ Add Booking</button>
              </div>`}

          <br><br>
          ${bookingsHtml}
          <div id="calendarContainer" style="display:none;"></div>
          <div id="modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); z-index:1000;">
            <div id="modalContent" style="position:relative; top:50px; left:50%; transform:translateX(-50%); width:80%; height:80%; background:white; border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.2);">
              <div style="text-align:right; padding:10px;">
                <button onclick="closeModal()" style="font-size:18px; background:none; border:none; cursor:pointer;">&times;</button>
              </div>
              <iframe id="modalFrame" src="" style="width:100%; height:90%; border:none; border-radius:0 0 10px 10px;"></iframe>
            </div>
          </div>

          <script>
            function openModal(url) {
              document.getElementById('modalFrame').src = url;
              document.getElementById('modal').style.display = 'block';
            }

            function closeModal() {
              document.getElementById('modalFrame').src = '';
              document.getElementById('modal').style.display = 'none';
            }

            window.addEventListener('click', function(event) {
              const modal = document.getElementById('modal');
              const modalContent = document.getElementById('modalContent');
              if (event.target === modal) {
                closeModal();
              }
            });

            function sendEmail(bookingId) {
              const button = document.getElementById('sendBtn-' + bookingId);
              const icon = document.getElementById('sendIcon-' + bookingId);

              if (icon) icon.className = 'fas fa-spinner fa-spin';
              if (button) button.disabled = true;

              fetch('/send-email/' + bookingId)
                .then(res => res.json())
                .then(data => {
                  if (data.success) {
                    if (icon) icon.className = 'fas fa-check-circle';
                    if (button) button.disabled = true;
                  } else {
                    alert('Email failed: ' + data.message);
                    if (icon) icon.className = 'fas fa-paper-plane';
                    if (button) button.disabled = false;
                  }
                })
                .catch(err => {
                  console.error(err);
                  alert('Error sending email.');
                  if (icon) icon.className = 'fas fa-paper-plane';
                  if (button) button.disabled = false;
                });
            }

          function showTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.style.display = 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.getElementById(tabName).style.display = 'block';
  event.target.classList.add('active');
}

let currentMonthOffset = 0;


function toggleView(view) {
  const listContainer = document.querySelector('.tabs');
  const calendarContainer = document.getElementById('calendarContainer');

  document.getElementById('listViewBtn').classList.remove('active');
  document.getElementById('calendarViewBtn').classList.remove('active');

  if (view === 'list') {
    listContainer.style.display = 'block';
    calendarContainer.style.display = 'none';
    document.getElementById('listViewBtn').classList.add('active');
  } else {
    listContainer.style.display = 'none';
    calendarContainer.style.display = 'block';
    document.getElementById('calendarViewBtn').classList.add('active');
    renderCalendar(currentMonthOffset);

  }
}

function cancelBooking(id) {
  if (confirm("Are you sure you want to cancel this booking?")) {
    fetch('/cancel-booking/' + id, {
      method: 'POST'
    })
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.text();
    })
    .then(() => location.reload())
    .catch(error => {
      console.error('Error cancelling booking:', error);
      alert('Failed to cancel booking.');
    });
  }
}

const bookings = ${JSON.stringify(activeBookings)};





function renderCalendar(monthOffset) {
  currentMonthOffset = monthOffset;
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = target.getFullYear();
  const month = target.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();

  let html = '<div class="calendar-header">' +
  '<button onclick="renderCalendar(' + (monthOffset - 1) + ')">&#10094;</button>' +
  '<strong>' + target.toLocaleString("default", { month: "long" }) + ' ' + year + '</strong>' +
  '<button onclick="renderCalendar(' + (monthOffset + 1) + ')">&#10095;</button>' +
  '</div>';

  html += '<div style="position: relative;">';
html += '<div class="calendar-grid calendar-grid-with-rows">';
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
weekdays.forEach(function(d) {
  html += '<div class="calendar-day-name">' + d + '</div>';
});

  for (let i = 0; i < firstDay.getDay(); i++) {
    html += '<div class="calendar-empty"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
  const currentDate = new Date(year, month, day);

  const bookingsToday = bookings.filter(b => {
    const checkIn = new Date(b.checkIn);
    const checkOut = new Date(b.checkOut);
    return currentDate >= checkIn && currentDate <= checkOut;
  });

  html += '<div class="calendar-cell">';
  html += '<strong>' + day + '</strong>';

 const checkoutsFirst = bookings.filter(b => new Date(b.checkOut).setHours(0,0,0,0) === currentDate.getTime());
checkoutsFirst.forEach(m => {
  html += '<div class="calendar-booking"><i class="fas fa-sign-out-alt" style="color: red;"></i> ' + m.guestName + ' <span>(' + m.platform + ')</span></div>';
});

const checkinsNext = bookings.filter(b => new Date(b.checkIn).setHours(0,0,0,0) === currentDate.getTime());
checkinsNext.forEach(m => {
  html += '<div class="calendar-booking"><i class="fas fa-sign-in-alt" style="color: green;"></i> ' + m.guestName + ' <span>(' + m.platform + ')</span></div>';
});

const duringStays = bookings.filter(b => {
  const ci = new Date(b.checkIn).setHours(0,0,0,0);
  const co = new Date(b.checkOut).setHours(0,0,0,0);
  return currentDate.getTime() > ci && currentDate.getTime() < co;
});
duringStays.forEach(m => {
  html += '<div class="calendar-booking">' + m.guestName + ' <span>(' + m.platform + ')</span></div>';
});

  html += '</div>'; // end .calendar-cell
}

html += '</div>'; // end .calendar-grid

html += '</div>'; // end outer wrapper

document.getElementById('calendarContainer').innerHTML = html;
}


          </script>

  





          </body>
      </html>
    `;

    res.send(fullHtml);
  });
});


app.post('/cancel-booking/:id', requireAdmin, async (req, res) => {

  try {
    if (usePgBookings(req)) {
      console.log('Bookings write backend: postgres');
      const ok = await pgSetCancelled(req.session.workspaceId, req.params.id, true);
      if (!ok) return res.status(404).send('Booking not found');
      return res.sendStatus(200);
    }

    const data = await fs.promises.readFile(bookingsFile, 'utf8');
    const bookings = JSON.parse(data || '[]');

    const index = bookings.findIndex(b => b.timestamp == req.params.id);
    if (index === -1) return res.status(404).send('Booking not found');

    // mark cancelled
    bookings[index].cancelled = true;

    // write locally and mirror to Gist
    try {
      writeBookingsLocal(bookings);
    } catch (e) {
      return res.status(500).send('Error writing file');
    }
    pushBookingsToGist(bookings).catch(() => {});

    // 🟡 Notification logic (unchanged, but now we can await)
    try {
      const checkOut = new Date(bookings[index].checkOut);
      const year = checkOut.getFullYear();
      const month = (checkOut.getMonth() + 1).toString().padStart(2, '0');
      const day = checkOut.getDate().toString().padStart(2, '0');
      const formattedDate = `${year}-${month}-${day}`;

      const message = 'Cleaning task is cancelled on ' + formattedDate;
      await sendPushNotification(message);
      console.log('Push notification sent:', message);
    } catch (notificationError) {
      console.error('Failed to send push notification:', notificationError);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Error cancelling booking:', err);
    return res.status(500).send('Error cancelling booking');
  }
});

// Undo a cancellation
app.post('/uncancel-booking/:id', requireAdmin, async (req, res) => {
  try {
    if (usePgBookings(req)) {
      console.log('Bookings write backend: postgres');
      const ok = await pgSetCancelled(req.session.workspaceId, req.params.id, false);
      if (!ok) return res.status(404).send('Booking not found');
      return res.redirect('/cancelled-bookings');
    }

    const data = await fs.promises.readFile(bookingsFile, 'utf8');
    const bookings = JSON.parse(data || '[]');
    const idx = bookings.findIndex(b => String(b.timestamp) === String(req.params.id) || (b.id && String(b.id) === String(req.params.id)));
    if (idx === -1) return res.status(404).send('Booking not found');
    delete bookings[idx].cancelled;
    writeBookingsLocal(bookings);
    pushBookingsToGist(bookings).catch(() => {});
    res.redirect('/cancelled-bookings');
  } catch (e) {
    console.error('Failed to uncancel booking', e);
    res.status(500).send('Failed to uncancel booking');
  }
});



// ✅ Updated /checklist/:id POST route
app.post('/checklist/:id', forbidViewer, (req, res) => {

  const bookingId = req.params.id; // now using timestamp

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) throw err;
    const bookings = JSON.parse(data);
    const bookingIndex = bookings.findIndex(b => b.timestamp === bookingId);

    if (bookingIndex === -1) return res.send('Booking not found.');

    bookings[bookingIndex].checklist = {
      step1: req.body.step1 === 'on',
      step2: req.body.step2 === 'on',
      step3: req.body.step3 === 'on',
      step4: req.body.step4 === 'on'
    };

    writeBookingsLocal(bookings);
    pushBookingsToGist(bookings).catch(() => {});
    res.redirect(`/checklist/${bookingId}`);
    });
  });

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.log('Error ending session:', err);
    }
    res.redirect('/');
  });
});


// ✅ Updated /checklist/:id route (GET)
app.get('/checklist/:id', (req, res) => {
  const bookingId = req.params.id; // now using timestamp

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) throw err;
    const bookings = JSON.parse(data);
    const booking = bookings.find(b => b.timestamp === bookingId);

    if (!booking) return res.send('Booking not found.');

    



    res.send(`
      <html>
        <head>
          <title>Checklist for ${booking.guestName}</title>
          <link rel="stylesheet" href="/style.css" />
        </head>
        <body>
        <div class="modal-container">
            <a href="#" class="modal-close" onclick="window.parent.closeModal(); return false;" aria-label="Close">&times;</a>

          <h1>Checklist for ${booking.guestName}</h1>
          <p>(${booking.platform})<br>
          Check-in: ${booking.checkIn}<br>
          Check-out: ${booking.checkOut}</p>

          <form id="checklist" class="modal-form">
            <label><input type="checkbox" name="step1" ${booking.checklist?.step1 ? 'checked' : ''}> Get guest IDs</label><br>
            <label><input type="checkbox" name="step2" ${booking.checklist?.step2 ? 'checked' : ''}> Send endorsement (w/ move-in form + ID)</label><br>
            <label><input type="checkbox" name="step3" ${booking.checklist?.step3 ? 'checked' : ''}> Pay for the access card</label><br>
            <label><input type="checkbox" name="step4" ${booking.checklist?.step4 ? 'checked' : ''}> Get access cards</label><br><br>
            <button type="submit">Save Checklist</button>
          </form>
          </div>



          



          <script>
  document.getElementById('checklist').addEventListener('submit', async function(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    const data = new URLSearchParams(formData);
    
    try {
      const response = await fetch('/checklist/${booking.timestamp}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data
      });

      if (response.ok) {
        // ✅ Close modal in parent and refresh dashboard
        window.parent.closeModal();
        window.parent.location.reload();
      } else {
        alert('Failed to save booking.');
      }
    } catch (err) {
      alert('Error occurred while saving.');
      console.error(err);
    }
  });
</script>

        </body>
      </html>
    `);
  });
});

app.get('/generate-movein/:id', async (req, res) => {
  const bookingId = req.params.id;
  const isNumericId = /^\d+$/.test(String(bookingId));
  const usePg = usePgBookings(req);

  // Debug: show where we are writing
  console.log('[/generate-movein] bookingId:', bookingId);
  console.log('[/generate-movein] OUTPUT_DIR:', OUTPUT_DIR);
  console.log('[/generate-movein] backend:', usePg ? 'postgres' : 'localjson', 'idType:', isNumericId ? 'numeric' : 'timestamp');

  let booking;
  let unit = null;
  try {
    if (usePg) {
      if (!req.session.workspaceId) {
        console.error('[/generate-movein] workspaceId missing in session');
        return res.status(400).send('workspace not set');
      }
      booking = await pgFetchBookingById(req.session.workspaceId, bookingId);
      if (!booking) return res.status(404).send('Booking not found.');
      unit = await resolveUnitForBooking(req.session.workspaceId, booking);
      const missing = validateUnitForMoveIn(unit);
      if (missing.length || !isUnitConfigured(unit)) {
        console.error('[movein] missing unit fields', missing);
        return res.status(409).json({ error: 'UNIT_NOT_CONFIGURED', redirect: '/unit-settings' });
      }
      if (!IS_PROD) console.log('[movein]', 'bookingId=', bookingId, 'workspace=', req.session.workspaceId, 'unitId=', unit && unit.id, 'signatureKey=', unit && unit.signature_file_key);
    } else {
      const data = fs.readFileSync(bookingsFile, 'utf8');
      const bookings = JSON.parse(data);
      booking = bookings.find(b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId)));
      unit = {
        unit_number: '___',
        unit_owner_name: '___',
        unit_phone: '___',
        signature_file_key: null
      };
    }
  } catch (err) {
    console.error('Failed to load booking for generate-movein:', err);
    return res.status(500).send('Failed to load booking');
  }

  if (!booking) {
    return res.status(404).send('Booking not found.');
  }

  const outputPath = path.join(OUTPUT_DIR, `movein-${bookingId}.pdf`);
  console.log('[/generate-movein] outputPath:', outputPath);

  try {
    if (!IS_PROD) {
      console.log('[movein]', 'generating PDF', {
        bookingId,
        workspaceId: req.session.workspaceId,
        unitId: unit && unit.id,
        unitNumber: unit && unit.unit_number,
        signatureKey: unit && unit.signature_file_key
      });
    }
    await generateMoveInPDF(booking, unit, outputPath, {
      loadSignature: (key) => loadSignatureBuffer(key)
    });
    // Sanity check: did the file get created?
    if (!fs.existsSync(outputPath)) {
      console.error('PDF was not created at:', outputPath);
      return res.status(500).send('PDF was not created. Check template paths inside generate-movein.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=movein.pdf');
    return res.sendFile(outputPath, (sendErr) => {
      if (sendErr) {
        console.error('sendFile error:', sendErr);
      }
    });

  } catch (err) {
    console.error('generateMoveInPDF threw:', err);
    return res.status(500).send('Failed to generate PDF: ' + (err && err.message ? err.message : String(err)));
  }
});


app.get('/send-email/:id', requireAdmin, async (req, res) => {

  const bookingId = req.params.id;
  let booking = null;
  let unit = null;

  try {
    if (usePgBookings(req)) {
      console.log('Bookings backend: postgres (send-email)', 'idType:', /^\d+$/.test(String(bookingId)) ? 'numeric' : 'timestamp');
      if (!req.session.workspaceId) {
        console.error('send-email: workspaceId missing in session');
        return res.status(400).json({ success: false, message: 'workspace not set' });
      }
      booking = await pgFetchBookingById(req.session.workspaceId, bookingId);
      if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
      unit = await resolveUnitForBooking(req.session.workspaceId, booking);
      const missing = validateUnitForMoveIn(unit);
      if (missing.length || !isUnitConfigured(unit)) {
        console.error('[movein] missing unit fields', missing);
        return res.status(409).json({ error: 'UNIT_NOT_CONFIGURED', redirect: '/unit-settings' });
      }
      if (!IS_PROD) console.log('[movein]', 'bookingId=', bookingId, 'workspace=', req.session.workspaceId, 'unitId=', unit && unit.id, 'signatureKey=', unit && unit.signature_file_key);
    } else {
      console.log('Bookings backend: localjson (send-email)');
      const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
      const idx = bookings.findIndex(b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId)));
      if (idx !== -1) booking = bookings[idx];
      unit = {
        unit_number: '___',
        unit_owner_name: '___',
        unit_phone: '___',
        signature_file_key: null
      };
    }
  } catch (err) {
    console.error('send-email: failed to load booking', err);
    return res.status(500).json({ success: false, message: 'Failed to load booking' });
  }

  if (!booking) {
    return res.status(404).json({ success: false, message: 'Booking not found.' });
  }

  const outputPath = path.join(OUTPUT_DIR, `movein-${bookingId}.pdf`);
  if (!IS_PROD) {
    console.log('[movein]', 'generating PDF', {
      bookingId,
      workspaceId: req.session.workspaceId,
      unitId: unit && unit.id,
      unitNumber: unit && unit.unit_number,
      signatureKey: unit && unit.signature_file_key
    });
  }
  await generateMoveInPDF(booking, unit, outputPath, {
    loadSignature: (key)=>loadSignatureBuffer(key)
  });

// --- Gather ID attachments ---
let uploadedFiles = [];

// Helper: quick mime for common types
const mimeOf = (filename) => {
  const ext = (require('path').extname(filename) || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
};

const loadLocalIds = () => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    const matching = files.filter(
      f => f.includes(`booking-${bookingId}-`) && !f.includes('-stamp-')
    );
    if (!IS_PROD) {
      console.log('[send-email] local ids matching', matching);
    }
    return matching.map(f => ({
      filename: f,
      path: path.join(UPLOADS_DIR, f)
    }));
  } catch {
    return [];
  }
};

const shouldUseLocal = (!IS_PROD || !hasSftpCreds());

if (shouldUseLocal) {
  uploadedFiles = loadLocalIds();
} else {
  try {
    const sftp = await getSftp();                              // uses env + private key
    const remoteDir = `${SFTP_ROOT}/ids`;
    let list = [];
    try {
      list = await sftp.list(remoteDir);
    } catch (_) {
      list = [];
    }

    // filter only ID uploads (exclude receipt/stamp files)
    const matching = list
      .map(f => f.name)
      .filter(name =>
        name.includes(`booking-${bookingId}-`) &&
        !name.includes('-stamp-')
      );

    if (!IS_PROD) {
      console.log('[send-email] bookingId', bookingId, 'remoteDir', remoteDir, 'sftpCount', list.length, 'matching', matching);
    }

    uploadedFiles = await Promise.all(matching.map(async (fname) => {
      const remotePath = `${remoteDir}/${fname}`;
      const buf = await sftp.get(remotePath);                  // Buffer
      return {
        filename: fname,
        content: buf,                                          // attach Buffer directly
        contentType: mimeOf(fname)
      };
    }));

    // Safety fallback: if SFTP reachable but no matches, also check local uploads
    if (uploadedFiles.length === 0) {
      const localFallback = loadLocalIds();
      uploadedFiles = localFallback;
      if (!IS_PROD) {
        console.log('[send-email] fallback to local ids, count', localFallback.length);
      }
    }

    await sftp.end();
  } catch (e) {
    console.warn('[email] SFTP fetch of IDs failed, falling back to local uploads:', e.message);
    uploadedFiles = loadLocalIds();
  }
}


  const checkInFormatted = formatDate(booking.checkIn);
  const checkOutFormatted = formatDate(booking.checkOut);

  const guestNameLine = booking.guestName2
  ? `${booking.guestName} and ${booking.guestName2}`
  : booking.guestName;

  
// Check if today is weekend (0 = Sunday, 6 = Saturday)
// Manila weekend check (UTC+8)
const now = new Date();
const manila = new Date(now.getTime() + (now.getTimezoneOffset() + 8 * 60) * 60000);
const day = manila.getDay(); // 0 Sun .. 6 Sat in Manila
const isWeekend = (day === 0 || day === 6);


// Build recipient list depending on environment
const prodRecipients = isWeekend
  ? ['pmo@knightsbridgeresidences.com.ph', 'securityandsafety@knightsbridgeresidences.com.ph']
  : ['pmo@knightsbridgeresidences.com.ph'];

// On staging/local we keep things safe: always send to your test inbox only
// (safeSendMail will also enforce this and prefix [STAGING] in subject)
const stagingRecipients = ['adamkischi@hotmail.com'];

  // Final "to" list
  const recipients = IS_PROD ? prodRecipients : stagingRecipients;

const mailOptions = {
  from: '"Adam Kischinovsky" <adam.kischinovsky@gmail.com>',
  to: recipients.join(', '),
  bcc: req.session.email || 'adamkischi@hotmail.com',   // copy to logged-in user
  replyTo: req.session.email || 'adamkischi@hotmail.com',
  subject: `Move-In Form for ${guestNameLine}`,
  text: `Hello PMO,

I hereby endorse ${guestNameLine} to move in to the unit ${unit?.unit_number || '___'} on ${checkInFormatted} and move-out ${checkOutFormatted}.

I am attaching the filled out move-in form, and ID’s.

Thank you

Best regards, 

${unit?.unit_owner_name || 'Unit Owner'}`,
  attachments: [
    { filename: `MoveInForm-${bookingId}.pdf`, path: outputPath },
    ...uploadedFiles
  ]
};

  try {
    await safeSendMail(mailOptions);
    if (usePgBookings(req)) {
      await pgUpdateChecklist(req.session.workspaceId, bookingId, 'emailSent', true);
    } else {
      const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
      const idx = bookings.findIndex(b => String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId)));
      if (idx !== -1) {
        bookings[idx].emailSent = true;
        bookings[idx].checklist = bookings[idx].checklist || {};
        bookings[idx].checklist.step2 = true; // endorsement email sent
        writeBookingsLocal(bookings);
        pushBookingsToGist(bookings).catch(() => {});
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/edit-booking/:id', (req, res) => {
  const bookingId = req.params.id;
  const renderForm = (booking) => {
    if (!booking) return res.send('Booking not found.');
    const fmt = (d) => {
      const dt = new Date(d);
      return isNaN(dt) ? d : dt.toISOString().slice(0,10);
    };
    res.send(`
      <html>
        <head>
          <title>Edit Booking</title>
          <link rel="stylesheet" href="/style.css" />
        </head>
        <body>
          <div class="modal-container">
            <a href="#" class="modal-close" onclick="window.parent.closeModal(); return false;" aria-label="Close">&times;</a>

            <h1>Edit Booking</h1>
            <form id="editBookingForm" class="modal-form">
              <label>Guest Name:
                <input type="text" name="guestName" value="${booking.guestName || ''}" required />
              </label>
              <label>Second Guest (optional):
                <input type="text" name="guestName2" value="${booking.guestName2 || ''}" />
              </label>
              <select name="platform" required>
              <option value="">Select Platform</option>
              <option value="Airbnb" ${booking.platform === 'Airbnb' ? 'selected' : ''}>Airbnb</option>
              <option value="Agoda" ${booking.platform === 'Agoda' ? 'selected' : ''}>Agoda</option>
              <option value="Booking.com" ${booking.platform === 'Booking.com' ? 'selected' : ''}>Booking.com</option>
              <option value="Direct" ${booking.platform === 'Direct' ? 'selected' : ''}>Direct</option>
              </select>
            <br />
              </label>
              <label>Check-in Date:
                <input type="date" name="checkIn" value="${fmt(booking.checkIn)}" required />
              </label>
              <label>Check-out Date:
                <input type="date" name="checkOut" value="${fmt(booking.checkOut)}" required />
              </label>
              <label>Amount of people:
                <input type="text" name="people" value="${booking.people || ''}" />
              </label>
              <label>Notes:
                <input type="text" name="notes" value="${booking.notes || ''}" />
              </label>
              <button type="submit">Save Changes</button>
            </form>
          </div>

          <script>
  document.getElementById('editBookingForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    const data = new URLSearchParams(formData);
    
    try {
      const response = await fetch('/edit-booking/${booking.timestamp || booking.id}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data
      });

      if (response.ok) {
        // ✅ Close modal in parent and refresh dashboard
        window.parent.closeModal();
        window.parent.location.reload();
      } else {
        alert('Failed to save booking.');
      }
    } catch (err) {
      alert('Error occurred while saving.');
      console.error(err);
    }
  });
</script>

        </body>
      </html>
    `);
  };

  if (usePgBookings(req)) {
    pool.query(
      `SELECT id, guest_name, check_in, check_out, platform, people, notes FROM bookings WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [bookingId, req.session.workspaceId]
    ).then(({ rows })=>{
      const b = rows[0];
      if (!b) return res.send('Booking not found.');
      renderForm({
        id: b.id,
        guestName: b.guest_name,
        guestName2: '',
        checkIn: b.check_in,
        checkOut: b.check_out,
        platform: b.platform,
        people: b.people,
        notes: b.notes
      });
    }).catch((e)=>{
      console.error('Edit booking fetch pg failed', e);
      res.send('Error reading bookings file.');
    });
    return;
  }

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) return res.send('Error reading bookings file.');
    const bookings = JSON.parse(data);
    const booking = bookings.find(b => b.timestamp === bookingId);
    renderForm(booking);
  });
});

app.post('/edit-booking/:id', requireAdmin, (req, res) => {

  const bookingId = req.params.id;
  const backend = usePgBookings(req) ? 'postgres' : 'localjson';
  if (!IS_PROD) {
    console.log('[edit-booking] backend=%s id=%s bodyKeys=%s workspace=%s',
      backend,
      bookingId,
      Object.keys(req.body || {}).join(','),
      req.session.workspaceId || null
    );
  }

  if (usePgBookings(req)) {
    console.log('Bookings write backend: postgres');
    const { guestName, platform, checkIn, checkOut, people, notes } = req.body || {};
    const bid = req.params.id;
    if (!bid) return res.status(400).send('Missing booking id');
    pool.query(
      `UPDATE bookings SET guest_name=$1, platform=$2, people=$3, notes=$4, check_in=$5, check_out=$6, updated_at=NOW()
       WHERE id=$7 AND workspace_id=$8
       RETURNING id`,
      [guestName || '', platform || '', people || null, notes || '', checkIn || null, checkOut || null, bid, req.session.workspaceId]
    ).then(({ rowCount })=>{
      if (rowCount !== 1) return res.status(404).send('Booking not found');
      return res.sendStatus(200);
    }).catch((e)=>{
      console.error('Edit booking pg failed', e);
      return res.status(500).send('Error saving booking.');
    });
    return;
  }

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) return res.send('Error loading data.');
    const bookings = JSON.parse(data);
    const index = bookings.findIndex(b =>
      String(b.timestamp) === String(bookingId) || (b.id && String(b.id) === String(bookingId))
    );
    if (index === -1) return res.status(404).send('Booking not found.');

    bookings[index] = {
      ...bookings[index],
      guestName: req.body.guestName,
      guestName2: req.body.guestName2,
      checkIn: req.body.checkIn,
      checkOut: req.body.checkOut,
      platform: req.body.platform,
      people: req.body.people,
      notes: req.body.notes
    };

    writeBookingsLocal(bookings);
pushBookingsToGist(bookings).catch(() => {});
res.sendStatus(200);

    });
  });

function isAuthenticated(req, res, next) {
  if (req.session.loggedIn && (req.session.role === 'admin' || req.session.role === 'cleaner')) {
    next();
  } else {
    res.redirect('/');
  }
}

// Helper: keep only one booking per unique id/timestamp (prefer last occurrence)
function dedupeBookings(list = []) {
  const seen = new Map();
  list.forEach((b) => {
    const key = String(
      b?.timestamp ||
      b?.id ||
      `${b?.checkIn || ''}|${b?.checkOut || ''}`
    );
    if (!key) return;
    // prefer the later entry in the array for merged data
    seen.set(key, { ...seen.get(key), ...b });
  });
  return Array.from(seen.values());
}

function cleanerActionResponse(req, res) {
  const wantsJSON = (req.headers.accept || '').includes('application/json');
  return wantsJSON ? res.json({ ok: true }) : res.redirect('/cleaner-dashboard');
}

// Mark a booking as seen by cleaner
app.post('/mark-seen', forbidViewer, (req, res) => {
  const bookingsData = JSON.parse(fs.readFileSync(bookingsFile));
  const { timestamp, id } = req.body || {};
  const key = String(timestamp || id || '');

  const updated = bookingsData.map((b) =>
    String(b.timestamp || b.id || '') === key
      ? {
          ...b,
          seen: true
        }
      : b
  );

  writeBookingsLocal(updated);
  pushBookingsToGist(updated).catch(() => {});

  return cleanerActionResponse(req, res);
});

// Mark a stay as cleaned
app.post('/mark-cleaned', forbidViewer, (req, res) => {
  const { timestamp, id } = req.body || {};
  const bookingKey = String(timestamp || id || '');
  if (usePgBookings(req)) {
    console.log('Bookings write backend: postgres');
    if (!req.session.workspaceId) return res.status(400).send('workspace not set');
    pgSetCleaned(req.session.workspaceId, bookingKey, true)
      .then(()=> cleanerActionResponse(req, res))
      .catch((e)=>{ console.error('mark-cleaned pg failed', e); res.status(500).send('Error marking cleaned');});
    return;
  }

  const bookingsData = JSON.parse(fs.readFileSync(bookingsFile));
  const updated = bookingsData.map((b) =>
    String(b.timestamp || b.id || '') === bookingKey
      ? {
          ...b,
          cleaned: true
        }
      : b
  );

  writeBookingsLocal(updated);
  pushBookingsToGist(updated).catch(() => {});

  return cleanerActionResponse(req, res);
});

// Undo a cleaned mark
app.post('/unmark-cleaned', forbidViewer, (req, res) => {
  const { timestamp, id } = req.body || {};
  const bookingKey = String(timestamp || id || '');
  if (usePgBookings(req)) {
    console.log('Bookings write backend: postgres');
    if (!req.session.workspaceId) return res.status(400).send('workspace not set');
    pgSetCleaned(req.session.workspaceId, bookingKey, false)
      .then(()=> cleanerActionResponse(req, res))
      .catch((e)=>{ console.error('unmark-cleaned pg failed', e); res.status(500).send('Error unmarking cleaned');});
    return;
  }

  const bookingsData = JSON.parse(fs.readFileSync(bookingsFile));
  const updated = bookingsData.map((b) => {
    if (String(b.timestamp || b.id || '') === bookingKey) {
      const copy = { ...b };
      delete copy.cleaned;
      return copy;
    }
    return b;
  });

  writeBookingsLocal(updated);
  pushBookingsToGist(updated).catch(() => {});

  return cleanerActionResponse(req, res);
});

// route to serve the cleaner dashboard (new static page)
app.get('/cleaner-dashboard', requireAnyUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'cleaner-dashboard.html'));
});

// Simple cancelled bookings list
app.get('/cancelled-bookings', requireAnyUser, (req, res) => {
  try {
    const data = readBookingsLocal();
    const cancelled = (data || []).filter(b => b && b.cancelled).sort((a,b)=> new Date(a.checkIn) - new Date(b.checkIn));
    const rows = cancelled.map(b => {
      const ci = new Date(b.checkIn).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'2-digit' });
      const co = new Date(b.checkOut).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'2-digit' });
      return `<li class="item">
        <div class="title">${b.guestName || 'Guest'}</div>
        <div class="muted">${b.platform || ''} • ${ci} → ${co}</div>
        <div class="muted">Guests: ${b.people || '-'}</div>
        <form action="/uncancel-booking/${encodeURIComponent(b.timestamp || b.id || '')}" method="POST" class="undo-form">
          <button type="submit" class="undo-btn">Undo cancellation</button>
        </form>
      </li>`;
    }).join('') || '<li class="item muted">No cancelled bookings.</li>';

    res.send(`
      <html>
        <head>
          <title>Cancelled bookings</title>
          <style>
            :root {
              --accent:#10b981;
              --accent-50:#ecfdf5;
              --border:rgba(16,185,129,0.35);
              --text:#0f172a;
              --muted:#6b7280;
              --bg:#ecfdf5;
              --shadow:0 18px 40px rgba(16,185,129,0.18);
            }
            * { box-sizing: border-box; }
            body {
              font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
              margin:0; padding:28px;
              background: linear-gradient(140deg, #d1fae5, #ecfdf5, #ffffff);
              color:var(--text);
            }
            .shell {
              max-width: 900px;
              margin: 0 auto;
            }
            .card {
              background:#fff;
              border:1px solid var(--border);
              border-radius:24px;
              box-shadow: var(--shadow);
              padding:24px 26px;
            }
            h1 { margin:0 0 10px; font-size:24px; }
            .sub { color:var(--muted); margin:0 0 18px; }
            ul { list-style:none; padding:0; margin:0; }
            .item {
              padding:14px 0;
              border-bottom:1px solid rgba(16,185,129,0.15);
              display:flex;
              flex-direction:column;
              gap:4px;
            }
            .item:last-child { border-bottom:none; }
            .title { font-weight:700; font-size:16px; }
            .row { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:14px; flex-wrap:wrap; }
            .pill {
              background: var(--accent-50);
              color: #047857;
              border:1px solid var(--border);
              padding:4px 10px;
              border-radius: 999px;
              font-weight:600;
              font-size:13px;
            }
            a.back {
              display:inline-flex; align-items:center; gap:6px;
              margin-bottom:16px; color:#047857; text-decoration:none; font-weight:700;
            }
            .empty {
              padding:16px;
              background:#f9fafb;
              border:1px dashed var(--border);
              border-radius:14px;
              color:var(--muted);
            }
            .undo-form { margin-top:6px; }
            .undo-btn {
              border:1px solid var(--border);
              background: var(--accent-50);
              color:#047857;
              border-radius:12px;
              padding:8px 12px;
              font-weight:700;
              cursor:pointer;
            }
            .undo-btn:hover { background:#d1fae5; }
          </style>
        </head>
        <body>
          <div class="shell">
            <a class="back" href="/dashboard-new">← Back to dashboard</a>
            <div class="card">
              <h1>Cancelled bookings</h1>
              <p class="sub">All cancelled stays in one place.</p>
              <ul>${rows || '<li class="empty">No cancelled bookings.</li>'}</ul>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    console.error('Cancelled bookings page failed', e);
    res.status(500).send('Failed to load cancelled bookings');
  }
});

// --------------- Finance Tab (MVP) ---------------



// NEW Finance page (shows Summary + Upcoming & Due + Add Expense)
app.get('/finance', requireAdmin, (req, res) => {
  const fmt = (n) => (Number(n || 0)).toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });
  const toMonthKey = (d) => {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  };
const makeDate = (y, m, d) => new Date(y, m, d); // local midnight
const toLocalISO = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

  const lastDayOfMonth = (y, m) => new Date(y, m + 1, 0);

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;

  // summary (paid-only)
  const summary = finance.monthSummary(monthKey);

  // data
  const settings = finance.getSettings();
  const entries = finance.listEntries();
  const bookings = (typeof readBookingsLocal === 'function') ? readBookingsLocal() : []; // uses your helper :contentReference[oaicite:7]{index=7}

  // did we already log this month’s expense for category?
  const hasExpenseForMonth = (category, mk) =>
    entries.some(e => e.type === 'expense' && (e.category || '').toLowerCase() === category.toLowerCase() && toMonthKey(e.date) === mk);

  // Internet (20th): show current month unless it’s already paid → then show next month
  const internetMonth = hasExpenseForMonth('Internet', monthKey)
    ? `${y}-${String(m + 2).padStart(2, '0')}`
    : monthKey;
  const [iy, im] = internetMonth.split('-').map(Number);
  const internetDueISO = toLocalISO(makeDate(iy, im - 1, 20));


  // Rent (10th)
  const rentMonth = hasExpenseForMonth('Rent', monthKey)
    ? `${y}-${String(m + 2).padStart(2, '0')}`
    : monthKey;
  const [ry, rm] = rentMonth.split('-').map(Number);
  const rentDueISO = toLocalISO(makeDate(ry, rm - 1, 10));


  // Cleaner payout (15th / last day), owed since settings.cleanerPaidThru
const nextCleanerDue = (now.getDate() <= 15)
  ? toLocalISO(makeDate(y, m, 15))
  : toLocalISO(lastDayOfMonth(y, m));

  const paidThru = settings.cleanerPaidThru ? new Date(settings.cleanerPaidThru) : new Date('1970-01-01');
  const end = new Date(nextCleanerDue);
  const cleanedSincePaid = bookings.filter(b => {
    try { return b.cleaned && new Date(b.checkOut) > paidThru && new Date(b.checkOut) <= end; }
    catch { return false; }
  });
  const cleaningsCount = cleanedSincePaid.length;
  const cleanerOwed = Number(settings.cleanerRate || 0) * cleaningsCount;

  // Build upcoming items list
  const items = [];

  items.push({
    dueISO: nextCleanerDue,
    title: 'Cleaner payout',
    amount: cleanerOwed,
    breakdown: [
      `${cleaningsCount} cleaned × ${fmt(settings.cleanerRate || 0)}`,
      'Laundry: (to be added later via receipt upload)'
    ],
    action: 'cleaner',
    params: { periodEnd: nextCleanerDue }
  });

  if ((settings.internetAmount || 0) > 0) {
    items.push({
      dueISO: internetDueISO,
      title: `Internet (${internetMonth})`,
      amount: Number(settings.internetAmount || 0),
      breakdown: [`Monthly internet for ${internetMonth}`],
      action: 'internet',
      params: { monthKey: internetMonth }
    });
  }

  if ((settings.rentAmount || 0) > 0) {
    items.push({
      dueISO: rentDueISO,
      title: `Rent (${rentMonth})`,
      amount: Number(settings.rentAmount || 0),
      breakdown: [`Monthly rent for ${rentMonth}`],
      action: 'rent',
      params: { monthKey: rentMonth }
    });
  }

  // group by due date
  const groups = {};
  for (const it of items) {
    if (!groups[it.dueISO]) groups[it.dueISO] = { dueISO: it.dueISO, total: 0, items: [] };
    groups[it.dueISO].total += Number(it.amount || 0);
    groups[it.dueISO].items.push(it);
  }
  const grouped = Object.values(groups).sort((a, b) => a.dueISO.localeCompare(b.dueISO));

  // recent entries table (same as your current table)
  const rows = entries.slice(0, 50).map(e => {
    if (e.type === 'income') {
      const net = (e.gross - (e.platformFee||0) - (e.cleaningCost||0) - (e.otherCost||0));
      return `<tr>
        <td>${e.date}</td><td>Income</td><td>${e.platform || ''}</td><td>${e.guestName || ''}</td>
        <td>${fmt(e.gross)}</td><td>${fmt(e.platformFee)}</td><td>${fmt(e.cleaningCost)}</td>
        <td>${fmt(e.otherCost)}</td><td>${fmt(net)}</td><td>${e.notes || ''}</td>
      </tr>`;
    } else {
      return `<tr>
        <td>${e.date}</td><td>Expense</td><td>${e.category || ''}</td><td></td>
        <td></td><td></td><td>${fmt(e.amount)}</td><td></td><td>-${fmt(e.amount)}</td>
        <td>${e.notes || ''}</td>
      </tr>`;
    }
  }).join('');

  res.send(`<!doctype html>
  <html>
  <head>
    <title>Finance</title>
    <link rel="stylesheet" href="/style.css" />
    <style>
      .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 24px; }
      .card { background:#fff; padding:16px; border-radius:12px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
      table { width:100%; border-collapse: collapse; margin-top: 16px; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 14px; }
      th { background:#f6f6f8; text-align:left; }
      .row { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
      input, select, textarea { padding:6px 8px; border:1px solid #ccc; border-radius:8px; }
      .subtle { color:#666; font-size: 13px; }
      .group { border:1px solid #eee; border-radius:10px; padding:10px; margin:10px 0; }
      .group-header { display:flex; justify-content:space-between; align-items:center; }
      .toggle { cursor:pointer; font-size:12px; }
      .breakdown { display:none; margin-top:8px; }
    </style>
  </head>
  <body>
    <div class="container">
      <a href="/dashboard" style="text-decoration:none;">← Back to Dashboard</a>
      <h1>Finance</h1>

      <div class="grid">
        <!-- Summary -->
        <div class="card">
          <h2>Summary (${summary.month})</h2>
          <div class="subtle">Only paid expenses are included in totals.</div>
          <table>
            <tbody>
              <tr><th>Total Gross (Income)</th><td>${fmt(summary.incomeGross)}</td></tr>
              <tr><th>Platform Fees</th><td>${fmt(summary.platformFees)}</td></tr>
              <tr><th>Cleaning Costs</th><td>${fmt(summary.cleaning)}</td></tr>
              <tr><th>Other Costs</th><td>${fmt(summary.other)}</td></tr>
              <tr><th>Expenses (General)</th><td>${fmt(summary.expense)}</td></tr>
              <tr><th>Net</th><td><strong>${fmt(summary.net)}</strong></td></tr>
            </tbody>
          </table>
        </div>

        <!-- Upcoming & Due -->
        <div class="card">
          <h2>Upcoming & Due Expenses</h2>
          <div class="subtle">Cleaner payout adds up as you mark bookings “Cleaned”. Internet (20th) and Rent (10th) show if configured.</div>

          ${grouped.map(g => {
            const brk = g.items.map(it => `
              <div style="border-top:1px dashed #eee; padding-top:8px; margin-top:8px;">
                <div><strong>${it.title}</strong></div>
                <div>${it.breakdown.map(line => `<div class="subtle">${line}</div>`).join('')}</div>
                <form method="POST" action="/finance/mark-paid/${it.action}" style="margin-top:8px;">
                  ${it.action === 'cleaner' ? `<input type="hidden" name="periodEnd" value="${it.params.periodEnd}">` : ''}
                  ${it.action !== 'cleaner' ? `<input type="hidden" name="monthKey" value="${it.params.monthKey}">` : ''}
                  <button class="btn btn-primary" ${Number(it.amount||0) <= 0 ? 'disabled' : ''}>Mark Paid (${fmt(it.amount)})</button>
                </form>
              </div>
            `).join('');

            const labels = g.items.map(it => (it.action === 'cleaner' ? 'Cleaning' : it.action === 'internet' ? 'Internet' : it.action === 'rent' ? 'Rent' : (it.title || ''))).join(' + ');


            return `
              <div class="group">
                <div class="group-header">
                <div><strong>Due ${g.dueISO} — ${labels}</strong></div>
                  <div><strong>${fmt(g.total)}</strong> <span class="toggle" onclick="toggleDetails('${g.dueISO}')">Details</span></div>
                </div>

                <div id="bd-${g.dueISO}" class="breakdown">${brk}</div>
              </div>
            `;
          }).join('')}

          <h3 style="margin-top:16px;">Settings</h3>
          <form method="POST" action="/finance/settings">
            <div class="row">
              <label>Cleaner rate (₱)<br/><input type="number" name="cleanerRate" step="0.01" value="${Number(settings.cleanerRate||0)}"></label>
              <label>Internet (₱)<br/><input type="number" name="internetAmount" step="0.01" value="${Number(settings.internetAmount||0)}"></label>
              <label>Rent (₱)<br/><input type="number" name="rentAmount" step="0.01" value="${Number(settings.rentAmount||0)}"></label>
            </div>
            <button class="btn btn-primary" type="submit">Save Settings</button>
          </form>
        </div>
      </div>

      <!-- Add Expense (general) -->
      <div class="card" style="margin-top:16px;">
        <h2>Add Expense (general)</h2>
        <form method="POST" action="/finance/entry">
          <input type="hidden" name="type" value="expense"/>
          <div class="row">
            <div><label>Date<br/><input type="date" name="date" required/></label></div>
            <div><label>Category<br/><input type="text" name="category" placeholder="Supplies, Transport, etc."/></label></div>
            <div><label>Amount (₱)<br/><input type="number" name="amount" step="0.01" required/></label></div>
          </div>
          <div class="row">
            <label style="flex:1;">Notes<br/><textarea name="notes" rows="2" style="width:100%;"></textarea></label>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" type="submit">Save Expense</button>

          </div>
        </form>
      </div>

      <div class="card" style="margin-top:16px;">
        <h2>Recent Entries</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Category/Platform</th><th>Guest</th>
              <th>Gross</th><th>Platform Fee</th><th>Cleaning</th><th>Other</th><th>Net</th><th>Notes</th>
            </tr>
          </thead>
          <tbody>${rows || ''}</tbody>
        </table>
      </div>
    </div>

    <script>
      function toggleDetails(id) {
        const el = document.getElementById('bd-' + id);
        if (!el) return;
        el.style.display = (el.style.display === 'block') ? 'none' : 'block';
      }
    </script>
  </body>
  </html>`);
});






// Admin-only Finance UI
app.get('/finance', requireAdmin, (req, res) => {
  const fmt = (n) => (Number(n || 0)).toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });

  // Current month key
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const summary = finance.monthSummary(monthKey);
  const entries = finance.listEntries();

  const rows = entries.slice(0, 50).map(e => {
    if (e.type === 'income') {
      const net = (e.gross - (e.platformFee||0) - (e.cleaningCost||0) - (e.otherCost||0));
      return `<tr>
        <td>${e.date}</td>
        <td>Income</td>
        <td>${e.platform || ''}</td>
        <td>${e.guestName || ''}</td>
        <td>${fmt(e.gross)}</td>
        <td>${fmt(e.platformFee)}</td>
        <td>${fmt(e.cleaningCost)}</td>
        <td>${fmt(e.otherCost)}</td>
        <td>${fmt(net)}</td>
        <td>${e.notes || ''}</td>
      </tr>`;
    } else {
      return `<tr>
        <td>${e.date}</td>
        <td>Expense</td>
        <td>${e.category || ''}</td>
        <td></td>
        <td></td>
        <td></td>
        <td>${fmt(e.amount)}</td>
        <td></td>
        <td>-${fmt(e.amount)}</td>
        <td>${e.notes || ''}</td>
      </tr>`;
    }
  }).join('');

  res.send(`<!doctype html>
  <html>
  <head>
    <title>Finance</title>
    <link rel="stylesheet" href="/style.css" />
    <style>
      .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 24px; }
      form .row { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
      table { width:100%; border-collapse: collapse; margin-top: 16px; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 14px; }
      th { background:#f6f6f8; text-align:left; }
      .card { background:#fff; padding:16px; border-radius:12px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
      h2 { margin: 0 0 8px; }
      .subtle { color:#666; font-size: 13px; }
      .actions { margin-top: 8px; }
      input, select, textarea { padding:6px 8px; border:1px solid #ccc; border-radius:8px; }
      label { font-size: 12px; color:#333; }
    </style>
  </head>
  <body>
    <div class="container">
      <a href="/dashboard" style="text-decoration:none;">← Back to Dashboard</a>
      <h1>Finance</h1>

      <div class="grid">
        <div class="card">
          <h2>Summary (${summary.month})</h2>
          <div class="subtle">Last 50 entries shown below</div>
          <table>
            <tbody>
              <tr><th>Total Gross (Income)</th><td>${fmt(summary.incomeGross)}</td></tr>
              <tr><th>Platform Fees</th><td>${fmt(summary.platformFees)}</td></tr>
              <tr><th>Cleaning Costs</th><td>${fmt(summary.cleaning)}</td></tr>
              <tr><th>Other Costs</th><td>${fmt(summary.other)}</td></tr>
              <tr><th>Expenses (General)</th><td>${fmt(summary.expense)}</td></tr>
              <tr><th>Net</th><td><strong>${fmt(summary.net)}</strong></td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Add Income (per booking)</h2>
          <form method="POST" action="/finance/entry">
            <input type="hidden" name="type" value="income"/>
            <div class="row">
              <div>
                <label>Date<br/><input type="date" name="date" required /></label>
              </div>
              <div>
                <label>Platform<br/>
                  <select name="platform">
                    <option value="">—</option>
                    <option>Airbnb</option>
                    <option>Booking.com</option>
                    <option>Agoda</option>
                    <option>Other</option>
                  </select>
                </label>
              </div>
              <div>
                <label>Booking Timestamp (optional)<br/><input type="text" name="bookingTimestamp" placeholder="ISO timestamp" /></label>
              </div>
              <div>
                <label>Guest Name (optional)<br/><input type="text" name="guestName" /></label>
              </div>
            </div>

            <div class="row">
              <div><label>Gross (₱)<br/><input type="number" name="gross" step="0.01" required/></label></div>
              <div><label>Platform Fee (₱)<br/><input type="number" name="platformFee" step="0.01"/></label></div>
              <div><label>Cleaning Cost (₱)<br/><input type="number" name="cleaningCost" step="0.01"/></label></div>
              <div><label>Other Cost (₱)<br/><input type="number" name="otherCost" step="0.01"/></label></div>
            </div>

            <div class="row">
              <label style="flex:1;">Notes<br/><textarea name="notes" rows="2" style="width:100%;"></textarea></label>
            </div>

            <div class="actions">
              <button type="submit">Save Income</button>
            </div>
          </form>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h2>Add Expense (general)</h2>
        <form method="POST" action="/finance/entry">
          <input type="hidden" name="type" value="expense"/>
          <div class="row">
            <div><label>Date<br/><input type="date" name="date" required/></label></div>
            <div><label>Category<br/><input type="text" name="category" placeholder="Supplies, Transport, etc."/></label></div>
            <div><label>Amount (₱)<br/><input type="number" name="amount" step="0.01" required/></label></div>
          </div>
          <div class="row">
            <label style="flex:1;">Notes<br/><textarea name="notes" rows="2" style="width:100%;"></textarea></label>
          </div>
          <div class="actions">
            <button type="submit">Save Expense</button>
          </div>
        </form>
      </div>

      <div class="card" style="margin-top:16px;">
        <h2>Recent Entries</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Platform/Category</th><th>Guest</th>
              <th>Gross</th><th>Platform Fee</th><th>Cleaning</th><th>Other</th><th>Net</th><th>Notes</th>
            </tr>
          </thead>
          <tbody>${rows || ''}</tbody>
        </table>
      </div>
    </div>
  </body>
  </html>`);
});













// Save Finance settings
app.post('/finance/settings', requireAdmin, (req, res) => {
  try {
    finance.updateSettings({
  cleanerRate: req.body.cleanerRate,
  internetAmount: req.body.internetAmount,
  rentAmount: req.body.rentAmount
  // cleanerPaidThru is updated only by the “Mark Paid – Cleaner” action
});

    res.redirect('/finance');
  } catch (e) {
    console.error('Finance settings error', e);
    res.status(500).send('Failed to save settings.');
  }
});

// Mark Paid — Internet
app.post('/finance/mark-paid/internet', requireAdmin, (req, res) => {
  try {
    const s = finance.getSettings();
    const mk = req.body.monthKey; // YYYY-MM
    const [y, m] = mk.split('-').map(Number);
    const dueDate = new Date(y, m - 1, 20).toISOString().split('T')[0];
    const amount = Number(s.internetAmount || 0);

    if (amount > 0) {
      finance.addExpense({
        date: dueDate,
        category: 'Internet',
        amount,
        notes: `Internet for ${mk}`
      });
    }
    res.redirect('/finance');
  } catch (e) {
    console.error('Internet mark-paid error', e);
    res.status(500).send('Failed to mark Internet paid.');
  }
});

// Mark Paid — Rent
app.post('/finance/mark-paid/rent', requireAdmin, (req, res) => {
  try {
    const s = finance.getSettings();
    const mk = req.body.monthKey; // YYYY-MM
    const [y, m] = mk.split('-').map(Number);
    const dueDate = new Date(y, m - 1, 10).toISOString().split('T')[0];
    const amount = Number(s.rentAmount || 0);

    if (amount > 0) {
      finance.addExpense({
        date: dueDate,
        category: 'Rent',
        amount,
        notes: `Rent for ${mk}`
      });
    }
    res.redirect('/finance');
  } catch (e) {
    console.error('Rent mark-paid error', e);
    res.status(500).send('Failed to mark Rent paid.');
  }
});

// Mark Paid — Cleaner payout (up to periodEnd)
app.post('/finance/mark-paid/cleaner', requireAdmin, (req, res) => {
  try {
    const s = finance.getSettings();
    const periodEnd = req.body.periodEnd; // ISO date (15th or month-end)

    // Recompute owed on server
    const bookings = (typeof readBookingsLocal === 'function') ? readBookingsLocal() : [];
    const paidThru = s.cleanerPaidThru ? new Date(s.cleanerPaidThru) : new Date('1970-01-01');
    const end = new Date(periodEnd);
    const cleanedSincePaid = bookings.filter(b => {
      try { return b.cleaned && new Date(b.checkOut) > paidThru && new Date(b.checkOut) <= end; }
      catch { return false; }
    });
    const count = cleanedSincePaid.length;
    const amount = Number(s.cleanerRate || 0) * count; // Laundry to be added later

    if (amount > 0 || count >= 0) {
      finance.addExpense({
        date: periodEnd,
        category: 'Cleaner Payout',
        amount,
        notes: `Up to ${periodEnd}: ${count} cleanings × ${s.cleanerRate || 0}. Laundry added later.`
      });
      // Move the boundary forward to avoid double paying
      finance.updateSettings({ cleanerPaidThru: periodEnd });
    }

    res.redirect('/finance');
  } catch (e) {
    console.error('Cleaner mark-paid error', e);
    res.status(500).send('Failed to mark Cleaner paid.');
  }
});





// Handle create entry (income or expense)
app.post('/finance/entry', requireAdmin, (req, res) => {
  try {
    if (req.body.type === 'income') {
      finance.addIncome({
        date: req.body.date,
        platform: req.body.platform,
        bookingTimestamp: req.body.bookingTimestamp,
        guestName: req.body.guestName,
        gross: req.body.gross,
        platformFee: req.body.platformFee,
        cleaningCost: req.body.cleaningCost,
        otherCost: req.body.otherCost,
        notes: req.body.notes
      });
    } else if (req.body.type === 'expense') {
      finance.addExpense({
        date: req.body.date,
        category: req.body.category,
        amount: req.body.amount,
        notes: req.body.notes
      });
    }
    res.redirect('/finance');
  } catch (e) {
    console.error('Finance save error', e);
    res.status(500).send('Failed to save. ' + e.message);
  }
});






app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
