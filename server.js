require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { google } = require('googleapis');
const { execFile } = require('child_process');
const {
  isFirebaseEnabled,
  readGalleryDb,
  writeGalleryDb,
  addPhoto,
  updatePhoto,
  deletePhotoRecord,
  getPhotoById,
  readEventsDb,
  writeEventsDb,
  addEvent,
  updateEvent,
  deleteEvent,
  getEventById,
  readSettings,
  writeSettings,
  invalidateSettingsCache,
  sanitizeSettingsForClient,
  uploadToFirebaseStorage,
  deleteFromFirebaseStorage,
  getFirebaseFileStream
} = require('./lib/store');
const { initFirebase } = require('./lib/firebase');

const app = express();
const PORT = process.env.PORT || 3000;

if (isFirebaseEnabled()) {
  initFirebase();
} else {
  console.warn('[Startup] Firebase is not enabled. Firestore metadata storage will not be available.');
}

validateEnvironment();
app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Memory storage works on Vercel (no persistent local disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
    fieldSize: 50 * 1024 * 1024  // 50 MB for form data text fields (e.g. descriptors JSON)
  },
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
  limits: {
    fileSize: 50 * 1024 * 1024,
    fieldSize: 50 * 1024 * 1024
  }
});

function normalizeHost(host) {
  if (!host) return host;
  return host.replace(/:(80|443)$/, '');
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const rawHost = req.headers['x-forwarded-host'] || req.headers.host || req.get('host');
    const host = normalizeHost(rawHost);
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

function validateEnvironment() {
  const required = [];
  const warnings = [];

  if (!process.env.SESSION_SECRET) {
    warnings.push('SESSION_SECRET is not set. Admin sessions will use the admin password as the HMAC secret.');
  }

  if (!process.env.PUBLIC_BASE_URL && !process.env.VERCEL_URL && !process.env.GOOGLE_REDIRECT_URI) {
    warnings.push('PUBLIC_BASE_URL or GOOGLE_REDIRECT_URI is not set. Google OAuth redirect URL may be computed incorrectly when behind a proxy.');
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    warnings.push('GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET are not set. Google Drive connection cannot be established until these values are saved in Admin settings.');
  }

  if (!isFirebaseEnabled()) {
    const message = 'Firebase environment variables are not fully configured. Firestore metadata storage and uploads will fail without FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.';
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      required.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (process.env.VERCEL && !isFirebaseEnabled()) {
    warnings.push('Running on Vercel without Firebase means settings and uploaded metadata may not persist across serverless cold starts. Configure Firebase to persist state.');
  }

  if (isFirebaseEnabled() && !process.env.FIREBASE_STORAGE_BUCKET) {
    warnings.push('FIREBASE_STORAGE_BUCKET is not set. Firebase Storage file metadata and some features may not work correctly.');
  }

  if (required.length > 0) {
    console.error('[ENV VALIDATION] Required environment variables missing:');
    required.forEach(msg => console.error(` - ${msg}`));
  }
  if (warnings.length > 0) {
    console.warn('[ENV VALIDATION] Environment warnings:');
    warnings.forEach(msg => console.warn(` - ${msg}`));
  }
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

async function verifyConnectedDriveScopes(settings, req) {
  if (!settings.googleRefreshToken) {
    settings.googleHasDriveScope = false;
    return settings;
  }

  try {
    const oauth2Client = await createGoogleOAuthClient(req);
    if (!oauth2Client) return settings;
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();
    const tokenInfo = await oauth2Client.getTokenInfo(credentials.access_token);
    const scopes = tokenInfo.scopes || [];
    const hasDriveScope = scopes.includes('https://www.googleapis.com/auth/drive.file');

    if (settings.googleHasDriveScope !== hasDriveScope) {
      settings.googleHasDriveScope = hasDriveScope;
      await writeSettings(settings);
    }
  } catch (err) {
    console.error('[Google OAuth] Failed to verify token/scopes:', err.message);
    settings.googleHasDriveScope = false;
  }
  return settings;
}

function getStorageMode(settings) {
  const firebase = isFirebaseEnabled();
  const drive = !!settings.googleRefreshToken;
  if (firebase && drive) return 'firebase+drive';
  if (drive) return 'drive';
  if (firebase) return 'firebase';
  return 'local';
}

const DEFAULT_GOOGLE_DRIVE_FOLDER_NAME = 'FaceMatch_Photos';
let cachedGoogleFolderId = '';

function getGoogleDriveFileUrl(fileId) {
  return fileId ? `https://drive.google.com/uc?export=view&id=${fileId}` : '';
}

function getGoogleDriveFileRoute(fileId) {
  return fileId ? `/api/drive/photo/${fileId}` : '';
}

function getConfiguredGoogleDriveFolderId() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  return folderId ? folderId.trim() : '';
}

async function uploadToGoogleDrive(fileBuffer, originalName, mimeType, req) {
  const settings = await readSettings();
  if (!settings.googleRefreshToken) {
    throw new Error('Google Drive is not connected. Connect your Google account in Admin settings first.');
  }

  const oauth2Client = await createGoogleOAuthClient(req);
  if (!oauth2Client) {
    throw new Error('Google OAuth Client ID and Secret are not configured.');
  }
  oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  let folderId = getConfiguredGoogleDriveFolderId() || cachedGoogleFolderId || '';
  if (!folderId) {
    try {
      const listRes = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${DEFAULT_GOOGLE_DRIVE_FOLDER_NAME}' and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive'
      });
      if (listRes.data.files.length > 0) {
        folderId = listRes.data.files[0].id;
      } else {
        const createFolder = await drive.files.create({
          resource: {
            name: DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder'
          },
          fields: 'id'
        });
        folderId = createFolder.data.id;
      }
      if (folderId) cachedGoogleFolderId = folderId;
    } catch (err) {
      console.error('Google Drive folder error:', err.message);
      throw new Error('Unable to prepare the Google Drive folder. Check Drive permissions and folder configuration.');
    }
  }

  const stream = require('stream');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(fileBuffer);

  let response;
  try {
    response = await drive.files.create({
      requestBody: {
        name: originalName,
        parents: folderId ? [folderId] : []
      },
      media: { mimeType, body: bufferStream },
      fields: 'id, webViewLink, webContentLink'
    });
  } catch (createErr) {
    console.error('[Google Drive] files.create error:', createErr && createErr.message ? createErr.message : createErr);
    throw new Error('Google Drive upload failed: ' + (createErr && createErr.message ? createErr.message : String(createErr)));
  }

  const fileId = response && response.data ? response.data.id : null;
  if (!fileId) {
    console.error('[Google Drive] Unexpected create response:', response && response.data ? response.data : response);
    throw new Error('Google Drive upload completed but no file ID was returned.');
  }

  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
  } catch (permErr) {
    console.warn('Google Drive permission create failed:', permErr && permErr.message ? permErr.message : permErr);
  }

  const imageUrl = getGoogleDriveFileUrl(fileId);
  const webView = response.data.webViewLink || '';
  console.log(`[Google Drive] Created file: id=${fileId} webView=${webView} contentLink=${response.data.webContentLink || ''}`);

  return {
    fileId,
    imageUrl
  };
}

async function deleteFromGoogleDrive(fileId, req) {
  const settings = await readSettings();
  if (!settings.googleRefreshToken) return;
  try {
    const oauth2Client = await createGoogleOAuthClient(req);
    if (!oauth2Client) return;
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    await drive.files.delete({ fileId });
    console.log(`[Google Drive] Deleted file ID: ${fileId}`);
  } catch (err) {
    console.error(`[Google Drive] Failed to delete file ID ${fileId}:`, err.message);
  }
}

async function deletePhotoAssets(photo, req) {
  if (!photo || !photo.filename) return;

  if (photo.filename.startsWith('firebase:')) {
    await deleteFromFirebaseStorage(photo.filename.slice('firebase:'.length));
  } else if (photo.filename.startsWith('drive:')) {
    await deleteFromGoogleDrive(photo.filename.split(':')[1], req);
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

async function listGoogleDriveGalleryFiles(req) {
  const settings = await readSettings();
  if (!settings.googleRefreshToken) return [];
  const oauth2Client = await createGoogleOAuthClient(req);
  oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  let folderId = getConfiguredGoogleDriveFolderId() || cachedGoogleFolderId || '';
  if (!folderId) {
    const listRes = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${DEFAULT_GOOGLE_DRIVE_FOLDER_NAME}' and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive'
    });
    if (listRes.data.files.length > 0) {
      folderId = listRes.data.files[0].id;
      cachedGoogleFolderId = folderId;
    } else {
      return [];
    }
  }

  const files = [];
  let pageToken = null;
  do {
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType contains 'image/'`,
      fields: 'nextPageToken, files(id, name, createdTime, modifiedTime, mimeType, webContentLink)',
      spaces: 'drive',
      pageSize: 200,
      pageToken
    });
    const pageFiles = listRes.data.files || [];
    pageFiles.forEach(file => {
      files.push({
        id: `drive:${file.id}`,
        fileId: file.id,
        filename: `drive:${file.id}`,
        imageUrl: getGoogleDriveFileUrl(file.id),
        storageUrl: getGoogleDriveFileRoute(file.id),
        originalName: file.name,
        uploadTime: file.createdTime || file.modifiedTime || new Date().toISOString(),
        timestamp: file.createdTime || file.modifiedTime || new Date().toISOString(),
        descriptors: [],
        status: 'approved',
        isPublic: true
      });
    });
    pageToken = listRes.data.nextPageToken;
  } while (pageToken);

  return files.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

let lastSyncTime = 0;
let isSyncing = false;

async function syncGoogleDrivePhotos(req = null, forceAll = false) {
  if (isSyncing) {
    console.log('[GDrive Sync] Sync is already in progress. Skipping.');
    if (forceAll) {
      throw new Error('Sync is already in progress. Please wait.');
    }
    return { success: false, error: 'Sync already in progress', count: 0 };
  }
  isSyncing = true;
  let syncedCount = 0;
  try {
    const settings = await readSettings();
    if (!settings.googleRefreshToken) {
      return { success: false, error: 'Google Drive not connected', count: 0 };
    }

    const oauth2Client = await createGoogleOAuthClient(req);
    if (!oauth2Client) {
      console.warn('[GDrive Sync] Google OAuth client could not be created.');
      return;
    }

    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Get or create the folder
    let folderId = getConfiguredGoogleDriveFolderId() || cachedGoogleFolderId || '';
    if (!folderId) {
      try {
        const listRes = await drive.files.list({
          q: `mimeType='application/vnd.google-apps.folder' and name='${DEFAULT_GOOGLE_DRIVE_FOLDER_NAME}' and trashed=false`,
          fields: 'files(id)',
          spaces: 'drive'
        });
        if (listRes.data.files.length > 0) {
          folderId = listRes.data.files[0].id;
          cachedGoogleFolderId = folderId;
        } else {
          const createFolder = await drive.files.create({
            resource: {
              name: DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
              mimeType: 'application/vnd.google-apps.folder'
            },
            fields: 'id'
          });
          folderId = createFolder.data.id;
          cachedGoogleFolderId = folderId;
          console.log(`[GDrive Sync] Created Google Drive folder '${DEFAULT_GOOGLE_DRIVE_FOLDER_NAME}' with ID ${folderId}`);
        }
      } catch (err) {
        console.error('[GDrive Sync] Error finding/creating folder:', err.message);
        return;
      }
    }

    // Get existing processed files
    let existingPhotos;
    try {
      existingPhotos = await readGalleryDb();
    } catch (err) {
      console.error('[GDrive Sync] Error reading gallery DB:', err.message);
      return;
    }

    const processedFileIds = new Set(
      existingPhotos
        .filter(p => p.fileId || (p.filename && p.filename.startsWith('drive:')))
        .map(p => p.fileId || p.filename.slice('drive:'.length))
    );

    // List images in the Google Drive folder
    const driveFiles = [];
    try {
      let pageToken = null;
      do {
        const listRes = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false and mimeType contains 'image/'`,
          fields: 'nextPageToken, files(id, name, createdTime, modifiedTime, mimeType, size)',
          spaces: 'drive',
          pageSize: 100,
          pageToken
        });
        const pageFiles = listRes.data.files || [];
        driveFiles.push(...pageFiles);
        pageToken = listRes.data.nextPageToken;
      } while (pageToken);
    } catch (err) {
      console.error('[GDrive Sync] Error listing files from Google Drive:', err.message);
      return;
    }

    // Filter out already processed files
    const unprocessedFiles = driveFiles.filter(file => !processedFileIds.has(file.id));
    if (unprocessedFiles.length === 0) {
      return { success: true, count: 0 };
    }

    console.log(`[GDrive Sync] Found ${unprocessedFiles.length} unprocessed image file(s) in Google Drive folder.`);

    // Limit processing to 5 files per run to avoid timeouts or CPU hogging, unless forced
    const limit = forceAll ? unprocessedFiles.length : 5;
    const filesToProcess = unprocessedFiles.slice(0, limit);

    for (const file of filesToProcess) {
      console.log(`[GDrive Sync] Processing file: ${file.name} (${file.id})`);
      let tempPath = null;
      try {
        // 1. Download file from Google Drive into memory
        const response = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const buffer = Buffer.from(response.data);

        // 2. Save file temporarily in scratch directory
        const ext = path.extname(file.name).toLowerCase() || '.jpg';
        const tempDir = path.join(__dirname, 'scratch');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        tempPath = path.join(tempDir, `gdrive_sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`);
        fs.writeFileSync(tempPath, buffer);

        // 3. Run python face detection
        console.log(`[GDrive Sync] Running face detection for ${file.name}...`);
        let descriptors = [];
        let faceDetectionStatus = 'No Face Detected';
        let faceDetected = false;

        try {
          const detectResult = await runPythonFaceDetector(tempPath);
          if (detectResult && detectResult.success && Array.isArray(detectResult.faces)) {
            descriptors = detectResult.faces;
            if (descriptors.length > 0) {
              faceDetectionStatus = 'Face Detected';
              faceDetected = true;
            }
            console.log(`[GDrive Sync] Face detection found ${descriptors.length} face(s) for ${file.name}`);
          } else {
            console.warn(`[GDrive Sync] Face detection returned no faces or error:`, detectResult ? detectResult.error : 'no response');
          }
        } catch (detectErr) {
          console.error(`[GDrive Sync] Face detection failed for ${file.name}:`, detectErr.message);
          faceDetectionStatus = 'Failed to process';
          faceDetected = false;
        }

        // 4. Save metadata to Firestore / Local gallery DB
        const photoId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const uploadTime = file.createdTime || file.modifiedTime || new Date().toISOString();
        const fileSize = parseInt(file.size, 10) || buffer.length || 0;
        const mimeType = file.mimeType || 'image/jpeg';
        const filename = `drive:${file.id}`;
        const imageUrl = getGoogleDriveFileUrl(file.id);
        const storageUrl = getGoogleDriveFileRoute(file.id);

        const newPhoto = {
          id: photoId,
          fileId: file.id,
          filename,
          imageUrl,
          storageUrl,
          originalName: file.name,
          originalFileName: file.name,
          fileSize,
          mimeType,
          uploadedBy: 'gdrive_sync',
          uploadTime,
          timestamp: uploadTime,
          descriptors,
          status: 'pending',
          isPublic: false,
          faceDetectionStatus,
          faceDetected
        };

        await addPhoto(newPhoto);
        syncedCount++;
        console.log(`[GDrive Sync] Successfully registered ${file.name} in database. Detected: ${faceDetected}.`);

        // 5. Try making file readable by anyone on Google Drive so direct web URLs work
        try {
          await drive.permissions.create({
            fileId: file.id,
            requestBody: {
              role: 'reader',
              type: 'anyone'
            }
          });
        } catch (permErr) {
          console.warn(`[GDrive Sync] Google Drive permission create failed for file ID ${file.id}:`, permErr && permErr.message ? permErr.message : permErr);
        }

      } catch (err) {
        console.error(`[GDrive Sync] Error processing file ID ${file.id} (${file.name}):`, err.message);
      } finally {
        // 6. Delete temporary image data after processing
        if (tempPath && fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
            console.log(`[GDrive Sync] Deleted temporary image file: ${tempPath}`);
          } catch (unlinkErr) {
            console.error(`[GDrive Sync] Failed to delete temporary file ${tempPath}:`, unlinkErr.message);
          }
        }
      }
    }
    return { success: true, count: syncedCount };
  } catch (syncErr) {
    console.error('[GDrive Sync] Fatal sync error:', syncErr.message);
    if (forceAll) throw syncErr;
    return { success: false, error: syncErr.message, count: syncedCount };
  } finally {
    isSyncing = false;
  }
}

async function triggerSyncIfNeeded(req) {
  const now = Date.now();
  const settings = await readSettings();
  if (!settings.googleRefreshToken) return;

  if (isSyncing || (now - lastSyncTime < 60000)) {
    return;
  }

  syncGoogleDrivePhotos(req)
    .then(() => {
      lastSyncTime = Date.now();
    })
    .catch(err => {
      console.error('[GDrive Sync] Error during request-triggered sync:', err);
    });
}

let lastLocalSyncTime = 0;
let isLocalSyncing = false;

async function syncLocalUploadsIfNeeded() {
  const now = Date.now();
  // Throttle syncs to once every 10 seconds to avoid too frequent disk scans
  if (isLocalSyncing || (now - lastLocalSyncTime < 10000)) {
    return;
  }

  isLocalSyncing = true;
  try {
    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      return;
    }

    const files = fs.readdirSync(uploadsDir);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return imageExtensions.includes(ext);
    });

    if (imageFiles.length === 0) {
      return;
    }

    const gallery = await readGalleryDb();
    const existingFilenames = new Set(gallery.map(p => p.filename));

    for (const file of imageFiles) {
      // Check if already in database (using name match)
      if (existingFilenames.has(file)) {
        continue;
      }

      const filePath = path.join(uploadsDir, file);
      console.log(`[Local Sync] Found new manual photo: ${file}. Running face detection...`);

      try {
        let descriptors = [];
        let faceDetectionStatus = 'No Face Detected';
        let faceDetected = false;

        try {
          const detectResult = await runPythonFaceDetector(filePath);
          if (detectResult && detectResult.success && Array.isArray(detectResult.faces)) {
            descriptors = detectResult.faces;
            if (descriptors.length > 0) {
              faceDetectionStatus = 'Face Detected';
              faceDetected = true;
            }
          }
        } catch (detectErr) {
          console.error(`[Local Sync] Face detection failed for ${file}:`, detectErr.message);
        }

        const photoId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const stats = fs.statSync(filePath);

        // Map file extension to MIME type
        const ext = path.extname(file).toLowerCase();
        let mimeType = 'image/jpeg';
        if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.webp') mimeType = 'image/webp';

        const photoRecord = {
          id: photoId,
          filename: file,
          originalName: file,
          uploadedBy: 'manual_copy',
          uploadTime: new Date(stats.mtime || Date.now()).toISOString(),
          fileSize: stats.size || 0,
          mimeType,
          storageUrl: `/uploads/${file}`,
          imageUrl: `/uploads/${file}`,
          faceDetectionStatus,
          faceDetected,
          descriptors: descriptors.map(f => f.descriptor),
          status: 'pending',
          isPublic: false
        };

        await addPhoto(photoRecord);
        console.log(`[Local Sync] Registered manual photo ${file} with ${descriptors.length} face(s).`);
      } catch (err) {
        console.error(`[Local Sync] Failed to register manual photo ${file}:`, err.message);
      }
    }

    lastLocalSyncTime = Date.now();
  } catch (err) {
    console.error('[Local Sync] Error scanning uploads directory:', err.message);
  } finally {
    isLocalSyncing = false;
  }
}

app.get('/api/gallery', async (req, res) => {
  try {
    triggerSyncIfNeeded(req).catch(err => console.error('[GDrive Sync] Trigger error:', err));
    syncLocalUploadsIfNeeded().catch(err => console.error('[Local Sync] Trigger error:', err));
    const settings = await readSettings();
    const galleryHeading = settings.publicGalleryHeading || 'Gallery Catalog';
    const events = await readEventsDb();
    const isAdmin = await isValidAdminSession(req);
    const configuredDefaultEventId = settings.defaultPublicEventId || 'all';

    let allEvt = events.find(e => e.id === 'all');
    if (!allEvt) {
      allEvt = {
        id: 'all',
        title: 'All Photos / All Events',
        name: 'All Photos / All Events',
        description: 'Combined catalog containing all event photos',
        date: 'Always Active',
        status: 'active',
        passcode: settings.allEventsPasscode || '',
        allowDownload: settings.allEventsAllowDownload !== false,
        disableRightClick: !!settings.allEventsDisableRightClick,
        announcementMessage: settings.galleryMessage || '',
        isSystemEvent: true
      };
    } else {
      allEvt = { ...allEvt, isSystemEvent: true };
    }

    let availableEvents = [];
    const customPublicEvents = events.filter(e => e.id !== 'all' && e.showInPublicGallery !== false && e.status === 'active');
    
    if (isAdmin) {
      availableEvents = [allEvt, ...events.filter(e => e.id !== 'all')];
    } else {
      // Public visitors never see 'All Photos / All Events' as a selectable option in dropdown
      availableEvents = customPublicEvents;
    }

    let defaultPublicEventId = configuredDefaultEventId;
    if (!isAdmin) {
      if (defaultPublicEventId !== 'all' && !availableEvents.some(e => e.id === defaultPublicEventId)) {
        defaultPublicEventId = availableEvents[0]?.id || '';
      }
    }

    if (!settings.publicGalleryEnabled) {
      return res.json({
        success: true,
        photos: [],
        events: availableEvents.map(e => { const { passcode, ...rest } = e; return rest; }),
        publicGalleryEnabled: false,
        galleryHeading,
        defaultPublicEventId,
        logoWidth: settings.logoWidth,
        storageMode: getStorageMode(settings),
        galleryMessage: settings.galleryMessage || ''
      });
    }

    const publicEventIds = new Set(customPublicEvents.map(e => e.id));
    const gallery = await readGalleryDb();
    let publicPhotos = gallery.filter(photo => {
      const status = photo.status === undefined ? 'approved' : photo.status;
      const isPublic = photo.isPublic === undefined ? true : photo.isPublic;
      if (isAdmin) {
        return status === 'approved';
      }
      const photoEvtId = photo.eventId || '';
      if (!photoEvtId || photoEvtId === 'all') {
        return status === 'approved' && isPublic === true;
      }
      return status === 'approved' && isPublic === true && (publicEventIds.has(photoEvtId) || configuredDefaultEventId === 'all');
    });

    const publicEvents = availableEvents.map(evt => {
      const item = {
        ...evt,
        hasPasscode: !!(evt.passcode && evt.passcode.trim())
      };
      if (!isAdmin) delete item.passcode;
      return item;
    });

    let requestedEventId = req.query.eventId;
    if (!isAdmin) {
      if (!requestedEventId) {
        requestedEventId = defaultPublicEventId;
      }
    } else {
      requestedEventId = requestedEventId || 'all';
    }

    const targetEvent = (requestedEventId === 'all' ? allEvt : availableEvents.find(e => e.id === requestedEventId)) || (isAdmin ? allEvt : availableEvents[0] || allEvt);

    if (targetEvent && targetEvent.passcode && targetEvent.passcode.trim() && !isAdmin) {
      const providedPasscode = (req.headers['x-event-passcode'] || req.query.passcode || '').trim();
      if (providedPasscode !== targetEvent.passcode.trim()) {
        return res.json({
          success: true,
          photos: [],
          events: publicEvents,
          publicGalleryEnabled: true,
          passcodeRequired: true,
          eventId: requestedEventId,
          error: 'Passcode required to view this private event.'
        });
      }
    }

    if (requestedEventId && requestedEventId !== 'all') {
      publicPhotos = publicPhotos.filter(photo => photo.eventId === requestedEventId);
    }

    publicPhotos.sort((a, b) => new Date(b.timestamp || b.uploadTime || 0) - new Date(a.timestamp || a.uploadTime || 0));

    res.json({
      success: true,
      photos: publicPhotos,
      events: publicEvents,
      publicGalleryEnabled: true,
      galleryHeading,
      defaultPublicEventId,
      allowPublicFaceAdjustment: settings.allowPublicFaceAdjustment !== false,
      logoWidth: settings.logoWidth,
      storageMode: getStorageMode(settings),
      galleryMessage: (targetEvent && targetEvent.announcementMessage) || settings.galleryMessage || ''
    });
  } catch (err) {
    console.error('Gallery endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Events Endpoints ----------

app.get('/api/events', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    const events = await readEventsDb();
    const gallery = await readGalleryDb();
    const settings = await readSettings();

    let allEvt = events.find(e => e.id === 'all');
    if (!allEvt) {
      allEvt = {
        id: 'all',
        title: 'All Photos / All Events',
        name: 'All Photos / All Events',
        description: 'Combined catalog containing all event photos',
        date: 'Always Active',
        status: 'active',
        passcode: settings.allEventsPasscode || '',
        allowDownload: settings.allEventsAllowDownload !== false,
        disableRightClick: !!settings.allEventsDisableRightClick,
        announcementMessage: settings.galleryMessage || '',
        isSystemEvent: true
      };
    } else {
      allEvt = { ...allEvt, isSystemEvent: true };
    }

    const photoCounts = {};
    gallery.forEach(p => {
      if (p.eventId) {
        photoCounts[p.eventId] = (photoCounts[p.eventId] || 0) + 1;
      }
    });

    const userEvents = isAdmin
      ? events.filter(e => e.id !== 'all')
      : events.filter(e => e.id !== 'all' && e.showInPublicGallery !== false && e.status === 'active');

    const eventsWithCount = userEvents.map(evt => {
      const item = {
        ...evt,
        photoCount: photoCounts[evt.id] || 0,
        hasPasscode: !!(evt.passcode && evt.passcode.trim())
      };
      if (!isAdmin) {
        delete item.passcode;
      }
      return item;
    });

    if (!isAdmin) {
      // Public visitors never see 'all' system event listed in events list
      return res.json({ success: true, events: eventsWithCount });
    }

    const allItem = {
      ...allEvt,
      photoCount: gallery.length,
      hasPasscode: !!(allEvt.passcode && allEvt.passcode.trim())
    };

    res.json({ success: true, events: [allItem, ...eventsWithCount] });
  } catch (err) {
    console.error('Fetch events error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Unauthorized access.' });
    }
    const { title, name, description, date, coverUrl, status, passcode, allowDownload, disableRightClick, announcementMessage, showInPublicGallery } = req.body;
    const eventName = (name || title || '').trim();
    if (!eventName) {
      return res.status(400).json({ success: false, error: 'Event name is required.' });
    }
    const eventId = 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const newEvent = {
      id: eventId,
      title: eventName,
      name: eventName,
      description: description || '',
      date: date || new Date().toISOString().split('T')[0],
      coverUrl: coverUrl || '',
      status: status || 'active',
      passcode: (passcode || '').trim(),
      allowDownload: allowDownload !== undefined ? !!allowDownload : true,
      disableRightClick: disableRightClick !== undefined ? !!disableRightClick : false,
      showInPublicGallery: showInPublicGallery !== undefined ? !!showInPublicGallery : true,
      announcementMessage: announcementMessage !== undefined ? announcementMessage.trim() : '',
      createdAt: new Date().toISOString()
    };
    await addEvent(newEvent);
    console.log(`[Events] Created new event: ${eventName} (${eventId})`);
    res.json({ success: true, event: newEvent });
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Unauthorized access.' });
    }
    const { id } = req.params;
    const { title, name, description, date, coverUrl, status, passcode, allowDownload, disableRightClick, announcementMessage, showInPublicGallery } = req.body;
    const patch = {};
    if (title !== undefined || name !== undefined) {
      const eventName = (name || title || '').trim();
      if (eventName) {
        patch.title = eventName;
        patch.name = eventName;
      }
    }
    if (description !== undefined) patch.description = description;
    if (date !== undefined) patch.date = date;
    if (coverUrl !== undefined) patch.coverUrl = coverUrl;
    if (status !== undefined) patch.status = status;
    if (passcode !== undefined) patch.passcode = (passcode || '').trim();
    if (allowDownload !== undefined) patch.allowDownload = !!allowDownload;
    if (disableRightClick !== undefined) patch.disableRightClick = !!disableRightClick;
    if (showInPublicGallery !== undefined) patch.showInPublicGallery = !!showInPublicGallery;
    if (announcementMessage !== undefined) patch.announcementMessage = announcementMessage.trim();

    let updated = await updateEvent(id, patch);
    if (!updated && id === 'all') {
      const newAllEvt = {
        id: 'all',
        title: patch.title || 'All Photos / All Events',
        name: patch.name || 'All Photos / All Events',
        description: patch.description || 'Combined catalog containing all event photos',
        date: patch.date || 'Always Active',
        status: patch.status || 'active',
        passcode: patch.passcode || '',
        allowDownload: patch.allowDownload !== undefined ? patch.allowDownload : true,
        disableRightClick: patch.disableRightClick !== undefined ? patch.disableRightClick : false,
        showInPublicGallery: patch.showInPublicGallery !== undefined ? patch.showInPublicGallery : true,
        announcementMessage: patch.announcementMessage || '',
        isSystemEvent: true,
        createdAt: new Date().toISOString()
      };
      updated = await addEvent(newAllEvt);
    }

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }

    if (id === 'all') {
      const settings = await readSettings();
      settings.allEventsPasscode = updated.passcode;
      settings.allEventsAllowDownload = updated.allowDownload;
      settings.allEventsDisableRightClick = updated.disableRightClick;
      settings.galleryMessage = updated.announcementMessage;
      if (updated.showInPublicGallery !== undefined) {
        settings.showAllEventsInPublicGallery = updated.showInPublicGallery !== false;
      }
      await writeSettings(settings);
    }

    console.log(`[Events] Updated event: ${id}`);
    res.json({ success: true, event: updated });
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Unauthorized access.' });
    }
    const { id } = req.params;
    if (id === 'all') {
      return res.status(400).json({ success: false, error: 'The All Photos system event cannot be deleted.' });
    }
    const deleted = await deleteEvent(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }
    console.log(`[Events] Deleted event: ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/events/:id/verify-passcode', async (req, res) => {
  try {
    const { id } = req.params;
    const { passcode } = req.body;
    const settings = await readSettings();
    let event = await getEventById(id);
    if (!event && id === 'all') {
      event = {
        id: 'all',
        passcode: settings.allEventsPasscode || ''
      };
    }
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }
    const expectedPasscode = (event.passcode || (id === 'all' ? settings.allEventsPasscode : '') || '').trim();
    if (!expectedPasscode) {
      return res.json({ success: true, verified: true });
    }
    const enteredPasscode = (passcode || '').trim();
    if (enteredPasscode === expectedPasscode) {
      return res.json({ success: true, verified: true });
    }
    return res.status(403).json({ success: false, verified: false, error: 'Incorrect event passcode.' });
  } catch (err) {
    console.error('Verify event passcode error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/photos/assign-event', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Unauthorized access.' });
    }
    const { photoIds, eventId } = req.body;
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ success: false, error: 'photoIds array is required.' });
    }
    for (const id of photoIds) {
      await updatePhoto(id, { eventId: eventId || '' });
    }
    console.log(`[Admin] Assigned ${photoIds.length} photo(s) to event: '${eventId || 'General'}'`);
    res.json({ success: true, count: photoIds.length });
  } catch (err) {
    console.error('Assign event error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

let uploadProcessingQueue = Promise.resolve();

let workingPythonCmd = null;

function runPythonFaceDetector(filePath) {
  const defaultCmds = [
    'python',
    'python3',
    'py',
    'C:\\Users\\SOURAV SENAPATI\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  ];
  const cmds = workingPythonCmd
    ? [workingPythonCmd, ...defaultCmds.filter(c => c !== workingPythonCmd)]
    : defaultCmds;
  
  const tryPythonCommand = (index) => {
    if (index >= cmds.length) {
      return Promise.resolve({ success: false, faces: [], error: 'Python interpreter not available on host system.' });
    }

    return new Promise((resolve) => {
      const cmd = cmds[index];
      const scriptPath = path.join(__dirname, 'detect_faces.py');

      execFile(cmd, [scriptPath, filePath], { timeout: 35000 }, (error, stdout, stderr) => {
        if (error) {
          console.warn(`[Python Face Detector] Error executing '${cmd}':`, error.message);
          return tryPythonCommand(index + 1).then(resolve);
        }
        try {
          const result = JSON.parse(stdout);
          if (result && result.success !== undefined) {
            return resolve(result);
          }
          tryPythonCommand(index + 1).then(resolve);
        } catch (parseErr) {
          console.warn(`[Python Face Detector] Failed to parse stdout from '${cmd}':`, stdout);
          tryPythonCommand(index + 1).then(resolve);
        }
      });
    });
  };

  return tryPythonCommand(0);
}

function runPythonSingleFaceDescriptor(filePath, box) {
  const defaultCmds = [
    'python',
    'python3',
    'py',
    'C:\\Users\\SOURAV SENAPATI\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  ];
  const cmds = workingPythonCmd
    ? [workingPythonCmd, ...defaultCmds.filter(c => c !== workingPythonCmd)]
    : defaultCmds;

  const tryPythonCommand = (index) => {
    if (index >= cmds.length) {
      return Promise.resolve({ success: false, error: 'Python interpreter not available on host system.' });
    }

    return new Promise((resolve) => {
      const cmd = cmds[index];
      const scriptPath = path.join(__dirname, 'compute_single_descriptor.py');
      const boxJson = JSON.stringify(box);

      execFile(cmd, [scriptPath, filePath, boxJson], { timeout: 35000 }, (error, stdout, stderr) => {
        if (error) {
          console.warn(`[Python Single Face Descriptor] Error executing '${cmd}':`, error.message);
          return tryPythonCommand(index + 1).then(resolve);
        }
        try {
          const result = JSON.parse(stdout);
          if (result && result.success !== undefined) {
            return resolve(result);
          }
          tryPythonCommand(index + 1).then(resolve);
        } catch (parseErr) {
          console.warn(`[Python Single Face Descriptor] Failed to parse stdout from '${cmd}':`, stdout);
          tryPythonCommand(index + 1).then(resolve);
        }
      });
    });
  };

  return tryPythonCommand(0);
}

async function getPhotoFileBuffer(photo, req) {
  let fileId = photo.fileId;
  if (!fileId && photo.filename && photo.filename.startsWith('drive:')) {
    fileId = photo.filename.slice('drive:'.length);
  }

  if (fileId) {
    const settings = await readSettings();
    if (!settings.googleRefreshToken) {
      throw new Error('Google Drive is not connected');
    }
    const oauth2Client = await createGoogleOAuthClient(req);
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(response.data);
  }

  if (photo.filename && photo.filename.startsWith('firebase:')) {
    const storagePath = photo.filename.slice('firebase:'.length);
    const { stream } = await getFirebaseFileStream(storagePath);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const filename = photo.filename || (photo.storageUrl ? path.basename(photo.storageUrl) : null);
  if (filename) {
    const localPath = path.join(__dirname, 'public', 'uploads', filename);
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath);
    }
  }

  throw new Error(`Could not find image source file for photo ${photo.id}`);
}

app.post('/api/admin/photos/:id/manual-face', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Unauthorized access.' });
    }

    const { id } = req.params;
    const { faceIndex, box, clientDescriptor } = req.body;

    if (!box || typeof box.x !== 'number' || typeof box.y !== 'number' || typeof box.width !== 'number' || typeof box.height !== 'number') {
      return res.status(400).json({ success: false, error: 'Valid box object with x, y, width, height is required.' });
    }

    const targetBox = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height)
    };

    const photo = await getPhotoById(id);
    if (!photo) {
      return res.status(404).json({ success: false, error: 'Photo not found.' });
    }

    let descriptor = null;
    let tempPath = null;

    try {
      const buffer = await getPhotoFileBuffer(photo, req);
      const ext = (photo.mimeType && photo.mimeType.includes('png')) ? '.png' : '.jpg';
      const tempDir = path.join(__dirname, 'scratch');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempPath = path.join(tempDir, `manual_face_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`);
      fs.writeFileSync(tempPath, buffer);

      const pyResult = await runPythonSingleFaceDescriptor(tempPath, targetBox);
      if (pyResult && pyResult.success && Array.isArray(pyResult.descriptor) && pyResult.descriptor.length === 128) {
        descriptor = pyResult.descriptor;
      } else {
        console.warn(`[Manual Face] Python descriptor extraction failed/unavailable:`, pyResult ? pyResult.error : 'no result');
      }
    } catch (fileErr) {
      console.warn(`[Manual Face] Could not retrieve original image file:`, fileErr.message);
    } finally {
      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
    }

    // Fallback to clientDescriptor if python failed/unavailable
    if (!descriptor && Array.isArray(clientDescriptor) && clientDescriptor.length === 128) {
      descriptor = clientDescriptor;
      console.log(`[Manual Face] Using client-provided face descriptor fallback for photo ${id}.`);
    }

    if (!descriptor) {
      return res.status(422).json({
        success: false,
        error: 'Could not generate face descriptor for the selected box. Ensure the box covers a clear face.'
      });
    }

    // Update photo descriptors array
    let currentDescriptors = Array.isArray(photo.descriptors) ? [...photo.descriptors] : [];
    
    currentDescriptors = currentDescriptors.map(item => {
      if (Array.isArray(item)) {
        return { descriptor: item, box: { x: 0, y: 0, width: 0, height: 0 } };
      }
      return item;
    });

    const targetIdx = parseInt(faceIndex, 10);
    const newFaceItem = {
      box: targetBox,
      descriptor
    };

    if (targetIdx >= 0 && targetIdx < currentDescriptors.length) {
      currentDescriptors[targetIdx] = newFaceItem;
      console.log(`[Manual Face] Corrected face #${targetIdx} on photo ${id}`);
    } else {
      currentDescriptors.push(newFaceItem);
      console.log(`[Manual Face] Added new face descriptor on photo ${id} (total: ${currentDescriptors.length})`);
    }

    const faceDetected = currentDescriptors.length > 0;
    const faceDetectionStatus = faceDetected ? 'Face Detected' : 'No Face Detected';

    const patch = {
      descriptors: currentDescriptors,
      faceDetected,
      faceDetectionStatus,
      reviewed: true,
      reviewedAt: new Date().toISOString()
    };

    const updatedPhoto = await updatePhoto(id, patch);
    res.json({
      success: true,
      photo: updatedPhoto || { ...photo, ...patch },
      faceIndex: targetIdx >= 0 && targetIdx < currentDescriptors.length ? targetIdx : currentDescriptors.length - 1
    });

  } catch (err) {
    console.error('[Manual Face Endpoint Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/photos/:id/delete-face', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Unauthorized access.' });
    }

    const { id } = req.params;
    const { faceIndex } = req.body;

    const photo = await getPhotoById(id);
    if (!photo) {
      return res.status(404).json({ success: false, error: 'Photo not found.' });
    }

    let currentDescriptors = Array.isArray(photo.descriptors) ? [...photo.descriptors] : [];
    const targetIdx = parseInt(faceIndex, 10);

    if (isNaN(targetIdx) || targetIdx < 0 || targetIdx >= currentDescriptors.length) {
      return res.status(400).json({ success: false, error: 'Invalid face index specified for deletion.' });
    }

    currentDescriptors.splice(targetIdx, 1);

    const faceDetected = currentDescriptors.length > 0;
    const faceDetectionStatus = faceDetected ? 'Face Detected' : 'No Face Detected';

    const patch = {
      descriptors: currentDescriptors,
      faceDetected,
      faceDetectionStatus,
      reviewed: true,
      reviewedAt: new Date().toISOString()
    };

    const updatedPhoto = await updatePhoto(id, patch);
    console.log(`[Manual Face] Removed face #${targetIdx} from photo ${id} (remaining: ${currentDescriptors.length})`);
    res.json({
      success: true,
      photo: updatedPhoto || { ...photo, ...patch }
    });
  } catch (err) {
    console.error('[Delete Face Endpoint Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/photos/:id/toggle-review', async (req, res) => {
  try {
    const isAdmin = await isValidAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Unauthorized access.' });
    }
    const { id } = req.params;
    const photo = await getPhotoById(id);
    if (!photo) {
      return res.status(404).json({ success: false, error: 'Photo not found.' });
    }
    const newReviewed = !photo.reviewed;
    const patch = {
      reviewed: newReviewed,
      reviewedAt: newReviewed ? new Date().toISOString() : null
    };
    const updatedPhoto = await updatePhoto(id, patch);
    console.log(`[Photo Review] Toggled photo ${id} reviewed status to ${newReviewed}`);
    res.json({
      success: true,
      photo: updatedPhoto || { ...photo, ...patch }
    });
  } catch (err) {
    console.error('[Toggle Review Endpoint Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function verifyPythonSetup() {
  const cmds = [
    'python',
    'python3',
    'py',
    'C:\\Users\\SOURAV SENAPATI\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  ];
  const testScript = "import sys; import mediapipe; import PIL; import numpy; print('OK')";

  const tryCheck = (index) => {
    if (index >= cmds.length) {
      console.warn('\x1b[33m[Startup Warning] No working Python installation with mediapipe library was found.\x1b[0m');
      console.warn('\x1b[33mServer-side face detection fallback will NOT work. Please run "pip install -r requirements.txt".\x1b[0m');
      return;
    }
    const cmd = cmds[index];
    execFile(cmd, ['-c', testScript], (error, stdout, stderr) => {
      if (!error && stdout.trim().includes('OK')) {
        workingPythonCmd = cmd;
        console.log(`[Startup] Python setup verified successfully using '${cmd}' command.`);
      } else {
        tryCheck(index + 1);
      }
    });
  };

  tryCheck(0);
}

async function processUploadTask(req) {
  const settings = await readSettings();
  const isAdmin = await isValidAdminSession(req);
  const buffer = req.file.buffer;
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const photoId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  let descriptors = [];
  if (req.body.descriptors) {
    try {
      const parsed = typeof req.body.descriptors === 'string'
        ? JSON.parse(req.body.descriptors)
        : req.body.descriptors;
      if (Array.isArray(parsed)) {
        descriptors = parsed.filter(item => item && Array.isArray(item.descriptor) && item.descriptor.length === 128);
      }
    } catch (parseErr) {
      console.warn('Invalid descriptors payload on upload, storing empty face descriptors.');
      descriptors = [];
    }
  }

  if (descriptors.length > 15) {
    console.warn(`[Upload] Image ${req.file.originalname} had ${descriptors.length} face descriptors. Capping at 15.`);
    descriptors = descriptors.slice(0, 15);
  }

  const storageMode = getStorageMode(settings);
  if (storageMode.includes('drive') && !settings.googleRefreshToken) {
    throw new Error('Google Drive is not connected. Connect your Google account in Admin settings before uploading photos.');
  }

  if (!isFirebaseEnabled()) {
    console.warn('Firebase is not configured. Photo metadata will be stored locally when possible.');
  }

  const uploadedBy = isAdmin ? 'admin' : 'public';
  const uploadTime = new Date().toISOString();
  const fileSize = req.file.size || 0;
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const originalFileName = req.file.originalname;

  let faceDetectionError = null;

  // Run server-side face detection fallback if no descriptors provided
  if (!descriptors || descriptors.length === 0) {
    if (process.env.VERCEL) {
      console.log(`[Upload] Vercel Serverless Mode: No client face descriptors provided for ${originalFileName}. Saving photo with empty descriptors.`);
      faceDetectionError = 'No face detected during client upload';
    } else {
      console.log(`[Upload] Running server-side face detection fallback for ${originalFileName}...`);
      try {
        const tempDir = path.join(__dirname, 'scratch');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const tempPath = path.join(tempDir, `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`);
        fs.writeFileSync(tempPath, buffer);

        try {
          const detectResult = await runPythonFaceDetector(tempPath);
          if (fs.existsSync(tempPath)) {
            try {
              buffer = fs.readFileSync(tempPath);
            } catch (readErr) {
              console.warn('[Upload] Failed to reload rotated image buffer from tempPath:', readErr.message);
            }
          }
          if (detectResult && detectResult.success && Array.isArray(detectResult.faces)) {
            descriptors = detectResult.faces.slice(0, 15);
            console.log(`[Upload] Server-side detection found ${descriptors.length} face(s) in ${originalFileName}.`);
          } else {
            faceDetectionError = detectResult ? detectResult.error : 'No response from python detector';
            console.warn(`[Upload] Server-side detection returned no faces:`, faceDetectionError);
          }
        } catch (pyErr) {
          console.warn(`[Upload] Server-side python face detector unavailable:`, pyErr.message);
          faceDetectionError = 'Server-side Python face detector unavailable';
        } finally {
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
          }
        }
      } catch (detectErr) {
        console.error(`[Upload] Server-side face detection error:`, detectErr.message);
        faceDetectionError = detectErr.message;
      }
    }
  }

  let fileId;
  let filename;
  let storageUrl = '';
  let imageUrl = '';

  if (storageMode.includes('drive')) {
    console.log(`[Google Drive] Uploading ${originalFileName}...`);
    const driveUpload = await uploadToGoogleDrive(buffer, originalFileName, mimeType, req);
    fileId = driveUpload.fileId;
    filename = `drive:${fileId}`;
    storageUrl = getGoogleDriveFileRoute(fileId);
    imageUrl = driveUpload.imageUrl || getGoogleDriveFileUrl(fileId);
    console.log(`[Google Drive] Upload completed. File ID: ${fileId} URL: ${imageUrl}`);
  } else if (storageMode === 'firebase') {
    console.log(`[Firebase Storage] Uploading ${originalFileName}...`);
    const destPath = `photos/${photoId}${ext}`;
    const firebaseUpload = await uploadToFirebaseStorage(buffer, destPath, mimeType);
    fileId = photoId;
    filename = `firebase:${destPath}`;
    storageUrl = firebaseUpload.url;
    imageUrl = firebaseUpload.url;
    console.log(`[Firebase Storage] Upload completed. Path: ${destPath}`);
  } else {
    console.log(`[Local Storage] Saving ${originalFileName}...`);
    const destName = `${photoId}${ext}`;
    const destPath = path.join(__dirname, 'public', 'uploads', destName);
    const destDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.writeFileSync(destPath, buffer);
    fileId = photoId;
    filename = destName;
    storageUrl = `/uploads/${destName}`;
    imageUrl = `/uploads/${destName}`;
    console.log(`[Local Storage] Save completed: ${destName}`);
  }

  const newPhoto = {
    id: photoId,
    eventId: req.body.eventId || '',
    fileId,
    filename,
    imageUrl,
    storageUrl,
    originalName: originalFileName,
    originalFileName,
    fileSize,
    mimeType,
    uploadedBy,
    uploadTime,
    timestamp: uploadTime,
    descriptors,
    status: isAdmin ? (req.body.status || 'approved') : 'pending',
    isPublic: isAdmin ? (req.body.isPublic === 'false' || req.body.isPublic === false ? false : true) : false,
    faceDetectionStatus: descriptors.length > 0 
      ? 'Face Detected' 
      : (faceDetectionError ? `Face Detection Error: ${faceDetectionError}` : 'No Face Detected'),
    faceDetected: descriptors.length > 0
  };

  try {
    await addPhoto(newPhoto);
  } catch (dbErr) {
    // Roll back uploaded file if metadata save fails
    await deletePhotoAssets(newPhoto, req);
    throw new Error(`Failed to save photo metadata: ${dbErr.message}`);
  }
  console.log(`Uploaded: ${newPhoto.filename} with ${descriptors.length} face descriptors (Admin: ${isAdmin})`);
  return newPhoto;
}

app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    const queuedUpload = uploadProcessingQueue
      .catch((prevErr) => {
        console.warn('Recovered upload queue after previous failure:', prevErr && prevErr.message ? prevErr.message : prevErr);
      })
      .then(() => processUploadTask(req));

    uploadProcessingQueue = queuedUpload.catch((err) => {
      console.warn('Upload task failed:', err && err.message ? err.message : err);
    });

    const newPhoto = await queuedUpload;
    res.json({ success: true, photo: newPhoto });
  } catch (err) {
    console.error('Upload endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/detect-faces', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    const buffer = req.file.buffer;
    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const tempDir = path.join(__dirname, 'scratch');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempPath = path.join(tempDir, `detect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`);
    fs.writeFileSync(tempPath, buffer);

    try {
      const result = await runPythonFaceDetector(tempPath);
      res.json(result);
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  } catch (err) {
    console.error('Server-side face detection error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/compute-descriptor', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    let box = null;
    if (req.body.box) {
      try {
        box = typeof req.body.box === 'string' ? JSON.parse(req.body.box) : req.body.box;
      } catch (e) {
        box = null;
      }
    }

    if (!box || typeof box.x !== 'number' || typeof box.y !== 'number' || typeof box.width !== 'number' || typeof box.height !== 'number') {
      return res.status(400).json({ success: false, error: 'Valid box object with x, y, width, height is required.' });
    }

    const buffer = req.file.buffer;
    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const tempDir = path.join(__dirname, 'scratch');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempPath = path.join(tempDir, `compute_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`);
    fs.writeFileSync(tempPath, buffer);

    try {
      const pyResult = await runPythonSingleFaceDescriptor(tempPath, box);
      if (pyResult && pyResult.success) {
        res.json(pyResult);
      } else {
        res.status(422).json({
          success: false,
          error: pyResult ? pyResult.error : 'Could not compute face descriptor from selected region.'
        });
      }
    } finally {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
    }
  } catch (err) {
    console.error('Compute single face descriptor endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.post('/api/search', async (req, res) => {
  try {
    triggerSyncIfNeeded(req).catch(err => console.error('[GDrive Sync] Trigger error:', err));
    const limit = req.body.threshold !== undefined ? parseFloat(req.body.threshold) : 0.55;
    const queryDescriptors = Array.isArray(req.body.descriptors)
    ? req.body.descriptors
    : (req.body.descriptor && Array.isArray(req.body.descriptor) ? [req.body.descriptor] : []);

    if (!queryDescriptors || queryDescriptors.length === 0) {
      return res.status(400).json({ success: false, error: 'No face descriptor provided for search' });
    }

    const gallery = await readGalleryDb();
    const events = await readEventsDb();
    const matches = [];
    const isAdmin = await isValidAdminSession(req);
    
    const settings = await readSettings();
    let allEvt = events.find(e => e.id === 'all');
    const isAllPublic = !!allEvt ? (allEvt.showInPublicGallery === true && allEvt.status === 'active') : !!settings.showAllEventsInPublicGallery;
    const publicEventIds = new Set(events.filter(e => e.id !== 'all' && e.showInPublicGallery !== false).map(e => e.id));

    let approvedPhotos = gallery.filter(photo => {
      const status = photo.status === undefined ? 'approved' : photo.status;
      const isPublic = photo.isPublic === undefined ? true : photo.isPublic;
      if (isAdmin) {
        return status === 'approved';
      }
      const photoEvtId = photo.eventId || '';
      if (!photoEvtId || photoEvtId === 'all') {
        return status === 'approved' && isPublic === true && isAllPublic;
      }
      return status === 'approved' && isPublic === true && (publicEventIds.has(photoEvtId) || isAllPublic);
    });

    let eventId = req.body.eventId;
    if (!isAdmin && (eventId === 'all' || !eventId)) {
      if (allEvt && allEvt.passcode && allEvt.passcode.trim()) {
        const providedPasscode = (req.headers['x-event-passcode'] || req.body.eventPasscode || '').trim();
        if (providedPasscode !== allEvt.passcode.trim()) {
          return res.status(403).json({
            success: false,
            passcodeRequired: true,
            eventId: 'all',
            error: 'Passcode required to search within All Photos / All Events.'
          });
        }
      }
      if (!isAllPublic && eventId === 'all') {
        return res.json({ success: true, matches: [] });
      }
      eventId = undefined;
    }

    if (eventId && eventId !== 'all') {
      const targetEvent = events.find(e => e.id === eventId);
      if (!isAdmin && targetEvent && targetEvent.showInPublicGallery === false) {
        return res.json({ success: true, matches: [] });
      }
      if (targetEvent && targetEvent.passcode && targetEvent.passcode.trim() && !isAdmin) {
        const providedPasscode = (req.headers['x-event-passcode'] || req.body.eventPasscode || '').trim();
        if (providedPasscode !== targetEvent.passcode.trim()) {
          return res.status(403).json({
            success: false,
            passcodeRequired: true,
            eventId,
            error: 'Passcode required to search within this private event.'
          });
        }
      }
      approvedPhotos = approvedPhotos.filter(photo => photo.eventId === eventId);
    }

    approvedPhotos.forEach(photo => {
      if (!photo.descriptors || photo.descriptors.length === 0) return;

      let minDistance = 999;
      queryDescriptors.forEach(qData => {
        const queryDescriptor = Array.isArray(qData) ? qData : (qData && qData.descriptor);
        if (!queryDescriptor || !Array.isArray(queryDescriptor) || queryDescriptor.length === 0) return;
        photo.descriptors.forEach(faceData => {
          const desc = Array.isArray(faceData) ? faceData : faceData.descriptor;
          if (!desc || !Array.isArray(desc) || desc.length === 0) return;
          const dist = getEuclideanDistance(queryDescriptor, desc);
          if (dist < minDistance) minDistance = dist;
        });
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

    const metaResponse = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType' });
    const response = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    const contentType = (response.headers && response.headers['content-type'])
      || (metaResponse && metaResponse.data && metaResponse.data.mimeType)
      || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    response.data.pipe(res);
  } catch (err) {
    console.error('Error fetching file from Google Drive:', err.message || err);
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

app.get('/api/google/redirect-uri', async (req, res) => {
  res.json({
    success: true,
    redirectUri: getGoogleRedirectUri(req),
    publicBaseUrl: getPublicBaseUrl(req)
  });
});

app.get('/api/google/auth', async (req, res) => {
  const settings = await readSettings();
  if (!settings.googleClientId || !settings.googleClientSecret) {
    return res.status(400).send(
      'Google Client ID and Secret are not saved yet. Open Admin → Google Drive Storage, enter your keys, click Save Keys, then Connect Gmail.'
    );
  }

  const oauth2Client = await createGoogleOAuthClient(req);
  if (!oauth2Client) {
    return res.status(400).send('Could not create Google OAuth client. Check your Client ID and Secret.');
  }

  const redirectUri = getGoogleRedirectUri(req);
  console.log(`[Google OAuth] Starting auth flow. Redirect URI: ${redirectUri}`);

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent',
    include_granted_scopes: true
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

    const tokenInfo = await oauth2Client.getTokenInfo(tokens.access_token);
    const scopesGranted = (tokenInfo.scopes || []).concat(tokens.scope ? tokens.scope.split(' ') : []);
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

    invalidateSettingsCache();
    await writeSettings(settings);
    console.log(`[Google OAuth] Connected ${email}. Drive scope: ${hasDriveScope}. Saved to ${isFirebaseEnabled() ? 'Firestore' : 'local settings'}.`);

    res.redirect(hasDriveScope ? '/admin.html?gdrive=success' : '/admin.html?gdrive=missing_scope');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    const msg = encodeURIComponent(err.message || 'OAuth verification failed');
    res.redirect(`/admin.html?gdrive=error&msg=${msg}`);
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

app.post('/api/admin/sync', checkAdminAuth, async (req, res) => {
  try {
    const result = await syncGoogleDrivePhotos(req, true);
    res.json(result);
  } catch (err) {
    console.error('[Admin Sync] Manual sync failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
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
  settings = await verifyConnectedDriveScopes(settings, req);
  res.json({
    success: true,
    storageMode: getStorageMode(settings),
    googleRedirectUri: getGoogleRedirectUri(req),
    settings: sanitizeSettingsForClient(settings)
  });
});

app.post('/api/admin/settings', checkAdminAuth, async (req, res) => {
  const { publicGalleryEnabled, publicGalleryHeading, defaultPublicEventId, allowPublicFaceAdjustment, newPassword, logoWidth, photoRetentionHours, googleClientId, googleClientSecret, galleryMessage } = req.body;
  const settings = await readSettings();

  if (publicGalleryEnabled !== undefined) settings.publicGalleryEnabled = !!publicGalleryEnabled;
  if (publicGalleryHeading !== undefined) settings.publicGalleryHeading = publicGalleryHeading.toString().trim() || 'Gallery Catalog';
  if (defaultPublicEventId !== undefined) settings.defaultPublicEventId = defaultPublicEventId.toString().trim() || 'all';
  if (allowPublicFaceAdjustment !== undefined) settings.allowPublicFaceAdjustment = !!allowPublicFaceAdjustment;
  if (newPassword && newPassword.trim() !== '') settings.adminPassword = newPassword.trim();
  if (logoWidth !== undefined) settings.logoWidth = parseInt(logoWidth, 10) || 245;
  if (photoRetentionHours !== undefined) settings.photoRetentionHours = parseFloat(photoRetentionHours);
  if (googleClientId !== undefined) {
    settings.googleClientId = googleClientId.trim();
    cachedGoogleFolderId = '';
  }
  if (googleClientSecret !== undefined && googleClientSecret !== '********' && googleClientSecret.trim() !== '') {
    settings.googleClientSecret = googleClientSecret.trim();
    cachedGoogleFolderId = '';
  }
  if (galleryMessage !== undefined) {
    settings.galleryMessage = galleryMessage;
  }

  try {
    invalidateSettingsCache();
    await writeSettings(settings);
    res.json({
      success: true,
      storageMode: getStorageMode(settings),
      googleRedirectUri: getGoogleRedirectUri(req),
      settings: sanitizeSettingsForClient(settings)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
  if (status === 'approved') patch.isPublic = true;
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
  const { status, ids, target } = req.body;
  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status value' });
  }

  const gallery = await readGalleryDb();
  let updatedCount = 0;

  for (const photo of gallery) {
    let shouldUpdate = false;
    if (Array.isArray(ids) && ids.length > 0) {
      shouldUpdate = ids.includes(photo.id);
    } else if (target === 'no-face') {
      shouldUpdate = !photo.descriptors || photo.descriptors.length === 0;
    } else if (target === 'all') {
      shouldUpdate = photo.status !== status;
    } else {
      shouldUpdate = photo.status === 'pending';
    }

    if (shouldUpdate) {
      const patch = { status };
      if (status === 'approved') patch.isPublic = true;
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

    await deletePhotoAssets(photoToDelete, req);
    await deletePhotoRecord(id);
    res.json({ success: true, message: 'Photo deleted successfully' });
  } catch (err) {
    console.error('Delete endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/delete-all', checkAdminAuth, async (req, res) => {
  try {
    const { filter, ids } = req.body || {};
    const gallery = await readGalleryDb();

    let photosToDelete = [];
    let photosToKeep = [];

    if (Array.isArray(ids) && ids.length > 0) {
      const idSet = new Set(ids);
      photosToDelete = gallery.filter(p => idSet.has(p.id));
      photosToKeep = gallery.filter(p => !idSet.has(p.id));
    } else if (filter && filter !== 'all') {
      photosToDelete = gallery.filter(photo => {
        if (filter === 'public-upload' || filter === 'public') {
          return photo.uploadedBy !== 'admin';
        }
        if (filter === 'admin-upload' || filter === 'admin') {
          return photo.uploadedBy === 'admin';
        }
        if (filter === 'pending') {
          return photo.status === 'pending';
        }
        if (filter === 'approved') {
          return photo.status === 'approved';
        }
        if (filter === 'rejected') {
          return photo.status === 'rejected';
        }
        if (filter === 'no-face') {
          return !photo.descriptors || photo.descriptors.length === 0;
        }
        return false;
      });
      photosToKeep = gallery.filter(p => !photosToDelete.includes(p));
    } else {
      photosToDelete = [...gallery];
      photosToKeep = [];
    }

    console.log(`[Admin Delete] Deleting ${photosToDelete.length} matching photo(s) (Filter: '${filter || 'all'}')...`);

    for (const photo of photosToDelete) {
      await deletePhotoAssets(photo, req);
    }

    await writeGalleryDb(photosToKeep);
    res.json({ success: true, count: photosToDelete.length, message: `Successfully deleted ${photosToDelete.length} photo(s)` });
  } catch (err) {
    console.error('Delete-all endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_VALUE' || err.status === 413 || err.type === 'entity.too.large')) {
    console.warn('[Express Limit] Payload or file size too large:', err.message || err.code);
    return res.status(413).json({
      success: false,
      error: 'File or payload size too large. Maximum supported upload size is 30 MB (up to 50 MB server limit).'
    });
  }
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
        await deletePhotoAssets(photo, null);
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

  // Run Google Drive sync every 2 minutes on long-lived servers
  setInterval(() => {
    syncGoogleDrivePhotos().catch(err => console.error('[GDrive Sync] Background error:', err));
  }, 2 * 60 * 1000);
  // Run initial sync 10 seconds after startup
  setTimeout(() => {
    syncGoogleDrivePhotos().catch(err => console.error('[GDrive Sync] Initial background error:', err));
  }, 10000);
}

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log('==================================================');
    console.log(' Face Detection Gallery Server is running!');
    console.log(` Local URL: http://localhost:${PORT}`);
    console.log(` Storage: ${isFirebaseEnabled() ? 'Firebase metadata' : 'Local metadata'} + Google Drive photos when connected`);
    console.log('==================================================');
    verifyPythonSetup();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error('Server error:', err);
    }
  });
}

app.syncGoogleDrivePhotos = syncGoogleDrivePhotos;
app.triggerSyncIfNeeded = triggerSyncIfNeeded;

module.exports = app;
