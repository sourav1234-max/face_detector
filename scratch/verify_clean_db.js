require('dotenv').config();
const { readGalleryDb } = require('../lib/store');

async function verify() {
  const photos = await readGalleryDb();
  console.log(`\n=== Verification Results ===`);
  console.log(`Remaining photo count in DB: ${photos.length}`);
  photos.forEach((p, idx) => {
    console.log(`[${idx + 1}] ID: ${p.id} | Name: ${p.originalName || p.filename} | UploadedBy: ${p.uploadedBy} | Status: ${p.status} | Faces: ${p.descriptors ? p.descriptors.length : 0}`);
  });
}

verify().catch(console.error);
