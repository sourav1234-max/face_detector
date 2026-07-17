require("dotenv").config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON and URL-encoded bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer storage for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'photo-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only JPEG, PNG, and WebP images are allowed!'));
  }
});

// Helper functions for gallery database file
const galleryDbPath = path.join(__dirname, 'public', 'gallery.json');
let galleryCache = null;
let isWritingGallery = false;
const galleryWriteQueue = [];

function readGalleryDb() {
  if (galleryCache === null) {
    try {
      if (!fs.existsSync(galleryDbPath)) {
        fs.writeFileSync(galleryDbPath, JSON.stringify([], null, 2));
        galleryCache = [];
      } else {
        const data = fs.readFileSync(galleryDbPath, 'utf8');
        galleryCache = JSON.parse(data || '[]');
      }
      
      // Migrate older entries if needed
      let migrated = false;
      galleryCache.forEach(photo => {
        if (photo.status === undefined) {
          photo.status = 'approved';
          migrated = true;
        }
        if (photo.isPublic === undefined) {
          photo.isPublic = true;
          migrated = true;
        }
      });
      
      if (migrated) {
        fs.writeFileSync(galleryDbPath, JSON.stringify(galleryCache, null, 2));
      }
    } catch (err) {
      console.error('Error reading gallery database:', err);
      galleryCache = [];
    }
  }
  return galleryCache;
}

async function writeGalleryDb(data) {
  galleryCache = data;
  return new Promise((resolve, reject) => {
    const performWrite = async () => {
      isWritingGallery = true;
      try {
        await fs.promises.writeFile(galleryDbPath, JSON.stringify(galleryCache, null, 2));
        resolve(true);
      } catch (err) {
        console.error('Error writing gallery database:', err);
        reject(err);
      } finally {
        isWritingGallery = false;
        if (galleryWriteQueue.length > 0) {
          const nextWrite = galleryWriteQueue.shift();
          nextWrite();
        }
      }
    };

    if (!isWritingGallery) {
      performWrite();
    } else {
      galleryWriteQueue.push(performWrite);
    }
  });
}

// Helper functions for settings file
const settingsPath = path.join(__dirname, 'settings.json');

function readSettings() {
  try {
    if (!fs.existsSync(settingsPath)) {
      const defaultSettings = {
        adminPassword: 'admin123',
        publicGalleryEnabled: true,
        logoWidth: 245,
        photoRetentionHours: 24,
        googleClientId: '',
        googleClientSecret: '',
        googleRefreshToken: '',
        googleConnectedEmail: '',
        googleHasDriveScope: false
      };
      fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
      return defaultSettings;
    }
    const data = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(data || '{}');
    if (parsed.logoWidth === undefined) parsed.logoWidth = 245;
    if (parsed.photoRetentionHours === undefined) parsed.photoRetentionHours = 24;
    if (parsed.googleClientId === undefined) parsed.googleClientId = '';
    if (parsed.googleClientSecret === undefined) parsed.googleClientSecret = '';
    if (parsed.googleRefreshToken === undefined) parsed.googleRefreshToken = '';
    if (parsed.googleConnectedEmail === undefined) parsed.googleConnectedEmail = '';
    return parsed;
  } catch (err) {
    console.error('Error reading settings:', err);
    return {
      adminPassword: 'admin123',
      publicGalleryEnabled: true,
      logoWidth: 245,
      photoRetentionHours: 24,
      googleClientId: '',
      googleClientSecret: '',
      googleRefreshToken: '',
      googleConnectedEmail: '',
      googleHasDriveScope: false
    };
  }
}

function writeSettings(data) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing settings:', err);
    return false;
  }
}

// Google OAuth2 Client Initializer
function getGoogleOAuthClient() {
  const settings = readSettings();
  if (!settings.googleClientId || !settings.googleClientSecret) {
    return null;
  }
  const redirectUri =  process.env.NODE_ENV === 'production'
    ? 'https://face-detector-wksm.onrender.com/api/google/callback'
    : 'http://localhost:3000/api/google/callback';
  return new google.auth.OAuth2(
    settings.googleClientId,
    settings.googleClientSecret,
    redirectUri
  );
}

// Check and update drive scope status in settings if connected
async function verifyConnectedDriveScopes(settings) {
  if (!settings.googleRefreshToken) {
    settings.googleHasDriveScope = false;
    return settings;
  }
  
  if (settings.googleHasDriveScope !== undefined && settings.googleHasDriveScope === false) {
    // If it's already marked false, we don't re-check every time but we can re-check on boot or reload.
    // Let's check it anyway if it is not explicitly false/true or check it dynamically.
  }
  
  // Let's only run verification if googleHasDriveScope is not set or settings are loaded.
  // To avoid hitting rate limits, if we already verified it (either true or false), we can return.
  // Wait, if it is false, they need to re-authenticate, which will overwrite settings.
  // If it is true, it remains true. So if it is defined, we can just return it.
  if (settings.googleHasDriveScope !== undefined) {
    return settings;
  }

  try {
    const oauth2Client = getGoogleOAuthClient();
    if (!oauth2Client) return settings;
    
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();
    const tokenInfo = await oauth2Client.getTokenInfo(credentials.access_token);
    
    const scopes = tokenInfo.scopes || [];
    settings.googleHasDriveScope = scopes.includes('https://www.googleapis.com/auth/drive.file');
    writeSettings(settings);
    console.log(`[Google OAuth] Verified scope for stored token. Has drive.file: ${settings.googleHasDriveScope}`);
  } catch (err) {
    console.error('[Google OAuth] Failed to verify scopes of stored token:', err.message);
  }
  return settings;
}

let cachedGoogleFolderId = '';

// Google Drive Upload Helper
async function uploadToGoogleDrive(fileBuffer, originalName, mimeType) {
  const settings = readSettings();
  if (!settings.googleRefreshToken) {
    throw new Error('Google Drive is not connected.');
  }

  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // Find or create "FaceMatch_Photos" folder
  let folderId = '';
  if (cachedGoogleFolderId) {
    folderId = cachedGoogleFolderId;
  } else {
    try {
      const listRes = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder' and name='FaceMatch_Photos' and trashed=false",
        fields: 'files(id)',
        spaces: 'drive'
      });
      if (listRes.data.files.length > 0) {
        folderId = listRes.data.files[0].id;
      } else {
        const folderMetadata = {
          name: 'FaceMatch_Photos',
          mimeType: 'application/vnd.google-apps.folder'
        };
        const createFolder = await drive.files.create({
          resource: folderMetadata,
          fields: 'id'
        });
        folderId = createFolder.data.id;
      }
      if (folderId) {
        cachedGoogleFolderId = folderId;
      }
    } catch (err) {
      console.error('Google Drive folder error:', err.message);
    }
  }

  const stream = require('stream');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(fileBuffer);

  const fileMetadata = {
    name: originalName,
    parents: folderId ? [folderId] : []
  };
  const media = {
    mimeType: mimeType,
    body: bufferStream
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id'
  });

  return response.data.id;
}

// Google Drive Delete Helper
async function deleteFromGoogleDrive(fileId) {
  const settings = readSettings();
  if (!settings.googleRefreshToken) return;

  try {
    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    await drive.files.delete({ fileId: fileId });
    console.log(`[Google Drive] Deleted file ID: ${fileId}`);
  } catch (err) {
    console.error(`[Google Drive] Failed to delete file ID ${fileId}:`, err.message);
  }
}

// Session-based admin authentication
const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  return cookieHeader.split(';').reduce((cookies, part) => {
    const [name, ...rest] = part.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
    return cookies;
  }, {});
}

function createAdminSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function setAdminSessionCookie(res, token) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${isProduction ? '; Secure' : ''}`);
}

function clearAdminSessionCookie(res) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${isProduction ? '; Secure' : ''}`);
}

function getAdminSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies.admin_session || null;
}

function isValidAdminSession(req) {
  const token = getAdminSessionToken(req);
  if (!token) return false;

  const session = adminSessions.get(token);
  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }

  return true;
}

function clearAdminSessions() {
  adminSessions.clear();
}

function checkAdminAuth(req, res, next) {
  if (isValidAdminSession(req)) {
    return next();
  }

  return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin session' });
}

// --- API Endpoints ---

// 1. Get all photos in gallery (Public access)
app.get('/api/gallery', (req, res) => {
  const settings = readSettings();
  if (!settings.publicGalleryEnabled) {
    return res.json({ success: true, photos: [], publicGalleryEnabled: false, logoWidth: settings.logoWidth });
  }
  const gallery = readGalleryDb();
  // Return list of photos with basic metadata
  const publicPhotos = gallery.filter(photo => photo.status === 'approved' && photo.isPublic === true);
  res.json({ success: true, photos: publicPhotos, publicGalleryEnabled: true, logoWidth: settings.logoWidth });
});

// Python Face Detection Helper
// Global lock/queue for uploads to prevent race conditions and Google Drive rate limits
let uploadProcessingQueue = Promise.resolve();

// Process the heavy upload task sequentially
async function processUploadTask(req) {
  const settings = readSettings();
  const isAdmin = isValidAdminSession(req);

  const tempFilePath = path.join(__dirname, 'public', 'uploads', req.file.filename);

  let descriptors = [];
  if (req.body.descriptors) {
    try {
      descriptors = typeof req.body.descriptors === 'string'
        ? JSON.parse(req.body.descriptors)
        : req.body.descriptors;
    } catch (parseErr) {
      console.warn('Invalid descriptors payload on upload, storing empty face descriptors.');
      descriptors = [];
    }
  }

  let filename = req.file.filename;

  // Upload to Google Drive if connected
  if (settings.googleRefreshToken) {
    try {
      console.log(`[Google Drive] Uploading ${req.file.originalname} to cloud...`);
      const fileBuffer = fs.readFileSync(tempFilePath);
      
      const driveFileId = await uploadToGoogleDrive(fileBuffer, req.file.originalname, req.file.mimetype);
      
      // Delete local temporary file
      fs.unlinkSync(tempFilePath);
      
      filename = `drive:${driveFileId}`;
      console.log(`[Google Drive] Upload completed. File ID: ${driveFileId}`);
    } catch (driveErr) {
      console.error('[Google Drive] Cloud upload failed, using local storage fallback:', driveErr.message);
      // Clear folder ID cache to ensure recreated folder next time if folder was deleted
      cachedGoogleFolderId = '';
    }
  }

  const gallery = readGalleryDb();
  const newPhoto = {
    id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    filename: filename,
    originalName: req.file.originalname,
    timestamp: new Date().toISOString(),
    descriptors: descriptors, // List of {box, descriptor} representing faces detected
    status: isAdmin ? 'approved' : 'pending',
    isPublic: isAdmin ? (req.body.isPublic === 'true' || req.body.isPublic === true) : false
  };

  gallery.push(newPhoto);
  await writeGalleryDb(gallery);

  console.log(`Uploaded: ${newPhoto.filename} with ${descriptors.length} face descriptors (Admin: ${isAdmin})`);
  return newPhoto;
}

// 2. Upload a new photo with its face descriptors
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    // Queue the upload tasks to run sequentially on the server
    const newPhoto = await new Promise((resolve, reject) => {
      uploadProcessingQueue = uploadProcessingQueue.then(async () => {
        try {
          const photo = await processUploadTask(req);
          resolve(photo);
        } catch (err) {
          reject(err);
        }
      });
    });

    res.json({ success: true, photo: newPhoto });
  } catch (err) {
    console.error('Upload endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Search API (Public access - secure server-side matching)
app.post('/api/search', async (req, res) => {
  try {
    const limit = req.body.threshold !== undefined ? parseFloat(req.body.threshold) : 0.5;
    const queryDescriptor = req.body.descriptor || req.body.queryDescriptor;

    if (!queryDescriptor || !Array.isArray(queryDescriptor)) {
      return res.status(400).json({ success: false, error: 'No face descriptor provided for search' });
    }

    const gallery = readGalleryDb();
    const matches = [];

    // Simple Euclidean distance function
    function getEuclideanDistance(a, b) {
      let sum = 0;
      const len = a.length;
      for (let i = 0; i < len; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
      }
      return Math.sqrt(sum);
    }

    // Only match against approved photos
    const approvedPhotos = gallery.filter(photo => photo.status === 'approved');

    approvedPhotos.forEach(photo => {
      if (!photo.descriptors || photo.descriptors.length === 0) return;

      let minDistance = 999;

      photo.descriptors.forEach(faceData => {
        const desc = Array.isArray(faceData) ? faceData : faceData.descriptor;
        if (!desc || !Array.isArray(desc)) return;

        const dist = getEuclideanDistance(queryDescriptor, desc);
        if (dist < minDistance) {
          minDistance = dist;
        }
      });

      if (minDistance <= limit) {
        const confidence = Math.max(0, Math.round((1 - minDistance) * 100));
        matches.push({
          photo: {
            id: photo.id,
            filename: photo.filename,
            originalName: photo.originalName,
            timestamp: photo.timestamp,
            descriptors: photo.descriptors
          },
          distance: minDistance,
          confidence: confidence
        });
      }
    });

    matches.sort((a, b) => a.distance - b.distance);

    res.json({ success: true, matches: matches });
  } catch (err) {
    // Clean up temporary search file on error
    if (isTempFile && tempSearchPath && fs.existsSync(tempSearchPath)) {
      try {
        fs.unlinkSync(tempSearchPath);
      } catch (unlinkErr) {
        console.error('Failed to unlink temporary search file on error:', unlinkErr.message);
      }
    }
    console.error('Search endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Google Drive Image Streaming Proxy ---
app.get('/api/drive/photo/:fileId', async (req, res) => {
  try {
    const settings = readSettings();
    if (!settings.googleRefreshToken) {
      return res.status(400).send('Google Drive is not connected.');
    }

    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    }
    response.data.pipe(res);
  } catch (err) {
    console.error('Error fetching file from Google Drive:', err.message);
    res.status(500).send('Error loading image.');
  }
});

// --- Admin OAuth2 Routes ---
app.get('/api/google/auth', (req, res) => {
  const oauth2Client = getGoogleOAuthClient();
  if (!oauth2Client) {
    return res.status(400).send('Please configure Google Client ID and Secret in settings first.');
  }
  
  const scopes = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email'
  ];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/api/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('OAuth callback code missing.');
  }
  
  try {
    const oauth2Client = getGoogleOAuthClient();
    if (!oauth2Client) {
      return res.status(400).send('Google credentials missing.');
    }
    
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    let email = 'Connected Account';
    try {
      const userInfo = await oauth2.userinfo.get();
      email = userInfo.data.email || 'Connected Account';
    } catch (err) {
      console.error('Failed to retrieve user email:', err.message);
    }
    
    const scopesGranted = (tokens.scope || '').split(' ');
    const hasDriveScope = scopesGranted.includes('https://www.googleapis.com/auth/drive.file');

    const settings = readSettings();
    if (tokens.refresh_token) {
      settings.googleRefreshToken = tokens.refresh_token;
    } else if (!settings.googleRefreshToken) {
      return res.status(400).send('Authentication failed: Refresh token not returned by Google. Revoke permissions for this app in your Google Account Settings and retry.');
    }
    
    settings.googleConnectedEmail = email;
    settings.googleHasDriveScope = hasDriveScope;
    writeSettings(settings);
    
    console.log(`Successfully connected Google Drive: ${email} (Has Drive Scope: ${hasDriveScope})`);
    if (!hasDriveScope) {
      res.redirect('/admin.html?gdrive=missing_scope');
    } else {
      res.redirect('/admin.html?gdrive=success');
    }
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.status(500).send('OAuth verification failed: ' + err.message);
  }
});

app.post('/api/google/disconnect', checkAdminAuth, (req, res) => {
  const settings = readSettings();
  settings.googleRefreshToken = '';
  settings.googleConnectedEmail = '';
  settings.googleHasDriveScope = false;
  writeSettings(settings);
  cachedGoogleFolderId = ''; // Clear folder cache on disconnect
  console.log('Google Drive disconnected.');
  res.json({ success: true });
});

// --- Admin APIs (Protected by x-admin-password header) ---

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const settings = readSettings();
  if (password === settings.adminPassword) {
    const token = createAdminSessionToken();
    adminSessions.set(token, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
    setAdminSessionCookie(res, token);
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Admin Session Check
app.get('/api/admin/session-check', (req, res) => {
  if (isValidAdminSession(req)) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: 'Not authenticated' });
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
  const token = getAdminSessionToken(req);
  if (token) {
    adminSessions.delete(token);
  }
  clearAdminSessionCookie(res);
  res.json({ success: true });
});

// Admin Get Settings
app.get('/api/admin/settings', checkAdminAuth, async (req, res) => {
  let settings = readSettings();
  settings = await verifyConnectedDriveScopes(settings);
  res.json({
    success: true,
    settings: {
      publicGalleryEnabled: settings.publicGalleryEnabled,
      logoWidth: settings.logoWidth,
      photoRetentionHours: settings.photoRetentionHours,
      googleClientId: settings.googleClientId,
      googleClientSecret: settings.googleClientSecret,
      googleRefreshToken: settings.googleRefreshToken,
      googleConnectedEmail: settings.googleConnectedEmail,
      googleHasDriveScope: settings.googleHasDriveScope
    }
  });
});

// Admin Update Settings
app.post('/api/admin/settings', checkAdminAuth, (req, res) => {
  const { publicGalleryEnabled, newPassword, logoWidth, photoRetentionHours, googleClientId, googleClientSecret } = req.body;
  const settings = readSettings();
  if (publicGalleryEnabled !== undefined) {
    settings.publicGalleryEnabled = !!publicGalleryEnabled;
  }
  if (newPassword && newPassword.trim() !== '') {
    settings.adminPassword = newPassword.trim();
    clearAdminSessions();
  }
  if (logoWidth !== undefined) {
    settings.logoWidth = parseInt(logoWidth, 10) || 245;
  }
  if (photoRetentionHours !== undefined) {
    settings.photoRetentionHours = parseFloat(photoRetentionHours);
  }
  if (googleClientId !== undefined) {
    settings.googleClientId = googleClientId.trim();
    cachedGoogleFolderId = ''; // Clear folder cache on credentials change
  }
  if (googleClientSecret !== undefined) {
    settings.googleClientSecret = googleClientSecret.trim();
    cachedGoogleFolderId = ''; // Clear folder cache on credentials change
  }
  writeSettings(settings);
  res.json({
    success: true,
    settings: {
      publicGalleryEnabled: settings.publicGalleryEnabled,
      logoWidth: settings.logoWidth,
      photoRetentionHours: settings.photoRetentionHours,
      googleClientId: settings.googleClientId,
      googleClientSecret: settings.googleClientSecret,
      googleRefreshToken: settings.googleRefreshToken,
      googleConnectedEmail: settings.googleConnectedEmail,
      googleHasDriveScope: settings.googleHasDriveScope
    }
  });
});

// Admin Get Gallery (returns all photos)
app.get('/api/admin/gallery', checkAdminAuth, (req, res) => {
  const gallery = readGalleryDb();
  res.json({ success: true, photos: gallery });
});

// Admin Update Status
app.post('/api/admin/update-status', checkAdminAuth, async (req, res) => {
  const { id, status } = req.body;
  if (!id || !status) {
    return res.status(400).json({ success: false, error: 'Photo ID and status are required' });
  }
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status value' });
  }
  const gallery = readGalleryDb();
  const photo = gallery.find(p => p.id === id);
  if (!photo) {
    return res.status(404).json({ success: false, error: 'Photo not found' });
  }
  photo.status = status;
  if (status === 'rejected') {
    photo.isPublic = false;
  }
  await writeGalleryDb(gallery);
  res.json({ success: true, photo });
});

// Admin Update Visibility
app.post('/api/admin/update-visibility', checkAdminAuth, async (req, res) => {
  const { id, isPublic } = req.body;
  if (!id || isPublic === undefined) {
    return res.status(400).json({ success: false, error: 'Photo ID and isPublic flag are required' });
  }
  const gallery = readGalleryDb();
  const photo = gallery.find(p => p.id === id);
  if (!photo) {
    return res.status(404).json({ success: false, error: 'Photo not found' });
  }
  photo.isPublic = !!isPublic;
  await writeGalleryDb(gallery);
  res.json({ success: true, photo });
});

// Admin Bulk Moderate (Approve All or Reject All)
app.post('/api/admin/bulk-status', checkAdminAuth, async (req, res) => {
  const { status, ids } = req.body;
  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status value' });
  }

  const gallery = readGalleryDb();
  let updatedCount = 0;

  gallery.forEach(photo => {
    if (ids && Array.isArray(ids)) {
      // Update selected ids
      if (ids.includes(photo.id)) {
        photo.status = status;
        if (status === 'rejected') photo.isPublic = false;
        updatedCount++;
      }
    } else if (photo.status === 'pending') {
      // Default: Update all pending photos
      photo.status = status;
      if (status === 'rejected') photo.isPublic = false;
      updatedCount++;
    }
  });

  await writeGalleryDb(gallery);
  res.json({ success: true, updatedCount });
});

// Multer memory storage for logo upload
const multerMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB logo limit
});

// Admin Upload Logo
app.post('/api/admin/upload-logo', checkAdminAuth, multerMemory.single('logo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No logo file uploaded' });
    }

    const logoDir = path.join(__dirname, 'public', 'photos');
    if (!fs.existsSync(logoDir)) {
      fs.mkdirSync(logoDir, { recursive: true });
    }

    const logoPath = path.join(logoDir, 'logo.png');
    fs.writeFileSync(logoPath, req.file.buffer);

    console.log('Admin uploaded custom logo');
    res.json({ success: true, logoUrl: '/photos/logo.png?t=' + Date.now() });
  } catch (err) {
    console.error('Logo upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Delete Photo (Protected delete endpoint)
app.post('/api/delete', checkAdminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Photo ID is required' });
    }

    const gallery = readGalleryDb();
    const photoToDelete = gallery.find(item => item.id === id);

    if (!photoToDelete) {
      return res.status(404).json({ success: false, error: 'Photo not found in registry' });
    }

    if (photoToDelete.filename.startsWith('drive:')) {
      const driveFileId = photoToDelete.filename.split(':')[1];
      await deleteFromGoogleDrive(driveFileId);
    } else {
      const filePath = path.join(__dirname, 'public', 'uploads', photoToDelete.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted file: ${filePath}`);
      }
    }

    // Read fresh cache, find index, splice and write asynchronously
    const freshGallery = readGalleryDb();
    const freshIndex = freshGallery.findIndex(item => item.id === id);
    if (freshIndex !== -1) {
      freshGallery.splice(freshIndex, 1);
      await writeGalleryDb(freshGallery);
    }

    res.json({ success: true, message: 'Photo deleted successfully' });
  } catch (err) {
    console.error('Delete endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Delete All Photos (Protected endpoint)
app.post('/api/admin/delete-all', checkAdminAuth, async (req, res) => {
  try {
    const gallery = readGalleryDb();
    console.log(`[Admin Delete All] Deleting all ${gallery.length} photos...`);

    for (const photo of gallery) {
      if (photo.filename.startsWith('drive:')) {
        const driveFileId = photo.filename.split(':')[1];
        try {
          await deleteFromGoogleDrive(driveFileId);
        } catch (driveErr) {
          console.error(`[Admin Delete All] Failed to delete file ${driveFileId} from Google Drive:`, driveErr.message);
        }
      } else {
        const filePath = path.join(__dirname, 'public', 'uploads', photo.filename);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            console.log(`Deleted file: ${filePath}`);
          } catch (fileErr) {
            console.error(`[Admin Delete All] Failed to delete local file ${filePath}:`, fileErr.message);
          }
        }
      }
    }

    await writeGalleryDb([]);
    res.json({ success: true, message: 'All photos deleted successfully' });
  } catch (err) {
    console.error('Delete-all endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Catch-all for Express errors
app.use((err, req, res, next) => {
  console.error('Express global error handler:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// Background Auto-Cleanup Task for expired photos
async function runPhotoCleanup() {
  try {
    const settings = readSettings();
    const retentionHours = parseFloat(settings.photoRetentionHours);
    if (isNaN(retentionHours) || retentionHours <= 0) {
      return; // Cleanup disabled
    }

    const gallery = readGalleryDb();
    const expirationMs = retentionHours * 60 * 60 * 1000;
    const now = Date.now();
    const remainingPhotos = [];
    let deletedCount = 0;

    for (const photo of gallery) {
      const ageMs = now - Date.parse(photo.timestamp);
      if (ageMs > expirationMs) {
        if (photo.filename.startsWith('drive:')) {
          const driveFileId = photo.filename.split(':')[1];
          await deleteFromGoogleDrive(driveFileId);
        } else {
          const filePath = path.join(__dirname, 'public', 'uploads', photo.filename);
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
              console.log(`[Auto-Cleanup] Deleted expired image file: ${photo.filename}`);
            } catch (err) {
              console.error(`[Auto-Cleanup] Failed to delete file: ${photo.filename}`, err);
            }
          }
        }
        deletedCount++;
      } else {
        remainingPhotos.push(photo);
      }
    }

    if (deletedCount > 0) {
      await writeGalleryDb(remainingPhotos);
      console.log(`[Auto-Cleanup] Automatically purged ${deletedCount} expired photo(s).`);
    }
  } catch (err) {
    console.error('[Auto-Cleanup] Error during auto-cleanup execution:', err);
  }
}

// Run cleanup every 10 minutes
setInterval(runPhotoCleanup, 10 * 60 * 1000);

// Run initial cleanup once on server boot
runPhotoCleanup();

// Start the server
const server = app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Face Detection Gallery Server is running!`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(`==================================================`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please stop the existing server or set PORT to a free port before starting.`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});
