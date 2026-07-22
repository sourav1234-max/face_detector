// ==========================================================================
// FaceMatch AI - Admin Dashboard Logic
// ==========================================================================

// Global state variables
window.allPhotos = [];
window.allEvents = [];
window.adminActiveEventId = 'all';
window.activeFilter = 'all';
window.selectedPhotoForLightbox = null;
window.faceApiLoaded = false;
// Admin-side limits to prevent memory issues
const ADMIN_MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB
const ADMIN_MAX_UPLOAD_QUEUE = 15; // max files admin can queue (limit 15)
const ADMIN_MOD_TABLE_PAGE_SIZE = 12; // rows per moderation page (reduced to avoid memory spikes)
let adminModCurrentPage = 0;

const LOCAL_MODEL_PATH = '/models';
const CDN_MODEL_PATH = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
let modelPath = LOCAL_MODEL_PATH;

async function resizeImageIfNeeded(file, maxDim = 2048) {
  if (!file || !(file instanceof File || file instanceof Blob) || (file.type && !file.type.startsWith('image/'))) {
    return file;
  }
  if (window.FaceDetectorUtils && typeof window.FaceDetectorUtils.createOrientedCanvas === 'function') {
    try {
      const oriented = await window.FaceDetectorUtils.createOrientedCanvas(file, maxDim);
      return oriented.file;
    } catch (e) {
      console.warn('[Admin Resizer] createOrientedCanvas failed, falling back:', e);
    }
  }

  if (window.FaceDetectorUtils && typeof window.FaceDetectorUtils.resizeImageFallback === 'function') {
    return window.FaceDetectorUtils.resizeImageFallback(file, maxDim);
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

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
        if (!blob) return resolve(file);
        const resizedFile = new File([blob], file.name, {
          type: 'image/jpeg',
          lastModified: Date.now()
        });
        resolve(resizedFile);
      }, 'image/jpeg', 0.85);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };
    img.src = objectUrl;
  });
}

async function loadFaceApiModels() {
  if (window.FaceDetectorUtils) {
    return window.FaceDetectorUtils.loadFaceApiModels();
  }
}

async function computeFaceDescriptors(source) {
  if (window.FaceDetectorUtils) {
    const { canvas } = await window.FaceDetectorUtils.createOrientedCanvas(source, 2048);
    return window.FaceDetectorUtils.detectFacesMultiScale(canvas);
  }
  return [];
}

async function computeFaceDescriptorsWithTimeout(source, timeoutMs = 15000) {
  return Promise.race([
    computeFaceDescriptors(source),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Browser face detection timed out')), timeoutMs)
    )
  ]);
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
  setupEventManagement();
  setupManualFaceEvents();

  // Preload face-api models for face detection on upload
  loadFaceApiModels().catch(err => console.warn('Failed to preload face-api models:', err));

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
      window.defaultPublicEventId = settingsRes.settings.defaultPublicEventId || 'all';
      document.getElementById('toggle-public-gallery-switch').checked = settingsRes.settings.publicGalleryEnabled;
      const faceAdjustSwitch = document.getElementById('toggle-public-face-adjustment-switch');
      if (faceAdjustSwitch) faceAdjustSwitch.checked = settingsRes.settings.allowPublicFaceAdjustment !== false;

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

    // 2. Fetch Events & Photos
    await fetchEventsAndRender();
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
  let photos = window.allPhotos;
  if (window.adminActiveEventId && window.adminActiveEventId !== 'all') {
    photos = window.allPhotos.filter(p => p.eventId === window.adminActiveEventId);
  }

  const totalCount = photos.length;
  const pendingCount = photos.filter(p => p.status === 'pending').length;
  const approvedCount = photos.filter(p => p.status === 'approved').length;
  const rejectedCount = photos.filter(p => p.status === 'rejected').length;
  const noFaceCount = photos.filter(p => !p.descriptors || p.descriptors.length === 0).length;
  const publicUploadCount = photos.filter(p => p.uploadedBy !== 'admin').length;
  const adminUploadCount = photos.filter(p => p.uploadedBy === 'admin').length;
  const reviewDoneCount = photos.filter(p => p.reviewed === true).length;
  const reviewPendingCount = photos.filter(p => p.reviewed !== true).length;

  // Render stats counters
  document.getElementById('stat-total').innerText = totalCount;
  document.getElementById('stat-pending').innerText = pendingCount;
  document.getElementById('stat-approved').innerText = approvedCount;
  document.getElementById('stat-rejected').innerText = rejectedCount;
  const noFaceEl = document.getElementById('stat-no-face');
  if (noFaceEl) noFaceEl.innerText = noFaceCount;

  const reviewDoneEl = document.getElementById('stat-review-done');
  if (reviewDoneEl) reviewDoneEl.innerText = reviewDoneCount;

  const reviewPendingEl = document.getElementById('stat-review-pending');
  if (reviewPendingEl) reviewPendingEl.innerText = reviewPendingCount;

  // Render Tab Badges
  const badgePending = document.getElementById('badge-pending-count');
  if (badgePending) {
    badgePending.innerText = pendingCount;
    badgePending.style.display = pendingCount > 0 ? 'inline-block' : 'none';
  }

  const badgePublic = document.getElementById('badge-public-count');
  if (badgePublic) {
    badgePublic.innerText = publicUploadCount;
    badgePublic.style.display = publicUploadCount > 0 ? 'inline-block' : 'none';
  }

  const badgeAdmin = document.getElementById('badge-admin-count');
  if (badgeAdmin) {
    badgeAdmin.innerText = adminUploadCount;
    badgeAdmin.style.display = adminUploadCount > 0 ? 'inline-block' : 'none';
  }

  const noFaceBadgeEl = document.getElementById('badge-no-face-count');
  if (noFaceBadgeEl) {
    noFaceBadgeEl.innerText = noFaceCount;
    noFaceBadgeEl.style.display = noFaceCount > 0 ? 'inline-block' : 'none';
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

window.togglePhotoReview = async function(id) {
  try {
    const res = await adminFetch(`/api/admin/photos/${id}/toggle-review`, { method: 'POST' });
    if (res.success && res.photo) {
      const idx = window.allPhotos.findIndex(p => p.id === id);
      if (idx !== -1) {
        window.allPhotos[idx] = res.photo;
      }
      updateStatsAndRender();
    } else {
      alert("Error updating review status: " + (res.error || 'Unknown error'));
    }
  } catch (err) {
    console.error("Toggle review error:", err);
    alert("Failed to update review status: " + err.message);
  }
};

// --- Render Table Dynamic Rows ---
function renderModerationTable() {
  const tbody = document.getElementById('moderation-table-body');
  const emptyState = document.getElementById('admin-empty-state');
  const tableWrapper = document.getElementById('admin-table-wrapper');

  tbody.innerHTML = '';

  // Filter photos by event first if an event is selected
  let basePhotos = window.allPhotos;
  if (window.adminActiveEventId && window.adminActiveEventId !== 'all') {
    basePhotos = basePhotos.filter(photo => photo.eventId === window.adminActiveEventId);
  }

  // Filter photos by tab category
  let filtered = basePhotos;
  if (window.activeFilter === 'public-upload' || window.activeFilter === 'public') {
    filtered = basePhotos.filter(photo => photo.uploadedBy !== 'admin');
  } else if (window.activeFilter === 'admin-upload' || window.activeFilter === 'admin') {
    filtered = basePhotos.filter(photo => photo.uploadedBy === 'admin');
  } else if (window.activeFilter === 'pending') {
    filtered = basePhotos.filter(photo => photo.status === 'pending');
  } else if (window.activeFilter === 'approved') {
    filtered = basePhotos.filter(photo => photo.status === 'approved');
  } else if (window.activeFilter === 'rejected') {
    filtered = basePhotos.filter(photo => photo.status === 'rejected');
  } else if (window.activeFilter === 'no-face') {
    filtered = basePhotos.filter(photo => !photo.descriptors || photo.descriptors.length === 0);
  }

  // Update Bulk Delete button text matching the active filter and count
  const bulkDeleteAllBtn = document.getElementById('bulk-delete-all-btn');
  if (bulkDeleteAllBtn) {
    let filterLabel = 'All Photos';
    if (window.activeFilter === 'public-upload') filterLabel = 'Public Uploads';
    else if (window.activeFilter === 'admin-upload') filterLabel = 'Admin Uploads';
    else if (window.activeFilter === 'pending') filterLabel = 'Pending';
    else if (window.activeFilter === 'approved') filterLabel = 'Approved';
    else if (window.activeFilter === 'rejected') filterLabel = 'Rejected';
    else if (window.activeFilter === 'no-face') filterLabel = 'No-Face Photos';

    bulkDeleteAllBtn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Delete ${filterLabel} (${filtered.length})`;
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
        <button class="btn btn-secondary btn-sm" onclick="openManualFaceModalById('${photo.id}')" title="Manual Face Correction" style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.3); color: #c4b5fd;">
          <i class="fa-solid fa-crop-simple"></i> Fix Faces
        </button>
        <button class="btn btn-danger btn-sm" onclick="deletePhotoPermanently('${photo.id}')" title="Delete Permanent">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;

    const evtObj = window.allEvents ? window.allEvents.find(e => e.id === photo.eventId) : null;
    const evtName = evtObj ? (evtObj.title || evtObj.name) : 'General';
    const eventBadge = `<span class="badge" style="background: rgba(139, 92, 246, 0.15); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.3); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;"><i class="fa-solid fa-tag"></i> ${evtName}</span>`;

    const isAdminUpload = photo.uploadedBy === 'admin';
    const uploaderBadge = isAdminUpload
      ? `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;"><i class="fa-solid fa-user-shield"></i> Admin</span>`
      : `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;"><i class="fa-solid fa-user"></i> Public</span>`;

    const isReviewed = photo.reviewed === true;
    const reviewBadge = isReviewed
      ? `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;" title="Face review verified"><i class="fa-solid fa-square-check"></i> Review Done</span>`
      : `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;" title="Face review pending"><i class="fa-solid fa-clock-rotate-left"></i> Review Pending</span>`;

    tr.innerHTML = `
        <td>
          <img src="${getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl)}" class="thumb-img" loading="lazy" alt="Thumbnail" onclick="openAdminLightbox('${photo.id}')">
        </td>
      <td style="font-weight: 500; font-size:13px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${photo.originalName}">
        ${photo.originalName}
        <div style="margin-top:2px;">${reviewBadge}</div>
      </td>
      <td>${eventBadge}</td>
      <td>${uploaderBadge}</td>
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

  const faceAdjustSwitch = document.getElementById('toggle-public-face-adjustment-switch');
  if (faceAdjustSwitch) {
    faceAdjustSwitch.addEventListener('change', async () => {
      const enabled = faceAdjustSwitch.checked;
      try {
        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowPublicFaceAdjustment: enabled })
        });
        if (!res.success) {
          alert("Failed to save face adjustment setting: " + res.error);
          faceAdjustSwitch.checked = !enabled;
        }
      } catch (err) {
        faceAdjustSwitch.checked = !enabled;
      }
    });
  }

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

  // Default Public Event Save
  const saveDefaultEventBtn = document.getElementById('save-default-event-btn');
  if (saveDefaultEventBtn) {
    saveDefaultEventBtn.addEventListener('click', async () => {
      const defaultSelect = document.getElementById('default-public-event-select');
      const savedIndicator = document.getElementById('default-event-saved-indicator');
      const defaultPublicEventId = defaultSelect ? defaultSelect.value : 'all';
      try {
        const res = await adminFetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultPublicEventId })
        });
        if (res.success) {
          window.defaultPublicEventId = defaultPublicEventId;
          if (savedIndicator) {
            savedIndicator.style.display = 'block';
            setTimeout(() => { savedIndicator.style.display = 'none'; }, 3000);
          }
        } else {
          alert('Failed to save default event: ' + res.error);
        }
      } catch (err) {
        console.error('Save default event error:', err);
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
      let filterLabel = 'All Photos';
      let targetPhotos = window.allPhotos;

      if (window.activeFilter === 'public-upload' || window.activeFilter === 'public') {
        filterLabel = 'Public Uploads';
        targetPhotos = window.allPhotos.filter(p => p.uploadedBy !== 'admin');
      } else if (window.activeFilter === 'admin-upload' || window.activeFilter === 'admin') {
        filterLabel = 'Admin Uploads';
        targetPhotos = window.allPhotos.filter(p => p.uploadedBy === 'admin');
      } else if (window.activeFilter === 'pending') {
        filterLabel = 'Pending Photos';
        targetPhotos = window.allPhotos.filter(p => p.status === 'pending');
      } else if (window.activeFilter === 'approved') {
        filterLabel = 'Approved Photos';
        targetPhotos = window.allPhotos.filter(p => p.status === 'approved');
      } else if (window.activeFilter === 'rejected') {
        filterLabel = 'Rejected Photos';
        targetPhotos = window.allPhotos.filter(p => p.status === 'rejected');
      } else if (window.activeFilter === 'no-face') {
        filterLabel = 'No-Face Photos';
        targetPhotos = window.allPhotos.filter(p => !p.descriptors || p.descriptors.length === 0);
      }

      if (targetPhotos.length === 0) {
        alert(`There are no photos matching the "${filterLabel}" filter to delete.`);
        return;
      }
      
      const confirmFirst = confirm(`WARNING: Are you sure you want to permanently delete all ${targetPhotos.length} photo(s) in category "${filterLabel}"? This will remove files and facial data. This action is irreversible.`);
      if (!confirmFirst) return;

      const confirmSecond = confirm(`FINAL CONFIRMATION: Click OK to delete these ${targetPhotos.length} photo(s).`);
      if (!confirmSecond) return;

      try {
        const idsToDelete = targetPhotos.map(p => p.id);
        const res = await adminFetch('/api/admin/delete-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filter: window.activeFilter,
            ids: idsToDelete
          })
        });
        if (res.success) {
          alert(`Successfully deleted ${res.count || targetPhotos.length} photo(s) from "${filterLabel}".`);
          await loadDashboardData();
        } else {
          alert("Error: " + res.error);
        }
      } catch (err) {
        console.error("Bulk delete failed:", err);
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

// Admin Upload Queue Setup
window.adminBatchQueue = new FaceDetectorUtils.BatchUploadQueue({
  concurrency: 1,
  maxQueueSize: ADMIN_MAX_UPLOAD_QUEUE,
  maxRetries: 3,
  isPublic: true,
  onItemChange: (item, action) => {
    if (action === 'added') {
      renderAdminQueueItem(item);
    } else if (action === 'removed') {
      const el = document.getElementById(item.id);
      if (el) el.remove();
    } else if (action === 'updated') {
      updateAdminQueueItemUI(item);
    }
    updateAdminQueueCount();
  },
  onProgress: ({ completed, total, percentage }) => {
    const progressBar = document.getElementById('admin-upload-progress-fill');
    const statusText = document.getElementById('admin-queue-status-text');
    if (progressBar) progressBar.style.width = `${percentage}%`;
    if (statusText) statusText.innerText = total > 0 ? `Processing admin uploads (${completed}/${total})...` : 'Images loaded.';
  },
  onComplete: async (queue) => {
    const startUploadBtn = document.getElementById('admin-start-upload-btn');
    const clearQueueBtn = document.getElementById('admin-clear-queue-btn');
    const progressBar = document.getElementById('admin-upload-progress-fill');
    const statusText = document.getElementById('admin-queue-status-text');

    const successCount = queue.filter(i => i.status === 'done').length;
    if (statusText) {
      statusText.innerHTML = `<span style='color:var(--success)'><i class='fa-solid fa-circle-check'></i> Successfully uploaded ${successCount}/${queue.length} photo(s)!</span>`;
    }
    if (progressBar) progressBar.style.width = '100%';

    setTimeout(() => {
      if (progressBar) progressBar.style.width = '0%';
      if (startUploadBtn) startUploadBtn.classList.remove('disabled');
      if (clearQueueBtn) clearQueueBtn.classList.remove('disabled');
    }, 2000);

    await loadDashboardData();
  }
});

async function handleAdminFilesAdded(fileList) {
  const queueContainer = document.getElementById('admin-upload-queue-container');
  if (queueContainer) {
    queueContainer.style.display = 'block';
    queueContainer.classList.remove('hidden');
  }

  const isPublicCheckbox = document.getElementById('admin-upload-public-checkbox');
  if (isPublicCheckbox) {
    window.adminBatchQueue.isPublic = isPublicCheckbox.checked;
  }

  const currentCount = window.adminBatchQueue.queue.length;
  const availableSlots = ADMIN_MAX_UPLOAD_QUEUE - currentCount;

  if (availableSlots <= 0) {
    alert(`Maximum limit of ${ADMIN_MAX_UPLOAD_QUEUE} photos reached in upload queue.`);
    return;
  }

  const validFiles = [];
  let skippedCount = 0;

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (file.size > ADMIN_MAX_UPLOAD_SIZE) {
      alert(`${file.name} is too large. Max size allowed is 50 MB.`);
      continue;
    }
    if (validFiles.length < availableSlots) {
      validFiles.push(file);
    } else {
      skippedCount++;
    }
  }

  if (skippedCount > 0) {
    alert(`Maximum batch upload limit is ${ADMIN_MAX_UPLOAD_QUEUE} photos. ${skippedCount} file(s) were excluded.`);
  }

  window.adminBatchQueue.addFiles(validFiles);
}

function renderAdminQueueItem(item) {
  const carousel = document.getElementById('admin-preview-carousel');
  if (!carousel) return;

  const itemEl = document.createElement('div');
  itemEl.className = 'preview-item';
  itemEl.id = item.id;

  const url = item.objectUrl || URL.createObjectURL(item.file);

  itemEl.innerHTML = `
    <div class="preview-thumbnail-wrapper">
      <img src="${url}" class="preview-thumbnail" alt="preview">
    </div>
    <div class="preview-info">
      <div class="preview-name">${item.file.name}</div>
      <div class="preview-status ready" id="${item.id}-status">
        <i class="fa-solid fa-clock" style="color:#a78bfa"></i> Queued
      </div>
    </div>
    <button class="preview-remove-btn" onclick="removeAdminQueueItem('${item.id}')">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  carousel.appendChild(itemEl);
  carousel.scrollTop = carousel.scrollHeight;
}

function updateAdminQueueItemUI(item) {
  const statusEl = document.getElementById(`${item.id}-status`);
  if (!statusEl) return;

  if (item.status === 'queued') {
    statusEl.className = 'preview-status ready';
    statusEl.innerHTML = `<i class="fa-solid fa-clock" style="color:#a78bfa"></i> Queued`;
  } else if (item.status === 'detecting') {
    statusEl.className = 'preview-status ready';
    statusEl.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" style="color:#3b82f6"></i> Detecting faces...`;
  } else if (item.status === 'uploading') {
    statusEl.className = 'preview-status ready';
    statusEl.innerHTML = `<i class="fa-solid fa-arrow-up-from-bracket fa-bounce" style="color:#8b5cf6"></i> Uploading...`;
  } else if (item.status === 'done') {
    statusEl.className = 'preview-status ready';
    const label = item.faceCount > 0 ? `Uploaded · ${item.faceCount} face(s)` : 'Uploaded · no face';
    statusEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981"></i> ${label}`;
  } else if (item.status === 'failed') {
    statusEl.className = 'preview-status failed';
    statusEl.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="color:#ef4444"></i> ${item.error || 'Failed'}`;
  }
}

window.removeAdminQueueItem = function(id) {
  window.adminBatchQueue.removeItem(id);
};

function updateAdminQueueCount() {
  const countSpan = document.getElementById('admin-queue-count');
  if (countSpan) countSpan.innerText = window.adminBatchQueue.queue.length;

  const container = document.getElementById('admin-upload-queue-container');
  if (container && window.adminBatchQueue.queue.length === 0) {
    container.style.display = 'none';
    container.classList.add('hidden');
  }
}

function clearAdminQueue() {
  window.adminBatchQueue.clear();
  const carousel = document.getElementById('admin-preview-carousel');
  if (carousel) carousel.innerHTML = '';
  updateAdminQueueCount();
}

async function startAdminBatchUpload() {
  const startUploadBtn = document.getElementById('admin-start-upload-btn');
  const clearQueueBtn = document.getElementById('admin-clear-queue-btn');
  const isPublicCheckbox = document.getElementById('admin-upload-public-checkbox');

  if (window.adminBatchQueue.queue.length === 0) {
    alert("No photos in queue ready for upload.");
    return;
  }

  if (isPublicCheckbox) {
    window.adminBatchQueue.isPublic = isPublicCheckbox.checked;
  }

  const eventSelect = document.getElementById('admin-upload-event-select');
  if (eventSelect) {
    window.adminBatchQueue.eventId = eventSelect.value || '';
  }

  if (startUploadBtn) startUploadBtn.classList.add('disabled');
  if (clearQueueBtn) clearQueueBtn.classList.add('disabled');

  window.adminBatchQueue.start();
}

// --- Event Management ---
async function fetchEventsAndRender() {
  try {
    const res = await adminFetch('/api/events');
    if (res.success) {
      window.allEvents = res.events || [];
      renderAdminEventsList();
      populateAdminEventDropdowns();
    }
  } catch (err) {
    console.error("Failed to load events:", err);
  }
}

function renderAdminEventsList() {
  const container = document.getElementById('admin-events-list');
  const countEl = document.getElementById('admin-events-count');
  if (!container) return;

  const events = window.allEvents || [];
  const userEventsCount = events.filter(e => e.id !== 'all').length;
  if (countEl) countEl.innerText = userEventsCount;

  if (events.length === 0) {
    container.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:8px 0; text-align:center;">No events created yet. Use the form above to add your first event.</div>`;
    return;
  }

  container.innerHTML = events.map(evt => {
    const isAllSystem = evt.id === 'all' || evt.isSystemEvent;
    return `
    <div style="display:flex; justify-content:space-between; align-items:center; background:${isAllSystem ? 'rgba(59,130,246,0.06)' : 'rgba(255,255,255,0.02)'}; border:1px solid ${isAllSystem ? 'rgba(59,130,246,0.3)' : 'var(--panel-border)'}; padding:8px 12px; border-radius:var(--border-radius-sm);">
      <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:8px;">
        <strong style="font-size:13px; color:#fff;">${evt.title || evt.name}</strong>
        ${isAllSystem ? `<span class="badge" style="background:rgba(59,130,246,0.2); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); padding:1px 6px; font-size:10px; margin-left:6px;"><i class="fa-solid fa-globe"></i> Global Catalog</span>` : ''}
        ${evt.showInPublicGallery !== false ? `<span class="badge" style="background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.3); padding:1px 6px; font-size:10px; margin-left:4px;"><i class="fa-solid fa-eye"></i> Public Gallery: Visible</span>` : `<span class="badge" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); padding:1px 6px; font-size:10px; margin-left:4px;"><i class="fa-solid fa-eye-slash"></i> Public Gallery: Hidden</span>`}
        ${(evt.passcode || evt.hasPasscode) ? `<span class="badge" style="background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.3); padding:1px 6px; font-size:10px; margin-left:6px;"><i class="fa-solid fa-lock"></i> ${evt.passcode ? 'Passcode: ' + evt.passcode : 'Passcode Protected'}</span>` : ''}
        ${evt.allowDownload === false ? `<span class="badge" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); padding:1px 6px; font-size:10px; margin-left:4px;"><i class="fa-solid fa-ban"></i> No Downloads</span>` : ''}
        ${evt.disableRightClick ? `<span class="badge" style="background:rgba(168,85,247,0.15); color:#c084fc; border:1px solid rgba(168,85,247,0.3); padding:1px 6px; font-size:10px; margin-left:4px;"><i class="fa-solid fa-shield"></i> Protected</span>` : ''}
        <div style="font-size:11px; color:var(--text-secondary);">
          <i class="fa-regular fa-calendar" style="margin-right:3px;"></i>${evt.date || 'No Date'} &bull; 
          <i class="fa-solid fa-image" style="margin-right:3px;"></i>${evt.photoCount || 0} photo(s)
        </div>
      </div>
      <div style="display:flex; gap:4px; align-items:center;">
        <button type="button" data-action="edit-event" data-event-id="${evt.id}" class="btn btn-secondary btn-sm" style="padding:4px 8px;" title="Edit Event Settings">
          <i class="fa-solid fa-pen"></i>
        </button>
        ${!isAllSystem ? `
        <button type="button" data-action="delete-event" data-event-id="${evt.id}" class="btn btn-secondary btn-sm" style="padding:4px 8px; color:var(--danger); border-color:rgba(239,68,68,0.2);" title="Delete Event">
          <i class="fa-solid fa-trash-can"></i>
        </button>` : `<span title="Global System Catalog" style="opacity:0.3; padding:4px 6px; font-size:11px; color:var(--text-muted);"><i class="fa-solid fa-lock"></i></span>`}
      </div>
    </div>
  `;
  }).join('');

  if (!container.dataset.listenerAttached) {
    container.dataset.listenerAttached = 'true';
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const eventId = btn.getAttribute('data-event-id');
      if (action === 'edit-event') {
        openEditEventModal(eventId);
      } else if (action === 'delete-event') {
        deleteEventItem(eventId);
      }
    });
  }
}

function populateAdminEventDropdowns() {
  const globalPicker = document.getElementById('admin-global-event-picker');
  const uploadSelect = document.getElementById('admin-upload-event-select');

  const customEvents = (window.allEvents || []).filter(e => e.id !== 'all');
  const eventOptions = customEvents.map(evt => `<option value="${evt.id}">📁 ${evt.title || evt.name}${evt.hasPasscode || evt.passcode ? ' 🔒' : ''}</option>`).join('');

  if (globalPicker) {
    globalPicker.innerHTML = `<option value="all">📁 All Photos / All Events (Full Catalog)</option>` + eventOptions;
    globalPicker.value = window.adminActiveEventId || 'all';

    if (!globalPicker.dataset.listenerAttached) {
      globalPicker.dataset.listenerAttached = 'true';
      globalPicker.addEventListener('change', (e) => {
        setAdminActiveEvent(e.target.value);
      });
    }
  }

  if (uploadSelect) {
    uploadSelect.innerHTML = `<option value="">-- General / All Photos Default --</option>` +
      customEvents.map(evt => `<option value="${evt.id}">${evt.title || evt.name}${evt.hasPasscode || evt.passcode ? ' 🔒' : ''}</option>`).join('');
    uploadSelect.value = window.adminActiveEventId === 'all' ? '' : window.adminActiveEventId;

    if (!uploadSelect.dataset.listenerAttached) {
      uploadSelect.dataset.listenerAttached = 'true';
      uploadSelect.addEventListener('change', (e) => {
        setAdminActiveEvent(e.target.value || 'all');
      });
    }
  }

  const defaultSelect = document.getElementById('default-public-event-select');
  if (defaultSelect) {
    const allEvt = (window.allEvents || []).find(e => e.id === 'all');
    const isAllVisible = !allEvt || allEvt.showInPublicGallery !== false;
    defaultSelect.innerHTML = `<option value="all">🎉 All Photos / All Events ${isAllVisible ? '(Public Catalog)' : '(Hidden in Public)'}</option>` +
      customEvents.map(evt => `<option value="${evt.id}">📁 ${evt.title || evt.name}${evt.hasPasscode || evt.passcode ? ' 🔒' : ''}</option>`).join('');
    defaultSelect.value = window.defaultPublicEventId || 'all';
  }
}

function setAdminActiveEvent(eventId) {
  window.adminActiveEventId = eventId || 'all';

  const globalPicker = document.getElementById('admin-global-event-picker');
  if (globalPicker) globalPicker.value = window.adminActiveEventId;

  const uploadSelect = document.getElementById('admin-upload-event-select');
  if (uploadSelect) uploadSelect.value = window.adminActiveEventId === 'all' ? '' : window.adminActiveEventId;

  updateStatsAndRender();
}

function setupEventManagement() {
  const form = document.getElementById('create-event-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const titleInput = document.getElementById('event-title-input');
    const dateInput = document.getElementById('event-date-input');
    const descInput = document.getElementById('event-desc-input');
    const statusInput = document.getElementById('event-status-input');
    const passcodeInput = document.getElementById('event-passcode-input');
    const showPublicCheck = document.getElementById('event-show-public-check');
    const allowDownloadCheck = document.getElementById('event-allow-download-check');
    const disableRightClickCheck = document.getElementById('event-disable-rightclick-check');
    const announcementInput = document.getElementById('event-announcement-input');

    const title = titleInput.value.trim();
    if (!title) return;

    try {
      const res = await adminFetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          name: title,
          date: dateInput ? dateInput.value : '',
          description: descInput ? descInput.value.trim() : '',
          status: statusInput ? statusInput.value : 'active',
          passcode: passcodeInput ? passcodeInput.value.trim() : '',
          showInPublicGallery: showPublicCheck ? showPublicCheck.checked : true,
          allowDownload: allowDownloadCheck ? allowDownloadCheck.checked : true,
          disableRightClick: disableRightClickCheck ? disableRightClickCheck.checked : false,
          announcementMessage: announcementInput ? announcementInput.value.trim() : ''
        })
      });

      if (res.success) {
        titleInput.value = '';
        if (dateInput) dateInput.value = '';
        if (descInput) descInput.value = '';
        if (passcodeInput) passcodeInput.value = '';
        if (showPublicCheck) showPublicCheck.checked = true;
        if (allowDownloadCheck) allowDownloadCheck.checked = true;
        if (disableRightClickCheck) disableRightClickCheck.checked = false;
        if (announcementInput) announcementInput.value = '';
        await fetchEventsAndRender();
        alert(`Event '${title}' created successfully!`);
      } else {
        alert("Error creating event: " + res.error);
      }
    } catch (err) {
      console.error("Create event error:", err);
      alert("Failed to create event: " + err.message);
    }
  });

  const editForm = document.getElementById('edit-event-form');
  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('edit-event-id').value;
      const title = document.getElementById('edit-event-title').value.trim();
      if (!title || !id) return;

      try {
        const res = await adminFetch(`/api/events/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            name: title,
            date: document.getElementById('edit-event-date').value,
            status: document.getElementById('edit-event-status').value,
            description: document.getElementById('edit-event-desc').value.trim(),
            passcode: document.getElementById('edit-event-passcode').value.trim(),
            showInPublicGallery: document.getElementById('edit-event-show-public') ? document.getElementById('edit-event-show-public').checked : true,
            allowDownload: document.getElementById('edit-event-allow-download').checked,
            disableRightClick: document.getElementById('edit-event-disable-rightclick').checked,
            announcementMessage: document.getElementById('edit-event-announcement').value.trim()
          })
        });

        if (res.success) {
          closeEditEventModal();
          await fetchEventsAndRender();
          alert(`Event '${title}' settings updated successfully!`);
        } else {
          alert('Failed to update event: ' + (res.error || 'Server error'));
        }
      } catch (err) {
        console.error('Update event error:', err);
        alert('Failed to update event: ' + err.message);
      }
    });
  }
}

window.openEditEventModal = function(id) {
  const evt = (window.allEvents || []).find(e => e.id === id);
  if (!evt) return;

  const idEl = document.getElementById('edit-event-id');
  const titleEl = document.getElementById('edit-event-title');
  const dateEl = document.getElementById('edit-event-date');
  const statusEl = document.getElementById('edit-event-status');
  const descEl = document.getElementById('edit-event-desc');
  const passcodeEl = document.getElementById('edit-event-passcode');
  const showPublicEl = document.getElementById('edit-event-show-public');
  const allowDlEl = document.getElementById('edit-event-allow-download');
  const blockRcEl = document.getElementById('edit-event-disable-rightclick');
  const announceEl = document.getElementById('edit-event-announcement');

  if (idEl) idEl.value = evt.id;
  if (titleEl) titleEl.value = evt.title || evt.name || '';
  if (dateEl) dateEl.value = evt.date || '';
  if (statusEl) statusEl.value = evt.status || 'active';
  if (descEl) descEl.value = evt.description || '';
  if (passcodeEl) passcodeEl.value = evt.passcode || '';
  if (showPublicEl) showPublicEl.checked = evt.showInPublicGallery !== false;
  if (allowDlEl) allowDlEl.checked = evt.allowDownload !== false;
  if (blockRcEl) blockRcEl.checked = !!evt.disableRightClick;
  if (announceEl) announceEl.value = evt.announcementMessage || '';

  const modal = document.getElementById('edit-event-modal');
  if (modal) modal.style.display = 'flex';
};

window.closeEditEventModal = function() {
  const modal = document.getElementById('edit-event-modal');
  if (modal) modal.style.display = 'none';
};

window.deleteEventItem = async function(id) {
  const evt = window.allEvents.find(e => e.id === id);
  const name = evt ? (evt.title || evt.name) : id;
  if (confirm(`Are you sure you want to delete event "${name}"? Photos in this event will not be deleted, but will become uncategorized.`)) {
    try {
      const res = await adminFetch(`/api/events/${id}`, { method: 'DELETE' });
      if (res.success) {
        await fetchEventsAndRender();
        await loadDashboardData();
      } else {
        alert("Error deleting event: " + res.error);
      }
    } catch (err) {
      console.error("Delete event error:", err);
    }
  }
};

// ==========================================================================
// MANUAL FACE CORRECTION ENGINE
// ==========================================================================

let currentManualFacePhoto = null;
let manualFaceBoxes = [];
let manualFaceSelectedIndex = -1;

let mfIsDragging = false;
let mfDragMode = null; // 'move', 'resize-nw', 'resize-ne', 'resize-sw', 'resize-se', 'resize-n', 'resize-e', 'resize-s', 'resize-w', 'draw'
let mfDragStart = { x: 0, y: 0, nx: 0, ny: 0 };
let mfInitialBox = null;

function setupManualFaceEvents() {
  const modal = document.getElementById('manual-face-modal');
  const closeBtn = document.getElementById('manual-face-close-btn');
  const updateBtn = document.getElementById('manual-face-update-btn');
  const deleteBtn = document.getElementById('manual-face-delete-btn');
  const lightboxBtn = document.getElementById('lightbox-manual-face-btn');

  const canvas = document.getElementById('manual-face-canvas');
  const img = document.getElementById('manual-face-img');

  const inputX = document.getElementById('mf-input-x');
  const inputY = document.getElementById('mf-input-y');
  const inputW = document.getElementById('mf-input-w');
  const inputH = document.getElementById('mf-input-h');

  if (closeBtn) {
    closeBtn.addEventListener('click', closeManualFaceModal);
  }

  if (lightboxBtn) {
    lightboxBtn.addEventListener('click', () => {
      if (window.selectedPhotoForLightbox) {
        closeLightbox();
        openManualFaceModal(window.selectedPhotoForLightbox);
      }
    });
  }

  if (updateBtn) {
    updateBtn.addEventListener('click', handleManualFaceUpdate);
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', handleManualFaceDelete);
  }

  [inputX, inputY, inputW, inputH].forEach(input => {
    if (input) {
      input.addEventListener('change', updateBoxFromInputs);
      input.addEventListener('input', updateBoxFromInputs);
    }
  });

  if (canvas) {
    canvas.addEventListener('mousedown', handleMfMouseDown);
    canvas.addEventListener('mousemove', handleMfMouseMove);
    canvas.addEventListener('mouseup', handleMfMouseUp);
    canvas.addEventListener('mouseleave', handleMfMouseUp);

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousedown', {
          clientX: touch.clientX,
          clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousemove', {
          clientX: touch.clientX,
          clientY: touch.clientY
        });
        canvas.dispatchEvent(mouseEvent);
      }
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
      const mouseEvent = new MouseEvent('mouseup', {});
      canvas.dispatchEvent(mouseEvent);
    });
  }

  window.addEventListener('resize', () => {
    if (modal && modal.style.display !== 'none' && currentManualFacePhoto) {
      syncCanvasDimensions();
      drawManualFaceCanvas();
    }
  });

  const rotateRightBtn = document.getElementById('mf-rotate-right-btn');
  const rotateLeftBtn = document.getElementById('mf-rotate-left-btn');
  const rotateResetBtn = document.getElementById('mf-rotate-reset-btn');

  if (rotateRightBtn) {
    rotateRightBtn.addEventListener('click', () => {
      manualFaceRotation = (manualFaceRotation + 90) % 360;
      applyMfRotation();
    });
  }
  if (rotateLeftBtn) {
    rotateLeftBtn.addEventListener('click', () => {
      manualFaceRotation = (manualFaceRotation - 90 + 360) % 360;
      applyMfRotation();
    });
  }
  if (rotateResetBtn) {
    rotateResetBtn.addEventListener('click', () => {
      manualFaceRotation = 0;
      applyMfRotation();
    });
  }
}

window.openManualFaceModalById = function(photoId) {
  const photo = window.allPhotos.find(p => p.id === photoId);
  if (photo) {
    openManualFaceModal(photo);
  }
};

let manualFaceRotation = 0;

function applyMfRotation() {
  const wrapper = document.getElementById('manual-face-canvas-wrapper');
  if (wrapper) {
    wrapper.style.transform = `rotate(${manualFaceRotation}deg)`;
    wrapper.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
  }
}

function openManualFaceModal(photo) {
  currentManualFacePhoto = photo;
  manualFaceRotation = 0;
  applyMfRotation();

  // Preload face-api models in background for quick manual face extraction
  if (window.FaceDetectorUtils && typeof window.FaceDetectorUtils.loadFaceApiModels === 'function') {
    window.FaceDetectorUtils.loadFaceApiModels().catch(e => console.warn('[Manual Face] Model preload warning:', e.message));
  }

  // Automatically mark photo as reviewed when Fix Faces is opened
  if (photo && !photo.reviewed) {
    photo.reviewed = true;
    togglePhotoReview(photo.id);
  }
  const modal = document.getElementById('manual-face-modal');
  const img = document.getElementById('manual-face-img');
  const statusBanner = document.getElementById('manual-face-status-banner');

  if (statusBanner) {
    statusBanner.style.display = 'none';
  }

  const rawDescriptors = Array.isArray(photo.descriptors) ? photo.descriptors : [];
  manualFaceBoxes = rawDescriptors.map(item => {
    if (item && item.box && typeof item.box.x === 'number') {
      return { ...item.box };
    }
    return { x: 0, y: 0, width: 100, height: 100 };
  });

  manualFaceSelectedIndex = manualFaceBoxes.length > 0 ? 0 : -1;

  const photoUrl = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
  img.onload = () => {
    syncCanvasDimensions();
    renderManualFacePills();
    updateInputFields();
    drawManualFaceCanvas();
  };
  img.src = photoUrl;

  modal.style.display = 'flex';
}

function closeManualFaceModal() {
  const modal = document.getElementById('manual-face-modal');
  if (modal) modal.style.display = 'none';
  currentManualFacePhoto = null;
  manualFaceBoxes = [];
  manualFaceSelectedIndex = -1;
  mfIsDragging = false;
  mfDragMode = null;
}

function syncCanvasDimensions() {
  const img = document.getElementById('manual-face-img');
  const canvas = document.getElementById('manual-face-canvas');
  if (!img || !canvas) return;

  const w = img.clientWidth || img.width;
  const h = img.clientHeight || img.height;
  canvas.width = w;
  canvas.height = h;
}

function getCanvasScale() {
  const img = document.getElementById('manual-face-img');
  const canvas = document.getElementById('manual-face-canvas');
  if (!img || !canvas || !img.naturalWidth || !img.naturalHeight) {
    return { scaleX: 1, scaleY: 1 };
  }
  return {
    scaleX: canvas.width / img.naturalWidth,
    scaleY: canvas.height / img.naturalHeight
  };
}

function renderManualFacePills() {
  const listEl = document.getElementById('manual-face-list');
  const badgeEl = document.getElementById('manual-face-count-badge');
  if (!listEl) return;

  if (badgeEl) {
    badgeEl.innerText = `${manualFaceBoxes.length} Face(s) Detected`;
  }

  listEl.innerHTML = '';

  manualFaceBoxes.forEach((box, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-sm ${idx === manualFaceSelectedIndex ? 'btn-primary' : 'btn-secondary'}`;
    btn.style.fontSize = '11px';
    btn.style.padding = '4px 10px';
    btn.style.borderRadius = '12px';
    btn.innerHTML = `<i class="fa-solid fa-user"></i> Face #${idx + 1}`;
    btn.addEventListener('click', () => {
      manualFaceSelectedIndex = idx;
      renderManualFacePills();
      updateInputFields();
      drawManualFaceCanvas();
    });
    listEl.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = `btn btn-sm ${manualFaceSelectedIndex === -1 ? 'btn-primary' : 'btn-tertiary'}`;
  addBtn.style.fontSize = '11px';
  addBtn.style.padding = '4px 10px';
  addBtn.style.borderRadius = '12px';
  addBtn.innerHTML = `<i class="fa-solid fa-plus"></i> Draw New Face`;
  addBtn.addEventListener('click', () => {
    manualFaceSelectedIndex = -1;
    renderManualFacePills();
    updateInputFields();
    drawManualFaceCanvas();
  });
  listEl.appendChild(addBtn);
}

function updateInputFields() {
  const inputX = document.getElementById('mf-input-x');
  const inputY = document.getElementById('mf-input-y');
  const inputW = document.getElementById('mf-input-w');
  const inputH = document.getElementById('mf-input-h');

  if (manualFaceSelectedIndex >= 0 && manualFaceSelectedIndex < manualFaceBoxes.length) {
    const box = manualFaceBoxes[manualFaceSelectedIndex];
    if (inputX) inputX.value = Math.round(box.x);
    if (inputY) inputY.value = Math.round(box.y);
    if (inputW) inputW.value = Math.round(box.width);
    if (inputH) inputH.value = Math.round(box.height);
  } else {
    if (inputX) inputX.value = 0;
    if (inputY) inputY.value = 0;
    if (inputW) inputW.value = 0;
    if (inputH) inputH.value = 0;
  }
}

function updateBoxFromInputs() {
  if (manualFaceSelectedIndex < 0 || manualFaceSelectedIndex >= manualFaceBoxes.length) return;

  const inputX = document.getElementById('mf-input-x');
  const inputY = document.getElementById('mf-input-y');
  const inputW = document.getElementById('mf-input-w');
  const inputH = document.getElementById('mf-input-h');

  const box = manualFaceBoxes[manualFaceSelectedIndex];
  if (inputX && !isNaN(parseInt(inputX.value))) box.x = Math.max(0, parseInt(inputX.value));
  if (inputY && !isNaN(parseInt(inputY.value))) box.y = Math.max(0, parseInt(inputY.value));
  if (inputW && !isNaN(parseInt(inputW.value))) box.width = Math.max(10, parseInt(inputW.value));
  if (inputH && !isNaN(parseInt(inputH.value))) box.height = Math.max(10, parseInt(inputH.value));

  drawManualFaceCanvas();
}

function drawManualFaceCanvas() {
  const canvas = document.getElementById('manual-face-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const { scaleX, scaleY } = getCanvasScale();
  const HANDLE_SIZE = 8;

  manualFaceBoxes.forEach((box, idx) => {
    const bx = box.x * scaleX;
    const by = box.y * scaleY;
    const bw = box.width * scaleX;
    const bh = box.height * scaleY;

    const isSelected = idx === manualFaceSelectedIndex;

    if (isSelected) {
      ctx.fillStyle = 'rgba(139, 92, 246, 0.25)';
      ctx.fillRect(bx, by, bw, bh);

      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.strokeRect(bx, by, bw, bh);

      const labelText = `Face #${idx + 1} (Active)`;
      ctx.font = 'bold 12px Inter, sans-serif';
      const textWidth = ctx.measureText(labelText).width;

      ctx.fillStyle = '#8b5cf6';
      ctx.fillRect(bx, Math.max(0, by - 22), textWidth + 12, 20);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, bx + 6, Math.max(14, by - 7));

      const handles = getHandleCoordinates(bx, by, bw, bh);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 2;

      Object.values(handles).forEach(h => {
        ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      });
    } else {
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(bx, by, bw, bh);

      const labelText = `Face #${idx + 1}`;
      ctx.font = '500 11px Inter, sans-serif';
      const textWidth = ctx.measureText(labelText).width;

      ctx.fillStyle = 'rgba(6, 182, 212, 0.85)';
      ctx.fillRect(bx, Math.max(0, by - 20), textWidth + 10, 18);

      ctx.fillStyle = '#000000';
      ctx.fillText(labelText, bx + 5, Math.max(13, by - 6));
    }
  });
}

function getHandleCoordinates(bx, by, bw, bh) {
  return {
    nw: { x: bx, y: by },
    n:  { x: bx + bw / 2, y: by },
    ne: { x: bx + bw, y: by },
    e:  { x: bx + bw, y: by + bh / 2 },
    se: { x: bx + bw, y: by + bh },
    s:  { x: bx + bw / 2, y: by + bh },
    sw: { x: bx, y: by + bh },
    w:  { x: bx, y: by + bh / 2 }
  };
}

function handleMfMouseDown(e) {
  const canvas = document.getElementById('manual-face-canvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const { scaleX, scaleY } = getCanvasScale();
  const nx = mx / scaleX;
  const ny = my / scaleY;

  const HANDLE_SIZE = 12;

  if (manualFaceSelectedIndex >= 0 && manualFaceSelectedIndex < manualFaceBoxes.length) {
    const box = manualFaceBoxes[manualFaceSelectedIndex];
    const bx = box.x * scaleX;
    const by = box.y * scaleY;
    const bw = box.width * scaleX;
    const bh = box.height * scaleY;

    const handles = {
      'resize-nw': { x: bx, y: by },
      'resize-n':  { x: bx + bw / 2, y: by },
      'resize-ne': { x: bx + bw, y: by },
      'resize-e':  { x: bx + bw, y: by + bh / 2 },
      'resize-se': { x: bx + bw, y: by + bh },
      'resize-s':  { x: bx + bw / 2, y: by + bh },
      'resize-sw': { x: bx, y: by + bh },
      'resize-w':  { x: bx, y: by + bh / 2 }
    };

    for (const [mode, h] of Object.entries(handles)) {
      if (Math.abs(mx - h.x) <= HANDLE_SIZE && Math.abs(my - h.y) <= HANDLE_SIZE) {
        mfIsDragging = true;
        mfDragMode = mode;
        mfDragStart = { mx, my, nx, ny };
        mfInitialBox = { ...box };
        return;
      }
    }

    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      mfIsDragging = true;
      mfDragMode = 'move';
      mfDragStart = { mx, my, nx, ny };
      mfInitialBox = { ...box };
      return;
    }
  }

  for (let i = manualFaceBoxes.length - 1; i >= 0; i--) {
    const box = manualFaceBoxes[i];
    const bx = box.x * scaleX;
    const by = box.y * scaleY;
    const bw = box.width * scaleX;
    const bh = box.height * scaleY;

    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      manualFaceSelectedIndex = i;
      mfIsDragging = true;
      mfDragMode = 'move';
      mfDragStart = { mx, my, nx, ny };
      mfInitialBox = { ...box };
      renderManualFacePills();
      updateInputFields();
      drawManualFaceCanvas();
      return;
    }
  }

  const img = document.getElementById('manual-face-img');
  const maxNx = img.naturalWidth || 1000;
  const maxNy = img.naturalHeight || 1000;

  const newBox = {
    x: Math.min(maxNx - 10, Math.max(0, Math.round(nx))),
    y: Math.min(maxNy - 10, Math.max(0, Math.round(ny))),
    width: 20,
    height: 20
  };

  manualFaceBoxes.push(newBox);
  manualFaceSelectedIndex = manualFaceBoxes.length - 1;

  mfIsDragging = true;
  mfDragMode = 'draw';
  mfDragStart = { mx, my, nx: newBox.x, ny: newBox.y };
  mfInitialBox = { ...newBox };

  renderManualFacePills();
  updateInputFields();
  drawManualFaceCanvas();
}

function handleMfMouseMove(e) {
  const canvas = document.getElementById('manual-face-canvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const { scaleX, scaleY } = getCanvasScale();
  const nx = mx / scaleX;
  const ny = my / scaleY;

  if (!mfIsDragging) {
    if (manualFaceSelectedIndex >= 0 && manualFaceSelectedIndex < manualFaceBoxes.length) {
      const box = manualFaceBoxes[manualFaceSelectedIndex];
      const bx = box.x * scaleX;
      const by = box.y * scaleY;
      const bw = box.width * scaleX;
      const bh = box.height * scaleY;

      if (Math.abs(mx - bx) < 8 && Math.abs(my - by) < 8) canvas.style.cursor = 'nwse-resize';
      else if (Math.abs(mx - (bx + bw)) < 8 && Math.abs(my - by) < 8) canvas.style.cursor = 'nesw-resize';
      else if (Math.abs(mx - bx) < 8 && Math.abs(my - (by + bh)) < 8) canvas.style.cursor = 'nesw-resize';
      else if (Math.abs(mx - (bx + bw)) < 8 && Math.abs(my - (by + bh)) < 8) canvas.style.cursor = 'nwse-resize';
      else if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) canvas.style.cursor = 'move';
      else canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = 'crosshair';
    }
    return;
  }

  if (manualFaceSelectedIndex < 0 || manualFaceSelectedIndex >= manualFaceBoxes.length) return;

  const box = manualFaceBoxes[manualFaceSelectedIndex];
  const img = document.getElementById('manual-face-img');
  const maxW = img.naturalWidth || 2048;
  const maxH = img.naturalHeight || 2048;

  const dNx = Math.round(nx - mfDragStart.nx);
  const dNy = Math.round(ny - mfDragStart.ny);

  if (mfDragMode === 'move') {
    box.x = Math.max(0, Math.min(maxW - box.width, mfInitialBox.x + dNx));
    box.y = Math.max(0, Math.min(maxH - box.height, mfInitialBox.y + dNy));
  } else if (mfDragMode === 'draw') {
    let currX = mfDragStart.nx;
    let currY = mfDragStart.ny;
    let currW = Math.round(nx - currX);
    let currH = Math.round(ny - currY);

    if (currW < 0) {
      box.x = Math.max(0, currX + currW);
      box.width = Math.abs(currW);
    } else {
      box.x = currX;
      box.width = Math.min(maxW - currX, currW);
    }

    if (currH < 0) {
      box.y = Math.max(0, currY + currH);
      box.height = Math.abs(currH);
    } else {
      box.y = currY;
      box.height = Math.min(maxH - currY, currH);
    }
  } else if (mfDragMode.startsWith('resize-')) {
    const mode = mfDragMode.replace('resize-', '');

    let newX = mfInitialBox.x;
    let newY = mfInitialBox.y;
    let newW = mfInitialBox.width;
    let newH = mfInitialBox.height;

    if (mode.includes('w')) {
      const targetRight = mfInitialBox.x + mfInitialBox.width;
      newX = Math.max(0, Math.min(targetRight - 15, mfInitialBox.x + dNx));
      newW = targetRight - newX;
    }
    if (mode.includes('e')) {
      newW = Math.max(15, Math.min(maxW - mfInitialBox.x, mfInitialBox.width + dNx));
    }
    if (mode.includes('n')) {
      const targetBottom = mfInitialBox.y + mfInitialBox.height;
      newY = Math.max(0, Math.min(targetBottom - 15, mfInitialBox.y + dNy));
      newH = targetBottom - newY;
    }
    if (mode.includes('s')) {
      newH = Math.max(15, Math.min(maxH - mfInitialBox.y, mfInitialBox.height + dNy));
    }

    box.x = newX;
    box.y = newY;
    box.width = newW;
    box.height = newH;
  }

  updateInputFields();
  drawManualFaceCanvas();
}

function handleMfMouseUp() {
  if (!mfIsDragging) return;
  mfIsDragging = false;
  mfDragMode = null;

  if (manualFaceSelectedIndex >= 0 && manualFaceSelectedIndex < manualFaceBoxes.length) {
    const box = manualFaceBoxes[manualFaceSelectedIndex];
    if (box.width < 15) box.width = 15;
    if (box.height < 15) box.height = 15;
  }

  updateInputFields();
  drawManualFaceCanvas();
}

async function handleManualFaceUpdate() {
  if (!currentManualFacePhoto) return;

  if (manualFaceSelectedIndex < 0 || manualFaceSelectedIndex >= manualFaceBoxes.length) {
    alert("Please select or draw a face bounding box first.");
    return;
  }

  const box = manualFaceBoxes[manualFaceSelectedIndex];
  if (box.width < 15 || box.height < 15) {
    alert("Please make sure the bounding box width and height are at least 15 pixels.");
    return;
  }

  const statusBanner = document.getElementById('manual-face-status-banner');
  if (statusBanner) {
    statusBanner.className = 'badge badge-pending';
    statusBanner.style.display = 'block';
    statusBanner.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating face descriptor...`;
  }

  let clientDescriptor = null;
  const imgEl = document.getElementById('manual-face-img');
  if (imgEl && window.FaceDetectorUtils && typeof window.FaceDetectorUtils.extractDescriptorForBox === 'function') {
    let tempObjectUrl = null;
    try {
      let targetImg = imgEl;
      if (currentManualFacePhoto) {
        const photoUrl = getPhotoUrl(currentManualFacePhoto.filename, currentManualFacePhoto.storageUrl, currentManualFacePhoto.imageUrl);
        try {
          const resp = await fetch(photoUrl);
          if (resp.ok) {
            const blob = await resp.blob();
            tempObjectUrl = URL.createObjectURL(blob);
            const cleanImg = new Image();
            cleanImg.crossOrigin = 'anonymous';
            cleanImg.src = tempObjectUrl;
            await new Promise((res, rej) => {
              cleanImg.onload = res;
              cleanImg.onerror = rej;
            });
            targetImg = cleanImg;
          }
        } catch (fetchErr) {
          console.warn('[Manual Face] Blob fetch fallback to imgEl:', fetchErr.message);
        }
      }

      clientDescriptor = await window.FaceDetectorUtils.extractDescriptorForBox(targetImg, box);

      if (clientDescriptor) {
        console.log('[Manual Face] Client computed face descriptor successfully.');
      } else {
        console.warn('[Manual Face] Client face descriptor extraction returned null.');
      }
    } catch (descErr) {
      console.warn('[Manual Face] Error generating client face descriptor:', descErr ? descErr.message : descErr);
    } finally {
      if (tempObjectUrl) {
        try { URL.revokeObjectURL(tempObjectUrl); } catch (e) {}
      }
    }
  }

  try {
    const result = await adminFetch(`/api/admin/photos/${currentManualFacePhoto.id}/manual-face`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        faceIndex: manualFaceSelectedIndex,
        box,
        clientDescriptor
      })
    });

    if (result.success && result.photo) {
      const idx = window.allPhotos.findIndex(p => p.id === result.photo.id);
      if (idx !== -1) {
        window.allPhotos[idx] = result.photo;
      }
      currentManualFacePhoto = result.photo;

      manualFaceBoxes = result.photo.descriptors.map(item => item.box || { x: 0, y: 0, width: 0, height: 0 });
      if (result.faceIndex !== undefined && result.faceIndex >= 0) {
        manualFaceSelectedIndex = result.faceIndex;
      }

      if (statusBanner) {
        statusBanner.className = 'badge badge-approved';
        statusBanner.innerHTML = `<i class="fa-solid fa-circle-check"></i> Face descriptor updated successfully!`;
      }

      updateStatsAndRender();
      renderManualFacePills();
      updateInputFields();
      drawManualFaceCanvas();
      updateStatsAndRender();
    } else {
      throw new Error(result.error || 'Failed to update face descriptor');
    }
  } catch (err) {
    console.error('Update manual face error:', err);
    if (statusBanner) {
      statusBanner.className = 'badge badge-rejected';
      statusBanner.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Error: ${err.message}`;
    }
  }
}

async function handleManualFaceDelete() {
  if (!currentManualFacePhoto) return;

  if (manualFaceSelectedIndex < 0 || manualFaceSelectedIndex >= manualFaceBoxes.length) {
    alert("Please select a face bounding box to delete.");
    return;
  }

  if (!confirm(`Are you sure you want to delete Face #${manualFaceSelectedIndex + 1}?`)) {
    return;
  }

  const statusBanner = document.getElementById('manual-face-status-banner');
  if (statusBanner) {
    statusBanner.className = 'badge badge-pending';
    statusBanner.style.display = 'block';
    statusBanner.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Removing face descriptor...`;
  }

  try {
    const result = await adminFetch(`/api/admin/photos/${currentManualFacePhoto.id}/delete-face`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        faceIndex: manualFaceSelectedIndex
      })
    });

    if (result.success && result.photo) {
      const idx = window.allPhotos.findIndex(p => p.id === result.photo.id);
      if (idx !== -1) {
        window.allPhotos[idx] = result.photo;
      }
      currentManualFacePhoto = result.photo;

      manualFaceBoxes = result.photo.descriptors.map(item => item.box || { x: 0, y: 0, width: 0, height: 0 });
      manualFaceSelectedIndex = manualFaceBoxes.length > 0 ? 0 : -1;

      if (statusBanner) {
        statusBanner.className = 'badge badge-approved';
        statusBanner.innerHTML = `<i class="fa-solid fa-circle-check"></i> Face deleted successfully!`;
      }

      renderManualFacePills();
      updateInputFields();
      drawManualFaceCanvas();
      updateStatsAndRender();
    } else {
      throw new Error(result.error || 'Failed to delete face');
    }
  } catch (err) {
    console.error('Delete face error:', err);
    if (statusBanner) {
      statusBanner.className = 'badge badge-rejected';
      statusBanner.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Error: ${err.message}`;
    }
  }
}


