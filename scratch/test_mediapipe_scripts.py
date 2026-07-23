import subprocess
import json
import sys
import os

def test_mediapipe_scripts():
    print("Testing MediaPipe detect_faces.py and compute_single_descriptor.py...")

    test_img = "scratch/user_test.jpg"
    if not os.path.exists(test_img):
        test_img = "scratch/upload_1784475000887_02ijll0cx.jpg"

    if not os.path.exists(test_img):
        print("No test image found.")
        return

    print(f"Using test image: {test_img}")
    
    # Test detect_faces.py
    res = subprocess.run([sys.executable, "detect_faces.py", test_img], capture_output=True, text=True)
    print("detect_faces.py stdout:", res.stdout)
    if res.stderr:
        print("detect_faces.py stderr:", res.stderr)

    try:
        data = json.loads(res.stdout.strip())
        if data.get("success") and data.get("faces"):
            first_face = data["faces"][0]
            box = first_face["box"]
            descriptor = first_face["descriptor"]
            print(f"SUCCESS: Face detected! Box: {box}, Descriptor length: {len(descriptor)}")
            
            # Test compute_single_descriptor.py
            box_json = json.dumps(box)
            res2 = subprocess.run([sys.executable, "compute_single_descriptor.py", test_img, box_json], capture_output=True, text=True)
            print("compute_single_descriptor.py stdout:", res2.stdout)
            if res2.stderr:
                print("compute_single_descriptor.py stderr:", res2.stderr)

            data2 = json.loads(res2.stdout.strip())
            if data2.get("success") and data2.get("descriptor"):
                print(f"SUCCESS: Single face descriptor computed! Length: {len(data2['descriptor'])}")
            else:
                print(f"ERROR computing single descriptor: {data2}")
        else:
            print(f"ERROR detecting faces: {data}")
    except Exception as e:
        print(f"Failed to parse test output: {e}")

if __name__ == '__main__':
    test_mediapipe_scripts()
