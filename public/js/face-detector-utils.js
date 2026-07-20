/**
 * FaceMatch AI - Unified Face Detection & Batch Upload Engine
 * 
 * Provides robust EXIF orientation correction, deterministic multi-scale face detection,
 * model pre-loading, and concurrency-controlled batch upload queue management.
 */

(function (window) {
  'use strict';

  const LOCAL_MODEL_PATH = '/models';
  const CDN_MODEL_PATH = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

  let activeModelPath = LOCAL_MODEL_PATH;
  let faceModelsPromise = null;

  /**
   * Parse EXIF Orientation from a JPEG ArrayBuffer
   * @param {ArrayBuffer} arrayBuffer 
   * @returns {number} Orientation value 1 to 8 (default 1)
   */
  function getExifOrientation(arrayBuffer) {
    try {
      const view = new DataView(arrayBuffer);
      if (view.getUint16(0, false) !== 0xFFD8) return 1; // Not JPEG
      const length = view.byteLength;
      let offset = 2;
      while (offset < length) {
        if (offset + 2 > length) break;
        const marker = view.getUint16(offset, false);
        offset += 2;
        if (marker === 0xFFE1) { // APP1 marker for EXIF
          if (offset + 6 > length) return 1;
          if (view.getUint32(offset + 2, false) !== 0x45786966) return 1; // "Exif"
          const little = view.getUint16(offset + 8, false) === 0x4949;
          const firstIFDOffset = view.getUint32(offset + 12, little);
          let tagsOffset = offset + 8 + firstIFDOffset;
          if (tagsOffset + 2 > length) return 1;
          const tags = view.getUint16(tagsOffset, little);
          tagsOffset += 2;
          for (let i = 0; i < tags; i++) {
            const tagEntry = tagsOffset + (i * 12);
            if (tagEntry + 12 > length) break;
            if (view.getUint16(tagEntry, little) === 0x0112) { // Orientation tag
              return view.getUint16(tagEntry + 8, little);
            }
          }
        } else if ((marker & 0xFF00) !== 0xFF00) {
          break;
        } else {
          if (offset + 2 > length) break;
          offset += view.getUint16(offset, false);
        }
      }
    } catch (err) {
      console.warn('[EXIF Parser] Failed to parse EXIF orientation:', err);
    }
    return 1;
  }

  /**
   * Read file as ArrayBuffer
   */
  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read file ArrayBuffer'));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Read file or blob as HTMLImageElement
   */
  function loadImageElement(source) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image element for face processing'));

      if (source instanceof File || source instanceof Blob) {
        const reader = new FileReader();
        reader.onload = (e) => {
          img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Failed to read image source'));
        reader.readAsDataURL(source);
      } else if (typeof source === 'string') {
        img.src = source;
      } else if (source instanceof HTMLImageElement) {
        resolve(source);
      } else {
        reject(new Error('Invalid image source type'));
      }
    });
  }

  /**
   * Create an HTMLCanvasElement with corrected EXIF orientation and downscaled dimensions (max 2048px).
   * @param {File|Blob|HTMLImageElement|string} source 
   * @param {number} maxDim Maximum width or height
   * @returns {Promise<{ canvas: HTMLCanvasElement, blob: Blob, file: File, originalWidth: number, originalHeight: number, orientation: number }>}
   */
  async function createOrientedCanvas(source, maxDim = 2048) {
    let orientation = 1;
    let fileName = 'photo.jpg';

    if (source instanceof Blob) {
      fileName = source.name || fileName;
      const isJpeg = !source.type || source.type === 'image/jpeg' || (source.name && source.name.match(/\.jpe?g$/i));
      if (isJpeg) {
        try {
          const buffer = await readFileAsArrayBuffer(source);
          orientation = getExifOrientation(buffer);
        } catch (e) {
          console.warn('[EXIF Engine] Orientation check skipped:', e.message);
        }
      }
    }

    const img = await loadImageElement(source);
    const origWidth = img.naturalWidth || img.width;
    const origHeight = img.naturalHeight || img.height;

    // Calculate aspect ratio scaling
    let targetWidth = origWidth;
    let targetHeight = origHeight;

    if (origWidth > maxDim || origHeight > maxDim) {
      if (origWidth > origHeight) {
        targetWidth = maxDim;
        targetHeight = Math.round((origHeight * maxDim) / origWidth);
      } else {
        targetHeight = maxDim;
        targetWidth = Math.round((origWidth * maxDim) / origHeight);
      }
    }

    const canvas = document.createElement('canvas');

    // Swap canvas dimensions for 90 or 270 degree rotations
    if ([5, 6, 7, 8].includes(orientation)) {
      canvas.width = targetHeight;
      canvas.height = targetWidth;
    } else {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();

    // Apply EXIF rotation transformations
    switch (orientation) {
      case 2: ctx.transform(-1, 0, 0, 1, canvas.width, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, canvas.width, canvas.height); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, canvas.height); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, canvas.width, 0); break; // 90 deg CW
      case 7: ctx.transform(0, -1, -1, 0, canvas.width, canvas.height); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, canvas.height); break; // 270 deg CW
      default: break;
    }

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    ctx.restore();

    // Export optimized Blob and File
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const resizedFile = new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now()
    });

    console.log(`[Image Processor] Processed ${fileName}: ${origWidth}x${origHeight} -> ${canvas.width}x${canvas.height} (EXIF Orientation: ${orientation}, Size: ${(blob.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      canvas,
      blob,
      file: resizedFile,
      originalWidth: origWidth,
      originalHeight: origHeight,
      orientation
    };
  }

  /**
   * Pre-load all face-api models (Singleton promise)
   */
  function loadFaceApiModels() {
    if (window.faceApiLoaded && faceModelsPromise) {
      return faceModelsPromise;
    }

    if (typeof faceapi === 'undefined') {
      return Promise.reject(new Error('face-api.js script is not loaded in window scope.'));
    }

    const loadFromPath = async (path) => {
      console.log(`[Face-API Engine] Loading neural network models from: ${path}`);
      if (typeof faceapi !== 'undefined' && faceapi.tf) {
        try {
          await faceapi.tf.ready();
        } catch (tfErr) {
          console.warn('[TF.js Init] tf.ready() warning:', tfErr.message);
        }
      }
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(path),
        faceapi.nets.ssdMobilenetv1.loadFromUri(path),
        faceapi.nets.faceLandmark68Net.loadFromUri(path),
        faceapi.nets.faceRecognitionNet.loadFromUri(path)
      ]);
      window.faceApiLoaded = true;
      console.log(`[Face-API Engine] Models loaded successfully from: ${path}`);
    };

    faceModelsPromise = (async () => {
      try {
        await loadFromPath(activeModelPath);
      } catch (err) {
        console.warn(`[Face-API Engine] Local models failed from ${activeModelPath}, trying CDN fallback:`, err.message);
        activeModelPath = CDN_MODEL_PATH;
        await loadFromPath(activeModelPath);
      }
    })();

    return faceModelsPromise;
  }

  /**
   * Intersection over Union (IoU) calculation for bounding box duplicate removal
   */
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

  /**
   * Merge secondary face detections into primary detections avoiding overlap duplicates
   */
  function mergeFaceDetections(primary, secondary) {
    const merged = [...primary];
    secondary.forEach(secDet => {
      const secBox = {
        left: secDet.detection.box.left,
        top: secDet.detection.box.top,
        right: secDet.detection.box.left + secDet.detection.box.width,
        bottom: secDet.detection.box.top + secDet.detection.box.height
      };
      const isDuplicate = merged.some(priDet => {
        const priBox = {
          left: priDet.detection.box.left,
          top: priDet.detection.box.top,
          right: priDet.detection.box.left + priDet.detection.box.width,
          bottom: priDet.detection.box.top + priDet.detection.box.height
        };
        return computeIoU(priBox, secBox) > 0.40;
      });
      if (!isDuplicate) {
        merged.push(secDet);
      }
    });
    return merged;
  }

  /**
   * Run multi-scale face detection pipeline on an upright canvas or image.
   * @param {HTMLCanvasElement|HTMLImageElement} inputElement 
   * @returns {Promise<Array<{ box: { x: number, y: number, width: number, height: number }, descriptor: Array<number> }>>}
   */
  /**
   * Global promise chain for single-threaded browser face detection (TFJS mutex lock)
   */
  let detectionQueueChain = Promise.resolve();

  const MAX_FACES_PER_PHOTO = 15;
  const MIN_BOX_DIM = 18;
  const MIN_BOX_AREA = 350;

  /**
   * Filter out tiny boxes, bad aspect ratios, and limit face count to max 50 per photo.
   */
  function filterAndSanitizeDetections(detections) {
    if (!Array.isArray(detections)) return [];

    const valid = detections.filter(det => {
      if (!det || !det.detection || !det.detection.box || !det.descriptor) return false;
      const { width, height } = det.detection.box;
      if (width < MIN_BOX_DIM || height < MIN_BOX_DIM) return false;
      if (width * height < MIN_BOX_AREA) return false;
      const aspectRatio = width / height;
      if (aspectRatio < 0.35 || aspectRatio > 2.5) return false;
      return true;
    });

    valid.sort((a, b) => {
      const areaA = a.detection.box.width * a.detection.box.height;
      const areaB = b.detection.box.width * b.detection.box.height;
      return areaB - areaA;
    });

    return valid.slice(0, MAX_FACES_PER_PHOTO);
  }

  /**
   * Internal implementation of multi-scale face detection pipeline
   */
  async function runDetectFacesMultiScaleInternal(inputElement) {
    try {
      await loadFaceApiModels();
      if (typeof faceapi !== 'undefined' && faceapi.tf) {
        await faceapi.tf.ready();
      }
    } catch (modelErr) {
      console.warn('[Face Detection Pipeline] Could not initialize browser face-api models:', modelErr.message);
      return [];
    }

    const formatResults = (detections) => detections.map(det => ({
      box: {
        x: Math.round(det.detection.box.left),
        y: Math.round(det.detection.box.top),
        width: Math.round(det.detection.box.width),
        height: Math.round(det.detection.box.height)
      },
      descriptor: Array.from(det.descriptor)
    }));

    // Pass 1: Primary Detection (SSD MobileNet 0.45 & TinyFace 512 0.45)
    console.log('[Face Detection Pipeline] Pass 1: Running primary SSD MobileNet (0.45) & TinyFace (512, 0.45)...');
    let primaryDetections = [];
    try {
      primaryDetections = await faceapi
        .detectAllFaces(inputElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (err) {
      console.warn('[Face Detection Pipeline] Primary SSD MobileNet pass error:', err.message);
    }

    let tinyDetections = [];
    try {
      tinyDetections = await faceapi
        .detectAllFaces(inputElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.45 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (err) {
      console.warn('[Face Detection Pipeline] TinyFaceDetector 512 pass error:', err.message);
    }

    let merged = mergeFaceDetections(primaryDetections, tinyDetections);
    let filtered = filterAndSanitizeDetections(merged);
    if (filtered.length > 0) {
      console.log(`[Face Detection Pipeline] Pass 1 succeeded. Identified ${filtered.length} face(s).`);
      return formatResults(filtered);
    }

    // Pass 2: Fallback Pass (SSD MobileNet 0.35 & TinyFace 640 0.35)
    console.log('[Face Detection Pipeline] Pass 2 (Fallback): Trying secondary SSD MobileNet (0.35) & TinyFace (640, 0.35)...');
    let fallbackPrimary = [];
    try {
      fallbackPrimary = await faceapi
        .detectAllFaces(inputElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (err) {
      console.warn('[Face Detection Pipeline] Pass 2 SSD MobileNet error:', err.message);
    }

    let fallbackTiny = [];
    try {
      fallbackTiny = await faceapi
        .detectAllFaces(inputElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 640, scoreThreshold: 0.35 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (err) {
      console.warn('[Face Detection Pipeline] Pass 2 TinyFaceDetector error:', err.message);
    }

    let fallbackMerged = mergeFaceDetections(fallbackPrimary, fallbackTiny);
    let fallbackFiltered = filterAndSanitizeDetections(fallbackMerged);
    if (fallbackFiltered.length > 0) {
      console.log(`[Face Detection Pipeline] Pass 2 succeeded. Identified ${fallbackFiltered.length} face(s).`);
      return formatResults(fallbackFiltered);
    }

    console.log('[Face Detection Pipeline] Detection completed. No faces found.');
    return [];
  }

  /**
   * Enqueued single-threaded multi-scale face detection pipeline on an upright canvas or image.
   * Ensures only ONE image is processed at a time in TensorFlow.js to prevent memory & WebGL crashes.
   * @param {HTMLCanvasElement|HTMLImageElement} inputElement 
   * @returns {Promise<Array<{ box: { x: number, y: number, width: number, height: number }, descriptor: Array<number> }>>}
   */
  function detectFacesMultiScale(inputElement) {
    return new Promise((resolve, reject) => {
      detectionQueueChain = detectionQueueChain.then(async () => {
        try {
          const res = await runDetectFacesMultiScaleInternal(inputElement);
          resolve(res);
        } catch (err) {
          reject(err);
        }
      }).catch((err) => {
        console.warn('[Face Detection Queue] Recovered from previous task failure:', err ? err.message : err);
        runDetectFacesMultiScaleInternal(inputElement).then(resolve).catch(reject);
      });
    });
  }

  /**
   * Process photo completely: Load image, fix EXIF orientation, resize, detect faces deterministically.
   * @param {File|Blob} file 
   * @returns {Promise<{ resizedFile: File, descriptors: Array, faceDetected: boolean, faceStatus: string }>}
   */
  async function processPhotoForUpload(file) {
    let canvas = null;
    let resizedFile = file;

    try {
      const oriented = await createOrientedCanvas(file, 2048);
      canvas = oriented.canvas;
      resizedFile = oriented.file;
    } catch (e) {
      console.warn('[Image Processor] createOrientedCanvas fallback to original file:', e.message);
      resizedFile = file;
    }

    let descriptors = [];
    if (canvas) {
      try {
        descriptors = await detectFacesMultiScale(canvas);
      } catch (err) {
        console.warn('[Face Detection Pipeline] Browser face detection exception, falling back to server-side detection:', err.message);
        descriptors = [];
      } finally {
        try {
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
          canvas.width = 0;
          canvas.height = 0;
        } catch (e) {}
      }
    }

    const faceDetected = descriptors.length > 0;
    const faceStatus = faceDetected
      ? `${descriptors.length} face(s) identified`
      : 'No Face Detected (Server fallback will scan on upload)';

    return {
      resizedFile,
      descriptors,
      faceDetected,
      faceStatus
    };
  }

  /**
   * Batch Upload Queue Controller with Concurrency Control and Retries
   */
  class BatchUploadQueue {
    constructor(options = {}) {
      this.concurrency = options.concurrency || 1;
      this.maxQueueSize = options.maxQueueSize || 15;
      this.maxRetries = options.maxRetries || 3;
      this.isPublic = options.isPublic !== undefined ? options.isPublic : true;
      this.onItemChange = options.onItemChange || (() => {});
      this.onProgress = options.onProgress || (() => {});
      this.onComplete = options.onComplete || (() => {});

      this.queue = [];
      this.activeCount = 0;
      this.isProcessing = false;
    }

    addFiles(fileList) {
      const addedItems = [];
      for (let i = 0; i < fileList.length; i++) {
        if (this.queue.length >= this.maxQueueSize) {
          break;
        }
        const file = fileList[i];
        if (this.queue.some(item => item.file.name === file.name && item.file.size === file.size)) {
          continue; // Skip duplicate
        }

        const id = 'uq_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const item = {
          id,
          file,
          status: 'queued', // queued, detecting, uploading, done, failed
          progress: 0,
          descriptors: [],
          resizedFile: file,
          faceCount: 0,
          faceStatus: 'Queued',
          error: null,
          retryCount: 0,
          objectUrl: null
        };

        try {
          item.objectUrl = URL.createObjectURL(file);
        } catch (e) {}

        this.queue.push(item);
        addedItems.push(item);
        this.onItemChange(item, 'added');
      }
      this.updateProgress();
      return addedItems;
    }

    removeItem(id) {
      const idx = this.queue.findIndex(item => item.id === id);
      if (idx > -1) {
        const item = this.queue[idx];
        if (item.objectUrl) {
          try { URL.revokeObjectURL(item.objectUrl); } catch (e) {}
        }
        this.queue.splice(idx, 1);
        this.onItemChange(item, 'removed');
        this.updateProgress();
      }
    }

    clear() {
      this.queue.forEach(item => {
        if (item.objectUrl) {
          try { URL.revokeObjectURL(item.objectUrl); } catch (e) {}
        }
      });
      this.queue = [];
      this.updateProgress();
    }

    async start() {
      if (this.isProcessing) return;
      this.isProcessing = true;
      this.processNext();
    }

    processNext() {
      const pendingItems = this.queue.filter(item => item.status === 'queued');

      if (pendingItems.length === 0 && this.activeCount === 0) {
        this.isProcessing = false;
        this.onComplete(this.queue);
        return;
      }

      while (this.activeCount < this.concurrency) {
        const nextItem = this.queue.find(item => item.status === 'queued');
        if (!nextItem) break;

        this.activeCount++;
        this.processItem(nextItem).finally(() => {
          this.activeCount--;
          this.processNext();
        });
      }
    }

    async processItem(item) {
      item.status = 'detecting';
      item.faceStatus = 'Detecting faces...';
      this.onItemChange(item, 'updated');

      try {
        // Step 1: Pre-process image & detect faces
        const processed = await processPhotoForUpload(item.file);
        item.resizedFile = processed.resizedFile;
        item.descriptors = processed.descriptors;
        item.faceCount = processed.descriptors.length;
        item.faceStatus = processed.faceStatus;

        // Step 2: Upload photo with retries
        item.status = 'uploading';
        this.onItemChange(item, 'updated');

        await this.uploadItemWithRetries(item);

        item.status = 'done';
        item.progress = 100;
        this.onItemChange(item, 'updated');
      } catch (err) {
        console.error(`[Upload Queue] Failed to process ${item.file.name}:`, err);
        item.status = 'failed';
        item.error = err.message || 'Upload failed';
        this.onItemChange(item, 'updated');
      } finally {
        this.updateProgress();
      }
    }

    async uploadItemWithRetries(item) {
      let lastError = null;

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for up to 30MB files

        try {
          const formData = new FormData();
          formData.append('photo', item.resizedFile);
          formData.append('descriptors', JSON.stringify(item.descriptors));
          formData.append('isPublic', String(this.isPublic));

          const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const errRes = await response.json().catch(() => ({}));
            throw new Error(errRes.error || `HTTP ${response.status} Server Error`);
          }

          const result = await response.json();
          if (!result.success) {
            throw new Error(result.error || 'Server rejected upload');
          }

          item.result = result.photo;
          return result;
        } catch (err) {
          clearTimeout(timeoutId);
          lastError = err;
          item.retryCount = attempt;

          const errMsg = err.name === 'AbortError'
            ? 'Request timed out (server busy)'
            : (err.message || 'Network fetch error');

          console.warn(`[Upload Queue] Attempt ${attempt}/${this.maxRetries} failed for ${item.file.name}:`, errMsg);

          if (attempt < this.maxRetries) {
            item.faceStatus = `Retrying upload (${attempt}/${this.maxRetries})...`;
            this.onItemChange(item, 'updated');
            // Exponential backoff wait
            await new Promise(res => setTimeout(res, attempt * 1000));
          }
        }
      }

      throw lastError || new Error(`Upload failed after ${this.maxRetries} attempts`);
    }

    updateProgress() {
      const total = this.queue.length;
      if (total === 0) {
        this.onProgress({ completed: 0, total: 0, percentage: 0 });
        return;
      }

      const completed = this.queue.filter(i => i.status === 'done' || i.status === 'failed').length;
      const percentage = Math.round((completed / total) * 100);
      this.onProgress({ completed, total, percentage });
    }
  }

  // Export to global scope
  window.FaceDetectorUtils = {
    getExifOrientation,
    createOrientedCanvas,
    loadFaceApiModels,
    detectFacesMultiScale,
    processPhotoForUpload,
    BatchUploadQueue
  };

})(window);
