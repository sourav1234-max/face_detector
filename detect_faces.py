import sys
import json
import os
from PIL import Image, ImageOps
import numpy as np
import face_recognition


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
        with Image.open(img_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode != "RGB":
                img = img.convert("RGB")

            orig_width, orig_height = img.size

            # Resize generously to preserve detail for small or high-resolution portraits.
            max_size = 1600
            resized = False
            if orig_width > max_size or orig_height > max_size:
                img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                resized = True

            resized_width, resized_height = img.size
            image_np = np.array(img)

            face_locations = []
            face_encodings = []
            last_error = None

            # Try a more sensitive HOG pass first, then fallback to CNN if needed.
            for model_name, kwargs in [
                ("hog", {"number_of_times_to_upsample": 1}),
                ("hog", {"number_of_times_to_upsample": 2}),
                ("cnn", {}),
            ]:
                try:
                    current_locations = face_recognition.face_locations(image_np, model=model_name, **kwargs)
                    if current_locations:
                        face_locations = current_locations
                        face_encodings = face_recognition.face_encodings(image_np, face_locations)
                        break
                except Exception as exc:
                    last_error = str(exc)

            if not face_locations:
                face_locations = face_recognition.face_locations(image_np, model="hog", number_of_times_to_upsample=2)
                face_encodings = face_recognition.face_encodings(image_np, face_locations)

            scale_x = orig_width / resized_width if resized else 1.0
            scale_y = orig_height / resized_height if resized else 1.0

            faces = []
            for location, encoding in zip(face_locations, face_encodings):
                top, right, bottom, left = location
                orig_left = int(left * scale_x)
                orig_top = int(top * scale_y)
                orig_right = int(right * scale_x)
                orig_bottom = int(bottom * scale_y)

                box = {
                    "x": orig_left,
                    "y": orig_top,
                    "width": orig_right - orig_left,
                    "height": orig_bottom - orig_top,
                }

                faces.append({
                    "box": box,
                    "descriptor": list(encoding),
                })

            print(json.dumps({"success": True, "faces": faces}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == '__main__':
    main()
