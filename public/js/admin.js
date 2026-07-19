// ==========================================================================
// FaceMatch AI - Admin Dashboard Logic
// ==========================================================================

// Global state variables
window.allPhotos = [];
window.activeFilter = 'all';
window.selectedPhotoForLightbox = null;
window.faceApiLoaded = false;
// Admin-side limits to prevent memory issues
const ADMIN_MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB
const ADMIN_MAX_UPLOAD_QUEUE = 50; // max files admin can queue
const ADMIN_MOD_TABLE_PAGE_SIZE = 12; // rows per moderation page (reduced to avoid memory spikes)
let adminModCurrentPage = 0;

const LOCAL_MODEL_PATH = '/models';
const CDN_MODEL_PATH = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
let modelPath = LOCAL_MODEL_PATH;

function resizeImageIfNeeded(file, maxDim = 2048) {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      return resolve(file);
    }

    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.onload = () => {
        const width = img.width;
        const height = img.height;

        if (width <= maxDim && height <= maxDim) {
          return resolve(file);
        }

        let newWidth = width;
        let newHeight = height;
        if (width > height) {
          if (width > maxDim) {
            newHeight = Math.round((height * maxDim) / width);
            newWidth = maxDim;
          }
        } else {
          if (height > maxDim) {
            newWidth = Math.round((width * maxDim) / height);
            newHeight = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = newWidth;
        canvas.height = newHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, newWidth, newHeight);

        canvas.toBlob((blob) => {
          if (!blob) {
            return resolve(file);
          }
          const resizedFile = new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          resolve(resizedFile);
        }, 'image/jpeg', 0.85);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

async function loadFaceApiModels() {
  if (window.faceApiLoaded) return;
  if (typeof faceapi === 'undefined') {
    throw new Error('face-api.js is not loaded. Refresh the page and try again.');
  }

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
      faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath),
      faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
      faceapi.nets.faceRecognitionNet.loadFromUri(modelPath)
    ]);
    window.faceApiLoaded = true;
  } catch (err) {
    console.warn('Local face-api models failed, falling back to CDN:', err);
    modelPath = CDN_MODEL_PATH;
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
      faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath),
      faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
      faceapi.nets.faceRecognitionNet.loadFromUri(modelPath)
    ]);
    window.faceApiLoaded = true;
  }
}

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image for face detection.'));
    if (source instanceof File || source instanceof Blob) {
      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsDataURL(source);
    } else {
      img.src = source;
    }
  });
}

function computeIoU(boxA, boxB) {
  const x1 = Math.max(boxA.left, boxB.left);
  const y1 = Math.max(boxA.top, boxB.top);
  const x2 = Math.min(boxA.right, boxB.right);
  const y2 = Math.min(boxA.bottom, boxB.bottom);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, boxA.right - boxA.left) * Math.max(0, boxA.bottom - boxA.top);
  const areaB = Math.max(0, boxB.right - boxB.left) * Math.max(0, boxB.bottom - boxB.top);
  return areaA + areaB === 0 ? 0 : intersection / (areaA + areaB - intersection);
}

function mergeFaceDetections(primary, fallback) {
  const merged = [...primary];
  fallback.forEach(fallbackDetection => {
    const fallbackBox = {
      left: fallbackDetection.detection.box.left,
      top: fallbackDetection.detection.box.top,
      right: fallbackDetection.detection.box.left + fallbackDetection.detection.box.width,
      bottom: fallbackDetection.detection.box.top + fallbackDetection.detection.box.height
    };
    const duplicate = merged.some(existing => {
      const existingBox = {
        left: existing.detection.box.left,
        top: existing.detection.box.top,
        right: existing.detection.box.left + existing.detection.box.width,
        bottom: existing.detection.box.top + existing.detection.box.height
      };
      return computeIoU(existingBox, fallbackBox) > 0.45;
    });
    if (!duplicate) merged.push(fallbackDetection);
  });
  return merged;
}

async function computeFaceDescriptors(source) {
  await loadFaceApiModels();
  const img = await loadImageElement(source);
  const mapDetections = (detections) => detections.map(detection => ({
    box: {
      x: Math.round(detection.detection.box.left),
      y: Math.round(detection.detection.box.top),
      width: Math.round(detection.detection.box.width),
      height: Math.round(detection.detection.box.height)
    },
    descriptor: Array.from(detection.descriptor)
  }));

  let detections = await faceapi
    .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 640, scoreThreshold: 0.25 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  let ssdDetections = [];
  try {
    if (!faceapi.nets.ssdMobilenetv1.isLoaded) {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath);
    }
    ssdDetections = await faceapi
      .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
  } catch (ssdErr) {
    console.warn('SSD MobileNet detection unavailable:', ssdErr);
  }

  if (detections.length === 0 && ssdDetections.length > 0) {
    detections = ssdDetections;
  } else if (ssdDetections.length > detections.length) {
    detections = mergeFaceDetections(detections, ssdDetections);
  }

  return mapDetections(detections);
}

// Photo URL Helper (local / Google Drive / Firebase Storage)
function getPhotoUrl(filename, storageUrl, imageUrl) {
  if (filename && filename.startsWith('drive:')) {
    return `/api/drive/photo/${filename.split(':')[1]}`;
  }
  if (storageUrl) return storageUrl;
  if (imageUrl) return imageUrl;
  if (!filename) return '';
  if (filename.startsWith('firebase:')) {
    const storagePath = filename.slice('firebase:'.length);
    return `/api/storage/photo?path=${encodeURIComponent(storagePath)}`;
  }
  return `/uploads/${filename}`;
}

// --- Helper AJAX function with Auth Header ---
async function adminFetch(url, options = {}) {
  options.credentials = 'same-origin';
  options.headers = {
    ...options.headers
  };

  let response;
  try {
    response = await fetch(url, options);
  } catch (netErr) {
    console.error("Network error during admin fetch:", netErr);
    alert("Network error: Could not reach the Node server. Please verify it is running.");
    throw netErr;
  }

  if (response.status === 401) {
    showAuthOverlay(true);
    showAuthError("Session expired or invalid admin password.");
    throw new Error('Unauthorized');
  } else if (!response.ok) {
    const errRes = await response.json().catch(() => ({}));
    const errMsg = errRes.error || `HTTP ${response.status} error`;
    alert("Database / Server error: " + errMsg);
    throw new Error(errMsg);
  }

  return response.json();
}

// --- Initialize Admin App ---
document.addEventListener('DOMContentLoaded', async () => {
  setupAuthEvents();
  setupTabFilters();
  setupSettingsEvents();
  setupLightboxEvents();
  setupBulkActions();
  setupDirectUpload();

  document.getElementById('refresh-moderation-btn').addEventListener('click', loadDashboardData);
  document.getElementById('admin-logout-btn').addEventListener('click', logoutAdmin);

  // Check URL parameters for successful Google Drive OAuth connection
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('gdrive') === 'success') {
    alert("Successfully authenticated with your Gmail account and connected to Google Drive!");
    window.history.replaceState({}, document.title, window.location.pathname);
    await loadDashboardData();
  } else if (urlParams.get('gdrive') === 'missing_scope') {
    alert("Warning: Google account connected, but Google Drive file creation access was NOT granted. Please disconnect and reconnect, making sure to allow Google Drive file access.");
    window.history.replaceState({}, document.title, window.location.pathname);
    await loadDashboardData();
  } else if (urlParams.get('gdrive') === 'error') {
    const msg = urlParams.get('msg') ? decodeURIComponent(urlParams.get('msg')) : 'Google OAuth connection failed. Please try again.';
    alert(`Google Drive connection error: ${msg}`);
    window.history.replaceState({}, document.title, window.location.pathname);
    await loadDashboardData();
  }

  // Check if we are already logged in through a session cookie
  checkExistingAdminSession();
});

// --- Authentication Flow ---
function setupAuthEvents() {
  const loginForm = document.getElementById('admin-login-form');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const passwordInput = document.getElementById('admin-auth-password');
    const passwordVal = passwordInput.value;

    document.getElementById('auth-error-msg').style.display = 'none';

    await verifyPasswordAndLoad(passwordVal);
  });
}

async function verifyPasswordAndLoad(password) {
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password })
    });

    const result = await response.json().catch(() => ({}));
    if (response.ok && result.success) {
      showAuthOverlay(false);
      await loadDashboardData();
    } else {
      const errMsg = result.error || 'Incorrect password. Please try again.';
      showAuthError(errMsg);
    }
  } catch (err) {
    console.error("Login verification error:", err);
    showAuthError('Failed to connect to server. Verify that the Node.js backend is running and reachable.');
  }
}

async function checkExistingAdminSession() {
  try {
    const response = await fetch('/api/admin/session-check', {
      method: 'GET',
      credentials: 'same-origin'
    });

    if (response.ok) {
      showAuthOverlay(false);
      await loadDashboardData();
    } else {
      showAuthOverlay(true);
    }
  } catch (err) {
    console.error("Session check error:", err);
    showAuthOverlay(true);
  }
}

function showAuthOverlay(show) {
  const overlay = document.getElementById('admin-auth-overlay');
  if (overlay) {
    overlay.style.display = show ? 'flex' : 'none';
  }
  if (show) {
    const passInput = document.getElementById('admin-auth-password');
    if (passInput) {
      passInput.value = '';
      passInput.focus();
    }
  }
}

function showAuthError(message) {
  const errorEl = document.getElementById('auth-error-msg');
  if (errorEl) {
    errorEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${message || 'Incorrect password. Please try again.'}`;
    errorEl.style.display = 'block';
  }
  const passInput = document.getElementById('admin-auth-password');
  if (passInput) {
    passInput.value = '';
    passInput.focus();
  }
}

async function logoutAdmin() {
  if (confirm("Are you sure you want to log out from the Admin Dashboard?")) {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        credentials: 'same-origin'
      });
    } catch (err) {
      console.error("Logout error:", err);
    }
    window.location.href = '/index.html';
  }
}

// --- Load Data & Stats ---
async function loadDashboardData() {
  try {
    // 1. Fetch Global Settings
    const settingsRes = await adminFetch('/api/admin/settings');
    if (settingsRes.success) {
      document.getElementById('toggle-public-gallery-switch').checked = settingsRes.settings.publicGalleryEnabled;

      // Update logo width slider
      const logoWidth = settingsRes.settings.logoWidth || 245;
      const widthSlider = document.getElementById('logo-width-slider');
      if (widthSlider) {
        widthSlider.value = logoWidth;
        document.getElementById('logo-width-val').innerText = logoWidth + 'px';
      }
      
      // Update photo retention input
      const retentionInput = document.getElementById('photo-retention-input');
      if (retentionInput) {
        retentionInput.value = settingsRes.settings.photoRetentionHours !== undefined ? settingsRes.settings.photoRetentionHours : 0;
      }

      const galleryHeadingInput = document.getElementById('gallery-heading-input');
      if (galleryHeadingInput) {
        galleryHeadingInput.value = settingsRes.settings.publicGalleryHeading || 'Gallery Catalog';
      }

      // Update Google Drive controls & connection badges
      const statusBadge = document.getElementById('gdrive-status-badge');
      const connectedContainer = document.getElementById('gdrive-connected-container');
      const warningContainer = document.getElementById('gdrive-warning-container');
      const setupContainer = document.getElementById('gdrive-setup-container');
      const emailSpan = document.getElementById('gdrive-email');
      const clientIdInput = document.getElementById('gdrive-client-id');
      const clientSecretInput = document.getElementById('gdrive-client-secret');

      if (statusBadge) {
        const isConnected = !!settingsRes.settings.googleDriveConnected;
        
        if (clientIdInput) clientIdInput.value = settingsRes.settings.googleClientId || '';
        if (clientSecretInput) {
          if (settingsRes.settings.googleClientSecret === '********') {
            clientSecretInput.value = '';
            clientSecretInput.placeholder = 'Saved (leave blank to keep current)';
          } else {
            clientSecretInput.value = settingsRes.settings.googleClientSecret || '';
            clientSecretInput.placeholder = 'Enter Google OAuth Client Secret';
          }
        }

        const redirectEl = document.getElementById('gdrive-redirect-uri');
        const copyRedirectBtn = document.getElementById('gdrive-copy-redirect-btn');
        if (redirectEl) {
          redirectEl.textContent = settingsRes.googleRedirectUri || 'Redirect URI not available yet.';
        }
        if (copyRedirectBtn) {
          copyRedirectBtn.disabled = !settingsRes.googleRedirectUri;
          copyRedirectBtn.addEventListener('click', () => {
            if (settingsRes.googleRedirectUri) {
              navigator.clipboard.writeText(settingsRes.googleRedirectUri)
                .then(() => alert('Redirect URI copied to clipboard'))
                .catch(() => alert('Failed to copy redirect URI'));
            }
          });
        }

        if (isConnected) {
          statusBadge.className = 'badge badge-approved';
          statusBadge.innerText = 'Connected';
          if (connectedContainer) connectedContainer.style.display = 'block';
          if (setupContainer) setupContainer.style.display = 'none';
          if (emailSpan) emailSpan.innerText = settingsRes.settings.googleConnectedEmail || 'Connected';
          
          const hasDriveScope = settingsRes.settings.googleHasDriveScope !== false;
          if (warningContainer) {
            warningContainer.style.display = hasDriveScope ? 'none' : 'block';
          }
        } else {
          statusBadge.className = 'badge badge-pending';
          statusBadge.innerText = 'Not Connected';
          if (connectedContainer) connectedContainer.style.display = 'none';
          if (setupContainer) setupContainer.style.display = 'block';
          if (warningContainer) warningContainer.style.display = 'none';
        }
      }
    }

    // 2. Fetch Photos
    const photosRes = await adminFetch('/api/admin/gallery');
    if (photosRes.success) {
      window.allPhotos = photosRes.photos || [];
      updateStatsAndRender();
    }

    // 3. Load gallery message
    const galleryMsgInput = document.getElementById('gallery-message-input');
    if (galleryMsgInput && settingsRes && settingsRes.settings) {
      galleryMsgInput.value = settingsRes.settings.galleryMessage || '';
    }
  } catch (err) {
    console.error("Failed to load dashboard data:", err);
  }
}

function updateStatsAndRender() {
  const photos = window.allPhotos;

  const totalCount = photos.length;
  const pendingCount = photos.filter(p => p.status === 'pending').length;
  const approvedCount = photos.filter(p => p.status === 'approved').length;
  const rejectedCount = photos.filter(p => p.status === 'rejected').length;
  const noFaceCount = photos.filter(p => !p.descriptors || p.descriptors.length === 0).length;

  // Render stats counters
  document.getElementById('stat-total').innerText = totalCount;
  document.getElementById('stat-pending').innerText = pendingCount;
  document.getElementById('stat-approved').innerText = approvedCount;
  document.getElementById('stat-rejected').innerText = rejectedCount;
  const noFaceEl = document.getElementById('stat-no-face');
  if (noFaceEl) noFaceEl.innerText = noFaceCount;

  // Render Tab Pending Badge count
  const badgeEl = document.getElementById('badge-pending-count');
  if (badgeEl) {
    if (pendingCount > 0) {
      badgeEl.innerText = pendingCount;
      badgeEl.style.display = 'inline-block';
    } else {
      badgeEl.style.display = 'none';
    }
  }

  // Render Tab No Face Badge count
  const noFaceBadgeEl = document.getElementById('badge-no-face-count');
  if (noFaceBadgeEl) {
    if (noFaceCount > 0) {
      noFaceBadgeEl.innerText = noFaceCount;
      noFaceBadgeEl.style.display = 'inline-block';
    } else {
      noFaceBadgeEl.style.display = 'none';
    }
  }

  renderModerationTable();
}

// --- Tab Filtering ---
function setupTabFilters() {
  const buttons = document.querySelectorAll('.filter-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      window.activeFilter = btn.getAttribute('data-filter');
      renderModerationTable();
    });
  });
}

// --- Render Table Dynamic Rows ---
function renderModerationTable() {
  const tbody = document.getElementById('moderation-table-body');
  const emptyState = document.getElementById('admin-empty-state');
  const tableWrapper = document.getElementById('admin-table-wrapper');

  tbody.innerHTML = '';

  // Filter photos
  let filtered = window.allPhotos;
  if (window.activeFilter === 'pending') {
    filtered = window.allPhotos.filter(photo => photo.status === 'pending');
  } else if (window.activeFilter === 'approved') {
    filtered = window.allPhotos.filter(photo => photo.status === 'approved');
  } else if (window.activeFilter === 'rejected') {
    filtered = window.allPhotos.filter(photo => photo.status === 'rejected');
  } else if (window.activeFilter === 'no-face') {
    filtered = window.allPhotos.filter(photo => !photo.descriptors || photo.descriptors.length === 0);
  }

  // Sort: pending first, then newest first
  filtered.sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    tableWrapper.classList.add('hidden');
    document.getElementById('admin-empty-state-text').innerText = `No photos match the "${window.activeFilter}" filter category.`;
    return;
  }

  emptyState.classList.add('hidden');
  tableWrapper.classList.remove('hidden');

  // Apply pagination for moderation table
  const start = 0;
  const end = Math.min(filtered.length, ADMIN_MOD_TABLE_PAGE_SIZE * (adminModCurrentPage + 1));
  const paged = filtered.slice(start, end);

  paged.forEach(photo => {
    const tr = document.createElement('tr');
    tr.id = `row-${photo.id}`;

    const dateStr = new Date(photo.timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const facesCount = photo.descriptors ? photo.descriptors.length : 0;

    // Status Badge HTML
    const statusBadge = `<span class="status-badge badge-${photo.status}">
      <i class="fa-solid ${photo.status === 'approved' ? 'fa-circle-check' : photo.status === 'rejected' ? 'fa-circle-xmark' : 'fa-circle-dot'}"></i>
      ${photo.status}
    </span>`;

    // Visibility Checkbox Switch (only enabled if status is approved)
    const isApproved = photo.status === 'approved';
    const isPublicChecked = photo.isPublic ? 'checked' : '';
    const visibilityHtml = `
      <label class="switch" style="opacity: ${isApproved ? 1 : 0.4}; cursor: ${isApproved ? 'pointer' : 'not-allowed'}">
        <input type="checkbox" onchange="togglePhotoVisibility('${photo.id}', this.checked)" ${isPublicChecked} ${isApproved ? '' : 'disabled'}>
        <span class="slider"></span>
      </label>
      <span style="font-size: 11px; margin-left: 6px; color: ${photo.isPublic && isApproved ? 'var(--success)' : 'var(--text-muted)'}">
        ${photo.isPublic && isApproved ? 'Public' : 'Private'}
      </span>
    `;

    // Action Buttons
    let actionsHtml = `
      <div class="btn-row">
    `;

    if (photo.status !== 'approved') {
      actionsHtml += `
        <button class="btn btn-success btn-sm" onclick="updatePhotoStatus('${photo.id}', 'approved')">
          <i class="fa-solid fa-check"></i> Approve
        </button>
      `;
    }

    if (photo.status !== 'rejected') {
      actionsHtml += `
        <button class="btn btn-warning btn-sm" onclick="updatePhotoStatus('${photo.id}', 'rejected')">
          <i class="fa-solid fa-xmark"></i> Reject
        </button>
      `;
    }

    actionsHtml += `
        <button class="btn btn-danger btn-sm" onclick="deletePhotoPermanently('${photo.id}')" title="Delete Permanent">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;

    tr.innerHTML = `
        <td>
          <img src="${getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl)}" class="thumb-img" loading="lazy" alt="Thumbnail" onclick="openAdminLightbox('${photo.id}')">
        </td>
      <td style="font-weight: 500; font-size:13px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${photo.originalName}">
        ${photo.originalName}
      </td>
      <td style="color: var(--text-secondary); font-size: 13px;">${dateStr}</td>
      <td style="font-weight: 600;"><i class="fa-solid fa-user-tag" style="color: var(--primary);"></i> ${facesCount}</td>
      <td>${statusBadge}</td>
      <td>
        <div style="display: flex; align-items: center;">
          ${visibilityHtml}
        </div>
      </td>
      <td>${actionsHtml}</td>
    `;

    tbody.appendChild(tr);
  });

  // Add Load More button for moderation table if needed
  const loadMoreId = 'admin-mod-load-more';
  let existing = document.getElementById(loadMoreId);
  if (existing) existing.remove();
  if (end < filtered.length) {
    const footer = document.getElementById('admin-table-footer') || document.getElementById('admin-table-wrapper');
    const btn = document.createElement('div');
    btn.id = loadMoreId;
    btn.style.textAlign = 'center';
    btn.style.padding = '8px 0';
    btn.innerHTML = `<button class="btn btn-secondary" id="admin-mod-load-more-btn">Load more</button>`;
    footer.parentNode.insertBefore(btn, footer.nextSibling);
    document.getElementById('admin-mod-load-more-btn').addEventListener('click', () => {
      adminModCurrentPage++;
      renderModerationTable();
    });
  }
}

// --- Action Functions ---
window.updatePhotoStatus = async function (id, status) {
  try {
    const res = await adminFetch('/api/admin/update-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id, status })
    });

    if (res.success) {
      // Find and update local object
      const photo = window.allPhotos.find(p => p.id === id);
      if (photo) {
        photo.status = status;
        // When rejecting, also automatically make it private
        if (status === 'rejected') {
          photo.isPublic = false;
        }
      }
      updateStatsAndRender();

      // Update active lightbox if open
      if (window.selectedPhotoForLightbox && window.selectedPhotoForLightbox.id === id) {
        window.selectedPhotoForLightbox.status = status;
        if (status === 'rejected') {
          window.selectedPhotoForLightbox.isPublic = false;
        }
        updateLightboxDetails(window.selectedPhotoForLightbox);
      }
    } else {
      alert("Error updating status: " + res.error);
    }
  } catch (err) {
    console.error("Update photo status call failed:", err);
  }
};

window.togglePhotoVisibility = async function (id, isPublic) {
  try {
    const res = await adminFetch('/api/admin/update-visibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id, isPublic })
    });

    if (res.success) {
      const photo = window.allPhotos.find(p => p.id === id);
      if (photo) photo.isPublic = isPublic;
      updateStatsAndRender();
    } else {
      alert("Error toggling visibility: " + res.error);
      loadDashboardData(); // reload on error to revert checkbox state
    }
  } catch (err) {
    console.error("Visibility toggle failed:", err);
  }
};

window.deletePhotoPermanently = async function (id) {
  try {
    const res = await adminFetch('/api/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id })
    });

    if (res.success) {
      // Remove from memory list
      window.allPhotos = window.allPhotos.filter(p => p.id !== id);
      updateStatsAndRender();

      // Close lightbox if we deleted the photo that is open
      if (window.selectedPhotoForLightbox && window.selectedPhotoForLightbox.id === id) {
        closeLightbox();
      }
    } else {
      alert("Delete failed: " + res.error);
    }
  } catch (err) {
    console.error("Delete photo call failed:", err);
  }
};

// --- Settings Operations ---
function setupSettingsEvents() {
  const publicSwitch = document.getElementById('toggle-public-gallery-switch');
  publicSwitch.addEventListener('change', async () => {
    const enabled = publicSwitch.checked;
    try {
      const res = await adminFetch('/api/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ publicGalleryEnabled: enabled })
      });
      if (!res.success) {
        alert("Failed to save settings: " + res.error);
        publicSwitch.checked = !enabled; // revert
      }
    } catch (err) {
      publicSwitch.checked = !enabled; // revert
    }
  });

  const passwordForm = document.getElementById('change-password-form');
  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPass = document.getElementById('new-admin-password').value;
    const confirmPass = document.getElementById('confirm-admin-password').value;

    if (newPass.length < 6) {
      alert("Password must be at least 6 characters long.");
      return;
    }

    if (newPass !== confirmPass) {
      alert("Passwords do not match. Please verify.");
      return;
    }

    try {
      const res = await adminFetch('/api/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ newPassword: newPass })
      });

      if (res.success) {
        alert("Admin password updated successfully! Please use the new password for future access.");
        passwordForm.reset();
      } else {
        alert("Failed to update password: " + res.error);
      }
    } catch (err) {
      console.error("Change password request error:", err);
    }
  });

  const logoFileInput = document.getElementById('logo-file-input');
  const logoFileName = document.getElementById('logo-file-name');
  const logoPreviewImg = document.getElementById('logo-preview-img');

  if (logoFileInput) {
    logoFileInput.addEventListener('change', async (e) => {
      if (e.target.files.length === 0) return;
      const file = e.target.files[0];
      logoFileName.innerText = file.name;

      const formData = new FormData();
      formData.append('logo', file);

      try {
        const response = await fetch('/api/admin/upload-logo', {
          method: 'POST',
          credentials: 'same-origin',
          body: formData
        });
        const res = await response.json();
        if (res.success) {
          alert("Custom logo uploaded successfully!");
          if (logoPreviewImg) {
            logoPreviewImg.src = res.logoUrl;
          }
        } else {
          alert("Logo upload failed: " + res.error);
        }
      } catch (err) {
        console.error("Logo upload failed:", err);
        alert("Error uploading logo: " + err.message);
      }
    });
  }

  const logoWidthSlider = document.getElementById('logo-width-slider');
  const logoWidthVal = document.getElementById('logo-width-val');

  if (logoWidthSlider) {
    logoWidthSlider.addEventListener('input', (e) => {
      logoWidthVal.innerText = e.target.value + 'px';
    });

    logoWidthSlider.addEventListener('change', async (e) => {
      const val = parseInt(e.target.value, 10);
      try {
        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ logoWidth: val })
        });
        if (!res.success) {
          alert("Failed to update logo width: " + res.error);
        }
      } catch (err) {
        console.error("Failed to update logo width settings:", err);
      }
    });
  }

  const retentionInput = document.getElementById('photo-retention-input');
  if (retentionInput) {
    retentionInput.addEventListener('change', async (e) => {
      const val = parseFloat(e.target.value);
      if (isNaN(val) || val < 0) {
        alert("Please enter a valid number of hours (0 or greater).");
        return;
      }
      try {
        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ photoRetentionHours: val })
        });
        if (res.success) {
          console.log("Photo retention period updated to " + val + " hours");
        } else {
          alert("Failed to update photo retention settings: " + res.error);
        }
      } catch (err) {
        console.error("Failed to update photo retention settings:", err);
      }
    });
  }

  const galleryHeadingInput = document.getElementById('gallery-heading-input');
  if (galleryHeadingInput) {
    galleryHeadingInput.addEventListener('change', async (e) => {
      const heading = e.target.value.toString().trim();
      try {
        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ publicGalleryHeading: heading })
        });
        if (!res.success) {
          alert("Failed to update gallery heading: " + res.error);
        }
      } catch (err) {
        console.error("Failed to update gallery heading:", err);
      }
    });
  }

  // Google Credentials Save Event
  const saveCredsBtn = document.getElementById('gdrive-save-creds-btn');
  if (saveCredsBtn) {
    saveCredsBtn.addEventListener('click', async () => {
      const clientId = document.getElementById('gdrive-client-id').value;
      const clientSecret = document.getElementById('gdrive-client-secret').value;
      
      try {
        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            googleClientId: clientId,
            googleClientSecret: clientSecret
          })
        });
        if (res.success) {
          alert("Google OAuth credentials saved successfully!");
          await loadDashboardData();
        } else {
          alert("Failed to save credentials: " + res.error);
        }
      } catch (err) {
        console.error("Save credentials error:", err);
      }
    });
  }

  // Google OAuth Authorization Redirect Connect Event
  const gdriveConnectBtn = document.getElementById('gdrive-connect-btn');
  if (gdriveConnectBtn) {
    gdriveConnectBtn.addEventListener('click', async () => {
      const clientId = document.getElementById('gdrive-client-id').value.trim();
      const clientSecret = document.getElementById('gdrive-client-secret').value.trim();
      if (!clientId) {
        alert("Please enter your Google Client ID.");
        return;
      }

      gdriveConnectBtn.disabled = true;
      gdriveConnectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

      try {
        const payload = { googleClientId: clientId };
        if (clientSecret) payload.googleClientSecret = clientSecret;

        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.success) {
          alert("Failed to save Google credentials: " + (res.error || 'Unknown error'));
          return;
        }

        window.location.href = '/api/google/auth';
      } catch (err) {
        console.error('Connect Google Drive error:', err);
      } finally {
        gdriveConnectBtn.disabled = false;
        gdriveConnectBtn.innerHTML = '<i class="fa-brands fa-google-drive"></i> Connect Gmail';
      }
    });
  }

  // Google Drive Sync Event
  const gdriveSyncBtn = document.getElementById('gdrive-sync-btn');
  if (gdriveSyncBtn) {
    gdriveSyncBtn.addEventListener('click', async () => {
      try {
        gdriveSyncBtn.disabled = true;
        gdriveSyncBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...';
        
        const res = await adminFetch('/api/admin/sync', {
          method: 'POST'
        });
        
        if (res.success) {
          alert(`Google Drive synced successfully! Processed ${res.count} new photo(s).`);
          await loadDashboardData();
        } else {
          alert("Sync failed: " + (res.error || 'Unknown error'));
        }
      } catch (err) {
        console.error("Sync error:", err);
        alert("Sync error: " + err.message);
      } finally {
        gdriveSyncBtn.disabled = false;
        gdriveSyncBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Sync Google Drive Photos';
      }
    });
  }

  // Google Disconnect Event
  const gdriveDisconnectBtn = document.getElementById('gdrive-disconnect-btn');
  if (gdriveDisconnectBtn) {
    gdriveDisconnectBtn.addEventListener('click', async () => {
      if (!confirm("Are you sure you want to disconnect Google Drive? New uploads will use Firebase Storage until you reconnect.")) {
        return;
      }
      try {
        const res = await adminFetch('/api/google/disconnect', {
          method: 'POST'
        });
        if (res.success) {
          alert("Google Drive disconnected successfully.");
          await loadDashboardData();
        } else {
          alert("Disconnect failed: " + res.error);
        }
      } catch (err) {
        console.error("Disconnect error:", err);
      }
    });
  }

  // Gallery Announcement Message Save
  const saveGalleryMsgBtn = document.getElementById('save-gallery-message-btn');
  if (saveGalleryMsgBtn) {
    saveGalleryMsgBtn.addEventListener('click', async () => {
      const galleryMsgInput = document.getElementById('gallery-message-input');
      const savedIndicator = document.getElementById('gallery-message-saved-indicator');
      const message = galleryMsgInput ? galleryMsgInput.value : '';
      try {
        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ galleryMessage: message })
        });
        if (res.success) {
          if (savedIndicator) {
            savedIndicator.style.display = 'block';
            setTimeout(() => { savedIndicator.style.display = 'none'; }, 3000);
          }
        } else {
          alert('Failed to save announcement: ' + res.error);
        }
      } catch (err) {
        console.error('Gallery message save error:', err);
      }
    });
  }
}

// --- Lightbox Integration ---
function setupLightboxEvents() {
  const modal = document.getElementById('lightbox-modal');
  const closeBtn = document.getElementById('lightbox-close-btn');

  closeBtn.addEventListener('click', closeLightbox);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') closeLightbox();
  });

  // Set up lightbox moderation triggers
  document.getElementById('lightbox-approve-btn').addEventListener('click', () => {
    if (window.selectedPhotoForLightbox) {
      updatePhotoStatus(window.selectedPhotoForLightbox.id, 'approved');
    }
  });

  document.getElementById('lightbox-reject-btn').addEventListener('click', () => {
    if (window.selectedPhotoForLightbox) {
      updatePhotoStatus(window.selectedPhotoForLightbox.id, 'rejected');
    }
  });

  document.getElementById('lightbox-delete-btn').addEventListener('click', () => {
    if (window.selectedPhotoForLightbox) {
      deletePhotoPermanently(window.selectedPhotoForLightbox.id);
    }
  });
}

function openAdminLightbox(photoId) {
  const photo = window.allPhotos.find(p => p.id === photoId);
  if (!photo) return;

  window.selectedPhotoForLightbox = photo;

  const modal = document.getElementById('lightbox-modal');
  const img = document.getElementById('lightbox-img');
  const canvas = document.getElementById('lightbox-canvas');
  const downloadLink = document.getElementById('lightbox-download-link');

  img.src = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
  downloadLink.href = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
  downloadLink.setAttribute('download', photo.originalName);

  updateLightboxDetails(photo);

  modal.style.display = 'flex';

  img.onload = () => {
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (photo.descriptors && photo.descriptors.length > 0) {
      const scaleX = img.clientWidth / img.naturalWidth;
      const scaleY = img.clientHeight / img.naturalHeight;

      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#8b5cf6';

      photo.descriptors.forEach(faceData => {
        const box = faceData.box;
        if (box) {
          const x = box.x * scaleX;
          const y = box.y * scaleY;
          const width = box.width * scaleX;
          const height = box.height * scaleY;

          ctx.beginPath();
          ctx.roundRect(x, y, width, height, 6);
          ctx.stroke();
        }
      });
      ctx.shadowBlur = 0;
    }
  };
}

function updateLightboxDetails(photo) {
  document.getElementById('detail-filename').innerText = photo.originalName;
  document.getElementById('detail-date').innerText = new Date(photo.timestamp).toLocaleString();

  const facesCount = photo.descriptors ? photo.descriptors.length : 0;
  document.getElementById('detail-faces').innerText = facesCount > 0 ? `${facesCount} face(s) identified` : 'No Face Detected';

  const statusEl = document.getElementById('detail-status');
  statusEl.innerText = photo.status;
  statusEl.className = `detail-value status-badge badge-${photo.status}`;

  // Highlight buttons if status is active
  const approveBtn = document.getElementById('lightbox-approve-btn');
  const rejectBtn = document.getElementById('lightbox-reject-btn');

  if (photo.status === 'approved') {
    approveBtn.style.opacity = '0.5';
    approveBtn.style.pointerEvents = 'none';
    rejectBtn.style.opacity = '1';
    rejectBtn.style.pointerEvents = 'auto';
  } else if (photo.status === 'rejected') {
    approveBtn.style.opacity = '1';
    approveBtn.style.pointerEvents = 'auto';
    rejectBtn.style.opacity = '0.5';
    rejectBtn.style.pointerEvents = 'none';
  } else {
    approveBtn.style.opacity = '1';
    approveBtn.style.pointerEvents = 'auto';
    rejectBtn.style.opacity = '1';
    rejectBtn.style.pointerEvents = 'auto';
  }
}

function closeLightbox() {
  const modal = document.getElementById('lightbox-modal');
  modal.style.display = 'none';
  document.getElementById('lightbox-img').src = '';
  const canvas = document.getElementById('lightbox-canvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  window.selectedPhotoForLightbox = null;
}

// --- Bulk Operations (Phase 2) ---
function setupBulkActions() {
  const bulkApproveBtn = document.getElementById('bulk-approve-btn');
  const bulkRejectBtn = document.getElementById('bulk-reject-btn');

  if (bulkApproveBtn) {
    bulkApproveBtn.addEventListener('click', async () => {
      const pendingPhotos = window.allPhotos.filter(p => p.status === 'pending');
      if (pendingPhotos.length === 0) {
        alert("No pending photos in the queue to approve.");
        return;
      }
      if (confirm(`Are you sure you want to APPROVE all ${pendingPhotos.length} pending photo(s)?`)) {
        try {
          const res = await adminFetch('/api/admin/bulk-status', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: 'approved' })
          });
          if (res.success) {
            alert(`Successfully approved ${res.updatedCount} photo(s).`);
            await loadDashboardData();
          } else {
            alert("Error: " + res.error);
          }
        } catch (err) {
          console.error("Bulk approve failed:", err);
        }
      }
    });
  }

  if (bulkRejectBtn) {
    bulkRejectBtn.addEventListener('click', async () => {
      const targetPhotos = window.activeFilter === 'no-face'
        ? window.allPhotos.filter(p => !p.descriptors || p.descriptors.length === 0)
        : window.allPhotos.filter(p => p.status !== 'rejected');
      if (targetPhotos.length === 0) {
        alert("No photos available to reject.");
        return;
      }
      if (confirm(`Are you sure you want to REJECT all ${targetPhotos.length} selected photo(s)?`)) {
        try {
          const res = await adminFetch('/api/admin/bulk-status', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: 'rejected', target: window.activeFilter === 'no-face' ? 'no-face' : 'all' })
          });
          if (res.success) {
            alert(`Successfully rejected ${res.updatedCount} photo(s).`);
            await loadDashboardData();
          } else {
            alert("Error: " + res.error);
          }
        } catch (err) {
          console.error("Bulk reject failed:", err);
        }
      }
    });
  }

  const bulkDeleteAllBtn = document.getElementById('bulk-delete-all-btn');
  if (bulkDeleteAllBtn) {
    bulkDeleteAllBtn.addEventListener('click', async () => {
      if (window.allPhotos.length === 0) {
        alert("There are no photos in the gallery to delete.");
        return;
      }
      
      const confirmFirst = confirm(`WARNING: Are you sure you want to permanently delete ALL ${window.allPhotos.length} photo(s) from the server? This will delete all image files, Google Drive files, and facial descriptor data. This action is irreversible.`);
      if (!confirmFirst) return;

      const confirmSecond = confirm(`FINAL CONFIRMATION: Type 'DELETE ALL' in the next prompt if you are absolutely sure.`);
      if (!confirmSecond) return;
      
      const typedConfirmation = prompt(`Please type 'DELETE ALL' to confirm deletion of all files:`);
      if (typedConfirmation !== 'DELETE ALL') {
        alert("Incorrect confirmation text. Deletion cancelled.");
        return;
      }

      try {
        const res = await adminFetch('/api/admin/delete-all', {
          method: 'POST'
        });
        if (res.success) {
          alert("All photos have been successfully deleted.");
          await loadDashboardData();
        } else {
          alert("Error: " + res.error);
        }
      } catch (err) {
        console.error("Bulk delete all failed:", err);
      }
    });
  }
}

// --- Direct Upload (Phase 2) ---
let faceApiLoaded = true;

async function initFaceApiForAdmin() {
  return true;
}

function promiseTimeout(promise, ms, onTimeout) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error('Face detection timed out after ' + ms / 1000 + ' seconds'));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function computeFaceDescriptorsWithTimeout(source, ms = 60000) {
  return await promiseTimeout(computeFaceDescriptors(source), ms);
}

window.adminUploadQueue = [];

function setupDirectUpload() {
  const dragZone = document.getElementById('admin-upload-drag-zone');
  const fileInput = document.getElementById('admin-file-input');
  const startUploadBtn = document.getElementById('admin-start-upload-btn');
  const clearQueueBtn = document.getElementById('admin-clear-queue-btn');

  if (!dragZone || !fileInput) return;

  dragZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleAdminFilesAdded(e.target.files);
    }
  });

  dragZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dragZone.style.borderColor = 'var(--primary)';
    dragZone.style.background = 'rgba(139, 92, 246, 0.05)';
  });

  dragZone.addEventListener('dragleave', () => {
    dragZone.style.borderColor = 'rgba(255,255,255,0.1)';
    dragZone.style.background = 'transparent';
  });

  dragZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragZone.style.borderColor = 'rgba(255,255,255,0.1)';
    dragZone.style.background = 'transparent';
    if (e.dataTransfer.files.length > 0) {
      handleAdminFilesAdded(e.dataTransfer.files);
    }
  });

  if (startUploadBtn) {
    startUploadBtn.addEventListener('click', startAdminBatchUpload);
  }
  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', clearAdminQueue);
  }
}

async function handleAdminFilesAdded(fileList) {
  const queueContainer = document.getElementById('admin-upload-queue-container');
  if (queueContainer) {
    queueContainer.style.display = 'block';
    queueContainer.classList.remove('hidden');
  }

  const statusText = document.getElementById('admin-queue-status-text');
  if (statusText) {
    statusText.innerText = "Images loaded.";
  }

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    // Reject files bigger than limit
    if (file.size > ADMIN_MAX_UPLOAD_SIZE) {
      alert(file.name + " is too large. Please select files up to 50 MB.");
      continue;
    }

    // Prevent too many files queued client-side
    if (window.adminUploadQueue.length >= ADMIN_MAX_UPLOAD_QUEUE) {
      alert('Admin upload queue limit reached. Please upload existing files or reduce selection.');
      break;
    }

    // Avoid duplicates by name
    if (window.adminUploadQueue.some(item => item.file.name === file.name)) continue;

    const queueId = 'aqi_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const queueItem = {
      id: queueId,
      file: file,
      status: 'ready', // Immediately ready for upload
      faces: [],
      error: null
    };

    window.adminUploadQueue.push(queueItem);
    renderAdminQueueItem(queueItem);
  }

  updateAdminQueueCount();
}

function renderAdminQueueItem(item) {
  const carousel = document.getElementById('admin-preview-carousel');
  if (!carousel) return;
  
  const itemEl = document.createElement('div');
  itemEl.className = 'preview-item';
  itemEl.id = item.id;

  const url = URL.createObjectURL(item.file);
  item.objectUrl = url;

  // Revoke object URL after image loads to free memory
  const tempImg = new Image();
  tempImg.onload = () => {
    try { URL.revokeObjectURL(url); } catch (e) {}
    // clear stored objectUrl reference (item removal will check)
    item.objectUrl = null;
  };
  tempImg.src = url;

  itemEl.innerHTML = `
    <div class="preview-thumbnail-wrapper">
      <img src="${url}" class="preview-thumbnail" alt="preview">
    </div>
    <div class="preview-info">
      <div class="preview-name">${item.file.name}</div>
      <div class="preview-status ready" id="${item.id}-status">
        <i class="fa-solid fa-circle-check" style="color:#10b981"></i> Loaded
      </div>
    </div>
    <button class="preview-remove-btn" onclick="removeAdminQueueItem('${item.id}')">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  carousel.appendChild(itemEl);
  carousel.scrollTop = carousel.scrollHeight;
}

window.removeAdminQueueItem = function(id) {
  const idx = window.adminUploadQueue.findIndex(item => item.id === id);
  if (idx > -1) {
    const item = window.adminUploadQueue[idx];
    if (item.objectUrl) {
      URL.revokeObjectURL(item.objectUrl);
    }
    window.adminUploadQueue.splice(idx, 1);
    const el = document.getElementById(id);
    if (el) el.remove();
    updateAdminQueueCount();
  }
};

function updateAdminQueueCount() {
  const countSpan = document.getElementById('admin-queue-count');
  if (countSpan) {
    countSpan.innerText = window.adminUploadQueue.length;
  }

  const container = document.getElementById('admin-upload-queue-container');
  if (container && window.adminUploadQueue.length === 0) {
    container.style.display = 'none';
    container.classList.add('hidden');
  }
}

function clearAdminQueue() {
  window.adminUploadQueue.forEach(item => {
    if (item.objectUrl) {
      URL.revokeObjectURL(item.objectUrl);
    }
  });
  window.adminUploadQueue = [];
  const carousel = document.getElementById('admin-preview-carousel');
  if (carousel) carousel.innerHTML = '';
  updateAdminQueueCount();
}

async function startAdminBatchUpload() {
  const startUploadBtn = document.getElementById('admin-start-upload-btn');
  const clearQueueBtn = document.getElementById('admin-clear-queue-btn');
  const progressBar = document.getElementById('admin-upload-progress-fill');
  const statusText = document.getElementById('admin-queue-status-text');
  const isPublicCheckbox = document.getElementById('admin-upload-public-checkbox');

  const uploadable = window.adminUploadQueue.filter(item => item.status === 'ready');
  if (uploadable.length === 0) {
    alert("No photos in queue ready for upload.");
    return;
  }

  if (startUploadBtn) startUploadBtn.classList.add('disabled');
  if (clearQueueBtn) clearQueueBtn.classList.add('disabled');

  let successCount = 0;
  if (progressBar) progressBar.style.width = '0%';

  for (let i = 0; i < uploadable.length; i++) {
    const item = uploadable[i];
    item.status = 'uploading';
    const statusEl = document.getElementById(`${item.id}-status`);
    if (statusEl) {
      statusEl.innerHTML = `<i class="fa-solid fa-arrow-up-from-bracket fa-bounce"></i> Uploading...`;
    }

    const formData = new FormData();
    formData.append('isPublic', isPublicCheckbox ? isPublicCheckbox.checked : true);
    formData.append('descriptors', JSON.stringify([]));

    try {
      const resizedFile = await resizeImageIfNeeded(item.file);
      formData.append('photo', resizedFile);

      const response = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
      });
      const result = await response.json();
      if (result.success) {
        successCount++;
        item.status = 'done';
        if (statusEl) {
          statusEl.className = 'preview-status ready';
          const serverFaces = result.photo && result.photo.descriptors ? result.photo.descriptors.length : 0;
          const faceLabel = serverFaces > 0
            ? `Uploaded · ${serverFaces} face(s)`
            : 'Uploaded · no face detected';
          statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${faceLabel}`;
        }

        setTimeout(() => {
          const el = document.getElementById(item.id);
          if (el) el.remove();
          if (item.objectUrl) {
            URL.revokeObjectURL(item.objectUrl);
          }
          window.adminUploadQueue = window.adminUploadQueue.filter(q => q.id !== item.id);
          updateAdminQueueCount();
        }, 1000);
      } else {
        item.status = 'failed';
        if (statusEl) {
          statusEl.className = 'preview-status failed';
          statusEl.innerHTML = `<i class="fa-solid fa-xmark"></i> Server error`;
        }
      }
    } catch (err) {
      console.error("Upload failed:", err);
      item.status = 'failed';
      if (statusEl) {
        statusEl.className = 'preview-status failed';
        statusEl.innerHTML = `<i class="fa-solid fa-xmark"></i> Upload failed`;
      }
    }

    const completedCount = uploadable.filter(q => q.status === 'done' || q.status === 'failed').length;
    const pct = Math.round((completedCount / uploadable.length) * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (statusText) statusText.innerText = `Uploading images (${completedCount}/${uploadable.length})...`;
  }

  if (statusText) {
    statusText.innerHTML = `<span style='color:var(--success)'><i class='fa-solid fa-circle-check'></i> Successfully uploaded ${successCount}/${uploadable.length} photos!</span>`;
  }
  if (progressBar) progressBar.style.width = '100%';

  setTimeout(() => {
    if (progressBar) progressBar.style.width = '0%';
    if (startUploadBtn) startUploadBtn.classList.remove('disabled');
    if (clearQueueBtn) clearQueueBtn.classList.remove('disabled');
  }, 2000);

  await loadDashboardData();
}
