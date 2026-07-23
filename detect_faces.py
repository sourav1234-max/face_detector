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


def rotate_image_np(img_np, angle):
    """
    Rotate image numpy array by 0, 90, 180, or 270 degrees clockwise.
    """
    if angle == 90:
        return np.rot90(img_np, -1)  # 90 deg CW
    elif angle == 180:
        return np.rot90(img_np, 2)   # 180 deg
    elif angle == 270:
        return np.rot90(img_np, 1)   # 270 deg CW (90 CCW)
    return img_np


def map_box_to_original(location, angle, curr_w, curr_h):
    """
    Map face bounding box (top, right, bottom, left) from rotated space back to unrotated space.
    curr_w and curr_h are the width and height of the image BEFORE rotation.
    """
    top, right, bottom, left = location

    if angle == 90:
        orig_left = top
        orig_right = bottom
        orig_top = curr_h - right
        orig_bottom = curr_h - left
    elif angle == 180:
        orig_left = curr_w - right
        orig_right = curr_w - left
        orig_top = curr_h - bottom
        orig_bottom = curr_h - top
    elif angle == 270:
        orig_left = curr_w - bottom
        orig_right = curr_w - top
        orig_top = left
        orig_bottom = right
    else:
        orig_left = left
        orig_right = right
        orig_top = top
        orig_bottom = bottom

    # Clamp coordinates
    orig_left = max(0, min(curr_w, orig_left))
    orig_right = max(0, min(curr_w, orig_right))
    orig_top = max(0, min(curr_h, orig_top))
    orig_bottom = max(0, min(curr_h, orig_bottom))

    return orig_top, orig_right, orig_bottom, orig_left


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


def detect_faces_mediapipe(img_np):
    """
    Detect faces using MediaPipe FaceLandmarker Tasks API on an RGB image numpy array.
    Returns list of (box_location_tuple, descriptor_list).
    box_location_tuple format: (top, right, bottom, left) in pixel space of img_np.
    """
    ensure_model_exists()
    if not os.path.exists(MODEL_PATH):
        raise RuntimeError("face_landmarker.task model file not available")

    h, w, _ = img_np.shape
    base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        num_faces=15,
        min_face_detection_confidence=0.3,
        min_face_presence_confidence=0.3
    )

    found = []
    with vision.FaceLandmarker.create_from_options(options) as detector:
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_np)
        detection_result = detector.detect(mp_image)

        if detection_result.face_landmarks:
            for face_landmarks in detection_result.face_landmarks:
                pts = [[lm.x, lm.y, lm.z] for lm in face_landmarks]
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]

                min_x, max_x = min(xs), max(xs)
                min_y, max_y = min(ys), max(ys)

                # 5% padding around landmark bounds
                bw = max_x - min_x
                bh = max_y - min_y
                pad_x = bw * 0.05
                pad_y = bh * 0.05

                left = max(0, int((min_x - pad_x) * w))
                top = max(0, int((min_y - pad_y) * h))
                right = min(w, int((max_x + pad_x) * w))
                bottom = min(h, int((max_y + pad_y) * h))

                if right <= left or bottom <= top:
                    continue

                desc = compute_mediapipe_descriptor(pts)
                found.append(((top, right, bottom, left), desc))

    return found


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Image path required"}))
        return

    img_path = sys.argv[1]
    if not os.path.exists(img_path):
        print(json.dumps({"success": False, "error": f"Image file not found: {img_path}"}))
        return

    try:
        img = Image.open(img_path)
        # 1. Correct EXIF orientation
        img = ImageOps.exif_transpose(img)
        if img.mode != "RGB":
            img = img.convert("RGB")

        # =========================================================================
        # FEATURE: Vertical (Portrait) Orientation Standardization
        # -------------------------------------------------------------------------
        # If the EXIF-corrected image is horizontal (landscape: width > height),
        # rotate 90° clockwise to make it vertical (portrait) before face detection.
        # =========================================================================
        if img.width > img.height:
            img = img.rotate(-90, expand=True)

        # Save the vertical image back to disk so the stored photo is vertical
        img.load()
        try:
            img.save(img_path, format="JPEG", quality=95)
        except Exception:
            pass

        orig_width, orig_height = img.size

        # 2. Resize generously to preserve detail for high-res images
        max_size = 1600
        resized = False
        if orig_width > max_size or orig_height > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            resized = True

        resized_width, resized_height = img.size
        base_image_np = np.array(img)

        found_faces = []
        last_error = None

        # Rotation angles to evaluate: 0 (default upright), then 90, 270, 180 fallback
        angles_to_try = [0, 90, 270, 180]

        for angle in angles_to_try:
            curr_np = rotate_image_np(base_image_np, angle)
            try:
                detected = detect_faces_mediapipe(curr_np)
                if detected:
                    for loc, enc in detected:
                        orig_loc = map_box_to_original(loc, angle, resized_width, resized_height)
                        found_faces.append((orig_loc, enc))
                    break
            except Exception as exc:
                last_error = str(exc)

            if found_faces:
                break

        if not found_faces and last_error is not None:
            print(json.dumps({"success": False, "error": f"Face detection model failed: {last_error}"}))
            return

        scale_x = orig_width / resized_width if resized else 1.0
        scale_y = orig_height / resized_height if resized else 1.0

        faces = []
        for (top, right, bottom, left), encoding in found_faces:
            orig_left = int(left * scale_x)
            orig_top = int(top * scale_y)
            orig_right = int(right * scale_x)
            orig_bottom = int(bottom * scale_y)
            width = orig_right - orig_left
            height = orig_bottom - orig_top

            if width < 15 or height < 15:
                continue

            box = {
                "x": orig_left,
                "y": orig_top,
                "width": width,
                "height": height,
            }

            faces.append({
                "box": box,
                "descriptor": encoding,
            })

        faces = faces[:15]
        print(json.dumps({"success": True, "faces": faces}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == '__main__':
    main()
