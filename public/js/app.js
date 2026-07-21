// ==========================================================================
// FaceMatch AI - Frontend Application Logic
// ==========================================================================

// Global state variables
window.galleryCatalog = [];
window.allEvents = [];
window.selectedEventId = localStorage.getItem('public_active_event_id') || 'all';
window.uploadQueue = [];
window.queryDescriptor = null;
window.searchQueryDescriptor = null;
window.searchQueryDescriptors = [];
window.webcamStream = null;
window.isWebcamActive = false;
window.faceApiLoaded = false;
window.selectedPhotoIds = new Set();
window.isSelectMode = false;
window.currentLightboxRotation = 0;
window.currentLightboxPhoto = null;

// Configuration & Face API
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

// Limits to protect browser memory
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB per file
const MAX_UPLOAD_QUEUE = 15; // max files in client-side queue (limit 15)
const MAX_ZIP_DOWNLOAD = 20; // max images to bundle client-side
// Gallery refresh settings
const GALLERY_POLL_INTERVAL = 30 * 1000; // 30 seconds
let galleryRefreshTimer = null;
// Gallery pagination to avoid rendering too many images at once
const GALLERY_PAGE_SIZE = 100; // images per page
let currentGalleryPage = 0;

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

// --- Initialize and Load Models ---
async function initFaceApi() {
  try {
    await loadFaceApiModels();
    const loader = document.getElementById('models-loader');
    if (loader) {
      loader.style.opacity = '0';
      setTimeout(() => loader.classList.add('hidden'), 500);
    }
  } catch (err) {
    console.error('Face API model load failed:', err);
  }
  // Fetch initial gallery files
  await fetchGallery();
}

// --- API Interactions ---

// Fetch gallery catalog
async function fetchGallery() {
  try {
    const headers = {};
    if (window.selectedEventId && window.selectedEventId !== 'all') {
      const passcode = getUnlockedEventPasscode(window.selectedEventId);
      if (passcode) {
        headers['x-event-passcode'] = passcode;
      }
    }

    const queryStr = (window.selectedEventId && window.selectedEventId !== 'all')
      ? `?eventId=${encodeURIComponent(window.selectedEventId)}`
      : '';

    const response = await fetch('/api/gallery' + queryStr, { headers });
    const result = await response.json();

    if (result.success) {
      if (!window.defaultEventApplied && result.defaultPublicEventId) {
        window.defaultEventApplied = true;
        const savedPref = localStorage.getItem('public_active_event_id');
        if (!savedPref && result.defaultPublicEventId !== 'all' && window.selectedEventId !== result.defaultPublicEventId) {
          window.selectedEventId = result.defaultPublicEventId;
          fetchGallery();
          return;
        }
      }

      if (result.passcodeRequired) {
        promptEventPasscode(result.eventId || window.selectedEventId);
        return;
      }

      window.galleryCatalog = result.photos;
      window.allEvents = result.events || [];
      window.publicGalleryEnabled = result.publicGalleryEnabled !== false;
      window.galleryHeading = result.galleryHeading || 'Gallery Catalog';
      window.allowPublicFaceAdjustment = result.allowPublicFaceAdjustment !== false;
      currentGalleryPage = 0;
      
      const headingEl = document.getElementById('gallery-catalog-heading');
      if (headingEl) {
        headingEl.innerText = window.galleryHeading;
      }
      
      populatePublicEventDropdowns();
      updateEventBanner();
      
      if (result.logoWidth) {
        const logoImg = document.querySelector('.logo-area img');
        if (logoImg) {
          logoImg.style.width = result.logoWidth + 'px';
        }
      }

      const banner = document.getElementById('gallery-announcement-banner');
      const bannerText = document.getElementById('gallery-announcement-text');
      window.globalGalleryMessage = (result.galleryMessage || '').trim();
      if (banner && bannerText) {
        if (window.globalGalleryMessage && (!window.selectedEventId || window.selectedEventId === 'all')) {
          bannerText.textContent = window.globalGalleryMessage;
          banner.style.display = 'block';
        }
      }
      
      updateGalleryUI();
    }
  } catch (err) {
    console.error("Error fetching gallery:", err);
  }
}

async function resizeImageIfNeeded(file, maxDim = 2048) {
  if (!file || !(file instanceof File || file instanceof Blob)) {
    return file;
  }
  if (window.FaceDetectorUtils && typeof window.FaceDetectorUtils.createOrientedCanvas === 'function') {
    try {
      const oriented = await window.FaceDetectorUtils.createOrientedCanvas(file, maxDim);
      return oriented.file;
    } catch (e) {
      console.warn('[Image Resizer] createOrientedCanvas failed:', e);
    }
  }
  return file;
}

// Upload photo with client-side descriptors
async function uploadPhoto(file, descriptors = []) {
  let fileToUpload = file;
  if (window.FaceDetectorUtils && typeof window.FaceDetectorUtils.createOrientedCanvas === 'function') {
    try {
      const oriented = await window.FaceDetectorUtils.createOrientedCanvas(file, 2048);
      fileToUpload = oriented.file;
    } catch (e) {
      console.warn('createOrientedCanvas fallback in uploadPhoto:', e);
    }
  }

  const formData = new FormData();
  formData.append('photo', fileToUpload);
  formData.append('descriptors', JSON.stringify(descriptors));

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    return await response.json();
  } catch (err) {
    console.error("Upload network error:", err);
    return { success: false, error: err.message };
  }
}

// Delete photo
async function deletePhoto(id) {
  try {
    const response = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const result = await response.json();
    if (result.success) {
      // Close lightbox
      closeLightbox();
      // Refresh list
      await fetchGallery();
      // Refresh search matches if there's an active query
      if (window.queryDescriptor) {
        performSearch();
      }
    } else {
      alert("Failed to delete photo: " + result.error);
    }
  } catch (err) {
    console.error("Delete call error:", err);
  }
}

// --- DOM Event Listeners & UI Navigation ---
document.addEventListener('DOMContentLoaded', () => {
  // Start AI models load
  initFaceApi();

  // Tab switching setup
  const navBtns = document.querySelectorAll('.nav-btn');
  const tabs = document.querySelectorAll('.tab-content');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      navBtns.forEach(b => b.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));

      btn.classList.add('active');
      const activeTabEl = document.getElementById(targetTab);
      activeTabEl.classList.add('active');

      // Stop webcam if switching away from search tab
      if (targetTab !== 'search-tab') {
        stopWebcam();
      }
    });
  });

  // Attach controls
  setupUploadTabEvents();
  setupSearchTabEvents();
  setupLightboxEvents();
  setupEventPasscodeModal();
  setupRightClickProtection();
  setupPublicFaceAdjustModal();
  startGalleryAutoRefresh();
});

// Start/stop gallery auto-refresh to keep gallery dynamic while leaving rest of page static
function startGalleryAutoRefresh() {
  // Immediately fetch once
  fetchGallery();
  if (galleryRefreshTimer) clearInterval(galleryRefreshTimer);
  galleryRefreshTimer = setInterval(() => {
    fetchGallery();
  }, GALLERY_POLL_INTERVAL);
}

function stopGalleryAutoRefresh() {
  if (galleryRefreshTimer) {
    clearInterval(galleryRefreshTimer);
    galleryRefreshTimer = null;
  }
}

// Pause refresh when the page is hidden to save resources
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopGalleryAutoRefresh(); else startGalleryAutoRefresh();
});

// --- Tab 1: Upload Logic ---
function setupUploadTabEvents() {
  const dragZone = document.getElementById('upload-drag-zone');
  const fileInput = document.getElementById('gallery-file-input');
  const previewCarousel = document.getElementById('preview-carousel');
  const startUploadBtn = document.getElementById('start-upload-btn');
  const clearQueueBtn = document.getElementById('clear-queue-btn');
  const queueContainer = document.getElementById('upload-queue-container');
  const refreshBtn = document.getElementById('refresh-gallery-btn');

  // Trigger input selection
  dragZone.addEventListener('click', () => fileInput.click());

  // Input file change
  fileInput.addEventListener('change', (e) => {
    handleFilesAdded(e.target.files);
  });

  // Drag and drop handlers
  dragZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dragZone.classList.add('dragover');
  });

  dragZone.addEventListener('dragleave', () => {
    dragZone.classList.remove('dragover');
  });

  dragZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFilesAdded(e.dataTransfer.files);
    }
  });

  // Actions
  startUploadBtn.addEventListener('click', startBatchUpload);
  clearQueueBtn.addEventListener('click', clearQueue);
  refreshBtn.addEventListener('click', fetchGallery);

  // Multi-select controls
  const selectModeBtn = document.getElementById('gallery-select-mode-btn');
  const batchSelectAllBtn = document.getElementById('batch-select-all-btn');
  const batchClearBtn = document.getElementById('batch-clear-btn');
  const batchDownloadBtn = document.getElementById('batch-download-btn');

  if (selectModeBtn) selectModeBtn.addEventListener('click', toggleSelectMode);
  if (batchSelectAllBtn) batchSelectAllBtn.addEventListener('click', selectAllPhotos);
  if (batchClearBtn) batchClearBtn.addEventListener('click', clearPhotoSelection);
  if (batchDownloadBtn) batchDownloadBtn.addEventListener('click', downloadSelectedPhotosZip);
}

// Batch Upload Queue Setup
window.publicBatchQueue = new FaceDetectorUtils.BatchUploadQueue({
  concurrency: 1,
  maxQueueSize: MAX_UPLOAD_QUEUE,
  maxRetries: 3,
  isPublic: true,
  onItemChange: (item, action) => {
    if (action === 'added') {
      renderQueueItem(item);
    } else if (action === 'removed') {
      const el = document.getElementById(item.id);
      if (el) el.remove();
    } else if (action === 'updated') {
      updateQueueItemUI(item);
    }
    updateQueueCount();
  },
  onProgress: ({ completed, total, percentage }) => {
    const progressBar = document.getElementById('upload-progress-fill');
    const statusText = document.getElementById('queue-status-text');
    if (progressBar) progressBar.style.width = `${percentage}%`;
    if (statusText) statusText.innerText = total > 0 ? `Processing uploads (${completed}/${total})...` : 'Ready to upload';
  },
  onComplete: async (queue) => {
    const startUploadBtn = document.getElementById('start-upload-btn');
    const clearQueueBtn = document.getElementById('clear-queue-btn');
    const progressBar = document.getElementById('upload-progress-fill');
    const statusText = document.getElementById('queue-status-text');

    const successCount = queue.filter(i => i.status === 'done').length;
    if (statusText) {
      statusText.innerHTML = `<span style='color:var(--success)'><i class='fa-solid fa-circle-check'></i> Upload complete! Successfully uploaded ${successCount}/${queue.length} photo(s).</span>`;
    }
    if (progressBar) progressBar.style.width = '100%';

    setTimeout(() => {
      if (progressBar) progressBar.style.width = '0%';
      if (startUploadBtn) startUploadBtn.classList.remove('disabled');
      if (clearQueueBtn) clearQueueBtn.classList.remove('disabled');
    }, 2000);

    await fetchGallery();
  }
});

function handleFilesAdded(fileList) {
  const queueContainer = document.getElementById('upload-queue-container');
  if (queueContainer) queueContainer.classList.remove('hidden');

  const currentCount = window.publicBatchQueue.queue.length;
  const availableSlots = MAX_UPLOAD_QUEUE - currentCount;

  if (availableSlots <= 0) {
    alert(`Maximum limit of ${MAX_UPLOAD_QUEUE} photos reached in upload queue.`);
    return;
  }

  const validFiles = [];
  let skippedCount = 0;

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (file.size > MAX_UPLOAD_SIZE) {
      alert(`${file.name} exceeds maximum allowed size of 50 MB.`);
      continue;
    }
    if (validFiles.length < availableSlots) {
      validFiles.push(file);
    } else {
      skippedCount++;
    }
  }

  if (skippedCount > 0) {
    alert(`Maximum batch upload limit is ${MAX_UPLOAD_QUEUE} photos. ${skippedCount} file(s) were excluded.`);
  }

  window.publicBatchQueue.addFiles(validFiles);
}

function renderQueueItem(item) {
  const carousel = document.getElementById('preview-carousel');
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
    <button class="preview-remove-btn" onclick="removeQueueItem('${item.id}')">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  carousel.appendChild(itemEl);
  carousel.scrollTop = carousel.scrollHeight;
}

function updateQueueItemUI(item) {
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

window.removeQueueItem = function(id) {
  window.publicBatchQueue.removeItem(id);
};

function updateQueueCount() {
  const countSpan = document.getElementById('queue-count');
  if (countSpan) countSpan.innerText = window.publicBatchQueue.queue.length;

  const container = document.getElementById('upload-queue-container');
  if (container && window.publicBatchQueue.queue.length === 0) {
    container.classList.add('hidden');
  }
}

function clearQueue() {
  window.publicBatchQueue.clear();
  const carousel = document.getElementById('preview-carousel');
  if (carousel) carousel.innerHTML = '';
  updateQueueCount();
}

async function startBatchUpload() {
  const startUploadBtn = document.getElementById('start-upload-btn');
  const clearQueueBtn = document.getElementById('clear-queue-btn');
  
  if (window.publicBatchQueue.queue.length === 0) {
    alert("No photos in queue ready for upload.");
    return;
  }

  const eventId = (!window.selectedEventId || window.selectedEventId === 'all') ? '' : window.selectedEventId;
  window.publicBatchQueue.eventId = eventId;

  // If selected event is passcode-protected, include passcode in upload
  if (eventId) {
    const passcode = getUnlockedEventPasscode(eventId);
    window.publicBatchQueue.passcode = passcode || '';
  } else {
    window.publicBatchQueue.passcode = '';
  }

  if (startUploadBtn) startUploadBtn.classList.add('disabled');
  if (clearQueueBtn) clearQueueBtn.classList.add('disabled');

  window.publicBatchQueue.start();
}

function getFilteredGalleryPhotos() {
  if (!window.selectedEventId || window.selectedEventId === 'all') {
    return window.galleryCatalog;
  }
  return window.galleryCatalog.filter(p => p.eventId === window.selectedEventId);
}

// Update the gallery catalog grid in UI
function updateGalleryUI() {
  const totalCountEl = document.getElementById('gallery-total-count');
  const emptyState = document.getElementById('empty-gallery-state');
  const grid = document.getElementById('gallery-grid');
  const headingEl = document.getElementById('gallery-catalog-heading');
  if (headingEl) {
    headingEl.innerText = window.galleryHeading || 'Gallery Catalog';
  }

  const filteredPhotos = getFilteredGalleryPhotos();
  totalCountEl.innerText = filteredPhotos.length;
  grid.innerHTML = '';

  if (window.publicGalleryEnabled === false) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    emptyState.innerHTML = `
      <i class="fa-solid fa-lock empty-icon" style="color: var(--warning)"></i>
      <h3>Public Gallery is Private</h3>
      <p>The administrator has disabled public browsing. Please use the <strong>"Find My Photos"</strong> tab to securely retrieve your photos using face search.</p>
    `;
    return;
  }

  if (filteredPhotos.length === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    emptyState.innerHTML = `
      <i class="fa-regular fa-image empty-icon"></i>
      <h3>No Photos in Gallery</h3>
      <p>No photos match the selected event or gallery is empty.</p>
    `;
    return;
  }

  emptyState.classList.add('hidden');
  grid.classList.remove('hidden');
  // Render only a page of gallery items to limit memory usage
  renderGalleryPage();
}

// --- Multi-Select Gallery Logic ---
function toggleSelectMode() {
  window.isSelectMode = !window.isSelectMode;
  const selectModeBtn = document.getElementById('gallery-select-mode-btn');
  const batchBar = document.getElementById('gallery-batch-bar');

  if (window.isSelectMode) {
    if (selectModeBtn) {
      selectModeBtn.classList.remove('btn-secondary');
      selectModeBtn.classList.add('btn-primary');
      selectModeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i> Exit Selection`;
    }
    if (batchBar) batchBar.classList.remove('hidden');
  } else {
    window.selectedPhotoIds.clear();
    if (selectModeBtn) {
      selectModeBtn.classList.remove('btn-primary');
      selectModeBtn.classList.add('btn-secondary');
      selectModeBtn.innerHTML = `<i class="fa-solid fa-list-check"></i> Select Photos`;
    }
    if (batchBar) batchBar.classList.add('hidden');
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const batchBar = document.getElementById('gallery-batch-bar');
  const countEl = document.getElementById('batch-selected-count');
  const downloadBtn = document.getElementById('batch-download-btn');
  const selectedCount = window.selectedPhotoIds.size;

  if (countEl) countEl.innerText = selectedCount;

  if (downloadBtn) {
    downloadBtn.disabled = selectedCount === 0;
  }

  if (selectedCount > 0 && batchBar) {
    batchBar.classList.remove('hidden');
  }

  const grid = document.getElementById('gallery-grid');
  if (grid) {
    const items = grid.querySelectorAll('.gallery-item');
    items.forEach(item => {
      const id = item.getAttribute('data-photo-id');
      if (id && window.selectedPhotoIds.has(id)) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }
}

function selectAllPhotos() {
  if (!window.galleryCatalog) return;
  window.galleryCatalog.forEach(photo => {
    if (photo.id) window.selectedPhotoIds.add(photo.id);
  });
  if (!window.isSelectMode) toggleSelectMode(); else updateSelectionUI();
}

function clearPhotoSelection() {
  window.selectedPhotoIds.clear();
  updateSelectionUI();
}

async function downloadSelectedPhotosZip() {
  if (window.selectedPhotoIds.size === 0) return;

  const downloadBtn = document.getElementById('batch-download-btn');
  const originalHtml = downloadBtn ? downloadBtn.innerHTML : '';

  if (downloadBtn) {
    downloadBtn.disabled = true;
    downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Zipping ${window.selectedPhotoIds.size}...`;
  }

  try {
    const zip = new JSZip();
    const folder = zip.folder("smriti_chitra_photos");

    const selectedPhotos = window.galleryCatalog.filter(p => window.selectedPhotoIds.has(p.id));

    for (let i = 0; i < selectedPhotos.length; i++) {
      const photo = selectedPhotos[i];
      const imageUrl = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
      
      try {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        
        let filename = photo.originalName || `photo_${i + 1}.jpg`;
        folder.file(filename, blob);
      } catch (err) {
        console.error(`Failed to fetch ${photo.originalName}:`, err);
      }
    }

    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `gallery-photos-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

  } catch (err) {
    console.error("Failed to generate ZIP:", err);
    alert("Could not generate ZIP: " + err.message);
  } finally {
    if (downloadBtn) {
      downloadBtn.disabled = window.selectedPhotoIds.size === 0;
      downloadBtn.innerHTML = originalHtml;
    }
  }
}

// Render a page of gallery items and optionally append a Load More button
function renderGalleryPage() {
  const grid = document.getElementById('gallery-grid');
  const emptyState = document.getElementById('empty-gallery-state');

  const photos = getFilteredGalleryPhotos();
  const start = 0;
  const end = Math.min(photos.length, GALLERY_PAGE_SIZE * (currentGalleryPage + 1));

  grid.innerHTML = '';

  if (end === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  grid.classList.remove('hidden');

  for (let i = start; i < end; i++) {
    const photo = photos[i];
    const itemEl = document.createElement('div');
    itemEl.className = 'gallery-item';
    if (photo.id) itemEl.setAttribute('data-photo-id', photo.id);

    if (photo.id && window.selectedPhotoIds.has(photo.id)) {
      itemEl.classList.add('selected');
    }

    itemEl.addEventListener('click', (e) => {
      // Toggle selection if checkbox clicked or in select mode
      if (e.target.closest('.gallery-item-checkbox') || window.isSelectMode) {
        e.stopPropagation();
        if (photo.id) {
          if (window.selectedPhotoIds.has(photo.id)) {
            window.selectedPhotoIds.delete(photo.id);
          } else {
            window.selectedPhotoIds.add(photo.id);
            if (!window.isSelectMode) {
              window.isSelectMode = true;
              const selectModeBtn = document.getElementById('gallery-select-mode-btn');
              if (selectModeBtn) {
                selectModeBtn.classList.remove('btn-secondary');
                selectModeBtn.classList.add('btn-primary');
                selectModeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i> Exit Selection`;
              }
            }
          }
          updateSelectionUI();
        }
      } else {
        openLightbox(photo);
      }
    });

    const dateStr = new Date(photo.timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });

    const facesCount = photo.descriptors ? photo.descriptors.length : 0;
    const badgeHtml = facesCount > 0 
      ? `<span class="faces-count-badge faces-count-badge-corner"><i class="fa-solid fa-user-tag"></i> ${facesCount}</span>`
      : '';

    itemEl.innerHTML = `
      <div class="gallery-item-checkbox" title="Select photo">
        <i class="fa-solid fa-check"></i>
      </div>
      ${badgeHtml}
      <div class="gallery-image-wrapper">
        <img src="${getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl)}" class="gallery-image" alt="Gallery photo" loading="lazy">
        <div class="gallery-item-overlay">
          <div class="gallery-item-info">
            <p class="gallery-item-name">${photo.originalName}</p>
            <p class="gallery-item-date">${dateStr}</p>
          </div>
        </div>
      </div>
    `;

    grid.appendChild(itemEl);
  }

  // Add Load More button if there are more items
  const moreContainerId = 'gallery-load-more-container';
  let moreContainer = document.getElementById(moreContainerId);
  if (moreContainer) moreContainer.remove();

  if (end < window.galleryCatalog.length) {
    moreContainer = document.createElement('div');
    moreContainer.id = moreContainerId;
    moreContainer.style.textAlign = 'center';
    moreContainer.style.margin = '16px 0';
    moreContainer.innerHTML = `<button id="gallery-load-more-btn" class="btn btn-secondary">Load more</button>`;
    grid.parentNode.appendChild(moreContainer);
    document.getElementById('gallery-load-more-btn').addEventListener('click', () => {
      currentGalleryPage++;
      renderGalleryPage();
    });
  }
}

// --- Tab 2: Face Search & Webcam Logic ---
function setupSearchTabEvents() {
  const fileModeBtn = document.getElementById('toggle-file-mode');
  const cameraModeBtn = document.getElementById('toggle-camera-mode');
  const fileInput = document.getElementById('search-file-input');
  const dragZone = document.getElementById('search-drag-zone');
  const removeBtn = document.getElementById('remove-search-file-btn');
  const searchBtn = document.getElementById('execute-search-btn');
  const thresholdSlider = document.getElementById('threshold-slider');
  const sliderValText = document.getElementById('threshold-val');
  const zipBtn = document.getElementById('download-all-matches-btn');

  // Input toggles
  fileModeBtn.addEventListener('click', () => {
    fileModeBtn.classList.add('active');
    cameraModeBtn.classList.remove('active');
    document.getElementById('search-drag-zone').classList.remove('hidden');
    document.getElementById('camera-zone').classList.add('hidden');
    stopWebcam();
  });

  cameraModeBtn.addEventListener('click', () => {
    cameraModeBtn.classList.add('active');
    fileModeBtn.classList.remove('active');
    document.getElementById('search-drag-zone').classList.add('hidden');
    document.getElementById('camera-zone').classList.remove('hidden');
    startWebcam();
  });

  // File loading
  dragZone.addEventListener('click', (e) => {
    // Avoid double trigger if clicking overlay controls
    if (e.target !== removeBtn && !removeBtn.contains(e.target)) {
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleSearchFileSelected(e.target.files[0]);
    }
  });

  // Drag over
  dragZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dragZone.classList.add('dragover');
  });

  dragZone.addEventListener('dragleave', () => {
    dragZone.classList.remove('dragover');
  });

  dragZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleSearchFileSelected(e.dataTransfer.files[0]);
    }
  });

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearSearchFile();
  });

  // Sensitivity slider
  thresholdSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    let desc = "Balanced";
    if (val < 0.45) desc = "Strict";
    else if (val > 0.60) desc = "Loose";
    
    sliderValText.innerText = `${desc} (${val.toFixed(2)})`;
    
    // Automatically re-run search if a query image is loaded
    if (window.searchQueryImage) {
      performSearch();
    }
  });

  // Run Search
  searchBtn.addEventListener('click', () => {
    if (window.searchQueryDescriptor) {
      performSearch();
    }
  });

  // Webcam actions
  document.getElementById('stop-camera-btn').addEventListener('click', stopWebcam);
  document.getElementById('capture-photo-btn').addEventListener('click', captureCameraSearch);

  // Zip match download
  zipBtn.addEventListener('click', downloadAllMatchesZip);
}

// Search file selection
async function detectFacesOnServer(fileOrBase64) {
  const formData = new FormData();
  if (typeof fileOrBase64 === 'string') {
    const blob = await fetch(fileOrBase64).then(r => r.blob());
    formData.append('photo', blob, 'webcam.jpg');
  } else {
    const resizedFile = await resizeImageIfNeeded(fileOrBase64);
    formData.append('photo', resizedFile);
  }

  const response = await fetch('/api/detect-faces', {
    method: 'POST',
    body: formData
  });
  const result = await response.json();
  if (result.success) {
    return result.faces || [];
  } else {
    throw new Error(result.error || 'Server face detection failed');
  }
}

// Search file selection
async function handleSearchFileSelected(file) {
  const prompt = document.getElementById('search-upload-prompt');
  const previewContainer = document.getElementById('search-preview-container');
  const canvas = document.getElementById('search-preview-canvas');
  const feedbackCard = document.getElementById('search-feedback-card');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackDesc = document.getElementById('feedback-desc');
  const searchBtn = document.getElementById('execute-search-btn');

  // Reset
  window.searchQueryImage = file;
  searchBtn.classList.remove('disabled');

  prompt.classList.add('hidden');
  previewContainer.classList.remove('hidden');
  feedbackCard.classList.remove('hidden');

  feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Processing Photo...`;
  feedbackDesc.innerText = "Preparing image...";

  try {
    // Render on canvas
    const img = new Image();
    // Check file size for search image
    if (file.size > MAX_UPLOAD_SIZE) {
      alert('Search image is too large. Please use an image up to 30 MB.');
      clearSearchFile();
      return;
    }

    const url = URL.createObjectURL(file);
    // Keep a reference so we can revoke on clear
    window.searchQueryObjectUrl = url;

    img.onload = async () => {
      const ctx = canvas.getContext('2d');
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      try { URL.revokeObjectURL(url); } catch (e) {}
      // clear stored object url since it's revoked
      window.searchQueryObjectUrl = null;

      let descriptors = [];
      // Compute descriptors immediately
      try {
        feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Detecting face (browser)...`;
        feedbackDesc.innerText = 'Running face-api.js in your browser...';
        descriptors = await computeFaceDescriptorsWithTimeout(file, 20000);
      } catch (faceErr) {
        console.warn('Browser face detection failed/timed out, trying server-side...', faceErr);
      }

      if (!descriptors || descriptors.length === 0) {
        try {
          feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Detecting face (server)...`;
          feedbackDesc.innerText = 'Running robust server-side face detector...';
          descriptors = await detectFacesOnServer(file);
        } catch (serverErr) {
          console.error('Server face detection failed:', serverErr);
        }
      }

      // Limit to only 1 face for "Find My Photo" search
      if (descriptors && descriptors.length > 1) {
        descriptors = descriptors.slice(0, 1);
      }

      window.searchQueryDescriptors = descriptors;
      window.searchQueryDescriptor = descriptors && descriptors.length > 0 ? descriptors[0].descriptor : null;

      if (!descriptors || descriptors.length === 0) {
        feedbackTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> No Face Detected`;
        feedbackDesc.innerText = 'We could not detect any face in this image on the browser or server. Please choose a different photo.';
        searchBtn.classList.add('disabled');
      } else {
        feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981"></i> Face Detected`;
        feedbackDesc.innerText = `Ready to search the gallery using 1 detected face.`;
        searchBtn.classList.remove('disabled');

        const adjustBtn = document.getElementById('adjust-search-face-btn');
        if (adjustBtn) {
          adjustBtn.style.display = window.allowPublicFaceAdjustment !== false ? 'inline-block' : 'none';
        }
        
        // Auto-run search for best user experience
        performSearch();
      }
    };
    img.src = url;
  } catch (err) {
    console.error("Error displaying search image:", err);
  }
}

function clearSearchFile() {
  document.getElementById('search-file-input').value = '';
  document.getElementById('search-upload-prompt').classList.remove('hidden');
  document.getElementById('search-preview-container').classList.add('hidden');
  document.getElementById('search-feedback-card').classList.add('hidden');
  document.getElementById('execute-search-btn').classList.add('disabled');
  const adjustBtn = document.getElementById('adjust-search-face-btn');
  if (adjustBtn) adjustBtn.style.display = 'none';
  // Revoke any object URL used for preview
  if (window.searchQueryObjectUrl) {
    try { URL.revokeObjectURL(window.searchQueryObjectUrl); } catch (e) {}
    window.searchQueryObjectUrl = null;
  }
  window.searchQueryImage = null;

  // Clear preview canvas to free memory
  const canvas = document.getElementById('search-preview-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
  }
}

// --- Webcam Integration ---
async function startWebcam() {
  const video = document.getElementById('webcam-video');
  const overlay = document.getElementById('webcam-overlay');
  
  if (window.isWebcamActive) return;

  try {
    window.webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }
    });
    video.srcObject = window.webcamStream;
    window.isWebcamActive = true;
    
    video.onloadedmetadata = () => {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    };
  } catch (err) {
    console.error("Webcam access failed:", err);
    alert("Could not access camera. Please check camera permissions or use File mode.");
    // Toggle back to file mode
    document.getElementById('toggle-file-mode').click();
  }
}

function stopWebcam() {
  const video = document.getElementById('webcam-video');
  if (window.webcamStream) {
    window.webcamStream.getTracks().forEach(track => track.stop());
    window.webcamStream = null;
  }
  video.srcObject = null;
  window.isWebcamActive = false;
  
  // Clear canvas overlay
  const overlay = document.getElementById('webcam-overlay');
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
}

// Capture photo and match
async function captureCameraSearch() {
  const video = document.getElementById('webcam-video');
  const feedbackCard = document.getElementById('search-feedback-card');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackDesc = document.getElementById('feedback-desc');

  feedbackCard.classList.remove('hidden');
  feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Processing...`;
  feedbackDesc.innerText = "Analyzing portrait...";

  try {
    // Capture to a temporary canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    // Stop webcam
    stopWebcam();

    // Show captured image on file preview drag zone
    const previewContainer = document.getElementById('search-preview-container');
    const canvas = document.getElementById('search-preview-canvas');
    document.getElementById('search-drag-zone').classList.remove('hidden');
    document.getElementById('camera-zone').classList.add('hidden');
    document.getElementById('toggle-file-mode').classList.add('active');
    document.getElementById('toggle-camera-mode').classList.remove('active');

    document.getElementById('search-upload-prompt').classList.add('hidden');
    previewContainer.classList.remove('hidden');
    
    canvas.width = tempCanvas.width;
    canvas.height = tempCanvas.height;
    canvas.getContext('2d').drawImage(tempCanvas, 0, 0);

    const base64Data = tempCanvas.toDataURL('image/jpeg');
    window.searchQueryImage = base64Data;
    document.getElementById('search-file-input').value = '';
    document.getElementById('search-upload-prompt').classList.add('hidden');
    document.getElementById('search-preview-container').classList.remove('hidden');

    canvas.width = tempCanvas.width;
    canvas.height = tempCanvas.height;
    canvas.getContext('2d').drawImage(tempCanvas, 0, 0);

    let descriptors = [];
    try {
      feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Detecting face (browser)...`;
      feedbackDesc.innerText = 'Running face-api.js in your browser...';
      descriptors = await computeFaceDescriptors(base64Data);
    } catch (faceErr) {
      console.warn('Browser webcam face detection failed, trying server-side...', faceErr);
    }

    if (!descriptors || descriptors.length === 0) {
      try {
        feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Detecting face (server)...`;
        feedbackDesc.innerText = 'Running robust server-side face detector...';
        descriptors = await detectFacesOnServer(base64Data);
      } catch (serverErr) {
        console.error('Server-side webcam face detection failed:', serverErr);
      }
    }

    // Limit to only 1 face for "Find My Photo" search
    if (descriptors && descriptors.length > 1) {
      descriptors = descriptors.slice(0, 1);
    }

    window.searchQueryDescriptors = descriptors;
    window.searchQueryDescriptor = descriptors && descriptors.length > 0 ? descriptors[0].descriptor : null;

    if (!descriptors || descriptors.length === 0) {
      feedbackTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> No Face Detected`;
      feedbackDesc.innerText = 'Please capture another photo with a clear face.';
      document.getElementById('execute-search-btn').classList.add('disabled');
      return;
    }

    feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981"></i> Captured!`;
    feedbackDesc.innerText = `Detected 1 face, searching gallery...`;
    document.getElementById('execute-search-btn').classList.remove('disabled');

    // Automatically perform search
    performSearch();
  } catch (err) {
    console.error("Camera capture search error:", err);
    feedbackTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> Error`;
    feedbackDesc.innerText = err.message;
  }
}

async function performSearch() {
  if (!window.searchQueryImage) return;

  const threshold = parseFloat(document.getElementById('threshold-slider').value);
  const resultsGrid = document.getElementById('search-grid');
  const emptyState = document.getElementById('empty-search-state');
  const summaryText = document.getElementById('search-results-summary');
  const downloadAllBtn = document.getElementById('download-all-matches-btn');

  summaryText.innerText = "Searching gallery...";

  if (!window.searchQueryDescriptor) {
    summaryText.innerText = "No face descriptor available";
    return;
  }

  const searchEventId = (!window.selectedEventId || window.selectedEventId === 'all') ? 'all' : window.selectedEventId;

  try {
    const searchHeaders = { 'Content-Type': 'application/json' };
    // Include passcode header if the selected event is passcode-protected
    if (searchEventId !== 'all') {
      const passcode = getUnlockedEventPasscode(searchEventId);
      if (passcode) {
        searchHeaders['x-event-passcode'] = passcode;
      }
    }

    const response = await fetch('/api/search', {
      method: 'POST',
      headers: searchHeaders,
      body: JSON.stringify({
        descriptors: window.searchQueryDescriptors,
        threshold: threshold,
        eventId: searchEventId
      })
    });
    
    const result = await response.json();
    if (!result.success) {
      summaryText.innerText = "Search failed";
      alert("Search failed: " + result.error);
      return;
    }

    const matches = result.matches || [];

    // Store active matches on window for ZIP downloads
    window.activeSearchMatches = matches.map(m => m.photo);

    // Render Grid
    resultsGrid.innerHTML = '';

    if (matches.length === 0) {
      // Show empty state
      emptyState.classList.remove('hidden');
      resultsGrid.classList.add('hidden');
      downloadAllBtn.classList.add('hidden');

      document.getElementById('empty-search-title').innerText = "No Matches Found";
      document.getElementById('empty-search-desc').innerText = `We couldn't find any photos matching this face. Try adjusting the match precision slider to 'Loose' or uploading a different portrait.`;
      summaryText.innerText = "Found 0 matching photos";
      return;
    }

    // Populate Grid
    emptyState.classList.add('hidden');
    resultsGrid.classList.remove('hidden');
    downloadAllBtn.classList.remove('hidden');

    summaryText.innerText = `Found ${matches.length} matching photo(s)`;

    matches.forEach(match => {
      const photo = match.photo;
      const card = document.createElement('div');
      card.className = 'gallery-item';
      card.addEventListener('click', () => openLightbox(photo));

      const dateStr = new Date(photo.timestamp).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric'
      });

      card.innerHTML = `
        <div class="match-score-badge">
          <i class="fa-solid fa-circle-check"></i> ${match.confidence}% match
        </div>
        <div class="gallery-image-wrapper">
          <img src="${getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl)}" class="gallery-image" alt="Match">
          <div class="gallery-item-overlay">
            <div class="gallery-item-info">
              <p class="gallery-item-name">${photo.originalName}</p>
              <p class="gallery-item-date">${dateStr}</p>
            </div>
          </div>
        </div>
      `;

      resultsGrid.appendChild(card);
    });
  } catch (err) {
    console.error("Search API error:", err);
    summaryText.innerText = "Error performing search";
  }
}

// Download matches bundle as ZIP
async function downloadAllMatchesZip() {
  if (!window.activeSearchMatches || window.activeSearchMatches.length === 0) return;

  if (window.activeSearchMatches.length > MAX_ZIP_DOWNLOAD) {
    alert('Too many images to download at once. Please narrow results or download fewer images.');
    return;
  }

  const zipBtn = document.getElementById('download-all-matches-btn');
  const originalHtml = zipBtn.innerHTML;

  zipBtn.classList.add('disabled');
  zipBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Bundling Zip...`;

  try {
    const zip = new JSZip();
    const folder = zip.folder("my_photos");

    // Fetch and add each image to zip
    for (let i = 0; i < window.activeSearchMatches.length; i++) {
      const photo = window.activeSearchMatches[i];
      const imageUrl = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
      
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      
      // Use original file name, append number if duplicates
      folder.file(photo.originalName, blob);
    }

    // Generate zip and trigger download
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `facematch-results-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

  } catch (err) {
    console.error("Failed to build Zip archive:", err);
    alert("Could not generate ZIP archive: " + err.message);
  } finally {
    zipBtn.classList.remove('disabled');
    zipBtn.innerHTML = originalHtml;
  }
}

// --- Lightbox Modal Logic & Image Rotation ---
function setupLightboxEvents() {
  const modal = document.getElementById('lightbox-modal');
  const closeBtn = document.getElementById('lightbox-close-btn');

  closeBtn.addEventListener('click', closeLightbox);
  
  // Close on outside click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeLightbox();
    }
  });

  // Escape key close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      closeLightbox();
    }
  });

  // Rotation controls
  const rotateLeftBtn = document.getElementById('rotate-left-btn');
  const rotateRightBtn = document.getElementById('rotate-right-btn');
  const rotateResetBtn = document.getElementById('rotate-reset-btn');
  const downloadBtn = document.getElementById('lightbox-download-btn');

  if (rotateLeftBtn) rotateLeftBtn.addEventListener('click', () => rotateLightboxImage(-90));
  if (rotateRightBtn) rotateRightBtn.addEventListener('click', () => rotateLightboxImage(90));
  if (rotateResetBtn) rotateResetBtn.addEventListener('click', () => resetLightboxRotation());
  if (downloadBtn) downloadBtn.addEventListener('click', downloadCurrentLightboxPhoto);
}

function rotateLightboxImage(delta) {
  window.currentLightboxRotation = (window.currentLightboxRotation + delta + 360) % 360;
  applyLightboxRotation();
}

function resetLightboxRotation() {
  window.currentLightboxRotation = 0;
  applyLightboxRotation();
}

function applyLightboxRotation() {
  const img = document.getElementById('lightbox-img');
  const canvas = document.getElementById('lightbox-canvas');
  const angle = window.currentLightboxRotation || 0;

  if (img) {
    img.style.transform = `rotate(${angle}deg)`;
  }
  if (canvas) {
    // Canvas face overlays align best at 0deg
    if (angle !== 0) {
      canvas.style.display = 'none';
    } else {
      canvas.style.display = 'block';
    }
  }
}

function openLightbox(photo) {
  window.currentLightboxPhoto = photo;
  window.currentLightboxRotation = 0;
  applyLightboxRotation();

  const modal = document.getElementById('lightbox-modal');
  const img = document.getElementById('lightbox-img');
  const canvas = document.getElementById('lightbox-canvas');
  const filename = document.getElementById('detail-filename');
  const date = document.getElementById('detail-date');
  const faces = document.getElementById('detail-faces');
  const downloadLink = document.getElementById('lightbox-download-link');
  const deleteBtn = document.getElementById('lightbox-delete-btn');

  const photoUrl = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);

  img.src = photoUrl;
  filename.innerText = photo.originalName;
  
  date.innerText = new Date(photo.timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const facesCount = photo.descriptors ? photo.descriptors.length : 0;
  faces.innerText = facesCount > 0 ? `${facesCount} face(s) identified` : 'No Face Detected';

  const activeEvt = (window.allEvents || []).find(e => e.id === (photo.eventId || window.selectedEventId));
  const allowDownload = !activeEvt || activeEvt.allowDownload !== false;

  const downloadBtn = document.getElementById('lightbox-download-btn');
  if (downloadBtn) {
    downloadBtn.style.display = allowDownload ? 'block' : 'none';
  }
  if (downloadLink) {
    downloadLink.style.display = allowDownload ? 'block' : 'none';
    downloadLink.href = photoUrl;
    downloadLink.setAttribute('download', photo.originalName);
  }

  // Hide delete button for normal public users
  if (deleteBtn) deleteBtn.style.display = 'none';

  deleteBtn.onclick = () => {
    if (confirm("Are you sure you want to delete this photo permanently? This action cannot be undone.")) {
      deletePhoto(photo.id);
    }
  };

  modal.style.display = 'flex';

  // Draw face highlight boxes in lightbox on top of the image
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

async function downloadCurrentLightboxPhoto() {
  const photo = window.currentLightboxPhoto;
  if (!photo) return;

  const activeEvt = (window.allEvents || []).find(e => e.id === (photo.eventId || window.selectedEventId));
  if (activeEvt && activeEvt.allowDownload === false) {
    alert("Downloading photos is disabled for this event.");
    return;
  }

  const imageUrl = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
  const filename = photo.originalName || 'photo.jpg';
  const angle = window.currentLightboxRotation || 0;

  const downloadBtn = document.getElementById('lightbox-download-btn');
  const originalHtml = downloadBtn ? downloadBtn.innerHTML : '';

  if (angle === 0) {
    // Download original directly via fetch -> blob or link
    try {
      if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Downloading...`;
      }
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      // Fallback to direct link click if fetch fails (e.g. CORS)
      const link = document.createElement('a');
      link.href = imageUrl;
      link.download = filename;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = originalHtml;
      }
    }
    return;
  }

  if (downloadBtn) {
    downloadBtn.disabled = true;
    downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Rotating & Downloading...`;
  }

  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageUrl;

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Failed to load image for rotation rendering"));
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    if (angle === 90 || angle === 270) {
      canvas.width = height;
      canvas.height = width;
    } else {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(img, -width / 2, -height / 2);

    canvas.toBlob((blob) => {
      if (!blob) {
        alert('Failed to generate rotated image blob.');
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);

      const extIndex = filename.lastIndexOf('.');
      const rotatedFilename = extIndex !== -1 
        ? `${filename.substring(0, extIndex)}_rotated_${angle}deg${filename.substring(extIndex)}`
        : `${filename}_rotated_${angle}deg.jpg`;

      link.download = rotatedFilename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }, 'image/jpeg', 0.95);

  } catch (err) {
    console.error("Rotated photo download error:", err);
    alert("Could not download rotated image: " + err.message);
  } finally {
    if (downloadBtn) {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = originalHtml;
    }
  }
}

function closeLightbox() {
  const modal = document.getElementById('lightbox-modal');
  modal.style.display = 'none';
  window.currentLightboxPhoto = null;
  window.currentLightboxRotation = 0;
  applyLightboxRotation();

  document.getElementById('lightbox-img').src = '';
  const canvas = document.getElementById('lightbox-canvas');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// --- Public Event Logic ---
function renderPublicEventFilterPills() {
  const container = document.getElementById('event-filter-pills');
  if (!container) return;

  const events = window.allEvents || [];
  let html = `<button class="filter-pill ${(!window.selectedEventId || window.selectedEventId === 'all') ? 'active' : ''}" onclick="selectPublicEvent('all')">All Events</button>`;
  
  events.forEach(evt => {
    const isSelected = window.selectedEventId === evt.id;
    html += `<button class="filter-pill ${isSelected ? 'active' : ''}" onclick="selectPublicEvent('${evt.id}')">${evt.title || evt.name}</button>`;
  });

  container.innerHTML = html;
}

// --- Public Event Logic ---
window.selectPublicEvent = function(eventId) {
  if (eventId && eventId !== 'all') {
    const evt = (window.allEvents || []).find(e => e.id === eventId);
    if (evt && (evt.hasPasscode || evt.passcode)) {
      const unlocked = getUnlockedEventPasscode(eventId);
      if (!unlocked) {
        promptEventPasscode(eventId);
        return;
      }
    }
  }

  window.selectedEventId = eventId || 'all';
  try {
    localStorage.setItem('public_active_event_id', window.selectedEventId);
  } catch (e) {}

  const globalPicker = document.getElementById('global-event-picker');
  if (globalPicker) globalPicker.value = window.selectedEventId;

  updateUploadEventIndicator();
  updateEventBanner();
  currentGalleryPage = 0;
  fetchGallery();
};

function updateEventBanner() {
  const banner = document.getElementById('gallery-selected-event-banner');
  const titleEl = document.getElementById('event-banner-title');
  const descEl = document.getElementById('event-banner-desc');
  const dateEl = document.getElementById('event-banner-date');
  const announcementBanner = document.getElementById('gallery-announcement-banner');
  const announcementText = document.getElementById('gallery-announcement-text');

  const activeEvt = (window.allEvents || []).find(e => e.id === window.selectedEventId);

  // Apply right click class to body
  if (activeEvt && activeEvt.disableRightClick) {
    document.body.classList.add('protected-event-no-rightclick');
  } else {
    document.body.classList.remove('protected-event-no-rightclick');
  }

  if (!window.selectedEventId || window.selectedEventId === 'all' || !activeEvt) {
    if (banner) banner.style.display = 'none';
    if (announcementBanner && announcementText) {
      const globalMsg = (window.globalGalleryMessage || '').trim();
      if (globalMsg) {
        announcementText.textContent = globalMsg;
        announcementBanner.style.display = 'block';
      } else {
        announcementBanner.style.display = 'none';
      }
    }
    return;
  }

  if (banner) {
    banner.style.display = 'block';
    if (titleEl) titleEl.innerText = activeEvt.title || activeEvt.name;
    if (descEl) descEl.innerText = activeEvt.description || 'Event Gallery';
    if (dateEl) dateEl.innerText = activeEvt.date ? `Date: ${activeEvt.date}` : '';
  }

  // Update Announcement Banner per Event
  if (announcementBanner && announcementText) {
    const eventMsg = (activeEvt.announcementMessage || window.globalGalleryMessage || '').trim();
    if (eventMsg) {
      announcementText.textContent = eventMsg;
      announcementBanner.style.display = 'block';
    } else {
      announcementBanner.style.display = 'none';
    }
  }
}

function setupRightClickProtection() {
  document.addEventListener('contextmenu', (e) => {
    const activeEvt = (window.allEvents || []).find(e => e.id === window.selectedEventId);
    if (activeEvt && activeEvt.disableRightClick) {
      if (e.target.tagName === 'IMG' || e.target.closest('.photo-card') || e.target.closest('#lightbox-modal')) {
        e.preventDefault();
      }
    }
  });

  document.addEventListener('dragstart', (e) => {
    const activeEvt = (window.allEvents || []).find(e => e.id === window.selectedEventId);
    if (activeEvt && activeEvt.disableRightClick) {
      if (e.target.tagName === 'IMG') {
        e.preventDefault();
      }
    }
  });
}

function populatePublicEventDropdowns() {
  const globalPicker = document.getElementById('global-event-picker');

  const eventOptions = (window.allEvents || []).map(evt => `<option value="${evt.id}">🎉 ${evt.title || evt.name}${evt.hasPasscode || evt.passcode ? ' 🔒' : ''}</option>`).join('');

  if (globalPicker) {
    globalPicker.innerHTML = `<option value="all">🎉 All Events (Combined Catalog)</option>` + eventOptions;
    globalPicker.value = window.selectedEventId || 'all';

    if (!globalPicker.dataset.listenerAttached) {
      globalPicker.dataset.listenerAttached = 'true';
      globalPicker.addEventListener('change', (e) => {
        selectPublicEvent(e.target.value);
      });
    }
  }

  updateUploadEventIndicator();
}

// Update the upload event indicator to show which event photos will be uploaded to
function updateUploadEventIndicator() {
  const indicator = document.getElementById('upload-event-indicator');
  const nameEl = document.getElementById('upload-event-name');
  const lockIcon = document.getElementById('upload-event-lock-icon');

  if (!indicator || !nameEl) return;

  if (!window.selectedEventId || window.selectedEventId === 'all') {
    indicator.style.display = 'none';
    return;
  }

  const evt = (window.allEvents || []).find(e => e.id === window.selectedEventId);
  if (!evt) {
    indicator.style.display = 'none';
    return;
  }

  indicator.style.display = 'block';
  nameEl.textContent = evt.title || evt.name || 'Selected Event';

  const hasPasscode = evt.hasPasscode || evt.passcode;
  if (lockIcon) {
    lockIcon.style.display = hasPasscode ? 'inline-block' : 'none';
    lockIcon.title = hasPasscode ? 'This event is passcode-protected' : '';
  }
}

// --- Event Passcode Manager ---
let unlockedEvents = {};
try {
  unlockedEvents = JSON.parse(sessionStorage.getItem('unlocked_events') || '{}');
} catch (e) {
  unlockedEvents = {};
}

function getUnlockedEventPasscode(eventId) {
  return unlockedEvents[eventId] || '';
}

function saveUnlockedPasscode(eventId, passcode) {
  unlockedEvents[eventId] = passcode;
  try {
    sessionStorage.setItem('unlocked_events', JSON.stringify(unlockedEvents));
  } catch (e) {}
}

let pendingEventIdToUnlock = null;

function setupEventPasscodeModal() {
  const modal = document.getElementById('event-passcode-modal');
  const form = document.getElementById('event-passcode-form');
  const cancelBtn = document.getElementById('event-passcode-cancel-btn');
  const errorEl = document.getElementById('event-passcode-error');

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      closeEventPasscodeModal();
      window.selectedEventId = 'all';
      try { localStorage.setItem('public_active_event_id', 'all'); } catch (e) {}
      const globalPicker = document.getElementById('global-event-picker');
      if (globalPicker) globalPicker.value = 'all';
      fetchGallery();
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('public-event-passcode-input');
      const passcode = input ? input.value.trim() : '';

      if (!pendingEventIdToUnlock) return;
      if (errorEl) errorEl.style.display = 'none';

      try {
        const res = await fetch(`/api/events/${pendingEventIdToUnlock}/verify-passcode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passcode })
        });
        const result = await res.json();
        if (result.success && result.verified) {
          saveUnlockedPasscode(pendingEventIdToUnlock, passcode);
          const unlockedId = pendingEventIdToUnlock;
          closeEventPasscodeModal();
          window.selectedEventId = unlockedId;
          try { localStorage.setItem('public_active_event_id', unlockedId); } catch (e) {}
          await fetchGallery();
        } else {
          if (errorEl) {
            errorEl.innerText = result.error || 'Incorrect passcode. Please try again.';
            errorEl.style.display = 'block';
          }
        }
      } catch (err) {
        console.error("Passcode verification error:", err);
        if (errorEl) {
          errorEl.innerText = 'Network error verifying passcode. Please try again.';
          errorEl.style.display = 'block';
        }
      }
    });
  }
}

function promptEventPasscode(eventId) {
  const evt = (window.allEvents || []).find(e => e.id === eventId);
  const modal = document.getElementById('event-passcode-modal');
  const descEl = document.getElementById('event-passcode-modal-desc');
  const input = document.getElementById('public-event-passcode-input');
  const errorEl = document.getElementById('event-passcode-error');

  pendingEventIdToUnlock = eventId;
  if (input) input.value = '';
  if (errorEl) errorEl.style.display = 'none';

  if (descEl && evt) {
    descEl.innerHTML = `Event <strong>"${evt.title || evt.name}"</strong> is protected with a passcode. Please enter the passcode to access photos.`;
  }

  if (modal) modal.style.display = 'flex';
}

function closeEventPasscodeModal() {
  const modal = document.getElementById('event-passcode-modal');
  if (modal) modal.style.display = 'none';
  pendingEventIdToUnlock = null;
}

// --- Public Face Adjustment for Search Engine ---
let publicAdjustBox = { x: 0, y: 0, width: 100, height: 100 };
let publicAdjustIsDragging = false;
let publicAdjustDragMode = null;
let publicAdjustDragStart = { mx: 0, my: 0, nx: 0, ny: 0 };
let publicAdjustInitialBox = { x: 0, y: 0, width: 100, height: 100 };

function setupPublicFaceAdjustModal() {
  const modal = document.getElementById('public-face-adjust-modal');
  const closeBtn = document.getElementById('public-face-adjust-close-btn');
  const cancelBtn = document.getElementById('public-face-adjust-cancel-btn');
  const applyBtn = document.getElementById('public-face-adjust-apply-btn');
  const adjustTriggerBtn = document.getElementById('adjust-search-face-btn');

  if (closeBtn) closeBtn.addEventListener('click', closePublicFaceAdjustModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closePublicFaceAdjustModal);

  if (adjustTriggerBtn) {
    adjustTriggerBtn.addEventListener('click', openPublicFaceAdjustModal);
  }

  if (applyBtn) {
    applyBtn.addEventListener('click', handlePublicFaceAdjustApply);
  }

  const canvas = document.getElementById('public-face-adjust-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown', handlePublicAdjustMouseDown);
    canvas.addEventListener('mousemove', handlePublicAdjustMouseMove);
    canvas.addEventListener('mouseup', handlePublicAdjustMouseUp);
    canvas.addEventListener('mouseleave', handlePublicAdjustMouseUp);

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const touch = e.touches[0];
        canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: touch.clientX, clientY: touch.clientY }));
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const touch = e.touches[0];
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: touch.clientX, clientY: touch.clientY }));
      }
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
      canvas.dispatchEvent(new MouseEvent('mouseup', {}));
    });
  }
}

function openPublicFaceAdjustModal() {
  if (!window.searchQueryImage) {
    alert("Please select or capture a photo first.");
    return;
  }

  const modal = document.getElementById('public-face-adjust-modal');
  const img = document.getElementById('public-face-adjust-img');
  if (!modal || !img) return;

  const objectUrl = (typeof window.searchQueryImage === 'string') 
    ? window.searchQueryImage 
    : URL.createObjectURL(window.searchQueryImage);

  img.onload = () => {
    syncPublicCanvasDimensions();
    if (window.searchQueryDescriptors && window.searchQueryDescriptors.length > 0 && window.searchQueryDescriptors[0].box) {
      const b = window.searchQueryDescriptors[0].box;
      publicAdjustBox = { x: b.x || b.left || 0, y: b.y || b.top || 0, width: b.width || (b.right - b.left) || 100, height: b.height || (b.bottom - b.top) || 100 };
    } else {
      const nw = img.naturalWidth || 400;
      const nh = img.naturalHeight || 400;
      publicAdjustBox = { x: Math.round(nw * 0.2), y: Math.round(nh * 0.2), width: Math.round(nw * 0.6), height: Math.round(nh * 0.6) };
    }
    drawPublicAdjustCanvas();
  };

  img.src = objectUrl;
  modal.style.display = 'flex';
}

function closePublicFaceAdjustModal() {
  const modal = document.getElementById('public-face-adjust-modal');
  if (modal) modal.style.display = 'none';
}

function syncPublicCanvasDimensions() {
  const img = document.getElementById('public-face-adjust-img');
  const canvas = document.getElementById('public-face-adjust-canvas');
  if (!img || !canvas) return;
  canvas.width = img.clientWidth || img.width;
  canvas.height = img.clientHeight || img.height;
}

function getPublicCanvasScale() {
  const img = document.getElementById('public-face-adjust-img');
  const canvas = document.getElementById('public-face-adjust-canvas');
  if (!img || !canvas || !img.naturalWidth || !img.naturalHeight) {
    return { scaleX: 1, scaleY: 1 };
  }
  return { scaleX: canvas.width / img.naturalWidth, scaleY: canvas.height / img.naturalHeight };
}

function drawPublicAdjustCanvas() {
  const canvas = document.getElementById('public-face-adjust-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const { scaleX, scaleY } = getPublicCanvasScale();
  const bx = publicAdjustBox.x * scaleX;
  const by = publicAdjustBox.y * scaleY;
  const bw = publicAdjustBox.width * scaleX;
  const bh = publicAdjustBox.height * scaleY;
  const HANDLE_SIZE = 10;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, canvas.width, by);
  ctx.fillRect(0, by, bx, bh);
  ctx.fillRect(bx + bw, by, canvas.width - (bx + bw), bh);
  ctx.fillRect(0, by + bh, canvas.width, canvas.height - (by + bh));

  ctx.fillStyle = 'rgba(139, 92, 246, 0.2)';
  ctx.fillRect(bx, by, bw, bh);

  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([]);
  ctx.strokeRect(bx, by, bw, bh);

  const labelText = 'Your Face Area';
  ctx.font = '600 12px Inter, sans-serif';
  const textWidth = ctx.measureText(labelText).width;
  ctx.fillStyle = '#8b5cf6';
  ctx.fillRect(bx, Math.max(0, by - 22), textWidth + 12, 20);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(labelText, bx + 6, Math.max(14, by - 7));

  const handles = {
    nw: { x: bx, y: by },
    ne: { x: bx + bw, y: by },
    se: { x: bx + bw, y: by + bh },
    sw: { x: bx, y: by + bh }
  };
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 2;

  Object.values(handles).forEach(h => {
    ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  });
}

function handlePublicAdjustMouseDown(e) {
  const canvas = document.getElementById('public-face-adjust-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const { scaleX, scaleY } = getPublicCanvasScale();
  const nx = mx / scaleX;
  const ny = my / scaleY;

  const bx = publicAdjustBox.x * scaleX;
  const by = publicAdjustBox.y * scaleY;
  const bw = publicAdjustBox.width * scaleX;
  const bh = publicAdjustBox.height * scaleY;
  const HANDLE_SIZE = 14;

  const handles = {
    'resize-nw': { x: bx, y: by },
    'resize-ne': { x: bx + bw, y: by },
    'resize-se': { x: bx + bw, y: by + bh },
    'resize-sw': { x: bx, y: by + bh }
  };

  for (const [mode, h] of Object.entries(handles)) {
    if (Math.abs(mx - h.x) <= HANDLE_SIZE && Math.abs(my - h.y) <= HANDLE_SIZE) {
      publicAdjustIsDragging = true;
      publicAdjustDragMode = mode;
      publicAdjustDragStart = { mx, my, nx, ny };
      publicAdjustInitialBox = { ...publicAdjustBox };
      return;
    }
  }

  if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
    publicAdjustIsDragging = true;
    publicAdjustDragMode = 'move';
    publicAdjustDragStart = { mx, my, nx, ny };
    publicAdjustInitialBox = { ...publicAdjustBox };
    return;
  }

  publicAdjustIsDragging = true;
  publicAdjustDragMode = 'draw';
  publicAdjustDragStart = { mx, my, nx, ny };
  publicAdjustBox = { x: Math.round(nx), y: Math.round(ny), width: 10, height: 10 };
  publicAdjustInitialBox = { ...publicAdjustBox };
  drawPublicAdjustCanvas();
}

function handlePublicAdjustMouseMove(e) {
  if (!publicAdjustIsDragging) return;
  const canvas = document.getElementById('public-face-adjust-canvas');
  const img = document.getElementById('public-face-adjust-img');
  if (!canvas || !img) return;

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const { scaleX, scaleY } = getPublicCanvasScale();
  const nx = mx / scaleX;
  const ny = my / scaleY;

  const maxW = img.naturalWidth || 1000;
  const maxH = img.naturalHeight || 1000;
  const dNx = nx - publicAdjustDragStart.nx;
  const dNy = ny - publicAdjustDragStart.ny;

  if (publicAdjustDragMode === 'move') {
    let newX = Math.round(publicAdjustInitialBox.x + dNx);
    let newY = Math.round(publicAdjustInitialBox.y + dNy);
    newX = Math.max(0, Math.min(maxW - publicAdjustInitialBox.width, newX));
    newY = Math.max(0, Math.min(maxH - publicAdjustInitialBox.height, newY));
    publicAdjustBox.x = newX;
    publicAdjustBox.y = newY;
  } else if (publicAdjustDragMode === 'draw') {
    const currX = publicAdjustInitialBox.x;
    const currY = publicAdjustInitialBox.y;
    let currW = Math.round(nx - currX);
    let currH = Math.round(ny - currY);

    if (currW < 0) {
      publicAdjustBox.x = Math.max(0, currX + currW);
      publicAdjustBox.width = Math.abs(currW);
    } else {
      publicAdjustBox.x = currX;
      publicAdjustBox.width = Math.min(maxW - currX, currW);
    }
    if (currH < 0) {
      publicAdjustBox.y = Math.max(0, currY + currH);
      publicAdjustBox.height = Math.abs(currH);
    } else {
      publicAdjustBox.y = currY;
      publicAdjustBox.height = Math.min(maxH - currY, currH);
    }
  } else if (publicAdjustDragMode && publicAdjustDragMode.startsWith('resize-')) {
    const mode = publicAdjustDragMode.replace('resize-', '');
    let newX = publicAdjustInitialBox.x;
    let newY = publicAdjustInitialBox.y;
    let newW = publicAdjustInitialBox.width;
    let newH = publicAdjustInitialBox.height;

    if (mode.includes('w')) {
      const targetRight = publicAdjustInitialBox.x + publicAdjustInitialBox.width;
      newX = Math.max(0, Math.min(targetRight - 15, publicAdjustInitialBox.x + dNx));
      newW = targetRight - newX;
    } else if (mode.includes('e')) {
      newW = Math.max(15, Math.min(maxW - publicAdjustInitialBox.x, publicAdjustInitialBox.width + dNx));
    }
    if (mode.includes('n')) {
      const targetBottom = publicAdjustInitialBox.y + publicAdjustInitialBox.height;
      newY = Math.max(0, Math.min(targetBottom - 15, publicAdjustInitialBox.y + dNy));
      newH = targetBottom - newY;
    } else if (mode.includes('s')) {
      newH = Math.max(15, Math.min(maxH - publicAdjustInitialBox.y, publicAdjustInitialBox.height + dNy));
    }
    publicAdjustBox.x = newX;
    publicAdjustBox.y = newY;
    publicAdjustBox.width = newW;
    publicAdjustBox.height = newH;
  }
  drawPublicAdjustCanvas();
}

function handlePublicAdjustMouseUp() {
  if (!publicAdjustIsDragging) return;
  publicAdjustIsDragging = false;
  publicAdjustDragMode = null;
  if (publicAdjustBox.width < 15) publicAdjustBox.width = 15;
  if (publicAdjustBox.height < 15) publicAdjustBox.height = 15;
  drawPublicAdjustCanvas();
}

async function handlePublicFaceAdjustApply() {
  const img = document.getElementById('public-face-adjust-img');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackDesc = document.getElementById('feedback-desc');
  const searchBtn = document.getElementById('execute-search-btn');

  if (!img || !window.searchQueryImage) return;
  closePublicFaceAdjustModal();

  if (feedbackTitle) feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Processing Adjusted Face...`;
  if (feedbackDesc) feedbackDesc.innerText = 'Calculating face descriptor from your custom box...';

  try {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = publicAdjustBox.width;
    tempCanvas.height = publicAdjustBox.height;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(
      img,
      publicAdjustBox.x, publicAdjustBox.y, publicAdjustBox.width, publicAdjustBox.height,
      0, 0, publicAdjustBox.width, publicAdjustBox.height
    );

    const blob = await new Promise(resolve => tempCanvas.toBlob(resolve, 'image/jpeg', 0.95));
    const croppedFile = new File([blob], 'adjusted_face.jpg', { type: 'image/jpeg' });

    let descriptors = [];
    try {
      descriptors = await computeFaceDescriptorsWithTimeout(croppedFile, 15000);
    } catch (e) {
      console.warn("Client descriptor on cropped face failed, trying server...", e);
    }

    if (!descriptors || descriptors.length === 0) {
      descriptors = await detectFacesOnServer(croppedFile);
    }

    if (descriptors && descriptors.length > 0) {
      window.searchQueryDescriptors = descriptors;
      window.searchQueryDescriptor = descriptors[0].descriptor;
      if (feedbackTitle) feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981"></i> Custom Face Box Ready`;
      if (feedbackDesc) feedbackDesc.innerText = `Searching gallery with your custom adjusted face region...`;
      if (searchBtn) searchBtn.classList.remove('disabled');
      performSearch();
    } else {
      if (feedbackTitle) feedbackTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> Low Face Details`;
      if (feedbackDesc) feedbackDesc.innerText = 'Could not extract features from the selected region. Please try adjusting the box to include the full face.';
    }
  } catch (err) {
    console.error("Public face adjust apply error:", err);
    alert("Error processing adjusted face: " + err.message);
  }
}

