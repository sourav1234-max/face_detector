import sys
import json
import os
import urllib.request
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = None
import numpy as np

# Suppress TensorFlow / MediaPipe C++ log noise
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['GLOG_minloglevel'] = '3'

import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

MODEL_FILENAME = "face_landmarker.task"
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), MODEL_FILENAME)
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"


def ensure_model_exists():
    if not os.path.exists(MODEL_PATH):
        try:
            urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        except Exception as e:
            pass


def compute_mediapipe_descriptor(landmarks_3d):
    """
    Compute a position-, scale-, and dimension-aligned 128-element face descriptor vector
    from MediaPipe 3D face mesh landmarks.
    """
    coords = np.array(landmarks_3d, dtype=np.float32)  # Shape (N, 3)
    centroid = np.mean(coords, axis=0)
    centered = coords - centroid
    scale = np.sqrt(np.mean(centered ** 2)) + 1e-7
    normalized = centered / scale

    flat = normalized.flatten()  # Length: N * 3 (e.g. 1434)
    target_dim = 128
    chunk_size = len(flat) / float(target_dim)
    
    descriptor = np.zeros(target_dim, dtype=np.float32)
    for k in range(target_dim):
        start_idx = int(k * chunk_size)
        end_idx = int((k + 1) * chunk_size)
        descriptor[k] = np.mean(flat[start_idx:end_idx])

    norm = np.linalg.norm(descriptor)
    if norm > 0:
        descriptor = descriptor / norm

    return descriptor.tolist()


def get_descriptor_from_crop(crop_np):
    """
    Run MediaPipe FaceLandmarker Tasks API on crop_np image.
    Returns descriptor list if face detected, else None.
    """
    if crop_np.shape[0] < 10 or crop_np.shape[1] < 10:
        return None

    ensure_model_exists()
    if not os.path.exists(MODEL_PATH):
        return None

    base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        num_faces=1,
        min_face_detection_confidence=0.15,
        min_face_presence_confidence=0.15
    )
    with vision.FaceLandmarker.create_from_options(options) as detector:
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=crop_np)
        detection_result = detector.detect(mp_image)

        if detection_result.face_landmarks:
            face_landmarks = detection_result.face_landmarks[0]
            pts = [[lm.x, lm.y, lm.z] for lm in face_landmarks]
            return compute_mediapipe_descriptor(pts)
    return None


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Image path and box JSON required"}))
        return

    img_path = sys.argv[1]
    raw_box = sys.argv[2]

    if not os.path.exists(img_path):
        print(json.dumps({"success": False, "error": f"Image file not found: {img_path}"}))
        return

    try:
        box = json.loads(raw_box)
    except Exception:
        try:
            import ast
            box = ast.literal_eval(raw_box)
        except Exception as parse_err:
            print(json.dumps({"success": False, "error": f"Invalid box JSON: {str(parse_err)}"}))
            return

    try:
        with Image.open(img_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode != "RGB":
                img = img.convert("RGB")

        # =========================================================================
        # FEATURE: Vertical (Portrait) Orientation Standardization
        # -------------------------------------------------------------------------
        # Check if EXIF-corrected image is landscape (width > height).
        # If landscape, rotate 90° clockwise to make it vertical before descriptor calculation.
        # =========================================================================
        if img.width > img.height:
            img = img.rotate(-90, expand=True)

        orig_width, orig_height = img.size

        max_size = 1600
        resized = False
        if orig_width > max_size or orig_height > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            resized = True

        resized_width, resized_height = img.size
        image_np = np.array(img)

        scale_x = orig_width / resized_width if resized else 1.0
        scale_y = orig_height / resized_height if resized else 1.0

        x = float(box.get("x", 0))
        y = float(box.get("y", 0))
        w = float(box.get("width", 50))
        h = float(box.get("height", 50))

        left = max(0, int(x / scale_x))
        top = max(0, int(y / scale_y))
        right = min(resized_width, int((x + w) / scale_x))
        bottom = min(resized_height, int((y + h) / scale_y))

        if right <= left or bottom <= top:
            print(json.dumps({"success": False, "error": "Invalid bounding box dimensions"}))
            return

        # Add 15% margin around target crop for better facial landmark detection context
        crop_w = right - left
        crop_h = bottom - top
        pad_w = int(crop_w * 0.15)
        pad_h = int(crop_h * 0.15)

        crop_left = max(0, left - pad_w)
        crop_top = max(0, top - pad_h)
        crop_right = min(resized_width, right + pad_w)
        crop_bottom = min(resized_height, bottom + pad_h)

        crop_np = image_np[crop_top:crop_bottom, crop_left:crop_right]
        descriptor = get_descriptor_from_crop(crop_np)

        # Fallback 1: Tight crop without padding
        if not descriptor:
            tight_crop = image_np[top:bottom, left:right]
            descriptor = get_descriptor_from_crop(tight_crop)

        # Fallback 2: Full image
        if not descriptor:
            descriptor = get_descriptor_from_crop(image_np)

        if descriptor:
            print(json.dumps({
                "success": True,
                "box": {
                    "x": int(x),
                    "y": int(y),
                    "width": int(w),
                    "height": int(h)
                },
                "descriptor": descriptor
            }))
        else:
            print(json.dumps({
                "success": False,
                "error": "Could not compute face descriptor from the selected box. Ensure the box contains a recognizable human face."
            }))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == '__main__':
    main()
