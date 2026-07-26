const path = require('path');
const {
  initRamCache,
  refreshRamCache,
  getCacheStatus,
  getMetrics,
  getHAStatus,
  setActiveBackend,
  toggleAutoFailover,
  readGalleryDb,
  readEventsDb
} = require('../lib/store');

async function runTests() {
  console.log('=== STARTING DUAL BACKEND HA & RAM CACHE TEST ===');

  console.log('1. Initializing RAM Cache...');
  await initRamCache();

  const cacheStatus = getCacheStatus();
  console.log('Cache Status:', JSON.stringify(cacheStatus, null, 2));

  const haStatus = getHAStatus();
  console.log('HA Status:', JSON.stringify(haStatus, null, 2));

  const metricsBefore = getMetrics();
  console.log('Metrics Before Reads:', JSON.stringify(metricsBefore, null, 2));

  console.log('2. Performing 5 consecutive read operations...');
  for (let i = 0; i < 5; i++) {
    await readGalleryDb();
    await readEventsDb();
  }

  const metricsAfter = getMetrics();
  console.log('Metrics After 10 Read Ops:', JSON.stringify(metricsAfter, null, 2));
  console.log(`RAM Cache Hits: ${metricsAfter.ramCacheHits}`);
  console.log(`Firestore Reads: ${metricsAfter.firestoreReads}`);

  console.log('3. Testing HA Backend Switch to RENDER...');
  await setActiveBackend('render', 'Automated test switch to Render');
  console.log('HA Status after switch to Render:', JSON.stringify(getHAStatus(), null, 2));

  console.log('4. Testing HA Backend Switch back to RAILWAY...');
  await setActiveBackend('railway', 'Automated test switch back to Railway');
  console.log('HA Status after switch to Railway:', JSON.stringify(getHAStatus(), null, 2));

  console.log('=== TEST COMPLETED SUCCESSFULLY ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
