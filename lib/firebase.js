const admin = require('firebase-admin');

let initialized = false;
let db = null;
let bucket = null;
let firebaseStatus = 'Uninitialized';
let lastInitError = null;
let lastInitTime = null;

function getFirebaseConfigFromEnv() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || (projectId ? `${projectId}.appspot.com` : '');

  if (!projectId || !clientEmail || !privateKey) {
    const missing = [];
    if (!projectId) missing.push('FIREBASE_PROJECT_ID');
    if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
    if (!privateKey) missing.push('FIREBASE_PRIVATE_KEY');
    lastInitError = `Missing required Firebase environment variables: ${missing.join(', ')}`;
    firebaseStatus = 'Disabled (Missing Credentials)';
    return null;
  }

  // Vercel / .env / Render often store newlines as \n
  privateKey = privateKey.replace(/\\n/g, '\n');

  return { projectId, clientEmail, privateKey, storageBucket };
}

function isFirebaseEnabled() {
  return !!getFirebaseConfigFromEnv();
}

function initFirebase() {
  lastInitTime = new Date().toISOString();
  if (initialized && db) {
    firebaseStatus = 'Connected';
    return { db, bucket };
  }

  const config = getFirebaseConfigFromEnv();
  if (!config) {
    return { db: null, bucket: null };
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: config.projectId,
          clientEmail: config.clientEmail,
          privateKey: config.privateKey
        }),
        storageBucket: config.storageBucket
      });
    }

    db = admin.firestore();
    bucket = admin.storage().bucket();
    initialized = true;
    firebaseStatus = 'Connected';
    lastInitError = null;
    console.log(`[Firebase] Successfully connected to project: ${config.projectId}`);
    return { db, bucket };
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    const errStack = err && err.stack ? err.stack : '';
    console.error(`[Firebase Initialization Failed] Error: ${errMsg}`);
    if (errStack) {
      console.error(`[Firebase Stack Trace]:\n${errStack}`);
    }
    console.error('[Firebase] Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are set and formatted correctly.');

    db = null;
    bucket = null;
    initialized = false;
    lastInitError = errMsg;

    if (errMsg.toLowerCase().includes('pem') || errMsg.toLowerCase().includes('key') || errMsg.toLowerCase().includes('credential') || errMsg.toLowerCase().includes('auth')) {
      firebaseStatus = 'Authentication Failed';
    } else {
      firebaseStatus = 'Initialization Failed';
    }

    return { db: null, bucket: null };
  }
}

function getDb() {
  initFirebase();
  return db;
}

function getBucket() {
  initFirebase();
  return bucket;
}

function getFirebaseStatus() {
  if (!initialized && firebaseStatus === 'Uninitialized') {
    initFirebase();
  }
  const config = getFirebaseConfigFromEnv();
  return {
    status: firebaseStatus,
    initialized: initialized && !!db,
    projectId: config ? config.projectId : null,
    error: lastInitError,
    lastAttempt: lastInitTime
  };
}

module.exports = {
  isFirebaseEnabled,
  initFirebase,
  getDb,
  getBucket,
  getFirebaseStatus,
  admin
};
