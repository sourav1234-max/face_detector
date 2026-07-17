import sys
import traceback
from PIL import Image
import numpy as np

try:
    import face_recognition
    print("face_recognition imported successfully")
    
    img_path = "public/uploads/photo-1784218939502-734312298.jpg"
    print(f"Loading image {img_path} with Pillow...")
    img = Image.open(img_path)
    
    # Resize image if any dimension exceeds 1000px
    max_size = 1000
    if img.width > max_size or img.height > max_size:
        print(f"Resizing from {img.size}...")
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        print(f"New size: {img.size}")
        
    image_np = np.array(img)
    
    print("Running face locations on resized image...")
    face_locations = face_recognition.face_locations(image_np)
    print(f"Found {len(face_locations)} face(s)")
    for i, loc in enumerate(face_locations):
        print(f"Face {i}: {loc}")
except Exception as e:
    print("Error occurred:")
    traceback.print_exc()
