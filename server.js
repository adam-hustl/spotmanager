const express = require('express');
const path = require('path');
const app = express();
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data-local');
fs.mkdirSync(DATA_DIR, { recursive: true });

const bookingsFile = path.join(DATA_DIR, 'bookings.json');
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';



// Ensure required folders/files exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'adam.kischinovsky@gmail.com',         // ← din Gmail-adresse
    pass: 'odtfujoqggybjurh'      // ← den 16-cifrede app-adgangskode
  }

  



});

const IS_PROD = process.env.APP_ENV === 'production';


const SftpClient = require('ssh2-sftp-client');

// Base dir you created on the server
const SFTP_ROOT = process.env.SFTP_BASE_DIR || '/var/www/www.demoaleph.dk/spotmanager/staging';

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






async function safeSendMail(options) {
  if (!IS_PROD) {
    // On staging/local: always send only to you, and clearly mark subject
    const clone = { ...options };
    clone.to = process.env.STAGING_MAIL_TO || 'adamkischi@hotmail.com';
    clone.cc = undefined;
    clone.bcc = undefined;
    clone.subject = `[STAGING] ${options.subject}`;
    return transporter.sendMail(clone);
  }
  return transporter.sendMail(options);
}






const multer = require('multer');

// Configure multer to save in uploads/ folder
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    cb(null, `booking-${req.params.id}-${Date.now()}-${file.originalname}`);
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
  if (!req.files || req.files.length === 0) return res.send('No files uploaded.');

  try {
    const sftp = await getSftp();
    const remoteDir = `${SFTP_ROOT}/ids`;
    try { await sftp.mkdir(remoteDir, true); } catch (_) {}

    // push each uploaded file to SFTP and then remove local copy
    for (const f of req.files) {
      const localPath = path.join(__dirname, 'uploads', f.filename);
      const remotePath = `${remoteDir}/${f.filename}`;
      await sftp.put(localPath, remotePath);
      try { fs.unlinkSync(localPath); } catch (_) {}
    }

    await sftp.end();
    res.send(`<h2>Files uploaded successfully to SFTP.<br><br><a href="/dashboard">Back</a></h2>`);
  } catch (e) {
    console.error('SFTP upload failed:', e);
    res.status(500).send('Failed to upload to SFTP: ' + e.message);
  }
});

app.get('/view-ids/:id', async (req, res) => {
  const bookingId = req.params.id;

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
      .filter(name => name.includes(`booking-${bookingId}-`));

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


    if (matching.length === 0) {
      return res.send('No uploaded IDs found for this booking.');
    }

    const items = matching.map(fname => {
      const encoded = encodeURIComponent(fname);
      const ext = path.extname(fname).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
      const preview = isImage
        ? `<img class="zoomable-id" src="/id/${encoded}" />`
        : `<a href="/id/${encoded}" target="_blank">${fname}</a>`;
      return `<div class="id-item">${preview}
                <div style="text-align:center;margin-top:10px">
                  <form action="/delete-id/${bookingId}/${encoded}" method="POST">
                    <button type="submit">Delete</button>
                  </form>
                </div>
              </div>`;
    }).join('');

    res.send(`
      <html>
        <head><link rel="stylesheet" href="/style.css" /></head>
        <body>
          <div class="modal-container view-ids">
            <a href="#" class="modal-close" onclick="window.parent.closeModal();return false;">&times;</a>
            <h2>Uploaded Guest IDs for guest ${guestName}</h2>
            <div class="id-gallery">${items}</div>
          </div>
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
  const file = req.params.filename;

  try {
    const sftp = await getSftp();
    await sftp.delete(`${SFTP_ROOT}/ids/${file}`);
    await sftp.end();
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







// Handle login
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Check admin credentials
  if (username === 'admin' && password === '1234') {
    req.session.loggedIn = true;
    req.session.role = 'admin';
    return res.redirect('/dashboard');
  }

  // Check cleaner credentials
  if (username === 'Diane' && password === 'abcd') {
    req.session.loggedIn = true;
    req.session.role = 'cleaner';
    return res.redirect('/cleaner-dashboard');
  }


    // Check viewer credentials (read-only)
  if (username === 'viewer' && password === 'viewonly') {
    req.session.loggedIn = true;
    req.session.role = 'viewer';
    return res.redirect('/dashboard');
  }

  // If no match
  res.redirect('/?error=1');
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
  if (req.session.loggedIn && (req.session.role === 'admin' || req.session.role === 'cleaner')) {
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
    const booking = bookings.find(b => b.timestamp === bookingId);
    if (!booking) return res.send('Booking not found.');

    res.send(`
      <html>
        <head>
          <title>Upload arrival stamp for ${booking.guestName}</title>
          <link rel="stylesheet" href="/style.css" />
        </head>
        <body>
          <div class="modal-container">
          <a href="#" class="modal-close" onclick="window.parent.closeModal(); return false;" aria-label="Close">&times;</a>
            <h1>Arrival stamp for ${booking.guestName}</h1>
            <p>Take a clear photo of the passport arrival stamp.</p>

            <form id="stampForm" class="modal-form" enctype="multipart/form-data" method="POST" action="/upload-stamp/${booking.timestamp}">
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

  try {
    const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
    const booking = bookings.find(b => b.timestamp === bookingId);
    if (!booking) return res.send('Booking not found.');
    if (!req.file) return res.send('No image uploaded.');




    // Manila weekend check (UTC+8)
const now = new Date();
const manila = new Date(now.getTime() + (now.getTimezoneOffset() + 8 * 60) * 60000);
const day = manila.getDay(); // 0 Sun .. 6 Sat in Manila
const isWeekend = (day === 0 || day === 6);

// Recipients by environment (same rule as endorsement email)
const prodRecipients = isWeekend
  ? ['pmo@knightsbridgeresidences.com.ph', 'securityandsafety@knightsbridgeresidences.com.ph']
  : ['pmo@knightsbridgeresidences.com.ph'];

// Keep staging/local safe: always send only to your test inbox
const stagingRecipients = ['adamkischi@hotmail.com'];

const recipients = IS_PROD ? prodRecipients : stagingRecipients;

const mailOptions = {
  from: '"Adam Kischinovsky" <adam.kischinovsky@gmail.com>',
  to: recipients.join(', '),
  bcc: 'adamkischi@hotmail.com', // keep a copy for yourself on prod; stripped on staging by safeSendMail
  replyTo: 'adamkischi@hotmail.com',
  subject: `Arrival stamp for ${booking.guestName}`,
  text: `Hello, this is the arrival stamp of ${booking.guestName} staying in unit 4317.\n\nThank you\n\n- Adam Kischinovsky`,
  attachments: [
    { filename: req.file.filename, path: path.join(__dirname, 'uploads', req.file.filename) }
  ]
};

    await safeSendMail(mailOptions);

    // Close the modal and refresh the dashboard
    res.send(`
      <h2>Stamp uploaded and email sent!<br><br>
      <a href="/dashboard" target="_parent">Back to Dashboard</a>
      <script>
        if (window.parent) {
          window.parent.closeModal();
          window.parent.location.reload();
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
        const hasIncomplete = [checklist.step1, checklist.step2, checklist.step3, checklist.step4].some(step => step !== true);

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

  // Debug: show where we are writing
  console.log('[/generate-movein] bookingId:', bookingId);
  console.log('[/generate-movein] OUTPUT_DIR:', OUTPUT_DIR);

  let data;
  try {
    data = fs.readFileSync(bookingsFile, 'utf8');
  } catch (readErr) {
    console.error('Failed to read bookings.json:', readErr);
    return res.status(500).send('Failed to read bookings file: ' + readErr.message);
  }

  let bookings;
  try {
    bookings = JSON.parse(data);
  } catch (parseErr) {
    console.error('Failed to parse bookings.json:', parseErr);
    return res.status(500).send('Failed to parse bookings file: ' + parseErr.message);
  }

  const booking = bookings.find(b => b.timestamp === bookingId);
  if (!booking) {
    return res.status(404).send('Booking not found.');
  }

  const outputPath = path.join(OUTPUT_DIR, `movein-${bookingId}.pdf`);
  console.log('[/generate-movein] outputPath:', outputPath);

  try {
    await generateMoveInPDF(booking, outputPath);
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
  const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
  const bookingIndex = bookings.findIndex(b => b.timestamp === bookingId);
  if (bookingIndex === -1) return res.status(404).json({ success: false, message: 'Booking not found.' });

  const booking = bookings[bookingIndex];
  const outputPath = path.join(OUTPUT_DIR, `movein-${bookingId}.pdf`);
  await generateMoveInPDF(booking, outputPath);

 // --- Gather ID attachments from SFTP (primary) or local uploads (fallback) ---
let uploadedFiles = [];
try {
  const sftp = await getSftp();                              // uses env + private key
  const remoteDir = `${SFTP_ROOT}/ids`;
  let list = [];
  try {
    list = await sftp.list(remoteDir);
  } catch (_) {
    list = [];
  }

  const matching = list
    .map(f => f.name)
    .filter(name => name.includes(`booking-${bookingId}-`));

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

  uploadedFiles = await Promise.all(matching.map(async (fname) => {
    const remotePath = `${remoteDir}/${fname}`;
    const buf = await sftp.get(remotePath);                  // Buffer
    return {
      filename: fname,
      content: buf,                                          // attach Buffer directly
      contentType: mimeOf(fname)
    };
  }));

  await sftp.end();
} catch (e) {
  console.warn('[email] SFTP fetch of IDs failed, falling back to local uploads:', e.message);
  // Fallback: look in local /uploads if running purely local/dev
  try {
    uploadedFiles = fs.readdirSync(path.join(__dirname, 'uploads'))
      .filter(f => f.includes(`booking-${bookingId}-`))
      .map(f => ({
        filename: f,
        path: path.join(__dirname, 'uploads', f)
      }));
  } catch {}
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
  bcc: 'adamkischi@hotmail.com',   // keep a copy to yourself on both envs
  replyTo: 'adamkischi@hotmail.com',
  subject: `Move-In Form for ${guestNameLine}`,
  text: `Hello PMO,

I hereby endorse ${guestNameLine} to move in to the unit 4317 on ${checkInFormatted} and move-out ${checkOutFormatted}.

I am attaching the filled out move-in form, and ID’s.

Thank you

Best regards, 

Adam Kischinovsky`,
  attachments: [
    { filename: `MoveInForm-${bookingId}.pdf`, path: outputPath },
    ...uploadedFiles
  ]
};

  try {
    await safeSendMail(mailOptions);
    bookings[bookingIndex].emailSent = true;
    writeBookingsLocal(bookings);
pushBookingsToGist(bookings).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/edit-booking/:id', (req, res) => {
  const bookingId = req.params.id;

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) return res.send('Error reading bookings file.');
    const bookings = JSON.parse(data);
    const booking = bookings.find(b => b.timestamp === bookingId);
    if (!booking) return res.send('Booking not found.');

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
                <input type="text" name="guestName" value="${booking.guestName}" required />
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
                <input type="date" name="checkIn" value="${booking.checkIn}" required />
              </label>
              <label>Check-out Date:
                <input type="date" name="checkOut" value="${booking.checkOut}" required />
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
      const response = await fetch('/edit-booking/${booking.timestamp}', {
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

app.post('/edit-booking/:id', requireAdmin, (req, res) => {

  const bookingId = req.params.id;

  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) return res.send('Error loading data.');
    const bookings = JSON.parse(data);
    const index = bookings.findIndex(b => b.timestamp === bookingId);
    if (index === -1) return res.send('Booking not found.');

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
res.send(`<h2>Booking updated!<br><br><a href="/dashboard">Back to Dashboard</a></h2>`);

    });
  });

function isAuthenticated(req, res, next) {
  if (req.session.loggedIn && (req.session.role === 'admin' || req.session.role === 'cleaner')) {
    next();
  } else {
    res.redirect('/');
  }
}

//  route mark-cleaned
app.post('/mark-seen', forbidViewer, (req, res) => {
  const bookingsData = JSON.parse(fs.readFileSync(bookingsFile));
  const { timestamp } = req.body;

  const updated = bookingsData.map(b => {
    if (b.timestamp === timestamp) {
      return {
        ...b,
        seen: true
      };
    }
    return b;
  });

  writeBookingsLocal(updated);
pushBookingsToGist(updated).catch(() => {});

  res.redirect('/cleaner-dashboard');
});


// route to serve the cleaner dashboard
app.get('/cleaner-dashboard', requireAdminOrViewer, (req, res) => {
  // new: exclude cancelled from all cleaner views
const allBookings = JSON.parse(fs.readFileSync(bookingsFile));
const bookingsData = allBookings.filter(b => !b.cancelled);
const today = new Date().toISOString().split('T')[0];


  // Step: Sort all bookings by check-in date
const sortedByCheckIn = [...bookingsData].sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));


// ---- read-only helpers for "viewer" role (same pattern as admin dashboard) ----
const readOnly = req.session.role === 'viewer';
const disabledAttr = readOnly
  ? 'disabled aria-disabled="true" style="opacity:.55; pointer-events:none"'
  : '';
const blockSubmit = readOnly ? ' onsubmit="return false"' : '';




  app.post('/mark-cleaned', forbidViewer, (req, res) => {
  const bookingsData = JSON.parse(fs.readFileSync(bookingsFile));
  const { timestamp } = req.body;


  const updated = bookingsData.map(b => {
    if (b.timestamp === timestamp) {
      return {
        ...b,
        cleaned: true
      };
    }
    return b;
  });
  

  writeBookingsLocal(updated);
pushBookingsToGist(updated).catch(() => {});

  res.redirect('/cleaner-dashboard');
});

app.post('/unmark-cleaned', forbidViewer, (req, res) => {
  const bookingsData = JSON.parse(fs.readFileSync(bookingsFile));
  const { timestamp } = req.body;

  const updated = bookingsData.map(b => {
    if (b.timestamp === timestamp) {
      const copy = { ...b };
      delete copy.cleaned;
      return copy;
    }
    return b;
  });

  writeBookingsLocal(updated);
pushBookingsToGist(updated).catch(() => {});

  res.redirect('/cleaner-dashboard');
});

sortedByCheckIn.forEach((b, index) => {
  const bCheckOut = new Date(b.checkOut);

  // Find the next booking (excluding the current one)
  const next = sortedByCheckIn.find(other => {
    if (other.timestamp === b.timestamp) return false;
    const otherCheckIn = new Date(other.checkIn);
    return otherCheckIn >= bCheckOut;
  });

  b.nextGuestPeople = next ? next.people : 'N/A';

  if (next) {
    const nextCheckin = new Date(next.checkIn);
    b.sameDayTurnover = (
      bCheckOut.getFullYear() === nextCheckin.getFullYear() &&
      bCheckOut.getMonth() === nextCheckin.getMonth() &&
      bCheckOut.getDate() === nextCheckin.getDate()
    );
  } else {
    b.sameDayTurnover = false;
  }
});

  



  // Define upcoming and alreadyCleaned bookings
  const upcoming = bookingsData
  .filter(b => !b.cleaned)
  .sort((a, b) => new Date(a.checkOut) - new Date(b.checkOut));

  const alreadyCleaned = bookingsData
  .filter(b => b.cleaned)
  .sort((a, b) => new Date(a.checkOut) - new Date(b.checkOut));


  // Function to render bookings as HTML list items
  function renderBookings(bookings) {


    return bookings.map(b => {

            const checkoutTime = new Date(b.checkOut + 'T11:00:00Z');

            const now = new Date();
            const isPastCheckout = now > checkoutTime;

      return `
        <li>
          <div class="booking-info" style="position: relative;">

          ${b.sameDayTurnover ? `
            <div class="same-day-alert">
              <i class="fas fa-exclamation-circle"></i> same day check-in
            </div>
          ` : ''}


              
        


            Cleaning date: ${b.checkOut || ''}<br>
            Guests arriving: ${b.nextGuestPeople || 'N/A'}<br>
            
            

            ${!b.cleaned ? `
              <form method="POST" class="logout-form" action="/mark-cleaned" style="margin-top:5px"${blockSubmit}>
              <input type="hidden" name="timestamp" value="${b.timestamp}">
              <button ${disabledAttr} class="mark-cleaned" type="submit" ${isPastCheckout ? '' : 'disabled style="background-color: grey; cursor: not-allowed;"'}>Mark as Cleaned</button>
              </form>

            ` : 

            `<form method="POST" class="logout-form" action="/unmark-cleaned" style="margin-top:5px"${blockSubmit}>
            <input type="hidden" name="timestamp" value="${b.timestamp}">
            <button ${disabledAttr} class="button-unmark-cleaned" type="submit">Unmark as Cleaned</button>
          </form>
          `
          }



            
        </form>

          <form method="POST" class="seen-form" action="/mark-seen"${blockSubmit}>
          <input type="hidden" name="timestamp" value="${b.timestamp}">
          <button ${disabledAttr} class="seen-button ${b.seen ? 'seen-true' : ''}" type="submit">
            👁️
          </button>
        </form>

          </div>
        </li>
      `;
    }).join('');
  }

  const showAdminButton = (req.session.role === 'admin' || req.session.role === 'viewer');




  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Cleaner Dashboard</title>
        <link rel="stylesheet" href="/style.css">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#007bff" />


                <!-- OneSignal SDK Script -->
        <script src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js" defer></script>
        <script>
          window.OneSignalDeferred = window.OneSignalDeferred || [];
          OneSignalDeferred.push(async function(OneSignal) {
            await OneSignal.init({
              appId: "${ONESIGNAL_APP_ID}"

            });
          });
        </script>



      </head>
      <body>


      <form action="/logout" method="POST" class="logout-form">
  <button type="submit" class="button-logout">Log Out</button>
</form>

<form action="/logout" method="POST" class="logout-form-phone">
  <button type="submit" class="button-logout-phone">Log Out</button>
</form>




        ${showAdminButton ? `
          
            <a href="/dashboard" class="view-cleaner-dashboard-button">View admin Dashboard</a>
          ` : ''}

          ${showAdminButton ? `
          
            <a href="/dashboard" class="view-cleaner-dashboard-button-phone">View admin Dashboard</a>
          ` : ''}

        <h1>Cleaner Dashboard</h1>




        <div class="tab-buttons">
          <button class="tab-btn active" onclick="showTab('upcoming')">Upcoming (${upcoming.length})</button>
          <button class="tab-btn" onclick="showTab('cleaned')">Already Cleaned (${alreadyCleaned.length})</button>
        </div>

        

        <div class="view-toggle">
          <button id="listViewBtn" class="view-icon active" onclick="toggleView('list')">
            <i class="fas fa-list"></i>
          </button>
          <button id="calendarViewBtn" class="view-icon" onclick="toggleView('calendar')">
            <i class="fas fa-calendar-alt"></i>
          </button>
        </div>

        <div id="calendarContainer" style="display:none;"></div>

        <div id="upcoming" class="tab-content" style="display:block">
          <ul>${renderBookings(upcoming)}</ul>
        </div>

        <div id="cleaned" class="tab-content" style="display:none">
          <ul>${renderBookings(alreadyCleaned)}</ul>
        </div>


        <script>
          function showTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById(tabId).style.display = 'block';
            event.target.classList.add('active');
          }
        </script>

        <script>
          let currentMonthOffset = 0;

          function toggleView(view) {
            const calendarContainer = document.getElementById('calendarContainer');
            const listViewBtn = document.getElementById('listViewBtn');
            const calendarViewBtn = document.getElementById('calendarViewBtn');

            // Hide all tab contents and tab buttons
            const allTabs = document.querySelectorAll('.tab-content');
            const tabButtons = document.querySelector('.tab-buttons');

            listViewBtn.classList.remove('active');
            calendarViewBtn.classList.remove('active');

            if (view === 'list') {
              if (tabButtons) tabButtons.style.display = 'flex';
              allTabs.forEach(tab => tab.style.display = 'none');
              const activeTab = document.querySelector('.tab-btn.active');
              if (activeTab) {
                const tabId = activeTab.textContent.includes('Upcoming') ? 'upcoming' : 'cleaned';
                document.getElementById(tabId).style.display = 'block';
              }
              calendarContainer.style.display = 'none';
              listViewBtn.classList.add('active');
            } else {
              if (tabButtons) tabButtons.style.display = 'none';
              allTabs.forEach(tab => tab.style.display = 'none');
              calendarContainer.style.display = 'block';
              calendarViewBtn.classList.add('active');
              renderCalendar(currentMonthOffset);
            }
          }


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

            const upcoming = ${JSON.stringify(upcoming)};

            for (let day = 1; day <= daysInMonth; day++) {
              const currentDate = new Date(Date.UTC(year, month, day)).toISOString().split('T')[0];
              const matches = upcoming.filter(b => b.checkOut === currentDate);

              html += '<div class="calendar-cell">';
              html += '<strong>' + day + '</strong>';
              matches.forEach(b => {
                html += '<div class="calendar-booking">' + b.checkOut + ' - ' + b.people + ' Guest' + (parseInt(b.people) > 1 ? 's' : '') + '</div>';
              });
              html += '</div>';
            }

            html += '</div></div>';
            document.getElementById('calendarContainer').innerHTML = html;
          }
        </script>


       


      </body>
    </html>
  `);
});



app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
