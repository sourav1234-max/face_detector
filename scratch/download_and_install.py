import urllib.request
import json
import subprocess
import os

def download_and_install_pypi_pkg(pkg_name):
    print(f"Fetching metadata for {pkg_name}...")
    url = f"https://pypi.org/pypi/{pkg_name}/json"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode())
    
    # Get the latest release files
    releases = data['urls']
    
    # Prefer .whl file first, then .tar.gz
    download_url = None
    filename = None
    for r in releases:
        if r['packagetype'] == 'bdist_wheel':
            download_url = r['url']
            filename = r['filename']
            break
            
    if not download_url:
        for r in releases:
            if r['packagetype'] == 'sdist':
                download_url = r['url']
                filename = r['filename']
                break
                
    if not download_url:
        raise Exception(f"No download URL found for {pkg_name}")
        
    print(f"Downloading {filename}...")
    urllib.request.urlretrieve(download_url, filename)
    print(f"Downloaded {filename} successfully.")
    
    print(f"Installing {filename} via pip --no-deps...")
    subprocess.check_call([
        "pip", "install", "--no-deps", filename
    ])
    print(f"Successfully installed {pkg_name}!")
    
    # Clean up file
    try:
        os.remove(filename)
        print(f"Cleaned up {filename}.")
    except Exception as cleanup_err:
        print(f"Cleanup error for {filename}: {cleanup_err}")

def main():
    try:
        # Install face-recognition-models first
        download_and_install_pypi_pkg("face-recognition-models")
        # Install face_recognition
        download_and_install_pypi_pkg("face_recognition")
        print("\nALL PACKAGES INSTALLED SUCCESSFULLY!")
    except Exception as e:
        print("\nInstallation failed:", e)

if __name__ == '__main__':
    main()
