const { readGalleryDb, saveGalleryDb, isFirebaseEnabled, getDb } = require('../lib/store');

async function cleanDuplicates() {
  console.log('=== Checking for Duplicate Photos in Gallery Database ===');
  const gallery = await readGalleryDb();
  console.log(`Total photos in gallery database: ${gallery.length}`);

  const seenKeys = new Map();
  const duplicatesToDelete = [];
  const uniquePhotos = [];

  for (const photo of gallery) {
    const key = photo.fileId || photo.originalName || photo.filename;
    if (!key) {
      uniquePhotos.push(photo);
      continue;
    }

    if (seenKeys.has(key)) {
      duplicatesToDelete.push(photo);
    } else {
      seenKeys.set(key, photo);
      uniquePhotos.push(photo);
    }
  }

  if (duplicatesToDelete.length > 0) {
    console.log(`Found ${duplicatesToDelete.length} duplicate photo records. Cleaning up...`);
    await saveGalleryDb(uniquePhotos);
    console.log('Successfully deduplicated photo database!');
  } else {
    console.log('No duplicate photo records found in database.');
  }
}

cleanDuplicates().catch(err => {
  console.error('Deduplication script failed:', err);
});
