const express = require('express');
const path = require('path');
const app = express();
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data-local');
fs.mkdirSync(DATA_DIR, { recursive: true });

const bookingsFile = path.join(DATA_DIR, 'bookings.json');


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
  destination: (req, file, cb) => cb(null, 'uploads/'),
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
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg') || '.jpg';
    cb(null, `booking-${req.params.id}-stamp-${Date.now()}${ext}`);
  }
});
const uploadStamp = multer({ storage: storageStamp });





app.get('/upload-id/:id', (req, res) => {
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

app.post('/upload-id/:id', upload.array('guestIds', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.send('No files uploaded.');

  const uploadedFiles = req.files.map(f => f.filename).join('<br>');
  res.send(`<h2>Files uploaded successfully:<br>${uploadedFiles} <br><br><a href="/dashboard">Go back</a></h2>`);
});

app.get('/view-ids/:id', (req, res) => {
  const bookingId = req.params.id;
  const folderPath = path.join(__dirname, 'uploads');

  fs.readdir(folderPath, (err, files) => {
    if (err) return res.send('Error reading uploaded files.');

    const matching = files.filter(f => f.includes(`booking-${bookingId}-`));
    if (matching.length === 0) return res.send('No uploaded IDs found for this booking.');

    const fileBlocks = matching.map(f => {
      const ext = path.extname(f).toLowerCase();
      const encoded = encodeURIComponent(f);
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);

      const preview = isImage
        ? `<img src="/uploads/${encoded}" alt="${f}" class="zoomable-id">`
        : `<a href="/uploads/${encoded}" target="_blank">${f}</a>`;

      return `
        <div class="id-item">
          ${preview}
     <div style="text-align: center; margin-top: 10px;">
      <form action="/delete-id/${bookingId}/${encoded}" method="POST">
     <button type="submit">Delete</button>
  </form>
</div>
        </div>
      `;
    }).join('');

    res.send(`
      <html>
        <head>
          <title>Uploaded Guest IDs</title>
          <link rel="stylesheet" href="/style.css" />
          <style>
            .modal-container .zoom-overlay {
              display: none;
              position: fixed;
              top: 0;
              left: 0;
              width: 100vw;
              height: 100vh;
              background: rgba(0, 0, 0, 0.8);
              justify-content: center;
              align-items: center;
              z-index: 9999;
            }
            .modal-container .zoom-overlay img {
              max-width: 90vw;
              max-height: 90vh;
              border-radius: 12px;
              box-shadow: 0 4px 16px rgba(0,0,0,0.2);
            }
          </style>
        </head>
        <body>
          <div class="modal-container view-ids">
          <a href="#" class="modal-close" onclick="window.parent.closeModal(); return false;" aria-label="Close">&times;</a>
            <h2>Uploaded Guest IDs for Booking ${bookingId}</h2>
            <div class="id-gallery">
              ${fileBlocks}
            </div>
            <div class="zoom-overlay" id="zoomOverlay" onclick="this.style.display='none';">
              <img id="zoomImage" src="" alt="Zoomed ID">
            </div>
          </div>

          <script>
            document.querySelectorAll('.zoomable-id').forEach(img => {
              img.addEventListener('click', () => {
                const overlay = document.getElementById('zoomOverlay');
                const zoomed = document.getElementById('zoomImage');
                zoomed.src = img.src;
                overlay.style.display = 'flex';
              });
            });
          </script>
        </body>
      </html>
    `);
  });
});


app.post('/delete-id/:id/:filename', (req, res) => {
  const bookingId = req.params.id; // now timestamp
  const fileToDelete = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', fileToDelete);

  fs.unlink(filePath, (err) => {
    if (err) return res.send('Error deleting file.');
    res.redirect(`/view-ids/${bookingId}`);
  });
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true }));



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

// Home route to serve index.html
app.get('/', (req, res) => {
  res.render('index');
});

// Login page
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});


// Add booking form
app.get('/add-booking', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'add-booking.html'));
});

// Handle form submission
app.post('/save-booking', async (req, res) => {
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
    const bookings = JSON.parse(data);
    bookings.push(newBooking);

    await fs.promises.writeFile(bookingsFile, JSON.stringify(bookings, null, 2));

  // Format checkOutDate to MM-DD-YYYY
  const checkOut = new Date(newBooking.checkOut);
  const formattedDate = `${(checkOut.getMonth() + 1).toString().padStart(2, '0')}-${checkOut.getDate().toString().padStart(2, '0')}-${checkOut.getFullYear()}`;

  // Send push notification with formatted date
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

// About page
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});



const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const sendPushNotification = async (message) => {
  try {
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'os_v2_app_5kj5txopgregxdlxsrcnlz3jt4ewaw7rxmzejsnxcv3mlekp43awmppykzwn2ecb5zk3wgd6ri2e4gaxda2t3uhpf4d6af6tv3cih7a' // Replace with your actual REST API Key
      },
      body: JSON.stringify({
        app_id: 'ea93d9dd-cf34-486b-8d77-9444d5e7699f', // Replace with your OneSignal App ID
        contents: { en: message },
        included_segments: ['All'] // Or target specific segments/users if needed
      })
    });
  } catch (error) {
    console.error('Push notification error:', error);
  }
};




app.get('/upload-stamp/:id', (req, res) => {
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




app.post('/upload-stamp/:id', uploadStamp.single('stamp'), async (req, res) => {
  const bookingId = req.params.id;

  try {
    const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
    const booking = bookings.find(b => b.timestamp === bookingId);
    if (!booking) return res.send('Booking not found.');
    if (!req.file) return res.send('No image uploaded.');




    const mailOptions = {
      from: '"Adam Kischinovsky" <adam.kischinovsky@gmail.com>',
      to: 'adam@aleph.dk',
      bcc: 'adamkischi@hotmail.com', 
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


app.get('/dashboard', requireAdmin, (req, res) => {
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
  const next = bookings.find(other =>
    new Date(other.checkIn) > new Date(b.checkOut) && !other.cancelled && !cleanedFor.has(other.timestamp)
  );
  if (next) cleanedFor.add(next.timestamp);
});




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
              <button data-label="Checklist" onclick="openModal('/checklist/${b.timestamp}')"><i class="fas fa-clipboard-check"></i></button>
              <button class="tab-desktop-only" data-label="Upload ID's" onclick="openModal('/upload-id/${b.timestamp}')"><i class="fas fa-upload"></i></button>
              <button class="tab-desktop-only" data-label="View ID's" onclick="openModal('/view-ids/${b.timestamp}')"><i class="fas fa-image"></i></button>
              <button class="tab-desktop-only" data-label="view move-in form" onclick="openModal('/generate-movein/${b.timestamp}')"><i class="fas fa-eye"></i></button>
              <button data-label="Send endorsement e-mail" id="sendBtn-${b.timestamp}" onclick="sendEmail('${b.timestamp}')" title="Send endorsement e-mail"${b.emailSent ? 'disabled' : ''}><i id="sendIcon-${b.timestamp}" class="fas ${b.emailSent ? 'fa-check-circle' : 'fa-paper-plane'}"></i></button>
              <button class="tab-desktop-only" data-label="Edit Booking" onclick="openModal('/edit-booking/${b.timestamp}')"><i class="fas fa-pen"></i></button>
              <button class="tab-desktop-only" data-label="Cancel Booking" onclick="cancelBooking('${b.timestamp}')"><i class="fas fa-times"></i></button>
              <button data-label="Stamp & send" onclick="openModal('/upload-stamp/${b.timestamp}')"><i class="fas fa-camera"></i></button>


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


          <div style="text-align: center;">
            <button class="button-add-booking" onclick="openModal('/add-booking')">+ Add Booking</button>
          </div>
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

  <script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
      .then(() => console.log('Service Worker Registered!'))
      .catch((error) => console.error('Service Worker Registration Failed:', error));
  }

  window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Force reload when app becomes active again
    location.reload();
  }
});


</script>





          </body>
      </html>
    `;

    res.send(fullHtml);
  });
});

app.post('/cancel-booking/:id', (req, res) => {
  fs.readFile(bookingsFile, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Error reading file');

    const bookings = JSON.parse(data);
    const index = bookings.findIndex(b => b.timestamp == req.params.id);

    if (index === -1) return res.status(404).send('Booking not found');

    bookings[index].cancelled = true;

    fs.writeFile(bookingsFile, JSON.stringify(bookings, null, 2), async err => {
      if (err) return res.status(500).send('Error writing file');

      // 🟡 Notification logic starts here
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

      res.sendStatus(200);
    });
  });
});



// ✅ Updated /checklist/:id POST route
app.post('/checklist/:id', (req, res) => {
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

    fs.writeFile(bookingsFile, JSON.stringify(bookings, null, 2), (err) => {
      if (err) throw err;
      res.redirect(`/checklist/${bookingId}`);
    });
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


app.get('/send-email/:id', async (req, res) => {
  const bookingId = req.params.id;
  const bookings = JSON.parse(fs.readFileSync(bookingsFile, 'utf8'));
  const bookingIndex = bookings.findIndex(b => b.timestamp === bookingId);
  if (bookingIndex === -1) return res.status(404).json({ success: false, message: 'Booking not found.' });

  const booking = bookings[bookingIndex];
  const outputPath = path.join(__dirname, 'outputs', `movein-${bookingId}.pdf`);
  await generateMoveInPDF(booking, outputPath);

  const uploadedFiles = fs.readdirSync(path.join(__dirname, 'uploads'))
    .filter(f => f.includes(`booking-${bookingId}-`))
    .map(f => ({
      filename: f,
      path: path.join(__dirname, 'uploads', f)
    }));

  const checkInFormatted = formatDate(booking.checkIn);
  const checkOutFormatted = formatDate(booking.checkOut);

  const guestNameLine = booking.guestName2
  ? `${booking.guestName} and ${booking.guestName2}`
  : booking.guestName;

  
// Check if today is weekend (0 = Sunday, 6 = Saturday)
  const today = new Date().getDay();
  const isWeekend = (today === 0 || today === 6);

  const recipients = ['adamkischi@hotmail.com'];
  if (isWeekend) {
    recipients.push('adam@aleph.dk');
  }



  const mailOptions = {
    from: '"Adam Kischinovsky" <adam.kischinovsky@gmail.com>',
    to: recipients.join(', '),
    bcc: 'adamkischi@hotmail.com',  
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
    fs.writeFileSync(bookingsFile, JSON.stringify(bookings, null, 2));
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

app.post('/edit-booking/:id', (req, res) => {
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

    fs.writeFile(bookingsFile, JSON.stringify(bookings, null, 2), (err) => {
      if (err) return res.send('Failed to save.');
      res.send(`<h2>Booking updated!<br><br><a href="/dashboard">Back to Dashboard</a></h2>`);
    });
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
app.post('/mark-seen', (req, res) => {
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

  fs.writeFileSync(bookingsFile, JSON.stringify(updated, null, 2));
  res.redirect('/cleaner-dashboard');
});


// route to serve the cleaner dashboard
app.get('/cleaner-dashboard', requireAnyUser, (req, res) => {
  const bookingsData = JSON.parse(fs.readFileSync(bookingsFile));
  const today = new Date().toISOString().split('T')[0];

  // Step: Sort all bookings by check-in date
const sortedByCheckIn = [...bookingsData].sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));



  app.post('/mark-cleaned', (req, res) => {
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
  

  fs.writeFileSync(bookingsFile, JSON.stringify(updated, null, 2));
  res.redirect('/cleaner-dashboard');
});

app.post('/unmark-cleaned', (req, res) => {
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

  fs.writeFileSync(bookingsFile, JSON.stringify(updated, null, 2));
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
              <form method="POST" class="logout-form" action="/mark-cleaned" style="margin-top:5px">
                <input type="hidden" name="timestamp" value="${b.timestamp}">
                <button class="mark-cleaned" type="submit" ${isPastCheckout ? '' : 'disabled style="background-color: grey; cursor: not-allowed;"'}>Mark as Cleaned</button>
              </form>
            ` : 

            `<form method="POST" class="logout-form" action="/unmark-cleaned" style="margin-top:5px">
                <input type="hidden" name="timestamp" value="${b.timestamp}">
                <button class="button-unmark-cleaned" type="submit">Unmark as Cleaned</button>
            </form>`
}



            
        </form>

          <form method="POST" class="seen-form" action="/mark-seen">
            <input type="hidden" name="timestamp" value="${b.timestamp}">
            <button class="seen-button ${b.seen ? 'seen-true' : ''}" type="submit">
            👁️
          </button>
        </form>
          </div>
        </li>
      `;
    }).join('');
  }

  const showAdminButton = req.session.role === 'admin';



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
              appId: "ea93d9dd-cf34-486b-8d77-9444d5e7699f", // ← Your App ID from OneSignal
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


        <script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
      .then(() => console.log('Service Worker Registered!'))
      .catch((error) => console.error('Service Worker Registration Failed:', error));
  }

  window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Force reload when app becomes active again
    location.reload();
  }
});


</script>



      </body>
    </html>
  `);
});



app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
