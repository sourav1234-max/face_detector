const {
  initRamCache,
  readGalleryDb,
  getPhotoById,
  addPhoto,
  updatePhoto,
  deletePhotoRecord,
  readEventsDb,
  readSettings
} = require('../lib/store');

async function testRamCache() {
  console.log('=== STARTING RAM CACHE UNIT TEST ===');

  // 1. Initialize RAM cache
  console.log('[Test 1] Initializing RAM Cache...');
  await initRamCache();

  // 2. Read gallery from RAM
  const initialPhotos = await readGalleryDb();
  console.log(`[Test 2] Gallery loaded from RAM: ${initialPhotos.length} photo(s).`);

  // 3. Test addPhoto (incremental RAM update)
  const testPhotoId = 'img_test_ram_' + Date.now();
  const testPhoto = {
    id: testPhotoId,
    fileId: 'gdrive_test_123',
    filename: 'drive:gdrive_test_123',
    imageUrl: 'https://drive.google.com/uc?export=view&id=gdrive_test_123',
    storageUrl: '/api/drive/photo/gdrive_test_123',
    originalName: 'test_photo.jpg',
    descriptors: [{ box: { x: 10, y: 10, width: 50, height: 50 }, descriptor: new Array(128).fill(0.1) }],
    status: 'approved',
    isPublic: true,
    uploadedBy: 'test_script',
    timestamp: new Date().toISOString()
  };

  console.log('[Test 3] Adding test photo (incremental update)...');
  await addPhoto(testPhoto);

  const updatedPhotos = await readGalleryDb();
  const fetchedPhoto = await getPhotoById(testPhotoId);

  if (!fetchedPhoto || fetchedPhoto.id !== testPhotoId) {
    throw new Error('FAIL: Added photo was not immediately found in RAM Cache!');
  }
  console.log('[Test 3 PASSED] Photo added and found in RAM Cache without full reload.');

  // 4. Test updatePhoto (in-place RAM update)
  console.log('[Test 4] Updating photo status in RAM...');
  await updatePhoto(testPhotoId, { status: 'rejected', isPublic: false });
  const updatedFetch = await getPhotoById(testPhotoId);
  if (!updatedFetch || updatedFetch.status !== 'rejected' || updatedFetch.isPublic !== false) {
    throw new Error('FAIL: Photo update was not immediately reflected in RAM Cache!');
  }
  console.log('[Test 4 PASSED] Photo updated in-place in RAM Cache.');

  // 5. Test deletePhotoRecord (in-place RAM removal)
  console.log('[Test 5] Deleting photo from RAM...');
  await deletePhotoRecord(testPhotoId);
  const deletedFetch = await getPhotoById(testPhotoId);
  if (deletedFetch) {
    throw new Error('FAIL: Deleted photo was still present in RAM Cache!');
  }
  console.log('[Test 5 PASSED] Photo successfully deleted from RAM Cache.');

  // 6. Test readEventsDb and readSettings
  const events = await readEventsDb();
  const settings = await readSettings();
  console.log(`[Test 6 PASSED] Events loaded: ${events.length}, Settings heading: '${settings.publicGalleryHeading}'`);

  console.log('=== ALL RAM CACHE UNIT TESTS PASSED SUCCESSFULLY! ===');
}

testRamCache().catch(err => {
  console.error('RAM Cache test failed:', err);
  process.exit(1);
});
