const fs = require('fs');
const path = require('path');
const { isFirebaseEnabled, getDb, getBucket } = require('./firebase');

const PHOTOS_COLLECTION = 'photos';
const SETTINGS_DOC = 'config/settings';

const galleryDbPath = path.join(__dirname, '..', 'public', 'gallery.json');
const settingsPath = path.join(__dirname, '..', 'settings.json');

let galleryCache = null;
let isWritingGallery = false;
const galleryWriteQueue = [];
let settingsMemoryCache = null;
let settingsStorageReadOnly = false;
let galleryMemoryCache = null;
let galleryStorageReadOnly = false;

function isReadOnlyFsError(err) {
  return err && ['EACCES', 'EPERM', 'EROFS'].includes(err.code);
}

const DEFAULT_SETTINGS = {
  adminPassword: 'admin123',
  publicGalleryEnabled: true,
  logoWidth: 245,
  photoRetentionHours: 0, // 0 = never auto-delete
  googleClientId: '',
  googleClientSecret: '',
  googleRefreshToken: '',
  googleConnectedEmail: '',
  googleHasDriveScope: false
};

function applyEnvOverrides(settings) {
  const merged = { ...settings };
  if (process.env.ADMIN_PASSWORD) merged.adminPassword = process.env.ADMIN_PASSWORD;
  // Env vars fill in missing values only — don't overwrite tokens saved in Firestore
  if (process.env.GOOGLE_CLIENT_ID && !merged.googleClientId) {
    merged.googleClientId = process.env.GOOGLE_CLIENT_ID;
  }
  if (process.env.GOOGLE_CLIENT_SECRET && !merged.googleClientSecret) {
    merged.googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  }
  if (process.env.GOOGLE_REFRESH_TOKEN && !merged.googleRefreshToken) {
    merged.googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  }
  if (process.env.PHOTO_RETENTION_HOURS !== undefined && process.env.PHOTO_RETENTION_HOURS !== '') {
    merged.photoRetentionHours = parseFloat(process.env.PHOTO_RETENTION_HOURS);
  }
  return merged;
}

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

function sanitizeSettingsForClient(settings) {
  return {
    publicGalleryEnabled: settings.publicGalleryEnabled,
    logoWidth: settings.logoWidth,
    photoRetentionHours: settings.photoRetentionHours,
    googleClientId: settings.googleClientId || '',
    googleClientSecret: settings.googleClientSecret ? '********' : '',
    googleDriveConnected: !!settings.googleRefreshToken,
    googleConnectedEmail: settings.googleConnectedEmail || '',
    googleHasDriveScope: settings.googleHasDriveScope !== false
  };
}

// ---------- Gallery ----------

function readLocalGallery() {
  if (galleryMemoryCache) {
    return galleryMemoryCache;
  }

  if (galleryCache === null) {
    try {
      if (!fs.existsSync(galleryDbPath)) {
        fs.writeFileSync(galleryDbPath, JSON.stringify([], null, 2));
        galleryCache = [];
      } else {
        const data = fs.readFileSync(galleryDbPath, 'utf8');
        galleryCache = JSON.parse(data || '[]');
      }

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
      if (isReadOnlyFsError(err)) {
        console.warn('Gallery storage is read-only. Using in-memory gallery fallback:', err.message);
        galleryStorageReadOnly = true;
        galleryMemoryCache = [];
        galleryCache = galleryMemoryCache;
      } else {
        console.error('Error reading gallery database:', err);
        galleryCache = [];
      }
    }
  }
  return galleryCache;
}

async function writeLocalGallery(data) {
  galleryCache = data;
  return new Promise((resolve, reject) => {
    const performWrite = async () => {
      isWritingGallery = true;
      try {
        await fs.promises.writeFile(galleryDbPath, JSON.stringify(galleryCache, null, 2));
        resolve(true);
      } catch (err) {
        if (isReadOnlyFsError(err)) {
          galleryStorageReadOnly = true;
          galleryMemoryCache = data;
          console.warn('Gallery storage is read-only. Using in-memory gallery cache instead:', err.message);
          resolve(true);
        } else {
          console.error('Error writing gallery database:', err);
          reject(err);
        }
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

async function readGalleryDb() {
  if (isFirebaseEnabled()) {
    const db = getDb();
    const snap = await db.collection(PHOTOS_COLLECTION).get();
    const photos = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    photos.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    return photos;
  }
  return readLocalGallery();
}

async function writeGalleryDb(data) {
  if (isFirebaseEnabled()) {
    const db = getDb();
    const existing = await db.collection(PHOTOS_COLLECTION).get();
    const ops = [];

    existing.docs.forEach(doc => {
      ops.push({ type: 'delete', ref: doc.ref });
    });
    data.forEach(photo => {
      const { id, ...rest } = photo;
      ops.push({ type: 'set', ref: db.collection(PHOTOS_COLLECTION).doc(id), data: rest });
    });

    // Firestore batches max 500 ops
    for (let i = 0; i < ops.length; i += 450) {
      const batch = db.batch();
      const chunk = ops.slice(i, i + 450);
      chunk.forEach(op => {
        if (op.type === 'delete') batch.delete(op.ref);
        else batch.set(op.ref, op.data);
      });
      await batch.commit();
    }
    return true;
  }
  return writeLocalGallery(data);
}

async function addPhoto(photo) {
  if (isFirebaseEnabled()) {
    const db = getDb();
    const { id, ...rest } = photo;
    await db.collection(PHOTOS_COLLECTION).doc(id).set(rest);
    return photo;
  }
  const gallery = readLocalGallery();
  gallery.push(photo);
  await writeLocalGallery(gallery);
  return photo;
}

async function updatePhoto(id, patch) {
  if (isFirebaseEnabled()) {
    const db = getDb();
    const ref = db.collection(PHOTOS_COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    await ref.update(patch);
    return { id, ...snap.data(), ...patch };
  }
  const gallery = readLocalGallery();
  const photo = gallery.find(p => p.id === id);
  if (!photo) return null;
  Object.assign(photo, patch);
  await writeLocalGallery(gallery);
  return photo;
}

async function deletePhotoRecord(id) {
  if (isFirebaseEnabled()) {
    const db = getDb();
    await db.collection(PHOTOS_COLLECTION).doc(id).delete();
    return true;
  }
  const gallery = readLocalGallery();
  const idx = gallery.findIndex(p => p.id === id);
  if (idx === -1) return false;
  gallery.splice(idx, 1);
  await writeLocalGallery(gallery);
  return true;
}

async function getPhotoById(id) {
  if (isFirebaseEnabled()) {
    const db = getDb();
    const snap = await db.collection(PHOTOS_COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  }
  return readLocalGallery().find(p => p.id === id) || null;
}

// ---------- Settings ----------

function readLocalSettings() {
  if (settingsMemoryCache) {
    return { ...DEFAULT_SETTINGS, ...settingsMemoryCache };
  }

  try {
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      return { ...DEFAULT_SETTINGS };
    }
    const data = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(data || '{}');
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    if (isReadOnlyFsError(err)) {
      settingsStorageReadOnly = true;
      settingsMemoryCache = { ...DEFAULT_SETTINGS };
      console.warn('Settings storage is read-only. Using in-memory settings fallback:', err.message);
      return settingsMemoryCache;
    }
    console.error('Error reading settings:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeLocalSettings(data) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    if (isReadOnlyFsError(err)) {
      settingsStorageReadOnly = true;
      settingsMemoryCache = data;
      console.warn('Settings storage is read-only. Using in-memory settings cache instead:', err.message);
      return false;
    }
    console.error('Error writing settings:', err);
    return false;
  }
}

let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_CACHE_MS = 5000;

async function readSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_CACHE_MS) {
    return applyEnvOverrides(settingsCache);
  }

  if (isFirebaseEnabled()) {
    try {
      const db = getDb();
      const snap = await db.doc(SETTINGS_DOC).get();
      if (!snap.exists) {
        await db.doc(SETTINGS_DOC).set(DEFAULT_SETTINGS);
        settingsCache = { ...DEFAULT_SETTINGS };
      } else {
        settingsCache = { ...DEFAULT_SETTINGS, ...snap.data() };
      }
    } catch (err) {
      console.error('[Firebase] Failed to read settings, falling back to local:', err.message);
      settingsCache = readLocalSettings();
    }
  } else {
    settingsCache = readLocalSettings();
  }

  settingsCacheAt = now;
  return applyEnvOverrides(settingsCache);
}

async function writeSettings(data) {
  const payload = { ...data };
  // Never persist masked placeholder from admin API responses
  if (payload.googleClientSecret === '********') {
    delete payload.googleClientSecret;
    if (settingsCache && settingsCache.googleClientSecret) {
      payload.googleClientSecret = settingsCache.googleClientSecret;
    }
  }

  if (isFirebaseEnabled()) {
    try {
      const db = getDb();
      await db.doc(SETTINGS_DOC).set(payload, { merge: true });
      settingsCache = { ...DEFAULT_SETTINGS, ...payload };
      settingsCacheAt = Date.now();
      console.log('[Firebase] Settings saved to Firestore');
      return true;
    } catch (err) {
      console.error('[Firebase] Failed to write settings:', err.message);
      throw new Error(`Failed to save settings to Firebase: ${err.message}`);
    }
  }

  const ok = writeLocalSettings(payload);
  if (!ok) {
    throw new Error('Failed to save settings to local file. On Vercel, configure Firebase env vars or use a writable filesystem.');
  }
  settingsCache = payload;
  settingsCacheAt = Date.now();
  return true;
}

// ---------- Firebase Storage ----------

async function uploadToFirebaseStorage(buffer, destinationPath, mimeType) {
  const bucket = getBucket();
  if (!bucket) throw new Error('Firebase Storage is not configured');

  const file = bucket.file(destinationPath);
  await file.save(buffer, {
    metadata: {
      contentType: mimeType,
      cacheControl: 'public, max-age=31536000'
    },
    resumable: false
  });

  // Make publicly readable so the UI can load images directly
  try {
    await file.makePublic();
  } catch (err) {
    console.warn('[Firebase Storage] makePublic failed (check IAM). Falling back to signed URL.', err.message);
  }

  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURI(destinationPath)}`;
  return { path: destinationPath, url: publicUrl };
}

async function deleteFromFirebaseStorage(storagePath) {
  const bucket = getBucket();
  if (!bucket || !storagePath) return;
  try {
    await bucket.file(storagePath).delete({ ignoreNotFound: true });
  } catch (err) {
    console.error(`[Firebase Storage] Failed to delete ${storagePath}:`, err.message);
  }
}

async function getFirebaseFileStream(storagePath) {
  const bucket = getBucket();
  if (!bucket) throw new Error('Firebase Storage is not configured');
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new Error('File not found');
  const [meta] = await file.getMetadata();
  return {
    stream: file.createReadStream(),
    contentType: meta.contentType || 'application/octet-stream'
  };
}

module.exports = {
  isFirebaseEnabled,
  readGalleryDb,
  writeGalleryDb,
  addPhoto,
  updatePhoto,
  deletePhotoRecord,
  getPhotoById,
  readSettings,
  writeSettings,
  invalidateSettingsCache,
  sanitizeSettingsForClient,
  uploadToFirebaseStorage,
  deleteFromFirebaseStorage,
  getFirebaseFileStream,
  DEFAULT_SETTINGS
};
