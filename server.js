require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { google } = require('googleapis');
const {
  isFirebaseEnabled,
  readGalleryDb,
  writeGalleryDb,
  addPhoto,
  updatePhoto,
  deletePhotoRecord,
  getPhotoById,
  readSettings,
  writeSettings,
  uploadToFirebaseStorage,
  deleteFromFirebaseStorage,
  getFirebaseFileStream
} = require('./lib/store');
const { initFirebase } = require('./lib/firebase');

const app = express();
const PORT = process.env.PORT || 3000;

if (isFirebaseEnabled()) {
  initFirebase();
}

app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Memory storage works on Vercel (no persistent local disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only JPEG, PNG, and WebP images are allowed!'));
  }
});

const multerMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

function getGoogleRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI.replace(/\/$/, '');
  }
  return `${getPublicBaseUrl(req)}/api/google/callback`;
}

async function createGoogleOAuthClient(req) {
  const settings = await readSettings();
  if (!settings.googleClientId || !settings.googleClientSecret) {
    return null;
  }
  const redirectUri = getGoogleRedirectUri(req);
  return new google.auth.OAuth2(
    settings.googleClientId,
    settings.googleClientSecret,
    redirectUri
  );
}

async function verifyConnectedDriveScopes(settings) {
  if (!settings.googleRefreshToken) {
    settings.googleHasDriveScope = false;
    return settings;
  }
  if (settings.googleHasDriveScope !== undefined) {
    return settings;
  }

  try {
    const oauth2Client = await createGoogleOAuthClient();
    if (!oauth2Client) return settings;
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();
    const tokenInfo = await oauth2Client.getTokenInfo(credentials.access_token);
    const scopes = tokenInfo.scopes || [];
    settings.googleHasDriveScope = scopes.includes('https://www.googleapis.com/auth/drive.file');
    await writeSettings(settings);
  } catch (err) {
    console.error('[Google OAuth] Failed to verify scopes:', err.message);
  }
  return settings;
}

let cachedGoogleFolderId = '';

async function uploadToGoogleDrive(fileBuffer, originalName, mimeType) {
  const settings = await readSettings();
  if (!settings.googleRefreshToken) {
    throw new Error('Google Drive is not connected.');
  }

  const oauth2Client = await createGoogleOAuthClient();
  oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

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
        const createFolder = await drive.files.create({
          resource: {
            name: 'FaceMatch_Photos',
            mimeType: 'application/vnd.google-apps.folder'
          },
          fields: 'id'
        });
        folderId = createFolder.data.id;
      }
      if (folderId) cachedGoogleFolderId = folderId;
    } catch (err) {
      console.error('Google Drive folder error:', err.message);
    }
  }

  const stream = require('stream');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(fileBuffer);

  const response = await drive.files.create({
    resource: {
      name: originalName,
      parents: folderId ? [folderId] : []
    },
    media: { mimeType, body: bufferStream },
    fields: 'id'
  });

  return response.data.id;
}

async function deleteFromGoogleDrive(fileId) {
  const settings = await readSettings();
  if (!settings.googleRefreshToken) return;
  try {
    const oauth2Client = await createGoogleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    await drive.files.delete({ fileId });
    console.log(`[Google Drive] Deleted file ID: ${fileId}`);
  } catch (err) {
    console.error(`[Google Drive] Failed to delete file ID ${fileId}:`, err.message);
  }
}

async function deletePhotoAssets(photo) {
  if (!photo || !photo.filename) return;

  if (photo.filename.startsWith('firebase:')) {
    await deleteFromFirebaseStorage(photo.filename.slice('firebase:'.length));
  } else if (photo.filename.startsWith('drive:')) {
    await deleteFromGoogleDrive(photo.filename.split(':')[1]);
  } else {
    const filePath = path.join(__dirname, 'public', 'uploads', photo.filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete local file ${photo.filename}:`, err.message);
      }
    }
  }
}

// Signed cookie sessions (works across Vercel serverless instances)
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  return cookieHeader.split(';').reduce((cookies, part) => {
    const [name, ...rest] = part.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(rest.join('='));
    return cookies;
  }, {});
}

function getSessionSecret(settings) {
  return process.env.SESSION_SECRET || settings.adminPassword || 'facematch-session';
}

async function createAdminSessionToken() {
  const settings = await readSettings();
  const issuedAt = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${issuedAt}.${nonce}`;
  const sig = crypto.createHmac('sha256', getSessionSecret(settings)).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function setAdminSessionCookie(res, token) {
  const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  res.setHeader(
    'Set-Cookie',
    `admin_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${isProduction ? '; Secure' : ''}`
  );
}

function clearAdminSessionCookie(res) {
  const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  res.setHeader(
    'Set-Cookie',
    `admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${isProduction ? '; Secure' : ''}`
  );
}

function getAdminSessionToken(req) {
  return parseCookies(req).admin_session || null;
}

async function isValidAdminSession(req) {
  const token = getAdminSessionToken(req);
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [issuedAt, nonce, sig] = parts;
  const settings = await readSettings();
  const payload = `${issuedAt}.${nonce}`;
  const expected = crypto.createHmac('sha256', getSessionSecret(settings)).update(payload).digest('hex');

  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }

  const age = Date.now() - parseInt(issuedAt, 10);
  return !isNaN(age) && age >= 0 && age <= ADMIN_SESSION_TTL_MS;
}

function checkAdminAuth(req, res, next) {
  isValidAdminSession(req)
    .then((ok) => {
      if (ok) return next();
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin session' });
    })
    .catch((err) => {
      console.error('Admin auth check failed:', err);
      return res.status(500).json({ success: false, error: 'Auth check failed' });
    });
}

function getEuclideanDistance(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// --- Public APIs ---

app.get('/api/gallery', async (req, res) => {
  try {
    const settings = await readSettings();
    if (!settings.publicGalleryEnabled) {
      return res.json({
        success: true,
        photos: [],
        publicGalleryEnabled: false,
        logoWidth: settings.logoWidth,
        storageMode: isFirebaseEnabled() ? 'firebase' : 'local'
      });
    }
    const gallery = await readGalleryDb();
    const publicPhotos = gallery.filter(photo => photo.status === 'approved' && photo.isPublic === true);
    res.json({
      success: true,
      photos: publicPhotos,
      publicGalleryEnabled: true,
      logoWidth: settings.logoWidth,
      storageMode: isFirebaseEnabled() ? 'firebase' : 'local'
    });
  } catch (err) {
    console.error('Gallery endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

let uploadProcessingQueue = Promise.resolve();

async function processUploadTask(req) {
  const settings = await readSettings();
  const isAdmin = await isValidAdminSession(req);
  const buffer = req.file.buffer;
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const photoId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

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

  let filename;
  let storageUrl = '';

  // Prefer Google Drive when connected, otherwise use Firebase Storage if enabled.
  if (settings.googleRefreshToken) {
    try {
      console.log(`[Google Drive] Uploading ${req.file.originalname}...`);
      const driveFileId = await uploadToGoogleDrive(buffer, req.file.originalname, req.file.mimetype);
      filename = `drive:${driveFileId}`;
      console.log(`[Google Drive] Upload completed. File ID: ${driveFileId}`);
    } catch (driveErr) {
      console.error('[Google Drive] Cloud upload failed:', driveErr.message);
      cachedGoogleFolderId = '';
      if (isFirebaseEnabled()) {
        const destPath = `photos/${photoId}${ext}`;
        const uploaded = await uploadToFirebaseStorage(buffer, destPath, req.file.mimetype);
        filename = `firebase:${uploaded.path}`;
        storageUrl = uploaded.url;
        console.log(`[Firebase Storage] Fallback upload ${req.file.originalname} -> ${uploaded.path}`);
      } else {
        filename = await saveLocalUpload(buffer, ext);
      }
    }
  } else if (isFirebaseEnabled()) {
    const destPath = `photos/${photoId}${ext}`;
    const uploaded = await uploadToFirebaseStorage(buffer, destPath, req.file.mimetype);
    filename = `firebase:${uploaded.path}`;
    storageUrl = uploaded.url;
    console.log(`[Firebase Storage] Uploaded ${req.file.originalname} -> ${uploaded.path}`);
  } else {
    filename = await saveLocalUpload(buffer, ext);
  }

  const newPhoto = {
    id: photoId,
    filename,
    storageUrl,
    originalName: req.file.originalname,
    timestamp: new Date().toISOString(),
    descriptors,
    status: isAdmin ? 'approved' : 'pending',
    isPublic: isAdmin ? (req.body.isPublic === 'true' || req.body.isPublic === true) : false
  };

  await addPhoto(newPhoto);
  console.log(`Uploaded: ${newPhoto.filename} with ${descriptors.length} face descriptors (Admin: ${isAdmin})`);
  return newPhoto;
}

async function saveLocalUpload(buffer, ext) {
  const uploadPath = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
  }
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const filename = 'photo-' + uniqueSuffix + ext;
  fs.writeFileSync(path.join(uploadPath, filename), buffer);
  return filename;
}

app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    const newPhoto = await new Promise((resolve, reject) => {
      uploadProcessingQueue = uploadProcessingQueue.then(async () => {
        try {
          resolve(await processUploadTask(req));
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

app.post('/api/search', async (req, res) => {
  try {
    const limit = req.body.threshold !== undefined ? parseFloat(req.body.threshold) : 0.55;
    const queryDescriptor = req.body.descriptor || req.body.queryDescriptor;

    if (!queryDescriptor || !Array.isArray(queryDescriptor)) {
      return res.status(400).json({ success: false, error: 'No face descriptor provided for search' });
    }

    const gallery = await readGalleryDb();
    const matches = [];
    const approvedPhotos = gallery.filter(photo => photo.status === 'approved');

    approvedPhotos.forEach(photo => {
      if (!photo.descriptors || photo.descriptors.length === 0) return;

      let minDistance = 999;
      photo.descriptors.forEach(faceData => {
        const desc = Array.isArray(faceData) ? faceData : faceData.descriptor;
        if (!desc || !Array.isArray(desc) || desc.length === 0) return;
        const dist = getEuclideanDistance(queryDescriptor, desc);
        if (dist < minDistance) minDistance = dist;
      });

      if (minDistance <= limit) {
        matches.push({
          photo: {
            id: photo.id,
            filename: photo.filename,
            storageUrl: photo.storageUrl || '',
            originalName: photo.originalName,
            timestamp: photo.timestamp,
            descriptors: photo.descriptors
          },
          distance: minDistance,
          confidence: Math.max(0, Math.round((1 - minDistance) * 100))
        });
      }
    });

    matches.sort((a, b) => a.distance - b.distance);
    res.json({ success: true, matches });
  } catch (err) {
    console.error('Search endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/drive/photo/:fileId', async (req, res) => {
  try {
    const settings = await readSettings();
    if (!settings.googleRefreshToken) {
      return res.status(400).send('Google Drive is not connected.');
    }

    const oauth2Client = await createGoogleOAuthClient(req);
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

app.get('/api/storage/photo', async (req, res) => {
  try {
    const storagePath = req.query.path;
    if (!storagePath || typeof storagePath !== 'string') {
      return res.status(400).send('Missing path');
    }
    // Prevent path traversal
    if (storagePath.includes('..') || storagePath.startsWith('/')) {
      return res.status(400).send('Invalid path');
    }

    const { stream, contentType } = await getFirebaseFileStream(storagePath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.pipe(res);
  } catch (err) {
    console.error('Error fetching Firebase Storage file:', err.message);
    res.status(404).send('Image not found.');
  }
});

// --- Google OAuth ---

app.get('/api/google/auth', async (req, res) => {
  const oauth2Client = await createGoogleOAuthClient(req);
  if (!oauth2Client) {
    return res.status(400).send('Please configure Google Client ID and Secret in settings first.');
  }

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/api/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('OAuth callback code missing.');

  try {
    const oauth2Client = await createGoogleOAuthClient(req);
    if (!oauth2Client) return res.status(400).send('Google credentials missing.');

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    let email = 'Connected Account';
    try {
      const userInfo = await oauth2.userinfo.get();
      email = userInfo.data.email || email;
    } catch (err) {
      console.error('Failed to retrieve user email:', err.message);
    }

    const scopesGranted = (tokens.scope || '').split(' ');
    const hasDriveScope = scopesGranted.includes('https://www.googleapis.com/auth/drive.file');
    const settings = await readSettings();

    if (tokens.refresh_token) {
      settings.googleRefreshToken = tokens.refresh_token;
    } else if (!settings.googleRefreshToken) {
      return res.status(400).send(
        'Authentication failed: Refresh token not returned by Google. Revoke app access in Google Account Settings and retry.'
      );
    }

    settings.googleConnectedEmail = email;
    settings.googleHasDriveScope = hasDriveScope;
    await writeSettings(settings);

    res.redirect(hasDriveScope ? '/admin.html?gdrive=success' : '/admin.html?gdrive=missing_scope');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.status(500).send('OAuth verification failed: ' + err.message);
  }
});

app.post('/api/google/disconnect', checkAdminAuth, async (req, res) => {
  const settings = await readSettings();
  settings.googleRefreshToken = '';
  settings.googleConnectedEmail = '';
  settings.googleHasDriveScope = false;
  await writeSettings(settings);
  cachedGoogleFolderId = '';
  res.json({ success: true });
});

// --- Admin APIs ---

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const settings = await readSettings();
  if (password === settings.adminPassword) {
    const token = await createAdminSessionToken();
    setAdminSessionCookie(res, token);
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

app.get('/api/admin/session-check', async (req, res) => {
  if (await isValidAdminSession(req)) return res.json({ success: true });
  return res.status(401).json({ success: false, error: 'Not authenticated' });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/admin/settings', checkAdminAuth, async (req, res) => {
  let settings = await readSettings();
  settings = await verifyConnectedDriveScopes(settings);
  res.json({
    success: true,
    storageMode: isFirebaseEnabled() ? 'firebase' : (settings.googleRefreshToken ? 'drive' : 'local'),
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

app.post('/api/admin/settings', checkAdminAuth, async (req, res) => {
  const { publicGalleryEnabled, newPassword, logoWidth, photoRetentionHours, googleClientId, googleClientSecret } = req.body;
  const settings = await readSettings();

  if (publicGalleryEnabled !== undefined) settings.publicGalleryEnabled = !!publicGalleryEnabled;
  if (newPassword && newPassword.trim() !== '') settings.adminPassword = newPassword.trim();
  if (logoWidth !== undefined) settings.logoWidth = parseInt(logoWidth, 10) || 245;
  if (photoRetentionHours !== undefined) settings.photoRetentionHours = parseFloat(photoRetentionHours);
  if (googleClientId !== undefined) {
    settings.googleClientId = googleClientId.trim();
    cachedGoogleFolderId = '';
  }
  if (googleClientSecret !== undefined) {
    settings.googleClientSecret = googleClientSecret.trim();
    cachedGoogleFolderId = '';
  }

  await writeSettings(settings);
  res.json({
    success: true,
    storageMode: isFirebaseEnabled() ? 'firebase' : (settings.googleRefreshToken ? 'drive' : 'local'),
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

app.get('/api/admin/gallery', checkAdminAuth, async (req, res) => {
  try {
    const gallery = await readGalleryDb();
    res.json({ success: true, photos: gallery });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/update-status', checkAdminAuth, async (req, res) => {
  const { id, status } = req.body;
  if (!id || !status) {
    return res.status(400).json({ success: false, error: 'Photo ID and status are required' });
  }
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status value' });
  }

  const patch = { status };
  if (status === 'rejected') patch.isPublic = false;
  const photo = await updatePhoto(id, patch);
  if (!photo) return res.status(404).json({ success: false, error: 'Photo not found' });
  res.json({ success: true, photo });
});

app.post('/api/admin/update-visibility', checkAdminAuth, async (req, res) => {
  const { id, isPublic } = req.body;
  if (!id || isPublic === undefined) {
    return res.status(400).json({ success: false, error: 'Photo ID and isPublic flag are required' });
  }
  const photo = await updatePhoto(id, { isPublic: !!isPublic });
  if (!photo) return res.status(404).json({ success: false, error: 'Photo not found' });
  res.json({ success: true, photo });
});

app.post('/api/admin/bulk-status', checkAdminAuth, async (req, res) => {
  const { status, ids } = req.body;
  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status value' });
  }

  const gallery = await readGalleryDb();
  let updatedCount = 0;

  for (const photo of gallery) {
    const shouldUpdate = ids && Array.isArray(ids)
      ? ids.includes(photo.id)
      : photo.status === 'pending';

    if (shouldUpdate) {
      const patch = { status };
      if (status === 'rejected') patch.isPublic = false;
      await updatePhoto(photo.id, patch);
      updatedCount++;
    }
  }

  res.json({ success: true, updatedCount });
});

app.post('/api/admin/upload-logo', checkAdminAuth, multerMemory.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No logo file uploaded' });
    }

    if (isFirebaseEnabled()) {
      const uploaded = await uploadToFirebaseStorage(req.file.buffer, 'branding/logo.png', req.file.mimetype || 'image/png');
      const settings = await readSettings();
      settings.logoUrl = uploaded.url;
      await writeSettings(settings);
      return res.json({ success: true, logoUrl: uploaded.url + '?t=' + Date.now() });
    }

    const logoDir = path.join(__dirname, 'public', 'photos');
    if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
    fs.writeFileSync(path.join(logoDir, 'logo.png'), req.file.buffer);
    res.json({ success: true, logoUrl: '/photos/logo.png?t=' + Date.now() });
  } catch (err) {
    console.error('Logo upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/delete', checkAdminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'Photo ID is required' });

    const photoToDelete = await getPhotoById(id);
    if (!photoToDelete) {
      return res.status(404).json({ success: false, error: 'Photo not found in registry' });
    }

    await deletePhotoAssets(photoToDelete);
    await deletePhotoRecord(id);
    res.json({ success: true, message: 'Photo deleted successfully' });
  } catch (err) {
    console.error('Delete endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/delete-all', checkAdminAuth, async (req, res) => {
  try {
    const gallery = await readGalleryDb();
    console.log(`[Admin Delete All] Deleting all ${gallery.length} photos...`);
    for (const photo of gallery) {
      await deletePhotoAssets(photo);
    }
    await writeGalleryDb([]);
    res.json({ success: true, message: 'All photos deleted successfully' });
  } catch (err) {
    console.error('Delete-all endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Express global error handler:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// Auto-cleanup only when retention > 0 (default is now 0 = keep forever)
async function runPhotoCleanup() {
  try {
    const settings = await readSettings();
    const retentionHours = parseFloat(settings.photoRetentionHours);
    if (isNaN(retentionHours) || retentionHours <= 0) return;

    const gallery = await readGalleryDb();
    const expirationMs = retentionHours * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    for (const photo of gallery) {
      const ageMs = now - Date.parse(photo.timestamp);
      if (ageMs > expirationMs) {
        await deletePhotoAssets(photo);
        await deletePhotoRecord(photo.id);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      console.log(`[Auto-Cleanup] Purged ${deletedCount} expired photo(s).`);
    }
  } catch (err) {
    console.error('[Auto-Cleanup] Error:', err);
  }
}

// Only run interval cleanup on long-lived servers (not ideal on Vercel serverless)
if (!process.env.VERCEL) {
  setInterval(runPhotoCleanup, 10 * 60 * 1000);
  runPhotoCleanup();
}

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log('==================================================');
    console.log(' Face Detection Gallery Server is running!');
    console.log(` Local URL: http://localhost:${PORT}`);
    console.log(` Storage: ${isFirebaseEnabled() ? 'Firebase' : 'Local/Drive'}`);
    console.log('==================================================');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error('Server error:', err);
    }
  });
}

module.exports = app;
