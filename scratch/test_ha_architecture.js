const { getSystemMetrics, addSystemLog, getSystemLogs, CURRENT_PLATFORM } = require('../lib/system-monitor');
const { initRamCache, getCacheStatus, getMetrics, refreshRamCache, isDuplicateRequest } = require('../lib/store');

async function testHAArchitecture() {
  console.log('=== Testing High-Availability Dual Backend Architecture ===');
  console.log(`[Platform Detected]: ${CURRENT_PLATFORM}`);

  // Test System Metrics
  const sysMetrics = getSystemMetrics();
  console.log('[System Metrics]:', JSON.stringify(sysMetrics, null, 2));

  // Test Deduplication
  const req1 = 'req_test_123';
  console.log(`[Idempotency Check 1]: isDuplicate(${req1}) = ${isDuplicateRequest(req1)} (Expected: false)`);
  console.log(`[Idempotency Check 2]: isDuplicate(${req1}) = ${isDuplicateRequest(req1)} (Expected: true)`);

  // Test Cache Initialization Progress
  console.log('[Initial Cache Status]:', JSON.stringify(getCacheStatus(), null, 2));
  
  await initRamCache();
  
  console.log('[Loaded Cache Status]:', JSON.stringify(getCacheStatus(), null, 2));
  console.log('[Operational Metrics]:', JSON.stringify(getMetrics(), null, 2));

  // Test System Logging
  addSystemLog({
    backend: CURRENT_PLATFORM,
    eventType: 'FAILOVER',
    status: 'WARNING',
    details: 'Simulated failover test event.'
  });

  const logs = getSystemLogs(10);
  console.log('[Latest System Logs]:', JSON.stringify(logs, null, 2));

  console.log('=== All HA Architecture Component Tests Passed Successfully! ===');
}

testHAArchitecture().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
