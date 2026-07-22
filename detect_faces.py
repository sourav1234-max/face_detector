import sys
import json
import os
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = None
import numpy as np
import face_recognition


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

        # Determine detection passes
        max_dim = max(resized_width, resized_height)
        models_to_try = [
            ("hog", {"number_of_times_to_upsample": 1}),
            ("hog", {"number_of_times_to_upsample": 2}),
            ("hog", {"number_of_times_to_upsample": 0}),
        ]
        if max_dim < 1200:
            models_to_try.append(("cnn", {}))

        found_faces = []
        last_error = None

        # Rotation angles to evaluate: 0 (default upright), then 90, 270, 180 fallback
        angles_to_try = [0, 90, 270, 180]

        for angle in angles_to_try:
            curr_np = rotate_image_np(base_image_np, angle)
            
            for model_name, kwargs in models_to_try:
                try:
                    current_locations = face_recognition.face_locations(curr_np, model=model_name, **kwargs)
                    if current_locations:
                        current_encodings = face_recognition.face_encodings(curr_np, current_locations)
                        
                        # Map locations back to unrotated resized space
                        for loc, enc in zip(current_locations, current_encodings):
                            orig_loc = map_box_to_original(loc, angle, resized_width, resized_height)
                            found_faces.append((orig_loc, enc))
                        break
                except Exception as exc:
                    last_error = str(exc)

            if found_faces:
                break

        if not found_faces and last_error is not None:
            print(json.dumps({"success": False, "error": f"Face detection models failed: {last_error}"}))
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
                "descriptor": list(encoding),
            })

        faces = faces[:15]
        print(json.dumps({"success": True, "faces": faces}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == '__main__':
    main()
