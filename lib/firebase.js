const admin = require('firebase-admin');

let initialized = false;
let db = null;
let bucket = null;

function getFirebaseConfigFromEnv() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || (projectId ? `${projectId}.appspot.com` : '');

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  // Vercel / .env often stores newlines as \n
  privateKey = privateKey.replace(/\\n/g, '\n');

  return { projectId, clientEmail, privateKey, storageBucket };
}

function isFirebaseEnabled() {
  return !!getFirebaseConfigFromEnv();
}

function initFirebase() {
  if (initialized) {
    return { db, bucket };
  }

  const config = getFirebaseConfigFromEnv();
  if (!config) {
    return { db: null, bucket: null };
  }

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
  console.log(`[Firebase] Connected to project ${config.projectId}`);
  return { db, bucket };
}

function getDb() {
  initFirebase();
  return db;
}

function getBucket() {
  initFirebase();
  return bucket;
}

module.exports = {
  isFirebaseEnabled,
  initFirebase,
  getDb,
  getBucket,
  admin
};
