/**
 * Railway Backend Manager
 * Controls Railway routing, health pings, request ID tracking,
 * and unified client-side fetch wrapper.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'ha_backend_config_v1';

  // Default Configuration (Railway Only)
  const config = {
    mode: 'railway',       // Fixed to Railway
    autoFailover: false,
    railwayUrl: typeof window !== 'undefined' && (window.RAILWAY_URL || (window.ENV && window.ENV.RAILWAY_URL)) ? (window.RAILWAY_URL || window.ENV.RAILWAY_URL) : '',
    pingIntervalMs: 30000 // Background health check interval (30s default)
  };

  // Load saved configuration from localStorage
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.railwayUrl) config.railwayUrl = parsed.railwayUrl;
    }
  } catch (err) {
    console.warn('[BackendManager] Failed to load stored config:', err);
  }

  // Health & Metric Tracking State
  const backendStats = {
    railway: {
      url: config.railwayUrl || '',
      status: 'unknown', // 'online' | 'offline' | 'loading'
      responseTimeMs: 0,
      uptimeSeconds: 0,
      activeRequests: 0,
      lastCheckTime: null,
      error: null
    },
    currentActive: 'railway',
    isFailingOver: false
  };

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      console.warn('[BackendManager] Failed to save config:', err);
    }
  }

  function normalizeUrl(url) {
    if (!url || url.trim() === '') return '';
    let cleaned = url.trim().replace(/\/$/, '');
    if (!/^https?:\/\//i.test(cleaned)) {
      cleaned = 'https://' + cleaned;
    }
    return cleaned;
  }

  function isSameServer() {
    if (typeof window === 'undefined' || !window.location) return false;
    const hostname = (window.location.hostname || '').toLowerCase();
    if (hostname.endsWith('.vercel.app') || hostname.includes('vercel')) {
      return false;
    }
    return true;
  }

  function getRailwayBaseUrl() {
    const configured = config.railwayUrl || (typeof window !== 'undefined' && (window.RAILWAY_URL || (window.ENV && window.ENV.RAILWAY_URL)));
    if (configured && configured.trim() !== '') {
      return normalizeUrl(configured);
    }
    if (isSameServer()) {
      return window.location.origin;
    }
    return '';
  }

  function validateStartupConfig() {
    const railwayBase = getRailwayBaseUrl();
    const onVercel = !isSameServer();

    if (onVercel && !railwayBase) {
      console.warn('[BackendManager] Railway URL is not explicitly set. Requests will use relative paths or default endpoints.');
    } else if (railwayBase) {
      console.log(`[BackendManager] Railway Backend URL: ${railwayBase}`);
    }
  }

  function getTargetUrl(path) {
    const baseUrl = getRailwayBaseUrl();
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

  // Ping Railway Backend Endpoint for Health & Response Latency
  async function pingRailway() {
    const baseUrl = getRailwayBaseUrl();
    const stats = backendStats.railway;
    stats.url = baseUrl;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      stats.status = 'offline';
      stats.error = 'Browser network is offline';
      notifyListeners('backend:health-updated', { backend: 'railway', stats });
      return stats;
    }

    const healthUrl = (baseUrl ? baseUrl : '') + '/api/health?t=' + Date.now();
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
        stats.uptimeSeconds = data.uptimeSeconds || Math.floor((Date.now() - startTime) / 1000);
        stats.activeRequests = data.activeRequests || 0;
        stats.error = null;
      } else {
        stats.status = 'offline';
        stats.error = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (err) {
      stats.status = 'offline';
      stats.error = err.name === 'AbortError' ? 'Health check timed out (8s)' : err.message;
    }

    stats.lastCheckTime = new Date().toISOString();
    notifyListeners('backend:health-updated', { backend: 'railway', stats });
    return stats;
  }

  async function checkHealthAll() {
    await pingRailway();
    notifyListeners('backend:routing-changed', {
      activeBackend: 'railway',
      stats: backendStats
    });
    return backendStats;
  }

  let healthIntervalId = null;
  function startHealthPingLoop() {
    if (healthIntervalId) clearInterval(healthIntervalId);
    healthIntervalId = setInterval(() => {
      pingRailway().catch(() => {});
    }, config.pingIntervalMs);
  }

  startHealthPingLoop();

  /**
   * Unified Single-Backend Fetch Wrapper
   * Attaches Request ID, Railway target URL, and passcode header.
   */
  async function haFetch(urlPath, options = {}) {
    const reqId = generateRequestId();
    const targetUrl = getTargetUrl(urlPath);

    const headers = new Headers(options.headers || {});
    if (!headers.has('x-request-id')) {
      headers.set('x-request-id', reqId);
    }
    if (!headers.has('x-backend-platform')) {
      headers.set('x-backend-platform', 'RAILWAY');
    }

    const passcode = localStorage.getItem('facematch_event_passcode');
    if (passcode && !headers.has('x-event-passcode')) {
      headers.set('x-event-passcode', passcode);
    }

    const modifiedOptions = { ...options, headers };

    backendStats.railway.activeRequests++;

    try {
      const res = await fetch(targetUrl, modifiedOptions);
      backendStats.railway.activeRequests = Math.max(0, backendStats.railway.activeRequests - 1);
      return res;
    } catch (err) {
      backendStats.railway.activeRequests = Math.max(0, backendStats.railway.activeRequests - 1);
      throw err;
    }
  }

  // Handle Toast Notifications for Online/Offline
  let networkToastTimer = null;
  function showNetworkToast(online, text) {
    let toast = document.getElementById('ha-network-status-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ha-network-status-toast';
      toast.style.position = 'fixed';
      toast.style.bottom = '20px';
      toast.style.right = '20px';
      toast.style.zIndex = '999999';
      toast.style.padding = '12px 20px';
      toast.style.borderRadius = '8px';
      toast.style.fontWeight = '600';
      toast.style.fontSize = '14px';
      toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.3)';
      toast.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      document.body.appendChild(toast);
    }

    if (online) {
      toast.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      toast.style.color = '#ffffff';
      toast.innerHTML = `<i class="fa-solid fa-wifi" style="margin-right:8px;"></i> ${text}`;
    } else {
      toast.style.background = 'linear-gradient(135deg, #dc2626, #f87171)';
      toast.style.color = '#ffffff';
      toast.innerHTML = `<i class="fa-solid fa-plane-slash" style="margin-right:8px;"></i> ${text}`;
    }

    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    if (networkToastTimer) clearTimeout(networkToastTimer);
    if (online) {
      networkToastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
      }, 4000);
    }
  }

  // Handle Browser Online/Offline Events
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      console.log('[BackendManager] Browser back online.');
      showNetworkToast(true, 'Connection Restored — Online');
      checkHealthAll();
      notifyListeners('backend:network-status', { online: true });
    });

    window.addEventListener('offline', () => {
      console.warn('[BackendManager] Browser network connection lost (Offline).');
      showNetworkToast(false, 'Network Offline — Check Internet');
      backendStats.railway.status = 'offline';
      backendStats.railway.error = 'Browser network offline';
      notifyListeners('backend:health-updated', { backend: 'railway', stats: backendStats.railway });
      notifyListeners('backend:network-status', { online: false });
    });
  }

  validateStartupConfig();
  checkHealthAll().catch(() => {});

  // Expose API on window.BackendManager
  global.BackendManager = {
    getConfig: () => ({ ...config }),
    updateConfig: (newCfg) => {
      if (newCfg.railwayUrl !== undefined) config.railwayUrl = newCfg.railwayUrl;
      saveConfig();
      checkHealthAll();
      return { ...config };
    },
    getStats: () => ({ ...backendStats }),
    isOnline: () => typeof navigator !== 'undefined' ? navigator.onLine : true,
    checkHealth: checkHealthAll,
    fetch: haFetch,
    getBackendUrl: getRailwayBaseUrl
  };

})(typeof window !== 'undefined' ? window : this);
