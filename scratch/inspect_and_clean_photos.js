require('dotenv').config();
const { readGalleryDb, saveGalleryDb, deletePhotoRecord } = require('../lib/store');

async function inspectAndClean() {
  console.log('=== Inspecting Photo Database Records ===');
  const photos = await readGalleryDb();
  console.log(`Found ${photos.length} total photo record(s) in DB:`);
  
  photos.forEach((p, idx) => {
    console.log(`[${idx + 1}] ID: ${p.id} | Name: ${p.originalName || p.filename} | UploadedBy: ${p.uploadedBy} | Status: ${p.status} | Faces: ${p.descriptors ? p.descriptors.length : 0} | Date: ${p.uploadTime || p.timestamp}`);
  });

  const seenNames = new Map();
  const duplicates = [];
  const cleanList = [];

  // Sort photos so that 'approved' or photos with face descriptors or admin uploads come first!
  const sorted = [...photos].sort((a, b) => {
    const aDesc = a.descriptors ? a.descriptors.length : 0;
    const bDesc = b.descriptors ? b.descriptors.length : 0;
    if (aDesc !== bDesc) return bDesc - aDesc; // photo with faces first
    if (a.status === 'approved' && b.status !== 'approved') return -1;
    if (b.status === 'approved' && a.status !== 'approved') return 1;
    if (a.uploadedBy === 'admin' && b.uploadedBy !== 'admin') return -1;
    return new Date(b.uploadTime || 0) - new Date(a.uploadTime || 0);
  });

  for (const p of sorted) {
    const key = (p.originalName || p.originalFileName || p.filename || '').toLowerCase().trim();
    if (!key) {
      cleanList.push(p);
      continue;
    }

    if (seenNames.has(key)) {
      console.log(`[Duplicate Found] ${p.id} (${key}) - uploaded by ${p.uploadedBy} [Status: ${p.status}]`);
      duplicates.push(p);
    } else {
      seenNames.set(key, p);
      cleanList.push(p);
    }
  }

  if (duplicates.length > 0) {
    console.log(`\nDeleting ${duplicates.length} duplicate record(s) from Firestore and local DB...`);
    for (const dup of duplicates) {
      try {
        await deletePhotoRecord(dup.id);
        console.log(`[Deleted] Removed duplicate photo: ${dup.id} (${dup.originalName || dup.filename})`);
      } catch (e) {
        console.error(`[Delete Error] ${dup.id}:`, e.message);
      }
    }

    await saveGalleryDb(cleanList);
    console.log(`Database successfully cleaned! Remaining unique photos: ${cleanList.length}`);
  } else {
    console.log('\nNo duplicate photo records found.');
  }
}

inspectAndClean().catch(err => console.error('Inspection error:', err));
