require('dotenv').config();
const { initFirebase } = require('../lib/firebase');

async function main() {
  const { db } = initFirebase();
  if (!db) {
    console.error("Firebase database could not be initialized.");
    process.exit(1);
  }

  console.log("Querying 'config/settings' document in Firestore...");
  try {
    const snap = await db.doc('config/settings').get();
    if (snap.exists) {
      const data = snap.data();
      console.log("Settings found in Firestore:");
      console.log(`- publicGalleryEnabled: ${data.publicGalleryEnabled}`);
      console.log(`- publicGalleryHeading: ${data.publicGalleryHeading}`);
      console.log(`- googleClientId: ${data.googleClientId}`);
      console.log(`- googleConnectedEmail: ${data.googleConnectedEmail}`);
      console.log(`- googleRefreshToken: ${data.googleRefreshToken ? "PRESENT (hidden)" : "MISSING"}`);
      console.log(`- googleHasDriveScope: ${data.googleHasDriveScope}`);
    } else {
      console.log("No config/settings document found.");
    }
  } catch (err) {
    console.error("Firestore settings query error:", err);
  }
  process.exit(0);
}

main();
