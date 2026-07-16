const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON and URL-encoded bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer storage for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'photo-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only JPEG, PNG, and WebP images are allowed!'));
  }
});

// Helper functions for gallery database file
const galleryDbPath = path.join(__dirname, 'public', 'gallery.json');

function readGalleryDb() {
  try {
    if (!fs.existsSync(galleryDbPath)) {
      fs.writeFileSync(galleryDbPath, JSON.stringify([], null, 2));
      return [];
    }
    const data = fs.readFileSync(galleryDbPath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading gallery database:', err);
    return [];
  }
}

function writeGalleryDb(data) {
  try {
    fs.writeFileSync(galleryDbPath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing gallery database:', err);
    return false;
  }
}

// --- API Endpoints ---

// 1. Get all photos in gallery
app.get('/api/gallery', (req, res) => {
  const gallery = readGalleryDb();
  // Return list of photos with basic metadata
  res.json({ success: true, photos: gallery });
});

// 2. Upload a new photo with its face descriptors
app.post('/api/upload', upload.single('photo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    // Parse face descriptors from client
    let descriptors = [];
    if (req.body.descriptors) {
      try {
        descriptors = JSON.parse(req.body.descriptors);
      } catch (parseErr) {
        console.error('Error parsing descriptors JSON:', parseErr);
      }
    }

    const gallery = readGalleryDb();
    const newPhoto = {
      id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      filename: req.file.filename,
      originalName: req.file.originalname,
      timestamp: new Date().toISOString(),
      descriptors: descriptors // List of Float32Array arrays representing faces detected
    };

    gallery.push(newPhoto);
    writeGalleryDb(gallery);

    console.log(`Uploaded: ${newPhoto.filename} with ${descriptors.length} face descriptors`);
    res.json({ success: true, photo: newPhoto });
  } catch (err) {
    console.error('Upload endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Delete a photo from gallery
app.post('/api/delete', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Photo ID is required' });
    }

    const gallery = readGalleryDb();
    const index = gallery.findIndex(item => item.id === id);

    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Photo not found in registry' });
    }

    const photoToDelete = gallery[index];
    const filePath = path.join(__dirname, 'public', 'uploads', photoToDelete.filename);

    // Delete image file from storage if it exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Deleted file: ${filePath}`);
    } else {
      console.warn(`File not found on disk, deleting entry anyway: ${filePath}`);
    }

    // Remove from array and save
    gallery.splice(index, 1);
    writeGalleryDb(gallery);

    res.json({ success: true, message: 'Photo deleted successfully' });
  } catch (err) {
    console.error('Delete endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Catch-all for Express errors
app.use((err, req, res, next) => {
  console.error('Express global error handler:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Face Detection Gallery Server is running!`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
