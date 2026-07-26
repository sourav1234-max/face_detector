const { initRamCache, getCacheStatus } = require('../lib/store');
const { getFirebaseStatus } = require('../lib/firebase');

async function testTelemetry() {
  console.log('=== Testing Firebase Status ===');
  const fbStatus = getFirebaseStatus();
  console.log('Firebase Status:', JSON.stringify(fbStatus, null, 2));

  console.log('\n=== Testing RAM Cache Initialization ===');
  await initRamCache();
  const cacheStatus = getCacheStatus();
  console.log('Cache Status:', JSON.stringify(cacheStatus, null, 2));

  console.log('\n=== Telemetry Tests Passed ===');
}

testTelemetry().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
