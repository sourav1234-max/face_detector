// ==========================================================================
// FaceMatch AI - Frontend Application Logic
// ==========================================================================

// Global state variables
window.galleryCatalog = [];
window.uploadQueue = [];
window.queryDescriptor = null;
window.webcamStream = null;
window.isWebcamActive = false;
window.faceApiLoaded = false;

// Configuration
const LOCAL_MODEL_PATH = '/models';
const CDN_MODEL_PATH = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
let modelPath = LOCAL_MODEL_PATH;

// --- Initialize and Load Models ---
async function initFaceApi() {
  const progressFill = document.getElementById('loader-progress');
  const statusText = document.getElementById('loader-status');

  try {
    // 1. Loading Face Detection Model
    statusText.innerText = "Loading Face Detection Model (SSD MobileNet)...";
    progressFill.style.width = "20%";
    try {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath);
    } catch (e) {
      console.warn("Failed to load models locally, trying CDN...", e);
      modelPath = CDN_MODEL_PATH;
      await faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath);
    }

    // 2. Loading Face Landmarks Model
    statusText.innerText = "Loading Face Landmark Model (68 Points)...";
    progressFill.style.width = "50%";
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelPath);

    // 3. Loading Face Recognition Model
    statusText.innerText = "Loading Face Recognition Model (Descriptors)...";
    progressFill.style.width = "80%";
    await faceapi.nets.faceRecognitionNet.loadFromUri(modelPath);

    // Done
    statusText.innerText = "Engine Ready!";
    progressFill.style.width = "100%";
    window.faceApiLoaded = true;

    // Fade out loader overlay
    setTimeout(() => {
      const loader = document.getElementById('models-loader');
      loader.style.opacity = '0';
      setTimeout(() => loader.classList.add('hidden'), 500);
    }, 400);

    // Fetch initial gallery files
    await fetchGallery();

  } catch (err) {
    console.error("AI Model Initialization failed:", err);
    statusText.innerHTML = `<span style="color: #ef4444">Failed to load models. Make sure Node server is running and models are installed.</span>`;
  }
}

// --- API Interactions ---

// Fetch gallery catalog
async function fetchGallery() {
  try {
    const response = await fetch('/api/gallery');
    const result = await response.json();
    if (result.success) {
      window.galleryCatalog = result.photos;
      updateGalleryUI();
    }
  } catch (err) {
    console.error("Error fetching gallery:", err);
  }
}

// Upload photo with metadata
async function uploadPhoto(file, faceData) {
  const formData = new FormData();
  formData.append('photo', file);
  // Send face bounding boxes and descriptors
  formData.append('descriptors', JSON.stringify(faceData));

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

// Queue items structure
async function handleFilesAdded(fileList) {
  const queueContainer = document.getElementById('upload-queue-container');
  queueContainer.classList.remove('hidden');

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    // Avoid duplicates by name
    if (window.uploadQueue.some(item => item.file.name === file.name)) continue;

    const queueId = 'qi_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const queueItem = {
      id: queueId,
      file: file,
      status: 'pending', // pending, analyzing, ready, uploading, done, failed
      faces: [],
      error: null
    };

    window.uploadQueue.push(queueItem);
    renderQueueItem(queueItem);

    // Asynchronously trigger face analysis
    analyzeQueueFile(queueItem);
  }

  updateQueueCount();
}

function renderQueueItem(item) {
  const carousel = document.getElementById('preview-carousel');
  const itemEl = document.createElement('div');
  itemEl.className = 'preview-item';
  itemEl.id = item.id;

  // Create Object URL for thumbnail preview
  const url = URL.createObjectURL(item.file);

  itemEl.innerHTML = `
    <div class="preview-thumbnail-wrapper">
      <img src="${url}" class="preview-thumbnail" alt="preview">
    </div>
    <div class="preview-info">
      <div class="preview-name">${item.file.name}</div>
      <div class="preview-status" id="${item.id}-status">
        <i class="fa-solid fa-spinner fa-spin"></i> Initializing...
      </div>
    </div>
    <button class="preview-remove-btn" onclick="removeQueueItem('${item.id}')">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  carousel.appendChild(itemEl);
  // Auto scroll down
  carousel.scrollTop = carousel.scrollHeight;
}

// Analyze face descriptors on client side
async function analyzeQueueFile(item) {
  const statusEl = document.getElementById(`${item.id}-status`);
  statusEl.className = 'preview-status processing';
  statusEl.innerHTML = `<i class="fa-solid fa-brain fa-pulse"></i> Running AI Detection...`;

  try {
    const img = await faceapi.bufferToImage(item.file);
    const detections = await faceapi.detectAllFaces(img)
      .withFaceLandmarks()
      .withFaceDescriptors();

    item.status = 'ready';
    item.faces = detections.map(det => ({
      box: {
        x: Math.round(det.detection.box.x),
        y: Math.round(det.detection.box.y),
        width: Math.round(det.detection.box.width),
        height: Math.round(det.detection.box.height)
      },
      descriptor: Array.from(det.descriptor) // convert Float32Array to standard array for JSON
    }));

    statusEl.className = 'preview-status ready';
    statusEl.innerHTML = `<i class="fa-solid fa-face-smile"></i> Detected ${item.faces.length} face(s)`;

  } catch (err) {
    console.error("Error analyzing image:", err);
    item.status = 'failed';
    item.error = err.message;
    statusEl.className = 'preview-status failed';
    statusEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Analysis failed`;
  }
}

// Remove single queue item
window.removeQueueItem = function(id) {
  const idx = window.uploadQueue.findIndex(item => item.id === id);
  if (idx > -1) {
    window.uploadQueue.splice(idx, 1);
    const el = document.getElementById(id);
    if (el) el.remove();
    updateQueueCount();
  }
};

function updateQueueCount() {
  const countSpan = document.getElementById('queue-count');
  countSpan.innerText = window.uploadQueue.length;

  const container = document.getElementById('upload-queue-container');
  if (window.uploadQueue.length === 0) {
    container.classList.add('hidden');
  }
}

function clearQueue() {
  window.uploadQueue = [];
  document.getElementById('preview-carousel').innerHTML = '';
  updateQueueCount();
}

// Run batch upload
async function startBatchUpload() {
  const startUploadBtn = document.getElementById('start-upload-btn');
  const clearQueueBtn = document.getElementById('clear-queue-btn');
  const progressBar = document.getElementById('upload-progress-fill');
  const statusText = document.getElementById('queue-status-text');

  // Filter items that are ready
  const uploadable = window.uploadQueue.filter(item => item.status === 'ready');
  if (uploadable.length === 0) {
    alert("No analyzed photos are ready for upload yet. Please wait for face detection to finish.");
    return;
  }

  // Lock buttons
  startUploadBtn.classList.add('disabled');
  clearQueueBtn.classList.add('disabled');

  let successCount = 0;
  progressBar.style.width = '0%';

  for (let i = 0; i < uploadable.length; i++) {
    const item = uploadable[i];
    item.status = 'uploading';
    const statusEl = document.getElementById(`${item.id}-status`);
    statusEl.innerHTML = `<i class="fa-solid fa-arrow-up-from-bracket fa-bounce"></i> Uploading...`;

    statusText.innerText = `Uploading image ${i + 1}/${uploadable.length}...`;

    const res = await uploadPhoto(item.file, item.faces);
    
    if (res.success) {
      successCount++;
      item.status = 'done';
      statusEl.className = 'preview-status ready';
      statusEl.innerHTML = `<i class="fa-solid fa-check"></i> Uploaded`;
      
      // Animate single removal from list
      setTimeout(() => {
        const el = document.getElementById(item.id);
        if (el) el.remove();
        // Remove from memory queue
        window.uploadQueue = window.uploadQueue.filter(q => q.id !== item.id);
        updateQueueCount();
      }, 1000);
    } else {
      item.status = 'failed';
      statusEl.className = 'preview-status failed';
      statusEl.innerHTML = `<i class="fa-solid fa-xmark"></i> Server error`;
    }

    // Update progress bar
    const pct = Math.round(((i + 1) / uploadable.length) * 100);
    progressBar.style.width = `${pct}%`;
  }

  statusText.innerText = `Finished! Successfully uploaded ${successCount} photos.`;
  progressBar.style.width = '100%';

  // Reset progress and unlock UI
  setTimeout(() => {
    progressBar.style.width = '0%';
    startUploadBtn.classList.remove('disabled');
    clearQueueBtn.classList.remove('disabled');
  }, 2000);

  // Reload gallery
  await fetchGallery();
}

// Update the gallery catalog grid in UI
function updateGalleryUI() {
  const totalCountEl = document.getElementById('gallery-total-count');
  const emptyState = document.getElementById('empty-gallery-state');
  const grid = document.getElementById('gallery-grid');

  totalCountEl.innerText = window.galleryCatalog.length;
  grid.innerHTML = '';

  if (window.galleryCatalog.length === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  grid.classList.remove('hidden');

  window.galleryCatalog.forEach(photo => {
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
        <img src="/uploads/${photo.filename}" class="gallery-image" alt="Gallery photo" loading="lazy">
        <div class="gallery-item-overlay">
          <div class="gallery-item-info">
            <p class="gallery-item-name">${photo.originalName}</p>
            <p class="gallery-item-date">${dateStr}</p>
          </div>
        </div>
      </div>
    `;

    grid.appendChild(itemEl);
  });
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
    
    // Automatically re-run search if a query descriptor is loaded
    if (window.queryDescriptor) {
      performSearch();
    }
  });

  // Run Search
  searchBtn.addEventListener('click', () => {
    if (window.queryDescriptor) {
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
async function handleSearchFileSelected(file) {
  const prompt = document.getElementById('search-upload-prompt');
  const previewContainer = document.getElementById('search-preview-container');
  const canvas = document.getElementById('search-preview-canvas');
  const feedbackCard = document.getElementById('search-feedback-card');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackDesc = document.getElementById('feedback-desc');
  const searchBtn = document.getElementById('execute-search-btn');

  // Reset
  window.queryDescriptor = null;
  searchBtn.classList.add('disabled');

  prompt.classList.add('hidden');
  previewContainer.classList.remove('hidden');
  feedbackCard.classList.remove('hidden');

  feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Processing Face...`;
  feedbackDesc.innerText = "Analyzing portrait, extracting features...";

  try {
    const img = await faceapi.bufferToImage(file);
    
    // Render on canvas
    const ctx = canvas.getContext('2d');
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    // Detect face
    const detection = await faceapi.detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:#ef4444"></i> No Face Detected`;
      feedbackDesc.innerText = "We couldn't identify a clear face in this photo. Please upload a clear, front-facing portrait.";
      return;
    }

    // Highlight face box on preview canvas
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = Math.max(4, Math.round(img.width / 150));
    const box = detection.detection.box;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    window.queryDescriptor = Array.from(detection.descriptor);
    searchBtn.classList.remove('disabled');

    feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981"></i> Face Extracted Successfully`;
    feedbackDesc.innerText = "1 face analyzed and loaded. Click 'Search Gallery' to find matches.";

  } catch (err) {
    console.error("Error analyzing search image:", err);
    feedbackTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> Error`;
    feedbackDesc.innerText = err.message;
  }
}

function clearSearchFile() {
  document.getElementById('search-file-input').value = '';
  document.getElementById('search-upload-prompt').classList.remove('hidden');
  document.getElementById('search-preview-container').classList.add('hidden');
  document.getElementById('search-feedback-card').classList.add('hidden');
  document.getElementById('execute-search-btn').classList.add('disabled');
  window.queryDescriptor = null;
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
      // Start real-time face detection loop
      drawWebcamDetectionsLoop();
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

// Draw webcam face rectangles in real time
async function drawWebcamDetectionsLoop() {
  const video = document.getElementById('webcam-video');
  const overlay = document.getElementById('webcam-overlay');
  const ctx = overlay.getContext('2d');

  if (!window.isWebcamActive) return;

  try {
    const detection = await faceapi.detectSingleFace(video);
    
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (detection && window.isWebcamActive) {
      const box = detection.box;
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#8b5cf6';
      // Draw neon rounded box
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, 10);
      ctx.stroke();
      ctx.shadowBlur = 0; // reset
    }
  } catch (err) {
    // Suppress console spam during shut down
  }

  // Next frame
  if (window.isWebcamActive) {
    requestAnimationFrame(drawWebcamDetectionsLoop);
  }
}

// Capture photo and match
async function captureCameraSearch() {
  const video = document.getElementById('webcam-video');
  const feedbackCard = document.getElementById('search-feedback-card');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackDesc = document.getElementById('feedback-desc');

  feedbackCard.classList.remove('hidden');
  feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Freezing Frame...`;
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

    // Analyze face
    const detection = await faceapi.detectSingleFace(tempCanvas)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:#ef4444"></i> Face Detection Failed`;
      feedbackDesc.innerText = "No face was recognized in the captured frame. Please try again with better lighting.";
      window.queryDescriptor = null;
      return;
    }

    // Highlight on preview canvas
    const previewCtx = canvas.getContext('2d');
    previewCtx.strokeStyle = '#3b82f6';
    previewCtx.lineWidth = 4;
    const box = detection.detection.box;
    previewCtx.strokeRect(box.x, box.y, box.width, box.height);

    window.queryDescriptor = Array.from(detection.descriptor);
    
    feedbackTitle.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981"></i> Captured!`;
    feedbackDesc.innerText = "Portrait successfully analyzed. Performing search...";

    // Instantly perform search!
    performSearch();

  } catch (err) {
    console.error("Camera capture search error:", err);
    feedbackTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> Error`;
    feedbackDesc.innerText = err.message;
  }
}

// --- Face Matching Algorithm ---
function getEuclideanDistance(a, b) {
  let sum = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function performSearch() {
  if (!window.queryDescriptor) return;

  const threshold = parseFloat(document.getElementById('threshold-slider').value);
  const resultsGrid = document.getElementById('search-grid');
  const emptyState = document.getElementById('empty-search-state');
  const summaryText = document.getElementById('search-results-summary');
  const downloadAllBtn = document.getElementById('download-all-matches-btn');

  // Array to hold matched photos
  const matches = [];

  // Iterate all photos in gallery catalog
  window.galleryCatalog.forEach(photo => {
    if (!photo.descriptors || photo.descriptors.length === 0) return;

    let minDistance = 999;
    
    // Check match against every face in the gallery photo
    photo.descriptors.forEach(faceData => {
      // Check if descriptors is format {box, descriptor} or raw descriptor array
      const descriptor = Array.isArray(faceData) ? faceData : faceData.descriptor;
      
      if (!descriptor) return;

      const dist = getEuclideanDistance(window.queryDescriptor, descriptor);
      if (dist < minDistance) {
        minDistance = dist;
      }
    });

    // If minDistance is within threshold, it's a match!
    if (minDistance <= threshold) {
      // Calculate a match confidence score
      // A distance of 0 means 100% match. A distance equal to threshold is 0% relative matching, 
      // or we can use a direct standard formula: Math.round((1 - minDistance) * 100)
      const confidence = Math.max(0, Math.round((1 - minDistance) * 100));
      matches.push({
        photo: photo,
        distance: minDistance,
        confidence: confidence
      });
    }
  });

  // Sort matches by confidence descending (distance ascending)
  matches.sort((a, b) => a.distance - b.distance);

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

  summaryText.innerText = `Found ${matches.length} matching photo(s) in catalog`;

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
        <img src="/uploads/${photo.filename}" class="gallery-image" alt="Match">
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
}

// Download matches bundle as ZIP
async function downloadAllMatchesZip() {
  if (!window.activeSearchMatches || window.activeSearchMatches.length === 0) return;

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
      const imageUrl = `/uploads/${photo.filename}`;
      
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

  img.src = `/uploads/${photo.filename}`;
  filename.innerText = photo.originalName;
  
  date.innerText = new Date(photo.timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const facesCount = photo.descriptors ? photo.descriptors.length : 0;
  faces.innerText = `${facesCount} face(s) identified`;

  downloadLink.href = `/uploads/${photo.filename}`;
  downloadLink.setAttribute('download', photo.originalName);

  // Set up delete trigger
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
