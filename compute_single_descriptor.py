import sys
import json
import os
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = None
import numpy as np
import face_recognition


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

            orig_width, orig_height = img.size

            # If horizontal (width > height), rotate 90 degrees clockwise to portrait orientation (same as detect_faces.py)
            if orig_width > orig_height:
                img = img.transpose(Image.ROTATE_270)
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

            location = [(top, right, bottom, left)]
            encodings = face_recognition.face_encodings(image_np, known_face_locations=location)

            # Fallback: crop image region if location encoding yielded no face landmarks
            if not encodings or len(encodings) == 0:
                crop_np = image_np[top:bottom, left:right]
                if crop_np.shape[0] >= 10 and crop_np.shape[1] >= 10:
                    crop_h, crop_w, _ = crop_np.shape
                    crop_loc = [(0, crop_w, crop_h, 0)]
                    encodings = face_recognition.face_encodings(crop_np, known_face_locations=crop_loc)

            if encodings and len(encodings) > 0:
                descriptor = list(encodings[0])
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
