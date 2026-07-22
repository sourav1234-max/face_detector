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

      if (source instanceof File || source instanceof Blob) {
        const objectUrl = URL.createObjectURL(source);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Could not load image element for face processing'));
        };
        img.src = objectUrl;
      } else if (typeof source === 'string') {
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not load image element from URL'));
        img.src = source;
      } else if (source instanceof HTMLImageElement) {
        if (source.complete && source.naturalWidth !== 0) {
          resolve(source);
        } else {
          source.onload = () => resolve(source);
          source.onerror = () => reject(new Error('HTMLImageElement failed to load'));
        }
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

    // =========================================================================
    // FEATURE: Vertical (Portrait) Orientation Standardization
    // -------------------------------------------------------------------------
    // 1. Correct EXIF orientation metadata first (handled above).
    // 2. Check if the EXIF-corrected image is horizontal (landscape: width > height).
    // 3. If landscape, rotate 90° clockwise to make it vertical (portrait) before face detection and upload.
    // 4. If already vertical (height >= width), leave unchanged.
    // =========================================================================
    if (canvas.width > canvas.height) {
      const verticalCanvas = document.createElement('canvas');
      verticalCanvas.width = canvas.height;
      verticalCanvas.height = canvas.width;
      const vertCtx = verticalCanvas.getContext('2d');
      vertCtx.save();
      vertCtx.translate(verticalCanvas.width / 2, verticalCanvas.height / 2);
      vertCtx.rotate((90 * Math.PI) / 180);
      vertCtx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      vertCtx.restore();

      canvas = verticalCanvas;
    }

    // Export optimized Blob and File
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const resizedFile = new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now()
    });

    console.log(`[Image Processor] Processed ${fileName}: ${canvas.width}x${canvas.height} (Vertical portrait, EXIF Orientation: ${orientation}, Size: ${(blob.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      canvas,
      blob,
      file: resizedFile,
      originalWidth: canvas.width,
      originalHeight: canvas.height,
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
   * Map face bounding box (x, y, width, height) from rotated space back to unrotated space.
   */
  function mapBoxToOriginal(box, angle, currW, currH) {
    const { x, y, width, height } = box;
    const top = y;
    const left = x;
    const bottom = y + height;
    const right = x + width;

    let origLeft, origRight, origTop, origBottom;

    if (angle === 90) {
      origLeft = top;
      origRight = bottom;
      origTop = currH - right;
      origBottom = currH - left;
    } else if (angle === 180) {
      origLeft = currW - right;
      origRight = currW - left;
      origTop = currH - bottom;
      origBottom = currH - top;
    } else if (angle === 270) {
      origLeft = currW - bottom;
      origRight = currW - top;
      origTop = left;
      origBottom = right;
    } else {
      origLeft = left;
      origRight = right;
      origTop = top;
      origBottom = bottom;
    }

    origLeft = Math.max(0, Math.min(currW, origLeft));
    origRight = Math.max(0, Math.min(currW, origRight));
    origTop = Math.max(0, Math.min(currH, origTop));
    origBottom = Math.max(0, Math.min(currH, origBottom));

    return {
      x: Math.round(origLeft),
      y: Math.round(origTop),
      width: Math.round(origRight - origLeft),
      height: Math.round(origBottom - origTop)
    };
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

    const scanSingleOrientation = async (targetElement) => {
      // Pass 1: Primary Detection (SSD MobileNet 0.45 & TinyFace 512 0.45)
      let primaryDetections = [];
      try {
        primaryDetections = await faceapi
          .detectAllFaces(targetElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (err) { }

      let tinyDetections = [];
      try {
        tinyDetections = await faceapi
          .detectAllFaces(targetElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.45 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (err) { }

      let merged = mergeFaceDetections(primaryDetections, tinyDetections);
      let filtered = filterAndSanitizeDetections(merged);
      if (filtered.length > 0) {
        return formatResults(filtered);
      }

      // Pass 2: Fallback Pass (SSD MobileNet 0.35 & TinyFace 640 0.35)
      let fallbackPrimary = [];
      try {
        fallbackPrimary = await faceapi
          .detectAllFaces(targetElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (err) { }

      let fallbackTiny = [];
      try {
        fallbackTiny = await faceapi
          .detectAllFaces(targetElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 640, scoreThreshold: 0.35 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (err) { }

      let fallbackMerged = mergeFaceDetections(fallbackPrimary, fallbackTiny);
      let fallbackFiltered = filterAndSanitizeDetections(fallbackMerged);
      if (fallbackFiltered.length > 0) {
        return formatResults(fallbackFiltered);
      }

      // Pass 3: Sensitive Pass (SSD MobileNet 0.15 & TinyFace 0.15)
      let pass3Primary = [];
      try {
        pass3Primary = await faceapi
          .detectAllFaces(targetElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (err) { }

      let pass3Tiny = [];
      try {
        pass3Tiny = await faceapi
          .detectAllFaces(targetElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.15 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (err) { }

      let pass3Merged = mergeFaceDetections(pass3Primary, pass3Tiny);
      let pass3Filtered = filterAndSanitizeDetections(pass3Merged);
      if (pass3Filtered.length > 0) {
        return formatResults(pass3Filtered);
      }

      return [];
    };

    // Rotation angles to evaluate if 0 deg pass yields no faces: 0, 90, 270, 180
    const anglesToTry = [0, 90, 270, 180];
    const currW = inputElement.width || inputElement.naturalWidth || 0;
    const currH = inputElement.height || inputElement.naturalHeight || 0;

    for (const angle of anglesToTry) {
      let targetElement = inputElement;
      let rotCanvas = null;

      if (angle !== 0 && currW > 0 && currH > 0) {
        rotCanvas = document.createElement('canvas');
        if (angle === 90 || angle === 270) {
          rotCanvas.width = currH;
          rotCanvas.height = currW;
        } else {
          rotCanvas.width = currW;
          rotCanvas.height = currH;
        }
        const ctx = rotCanvas.getContext('2d');
        ctx.save();
        ctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
        ctx.rotate((angle * Math.PI) / 180);
        ctx.drawImage(inputElement, -currW / 2, -currH / 2);
        ctx.restore();
        targetElement = rotCanvas;
      }

      let results = await scanSingleOrientation(targetElement);

      if (rotCanvas) {
        try {
          const ctx = rotCanvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, rotCanvas.width, rotCanvas.height);
          rotCanvas.width = 0;
          rotCanvas.height = 0;
        } catch (e) { }
      }

      if (results && results.length > 0) {
        if (angle !== 0) {
          console.log(`[Face Detection Pipeline] Face identified at rotation angle ${angle}°. Mapping bounding boxes to canvas space...`);
          results = results.map(item => ({
            box: mapBoxToOriginal(item.box, angle, currW, currH),
            descriptor: item.descriptor
          }));
        }
        return results;
      }
    }

    console.log('[Face Detection Pipeline] Detection completed. No faces found across all orientation passes.');
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
   * Safe lightweight fallback resizer using ObjectURL and Canvas
   */
  async function resizeImageFallback(file, maxDim = 2048) {
    if (!file || !(file instanceof File || file instanceof Blob) || (file.type && !file.type.startsWith('image/'))) {
      return file;
    }
    return new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        
        let nw = w;
        let nh = h;
        if (w > h) {
          if (w > maxDim) { nh = Math.round((h * maxDim) / w); nw = maxDim; }
        } else {
          if (h > maxDim) { nw = Math.round((w * maxDim) / h); nh = maxDim; }
        }

        const canvas = document.createElement('canvas');
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, nw, nh);
        canvas.toBlob((blob) => {
          if (!blob) return resolve(file);
          const baseName = (file.name || 'photo.jpg').replace(/\.[^/.]+$/, '');
          const resized = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
          console.log(`[Image Resizer Fallback] Reduced size from ${(file.size / 1024 / 1024).toFixed(2)} MB to ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
          resolve(resized);
        }, 'image/jpeg', 0.85);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(file);
      };
      img.src = objectUrl;
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
      console.warn('[Image Processor] createOrientedCanvas failed, using fallback resizer:', e.message);
      resizedFile = await resizeImageFallback(file, 2048);
    }

    // Safety check: if file is still over 4 MB (e.g. uncompressed raw file fallback), compress it again
    if (resizedFile && resizedFile.size > 4 * 1024 * 1024) {
      console.log(`[Image Processor] Resized file is still ${ (resizedFile.size / 1024 / 1024).toFixed(2) } MB, applying aggressive compression...`);
      resizedFile = await resizeImageFallback(resizedFile, 1600);
    }

    let descriptors = [];
    try {
      // Ensure all asynchronous image loading and decoding completes before face detection starts
      const inputTarget = canvas || (await loadImageElement(resizedFile));
      descriptors = await detectFacesMultiScale(inputTarget);
    } catch (err) {
      console.warn('[Face Detection Pipeline] Browser face detection exception, falling back to server-side detection:', err.message);
      descriptors = [];
    } finally {
      if (canvas) {
        try {
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
          canvas.width = 0;
          canvas.height = 0;
        } catch (e) { }
      }
    }

    const faceDetected = Array.isArray(descriptors) && descriptors.length > 0;
    const faceStatus = faceDetected
      ? `${descriptors.length} face(s) identified`
      : 'No Face Detected (Server fallback will scan on upload)';

    return {
      resizedFile,
      descriptors: Array.isArray(descriptors) ? descriptors : [],
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
      this.onItemChange = options.onItemChange || (() => { });
      this.onProgress = options.onProgress || (() => { });
      this.onComplete = options.onComplete || (() => { });

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
        } catch (e) { }

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
          try { URL.revokeObjectURL(item.objectUrl); } catch (e) { }
        }
        this.queue.splice(idx, 1);
        this.onItemChange(item, 'removed');
        this.updateProgress();
      }
    }

    clear() {
      this.queue.forEach(item => {
        if (item.objectUrl) {
          try { URL.revokeObjectURL(item.objectUrl); } catch (e) { }
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
          if (this.eventId) {
            formData.append('eventId', String(this.eventId));
          }

          const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const errRes = await response.json().catch(() => ({}));
            if (response.status === 413) {
              throw new Error(errRes.error || 'HTTP 413: Image payload is too large for server limits.');
            }
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

  /**
   * Extract a 128-dimensional face descriptor for a specific bounding box on an image using face-api.js.
   * @param {HTMLImageElement|HTMLCanvasElement} inputElement 
   * @param {{ x: number, y: number, width: number, height: number }} box 
   * @returns {Promise<Array<number>|null>} Array of 128 numbers or null
   */
  async function extractDescriptorForBox(inputElement, box, fileOrBlob = null) {
    if (!inputElement || !box || box.width < 10 || box.height < 10) return null;

    try {
      await loadFaceApiModels();
      if (typeof faceapi !== 'undefined' && faceapi.tf) {
        await faceapi.tf.ready();
      }
    } catch (modelErr) {
      console.warn('[Descriptor Extractor] Failed to initialize browser face-api models:', modelErr.message);
    }

    const origWidth = inputElement.naturalWidth || inputElement.width;
    const origHeight = inputElement.naturalHeight || inputElement.height;

    // Try client-side extraction first
    if (origWidth && origHeight) {
      const tryDetectOnCanvas = async (canvas) => {
        try {
          let landmarks = await faceapi.detectFaceLandmarks(canvas);
          if (!landmarks) {
            landmarks = await faceapi.detectFaceLandmarksTiny(canvas);
          }
          if (landmarks) {
            const desc = await faceapi.computeFaceDescriptor(canvas, landmarks);
            if (desc) return Array.from(desc);
          }
        } catch (e) {
          console.warn('[Descriptor Extractor] Direct landmark extraction pass:', e.message);
        }

        try {
          let det = await faceapi
            .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.05 }))
            .withFaceLandmarks()
            .withFaceDescriptors();
          if (det && det.descriptor) return Array.from(det.descriptor);

          det = await faceapi
            .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.05 }))
            .withFaceLandmarks()
            .withFaceDescriptors();
          if (det && det.descriptor) return Array.from(det.descriptor);
        } catch (e) {
          console.warn('[Descriptor Extractor] Single face pass error:', e.message);
        }
        return null;
      };

      // Pass 1: Try cropped canvas with 25% margin padding around target box
      const margin = 0.25;
      const padW = box.width * margin;
      const padH = box.height * margin;
      const cropX = Math.max(0, box.x - padW);
      const cropY = Math.max(0, box.y - padH);
      const cropW = Math.min(origWidth - cropX, box.width + 2 * padW);
      const cropH = Math.min(origHeight - cropY, box.height + 2 * padH);

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = Math.max(20, Math.round(cropW));
      cropCanvas.height = Math.max(20, Math.round(cropH));
      const ctx = cropCanvas.getContext('2d');
      ctx.drawImage(inputElement, cropX, cropY, cropW, cropH, 0, 0, cropCanvas.width, cropCanvas.height);

      let descriptor = await tryDetectOnCanvas(cropCanvas);
      if (descriptor) return descriptor;

      // Pass 2: Try exact box crop canvas
      const exactCanvas = document.createElement('canvas');
      exactCanvas.width = Math.max(20, Math.round(box.width));
      exactCanvas.height = Math.max(20, Math.round(box.height));
      const exactCtx = exactCanvas.getContext('2d');
      exactCtx.drawImage(inputElement, box.x, box.y, box.width, box.height, 0, 0, exactCanvas.width, exactCanvas.height);

      descriptor = await tryDetectOnCanvas(exactCanvas);
      if (descriptor) return descriptor;

      // Pass 3: Fallback - Detect faces on full image and match nearest bounding box center
      try {
        let fullDetections = await faceapi
          .detectAllFaces(inputElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.1 }))
          .withFaceLandmarks()
          .withFaceDescriptors();

        if (!fullDetections || fullDetections.length === 0) {
          fullDetections = await faceapi
            .detectAllFaces(inputElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.1 }))
            .withFaceLandmarks()
            .withFaceDescriptors();
        }

        if (fullDetections && fullDetections.length > 0) {
          const targetCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          let bestDet = null;
          let minDistanceSq = Infinity;

          for (const d of fullDetections) {
            const db = d.detection.box;
            const dCenter = { x: db.x + db.width / 2, y: db.y + db.height / 2 };
            const distSq = Math.pow(targetCenter.x - dCenter.x, 2) + Math.pow(targetCenter.y - dCenter.y, 2);
            if (distSq < minDistanceSq) {
              minDistanceSq = distSq;
              bestDet = d;
            }
          }

          const maxDist = Math.max(box.width, box.height) * 2.5;
          if (bestDet && Math.sqrt(minDistanceSq) <= maxDist && bestDet.descriptor) {
            return Array.from(bestDet.descriptor);
          }
        }
      } catch (e) {
        console.warn('[Descriptor Extractor] Full image fallback error:', e.message);
      }
    }

    // Server fallback for single face descriptor calculation
    try {
      let targetFile = fileOrBlob;
      if (!targetFile && inputElement instanceof HTMLCanvasElement) {
        const blob = await new Promise(r => inputElement.toBlob(r, 'image/jpeg', 0.9));
        if (blob) targetFile = new File([blob], 'oriented_search.jpg', { type: 'image/jpeg' });
      } else if (!targetFile && inputElement instanceof HTMLImageElement && inputElement.src) {
        const res = await fetch(inputElement.src);
        const blob = await res.blob();
        targetFile = new File([blob], 'search.jpg', { type: 'image/jpeg' });
      }

      if (targetFile) {
        console.log('[Descriptor Extractor] Running server-side descriptor extraction for box...', box);
        const formData = new FormData();
        formData.append('photo', targetFile);
        formData.append('box', JSON.stringify(box));

        const serverRes = await fetch('/api/compute-descriptor', {
          method: 'POST',
          body: formData
        });
        const serverData = await serverRes.json();
        if (serverData && serverData.success && Array.isArray(serverData.descriptor)) {
          return serverData.descriptor;
        }
      }
    } catch (serverErr) {
      console.warn('[Descriptor Extractor] Server-side descriptor extraction error:', serverErr.message);
    }

    return null;
  }

  // Export to global scope
  window.FaceDetectorUtils = {
    getExifOrientation,
    createOrientedCanvas,
    resizeImageFallback,
    loadFaceApiModels,
    detectFacesMultiScale,
    extractDescriptorForBox,
    processPhotoForUpload,
    BatchUploadQueue
  };

})(window);
