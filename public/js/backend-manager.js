/**
 * Dual Backend & High Availability (HA) Manager
 * Controls Railway (Primary) and Render (Backup) routing, automatic health pings,
 * client-side failover retry logic, and request ID tracking.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'ha_backend_config_v1';

  // Default Configuration
  const config = {
    mode: 'auto',         // 'auto' | 'railway' | 'render'
    autoFailover: true,   // Automatically retry request on Render if Railway fails
    railwayUrl: '',       // Custom Railway URL override (defaults to current origin if on Railway)
    renderUrl: '',        // Render backup backend URL (e.g., https://app.onrender.com)
    pingIntervalMs: 15000 // Background health check interval (15s)
  };

  // Load saved configuration from localStorage
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      Object.assign(config, JSON.parse(saved));
    }
  } catch (err) {
    console.warn('[BackendManager] Failed to load stored config:', err);
  }

  // Health & Metric Tracking State
  const backendStats = {
    railway: {
      url: config.railwayUrl || window.location.origin,
      status: 'unknown', // 'online' | 'offline' | 'loading'
      responseTimeMs: 0,
      uptimeSeconds: 0,
      activeRequests: 0,
      lastCheckTime: null,
      error: null
    },
    render: {
      url: config.renderUrl || '',
      status: 'unknown',
      responseTimeMs: 0,
      uptimeSeconds: 0,
      activeRequests: 0,
      lastCheckTime: null,
      error: null
    },
    currentActive: 'railway', // 'railway' | 'render'
    isFailingOver: false
  };

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      console.warn('[BackendManager] Failed to save config:', err);
    }
  }

  function getRailwayBaseUrl() {
    if (config.railwayUrl && config.railwayUrl.trim() !== '') {
      return config.railwayUrl.replace(/\/$/, '');
    }
    return window.location.origin;
  }

  function getRenderBaseUrl() {
    if (config.renderUrl && config.renderUrl.trim() !== '') {
      return config.renderUrl.replace(/\/$/, '');
    }
    return '';
  }

  function getTargetUrl(path, backendKey) {
    const baseUrl = backendKey === 'render' ? getRenderBaseUrl() : getRailwayBaseUrl();
    if (!baseUrl) return path;
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    return baseUrl + cleanPath;
  }

  function generateRequestId() {
    return 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  }

  function notifyListeners(eventName, detail) {
    try {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    } catch (e) { }
  }

  // Ping a Single Backend Endpoint for Health & Response Latency
  async function pingBackend(backendKey) {
    const baseUrl = backendKey === 'render' ? getRenderBaseUrl() : getRailwayBaseUrl();
    const stats = backendStats[backendKey];
    stats.url = baseUrl;

    if (!baseUrl) {
      stats.status = 'offline';
      stats.error = 'URL not configured';
      return stats;
    }

    const healthUrl = baseUrl + '/api/health?t=' + Date.now();
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(healthUrl, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const latency = Date.now() - startTime;

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        stats.status = 'online';
        stats.responseTimeMs = latency;
        stats.uptimeSeconds = data.uptimeSeconds || 0;
        stats.activeRequests = data.activeRequests || 0;
        stats.lastCheckTime = new Date().toISOString();
        stats.error = null;
      } else {
        stats.status = 'offline';
        stats.error = `HTTP ${res.status}`;
      }
    } catch (err) {
      stats.status = 'offline';
      stats.responseTimeMs = 0;
      stats.error = err.name === 'AbortError' ? 'Timeout (8s)' : (err.message || 'Network error');
    }

    notifyListeners('backend:health-updated', { backend: backendKey, stats });
    return stats;
  }

  // Perform Health Checks on Both Backends
  async function checkHealthAll() {
    await Promise.all([
      pingBackend('railway'),
      pingBackend('render')
    ]);

    // Evaluate failover state if mode is auto
    if (config.mode === 'auto') {
      if (backendStats.railway.status === 'offline' && backendStats.render.status === 'online') {
        if (backendStats.currentActive !== 'render') {
          backendStats.currentActive = 'render';
          notifyListeners('backend:switched', { active: 'render', reason: 'Railway offline, switched to Render' });
        }
      } else if (backendStats.railway.status === 'online') {
        if (backendStats.currentActive !== 'railway') {
          backendStats.currentActive = 'railway';
          notifyListeners('backend:switched', { active: 'railway', reason: 'Railway healthy, restored primary' });
        }
      }
    }

    return backendStats;
  }

  // Enhanced Fetch Wrapper with Failover and Request ID
  async function haFetch(urlPath, options = {}) {
    const reqId = generateRequestId();
    
    // Copy plain object headers safely without destroying Content-Type
    const headersObj = {};
    if (options.headers) {
      if (typeof options.headers.forEach === 'function') {
        options.headers.forEach((val, key) => { headersObj[key] = val; });
      } else if (typeof options.headers === 'object') {
        Object.assign(headersObj, options.headers);
      }
    }
    headersObj['X-Request-ID'] = reqId;

    const requestOptions = {
      ...options,
      headers: headersObj
    };

    // Determine primary attempt backend
    let primaryBackend = 'railway';
    if (config.mode === 'render') {
      primaryBackend = 'render';
    } else if (config.mode === 'railway') {
      primaryBackend = 'railway';
    } else {
      // Auto mode: use current active health recommendation
      primaryBackend = backendStats.currentActive;
    }

    const secondaryBackend = primaryBackend === 'railway' ? 'render' : 'railway';

    // Primary attempt
    const primaryUrl = getTargetUrl(urlPath, primaryBackend);
    let primaryError = null;

    try {
      const controller = new AbortController();
      const timeoutMs = options.timeout || 12000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(primaryUrl, {
        ...requestOptions,
        signal: options.signal || controller.signal
      });
      clearTimeout(timeoutId);

      // If response is successful or client-side error (4xx), return it directly
      if (res.status < 500) {
        return res;
      }

      primaryError = new Error(`Server returned HTTP ${res.status}`);

    } catch (err) {
      primaryError = err;
    }

    // If primary attempt succeeded or failover is disabled or no backup URL configured, throw/return error
    const backupUrl = getTargetUrl(urlPath, secondaryBackend);
    if (!config.autoFailover || !getRenderBaseUrl() || primaryUrl === backupUrl) {
      if (primaryError) throw primaryError;
    }

    // Trigger Automatic Failover Retry
    console.warn(`[BackendManager] Primary backend (${primaryBackend}) failed (${primaryError.message}). Retrying on secondary backend (${secondaryBackend})...`);

    backendStats.isFailingOver = true;
    notifyListeners('backend:failover', {
      from: primaryBackend,
      to: secondaryBackend,
      reason: primaryError.message,
      url: urlPath
    });

    try {
      const secondaryController = new AbortController();
      const secondaryTimeout = setTimeout(() => secondaryController.abort(), 12000);

      const backupRes = await fetch(backupUrl, {
        ...requestOptions,
        signal: secondaryController.signal
      });
      clearTimeout(secondaryTimeout);

      backendStats.isFailingOver = false;
      backendStats.currentActive = secondaryBackend;
      return backupRes;

    } catch (secondaryErr) {
      backendStats.isFailingOver = false;
      console.error(`[BackendManager] Both backends failed for ${urlPath}!`, secondaryErr);
      throw new Error(`Both Railway and Render backends are unavailable (${primaryError.message} / ${secondaryErr.message})`);
    }
  }

  // Start background health ping loop
  checkHealthAll().catch(() => {});
  setInterval(() => {
    checkHealthAll().catch(() => {});
  }, config.pingIntervalMs);

  // Expose API on window.BackendManager
  global.BackendManager = {
    getConfig: () => ({ ...config }),
    updateConfig: (newCfg) => {
      Object.assign(config, newCfg);
      saveConfig();
      checkHealthAll();
      return { ...config };
    },
    getStats: () => ({ ...backendStats }),
    checkHealth: checkHealthAll,
    fetch: haFetch
  };

})(typeof window !== 'undefined' ? window : this);
