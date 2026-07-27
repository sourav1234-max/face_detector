/**
 * Automated Verification Script for Dual Backend Manager Fixes
 */

const fs = require('fs');
const path = require('path');

// Read backend-manager.js source
const scriptPath = path.join(__dirname, '../public/js/backend-manager.js');
const sourceCode = fs.readFileSync(scriptPath, 'utf8');

let mockListeners = [];
let fetchMocks = {};

function createMockEnvironment(hostname = 'localhost') {
  mockListeners = [];
  fetchMocks = {};

  const localStorageData = {};
  const mockLocalStorage = {
    getItem: (key) => localStorageData[key] || null,
    setItem: (key, val) => { localStorageData[key] = String(val); },
    removeItem: (key) => { delete localStorageData[key]; }
  };

  const mockWindow = {
    location: {
      origin: `https://${hostname}`,
      hostname: hostname
    },
    localStorage: mockLocalStorage,
    sessionStorage: mockLocalStorage,
    dispatchEvent: (event) => {
      mockListeners.push(event);
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const mockNavigator = { onLine: true };

  // Global fetch mock
  const mockFetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (fetchMocks[urlStr]) {
      return fetchMocks[urlStr](url, options);
    }
    // Pattern matching
    for (const [pattern, handler] of Object.entries(fetchMocks)) {
      if (urlStr.includes(pattern)) {
        return handler(url, options);
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
      clone: function() { return this; }
    };
  };

  // Evaluate script in isolated context
  const evalFn = new Function('window', 'global', 'navigator', 'fetch', 'localStorage', sourceCode);
  evalFn(mockWindow, mockWindow, mockNavigator, mockFetch, mockLocalStorage);

  return { mockWindow, mockFetch };
}

async function runTests() {
  console.log('====================================================');
  console.log('   RUNNING DUAL BACKEND MANAGER VERIFICATION TESTS   ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      failed++;
    }
  }

  // --- Test 1: Vercel Origin Prevention ---
  console.log('--- Test 1: Vercel Origin Prevention ---');
  {
    const { mockWindow } = createMockEnvironment('my-app.vercel.app');
    const BM = mockWindow.BackendManager;
    const stats = BM.getStats();
    assert(stats.railway.url === '', 'Railway URL defaults to empty on Vercel (not Vercel origin)');

    BM.updateConfig({ railwayUrl: 'https://my-railway-app.up.railway.app' });
    const updatedStats = BM.getStats();
    assert(updatedStats.railway.url === 'https://my-railway-app.up.railway.app', 'Explicit Railway URL is respected on Vercel');
  }

  // --- Test 2: Localhost Origin Fallback ---
  console.log('\n--- Test 2: Localhost Origin Fallback ---');
  {
    const { mockWindow } = createMockEnvironment('localhost');
    const BM = mockWindow.BackendManager;
    const stats = BM.getStats();
    assert(stats.railway.url === 'https://localhost', 'Railway URL falls back to location.origin on same server/localhost');
  }

  // --- Test 3: Per-Request Failover Isolation (Does NOT lock currentActive to Render) ---
  console.log('\n--- Test 3: Per-Request Failover Isolation ---');
  {
    const { mockWindow } = createMockEnvironment('my-app.vercel.app');
    const BM = mockWindow.BackendManager;
    BM.updateConfig({
      mode: 'auto',
      autoFailover: true,
      railwayUrl: 'https://railway-primary.up.railway.app',
      renderUrl: 'https://render-backup.onrender.com'
    });

    // Mock Railway health check & request failure, Render success
    fetchMocks['railway-primary.up.railway.app'] = async (url) => {
      if (url.includes('/api/health')) {
        return { ok: true, status: 200, json: async () => ({ uptimeSeconds: 100 }) };
      }
      throw new Error('Railway connection reset');
    };

    fetchMocks['render-backup.onrender.com'] = async (url) => {
      return { ok: true, status: 200, json: async () => ({ data: 'from_render' }), clone: function() { return this; } };
    };

    // Initialize health check
    await BM.checkHealth();
    assert(BM.getStats().currentActive === 'railway', 'Before request: currentActive is railway');

    // Perform haFetch request - Railway will fail, failover to Render
    const res = await BM.fetch('/api/data');
    const json = await res.json();
    assert(json.data === 'from_render', 'Request succeeded via Render failover');
    assert(BM.getStats().currentActive === 'railway', 'After failover: currentActive MUST STILL be railway (not permanently changed!)');
  }

  // --- Test 4: Priority & Recovery in Health Check ---
  console.log('\n--- Test 4: Health Check Priority & Recovery ---');
  {
    const { mockWindow } = createMockEnvironment('my-app.vercel.app');
    const BM = mockWindow.BackendManager;
    BM.updateConfig({
      mode: 'auto',
      railwayUrl: 'https://railway.up.railway.app',
      renderUrl: 'https://render.onrender.com'
    });

    // Phase A: Railway offline, Render online -> currentActive becomes 'render'
    fetchMocks['railway.up.railway.app'] = async () => ({ ok: false, status: 502 });
    fetchMocks['render.onrender.com'] = async () => ({ ok: true, status: 200, json: async () => ({ uptimeSeconds: 50 }) });

    await BM.checkHealth();
    assert(BM.getStats().currentActive === 'render', 'Phase A: Railway offline -> active switches to render');

    // Phase B: Railway comes back online -> checkHealth MUST immediately restore Railway
    fetchMocks['railway.up.railway.app'] = async () => ({ ok: true, status: 200, json: async () => ({ uptimeSeconds: 200 }) });

    await BM.checkHealth();
    assert(BM.getStats().currentActive === 'railway', 'Phase B: Railway back online -> active immediately restored to railway');
  }

  console.log('\n====================================================');
  console.log(`   TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test Suite Exception:', err);
  process.exit(1);
});
