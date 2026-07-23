const fs = require('fs');
const path = require('path');
const { isFirebaseEnabled, getDb, getBucket } = require('./firebase');

const PHOTOS_COLLECTION = 'photos';
const EVENTS_COLLECTION = 'events';
const SETTINGS_DOC = 'config/settings';

const galleryDbPath = path.join(__dirname, '..', 'public', 'gallery.json');
const eventsDbPath = path.join(__dirname, '..', 'public', 'events.json');
const settingsPath = path.join(__dirname, '..', 'settings.json');

// --- In-Memory RAM Cache ---
let ramGalleryCache = null;
let ramEventsCache = null;
let ramSettingsCache = null;
let isRamCacheInitialized = false;
let ramInitPromise = null;

let isWritingGallery = false;
const galleryWriteQueue = [];
let settingsMemoryCache = null;
let settingsStorageReadOnly = false;
let galleryMemoryCache = null;
let eventsMemoryCache = null;
let galleryStorageReadOnly = false;

function isReadOnlyFsError(err) {
  return err && ['EACCES', 'EPERM', 'EROFS'].includes(err.code);
}

const DEFAULT_SETTINGS = {
  adminPassword: 'admin123',
  publicGalleryEnabled: true,
  publicGalleryHeading: 'Gallery Catalog',
  defaultPublicEventId: 'all',
  allowPublicFaceAdjustment: true,
  faceDetectionEnabled: true, // Global face detection pipeline toggle
  logoWidth: 245,
  photoRetentionHours: 0, // 0 = never auto-delete
  googleClientId: '',
  googleClientSecret: '',
  googleRefreshToken: '',
  googleConnectedEmail: '',
  googleHasDriveScope: false,
  galleryMessage: ''
};

function applyEnvOverrides(settings) {
  const merged = { ...settings };
  if (process.env.ADMIN_PASSWORD) merged.adminPassword = process.env.ADMIN_PASSWORD;
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
  // RAM settings cache is updated automatically in-memory
}

function sanitizeSettingsForClient(settings) {
  return {
    publicGalleryEnabled: settings.publicGalleryEnabled,
    publicGalleryHeading: settings.publicGalleryHeading || 'Gallery Catalog',
    defaultPublicEventId: settings.defaultPublicEventId || 'all',
    allowPublicFaceAdjustment: settings.allowPublicFaceAdjustment !== false,
    faceDetectionEnabled: settings.faceDetectionEnabled !== false,
    logoWidth: settings.logoWidth,
    photoRetentionHours: settings.photoRetentionHours,
    googleClientId: settings.googleClientId || '',
    googleClientSecret: settings.googleClientSecret ? '********' : '',
    googleDriveConnected: !!settings.googleRefreshToken,
    googleConnectedEmail: settings.googleConnectedEmail || '',
    googleHasDriveScope: settings.googleHasDriveScope !== false,
    galleryMessage: settings.galleryMessage || ''
  };
}

// ---------- RAM Cache Initialization ----------

async function initRamCache() {
  if (isRamCacheInitialized) {
    return true;
  }
  if (ramInitPromise) {
    return ramInitPromise;
  }

  ramInitPromise = (async () => {
    console.log('[RAM Cache] Initializing RAM cache from permanent storage...');
    if (isFirebaseEnabled()) {
      try {
        const db = getDb();
        if (!db) {
          throw new Error('Firestore instance not available');
        }

        // 1. Single load of all photo metadata & face descriptors from Firestore
        const photosSnap = await db.collection(PHOTOS_COLLECTION).get();
        const photos = photosSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        photos.sort((a, b) => String(b.timestamp || b.uploadTime || '').localeCompare(String(a.timestamp || a.uploadTime || '')));
        ramGalleryCache = photos;

        // 2. Single load of all events from Firestore
        const eventsSnap = await db.collection(EVENTS_COLLECTION).get();
        const events = eventsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        events.sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')));
        ramEventsCache = events;

        // 3. Single load of settings from Firestore
        const settingsSnap = await db.doc(SETTINGS_DOC).get();
        if (!settingsSnap.exists) {
          await db.doc(SETTINGS_DOC).set(DEFAULT_SETTINGS);
          ramSettingsCache = { ...DEFAULT_SETTINGS };
        } else {
          ramSettingsCache = { ...DEFAULT_SETTINGS, ...settingsSnap.data() };
        }

        console.log(`[RAM Cache] Firestore initial load successful. Cached ${ramGalleryCache.length} photo(s), ${ramEventsCache.length} event(s), and system settings in RAM.`);
      } catch (err) {
        console.error('[RAM Cache] Firestore load failed, falling back to local files:', err.message);
        ramGalleryCache = readLocalGallery();
        ramEventsCache = readLocalEvents();
        ramSettingsCache = readLocalSettings();
      }
    } else {
      ramGalleryCache = readLocalGallery();
      ramEventsCache = readLocalEvents();
      ramSettingsCache = readLocalSettings();
      console.log(`[RAM Cache] Local JSON initial load successful. Cached ${ramGalleryCache.length} photo(s) and ${ramEventsCache.length} event(s) in RAM.`);
    }

    isRamCacheInitialized = true;
    return true;
  })();

  return ramInitPromise;
}

// ---------- Local File Helpers ----------

function readLocalGallery() {
  if (galleryMemoryCache) {
    return galleryMemoryCache;
  }
  let localData = [];
  try {
    if (!fs.existsSync(galleryDbPath)) {
      fs.writeFileSync(galleryDbPath, JSON.stringify([], null, 2));
    } else {
      const data = fs.readFileSync(galleryDbPath, 'utf8');
      localData = JSON.parse(data || '[]');
    }

    let migrated = false;
    localData.forEach(photo => {
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
      fs.writeFileSync(galleryDbPath, JSON.stringify(localData, null, 2));
    }
  } catch (err) {
    if (isReadOnlyFsError(err)) {
      galleryStorageReadOnly = true;
      galleryMemoryCache = [];
      localData = galleryMemoryCache;
    } else {
      console.error('Error reading gallery database:', err);
      localData = [];
    }
  }
  return localData.sort((a, b) => String(b.timestamp || b.uploadTime || '').localeCompare(String(a.timestamp || a.uploadTime || '')));
}

async function writeLocalGallery(data) {
  return new Promise((resolve, reject) => {
    const performWrite = async () => {
      isWritingGallery = true;
      try {
        await fs.promises.writeFile(galleryDbPath, JSON.stringify(data, null, 2));
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

function readLocalEvents() {
  if (eventsMemoryCache) {
    return eventsMemoryCache;
  }
  let localData = [];
  try {
    if (!fs.existsSync(eventsDbPath)) {
      fs.writeFileSync(eventsDbPath, JSON.stringify([], null, 2));
    } else {
      const data = fs.readFileSync(eventsDbPath, 'utf8');
      localData = JSON.parse(data || '[]');
    }
  } catch (err) {
    if (isReadOnlyFsError(err)) {
      eventsMemoryCache = [];
      localData = eventsMemoryCache;
    } else {
      console.error('Error reading events database:', err);
      localData = [];
    }
  }
  return localData;
}

async function writeLocalEvents(data) {
  try {
    await fs.promises.writeFile(eventsDbPath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    if (isReadOnlyFsError(err)) {
      eventsMemoryCache = data;
      return true;
    }
    console.error('Error writing events database:', err);
    throw err;
  }
}

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

// ---------- Gallery DB (RAM Cache + Firestore Sync) ----------

async function readGalleryDb() {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }
  return [...ramGalleryCache].sort((a, b) => String(b.timestamp || b.uploadTime || '').localeCompare(String(a.timestamp || a.uploadTime || '')));
}

async function writeGalleryDb(data) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  if (isFirebaseEnabled()) {
    const db = getDb();
    const newIdSet = new Set(data.map(p => p.id));
    // Remove deleted documents from Firestore
    const removedPhotos = ramGalleryCache.filter(p => !newIdSet.has(p.id));
    for (const photo of removedPhotos) {
      try {
        await db.collection(PHOTOS_COLLECTION).doc(photo.id).delete();
      } catch (err) {
        console.error(`[RAM Cache Sync] Firestore delete failed for ${photo.id}:`, err.message);
      }
    }

    // Upsert items into Firestore
    for (const photo of data) {
      const { id, ...rest } = photo;
      try {
        await db.collection(PHOTOS_COLLECTION).doc(id).set(rest, { merge: true });
      } catch (err) {
        console.error(`[RAM Cache Sync] Firestore set failed for ${id}:`, err.message);
      }
    }
  } else {
    await writeLocalGallery(data);
  }

  ramGalleryCache = [...data];
  return true;
}

async function addPhoto(photo) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  const { id, ...rest } = photo;
  if (isFirebaseEnabled()) {
    try {
      const db = getDb();
      if (db) {
        await db.collection(PHOTOS_COLLECTION).doc(id).set(rest);
      }
    } catch (err) {
      console.error(`[Firestore Error] Failed to write photo ${id}:`, err.message);
    }
  } else {
    const localGallery = readLocalGallery();
    localGallery.push(photo);
    await writeLocalGallery(localGallery);
  }

  // Update RAM cache immediately in memory (no re-reading from Firestore)
  const idx = ramGalleryCache.findIndex(p => p.id === id);
  if (idx !== -1) {
    ramGalleryCache[idx] = { ...photo };
  } else {
    ramGalleryCache.unshift({ ...photo });
  }

  return photo;
}

async function updatePhoto(id, patch) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  const existing = ramGalleryCache.find(p => p.id === id);
  if (!existing) {
    return null;
  }

  if (isFirebaseEnabled()) {
    try {
      const db = getDb();
      if (db) {
        const ref = db.collection(PHOTOS_COLLECTION).doc(id);
        await ref.update(patch);
      }
    } catch (err) {
      console.error(`[Firestore Error] Failed to update photo ${id}:`, err.message);
    }
  } else {
    const localGallery = readLocalGallery();
    const p = localGallery.find(item => item.id === id);
    if (p) {
      Object.assign(p, patch);
      await writeLocalGallery(localGallery);
    }
  }

  // Update RAM cache immediately in memory
  Object.assign(existing, patch);
  return { ...existing };
}

async function deletePhotoRecord(id) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  if (isFirebaseEnabled()) {
    try {
      const db = getDb();
      if (db) {
        await db.collection(PHOTOS_COLLECTION).doc(id).delete();
      }
    } catch (err) {
      console.error(`[Firestore Error] Failed to delete photo ${id}:`, err.message);
    }
  } else {
    const localGallery = readLocalGallery();
    const idx = localGallery.findIndex(p => p.id === id);
    if (idx !== -1) {
      localGallery.splice(idx, 1);
      await writeLocalGallery(localGallery);
    }
  }

  // Remove from RAM cache immediately
  const idx = ramGalleryCache.findIndex(p => p.id === id);
  if (idx !== -1) {
    ramGalleryCache.splice(idx, 1);
  }
  return true;
}

async function getPhotoById(id) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }
  const photo = ramGalleryCache.find(p => p.id === id);
  return photo ? { ...photo } : null;
}

// ---------- Events DB (RAM Cache + Firestore Sync) ----------

async function readEventsDb() {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }
  return [...ramEventsCache].sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')));
}

async function writeEventsDb(data) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  if (isFirebaseEnabled()) {
    const db = getDb();
    const newIdSet = new Set(data.map(e => e.id));
    const removedEvents = ramEventsCache.filter(e => !newIdSet.has(e.id));
    for (const evt of removedEvents) {
      await db.collection(EVENTS_COLLECTION).doc(evt.id).delete();
    }
    for (const evt of data) {
      const { id, ...rest } = evt;
      await db.collection(EVENTS_COLLECTION).doc(id).set(rest, { merge: true });
    }
  } else {
    await writeLocalEvents(data);
  }

  ramEventsCache = [...data];
  return true;
}

async function addEvent(event) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  const { id, ...rest } = event;
  if (isFirebaseEnabled()) {
    const db = getDb();
    await db.collection(EVENTS_COLLECTION).doc(id).set(rest);
  } else {
    const localEvents = readLocalEvents();
    localEvents.push(event);
    await writeLocalEvents(localEvents);
  }

  const idx = ramEventsCache.findIndex(e => e.id === id);
  if (idx !== -1) {
    ramEventsCache[idx] = { ...event };
  } else {
    ramEventsCache.push({ ...event });
  }

  return event;
}

async function updateEvent(id, patch) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  const existing = ramEventsCache.find(e => e.id === id);
  if (!existing) return null;

  if (isFirebaseEnabled()) {
    const db = getDb();
    const ref = db.collection(EVENTS_COLLECTION).doc(id);
    await ref.update(patch);
  } else {
    const localEvents = readLocalEvents();
    const evt = localEvents.find(e => e.id === id);
    if (evt) {
      Object.assign(evt, patch);
      await writeLocalEvents(localEvents);
    }
  }

  Object.assign(existing, patch);
  return { ...existing };
}

async function deleteEvent(id) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  if (isFirebaseEnabled()) {
    const db = getDb();
    await db.collection(EVENTS_COLLECTION).doc(id).delete();
  } else {
    const localEvents = readLocalEvents();
    const idx = localEvents.findIndex(e => e.id === id);
    if (idx !== -1) {
      localEvents.splice(idx, 1);
      await writeLocalEvents(localEvents);
    }
  }

  const idx = ramEventsCache.findIndex(e => e.id === id);
  if (idx !== -1) {
    ramEventsCache.splice(idx, 1);
  }
  return true;
}

async function getEventById(id) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }
  const evt = ramEventsCache.find(e => e.id === id);
  return evt ? { ...evt } : null;
}

// ---------- Settings DB (RAM Cache + Firestore Sync) ----------

async function readSettings() {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }
  return applyEnvOverrides(ramSettingsCache || DEFAULT_SETTINGS);
}

async function writeSettings(data) {
  if (!isRamCacheInitialized) {
    await initRamCache();
  }

  const payload = { ...data };
  if (payload.googleClientSecret === '********') {
    delete payload.googleClientSecret;
    if (ramSettingsCache && ramSettingsCache.googleClientSecret) {
      payload.googleClientSecret = ramSettingsCache.googleClientSecret;
    }
  }

  if (isFirebaseEnabled()) {
    try {
      const db = getDb();
      await db.doc(SETTINGS_DOC).set(payload, { merge: true });
    } catch (err) {
      console.error('[Firebase] Failed to write settings:', err.message);
      throw new Error(`Failed to save settings to Firebase: ${err.message}`);
    }
  } else {
    writeLocalSettings(payload);
  }

  ramSettingsCache = { ...DEFAULT_SETTINGS, ...ramSettingsCache, ...payload };
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
  initRamCache,
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
  getFirebaseFileStream,
  DEFAULT_SETTINGS
};
