/**
 * System Monitor & Telemetry Service
 * Tracks CPU, Memory, Uptime, Active Requests, Platform Detection, and Event Logs
 */

const os = require('os');

// Detect Deployment Platform
const CURRENT_PLATFORM = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_SERVICE_ID
  ? 'RAILWAY'
  : (process.env.RENDER || process.env.RENDER_SERVICE_ID
    ? 'RENDER'
    : (process.env.BACKEND_PLATFORM || 'LOCAL'));

// Log Stream Buffer (max 500 entries)
const logBuffer = [];
const MAX_LOG_BUFFER = 500;

// CPU Calculation State
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let cachedCpuPercent = 0;

function calculateCpuUsage() {
  const now = Date.now();
  const timeDiff = now - lastCpuTime;
  if (timeDiff < 500) return cachedCpuPercent; // Use cached value if checked < 500ms ago

  const currentCpuUsage = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();
  lastCpuTime = now;

  const totalMicroSecs = (currentCpuUsage.user + currentCpuUsage.system);
  const totalMs = totalMicroSecs / 1000;
  const numCores = os.cpus().length || 1;

  cachedCpuPercent = Math.min(100, Math.round((totalMs / (timeDiff * numCores)) * 100 * 10) / 10);
  return cachedCpuPercent;
}

// Active Request Counter
let activeRequestsCount = 0;

function incrementActiveRequests() {
  activeRequestsCount++;
}

function decrementActiveRequests() {
  activeRequestsCount = Math.max(0, activeRequestsCount - 1);
}

/**
 * Add an audit/system event log to memory buffer
 * @param {Object} entry { backend, eventType, status, details }
 */
function addSystemLog(entry) {
  const logItem = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
    timestamp: new Date().toISOString(),
    backend: entry.backend || CURRENT_PLATFORM,
    eventType: entry.eventType || 'SYSTEM', // 'STARTUP' | 'CACHE' | 'FIRESTORE' | 'FAILOVER' | 'ERROR'
    status: entry.status || 'INFO',        // 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR'
    details: entry.details || ''
  };

  logBuffer.unshift(logItem);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.pop();
  }

  const colorPrefix = entry.status === 'ERROR' ? '\x1b[31m' : (entry.status === 'WARNING' ? '\x1b[33m' : '\x1b[32m');
  console.log(`[${logItem.backend}][${logItem.eventType}][${logItem.status}] ${logItem.details}`);
  return logItem;
}

function getSystemLogs(limit = 50, filterType = null) {
  let logs = logBuffer;
  if (filterType) {
    logs = logs.filter(l => l.eventType === filterType || l.status === filterType);
  }
  return logs.slice(0, limit);
}

function getSystemMetrics() {
  const memUsage = process.memoryUsage();
  const systemTotalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const systemFreeMemMB = Math.round(os.freemem() / 1024 / 1024);

  return {
    platform: CURRENT_PLATFORM,
    uptimeSeconds: Math.floor(process.uptime()),
    cpuPercent: calculateCpuUsage(),
    memory: {
      rssMB: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
      externalMB: Math.round(memUsage.external / 1024 / 1024 * 100) / 100,
      systemTotalMB: systemTotalMemMB,
      systemFreeMB: systemFreeMemMB
    },
    activeRequests: activeRequestsCount,
    timestamp: new Date().toISOString()
  };
}

// Initial Log Entry
addSystemLog({
  backend: CURRENT_PLATFORM,
  eventType: 'STARTUP',
  status: 'INFO',
  details: `System monitoring initialized on ${CURRENT_PLATFORM} platform.`
});

module.exports = {
  CURRENT_PLATFORM,
  getSystemMetrics,
  addSystemLog,
  getSystemLogs,
  incrementActiveRequests,
  decrementActiveRequests
};
