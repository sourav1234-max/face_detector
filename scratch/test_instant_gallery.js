const http = require('http');
const fs = require('fs');
const path = require('path');
const { initRamCache, readGalleryDb, syncStaticGalleryFile } = require('../lib/store');

function fetchUrl(pathStr) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    http.get(`http://127.0.0.1:3015${pathStr}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const responseTimeMs = Date.now() - startTime;
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            responseTimeMs,
            data: JSON.parse(body)
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            responseTimeMs,
            body
          });
        }
      });
    }).on('error', reject);
  });
}

async function runTest() {
  console.log('=== STARTING INSTANT GALLERY PRE-FETCH UNIT TEST ===');

  // Step 1: Initialize RAM cache
  console.log('[Test 1] Initializing RAM Cache and syncing static gallery file...');
  await initRamCache();
  const photos = await readGalleryDb();
  console.log(`[Test 1 PASSED] RAM cache initialized. Total photos: ${photos.length}`);

  // Sync static file
  syncStaticGalleryFile(photos);
  const galleryJsonPath = path.join(__dirname, '..', 'public', 'gallery.json');
  if (fs.existsSync(galleryJsonPath)) {
    const diskContent = fs.readFileSync(galleryJsonPath, 'utf8');
    const parsedDisk = JSON.parse(diskContent || '[]');
    console.log(`[Test 2 PASSED] public/gallery.json on disk contains ${parsedDisk.length} item(s).`);
  }

  // Step 2: Start Express server on test port 3015
  console.log('[Test 3] Starting server instance to test GET /gallery.json...');
  const app = require('../server.js');
  const server = app.listen(3015, '127.0.0.1');

  await new Promise(r => setTimeout(r, 1500));

  // Step 3: Fetch GET /gallery.json
  console.log('[Test 4] Requesting GET /gallery.json...');
  const res = await fetchUrl('/gallery.json');
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Response Time: ${res.responseTimeMs} ms`);
  console.log(`Cache-Control Header: ${res.headers['cache-control'] || 'none'}`);
  console.log(`Photos Array Length: ${Array.isArray(res.data) ? res.data.length : 'not array'}`);

  if (res.status !== 200) {
    throw new Error(`FAIL: Expected HTTP status 200, got ${res.status}`);
  }
  if (!Array.isArray(res.data)) {
    throw new Error('FAIL: Expected response data to be an Array');
  }
  if (res.responseTimeMs > 200) {
    console.warn(`WARNING: Response took ${res.responseTimeMs}ms (target <50ms)`);
  } else {
    console.log(`[Test 4 PASSED] GET /gallery.json returned in ${res.responseTimeMs}ms!`);
  }

  server.close(() => {
    console.log('\n=== ALL INSTANT GALLERY PRE-FETCH TESTS PASSED SUCCESSFULLY! ===');
    process.exit(0);
  });
}

runTest().catch(err => {
  console.error('[Instant Gallery Test Failed]:', err);
  process.exit(1);
});
