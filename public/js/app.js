// ==========================================================================
// FaceMatch AI - Frontend Application Logic
// ==========================================================================

// Global state variables
window.galleryCatalog = [];
window.uploadQueue = [];
window.queryDescriptor = null;
window.searchQueryDescriptor = null;
window.searchQueryDescriptors = [];
window.webcamStream = null;
window.isWebcamActive = false;
window.faceApiLoaded = false;

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

async function computeFaceDescriptorsWithTimeout(source) {
  return computeFaceDescriptors(source);
}

// Limits to protect browser memory
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB per file
const MAX_UPLOAD_QUEUE = 50; // max files in client-side queue
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
    const response = await fetch('/api/gallery');
    const result = await response.json();
    if (result.success) {
      window.galleryCatalog = result.photos;
      window.publicGalleryEnabled = result.publicGalleryEnabled !== false;
      window.galleryHeading = result.galleryHeading || 'Gallery Catalog';
      // reset pagination when gallery refreshes
      currentGalleryPage = 0;
      
      const headingEl = document.getElementById('gallery-catalog-heading');
      if (headingEl) {
        headingEl.innerText = window.galleryHeading;
      }
      
      // Apply custom logo width if returned
      if (result.logoWidth) {
        const logoImg = document.querySelector('.logo-area img');
        if (logoImg) {
          logoImg.style.width = result.logoWidth + 'px';
        }
      }

      // Show/hide gallery announcement banner
      const banner = document.getElementById('gallery-announcement-banner');
      const bannerText = document.getElementById('gallery-announcement-text');
      if (banner && bannerText) {
        const msg = (result.galleryMessage || '').trim();
        if (msg) {
          bannerText.textContent = msg;
          banner.style.display = 'block';
        } else {
          banner.style.display = 'none';
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
  // Start automatic gallery refresh so the gallery catalog stays dynamic
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
}

// Batch Upload Queue Setup
window.publicBatchQueue = new FaceDetectorUtils.BatchUploadQueue({
  concurrency: 2,
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

  const validFiles = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (file.size > MAX_UPLOAD_SIZE) {
      alert(`${file.name} exceeds maximum allowed size of 50 MB.`);
      continue;
    }
    validFiles.push(file);
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

  if (startUploadBtn) startUploadBtn.classList.add('disabled');
  if (clearQueueBtn) clearQueueBtn.classList.add('disabled');

  window.publicBatchQueue.start();
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

  totalCountEl.innerText = window.galleryCatalog.length;
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

  if (window.galleryCatalog.length === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    emptyState.innerHTML = `
      <i class="fa-regular fa-image empty-icon"></i>
      <h3>No Photos in Gallery</h3>
      <p>Upload photos using the panel on the left to start building your gallery catalog.</p>
    `;
    return;
  }

  emptyState.classList.add('hidden');
  grid.classList.remove('hidden');
  // Render only a page of gallery items to limit memory usage
  renderGalleryPage();
}

// Render a page of gallery items and optionally append a Load More button
function renderGalleryPage() {
  const grid = document.getElementById('gallery-grid');
  const emptyState = document.getElementById('empty-gallery-state');

  const start = 0;
  const end = Math.min(window.galleryCatalog.length, GALLERY_PAGE_SIZE * (currentGalleryPage + 1));

  grid.innerHTML = '';

  if (end === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  grid.classList.remove('hidden');

  for (let i = start; i < end; i++) {
    const photo = window.galleryCatalog[i];
    const itemEl = document.createElement('div');
    itemEl.className = 'gallery-item';
    itemEl.addEventListener('click', () => openLightbox(photo));

    const dateStr = new Date(photo.timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });

    const facesCount = photo.descriptors ? photo.descriptors.length : 0;
    const badgeHtml = facesCount > 0 
      ? `<span class="faces-count-badge faces-count-badge-corner"><i class="fa-solid fa-user-tag"></i> ${facesCount}</span>`
      : '';

    itemEl.innerHTML = `
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

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        descriptors: window.searchQueryDescriptors,
        threshold: threshold
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

// --- Lightbox Modal Logic ---
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
}

function openLightbox(photo) {
  const modal = document.getElementById('lightbox-modal');
  const img = document.getElementById('lightbox-img');
  const canvas = document.getElementById('lightbox-canvas');
  const filename = document.getElementById('detail-filename');
  const date = document.getElementById('detail-date');
  const faces = document.getElementById('detail-faces');
  const downloadLink = document.getElementById('lightbox-download-link');
  const deleteBtn = document.getElementById('lightbox-delete-btn');

  img.src = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
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

  downloadLink.href = getPhotoUrl(photo.filename, photo.storageUrl, photo.imageUrl);
  downloadLink.setAttribute('download', photo.originalName);

  // Hide delete button for normal public users
  deleteBtn.style.display = 'none';

  // Set up delete trigger (kept just in case)
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
      // Calculate scales based on client dimension vs natural dimension of image
      const scaleX = img.clientWidth / img.naturalWidth;
      const scaleY = img.clientHeight / img.naturalHeight;

      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#8b5cf6';

      photo.descriptors.forEach(faceData => {
        // Handle both older flat array descriptors or new structure containing {box, descriptor}
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
      ctx.shadowBlur = 0; // reset
    }
  };
}

function closeLightbox() {
  const modal = document.getElementById('lightbox-modal');
  modal.style.display = 'none';
  // Clear image source to free resources
  document.getElementById('lightbox-img').src = '';
  const canvas = document.getElementById('lightbox-canvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}
