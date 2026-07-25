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

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      stats.status = 'offline';
      stats.error = 'Browser network is offline';
      notifyListeners('backend:health-updated', { backend: backendKey, stats });
      return stats;
    }

    if (!baseUrl) {
      stats.status = 'offline';
      stats.error = 'URL not configured';
      notifyListeners('backend:health-updated', { backend: backendKey, stats });
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

    const token = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('admin_token')
      : (typeof localStorage !== 'undefined' ? localStorage.getItem('admin_token') : null);
    if (token && !headersObj['Authorization']) {
      headersObj['Authorization'] = `Bearer ${token}`;
    }

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

  // --- Server RAM Cache Hydration Progress Overlay ---
  let cacheOverlayPollTimer = null;

  function createOverlayDom() {
    if (document.getElementById('ram-cache-loader-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'ram-cache-loader-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(10, 15, 29, 0.96);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: opacity 0.4s ease, visibility 0.4s ease;
    `;

    overlay.innerHTML = `
      <div style="max-width: 440px; width: 90%; background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 16px; padding: 32px 28px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); text-align: center;">
        <div style="width: 64px; height: 64px; margin: 0 auto 20px; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 28px; color: #38bdf8;">
          <i class="fa-solid fa-server fa-spin" style="--fa-animation-duration: 3s;"></i>
        </div>
        <div id="ram-cache-platform-badge" style="display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; tracking: 1px; color: #38bdf8; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 20px; padding: 4px 12px; margin-bottom: 12px;">
          Initial Startup
        </div>
        <h3 style="font-size: 20px; font-weight: 700; margin: 0 0 8px; color: #f8fafc;">Hydrating In-Memory Cache</h3>
        <p style="font-size: 13px; color: #94a3b8; margin: 0 0 24px; line-height: 1.5;">
          Loading metadata, face descriptors, and catalog indexes into server RAM for zero-latency searches.
        </p>

        <!-- Progress Bar -->
        <div style="width: 100%; height: 10px; background: rgba(255, 255, 255, 0.08); border-radius: 10px; overflow: hidden; margin-bottom: 12px; position: relative;">
          <div id="ram-cache-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #38bdf8, #818cf8, #c084fc); border-radius: 10px; transition: width 0.3s ease;"></div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; color: #cbd5e1; margin-bottom: 16px;">
          <span id="ram-cache-stage-text">Connecting to database...</span>
          <span id="ram-cache-percent-text" style="color: #38bdf8; font-size: 14px;">0%</span>
        </div>

        <div id="ram-cache-detail-sub" style="font-size: 11.5px; color: #64748b; font-family: monospace;">
          Initializing RAM Cache Engine...
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
  }

  function updateOverlay(cache, platform) {
    createOverlayDom();
    const progress = cache.progress || {};
    const percent = progress.percent || (cache.isInitialized ? 100 : 0);
    const stage = progress.stage || 'Loading metadata...';

    const bar = document.getElementById('ram-cache-progress-bar');
    const stageEl = document.getElementById('ram-cache-stage-text');
    const percentEl = document.getElementById('ram-cache-percent-text');
    const detailEl = document.getElementById('ram-cache-detail-sub');
    const badgeEl = document.getElementById('ram-cache-platform-badge');

    if (bar) bar.style.width = percent + '%';
    if (stageEl) stageEl.innerText = stage;
    if (percentEl) percentEl.innerText = percent + '%';
    if (badgeEl && platform) badgeEl.innerText = `${platform} Backend Readying`;

    if (detailEl) {
      if (progress.loadedPhotos !== undefined) {
        detailEl.innerText = `Photos: ${progress.loadedPhotos || 0} | Descriptors: ${progress.loadedDescriptors || 0} | Events: ${progress.loadedEvents || 0}`;
      }
    }

    if (cache.isInitialized || percent >= 100) {
      removeOverlay();
    }
  }

  function removeOverlay() {
    if (cacheOverlayPollTimer) {
      clearInterval(cacheOverlayPollTimer);
      cacheOverlayPollTimer = null;
    }
    const overlay = document.getElementById('ram-cache-loader-overlay');
    if (overlay) {
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 400);
    }
  }

  async function checkCacheProgressLoop() {
    try {
      const res = await fetch('/api/cache/progress?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.cache) {
          if (!data.cache.isInitialized) {
            updateOverlay(data.cache, data.platform);
          } else {
            removeOverlay();
          }
        }
      }
    } catch (e) {}
  }

  // Check progress immediately on DOM ready
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        checkCacheProgressLoop();
        cacheOverlayPollTimer = setInterval(checkCacheProgressLoop, 400);
      });
    } else {
      checkCacheProgressLoop();
      cacheOverlayPollTimer = setInterval(checkCacheProgressLoop, 400);
    }
  }

  // --- Floating Network Status Toast Notification ---
  let networkToastTimer = null;

  function showNetworkToast(isOnline, message) {
    if (typeof document === 'undefined') return;
    let toast = document.getElementById('ha-network-status-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ha-network-status-toast';
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 18px;
        border-radius: 30px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        transition: opacity 0.3s ease, transform 0.3s ease, visibility 0.3s ease;
        pointer-events: none;
        opacity: 0;
        transform: translateY(20px);
      `;
      document.body.appendChild(toast);
    }

    if (networkToastTimer) {
      clearTimeout(networkToastTimer);
      networkToastTimer = null;
    }

    if (isOnline) {
      toast.style.background = 'rgba(16, 185, 129, 0.92)';
      toast.style.color = '#ffffff';
      toast.style.border = '1px solid rgba(52, 211, 153, 0.5)';
      toast.innerHTML = `<i class="fa-solid fa-wifi" style="font-size:14px;"></i> <span>${message || 'Network Reconnected — Online'}</span>`;
    } else {
      toast.style.background = 'rgba(239, 68, 68, 0.94)';
      toast.style.color = '#ffffff';
      toast.style.border = '1px solid rgba(248, 113, 113, 0.5)';
      toast.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="font-size:14px;"></i> <span>${message || 'Internet Disconnected — Offline'}</span>`;
    }

    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    if (isOnline) {
      networkToastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
      }, 4000);
    }
  }

  // Handle Browser Online/Offline Events
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      console.log('[BackendManager] Browser back online. Immediate health re-ping triggered.');
      showNetworkToast(true, 'Connection Restored — Online');
      checkHealthAll();
      notifyListeners('backend:network-status', { online: true });
    });

    window.addEventListener('offline', () => {
      console.warn('[BackendManager] Browser network connection lost (Offline).');
      showNetworkToast(false, 'Network Offline — Check Internet');
      backendStats.railway.status = 'offline';
      backendStats.railway.error = 'Browser network offline';
      backendStats.render.status = 'offline';
      backendStats.render.error = 'Browser network offline';
      notifyListeners('backend:health-updated', { backend: 'railway', stats: backendStats.railway });
      notifyListeners('backend:health-updated', { backend: 'render', stats: backendStats.render });
      notifyListeners('backend:network-status', { online: false });
    });
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
    isOnline: () => typeof navigator !== 'undefined' ? navigator.onLine : true,
    checkHealth: checkHealthAll,
    fetch: haFetch
  };

})(typeof window !== 'undefined' ? window : this);
