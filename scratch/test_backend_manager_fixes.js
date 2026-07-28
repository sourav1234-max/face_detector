/**
 * Comprehensive Automated Verification Script for Dual Backend Manager Fixes
 */

const fs = require('fs');
const path = require('path');

// Read backend-manager.js source
const scriptPath = path.join(__dirname, '../public/js/backend-manager.js');
const sourceCode = fs.readFileSync(scriptPath, 'utf8');

let mockListeners = [];
let fetchMocks = {};
let consoleLogs = [];
let consoleWarns = [];
let consoleErrors = [];

function createMockEnvironment(hostname = 'localhost') {
  mockListeners = [];
  fetchMocks = {};
  consoleLogs = [];
  consoleWarns = [];
  consoleErrors = [];

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

  const customConsole = {
    log: (...args) => consoleLogs.push(args.join(' ')),
    warn: (...args) => consoleWarns.push(args.join(' ')),
    error: (...args) => consoleErrors.push(args.join(' '))
  };

  // Evaluate script in isolated context
  const evalFn = new Function('window', 'global', 'navigator', 'fetch', 'localStorage', 'console', sourceCode);
  evalFn(mockWindow, mockWindow, mockNavigator, mockFetch, mockLocalStorage, customConsole);

  return { mockWindow, mockFetch };
}

async function runTests() {
  console.log('===========================================================');
  console.log('   RUNNING ENHANCED DUAL BACKEND MANAGER RELIABILITY TESTS  ');
  console.log('===========================================================\n');

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

  // --- Test 1: Startup Validation on Vercel ---
  console.log('--- Test 1: Startup Validation on Vercel ---');
  {
    createMockEnvironment('my-app.vercel.app');
    const hasVercelErr = consoleErrors.some(m => m.includes('Railway URL is not configured') && m.includes('running on Vercel'));
    assert(hasVercelErr, 'Startup validation outputs error log when RAILWAY_URL is missing on Vercel');
  }

  // --- Test 2: Localhost Origin Fallback ---
  console.log('\n--- Test 2: Localhost Origin Fallback ---');
  {
    const { mockWindow } = createMockEnvironment('localhost');
    const BM = mockWindow.BackendManager;
    const stats = BM.getStats();
    assert(stats.railway.url === 'https://localhost', 'Railway URL falls back to location.origin on same server/localhost');
  }

  // --- Test 3: HTTP 503 Passive Mode Does NOT Mutate Global Routing ---
  console.log('\n--- Test 3: HTTP 503 Passive Mode Isolation ---');
  {
    const { mockWindow } = createMockEnvironment('my-app.vercel.app');
    const BM = mockWindow.BackendManager;
    BM.updateConfig({
      mode: 'auto',
      autoFailover: true,
      railwayUrl: 'https://railway-primary.up.railway.app',
      renderUrl: 'https://render-backup.onrender.com'
    });

    // Mock Railway health check online, but /api/data returns 503 passive mode recommending render
    fetchMocks['railway-primary.up.railway.app'] = async (url) => {
      if (url.includes('/api/health')) {
        return { ok: true, status: 200, json: async () => ({ uptimeSeconds: 100 }) };
      }
      return {
        ok: false,
        status: 503,
        json: async () => ({ passive: true, activeBackend: 'render' }),
        clone: function() { return this; }
      };
    };

    fetchMocks['render-backup.onrender.com'] = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: 'from_render' }),
      clone: function() { return this; }
    });

    await BM.checkHealth();
    assert(BM.getStats().currentActive === 'railway', 'Before passive request: currentActive is railway');

    const res = await BM.fetch('/api/data');
    const json = await res.json();
    assert(json.data === 'from_render', 'Passive request retried on Render successfully');
    assert(BM.getStats().currentActive === 'railway', 'After 503 passive request: currentActive MUST STILL be railway');
  }

  // --- Test 4: Single Request Failure Does NOT Mark Railway Offline ---
  console.log('\n--- Test 4: Health Status Separation (No Immediate Offline Mutation) ---');
  {
    const { mockWindow } = createMockEnvironment('my-app.vercel.app');
    const BM = mockWindow.BackendManager;
    BM.updateConfig({
      mode: 'auto',
      autoFailover: true,
      railwayUrl: 'https://railway.up.railway.app',
      renderUrl: 'https://render.onrender.com'
    });

    // Railway health check returns 200 online, but request to /api/error returns 500
    fetchMocks['railway.up.railway.app'] = async (url) => {
      if (url.includes('/api/health')) {
        return { ok: true, status: 200, json: async () => ({ uptimeSeconds: 500 }) };
      }
      return { ok: false, status: 500, json: async () => ({ error: 'Internal server error' }), clone: function() { return this; } };
    };

    fetchMocks['render.onrender.com'] = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: 'render_ok' }),
      clone: function() { return this; }
    });

    await BM.checkHealth();
    assert(BM.getStats().railway.status === 'online', 'Health status is online before failed request');

    // Make request that returns 500
    await BM.fetch('/api/error');
    assert(BM.getStats().railway.status === 'online', 'Health status remains online after single 500 request failure (does NOT force offline)');
  }

  // --- Test 5: Health Check Priority & Recovery ---
  console.log('\n--- Test 5: Health Check Priority & Recovery ---');
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

    // Phase B: Railway comes back online -> checkHealth restores Railway after recovery threshold (2 consecutive healthy checks)
    fetchMocks['railway.up.railway.app'] = async () => ({ ok: true, status: 200, json: async () => ({ uptimeSeconds: 200 }) });

    await BM.checkHealth();
    await BM.checkHealth();
    assert(BM.getStats().currentActive === 'railway', 'Phase B: Railway back online -> active restored to railway after recovery threshold');
  }

  console.log('\n===========================================================');
  console.log(`   TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===========================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test Suite Exception:', err);
  process.exit(1);
});
