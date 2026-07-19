require('dotenv').config();
const { initFirebase, getDb } = require('../lib/firebase');


async function main() {
  const { db } = initFirebase();
  if (!db) {
    console.error("Firebase database could not be initialized. Check env variables.");
    process.exit(1);
  }

  console.log("Querying 'photos' collection in Firestore...");
  try {
    const snap = await db.collection('photos').get();
    console.log(`Found ${snap.size} document(s) in 'photos' collection:`);
    snap.docs.forEach(doc => {
      const data = doc.data();
      console.log(`- ID: ${doc.id}`);
      console.log(`  Filename: ${data.filename}`);
      console.log(`  Original Name: ${data.originalName}`);
      console.log(`  Uploaded By: ${data.uploadedBy}`);
      console.log(`  Upload Time: ${data.uploadTime}`);
      console.log(`  Face Detected: ${data.faceDetected}`);
      console.log(`  Face Detection Status: ${data.faceDetectionStatus}`);
      console.log(`  Descriptors Count: ${data.descriptors ? data.descriptors.length : 0}`);
      console.log("-----------------------------------------");
    });
  } catch (err) {
    console.error("Firestore query error:", err);
  }
  process.exit(0);
}

main();
